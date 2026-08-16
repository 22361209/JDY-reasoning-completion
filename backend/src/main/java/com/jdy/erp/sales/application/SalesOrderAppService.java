package com.jdy.erp.sales.application;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import org.springframework.http.HttpStatus;
import com.jdy.erp.shared.application.BillLifecycleService;
import com.jdy.erp.shared.application.BillLifecycleService.BillLifecycleTarget;
import com.jdy.erp.shared.application.LookupService;
import com.jdy.erp.shared.application.NumberingService;
import com.jdy.erp.shared.application.ProductSnapshotService;
import com.jdy.erp.shared.application.TaxAmountCalculator;
import com.jdy.erp.shared.application.ValidationService;
import com.jdy.erp.shared.domain.BillStatus;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantDataScopeService;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class SalesOrderAppService {
    private static final String BILL_TABLE = "sales_order";
    private static final BillLifecycleTarget LIFECYCLE_TARGET = new BillLifecycleTarget(BILL_TABLE, "sales_order_line", "order_id", "SALES", "sales_order");

    private final JdbcTemplate jdbcTemplate;
    private final LookupService lookupService;
    private final ValidationService validationService;
    private final BillLifecycleService lifecycleService;
    private final NumberingService numberingService;
    private final CurrentSessionService currentSessionService;
    private final TaxAmountCalculator taxAmountCalculator;
    private final ProductSnapshotService productSnapshotService;
    private final TenantDataScopeService tenantDataScopeService;

    public SalesOrderAppService(
        JdbcTemplate jdbcTemplate,
        LookupService lookupService,
        ValidationService validationService,
        BillLifecycleService lifecycleService,
        NumberingService numberingService,
        CurrentSessionService currentSessionService,
        TaxAmountCalculator taxAmountCalculator,
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
        this.productSnapshotService = productSnapshotService;
        this.tenantDataScopeService = tenantDataScopeService;
    }

    @Transactional
    public Map<String, Object> saveDraft(SalesOrderDraftRequest request) {
        request.lines().forEach(line -> validationService.nonNegative(line.qty(), "销售订单数量"));
        var billNo = numberingService.assignBillNo("salesOrder", request.billNo());
        var customerId = lookupService.lookupEnabledId("md_customer", request.customerCode(), "客户");
        var totalAmount = request.lines().stream()
            .map(line -> taxAmountCalculator.calculate(line.qty(), line.unitPrice(), line.taxRate()).priceTaxTotal())
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        var ownerName = currentSessionService.currentDisplayName();
        var createdBy = currentSessionService.currentUserId();
        var currency = normalizeCurrency(request.currency());
        var order = jdbcTemplate.queryForMap("""
            INSERT INTO sales_order (bill_no, customer_id, bill_date, department, status, total_amount, currency, owner_name, remark, created_by)
            VALUES (?, ?::uuid, ?, ?, ?, ?, ?, ?, ?, ?::uuid)
            ON CONFLICT (bill_no) DO UPDATE
            SET customer_id = EXCLUDED.customer_id,
                bill_date = EXCLUDED.bill_date,
                department = EXCLUDED.department,
                status = EXCLUDED.status,
                out_status = 'NOT_OUT',
                close_status = 'OPEN',
                close_mode = NULL,
                close_reason = NULL,
                closed_by = NULL,
                closed_at = NULL,
                frozen_status = 'NORMAL',
                frozen_reason = NULL,
                frozen_by = NULL,
                frozen_at = NULL,
                total_amount = EXCLUDED.total_amount,
                currency = EXCLUDED.currency,
                owner_name = EXCLUDED.owner_name,
                remark = EXCLUDED.remark,
                updated_at = now(),
                version = sales_order.version + 1
            RETURNING id::text AS id, bill_no AS "billNo", total_amount AS "totalAmount", currency
            """,
            billNo,
            customerId,
            LocalDate.parse(validationService.required(request.billDate(), "业务日期")),
            request.department(),
            BillStatus.DRAFT.name(),
            totalAmount,
            currency,
            ownerName,
            validationService.optionalText(request.remark()),
            createdBy
        );
        var orderId = order.get("id");
        jdbcTemplate.update("DELETE FROM sales_order_line WHERE order_id = ?::uuid", orderId);
        var lineNo = 1;
        for (var line : request.lines()) {
            var product = productSnapshotService.resolveForReference(line.productId(), line.productCode(), "商品");
            var warehouseId = lookupService.lookupEnabledId("md_warehouse", line.warehouseCode(), "仓库");
            var amounts = taxAmountCalculator.calculate(line.qty(), line.unitPrice(), line.taxRate());
            jdbcTemplate.update("""
                INSERT INTO sales_order_line (order_id, line_no, source_order_no, source_line_no, product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot, warehouse_id, qty, unit_price, amount, tax_rate, tax_amount, price_tax_total, customer_material_code, customer_order_no, line_remark, plan_delivery_date)
                VALUES (?::uuid, ?, ?, ?, ?::uuid, ?, ?, ?, ?::uuid, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                orderId,
                lineNo,
                validationService.optionalText(line.sourceOrderNo()),
                line.sourceLineNo(),
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
        return order;
    }

    @Transactional
    public Map<String, Object> audit(String billNo) {
        lifecycleService.guardPositiveLineQuantities(LIFECYCLE_TARGET, billNo, "销售订单数量必须大于 0");
        return lifecycleService.transition(
            BILL_TABLE,
            billNo,
            BillStatus.DRAFT,
            BillStatus.AUDITED,
            "id::text AS id, bill_no AS \"billNo\", status",
            "SALES",
            "AUDIT",
            "sales_order",
            "销售订单不存在或状态不允许操作"
        );
    }

    @Transactional
    public Map<String, Object> reverse(String billNo) {
        var downstreamCount = jdbcTemplate.queryForObject("""
            SELECT COUNT(*)
            FROM sales_order so
            JOIN delivery_notice_line dnl ON dnl.source_order_no = so.bill_no
            JOIN delivery_notice dn ON dn.id = dnl.bill_id
            WHERE so.bill_no = ? AND dn.status = ?
            """, Long.class, billNo, BillStatus.AUDITED.name());
        if (downstreamCount != null && downstreamCount > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "销售订单已有已审核发货通知单，不能反审核");
        }
        return lifecycleService.transition(
            BILL_TABLE,
            billNo,
            BillStatus.AUDITED,
            BillStatus.DRAFT,
            "id::text AS id, bill_no AS \"billNo\", status",
            "SALES",
            "REVERSE",
            "sales_order",
            "销售订单不存在或不能反审核"
        );
    }

    public Map<String, Object> delete(String billNo) {
        return lifecycleService.deleteDraft(LIFECYCLE_TARGET, billNo, "只有草稿销售订单可以删除");
    }

    public Map<String, Object> detail(String billNo) {
        return orderPayload(billNo, "DETAIL");
    }

    public Map<String, Object> export(String billNo) {
        return orderPayload(billNo, "EXPORT");
    }

    public Map<String, Object> print(String billNo) {
        return orderPayload(billNo, "PRINT");
    }

    public Map<String, Object> selectableLines(String customerCode) {
        var rows = jdbcTemplate.queryForList("""
            SELECT so.bill_no AS "billNo",
                   c.code AS "customerCode",
                   c.name AS customer,
                   to_char(so.bill_date, 'YYYY-MM-DD') AS "billDate",
                   so.department,
                   so.currency,
                   so.owner_name AS "ownerName",
                   l.line_no AS "lineNo",
                   l.product_id::text AS "productId",
                   COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                   COALESCE(l.product_name_snapshot, p.name) AS "productName",
                   COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                   w.code AS "warehouseCode",
                   l.qty AS "sourceQty",
                   l.shipped_qty AS "shippedQty",
                   GREATEST(0, l.qty - COALESCE(notice.noticed_qty, 0)) AS "remainingQty",
                   GREATEST(0, l.qty - COALESCE(notice.noticed_qty, 0)) AS "availableNoticeQty",
                   l.line_close_status AS "lineCloseStatus",
                   l.line_frozen_status AS "lineFrozenStatus",
                   l.unit_price AS "unitPrice",
                   round(l.unit_price * (1 + COALESCE(l.tax_rate, 0) / 100), 2) AS "taxInclusiveUnitPrice",
                   l.tax_rate AS "taxRate",
                   COALESCE(l.customer_material_code, '') AS "customerMaterialCode",
                   COALESCE(l.customer_order_no, '') AS "customerOrderNo",
                   COALESCE(l.line_remark, '') AS "lineRemark",
                   to_char(l.plan_delivery_date, 'YYYY-MM-DD') AS "planDeliveryDate",
                   COALESCE(b.qty_on_hand, 0) AS "stockOnHand",
                   COALESCE(b.qty_reserved, 0) AS "stockReserved",
                   COALESCE(b.qty_available, 0) AS "stockAvailable",
                   COALESCE(it.qty, 0) AS "stockInTransit"
            FROM sales_order so
            JOIN md_customer c ON c.id = so.customer_id
            JOIN sales_order_line l ON l.order_id = so.id
            JOIN md_product p ON p.id = l.product_id
            LEFT JOIN md_warehouse w ON w.id = l.warehouse_id
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
                SELECT source_order_no, source_line_no, SUM(dnl.qty) AS noticed_qty
                FROM delivery_notice_line dnl
                JOIN delivery_notice dn ON dn.id = dnl.bill_id
                WHERE dn.status = 'AUDITED'
                GROUP BY source_order_no, source_line_no
            ) notice ON notice.source_order_no = so.bill_no AND notice.source_line_no = l.line_no
            WHERE c.code = ?
              AND so.status = ?
              AND so.close_status = 'OPEN'
              AND so.frozen_status = 'NORMAL'
              AND l.line_close_status = 'OPEN'
              AND l.line_frozen_status = 'NORMAL'
              AND GREATEST(0, l.qty - COALESCE(notice.noticed_qty, 0)) > 0
            ORDER BY so.bill_date DESC, so.bill_no DESC, l.line_no
            """, inventoryScopeId(), customerCode == null ? "" : customerCode.trim(), BillStatus.AUDITED.name());
        return Map.of("customerCode", customerCode == null ? "" : customerCode.trim(), "lines", rows);
    }

    private Map<String, Object> orderPayload(String billNo, String action) {
        var orderRows = jdbcTemplate.queryForList("""
            SELECT so.id::text AS id,
                   so.bill_no AS "billNo",
                   c.code AS "customerCode",
                   c.name AS customer,
                   to_char(so.bill_date, 'YYYY-MM-DD') AS "billDate",
                   so.department,
                   so.status,
                   so.close_status AS "closeStatus",
                   so.close_mode AS "closeMode",
                   so.frozen_status AS "frozenStatus",
                   so.total_amount AS "totalAmount",
                   so.currency,
                   so.owner_name AS "ownerName",
                   COALESCE(creator.display_name, so.owner_name, '') AS "createdByName",
                   COALESCE(so.remark, '') AS remark
            FROM sales_order so
            JOIN md_customer c ON c.id = so.customer_id
            LEFT JOIN public.sys_user creator ON creator.id = so.created_by
            WHERE so.bill_no = ?
            """, billNo);
        if (orderRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "销售订单不存在");
        }
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
                   l.shipped_qty AS "shippedQty",
                   GREATEST(0, l.qty - COALESCE(l.shipped_qty, 0)) AS "remainingQty",
                   GREATEST(0, l.qty - COALESCE(notice.noticed_qty, 0)) AS "availableNoticeQty",
                   l.line_close_status AS "lineCloseStatus",
                   l.line_frozen_status AS "lineFrozenStatus",
                   l.unit_price AS "unitPrice",
                   round(l.unit_price * (1 + COALESCE(l.tax_rate, 0) / 100), 2) AS "taxInclusiveUnitPrice",
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
            FROM sales_order_line l
            JOIN sales_order so ON so.id = l.order_id
            JOIN md_product p ON p.id = l.product_id
            LEFT JOIN md_warehouse w ON w.id = l.warehouse_id
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
                SELECT source_order_no, source_line_no, SUM(dnl.qty) AS noticed_qty
                FROM delivery_notice_line dnl
                JOIN delivery_notice dn ON dn.id = dnl.bill_id
                WHERE dn.status = 'AUDITED'
                GROUP BY source_order_no, source_line_no
            ) notice ON notice.source_order_no = so.bill_no AND notice.source_line_no = l.line_no
            WHERE so.bill_no = ?
            ORDER BY l.line_no
            """, inventoryScopeId(), billNo);
        var sourceOrderId = String.valueOf(orderRows.get(0).get("id"));
        var enrichedLines = lines.stream().map(line -> {
            var copy = new HashMap<String, Object>(line);
            copy.put("downstreamDocs", downstreamSalesOutDocs(sourceOrderId, line.get("lineNo")));
            return copy;
        }).toList();
        return Map.of("action", action, "order", orderRows.get(0), "lines", enrichedLines);
    }

    private List<Map<String, Object>> downstreamSalesOutDocs(String sourceOrderId, Object sourceLineNo) {
        var docs = jdbcTemplate.queryForList("""
            SELECT dn.bill_no AS "billNo",
                   'deliveryNotice' AS type,
                   '发货通知单' AS "typeLabel",
                   dn.status,
                   to_char(dn.bill_date, 'YYYY-MM-DD') AS "billDate",
                   COALESCE(l.source_line_no, l.line_no) AS "sourceLineNo",
                   l.line_no AS "downstreamLineNo",
                   l.qty,
                   l.amount,
                   l.price_tax_total AS "priceTaxTotal"
            FROM delivery_notice_line l
            JOIN delivery_notice dn ON dn.id = l.bill_id
            JOIN sales_order src ON src.bill_no = l.source_order_no
            WHERE src.id = ?::uuid
              AND COALESCE(l.source_line_no, l.line_no) = ?
              AND dn.status = ?
            ORDER BY dn.bill_date DESC, dn.bill_no DESC, l.line_no
            """, sourceOrderId, sourceLineNo, BillStatus.AUDITED.name());
        return docs.stream().<Map<String, Object>>map(doc -> {
            var copy = new HashMap<String, Object>(doc);
            copy.put("riskLevel", "HIGH");
            copy.put("reverseImpact", "反审核发货通知将释放预留库存，并恢复源销售订单第 "
                + doc.get("sourceLineNo") + " 行可通知数量 " + doc.get("qty") + "。");
            copy.put("redReverseImpact", "发货通知单不支持红冲；如已下推出库需先处理销售出库。");
            return copy;
        }).toList();
    }

    public record SalesOrderDraftRequest(
        String billNo,
        String customerCode,
        String billDate,
        String department,
        String ownerName,
        String remark,
        String currency,
        List<SalesOrderLineRequest> lines
    ) {
        public SalesOrderDraftRequest(
            String billNo,
            String customerCode,
            String billDate,
            String department,
            String ownerName,
            String remark,
            List<SalesOrderLineRequest> lines
        ) {
            this(billNo, customerCode, billDate, department, ownerName, remark, "CNY", lines);
        }

        public SalesOrderDraftRequest {
            if (lines == null || lines.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "至少需要一条分录");
            }
        }
    }

    public record SalesOrderLineRequest(
        String productId,
        String productCode,
        String warehouseCode,
        String sourceOrderNo,
        Integer sourceLineNo,
        BigDecimal qty,
        BigDecimal unitPrice,
        BigDecimal taxRate,
        String customerMaterialCode,
        String customerOrderNo,
        String lineRemark,
        String planDeliveryDate
    ) {
    }

    private LocalDate optionalDate(String value) {
        return value == null || value.isBlank() ? null : LocalDate.parse(value);
    }

    private String normalizeCurrency(String value) {
        if (value == null) {
            return "CNY";
        }
        if (value.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "请选择币种");
        }
        var currency = value.trim().toUpperCase(Locale.ROOT);
        if (!"CNY".equals(currency) && !"USD".equals(currency)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "币种只支持 CNY 或 USD");
        }
        return currency;
    }

    private String inventoryScopeId() {
        return tenantDataScopeService.currentScopeId("inventory");
    }
}
