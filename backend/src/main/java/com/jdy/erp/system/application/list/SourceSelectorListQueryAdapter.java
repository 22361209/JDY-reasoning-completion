package com.jdy.erp.system.application.list;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.jdy.erp.system.tenant.TenantDataScopeService;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

@Component
public class SourceSelectorListQueryAdapter implements ListQueryAdapter {
    private final JdbcTemplate jdbcTemplate;
    private final TenantDataScopeService tenantDataScopeService;

    public SourceSelectorListQueryAdapter(JdbcTemplate jdbcTemplate, TenantDataScopeService tenantDataScopeService) {
        this.jdbcTemplate = jdbcTemplate;
        this.tenantDataScopeService = tenantDataScopeService;
    }

    @Override
    public String key() {
        return "sourceSelector";
    }

    @Override
    public ListQueryResult query(ListQueryRequest request, ListQueryContract contract, ListQuerySupport support, ListSeedRowsProvider seedRowsProvider) {
        var filters = support.columnFilters(request);
        var tokens = support.keywordTokens(request.keyword());
        var spec = sourceSpec(request.listKey());
        var where = new ArrayList<String>();
        var params = new ArrayList<>(spec.params());
        appendKeywordConditions(spec, where, params, contract.keywordFields(), tokens);
        appendDateConditions(spec, where, params, contract.dateField(), request.dateFrom(), request.dateTo());
        appendColumnFilterConditions(spec, where, params, filters);

        var whereSql = where.isEmpty() ? "" : " WHERE " + String.join(" AND ", where);
        var pageSize = Math.max(1, request.pageSize());
        var page = Math.max(1, request.page());
        var totalSql = "SELECT COUNT(*) FROM (" + spec.sql() + ") source" + whereSql;
        var total = jdbcTemplate.queryForObject(totalSql, Long.class, params.toArray());
        var rowParams = new ArrayList<>(params);
        var rowSql = "SELECT * FROM (" + spec.sql() + ") source"
            + whereSql
            + " ORDER BY " + orderExpression(spec, request.sortField(), request.sortOrder())
            + (request.exportMode() ? "" : " LIMIT ? OFFSET ?");
        if (!request.exportMode()) {
            rowParams.add(pageSize);
            rowParams.add((page - 1) * pageSize);
        }
        var rows = jdbcTemplate.queryForList(rowSql, rowParams.toArray());
        List<Map<String, ?>> pageRows = new ArrayList<>(rows);
        return new ListQueryResult(
            page,
            pageSize,
            "detail",
            request.sortField(),
            support.normalizedSortOrder(request.sortOrder()),
            total == null ? 0 : total,
            pageRows
        );
    }

    private SourceQuerySpec sourceSpec(String listKey) {
        return switch (listKey) {
            case "sales-quote-source-selector" -> salesQuoteSpec();
            case "sales-order-source-selector" -> salesOrderSpec();
            case "delivery-notice-source-selector" -> deliveryNoticeSpec();
            case "purchase-requisition-source-selector" -> purchaseRequisitionSpec();
            case "purchase-order-source-selector" -> purchaseOrderSpec();
            case "purchase-in-source-selector" -> purchaseInSpec();
            case "production-task-source-selector" -> productionTaskSpec();
            case "outsourcing-work-order-issue-source-selector" -> outsourcingWorkOrderIssueSpec();
            case "outsourcing-work-order-receipt-source-selector" -> outsourcingWorkOrderReceiptSpec();
            case "outsourcing-receipt-return-source-selector" -> outsourcingReceiptSpec("return");
            case "outsourcing-receipt-scrap-source-selector" -> outsourcingReceiptSpec("scrap");
            default -> new SourceQuerySpec("SELECT NULL AS \"billNo\", NULL AS \"billDate\", NULL AS \"lineNo\" WHERE FALSE", List.of(), sourceFields("billNo", "billDate", "lineNo"));
        };
    }

    private void appendKeywordConditions(SourceQuerySpec spec, List<String> where, List<Object> params, List<String> fields, List<String> tokens) {
        for (var token : tokens) {
            var expressions = fields.stream()
                .filter(field -> isAllowedField(spec, field))
                .map(field -> fieldExpression(spec, field) + " ILIKE ?")
                .toList();
            if (expressions.isEmpty()) {
                continue;
            }
            where.add("(" + String.join(" OR ", expressions) + ")");
            for (int i = 0; i < expressions.size(); i += 1) {
                params.add("%" + token + "%");
            }
        }
    }

    private void appendDateConditions(SourceQuerySpec spec, List<String> where, List<Object> params, String field, String dateFrom, String dateTo) {
        if (!isAllowedField(spec, field)) {
            return;
        }
        var expression = fieldExpression(spec, field);
        if (dateFrom != null && !dateFrom.isBlank()) {
            where.add(expression + " >= ?");
            params.add(dateFrom);
        }
        if (dateTo != null && !dateTo.isBlank()) {
            where.add(expression + " <= ?");
            params.add(dateTo);
        }
    }

    private void appendColumnFilterConditions(SourceQuerySpec spec, List<String> where, List<Object> params, Map<String, Map<String, String>> filters) {
        filters.forEach((field, filter) -> {
            if (!isAllowedField(spec, field)) {
                return;
            }
            var expression = fieldExpression(spec, field);
            var operator = filter.getOrDefault("operator", "包含");
            var value = filter.getOrDefault("value", "");
            switch (operator) {
                case "不包含" -> {
                    where.add(expression + " NOT ILIKE ?");
                    params.add("%" + value + "%");
                }
                case "等于" -> {
                    where.add(expression + " = ?");
                    params.add(value);
                }
                case "不等于" -> {
                    where.add(expression + " <> ?");
                    params.add(value);
                }
                case "以……开始" -> {
                    where.add(expression + " ILIKE ?");
                    params.add(value + "%");
                }
                case "以……结束" -> {
                    where.add(expression + " ILIKE ?");
                    params.add("%" + value);
                }
                case "为空" -> where.add(expression + " = ''");
                case "不为空" -> where.add(expression + " <> ''");
                default -> {
                    where.add(expression + " ILIKE ?");
                    params.add("%" + value + "%");
                }
            }
        });
    }

    private String orderExpression(SourceQuerySpec spec, String sortField, String sortOrder) {
        var field = isAllowedField(spec, sortField) ? sortField : defaultSortField(spec);
        var direction = "asc".equalsIgnoreCase(sortOrder) ? "ASC" : "DESC";
        var expression = rawFieldExpression(spec, field);
        var fallback = new ArrayList<String>();
        if (!"billDate".equals(field) && isAllowedField(spec, "billDate")) {
            fallback.add(rawFieldExpression(spec, "billDate") + " DESC");
        }
        if (!"billNo".equals(field) && isAllowedField(spec, "billNo")) {
            fallback.add(rawFieldExpression(spec, "billNo") + " DESC");
        }
        if (!"lineNo".equals(field) && isAllowedField(spec, "lineNo")) {
            fallback.add(rawFieldExpression(spec, "lineNo") + " ASC");
        }
        return fallback.isEmpty() ? expression + " " + direction : expression + " " + direction + ", " + String.join(", ", fallback);
    }

    private String defaultSortField(SourceQuerySpec spec) {
        if (isAllowedField(spec, "billDate")) {
            return "billDate";
        }
        if (isAllowedField(spec, "billNo")) {
            return "billNo";
        }
        return spec.fields().keySet().stream().findFirst().orElse("billNo");
    }

    private boolean isAllowedField(SourceQuerySpec spec, String field) {
        return field != null && spec.fields().containsKey(field);
    }

    private String fieldExpression(SourceQuerySpec spec, String field) {
        return "COALESCE(" + rawFieldExpression(spec, field) + "::text, '')";
    }

    private String rawFieldExpression(SourceQuerySpec spec, String field) {
        return spec.fields().get(field);
    }

    private Map<String, String> sourceFields(String... fieldNames) {
        var fields = new LinkedHashMap<String, String>();
        for (var field : fieldNames) {
            fields.put(field, "source.\"" + field + "\"");
        }
        return fields;
    }

    private record SourceQuerySpec(String sql, List<Object> params, Map<String, String> fields) {}

    private SourceQuerySpec salesQuoteSpec() {
        return new SourceQuerySpec("""
            SELECT sq.bill_no AS "billNo",
                   c.code AS "customerCode",
                   c.name AS customer,
                   to_char(sq.bill_date, 'YYYY-MM-DD') AS "billDate",
                   to_char(sq.valid_until, 'YYYY-MM-DD') AS "validUntil",
                   sq.department,
                   sq.owner_name AS "ownerName",
                   sq.is_tax_inclusive AS "isTaxInclusive",
                   l.line_no AS "lineNo",
                   l.product_id::text AS "productId",
                   COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                   COALESCE(l.product_name_snapshot, p.name) AS "productName",
                   COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                   COALESCE(w.code, 'CK-001') AS "warehouseCode",
                   l.qty AS "sourceQty",
                   l.unit_price AS "unitPrice",
                   l.tax_rate AS "taxRate",
                   l.tax_amount AS "taxAmount",
                   l.price_tax_total AS "priceTaxTotal",
                   COALESCE(l.customer_material_code, '') AS "customerMaterialCode",
                   COALESCE(l.customer_order_no, '') AS "customerOrderNo",
                   COALESCE(l.line_remark, '') AS "lineRemark",
                   to_char(l.plan_delivery_date, 'YYYY-MM-DD') AS "planDeliveryDate"
            FROM sales_quote sq
            JOIN md_customer c ON c.id = sq.customer_id
            JOIN sales_quote_line l ON l.quote_id = sq.id
            JOIN md_product p ON p.id = l.product_id
            LEFT JOIN md_warehouse w ON w.id = l.warehouse_id
            WHERE sq.status = 'AUDITED'
              AND sq.enabled = TRUE
              AND sq.valid_until >= CURRENT_DATE
              AND NOT EXISTS (
                  SELECT 1
                  FROM sales_order_line sol
                  JOIN sales_order so ON so.id = sol.order_id
                  WHERE sol.source_order_no = sq.bill_no
                    AND sol.source_line_no = l.line_no
                    AND so.status <> 'VOID'
              )
            """, List.of(), sourceFields(
                "billNo", "customerCode", "customer", "billDate", "validUntil", "department", "ownerName",
                "lineNo", "productId", "productCode", "productName", "spec", "unit", "netWeight", "grossWeight",
                "warehouseCode", "sourceQty", "unitPrice", "taxRate", "taxAmount", "priceTaxTotal",
                "customerMaterialCode", "customerOrderNo", "lineRemark", "planDeliveryDate"
            ));
    }

    private SourceQuerySpec salesOrderSpec() {
        return new SourceQuerySpec("""
            SELECT so.bill_no AS "billNo",
                   c.code AS "customerCode",
                   c.name AS customer,
                   to_char(so.bill_date, 'YYYY-MM-DD') AS "billDate",
                   so.department,
                   so.owner_name AS "ownerName",
                   so.is_tax_inclusive AS "isTaxInclusive",
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
                SELECT source_order_no, source_line_no, SUM(qty) AS noticed_qty
                FROM delivery_notice_line dnl
                JOIN delivery_notice dn ON dn.id = dnl.bill_id
                WHERE dn.status <> 'VOID'
                GROUP BY source_order_no, source_line_no
            ) notice ON notice.source_order_no = so.bill_no AND notice.source_line_no = l.line_no
            WHERE so.status = 'AUDITED'
              AND so.close_status = 'OPEN'
              AND so.frozen_status = 'NORMAL'
              AND l.line_close_status = 'OPEN'
              AND l.line_frozen_status = 'NORMAL'
              AND GREATEST(0, l.qty - COALESCE(notice.noticed_qty, 0)) > 0
            """, List.of(inventoryScopeId()), sourceFields(
                "billNo", "customerCode", "customer", "billDate", "department", "ownerName",
                "lineNo", "productId", "productCode", "productName", "spec", "unit", "netWeight", "grossWeight",
                "warehouseCode", "sourceQty", "shippedQty", "remainingQty", "availableNoticeQty",
                "lineCloseStatus", "lineFrozenStatus", "unitPrice", "taxRate", "customerMaterialCode",
                "customerOrderNo", "lineRemark", "planDeliveryDate", "stockOnHand", "stockReserved",
                "stockAvailable", "stockInTransit"
            ));
    }

    private SourceQuerySpec deliveryNoticeSpec() {
        return new SourceQuerySpec("""
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
            WHERE dn.status = 'AUDITED'
              AND GREATEST(0, l.qty - COALESCE(out_qty.shipped_qty, 0)) > 0
            """, List.of(inventoryScopeId()), sourceFields(
                "billNo", "customerCode", "customer", "billDate", "department", "ownerName",
                "lineNo", "sourceOrderNo", "sourceLineNo", "productId", "productCode", "productName", "spec",
                "unit", "netWeight", "grossWeight", "warehouseCode", "sourceQty", "shippedQty", "remainingQty",
                "unitPrice", "taxRate", "customerMaterialCode", "customerOrderNo", "lineRemark",
                "planDeliveryDate", "stockOnHand", "stockReserved", "stockAvailable", "stockInTransit"
            ));
    }

    private SourceQuerySpec purchaseRequisitionSpec() {
        return new SourceQuerySpec("""
            SELECT pr.bill_no AS "billNo",
                   COALESCE(pr.supplier_code_snapshot, s.code) AS "supplierCode",
                   COALESCE(pr.supplier_name_snapshot, s.name) AS supplier,
                   to_char(pr.bill_date, 'YYYY-MM-DD') AS "billDate",
                   pr.department,
                   pr.owner_name AS "ownerName",
                   FALSE AS "isTaxInclusive",
                   l.line_no AS "lineNo",
                   l.product_id::text AS "productId",
                   COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                   COALESCE(l.product_name_snapshot, p.name) AS "productName",
                   COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                   COALESCE(w.code, '') AS "warehouseCode",
                   l.qty AS "sourceQty",
                   COALESCE(l.ordered_qty, 0) AS "receivedQty",
                   GREATEST(0, l.qty - COALESCE(l.ordered_qty, 0)) AS "remainingQty",
                   COALESCE(l.supplier_material_code, '') AS "supplierMaterialCode",
                   COALESCE(p.purchase_price, 0) AS "unitPrice",
                   COALESCE(p.tax_rate, 13) AS "taxRate",
                   0 AS "taxAmount",
                   0 AS "priceTaxTotal",
                   '' AS "lineRemark",
                   to_char(l.plan_delivery_date, 'YYYY-MM-DD') AS "planDeliveryDate"
            FROM purchase_requisition pr
            JOIN purchase_requisition_line l ON l.requisition_id = pr.id
            JOIN md_supplier s ON s.id = pr.supplier_id
            JOIN md_product p ON p.id = l.product_id
            LEFT JOIN md_warehouse w ON w.id = l.warehouse_id
            WHERE pr.status = 'AUDITED'
              AND l.line_close_status = 'OPEN'
              AND l.line_frozen_status = 'NORMAL'
              AND GREATEST(0, l.qty - COALESCE(l.ordered_qty, 0)) > 0
            """, List.of(), sourceFields(
                "billNo", "supplierCode", "supplier", "billDate", "department", "ownerName",
                "lineNo", "productId", "productCode", "productName", "spec", "unit", "netWeight", "grossWeight",
                "warehouseCode", "sourceQty", "receivedQty", "remainingQty", "supplierMaterialCode",
                "unitPrice", "taxRate", "taxAmount", "priceTaxTotal", "lineRemark", "planDeliveryDate"
            ));
    }

    private SourceQuerySpec purchaseOrderSpec() {
        return new SourceQuerySpec("""
            SELECT po.bill_no AS "billNo",
                   s.code AS "supplierCode",
                   s.name AS supplier,
                   to_char(po.bill_date, 'YYYY-MM-DD') AS "billDate",
                   po.department,
                   po.owner_name AS "ownerName",
                   po.is_tax_inclusive AS "isTaxInclusive",
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
                   GREATEST(COALESCE(l.received_qty, 0), COALESCE(in_qty.received_qty, 0)) AS "receivedQty",
                   GREATEST(0, l.qty - GREATEST(COALESCE(l.received_qty, 0), COALESCE(in_qty.received_qty, 0))) AS "remainingQty",
                   l.line_close_status AS "lineCloseStatus",
                   l.line_frozen_status AS "lineFrozenStatus",
                   COALESCE(l.supplier_material_code, '') AS "supplierMaterialCode",
                   l.unit_price AS "unitPrice",
                   l.tax_rate AS "taxRate",
                   l.tax_amount AS "taxAmount",
                   l.price_tax_total AS "priceTaxTotal",
                   COALESCE(l.line_remark, '') AS "lineRemark",
                   to_char(l.plan_delivery_date, 'YYYY-MM-DD') AS "planDeliveryDate"
            FROM purchase_order po
            JOIN md_supplier s ON s.id = po.supplier_id
            JOIN purchase_order_line l ON l.order_id = po.id
            JOIN md_product p ON p.id = l.product_id
            LEFT JOIN md_warehouse w ON w.id = l.warehouse_id
            LEFT JOIN (
                SELECT pil.source_order_no,
                       pil.source_line_no,
                       SUM(pil.qty) AS received_qty
                FROM purchase_in_line pil
                JOIN purchase_in pi ON pi.id = pil.bill_id
                WHERE pi.status = 'AUDITED'
                GROUP BY pil.source_order_no, pil.source_line_no
            ) in_qty ON in_qty.source_order_no = po.bill_no AND in_qty.source_line_no = l.line_no
            WHERE po.status = 'AUDITED'
              AND po.close_status = 'OPEN'
              AND po.frozen_status = 'NORMAL'
              AND l.line_close_status = 'OPEN'
              AND l.line_frozen_status = 'NORMAL'
              AND GREATEST(0, l.qty - GREATEST(COALESCE(l.received_qty, 0), COALESCE(in_qty.received_qty, 0))) > 0
            """, List.of(), sourceFields(
                "billNo", "supplierCode", "supplier", "billDate", "department", "ownerName",
                "lineNo", "productId", "productCode", "productName", "spec", "unit", "netWeight", "grossWeight",
                "warehouseCode", "sourceQty", "receivedQty", "remainingQty", "lineCloseStatus",
                "lineFrozenStatus", "supplierMaterialCode", "unitPrice", "taxRate", "taxAmount",
                "priceTaxTotal", "lineRemark", "planDeliveryDate"
            ));
    }

    private SourceQuerySpec purchaseInSpec() {
        return new SourceQuerySpec("""
            SELECT pi.bill_no AS "billNo",
                   s.code AS "supplierCode",
                   s.name AS supplier,
                   to_char(pi.bill_date, 'YYYY-MM-DD') AS "billDate",
                   pi.department,
                   pi.owner_name AS "ownerName",
                   pi.is_tax_inclusive AS "isTaxInclusive",
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
                   COALESCE(returned.returned_qty, 0) AS "returnedQty",
                   GREATEST(0, l.qty - COALESCE(returned.returned_qty, 0)) AS "remainingQty",
                   l.unit_price AS "unitPrice",
                   l.tax_rate AS "taxRate",
                   l.tax_amount AS "taxAmount",
                   l.price_tax_total AS "priceTaxTotal",
                   COALESCE(l.line_remark, '') AS "lineRemark"
            FROM purchase_in pi
            JOIN md_supplier s ON s.id = pi.supplier_id
            JOIN purchase_in_line l ON l.bill_id = pi.id
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.warehouse_id
            LEFT JOIN (
                SELECT source_in_no, source_line_no, SUM(qty) AS returned_qty
                FROM purchase_return_line prl
                JOIN purchase_return pr ON pr.id = prl.bill_id
                WHERE pr.status = 'AUDITED'
                GROUP BY source_in_no, source_line_no
            ) returned ON returned.source_in_no = pi.bill_no AND returned.source_line_no = l.line_no
            WHERE pi.status = 'AUDITED'
              AND GREATEST(0, l.qty - COALESCE(returned.returned_qty, 0)) > 0
            """, List.of(), sourceFields(
                "billNo", "supplierCode", "supplier", "billDate", "department", "ownerName",
                "lineNo", "productId", "productCode", "productName", "spec", "unit", "netWeight", "grossWeight",
                "warehouseCode", "sourceQty", "returnedQty", "remainingQty", "unitPrice", "taxRate",
                "taxAmount", "priceTaxTotal", "lineRemark"
            ));
    }

    private SourceQuerySpec productionTaskSpec() {
        return new SourceQuerySpec("""
            SELECT t.bill_no AS "billNo",
                   COALESCE(pl.bill_no, '') AS "planNo",
                   to_char(t.created_at, 'YYYY-MM-DD') AS "billDate",
                   COALESCE(t.department_code, '') AS department,
                   COALESCE(t.product_code_snapshot, p.code) AS "productCode",
                   COALESCE(t.product_name_snapshot, p.name) AS "productName",
                   COALESCE(t.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(p.unit, '') AS unit,
                   w.code AS "warehouseCode",
                   t.bom_code_snapshot AS "bomCode",
                   t.bom_version_no AS "bomVersionNo",
                   t.qty AS "taskQty",
                   t.completed_qty AS "completedQty",
                   GREATEST(t.qty - t.completed_qty, 0) AS "remainingProductQty",
                   SUM(s.required_qty) AS "requiredQty",
                   SUM(s.issued_qty) AS "issuedQty",
                   SUM(s.required_qty - s.issued_qty) AS "remainingQty"
            FROM production_task t
            LEFT JOIN production_plan pl ON pl.id = t.plan_id
            JOIN md_product p ON p.id = t.product_id
            JOIN md_warehouse w ON w.id = t.warehouse_id
            JOIN production_task_material_snapshot s ON s.task_id = t.id
            WHERE t.status IN ('AUDITED', 'ISSUED')
            GROUP BY t.id, pl.bill_no, p.code, p.name, p.spec, p.unit, w.code
            HAVING SUM(s.required_qty - s.issued_qty) > 0
            """, List.of(), sourceFields(
                "billNo", "planNo", "billDate", "department", "productCode", "productName", "spec", "unit",
                "warehouseCode", "bomCode", "bomVersionNo", "taskQty", "completedQty", "remainingProductQty",
                "requiredQty", "issuedQty", "remainingQty"
            ));
    }

    private SourceQuerySpec outsourcingWorkOrderReceiptSpec() {
        return new SourceQuerySpec("""
            SELECT h.bill_no AS "billNo",
                   h.supplier_code_snapshot AS "supplierCode",
                   h.supplier_name_snapshot AS "supplierName",
                   h.supplier_name_snapshot AS supplier,
                   to_char(h.created_at, 'YYYY-MM-DD') AS "billDate",
                   l.line_no AS "sourceLineNo",
                   l.line_no AS "lineNo",
                   l.product_code_snapshot AS "productCode",
                   l.product_name_snapshot AS "productName",
                   l.product_spec_snapshot AS spec,
                   COALESCE(l.product_unit_snapshot, '') AS unit,
                   l.warehouse_code_snapshot AS "warehouseCode",
                   l.qty AS "sourceQty",
                   l.received_qty AS "receivedQty",
                   l.qty - l.received_qty AS "remainingQty",
                   '' AS "lineRemark"
            FROM outsourcing_work_order h
            JOIN outsourcing_work_order_line l ON l.work_order_id = h.id
            WHERE h.status = 'AUDITED'
              AND l.qty > l.received_qty
            """, List.of(), sourceFields(
                "billNo", "supplierCode", "supplierName", "supplier", "billDate", "sourceLineNo", "lineNo",
                "productCode", "productName", "spec", "unit", "warehouseCode", "sourceQty", "receivedQty",
                "remainingQty", "lineRemark"
            ));
    }

    private SourceQuerySpec outsourcingWorkOrderIssueSpec() {
        return new SourceQuerySpec("""
            SELECT h.bill_no AS "billNo",
                   h.supplier_code_snapshot AS "supplierCode",
                   h.supplier_name_snapshot AS "supplierName",
                   h.supplier_name_snapshot AS supplier,
                   to_char(h.created_at, 'YYYY-MM-DD') AS "billDate",
                   MIN(c.line_no) AS "sourceLineNo",
                   MIN(c.line_no) AS "lineNo",
                   l.product_code_snapshot AS "productCode",
                   l.product_name_snapshot AS "productName",
                   '' AS spec,
                   COALESCE(l.product_unit_snapshot, '') AS unit,
                   '' AS "warehouseCode",
                   SUM(c.required_qty) AS "sourceQty",
                   SUM(c.issued_qty) AS "issuedQty",
                   SUM(c.required_qty - c.issued_qty) AS "remainingQty",
                   '' AS "lineRemark"
            FROM outsourcing_work_order h
            JOIN outsourcing_work_order_line l ON l.work_order_id = h.id
            JOIN outsourcing_work_order_component c ON c.work_order_id = h.id
            WHERE h.status = 'AUDITED'
              AND c.required_qty > c.issued_qty
            GROUP BY h.bill_no, h.supplier_code_snapshot, h.supplier_name_snapshot,
                     l.product_code_snapshot, l.product_name_snapshot, l.product_unit_snapshot, h.created_at
            """, List.of(), sourceFields(
                "billNo", "supplierCode", "supplierName", "supplier", "billDate", "sourceLineNo", "lineNo",
                "productCode", "productName", "spec", "unit", "warehouseCode", "sourceQty", "issuedQty",
                "remainingQty", "lineRemark"
            ));
    }

    private SourceQuerySpec outsourcingReceiptSpec(String target) {
        return new SourceQuerySpec("""
            SELECT h.bill_no AS "billNo",
                   h.source_work_order_no AS "sourceBillNo",
                   h.supplier_code_snapshot AS "supplierCode",
                   h.supplier_name_snapshot AS "supplierName",
                   h.supplier_name_snapshot AS supplier,
                   to_char(h.created_at, 'YYYY-MM-DD') AS "billDate",
                   l.line_no AS "sourceLineNo",
                   l.line_no AS "lineNo",
                   l.product_code_snapshot AS "productCode",
                   l.product_name_snapshot AS "productName",
                   l.product_spec_snapshot AS spec,
                   COALESCE(l.product_unit_snapshot, '') AS unit,
                   l.warehouse_code_snapshot AS "warehouseCode",
                   l.qty AS "sourceQty",
                   l.returned_qty AS "returnedQty",
                   l.scrapped_qty AS "scrappedQty",
                   l.qty - l.returned_qty - l.scrapped_qty AS "remainingQty",
                   '' AS "lineRemark",
                   ? AS "target"
            FROM outsourcing_receipt h
            JOIN outsourcing_receipt_line l ON l.receipt_id = h.id
            WHERE h.status = 'AUDITED'
              AND l.qty > l.returned_qty + l.scrapped_qty
            """, List.of(target), sourceFields(
                "billNo", "sourceBillNo", "supplierCode", "supplierName", "supplier", "billDate", "sourceLineNo",
                "lineNo", "productCode", "productName", "spec", "unit", "warehouseCode", "sourceQty",
                "returnedQty", "scrappedQty", "remainingQty", "lineRemark", "target"
            ));
    }

    private String inventoryScopeId() {
        return tenantDataScopeService.currentScopeId("inventory");
    }

}
