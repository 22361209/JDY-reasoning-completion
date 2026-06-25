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
import com.jdy.erp.shared.application.ValidationService;
import com.jdy.erp.shared.domain.BillStatus;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class StockCountLossAppService {
    private static final String BILL_TABLE = "stock_count_loss";

    private final JdbcTemplate jdbcTemplate;
    private final LookupService lookupService;
    private final ValidationService validationService;
    private final BillLifecycleService lifecycleService;
    private final NumberingService numberingService;
    private final PostingPipeline postingPipeline;

    public StockCountLossAppService(JdbcTemplate jdbcTemplate, LookupService lookupService, ValidationService validationService, BillLifecycleService lifecycleService, PostingPipeline postingPipeline, NumberingService numberingService) {
        this.jdbcTemplate = jdbcTemplate;
        this.lookupService = lookupService;
        this.validationService = validationService;
        this.lifecycleService = lifecycleService;
        this.postingPipeline = postingPipeline;
        this.numberingService = numberingService;
    }

    public Map<String, Object> detail(String billNo) {
        var billRows = jdbcTemplate.queryForList("""
            SELECT b.id::text AS id,
                   b.bill_no AS "billNo",
                   sc.bill_no AS "sourceOrderNo",
                   to_char(b.bill_date, 'YYYY-MM-DD') AS "billDate",
                   b.department,
                   b.business_type AS "businessType",
                   b.status,
                   b.total_amount AS "totalAmount",
                   b.owner_name AS "ownerName"
            FROM stock_count_loss b
            LEFT JOIN stock_count sc ON sc.id = b.source_bill_id
            WHERE b.bill_no = ?
            """, billNo);
        if (billRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "盘亏单不存在");
        }
        var lines = jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo",
                   l.source_line_no AS "sourceLineNo",
                   p.code AS "productCode",
                   p.name AS "productName",
                   COALESCE(p.spec, '') AS spec,
                   w.code AS "warehouseCode",
                   l.qty,
                   l.unit_price AS "unitPrice",
                   l.amount,
                   COALESCE(l.line_remark, '') AS "lineRemark"
            FROM stock_count_loss_line l
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.warehouse_id
            JOIN stock_count_loss b ON b.id = l.bill_id
            WHERE b.bill_no = ?
            ORDER BY l.line_no
            """, billNo);
        return Map.of("action", "DETAIL", "document", billRows.get(0), "lines", lines);
    }

    @Transactional
    public Map<String, Object> saveDraft(StockCountLossDraftRequest request) {
        var billNo = numberingService.assignBillNo("stockCountLoss", request.billNo());
        var totalAmount = request.lines().stream()
            .map(line -> positive(line.qty(), "数量").multiply(nonNegativePrice(line.unitPrice())))
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        var bill = jdbcTemplate.queryForMap("""
            INSERT INTO stock_count_loss (bill_no, bill_date, department, document_type, business_type, status, total_amount, owner_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (bill_no) DO UPDATE
            SET bill_date = EXCLUDED.bill_date,
                department = EXCLUDED.department,
                status = EXCLUDED.status,
                total_amount = EXCLUDED.total_amount,
                owner_name = EXCLUDED.owner_name,
                updated_at = now(),
                version = stock_count_loss.version + 1
            WHERE stock_count_loss.status = ?
            RETURNING id::text AS id, bill_no AS "billNo", total_amount AS "totalAmount"
            """,
            billNo,
            LocalDate.parse(validationService.required(request.billDate(), "业务日期")),
            request.department(),
            "STK_StockCountLoss",
            "盘亏单",
            BillStatus.DRAFT.name(),
            totalAmount,
            request.ownerName(),
            BillStatus.DRAFT.name()
        );
        var billId = bill.get("id");
        jdbcTemplate.update("DELETE FROM stock_count_loss_line WHERE bill_id = ?::uuid", billId);
        insertLines(billId, request.lines());
        return bill;
    }

    @Transactional
    public Map<String, Object> audit(String billNo) {
        var row = lifecycleService.transition(BILL_TABLE, billNo, BillStatus.DRAFT, BillStatus.AUDITED,
            "id::text AS id, bill_no AS \"billNo\", status", "INVENTORY", "AUDIT", "stock_count_loss", "盘亏单不存在或已审核");
        for (var line : postingLines(billNo)) {
            postingPipeline.post(new PostingContext(InventoryPostingHook.CHANNEL, String.valueOf(line.get("productCode")), String.valueOf(line.get("warehouseCode")), ((BigDecimal) line.get("qty")).negate(), "STOCK_COUNT_LOSS", "STOCK_COUNT_LOSS:" + billNo));
        }
        return row;
    }

    @Transactional
    public Map<String, Object> reverse(String billNo) {
        var row = lifecycleService.transition(BILL_TABLE, billNo, BillStatus.AUDITED, BillStatus.REVERSED,
            "id::text AS id, bill_no AS \"billNo\", status", "INVENTORY", "REVERSE", "stock_count_loss", "盘亏单不存在或不能反审核");
        for (var line : postingLines(billNo)) {
            postingPipeline.post(new PostingContext(InventoryPostingHook.CHANNEL, String.valueOf(line.get("productCode")), String.valueOf(line.get("warehouseCode")), (BigDecimal) line.get("qty"), "STOCK_COUNT_LOSS_REVERSE", "STOCK_COUNT_LOSS_REVERSE:" + billNo));
        }
        return row;
    }

    @Transactional
    public Map<String, Object> voidBill(String billNo) {
        return lifecycleService.transition(BILL_TABLE, billNo, BillStatus.DRAFT, BillStatus.VOID,
            "id::text AS id, bill_no AS \"billNo\", status", "INVENTORY", "VOID", "stock_count_loss", "只有草稿盘亏单可以作废");
    }

    private void insertLines(Object billId, List<StockCountLossLineRequest> lines) {
        var lineNo = 1;
        for (var line : lines) {
            var productId = lookupService.lookupEnabledId("md_product", line.productCode(), "商品");
            var warehouseId = lookupService.lookupEnabledId("md_warehouse", line.warehouseCode(), "仓库");
            var qty = positive(line.qty(), "数量");
            var unitPrice = nonNegativePrice(line.unitPrice());
            jdbcTemplate.update("""
                INSERT INTO stock_count_loss_line (bill_id, line_no, product_id, warehouse_id, source_line_no, qty, unit_price, amount, line_remark)
                VALUES (?::uuid, ?, ?::uuid, ?::uuid, ?, ?, ?, ?, ?)
                """, billId, lineNo, productId, warehouseId, line.sourceLineNo(), qty, unitPrice, qty.multiply(unitPrice), validationService.optionalText(line.lineRemark()));
            lineNo += 1;
        }
    }

    private List<Map<String, Object>> postingLines(String billNo) {
        return jdbcTemplate.queryForList("""
            SELECT p.code AS "productCode", w.code AS "warehouseCode", l.qty
            FROM stock_count_loss_line l
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.warehouse_id
            JOIN stock_count_loss b ON b.id = l.bill_id
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

    public record StockCountLossDraftRequest(String billNo, String supplierCode, String billDate, String department, String ownerName, List<StockCountLossLineRequest> lines) {
        public StockCountLossDraftRequest {
            if (lines == null || lines.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "至少需要一条分录");
            }
        }
    }

    public record StockCountLossLineRequest(String productCode, String warehouseCode, Integer sourceLineNo, BigDecimal qty, BigDecimal unitPrice, String lineRemark) {
    }
}
