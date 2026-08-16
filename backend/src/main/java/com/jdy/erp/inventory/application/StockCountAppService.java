package com.jdy.erp.inventory.application;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;

import com.jdy.erp.shared.application.BillLifecycleService;
import com.jdy.erp.shared.application.BillLifecycleService.BillLifecycleTarget;
import com.jdy.erp.shared.application.BillLifecycleService.VoidRequest;
import com.jdy.erp.shared.application.ConversionService;
import com.jdy.erp.shared.application.LookupService;
import com.jdy.erp.shared.application.NumberingService;
import com.jdy.erp.shared.application.ProductSnapshotService;
import com.jdy.erp.shared.application.ValidationService;
import com.jdy.erp.shared.domain.BillStatus;
import com.jdy.erp.system.tenant.TenantDataScopeService;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class StockCountAppService {
    private static final String BILL_TABLE = "stock_count";
    private static final BillLifecycleTarget LIFECYCLE_TARGET = new BillLifecycleTarget(BILL_TABLE, "stock_count_line", "bill_id", "INVENTORY", "stock_count");

    private final JdbcTemplate jdbcTemplate;
    private final LookupService lookupService;
    private final ValidationService validationService;
    private final BillLifecycleService lifecycleService;
    private final NumberingService numberingService;
    private final ConversionService conversionService;
    private final ProductSnapshotService productSnapshotService;
    private final TenantDataScopeService tenantDataScopeService;

    public StockCountAppService(
        JdbcTemplate jdbcTemplate,
        LookupService lookupService,
        ValidationService validationService,
        BillLifecycleService lifecycleService,
        NumberingService numberingService,
        ConversionService conversionService,
        ProductSnapshotService productSnapshotService,
        TenantDataScopeService tenantDataScopeService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.lookupService = lookupService;
        this.validationService = validationService;
        this.lifecycleService = lifecycleService;
        this.numberingService = numberingService;
        this.conversionService = conversionService;
        this.productSnapshotService = productSnapshotService;
        this.tenantDataScopeService = tenantDataScopeService;
    }

    @Transactional(readOnly = true)
    public Map<String, Object> bookQuantity(String productId, String productCode, String warehouseCode) {
        var product = productSnapshotService.resolve(productId, productCode, "商品");
        var resolvedWarehouseCode = validationService.required(warehouseCode, "仓库编码");
        var warehouseId = lookupService.lookupEnabledId("md_warehouse", resolvedWarehouseCode, "仓库");
        return Map.of(
            "productId", product.id(),
            "productCode", product.code(),
            "warehouseCode", resolvedWarehouseCode,
            "bookQuantity", currentStockQty(product.id(), warehouseId)
        );
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
                   l.product_id::text AS "productId",
                   COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                   COALESCE(l.product_name_snapshot, p.name) AS "productName",
                   COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
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
        var billNo = numberingService.assignBillNo("stockCount", request.billNo());
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
            billNo,
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
        return lifecycleService.transition(BILL_TABLE, billNo, BillStatus.AUDITED, BillStatus.DRAFT,
            "id::text AS id, bill_no AS \"billNo\", status", "INVENTORY", "REVERSE", "stock_count", "盘点单不存在或不能反审核");
    }

    @Transactional
    public Map<String, Object> voidBill(String billNo, VoidRequest request) {
        return lifecycleService.voidBill(LIFECYCLE_TARGET, billNo, request);
    }

    private void insertLines(Object billId, List<StockCountLineRequest> lines) {
        var lineNo = 1;
        for (var line : lines) {
            var product = productSnapshotService.resolveForReference(line.productId(), line.productCode(), "商品");
            var warehouseId = lookupService.lookupEnabledId("md_warehouse", line.warehouseCode(), "仓库");
            var countedQty = nonNegative(line.qty(), "实盘数量");
            var systemQty = currentStockQty(product.id(), warehouseId);
            var unitPrice = nonNegativePrice(line.unitPrice());
            jdbcTemplate.update("""
                INSERT INTO stock_count_line (bill_id, line_no, product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot, warehouse_id, system_qty, counted_qty, diff_qty, unit_price, line_remark)
                VALUES (?::uuid, ?, ?::uuid, ?, ?, ?, ?::uuid, ?, ?, ?, ?, ?)
                """,
                billId,
                lineNo,
                product.id(),
                product.code(),
                product.name(),
                product.spec(),
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
                WHERE account_set_id = ?::uuid
                  AND product_id = ?::uuid
                  AND warehouse_id = ?::uuid
            ), 0)
            """, BigDecimal.class, tenantDataScopeService.currentScopeId("inventory"), productId, warehouseId);
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

    public record StockCountLineRequest(String productId, String productCode, String warehouseCode, Integer sourceLineNo, BigDecimal qty, BigDecimal unitPrice, String lineRemark) {
    }
}
