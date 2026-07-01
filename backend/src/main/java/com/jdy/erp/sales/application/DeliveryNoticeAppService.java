package com.jdy.erp.sales.application;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import com.jdy.erp.inventory.application.InventoryPostingService;
import com.jdy.erp.shared.application.BillLifecycleService;
import com.jdy.erp.shared.application.BillLifecycleService.BillLifecycleTarget;
import com.jdy.erp.shared.application.ConversionService.SourceExecutionSpec;
import com.jdy.erp.shared.application.LookupService;
import com.jdy.erp.shared.application.NumberingService;
import com.jdy.erp.shared.application.ProductSnapshotService;
import com.jdy.erp.shared.application.TaxAmountCalculator;
import com.jdy.erp.shared.application.ValidationService;
import com.jdy.erp.shared.domain.BillStatus;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantDataScopeService;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class DeliveryNoticeAppService {
    private static final String BILL_TABLE = "delivery_notice";
    private static final BillLifecycleTarget LIFECYCLE_TARGET = new BillLifecycleTarget(BILL_TABLE, "delivery_notice_line", "bill_id", "SALES", "delivery_notice");
    private static final SourceExecutionSpec SALES_ORDER_NOTICE_SPEC = new SourceExecutionSpec(
        "sales_order",
        "sales_order_line",
        "order_id",
        "line_no",
        "shipped_qty",
        "qty",
        "out_status",
        "发货通知数量不能超过销售订单剩余可通知数量"
    );

    private final JdbcTemplate jdbcTemplate;
    private final LookupService lookupService;
    private final ValidationService validationService;
    private final BillLifecycleService lifecycleService;
    private final NumberingService numberingService;
    private final CurrentSessionService currentSessionService;
    private final TaxAmountCalculator taxAmountCalculator;
    private final InventoryPostingService inventoryPostingService;
    private final ProductSnapshotService productSnapshotService;
    private final TenantDataScopeService tenantDataScopeService;

    public DeliveryNoticeAppService(
        JdbcTemplate jdbcTemplate,
        LookupService lookupService,
        ValidationService validationService,
        BillLifecycleService lifecycleService,
        NumberingService numberingService,
        CurrentSessionService currentSessionService,
        TaxAmountCalculator taxAmountCalculator,
        InventoryPostingService inventoryPostingService,
        ProductSnapshotService productSnapshotService,
        TenantDataScopeService tenantDataScopeService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.lookupService = lookupService;
        this.validationService = validationService;
        this.lifecycleService = lifecycleService;
        this.numberingService = numberingService;
        this.currentSessionService = currentSessionService;
        this.taxAmountCalculator = taxAmountCalculator;
        this.inventoryPostingService = inventoryPostingService;
        this.productSnapshotService = productSnapshotService;
        this.tenantDataScopeService = tenantDataScopeService;
    }

    public Map<String, Object> detail(String billNo) {
        var billRows = jdbcTemplate.queryForList("""
            SELECT dn.id::text AS id,
                   dn.bill_no AS "billNo",
                   c.code AS "customerCode",
                   c.name AS customer,
                   to_char(dn.bill_date, 'YYYY-MM-DD') AS "billDate",
                   dn.department,
                   dn.status,
                   dn.close_status AS "closeStatus",
                   dn.frozen_status AS "frozenStatus",
                   dn.total_amount AS "totalAmount",
                   dn.is_tax_inclusive AS "isTaxInclusive",
                   dn.owner_name AS "ownerName",
                   COALESCE(creator.display_name, dn.owner_name, '') AS "createdByName",
                   COALESCE(dn.remark, '') AS remark
            FROM delivery_notice dn
            JOIN md_customer c ON c.id = dn.customer_id
            LEFT JOIN public.sys_user creator ON creator.id = dn.created_by
            WHERE dn.bill_no = ?
            """, billNo);
        if (billRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "发货通知单不存在");
        }
        return Map.of("action", "DETAIL", "document", billRows.get(0), "lines", detailLines(billNo));
    }

    @Transactional
    public Map<String, Object> saveDraft(DeliveryNoticeDraftRequest request) {
        var billNo = numberingService.assignBillNo("deliveryNotice", request.billNo());
        var customerId = lookupService.lookupEnabledId("md_customer", request.customerCode(), "客户");
        var isTaxInclusive = Boolean.TRUE.equals(request.isTaxInclusive());
        var totalAmount = request.lines().stream()
            .map(line -> taxAmountCalculator.calculate(line.qty(), line.unitPrice(), line.taxRate(), isTaxInclusive).priceTaxTotal())
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        var bill = jdbcTemplate.queryForMap("""
            INSERT INTO delivery_notice (bill_no, customer_id, bill_date, department, status, total_amount, is_tax_inclusive, owner_name, remark, created_by)
            VALUES (?, ?::uuid, ?, ?, ?, ?, ?, ?, ?, ?::uuid)
            ON CONFLICT (bill_no) DO UPDATE
            SET customer_id = EXCLUDED.customer_id,
                bill_date = EXCLUDED.bill_date,
                department = EXCLUDED.department,
                status = EXCLUDED.status,
                total_amount = EXCLUDED.total_amount,
                is_tax_inclusive = EXCLUDED.is_tax_inclusive,
                owner_name = EXCLUDED.owner_name,
                remark = EXCLUDED.remark,
                updated_at = now(),
                version = delivery_notice.version + 1
            RETURNING id::text AS id, bill_no AS "billNo", total_amount AS "totalAmount"
            """,
            billNo,
            customerId,
            LocalDate.parse(validationService.required(request.billDate(), "业务日期")),
            request.department(),
            BillStatus.DRAFT.name(),
            totalAmount,
            isTaxInclusive,
            currentSessionService.currentDisplayName(),
            validationService.optionalText(request.remark()),
            currentSessionService.currentUserId()
        );
        var billId = bill.get("id");
        jdbcTemplate.update("DELETE FROM delivery_notice_line WHERE bill_id = ?::uuid", billId);
        insertLines(billId, request.sourceOrderNo(), request.lines(), isTaxInclusive);
        return bill;
    }

    @Transactional
    public Map<String, Object> audit(String billNo) {
        var row = lifecycleService.transition(
            BILL_TABLE,
            billNo,
            BillStatus.DRAFT,
            BillStatus.AUDITED,
            "id::text AS id, bill_no AS \"billNo\", status",
            "SALES",
            "AUDIT",
            "delivery_notice",
            "发货通知单不存在或已审核"
        );
        var lines = postingLines(billNo);
        guardSourceOrderNoticeQuantity(lines, billNo);
        for (var line : lines) {
            inventoryPostingService.reserve(
                String.valueOf(line.get("productCode")),
                String.valueOf(line.get("warehouseCode")),
                (BigDecimal) line.get("qty"),
                "DELIVERY_NOTICE_RESERVE",
                "DELIVERY_NOTICE:" + billNo
            );
        }
        return row;
    }

    @Transactional
    public Map<String, Object> reverse(String billNo) {
        if (downstreamSalesOutCount(billNo) > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "发货通知单已有下游销售出库，不能反审核");
        }
        var row = lifecycleService.transition(
            BILL_TABLE,
            billNo,
            BillStatus.AUDITED,
            BillStatus.DRAFT,
            "id::text AS id, bill_no AS \"billNo\", status",
            "SALES",
            "REVERSE",
            "delivery_notice",
            "发货通知单不存在或不能反审核"
        );
        for (var line : postingLines(billNo)) {
            inventoryPostingService.releaseReservation(
                String.valueOf(line.get("productCode")),
                String.valueOf(line.get("warehouseCode")),
                (BigDecimal) line.get("qty"),
                "DELIVERY_NOTICE_RESERVE_REVERSE",
                "DELIVERY_NOTICE_REVERSE:" + billNo
            );
        }
        return row;
    }

    public Map<String, Object> selectableLines(String customerCode) {
        var rows = jdbcTemplate.queryForList("""
            SELECT dn.bill_no AS "billNo",
                   c.code AS "customerCode",
                   c.name AS customer,
                   to_char(dn.bill_date, 'YYYY-MM-DD') AS "billDate",
                   dn.department,
                   dn.owner_name AS "ownerName",
                   dn.is_tax_inclusive AS "isTaxInclusive",
                   l.line_no AS "lineNo",
                   l.source_order_no AS "sourceOrderNo",
                   l.source_line_no AS "sourceLineNo",
                   l.product_id::text AS "productId",
                   COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                   COALESCE(l.product_name_snapshot, p.name) AS "productName",
                   COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                   w.code AS "warehouseCode",
                   l.qty AS "sourceQty",
                   COALESCE(out_qty.shipped_qty, 0) AS "shippedQty",
                   GREATEST(0, l.qty - COALESCE(out_qty.shipped_qty, 0)) AS "remainingQty",
                   l.unit_price AS "unitPrice",
                   l.tax_rate AS "taxRate",
                   COALESCE(l.customer_material_code, '') AS "customerMaterialCode",
                   COALESCE(l.customer_order_no, '') AS "customerOrderNo",
                   COALESCE(l.line_remark, '') AS "lineRemark",
                   to_char(l.plan_delivery_date, 'YYYY-MM-DD') AS "planDeliveryDate",
                   COALESCE(b.qty_on_hand, 0) AS "stockOnHand",
                   COALESCE(b.qty_reserved, 0) AS "stockReserved",
                   COALESCE(b.qty_available, 0) AS "stockAvailable",
                   COALESCE(it.qty, 0) AS "stockInTransit"
            FROM delivery_notice dn
            JOIN md_customer c ON c.id = dn.customer_id
            JOIN delivery_notice_line l ON l.bill_id = dn.id
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.warehouse_id
            LEFT JOIN inv_stock_balance b ON b.product_id = l.product_id AND b.warehouse_id = l.warehouse_id AND b.account_set_id = ?::uuid
            LEFT JOIN (
                SELECT pol.product_id, pol.warehouse_id,
                       SUM(GREATEST(0, pol.qty - pol.received_qty)) AS qty
                FROM purchase_order_line pol
                JOIN purchase_order po ON po.id = pol.order_id
                WHERE po.status = 'AUDITED'
                  AND pol.qty > pol.received_qty
                GROUP BY pol.product_id, pol.warehouse_id
            ) it ON it.product_id = l.product_id AND it.warehouse_id = l.warehouse_id
            LEFT JOIN (
                SELECT source_delivery_notice_no, source_delivery_line_no, SUM(qty) AS shipped_qty
                FROM sales_out_line sol
                JOIN sales_out so ON so.id = sol.bill_id
                WHERE so.status <> 'VOID'
                GROUP BY source_delivery_notice_no, source_delivery_line_no
            ) out_qty ON out_qty.source_delivery_notice_no = dn.bill_no AND out_qty.source_delivery_line_no = l.line_no
            WHERE c.code = ?
              AND dn.status = 'AUDITED'
              AND GREATEST(0, l.qty - COALESCE(out_qty.shipped_qty, 0)) > 0
            ORDER BY dn.bill_date DESC, dn.bill_no DESC, l.line_no
            """, inventoryScopeId(), customerCode == null ? "" : customerCode.trim());
        return Map.of("customerCode", customerCode == null ? "" : customerCode.trim(), "lines", rows);
    }

    public Map<String, Object> delete(String billNo) {
        return lifecycleService.deleteDraft(LIFECYCLE_TARGET, billNo, "只有草稿发货通知单可以删除");
    }

    public Map<String, Object> stockSnapshot(String billNo) {
        return Map.of("billNo", billNo, "lines", stockRowsForBill(billNo));
    }

    private void insertLines(Object billId, String defaultSourceOrderNo, List<DeliveryNoticeLineRequest> lines, boolean isTaxInclusive) {
        var lineNo = 1;
        for (var line : lines) {
            var product = productSnapshotService.resolve(line.productId(), line.productCode(), "商品");
            var warehouseId = lookupService.lookupEnabledId("md_warehouse", line.warehouseCode(), "仓库");
            var amounts = taxAmountCalculator.calculate(line.qty(), line.unitPrice(), line.taxRate(), isTaxInclusive);
            var sourceOrderNo = validationService.optionalText(line.sourceOrderNo() == null || line.sourceOrderNo().isBlank() ? defaultSourceOrderNo : line.sourceOrderNo());
            var sourceLineNo = line.sourceLineNo() == null && sourceOrderNo != null ? lineNo : line.sourceLineNo();
            jdbcTemplate.update("""
                INSERT INTO delivery_notice_line (bill_id, line_no, source_order_no, source_line_no, product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot, warehouse_id, qty, unit_price, amount, tax_rate, tax_amount, price_tax_total, customer_material_code, customer_order_no, line_remark, plan_delivery_date)
                VALUES (?::uuid, ?, ?, ?, ?::uuid, ?, ?, ?, ?::uuid, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                billId,
                lineNo,
                sourceOrderNo,
                sourceLineNo,
                product.id(),
                product.code(),
                product.name(),
                product.spec(),
                warehouseId,
                line.qty(),
                line.unitPrice(),
                amounts.amount(),
                amounts.taxRate(),
                amounts.taxAmount(),
                amounts.priceTaxTotal(),
                validationService.optionalText(line.customerMaterialCode()),
                validationService.optionalText(line.customerOrderNo()),
                validationService.optionalText(line.lineRemark()),
                optionalDate(line.planDeliveryDate())
            );
            lineNo += 1;
        }
    }

    private List<Map<String, Object>> detailLines(String billNo) {
        var lines = jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo",
                   l.source_order_no AS "sourceOrderNo",
                   l.source_line_no AS "sourceLineNo",
                   l.product_id::text AS "productId",
                   COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                   COALESCE(l.product_name_snapshot, p.name) AS "productName",
                   COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                   w.code AS "warehouseCode",
                   l.qty,
                   COALESCE(out_qty.shipped_qty, 0) AS "shippedQty",
                   GREATEST(0, l.qty - COALESCE(out_qty.shipped_qty, 0)) AS "remainingQty",
                   l.line_close_status AS "lineCloseStatus",
                   l.line_frozen_status AS "lineFrozenStatus",
                   l.unit_price AS "unitPrice",
                   l.amount,
                   l.tax_rate AS "taxRate",
                   l.tax_amount AS "taxAmount",
                   l.price_tax_total AS "priceTaxTotal",
                   COALESCE(l.customer_material_code, '') AS "customerMaterialCode",
                   COALESCE(l.customer_order_no, '') AS "customerOrderNo",
                   COALESCE(l.line_remark, '') AS "lineRemark",
                   to_char(l.plan_delivery_date, 'YYYY-MM-DD') AS "planDeliveryDate",
                   COALESCE(b.qty_on_hand, 0) AS "stockOnHand",
                   COALESCE(b.qty_reserved, 0) AS "stockReserved",
                   COALESCE(b.qty_available, 0) AS "stockAvailable",
                   COALESCE(it.qty, 0) AS "stockInTransit"
            FROM delivery_notice_line l
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.warehouse_id
            JOIN delivery_notice dn ON dn.id = l.bill_id
            LEFT JOIN inv_stock_balance b ON b.product_id = l.product_id AND b.warehouse_id = l.warehouse_id AND b.account_set_id = ?::uuid
            LEFT JOIN (
                SELECT pol.product_id, pol.warehouse_id,
                       SUM(GREATEST(0, pol.qty - pol.received_qty)) AS qty
                FROM purchase_order_line pol
                JOIN purchase_order po ON po.id = pol.order_id
                WHERE po.status = 'AUDITED'
                  AND pol.qty > pol.received_qty
                GROUP BY pol.product_id, pol.warehouse_id
            ) it ON it.product_id = l.product_id AND it.warehouse_id = l.warehouse_id
            LEFT JOIN (
                SELECT source_delivery_notice_no, source_delivery_line_no, SUM(qty) AS shipped_qty
                FROM sales_out_line sol
                JOIN sales_out so ON so.id = sol.bill_id
                WHERE so.status <> 'VOID'
                GROUP BY source_delivery_notice_no, source_delivery_line_no
            ) out_qty ON out_qty.source_delivery_notice_no = dn.bill_no AND out_qty.source_delivery_line_no = l.line_no
            WHERE dn.bill_no = ?
            ORDER BY l.line_no
            """, inventoryScopeId(), billNo);
        return mergeStock(lines, stockRowsForBill(billNo));
    }

    private List<Map<String, Object>> postingLines(String billNo) {
        return jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo",
                   l.source_order_no AS "sourceOrderNo",
                   l.source_line_no AS "sourceLineNo",
                   COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                   w.code AS "warehouseCode",
                   l.qty
            FROM delivery_notice_line l
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.warehouse_id
            JOIN delivery_notice dn ON dn.id = l.bill_id
            WHERE dn.bill_no = ?
            ORDER BY l.line_no
            """, billNo);
    }

    private List<Map<String, Object>> stockRowsForBill(String billNo) {
        return jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo",
                   COALESCE(b.qty_on_hand, 0) AS "stockOnHand",
                   COALESCE(b.qty_reserved, 0) AS "stockReserved",
                   COALESCE(b.qty_available, 0) AS "stockAvailable",
                   COALESCE(it.qty, 0) AS "stockInTransit"
            FROM delivery_notice_line l
            JOIN delivery_notice dn ON dn.id = l.bill_id
            LEFT JOIN inv_stock_balance b ON b.product_id = l.product_id AND b.warehouse_id = l.warehouse_id AND b.account_set_id = ?::uuid
            LEFT JOIN (
                SELECT pol.product_id, pol.warehouse_id,
                       SUM(GREATEST(0, pol.qty - pol.received_qty)) AS qty
                FROM purchase_order_line pol
                JOIN purchase_order po ON po.id = pol.order_id
                WHERE po.status = 'AUDITED'
                  AND pol.qty > pol.received_qty
                GROUP BY pol.product_id, pol.warehouse_id
            ) it ON it.product_id = l.product_id AND it.warehouse_id = l.warehouse_id
            WHERE dn.bill_no = ?
            ORDER BY l.line_no
            """, inventoryScopeId(), billNo);
    }

    private List<Map<String, Object>> mergeStock(List<Map<String, Object>> lines, List<Map<String, Object>> stocks) {
        var byLine = new HashMap<Object, Map<String, Object>>();
        stocks.forEach(row -> byLine.put(row.get("lineNo"), row));
        return lines.stream().<Map<String, Object>>map(line -> {
            var copy = new HashMap<String, Object>(line);
            var stock = byLine.get(line.get("lineNo"));
            if (stock != null) {
                copy.putAll(stock);
            }
            return copy;
        }).toList();
    }

    private void guardSourceOrderNoticeQuantity(List<Map<String, Object>> lines, String billNo) {
        for (var line : lines) {
            if (line.get("sourceOrderNo") == null || line.get("sourceLineNo") == null) {
                continue;
            }
            var sourceRows = jdbcTemplate.queryForList(
                "SELECT id::text AS id FROM sales_order WHERE bill_no = ? AND status = ?",
                String.valueOf(line.get("sourceOrderNo")),
                BillStatus.AUDITED.name()
            );
            if (sourceRows.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "销售订单不存在或未审核，不能下推发货通知");
            }
            lifecycleService.guardExecutableSourceLine(SALES_ORDER_NOTICE_SPEC, String.valueOf(sourceRows.get(0).get("id")), line.get("sourceLineNo"));
            var remaining = jdbcTemplate.queryForObject("""
                SELECT sol.qty - COALESCE(notice.noticed_qty, 0)
                FROM sales_order so
                JOIN sales_order_line sol ON sol.order_id = so.id AND sol.line_no = ?
                LEFT JOIN (
                    SELECT source_order_no, source_line_no, SUM(dnl.qty) AS noticed_qty
                    FROM delivery_notice_line dnl
                    JOIN delivery_notice dn ON dn.id = dnl.bill_id
                    WHERE dn.status = 'AUDITED' AND dn.bill_no <> ?
                    GROUP BY source_order_no, source_line_no
                ) notice ON notice.source_order_no = so.bill_no AND notice.source_line_no = sol.line_no
                WHERE so.bill_no = ?
                """, BigDecimal.class, line.get("sourceLineNo"), billNo, line.get("sourceOrderNo"));
            if (remaining == null || remaining.compareTo((BigDecimal) line.get("qty")) < 0) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "发货通知数量不能超过销售订单剩余可通知数量");
            }
        }
    }

    private long downstreamSalesOutCount(String billNo) {
        var value = jdbcTemplate.queryForObject("""
            SELECT COUNT(*)
            FROM sales_out_line sol
            JOIN sales_out so ON so.id = sol.bill_id
            WHERE sol.source_delivery_notice_no = ? AND so.status <> 'VOID'
            """, Long.class, billNo);
        return value == null ? 0 : value;
    }

    private LocalDate optionalDate(String value) {
        return value == null || value.isBlank() ? null : LocalDate.parse(value);
    }

    private String inventoryScopeId() {
        return tenantDataScopeService.currentScopeId("inventory");
    }

    public record DeliveryNoticeDraftRequest(String billNo, String sourceOrderNo, String customerCode, String billDate, String department, String ownerName, String remark, Boolean isTaxInclusive, List<DeliveryNoticeLineRequest> lines) {
        public DeliveryNoticeDraftRequest {
            if (lines == null || lines.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "至少需要一条分录");
            }
        }
    }

    public record DeliveryNoticeLineRequest(String productId, String productCode, String warehouseCode, String sourceOrderNo, Integer sourceLineNo, BigDecimal qty, BigDecimal unitPrice, BigDecimal taxRate, String customerMaterialCode, String customerOrderNo, String lineRemark, String planDeliveryDate) {
    }
}
