package com.jdy.erp.inventory.application;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;

import com.jdy.erp.shared.application.BillLifecycleService;
import com.jdy.erp.shared.application.ConversionService;
import com.jdy.erp.shared.application.LookupService;
import com.jdy.erp.shared.application.ValidationService;
import com.jdy.erp.shared.domain.BillStatus;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class StockCountAppService {
    private static final String BILL_TABLE = "stock_count";

    private final JdbcTemplate jdbcTemplate;
    private final LookupService lookupService;
    private final ValidationService validationService;
    private final BillLifecycleService lifecycleService;
    private final ConversionService conversionService;

    public StockCountAppService(
        JdbcTemplate jdbcTemplate,
        LookupService lookupService,
        ValidationService validationService,
        BillLifecycleService lifecycleService,
        ConversionService conversionService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.lookupService = lookupService;
        this.validationService = validationService;
        this.lifecycleService = lifecycleService;
        this.conversionService = conversionService;
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
            FROM stock_count b
            WHERE b.bill_no = ?
            """, billNo);
        if (billRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "盘点单不存在");
        }
        var lines = jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo",
                   p.code AS "productCode",
                   p.name AS "productName",
                   COALESCE(p.spec, '') AS spec,
                   w.code AS "warehouseCode",
                   l.counted_qty AS qty,
                   l.system_qty AS "systemQty",
                   l.diff_qty AS "diffQty",
                   l.unit_price AS "unitPrice",
                   COALESCE(l.line_remark, '') AS "lineRemark"
            FROM stock_count_line l
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.warehouse_id
            JOIN stock_count b ON b.id = l.bill_id
            WHERE b.bill_no = ?
            ORDER BY l.line_no
            """, billNo);
        return Map.of("action", "DETAIL", "document", billRows.get(0), "lines", lines);
    }

    @Transactional
    public Map<String, Object> saveDraft(StockCountDraftRequest request) {
        var bill = jdbcTemplate.queryForMap("""
            INSERT INTO stock_count (bill_no, bill_date, department, document_type, business_type, status, owner_name)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (bill_no) DO UPDATE
            SET bill_date = EXCLUDED.bill_date,
                department = EXCLUDED.department,
                owner_name = EXCLUDED.owner_name,
                status = EXCLUDED.status,
                updated_at = now(),
                version = stock_count.version + 1
            WHERE stock_count.status = ?
            RETURNING id::text AS id, bill_no AS "billNo"
            """,
            validationService.required(request.billNo(), "单据编号"),
            LocalDate.parse(validationService.required(request.billDate(), "业务日期")),
            request.department(),
            "STK_StockCountInput",
            "盘点单",
            BillStatus.DRAFT.name(),
            request.ownerName(),
            BillStatus.DRAFT.name()
        );
        var billId = bill.get("id");
        jdbcTemplate.update("DELETE FROM stock_count_line WHERE bill_id = ?::uuid", billId);
        insertLines(billId, request.lines());
        return bill;
    }

    @Transactional
    public Map<String, Object> audit(String billNo) {
        var row = lifecycleService.transition(BILL_TABLE, billNo, BillStatus.DRAFT, BillStatus.AUDITED,
            "id::text AS id, bill_no AS \"billNo\", status", "INVENTORY", "AUDIT", "stock_count", "盘点单不存在或已审核");
        var result = conversionService.createStockCountAdjustments(billNo);
        return Map.of(
            "id", row.get("id"),
            "billNo", row.get("billNo"),
            "status", row.get("status"),
            "gainBillNo", result.gainBillNo(),
            "lossBillNo", result.lossBillNo(),
            "gainCount", result.gainCount(),
            "lossCount", result.lossCount()
        );
    }

    @Transactional
    public Map<String, Object> reverse(String billNo) {
        return lifecycleService.transition(BILL_TABLE, billNo, BillStatus.AUDITED, BillStatus.REVERSED,
            "id::text AS id, bill_no AS \"billNo\", status", "INVENTORY", "REVERSE", "stock_count", "盘点单不存在或不能反审核");
    }

    @Transactional
    public Map<String, Object> voidBill(String billNo) {
        return lifecycleService.transition(BILL_TABLE, billNo, BillStatus.DRAFT, BillStatus.VOID,
            "id::text AS id, bill_no AS \"billNo\", status", "INVENTORY", "VOID", "stock_count", "只有草稿盘点单可以作废");
    }

    private void insertLines(Object billId, List<StockCountLineRequest> lines) {
        var lineNo = 1;
        for (var line : lines) {
            var productId = lookupService.lookupEnabledId("md_product", line.productCode(), "商品");
            var warehouseId = lookupService.lookupEnabledId("md_warehouse", line.warehouseCode(), "仓库");
            var countedQty = nonNegative(line.qty(), "实盘数量");
            var systemQty = currentStockQty(productId, warehouseId);
            var unitPrice = nonNegativePrice(line.unitPrice());
            jdbcTemplate.update("""
                INSERT INTO stock_count_line (bill_id, line_no, product_id, warehouse_id, system_qty, counted_qty, diff_qty, unit_price, line_remark)
                VALUES (?::uuid, ?, ?::uuid, ?::uuid, ?, ?, ?, ?, ?)
                """,
                billId,
                lineNo,
                productId,
                warehouseId,
                systemQty,
                countedQty,
                countedQty.subtract(systemQty),
                unitPrice,
                validationService.optionalText(line.lineRemark())
            );
            lineNo += 1;
        }
    }

    private BigDecimal currentStockQty(Object productId, Object warehouseId) {
        return jdbcTemplate.queryForObject("""
            SELECT COALESCE((
                SELECT qty_on_hand
                FROM inv_stock_balance
                WHERE product_id = ?::uuid AND warehouse_id = ?::uuid
            ), 0)
            """, BigDecimal.class, productId, warehouseId);
    }

    private BigDecimal nonNegative(BigDecimal value, String label) {
        if (value == null || value.compareTo(BigDecimal.ZERO) < 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不能小于 0");
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

    public record StockCountDraftRequest(String billNo, String supplierCode, String billDate, String department, String ownerName, List<StockCountLineRequest> lines) {
        public StockCountDraftRequest {
            if (lines == null || lines.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "至少需要一条分录");
            }
        }
    }

    public record StockCountLineRequest(String productCode, String warehouseCode, Integer sourceLineNo, BigDecimal qty, BigDecimal unitPrice, String lineRemark) {
    }
}
