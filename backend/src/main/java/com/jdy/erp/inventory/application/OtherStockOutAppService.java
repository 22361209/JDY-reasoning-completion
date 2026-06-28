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
public class OtherStockOutAppService {
    private static final String BILL_TABLE = "other_stock_out";

    private final JdbcTemplate jdbcTemplate;
    private final LookupService lookupService;
    private final ValidationService validationService;
    private final BillLifecycleService lifecycleService;
    private final NumberingService numberingService;
    private final PostingPipeline postingPipeline;
    private final ProductSnapshotService productSnapshotService;

    public OtherStockOutAppService(
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
                   b.total_amount AS "totalAmount",
                   b.owner_name AS "ownerName"
            FROM other_stock_out b
            WHERE b.bill_no = ?
            """, billNo);
        if (billRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "其他出库单不存在");
        }
        var lines = jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo",
                   l.product_id::text AS "productId",
                   COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                   COALESCE(l.product_name_snapshot, p.name) AS "productName",
                   COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   w.code AS "warehouseCode",
                   l.qty,
                   l.unit_price AS "unitPrice",
                   l.amount,
                   COALESCE(l.line_remark, '') AS "lineRemark"
            FROM other_stock_out_line l
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.warehouse_id
            JOIN other_stock_out b ON b.id = l.bill_id
            WHERE b.bill_no = ?
            ORDER BY l.line_no
            """, billNo);
        return Map.of("action", "DETAIL", "document", billRows.get(0), "lines", lines);
    }

    @Transactional
    public Map<String, Object> saveDraft(OtherStockOutDraftRequest request) {
        var billNo = numberingService.assignBillNo("otherStockOut", request.billNo());
        var totalAmount = request.lines().stream()
            .map(line -> positive(line.qty(), "数量").multiply(nonNegativePrice(line.unitPrice())))
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        var bill = jdbcTemplate.queryForMap("""
            INSERT INTO other_stock_out (bill_no, bill_date, department, business_type, status, total_amount, owner_name)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (bill_no) DO UPDATE
            SET bill_date = EXCLUDED.bill_date,
                department = EXCLUDED.department,
                business_type = EXCLUDED.business_type,
                status = EXCLUDED.status,
                total_amount = EXCLUDED.total_amount,
                owner_name = EXCLUDED.owner_name,
                updated_at = now(),
                version = other_stock_out.version + 1
            WHERE other_stock_out.status = ?
            RETURNING id::text AS id, bill_no AS "billNo", total_amount AS "totalAmount"
            """,
            billNo,
            LocalDate.parse(validationService.required(request.billDate(), "业务日期")),
            request.department(),
            "其他出库",
            BillStatus.DRAFT.name(),
            totalAmount,
            request.ownerName(),
            BillStatus.DRAFT.name()
        );
        var billId = bill.get("id");
        jdbcTemplate.update("DELETE FROM other_stock_out_line WHERE bill_id = ?::uuid", billId);
        insertLines(billId, request.lines());
        return bill;
    }

    @Transactional
    public Map<String, Object> audit(String billNo) {
        var row = lifecycleService.transition(BILL_TABLE, billNo, BillStatus.DRAFT, BillStatus.AUDITED,
            "id::text AS id, bill_no AS \"billNo\", status", "INVENTORY", "AUDIT", "other_stock_out", "其他出库单不存在或已审核");
        for (var line : postingLines(billNo)) {
            postingPipeline.post(new PostingContext(
                InventoryPostingHook.CHANNEL,
                String.valueOf(line.get("productCode")),
                String.valueOf(line.get("warehouseCode")),
                ((BigDecimal) line.get("qty")).negate(),
                "OTHER_STOCK_OUT",
                "OTHER_STOCK_OUT:" + billNo
            ));
        }
        return row;
    }

    @Transactional
    public Map<String, Object> reverse(String billNo) {
        var row = lifecycleService.transition(BILL_TABLE, billNo, BillStatus.AUDITED, BillStatus.DRAFT,
            "id::text AS id, bill_no AS \"billNo\", status", "INVENTORY", "REVERSE", "other_stock_out", "其他出库单不存在或不能反审核");
        for (var line : postingLines(billNo)) {
            postingPipeline.post(new PostingContext(
                InventoryPostingHook.CHANNEL,
                String.valueOf(line.get("productCode")),
                String.valueOf(line.get("warehouseCode")),
                (BigDecimal) line.get("qty"),
                "OTHER_STOCK_OUT_REVERSE",
                "OTHER_STOCK_OUT_REVERSE:" + billNo
            ));
        }
        return row;
    }

    @Transactional
    public Map<String, Object> voidBill(String billNo) {
        return lifecycleService.transition(BILL_TABLE, billNo, BillStatus.DRAFT, BillStatus.VOID,
            "id::text AS id, bill_no AS \"billNo\", status", "INVENTORY", "VOID", "other_stock_out", "只有草稿其他出库单可以作废");
    }

    private void insertLines(Object billId, List<OtherStockOutLineRequest> lines) {
        var lineNo = 1;
        for (var line : lines) {
            var product = productSnapshotService.resolve(line.productId(), line.productCode(), "商品");
            var warehouseId = lookupService.lookupEnabledId("md_warehouse", line.warehouseCode(), "仓库");
            var qty = positive(line.qty(), "数量");
            var unitPrice = nonNegativePrice(line.unitPrice());
            jdbcTemplate.update("""
                INSERT INTO other_stock_out_line (bill_id, line_no, product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot, warehouse_id, qty, unit_price, amount, line_remark)
                VALUES (?::uuid, ?, ?::uuid, ?, ?, ?, ?::uuid, ?, ?, ?, ?)
                """, billId, lineNo, product.id(), product.code(), product.name(), product.spec(), warehouseId, qty, unitPrice, qty.multiply(unitPrice), validationService.optionalText(line.lineRemark()));
            lineNo += 1;
        }
    }

    private List<Map<String, Object>> postingLines(String billNo) {
        return jdbcTemplate.queryForList("""
            SELECT p.code AS "productCode", w.code AS "warehouseCode", l.qty
            FROM other_stock_out_line l
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.warehouse_id
            JOIN other_stock_out b ON b.id = l.bill_id
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

    public record OtherStockOutDraftRequest(String billNo, String customerCode, String billDate, String department, String ownerName, List<OtherStockOutLineRequest> lines) {
        public OtherStockOutDraftRequest {
            if (lines == null || lines.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "至少需要一条分录");
            }
        }
    }

    public record OtherStockOutLineRequest(String productId, String productCode, String warehouseCode, Integer sourceLineNo, BigDecimal qty, BigDecimal unitPrice, String lineRemark) {
    }
}
