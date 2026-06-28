package com.jdy.erp.inventory.application;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;

import com.jdy.erp.shared.application.BillLifecycleService;
import com.jdy.erp.shared.application.InventoryPostingHook;
import com.jdy.erp.shared.application.LookupService;
import com.jdy.erp.shared.application.NumberingService;
import com.jdy.erp.shared.application.PostingContext;
import com.jdy.erp.shared.application.PostingPipeline;
import com.jdy.erp.shared.application.ProductSnapshotService;
import com.jdy.erp.shared.application.ValidationService;
import com.jdy.erp.shared.domain.BillStatus;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class StockTransferAppService {
    private static final String BILL_TABLE = "stock_transfer";

    private final JdbcTemplate jdbcTemplate;
    private final LookupService lookupService;
    private final ValidationService validationService;
    private final BillLifecycleService lifecycleService;
    private final NumberingService numberingService;
    private final PostingPipeline postingPipeline;
    private final ProductSnapshotService productSnapshotService;

    public StockTransferAppService(
        JdbcTemplate jdbcTemplate,
        LookupService lookupService,
        ValidationService validationService,
        BillLifecycleService lifecycleService,
        PostingPipeline postingPipeline,
        NumberingService numberingService,
        ProductSnapshotService productSnapshotService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.lookupService = lookupService;
        this.validationService = validationService;
        this.lifecycleService = lifecycleService;
        this.postingPipeline = postingPipeline;
        this.numberingService = numberingService;
        this.productSnapshotService = productSnapshotService;
    }

    public Map<String, Object> detail(String billNo) {
        var billRows = jdbcTemplate.queryForList("""
            SELECT b.id::text AS id,
                   b.bill_no AS "billNo",
                   to_char(b.bill_date, 'YYYY-MM-DD') AS "billDate",
                   b.department,
                   b.business_type AS "businessType",
                   b.status,
                   b.owner_name AS "ownerName"
            FROM stock_transfer b
            WHERE b.bill_no = ?
            """, billNo);
        if (billRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "调拨单不存在");
        }
        var lines = jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo",
                   l.product_id::text AS "productId",
                   COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                   COALESCE(l.product_name_snapshot, p.name) AS "productName",
                   COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                   sw.code AS "warehouseCode",
                   tw.code AS "targetWarehouseCode",
                   l.qty,
                   l.unit_price AS "unitPrice",
                   l.amount,
                   COALESCE(l.line_remark, '') AS "lineRemark"
            FROM stock_transfer_line l
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse sw ON sw.id = l.source_warehouse_id
            JOIN md_warehouse tw ON tw.id = l.target_warehouse_id
            JOIN stock_transfer b ON b.id = l.bill_id
            WHERE b.bill_no = ?
            ORDER BY l.line_no
            """, billNo);
        return Map.of("action", "DETAIL", "document", billRows.get(0), "lines", lines);
    }

    @Transactional
    public Map<String, Object> saveDraft(StockTransferDraftRequest request) {
        var billNo = numberingService.assignBillNo("stockTransfer", request.billNo());
        var bill = jdbcTemplate.queryForMap("""
            INSERT INTO stock_transfer (bill_no, bill_date, department, transfer_type, business_type, status, owner_name)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (bill_no) DO UPDATE
            SET bill_date = EXCLUDED.bill_date,
                department = EXCLUDED.department,
                transfer_type = EXCLUDED.transfer_type,
                business_type = EXCLUDED.business_type,
                status = EXCLUDED.status,
                owner_name = EXCLUDED.owner_name,
                updated_at = now(),
                version = stock_transfer.version + 1
            WHERE stock_transfer.status = ?
            RETURNING id::text AS id, bill_no AS "billNo"
            """,
            billNo,
            LocalDate.parse(validationService.required(request.billDate(), "业务日期")),
            request.department(),
            "STK_TransferDirect",
            "直接调拨",
            BillStatus.DRAFT.name(),
            request.ownerName(),
            BillStatus.DRAFT.name()
        );
        var billId = bill.get("id");
        jdbcTemplate.update("DELETE FROM stock_transfer_line WHERE bill_id = ?::uuid", billId);
        insertLines(billId, request.lines());
        return bill;
    }

    @Transactional
    public Map<String, Object> audit(String billNo) {
        var row = lifecycleService.transition(BILL_TABLE, billNo, BillStatus.DRAFT, BillStatus.AUDITED,
            "id::text AS id, bill_no AS \"billNo\", status", "INVENTORY", "AUDIT", "stock_transfer", "调拨单不存在或已审核");
        for (var line : postingLines(billNo)) {
            var qty = (BigDecimal) line.get("qty");
            postLeg(line, String.valueOf(line.get("sourceWarehouseCode")), qty.negate(), "STOCK_TRANSFER_OUT", billNo);
            postLeg(line, String.valueOf(line.get("targetWarehouseCode")), qty, "STOCK_TRANSFER_IN", billNo);
        }
        return row;
    }

    @Transactional
    public Map<String, Object> reverse(String billNo) {
        var row = lifecycleService.transition(BILL_TABLE, billNo, BillStatus.AUDITED, BillStatus.DRAFT,
            "id::text AS id, bill_no AS \"billNo\", status", "INVENTORY", "REVERSE", "stock_transfer", "调拨单不存在或不能反审核");
        for (var line : postingLines(billNo)) {
            var qty = (BigDecimal) line.get("qty");
            postLeg(line, String.valueOf(line.get("targetWarehouseCode")), qty.negate(), "STOCK_TRANSFER_IN_REVERSE", billNo);
            postLeg(line, String.valueOf(line.get("sourceWarehouseCode")), qty, "STOCK_TRANSFER_OUT_REVERSE", billNo);
        }
        return row;
    }

    @Transactional
    public Map<String, Object> voidBill(String billNo) {
        return lifecycleService.transition(BILL_TABLE, billNo, BillStatus.DRAFT, BillStatus.VOID,
            "id::text AS id, bill_no AS \"billNo\", status", "INVENTORY", "VOID", "stock_transfer", "只有草稿调拨单可以作废");
    }

    private void postLeg(Map<String, Object> line, String warehouseCode, BigDecimal qtyDelta, String txnType, String billNo) {
        postingPipeline.post(new PostingContext(
            InventoryPostingHook.CHANNEL,
            String.valueOf(line.get("productCode")),
            warehouseCode,
            qtyDelta,
            txnType,
            txnType + ":" + billNo
        ));
    }

    private void insertLines(Object billId, List<StockTransferLineRequest> lines) {
        var lineNo = 1;
        for (var line : lines) {
            var product = productSnapshotService.resolve(line.productId(), line.productCode(), "商品");
            var sourceWarehouseCode = validationService.required(line.warehouseCode(), "源仓库");
            var targetWarehouseCode = validationService.required(line.targetWarehouseCode(), "目标仓库");
            var sourceWarehouseId = lookupService.lookupEnabledId("md_warehouse", sourceWarehouseCode, "源仓库");
            var targetWarehouseId = lookupService.lookupEnabledId("md_warehouse", targetWarehouseCode, "目标仓库");
            if (sourceWarehouseCode.equals(targetWarehouseCode)) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "源仓库和目标仓库不能相同");
            }
            var qty = positive(line.qty(), "数量");
            var unitPrice = nonNegativePrice(line.unitPrice());
            jdbcTemplate.update("""
                INSERT INTO stock_transfer_line (bill_id, line_no, product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot, source_warehouse_id, target_warehouse_id, qty, unit_price, amount, line_remark)
                VALUES (?::uuid, ?, ?::uuid, ?, ?, ?, ?::uuid, ?::uuid, ?, ?, ?, ?)
                """, billId, lineNo, product.id(), product.code(), product.name(), product.spec(), sourceWarehouseId, targetWarehouseId, qty, unitPrice, qty.multiply(unitPrice), validationService.optionalText(line.lineRemark()));
            lineNo += 1;
        }
    }

    private List<Map<String, Object>> postingLines(String billNo) {
        return jdbcTemplate.queryForList("""
            SELECT p.code AS "productCode",
                   sw.code AS "sourceWarehouseCode",
                   tw.code AS "targetWarehouseCode",
                   l.qty
            FROM stock_transfer_line l
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse sw ON sw.id = l.source_warehouse_id
            JOIN md_warehouse tw ON tw.id = l.target_warehouse_id
            JOIN stock_transfer b ON b.id = l.bill_id
            WHERE b.bill_no = ?
            ORDER BY l.line_no
            """, billNo);
    }

    private BigDecimal positive(BigDecimal value, String label) {
        if (value == null || value.compareTo(BigDecimal.ZERO) <= 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "必须大于 0");
        }
        return value;
    }

    private BigDecimal nonNegativePrice(BigDecimal value) {
        var price = value == null ? BigDecimal.ZERO : value;
        if (price.compareTo(BigDecimal.ZERO) < 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "单位成本不能小于 0");
        }
        return price;
    }

    public record StockTransferDraftRequest(String billNo, String supplierCode, String billDate, String department, String ownerName, List<StockTransferLineRequest> lines) {
        public StockTransferDraftRequest {
            if (lines == null || lines.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "至少需要一条分录");
            }
        }
    }

    public record StockTransferLineRequest(String productId, String productCode, String warehouseCode, String targetWarehouseCode, Integer sourceLineNo, BigDecimal qty, BigDecimal unitPrice, String lineRemark) {
    }
}
