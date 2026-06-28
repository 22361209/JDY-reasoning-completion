package com.jdy.erp.system.api;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/lists")
public class ListStubController {
    private final ObjectMapper objectMapper;
    private final JdbcTemplate jdbcTemplate;

    public ListStubController(ObjectMapper objectMapper, JdbcTemplate jdbcTemplate) {
        this.objectMapper = objectMapper;
        this.jdbcTemplate = jdbcTemplate;
    }

    @GetMapping("/{listKey}")
    public Map<String, Object> rows(
        @PathVariable String listKey,
        @RequestParam(defaultValue = "") String keyword,
        @RequestParam(defaultValue = "") String status,
        @RequestParam(defaultValue = "1") int page,
        @RequestParam(defaultValue = "200") int pageSize,
        @RequestParam(defaultValue = "header") String view,
        @RequestParam(defaultValue = "") String sortField,
        @RequestParam(defaultValue = "asc") String sortOrder,
        @RequestParam(defaultValue = "") String columnFilters,
        @RequestParam(defaultValue = "") String module,
        @RequestParam(defaultValue = "") String action,
        @RequestParam(defaultValue = "") String operator,
        @RequestParam(defaultValue = "") String targetType,
        @RequestParam(defaultValue = "") String dateFrom,
        @RequestParam(defaultValue = "") String dateTo
    ) {
        if ("permission-denied-list".equals(listKey)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "No permission for this list");
        }
        if ("error-list".equals(listKey)) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Stub error for list state");
        }

        var rows = filteredRows(listKey, view, keyword, status, pageSize, columnFilters, module, action, operator, targetType, dateFrom, dateTo);
        if (!sortField.isBlank()) {
            rows = rows.stream()
                .sorted(comparator(sortField, sortOrder))
                .toList();
        }
        return Map.of(
            "page", page,
            "pageSize", pageSize,
            "view", normalizedView(view),
            "sortField", sortField,
            "sortOrder", sortOrder,
            "total", rows.size(),
            "rows", rows.stream().skip((long) (page - 1) * pageSize).limit(pageSize).toList()
        );
    }

    @GetMapping("/{listKey}/export.csv")
    public ResponseEntity<String> exportCsv(
        @PathVariable String listKey,
        @RequestParam(defaultValue = "") String keyword,
        @RequestParam(defaultValue = "") String status,
        @RequestParam(defaultValue = "1000") int pageSize,
        @RequestParam(defaultValue = "header") String view,
        @RequestParam(defaultValue = "") String sortField,
        @RequestParam(defaultValue = "asc") String sortOrder,
        @RequestParam(defaultValue = "") String columnFilters,
        @RequestParam(defaultValue = "") String module,
        @RequestParam(defaultValue = "") String action,
        @RequestParam(defaultValue = "") String operator,
        @RequestParam(defaultValue = "") String targetType,
        @RequestParam(defaultValue = "") String dateFrom,
        @RequestParam(defaultValue = "") String dateTo
    ) {
        var rows = filteredRows(listKey, view, keyword, status, pageSize, columnFilters, module, action, operator, targetType, dateFrom, dateTo);
        if (!sortField.isBlank()) {
            rows = rows.stream()
                .sorted(comparator(sortField, sortOrder))
                .toList();
        }
        var columns = columnsForExport(listKey, rows);
        var csv = new StringBuilder();
        csv.append('\ufeff');
        csv.append(columns.stream().map(column -> escapeCsv(column.title())).collect(java.util.stream.Collectors.joining(","))).append('\n');
        for (var row : rows) {
            csv.append(columns.stream()
                .map(column -> escapeCsv(String.valueOf(row.get(column.field()) == null ? "" : row.get(column.field()))))
                .collect(java.util.stream.Collectors.joining(",")))
                .append('\n');
        }
        var fileName = listKey + "-export.csv";
        return ResponseEntity.ok()
            .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + fileName + "\"")
            .contentType(new MediaType("text", "csv", java.nio.charset.StandardCharsets.UTF_8))
            .body(csv.toString());
    }

    private List<Map<String, ?>> filteredRows(
        String listKey,
        String view,
        String keyword,
        String status,
        int pageSize,
        String columnFilters,
        String module,
        String action,
        String operator,
        String targetType,
        String dateFrom,
        String dateTo
    ) {
        var filters = parseColumnFilters(columnFilters);
        return expandRowsForLargePage(listKey, seedRows(listKey, view), pageSize).stream()
            .filter(row -> keyword.isBlank() || row.values().stream().anyMatch(value -> String.valueOf(value).contains(keyword)))
            .filter(row -> status.isBlank() || status.equals(row.get("status")))
            .filter(row -> matchesOperationLogFilters(listKey, row, module, action, operator, targetType, dateFrom, dateTo))
            .filter(row -> matchesColumnFilters(row, filters))
            .toList();
    }

    private String normalizedView(String view) {
        return "detail".equalsIgnoreCase(view) ? "detail" : "header";
    }

    private List<ExportColumn> columnsForExport(String listKey, List<Map<String, ?>> rows) {
        if ("operation-log-list".equals(listKey)) {
            return List.of(
                new ExportColumn("operatedAt", "操作时间"),
                new ExportColumn("module", "模块"),
                new ExportColumn("action", "动作"),
                new ExportColumn("targetType", "对象类型"),
                new ExportColumn("targetNo", "业务单号"),
                new ExportColumn("operator", "操作人"),
                new ExportColumn("status", "状态"),
                new ExportColumn("reason", "失败原因")
            );
        }
        if (rows.isEmpty()) {
            return List.of();
        }
        return rows.get(0).keySet().stream()
            .filter(field -> !"id".equals(field))
            .map(field -> new ExportColumn(field, field))
            .toList();
    }

    private String escapeCsv(String value) {
        if (value == null) {
            return "";
        }
        if (value.contains(",") || value.contains("\"") || value.contains("\n") || value.contains("\r")) {
            return "\"" + value.replace("\"", "\"\"") + "\"";
        }
        return value;
    }

    private record ExportColumn(String field, String title) {}

    private boolean matchesOperationLogFilters(
        String listKey,
        Map<String, ?> row,
        String module,
        String action,
        String operator,
        String targetType,
        String dateFrom,
        String dateTo
    ) {
        if (!"operation-log-list".equals(listKey)) {
            return true;
        }
        var rowModule = String.valueOf(row.get("module") == null ? "" : row.get("module"));
        var rowAction = String.valueOf(row.get("action") == null ? "" : row.get("action"));
        var rowOperator = String.valueOf(row.get("operator") == null ? "" : row.get("operator"));
        var rowTargetType = String.valueOf(row.get("targetType") == null ? "" : row.get("targetType"));
        var operatedAt = String.valueOf(row.get("operatedAt") == null ? "" : row.get("operatedAt"));
        var operatedDate = operatedAt.length() >= 10 ? operatedAt.substring(0, 10) : "";
        return (module == null || module.isBlank() || module.equals(rowModule))
            && (action == null || action.isBlank() || action.equals(rowAction))
            && (operator == null || operator.isBlank() || rowOperator.contains(operator))
            && (targetType == null || targetType.isBlank() || targetType.equals(rowTargetType))
            && (dateFrom == null || dateFrom.isBlank() || operatedDate.compareTo(dateFrom) >= 0)
            && (dateTo == null || dateTo.isBlank() || operatedDate.compareTo(dateTo) <= 0);
    }

    private Map<String, Map<String, String>> parseColumnFilters(String columnFilters) {
        if (columnFilters == null || columnFilters.isBlank()) {
            return Map.of();
        }
        try {
            return objectMapper.readValue(columnFilters, new TypeReference<>() {});
        } catch (Exception ignored) {
            return Map.of();
        }
    }

    private boolean matchesColumnFilters(Map<String, ?> row, Map<String, Map<String, String>> filters) {
        return filters.entrySet().stream().allMatch(entry -> {
            var filter = entry.getValue();
            var operator = filter.getOrDefault("operator", "包含");
            var value = filter.getOrDefault("value", "");
            var rawValue = row.get(entry.getKey());
            var cellValue = String.valueOf(rawValue == null ? "" : rawValue);
            return switch (operator) {
                case "不包含" -> !cellValue.contains(value);
                case "等于" -> cellValue.equals(value);
                case "不等于" -> !cellValue.equals(value);
                case "以……开始" -> cellValue.startsWith(value);
                case "以……结束" -> cellValue.endsWith(value);
                case "为空" -> cellValue.isBlank();
                case "不为空" -> !cellValue.isBlank();
                default -> cellValue.contains(value);
            };
        });
    }

    private Comparator<Map<String, ?>> comparator(String sortField, String sortOrder) {
        var comparator = Comparator.comparing((Map<String, ?> row) -> {
            var rawValue = row.get(sortField);
            return String.valueOf(rawValue == null ? "" : rawValue);
        });
        return "desc".equalsIgnoreCase(sortOrder) ? comparator.reversed() : comparator;
    }

    private List<Map<String, ?>> expandRowsForLargePage(String listKey, List<Map<String, ?>> seedRows, int pageSize) {
        if (pageSize < 1000 || seedRows.isEmpty() || !isSyntheticExpandableList(listKey)) {
            return seedRows;
        }
        var rows = new ArrayList<Map<String, ?>>();
        for (int index = 0; index < 1200; index += 1) {
            var source = seedRows.get(index % seedRows.size());
            var row = new java.util.LinkedHashMap<String, Object>(source);
            row.put("id", source.get("id") + "-" + index);
            if (row.containsKey("billNo")) {
                row.put("billNo", String.format("XSDD-%05d", index + 1));
            }
            if (row.containsKey("code")) {
                row.put("code", String.format("%s-%04d", source.get("code"), index + 1));
            }
            rows.add(row);
        }
        return rows;
    }

    private boolean isSyntheticExpandableList(String listKey) {
        return Stream.of("standard-list", "error-list", "permission-denied-list")
            .anyMatch(listKey::equals);
    }

    private List<Map<String, ?>> seedRows(String listKey, String view) {
        if ("detail".equals(normalizedView(view))) {
            var detailRows = documentDetailRows(listKey);
            if (!detailRows.isEmpty()) {
                return detailRows;
            }
        }
        return switch (listKey) {
            case "product-master-list" -> realProductRows();
            case "product-category-list" -> realProductCategoryRows();
            case "unit-master-list" -> realUnitRows();
            case "customer-master-list" -> realCustomerRows();
            case "supplier-master-list" -> realSupplierRows();
            case "warehouse-master-list" -> realWarehouseRows();
            case "production-department-list" -> realProductionDepartmentRows();
            case "sales-quote-form-list" -> salesQuoteRows();
            case "purchase-order-form-list" -> purchaseOrderRows();
            case "delivery-notice-form-list" -> deliveryNoticeRows();
            case "purchase-in-list", "purchase-in-form-list" -> purchaseInRows();
            case "purchase-return-list", "purchase-return-form-list" -> purchaseReturnRows();
            case "purchase-summary-report" -> purchaseSummaryRows();
            case "sales-out-list", "sales-out-form-list" -> salesOutRows();
            case "other-in-list", "other-in-form-list" -> otherStockInRows();
            case "other-out-list", "other-out-form-list" -> otherStockOutRows();
            case "stock-transfer-list", "stock-transfer-form-list" -> stockTransferRows();
            case "inventory-query-list" -> realInventoryRows();
            case "stock-alert-list" -> stockAlertRows();
            case "receivable-list", "ar-receivable-list" -> receivableRows();
            case "payable-list", "ap-payable-list" -> payableRows();
            case "bom-list" -> bomRows();
            case "production-plan-list" -> productionPlanRows();
            case "kit-analysis-list" -> kitAnalysisRows();
            case "production-task-list", "production-task-form-list" -> productionTaskRows();
            case "material-issue-list", "material-issue-form-list" -> materialIssueRows();
            case "product-in-list", "product-in-form-list" -> productInRows();
            case "outsourcing-surface-list" -> outsourcingSurfaceRows();
            case "role-list", "user-role-list" -> roleRows();
            case "operation-log-list" -> operationLogRows();
            default -> salesRows();
        };
    }

    private List<Map<String, ?>> documentDetailRows(String listKey) {
        return switch (listKey) {
            case "sales-quote-form-list" -> queryDetailRows("""
                SELECT concat(sq.id::text, '-', l.line_no) AS id,
                       sq.bill_no AS "billNo",
                       c.code AS "customerCode",
                       COALESCE(l.customer_material_code, '') AS "customerMaterialCode",
                       COALESCE(l.customer_order_no, '') AS "customerOrderNo",
                       to_char(sq.bill_date, 'YYYY-MM-DD') AS "billDate",
                       to_char(l.plan_delivery_date, 'YYYY-MM-DD') AS "planDeliveryDate",
                       c.name AS partner,
                       CASE WHEN sq.status = 'DRAFT' THEN '草稿' WHEN sq.status = 'VOID' THEN '已作废' ELSE '已审核' END AS status,
                       l.line_no AS "lineNo",
                       COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                       COALESCE(l.product_name_snapshot, p.name) AS "productName",
                       COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                       COALESCE(w.name, '') AS warehouse,
                       trim(to_char(COALESCE(l.qty, 0), 'FM9999999990.####')) AS qty,
                       trim(to_char(l.unit_price, 'FM9999999990.00')) AS "unitPrice",
                       trim(to_char(COALESCE(l.tax_rate, 13), 'FM9999999990.####')) AS "taxRate",
                       trim(to_char(l.amount, 'FM9999999990.00')) AS amount,
                       trim(to_char(l.price_tax_total, 'FM9999999990.00')) AS "priceTaxTotal",
                       COALESCE(l.line_remark, '') AS "lineRemark",
                       '' AS "sourceBillNo",
                       '' AS "sourceLineNo"
                FROM sales_quote sq
                JOIN sales_quote_line l ON l.quote_id = sq.id
                JOIN md_customer c ON c.id = sq.customer_id
                JOIN md_product p ON p.id = l.product_id
                LEFT JOIN md_warehouse w ON w.id = l.warehouse_id
                ORDER BY sq.updated_at DESC, l.line_no
                """);
            case "sales-order-form-list" -> queryDetailRows("""
                SELECT concat(so.id::text, '-', l.line_no) AS id,
                       so.bill_no AS "billNo",
                       c.code AS "customerCode",
                       COALESCE(l.customer_material_code, '') AS "customerMaterialCode",
                       COALESCE(l.customer_order_no, '') AS "customerOrderNo",
                       to_char(so.bill_date, 'YYYY-MM-DD') AS "billDate",
                       to_char(l.plan_delivery_date, 'YYYY-MM-DD') AS "planDeliveryDate",
                       c.name AS partner,
                       CASE WHEN so.status = 'DRAFT' THEN '草稿' WHEN so.status = 'VOID' THEN '已作废' ELSE '已审核' END AS status,
                       l.line_no AS "lineNo",
                       COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                       COALESCE(l.product_name_snapshot, p.name) AS "productName",
                       COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                       COALESCE(w.name, '') AS warehouse,
                       trim(to_char(l.qty, 'FM9999999990.####')) AS qty,
                       trim(to_char(COALESCE(l.shipped_qty, 0), 'FM9999999990.####')) AS "shippedQty",
                       trim(to_char(GREATEST(0, l.qty - COALESCE(l.shipped_qty, 0)), 'FM9999999990.####')) AS "remainingQty",
                       trim(to_char(l.unit_price, 'FM9999999990.00')) AS "unitPrice",
                       trim(to_char(COALESCE(l.tax_rate, 13), 'FM9999999990.####')) AS "taxRate",
                       trim(to_char(l.amount, 'FM9999999990.00')) AS amount,
                       trim(to_char(l.price_tax_total, 'FM9999999990.00')) AS "priceTaxTotal",
                       COALESCE(l.line_remark, '') AS "lineRemark",
                       '' AS "sourceBillNo",
                       '' AS "sourceLineNo"
                FROM sales_order so
                JOIN sales_order_line l ON l.order_id = so.id
                JOIN md_customer c ON c.id = so.customer_id
                JOIN md_product p ON p.id = l.product_id
                LEFT JOIN md_warehouse w ON w.id = l.warehouse_id
                ORDER BY so.updated_at DESC, l.line_no
                """);
            case "purchase-order-form-list" -> queryDetailRows("""
                SELECT concat(po.id::text, '-', l.line_no) AS id,
                       po.bill_no AS "billNo",
                       s.code AS "supplierCode",
                       to_char(po.bill_date, 'YYYY-MM-DD') AS "billDate",
                       to_char(l.plan_delivery_date, 'YYYY-MM-DD') AS "planDeliveryDate",
                       s.name AS partner,
                       CASE WHEN po.status = 'DRAFT' THEN '草稿' WHEN po.status = 'VOID' THEN '已作废' ELSE '已审核' END AS status,
                       l.line_no AS "lineNo",
                       COALESCE(l.supplier_material_code, '') AS "supplierMaterialCode",
                       COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                       COALESCE(l.product_name_snapshot, p.name) AS "productName",
                       COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                       COALESCE(w.name, '') AS warehouse,
                       trim(to_char(l.qty, 'FM9999999990.####')) AS qty,
                       trim(to_char(GREATEST(COALESCE(l.received_qty, 0), COALESCE(in_qty.received_qty, 0)), 'FM9999999990.####')) AS "receivedQty",
                       trim(to_char(GREATEST(0, l.qty - GREATEST(COALESCE(l.received_qty, 0), COALESCE(in_qty.received_qty, 0))), 'FM9999999990.####')) AS "remainingQty",
                       trim(to_char(l.unit_price, 'FM9999999990.00')) AS "unitPrice",
                       trim(to_char(
                           CASE
                               WHEN po.is_tax_inclusive THEN l.unit_price
                               ELSE round(l.unit_price * (1 + COALESCE(l.tax_rate, 0) / 100), 2)
                           END,
                           'FM9999999990.00'
                       )) AS "taxInclusiveUnitPrice",
                       trim(to_char(COALESCE(l.tax_rate, 13), 'FM9999999990.####')) AS "taxRate",
                       trim(to_char(l.amount, 'FM9999999990.00')) AS amount,
                       trim(to_char(l.price_tax_total, 'FM9999999990.00')) AS "priceTaxTotal",
                       '' AS "sourceBillNo",
                       '' AS "sourceLineNo"
                FROM purchase_order po
                JOIN purchase_order_line l ON l.order_id = po.id
                JOIN md_supplier s ON s.id = po.supplier_id
                JOIN md_product p ON p.id = l.product_id
                LEFT JOIN md_warehouse w ON w.id = l.warehouse_id
                LEFT JOIN (
                    SELECT pil.source_order_no,
                           pil.source_line_no,
                           SUM(pil.qty) AS received_qty
                    FROM purchase_in_line pil
                    JOIN purchase_in pi ON pi.id = pil.bill_id
                    WHERE pi.status <> 'VOID'
                    GROUP BY pil.source_order_no, pil.source_line_no
                ) in_qty ON in_qty.source_order_no = po.bill_no AND in_qty.source_line_no = l.line_no
                ORDER BY po.updated_at DESC, l.line_no
                """);
            case "sales-out-list", "sales-out-form-list" -> queryDetailRows("""
                SELECT concat(so.id::text, '-', l.line_no) AS id,
                       so.bill_no AS "billNo",
                       c.code AS "customerCode",
                       COALESCE(l.customer_material_code, '') AS "customerMaterialCode",
                       COALESCE(l.customer_order_no, '') AS "customerOrderNo",
                       to_char(so.bill_date, 'YYYY-MM-DD') AS "billDate",
                       to_char(l.plan_delivery_date, 'YYYY-MM-DD') AS "planDeliveryDate",
                       c.name AS partner,
                       CASE
                           WHEN so.status = 'DRAFT' THEN '草稿'
                           WHEN so.status = 'REVERSED' THEN '已反审核'
                           WHEN so.status = 'RED_REVERSED' THEN '已红冲'
                           WHEN so.status = 'VOID' THEN '已作废'
                           ELSE '已审核'
                       END AS status,
                       l.line_no AS "lineNo",
                       COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                       COALESCE(l.product_name_snapshot, p.name) AS "productName",
                       COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                       w.name AS warehouse,
                       trim(to_char(l.qty, 'FM9999999990.####')) AS qty,
                       trim(to_char(l.unit_price, 'FM9999999990.00')) AS "unitPrice",
                       trim(to_char(COALESCE(l.tax_rate, 13), 'FM9999999990.####')) AS "taxRate",
                       trim(to_char(l.amount, 'FM9999999990.00')) AS amount,
                       trim(to_char(l.price_tax_total, 'FM9999999990.00')) AS "priceTaxTotal",
                       COALESCE(l.line_remark, '') AS "lineRemark",
                       COALESCE(l.source_delivery_notice_no, l.source_order_no, '') AS "sourceBillNo",
                       COALESCE(l.source_delivery_line_no::text, l.source_line_no::text, '') AS "sourceLineNo"
                FROM sales_out so
                JOIN sales_out_line l ON l.bill_id = so.id
                JOIN md_customer c ON c.id = so.customer_id
                JOIN md_product p ON p.id = l.product_id
                JOIN md_warehouse w ON w.id = l.warehouse_id
                ORDER BY so.updated_at DESC, l.line_no
                """);
            case "delivery-notice-form-list" -> queryDetailRows("""
                SELECT concat(dn.id::text, '-', l.line_no) AS id,
                       dn.bill_no AS "billNo",
                       c.code AS "customerCode",
                       COALESCE(l.customer_material_code, '') AS "customerMaterialCode",
                       COALESCE(l.customer_order_no, '') AS "customerOrderNo",
                       to_char(dn.bill_date, 'YYYY-MM-DD') AS "billDate",
                       to_char(l.plan_delivery_date, 'YYYY-MM-DD') AS "planDeliveryDate",
                       c.name AS partner,
                       CASE
                           WHEN dn.status = 'DRAFT' THEN '草稿'
                           WHEN dn.status = 'REVERSED' THEN '已反审核'
                           WHEN dn.status = 'VOID' THEN '已作废'
                           ELSE '已审核'
                       END AS status,
                       l.line_no AS "lineNo",
                       COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                       COALESCE(l.product_name_snapshot, p.name) AS "productName",
                       COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                       w.name AS warehouse,
                       trim(to_char(l.qty, 'FM9999999990.####')) AS qty,
                       trim(to_char(l.unit_price, 'FM9999999990.00')) AS "unitPrice",
                       trim(to_char(COALESCE(l.tax_rate, 13), 'FM9999999990.####')) AS "taxRate",
                       trim(to_char(l.amount, 'FM9999999990.00')) AS amount,
                       trim(to_char(l.price_tax_total, 'FM9999999990.00')) AS "priceTaxTotal",
                       COALESCE(l.line_remark, '') AS "lineRemark",
                       COALESCE(l.source_order_no, '') AS "sourceBillNo",
                       COALESCE(l.source_line_no::text, '') AS "sourceLineNo"
                FROM delivery_notice dn
                JOIN delivery_notice_line l ON l.bill_id = dn.id
                JOIN md_customer c ON c.id = dn.customer_id
                JOIN md_product p ON p.id = l.product_id
                JOIN md_warehouse w ON w.id = l.warehouse_id
                ORDER BY dn.updated_at DESC, l.line_no
                """);
            case "purchase-in-list", "purchase-in-form-list" -> queryDetailRows("""
                SELECT concat(pi.id::text, '-', l.line_no) AS id,
                       pi.bill_no AS "billNo",
                       s.code AS "supplierCode",
                       to_char(pi.bill_date, 'YYYY-MM-DD') AS "billDate",
                       s.name AS partner,
                       CASE
                           WHEN pi.status = 'DRAFT' THEN '草稿'
                           WHEN pi.status = 'REVERSED' THEN '已反审核'
                           WHEN pi.status = 'RED_REVERSED' THEN '已红冲'
                           WHEN pi.status = 'VOID' THEN '已作废'
                           ELSE '已审核'
                       END AS status,
                       l.line_no AS "lineNo",
                       COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                       COALESCE(l.product_name_snapshot, p.name) AS "productName",
                       COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                       w.name AS warehouse,
                       trim(to_char(l.qty, 'FM9999999990.####')) AS qty,
                       trim(to_char(l.unit_price, 'FM9999999990.00')) AS "unitPrice",
                       trim(to_char(l.amount, 'FM9999999990.00')) AS amount,
                       trim(to_char(l.price_tax_total, 'FM9999999990.00')) AS "priceTaxTotal",
                       COALESCE(l.source_order_no, '') AS "sourceBillNo",
                       COALESCE(l.source_line_no::text, '') AS "sourceLineNo"
                FROM purchase_in pi
                JOIN purchase_in_line l ON l.bill_id = pi.id
                JOIN md_supplier s ON s.id = pi.supplier_id
                JOIN md_product p ON p.id = l.product_id
                JOIN md_warehouse w ON w.id = l.warehouse_id
                ORDER BY pi.updated_at DESC, l.line_no
                """);
            case "purchase-return-list", "purchase-return-form-list" -> queryDetailRows("""
                SELECT concat(pr.id::text, '-', l.line_no) AS id,
                       pr.bill_no AS "billNo",
                       s.code AS "supplierCode",
                       to_char(pr.bill_date, 'YYYY-MM-DD') AS "billDate",
                       s.name AS partner,
                       CASE
                           WHEN pr.status = 'DRAFT' THEN '草稿'
                           WHEN pr.status = 'REVERSED' THEN '已反审核'
                           WHEN pr.status = 'VOID' THEN '已作废'
                           ELSE '已审核'
                       END AS status,
                       l.line_no AS "lineNo",
                       COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                       COALESCE(l.product_name_snapshot, p.name) AS "productName",
                       COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                       w.name AS warehouse,
                       trim(to_char(l.qty, 'FM9999999990.####')) AS qty,
                       trim(to_char(l.unit_price, 'FM9999999990.00')) AS "unitPrice",
                       trim(to_char(l.amount, 'FM9999999990.00')) AS amount,
                       trim(to_char(l.price_tax_total, 'FM9999999990.00')) AS "priceTaxTotal",
                       COALESCE(l.source_in_no, '') AS "sourceBillNo",
                       COALESCE(l.source_line_no::text, '') AS "sourceLineNo",
                       COALESCE(l.line_remark, '') AS "lineRemark"
                FROM purchase_return pr
                JOIN purchase_return_line l ON l.bill_id = pr.id
                JOIN md_supplier s ON s.id = pr.supplier_id
                JOIN md_product p ON p.id = l.product_id
                JOIN md_warehouse w ON w.id = l.warehouse_id
                ORDER BY pr.updated_at DESC, l.line_no
                """);
            case "material-issue-list", "material-issue-form-list" -> queryDetailRows("""
                SELECT concat(i.id::text, '-', l.line_no) AS id,
                       i.bill_no AS "billNo",
                       to_char(i.created_at, 'YYYY-MM-DD') AS "billDate",
                       t.bill_no AS partner,
                       CASE WHEN i.status = 'REVERSED' THEN '已反审核' WHEN i.status = 'RED_REVERSED' THEN '已红冲' ELSE '已审核' END AS status,
                       l.line_no AS "lineNo",
                       COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                       COALESCE(l.product_name_snapshot, p.name) AS "productName",
                       COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                       w.name AS warehouse,
                       trim(to_char(l.qty, 'FM9999999990.####')) AS qty,
                       trim(to_char(l.unit_price, 'FM9999999990.00')) AS "unitPrice",
                       trim(to_char(l.amount, 'FM9999999990.00')) AS amount,
                       t.bill_no AS "sourceBillNo",
                       '' AS "sourceLineNo"
                FROM production_material_issue i
                JOIN production_task t ON t.id = i.task_id
                JOIN production_material_issue_line l ON l.issue_id = i.id
                JOIN md_product p ON p.id = l.product_id
                JOIN md_warehouse w ON w.id = l.warehouse_id
                ORDER BY i.created_at DESC, l.line_no
                """);
            case "product-in-list", "product-in-form-list" -> queryDetailRows("""
                SELECT concat(c.id::text, '-', l.line_no) AS id,
                       c.bill_no AS "billNo",
                       to_char(c.created_at, 'YYYY-MM-DD') AS "billDate",
                       t.bill_no AS partner,
                       CASE WHEN c.status = 'REVERSED' THEN '已反审核' WHEN c.status = 'RED_REVERSED' THEN '已红冲' ELSE '已审核' END AS status,
                       l.line_no AS "lineNo",
                       COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                       COALESCE(l.product_name_snapshot, p.name) AS "productName",
                       COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                       w.name AS warehouse,
                       trim(to_char(l.qty, 'FM9999999990.####')) AS qty,
                       trim(to_char(l.unit_price, 'FM9999999990.00')) AS "unitPrice",
                       trim(to_char(l.amount, 'FM9999999990.00')) AS amount,
                       t.bill_no AS "sourceBillNo",
                       '' AS "sourceLineNo"
                FROM production_completion c
                JOIN production_task t ON t.id = c.task_id
                JOIN production_completion_line l ON l.completion_id = c.id
                JOIN md_product p ON p.id = l.product_id
                JOIN md_warehouse w ON w.id = l.warehouse_id
                ORDER BY c.created_at DESC, l.line_no
                """);
            case "other-in-list", "other-in-form-list" -> inventoryDetailRows("other_stock_in", "other_stock_in_line", "warehouse_id", "其他入库");
            case "other-out-list", "other-out-form-list" -> inventoryDetailRows("other_stock_out", "other_stock_out_line", "warehouse_id", "其他出库");
            case "stock-transfer-list", "stock-transfer-form-list" -> queryDetailRows("""
                SELECT concat(b.id::text, '-', l.line_no) AS id,
                       b.bill_no AS "billNo",
                       to_char(b.bill_date, 'YYYY-MM-DD') AS "billDate",
                       COALESCE(b.department, '') AS partner,
                       CASE WHEN b.status = 'DRAFT' THEN '草稿' WHEN b.status = 'REVERSED' THEN '已反审核' WHEN b.status = 'VOID' THEN '已作废' ELSE '已审核' END AS status,
                       l.line_no AS "lineNo",
                       COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                       COALESCE(l.product_name_snapshot, p.name) AS "productName",
                       COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                       concat(sw.name, ' → ', tw.name) AS warehouse,
                       trim(to_char(l.qty, 'FM9999999990.####')) AS qty,
                       trim(to_char(l.unit_price, 'FM9999999990.00')) AS "unitPrice",
                       trim(to_char(l.amount, 'FM9999999990.00')) AS amount,
                       '' AS "sourceBillNo",
                       '' AS "sourceLineNo"
                FROM stock_transfer b
                JOIN stock_transfer_line l ON l.bill_id = b.id
                JOIN md_product p ON p.id = l.product_id
                JOIN md_warehouse sw ON sw.id = l.source_warehouse_id
                JOIN md_warehouse tw ON tw.id = l.target_warehouse_id
                ORDER BY b.updated_at DESC, l.line_no
                """);
            case "stock-count-list", "stock-count-form-list" -> queryDetailRows("""
                SELECT concat(b.id::text, '-', l.line_no) AS id,
                       b.bill_no AS "billNo",
                       to_char(b.bill_date, 'YYYY-MM-DD') AS "billDate",
                       COALESCE(b.department, '') AS partner,
                       CASE WHEN b.status = 'DRAFT' THEN '草稿' WHEN b.status = 'REVERSED' THEN '已反审核' WHEN b.status = 'VOID' THEN '已作废' ELSE '已审核' END AS status,
                       l.line_no AS "lineNo",
                       COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                       COALESCE(l.product_name_snapshot, p.name) AS "productName",
                       COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                       w.name AS warehouse,
                       trim(to_char(l.counted_qty, 'FM9999999990.####')) AS qty,
                       trim(to_char(l.unit_price, 'FM9999999990.00')) AS "unitPrice",
                       trim(to_char(l.diff_qty * l.unit_price, 'FM9999999990.00')) AS amount,
                       '' AS "sourceBillNo",
                       '' AS "sourceLineNo"
                FROM stock_count b
                JOIN stock_count_line l ON l.bill_id = b.id
                JOIN md_product p ON p.id = l.product_id
                JOIN md_warehouse w ON w.id = l.warehouse_id
                ORDER BY b.updated_at DESC, l.line_no
                """);
            case "stock-count-gain-list", "stock-count-gain-form-list" -> stockCountDiffDetailRows("stock_count_gain", "stock_count_gain_line");
            case "stock-count-loss-list", "stock-count-loss-form-list" -> stockCountDiffDetailRows("stock_count_loss", "stock_count_loss_line");
            default -> List.of();
        };
    }

    private List<Map<String, ?>> inventoryDetailRows(String headerTable, String lineTable, String warehouseColumn, String fallbackBusinessType) {
        return queryDetailRows("""
            SELECT concat(b.id::text, '-', l.line_no) AS id,
                   b.bill_no AS "billNo",
                   to_char(b.bill_date, 'YYYY-MM-DD') AS "billDate",
                   COALESCE(b.department, b.business_type, '%s') AS partner,
                   CASE WHEN b.status = 'DRAFT' THEN '草稿' WHEN b.status = 'REVERSED' THEN '已反审核' WHEN b.status = 'VOID' THEN '已作废' ELSE '已审核' END AS status,
                   l.line_no AS "lineNo",
                   COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                       COALESCE(l.product_name_snapshot, p.name) AS "productName",
                       COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                   w.name AS warehouse,
                   trim(to_char(l.qty, 'FM9999999990.####')) AS qty,
                   trim(to_char(l.unit_price, 'FM9999999990.00')) AS "unitPrice",
                   trim(to_char(l.amount, 'FM9999999990.00')) AS amount,
                   '' AS "sourceBillNo",
                   '' AS "sourceLineNo"
            FROM %s b
            JOIN %s l ON l.bill_id = b.id
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.%s
            ORDER BY b.updated_at DESC, l.line_no
            """.formatted(fallbackBusinessType, headerTable, lineTable, warehouseColumn));
    }

    private List<Map<String, ?>> stockCountDiffDetailRows(String headerTable, String lineTable) {
        return queryDetailRows("""
            SELECT concat(b.id::text, '-', l.line_no) AS id,
                   b.bill_no AS "billNo",
                   to_char(b.bill_date, 'YYYY-MM-DD') AS "billDate",
                   COALESCE(b.department, b.business_type, '') AS partner,
                   CASE WHEN b.status = 'DRAFT' THEN '草稿' WHEN b.status = 'REVERSED' THEN '已反审核' WHEN b.status = 'VOID' THEN '已作废' ELSE '已审核' END AS status,
                   l.line_no AS "lineNo",
                   COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                       COALESCE(l.product_name_snapshot, p.name) AS "productName",
                       COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                   w.name AS warehouse,
                   trim(to_char(l.qty, 'FM9999999990.####')) AS qty,
                   trim(to_char(l.unit_price, 'FM9999999990.00')) AS "unitPrice",
                   trim(to_char(l.amount, 'FM9999999990.00')) AS amount,
                   COALESCE(sc.bill_no, '') AS "sourceBillNo",
                   COALESCE(l.source_line_no::text, '') AS "sourceLineNo"
            FROM %s b
            JOIN %s l ON l.bill_id = b.id
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.warehouse_id
            LEFT JOIN stock_count sc ON sc.id = l.source_bill_id
            ORDER BY b.updated_at DESC, l.line_no
            """.formatted(headerTable, lineTable));
    }

    private List<Map<String, ?>> queryDetailRows(String sql) {
        return List.copyOf(jdbcTemplate.queryForList(sql));
    }

    private List<Map<String, ?>> realProductRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   system_no::text AS "systemNo",
                   code,
                   name,
                   COALESCE(short_name, '') AS "shortName",
                   COALESCE(barcode, '') AS barcode,
                   COALESCE(brand, '') AS brand,
                   COALESCE(spec, '') AS spec,
                   category,
                   product_type AS "productType",
                   unit,
                   trim(to_char(net_weight, 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(gross_weight, 'FM9999999990.00')) AS "grossWeight",
                   COALESCE(oe_no, '') AS "oeNo",
                   COALESCE(position_name, '') AS "positionName",
                   COALESCE(surface_treatment, '') AS "surfaceTreatment",
                   CASE WHEN is_purchase THEN '是' ELSE '否' END AS "isPurchase",
                   CASE WHEN is_sale THEN '是' ELSE '否' END AS "isSale",
                   CASE WHEN is_inventory THEN '是' ELSE '否' END AS "isInventory",
                   CASE WHEN is_produce THEN '是' ELSE '否' END AS "isProduce",
                   CASE WHEN is_subcontract THEN '是' ELSE '否' END AS "isSubcontract",
                   COALESCE(default_warehouse_code, '') AS "defaultWarehouseCode",
                   COALESCE(default_workshop, '') AS "defaultWorkshop",
                   COALESCE(sale_unit, unit) AS "saleUnit",
                   COALESCE(purchase_unit, unit) AS "purchaseUnit",
                   COALESCE(bom_unit, unit) AS "bomUnit",
                   COALESCE(default_supplier_code, '') AS "defaultSupplierCode",
                   COALESCE(issue_warehouse_code, '') AS "issueWarehouseCode",
                   issue_method AS "issueMethod",
                   trim(to_char(tax_rate, 'FM9999999990.####')) AS "taxRate",
                   trim(to_char(default_sale_price, 'FM9999999990.00')) AS "defaultSalePrice",
                   trim(to_char(cost_price, 'FM9999999990.00')) AS "costPrice",
                   trim(to_char(min_sale_price, 'FM9999999990.00')) AS "minSalePrice",
                   trim(to_char(purchase_price, 'FM9999999990.00')) AS "purchasePrice",
                   trim(to_char(max_purchase_price, 'FM9999999990.00')) AS "maxPurchasePrice",
                   trim(to_char(subcontract_price, 'FM9999999990.00')) AS "subcontractPrice",
                   trim(to_char(wholesale_price, 'FM9999999990.00')) AS "wholesalePrice",
                   trim(to_char(retail_price, 'FM9999999990.00')) AS "retailPrice",
                   trim(to_char(min_stock_qty, 'FM9999999990.####')) AS "minStockQty",
                   trim(to_char(safety_stock_qty, 'FM9999999990.####')) AS "safetyStockQty",
                   trim(to_char(max_stock_qty, 'FM9999999990.####')) AS "maxStockQty",
                   COALESCE(remark, '') AS remark,
                   CASE WHEN enabled THEN '启用' ELSE '禁用' END AS status,
                   CASE WHEN audit_status = 'AUDITED' THEN '已审核' ELSE '草稿' END AS "auditStatus",
                   to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS "updatedAt"
            FROM md_product
            ORDER BY code
            """));
    }

    private List<Map<String, ?>> realProductCategoryRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   code,
                   name,
                   COALESCE(parent_code, '') AS "parentCode",
                   sort_no AS "sortNo",
                   COALESCE(remark, '') AS remark,
                   CASE WHEN enabled THEN '启用' ELSE '禁用' END AS status,
                   CASE WHEN audit_status = 'AUDITED' THEN '已审核' ELSE '草稿' END AS "auditStatus",
                   to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS "updatedAt"
            FROM md_product_category
            ORDER BY sort_no, code
            """));
    }

    private List<Map<String, ?>> realUnitRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   code,
                   name,
                   decimal_places AS "decimalPlaces",
                   sort_no AS "sortNo",
                   COALESCE(remark, '') AS remark,
                   CASE WHEN enabled THEN '启用' ELSE '禁用' END AS status,
                   CASE WHEN audit_status = 'AUDITED' THEN '已审核' ELSE '草稿' END AS "auditStatus",
                   to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS "updatedAt"
            FROM md_unit
            ORDER BY sort_no, code
            """));
    }

    private List<Map<String, ?>> realCustomerRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   system_no::text AS "systemNo",
                   code,
                   name,
                   COALESCE(short_name, '') AS "shortName",
                   customer_level AS "customerLevel",
                   COALESCE(contact, '') AS contact,
                   COALESCE(phone, '') AS phone,
                   COALESCE(region, '') AS region,
                   COALESCE(tax_no, '') AS "taxNo",
                   COALESCE(address, '') AS address,
                   trim(to_char(credit_limit, 'FM9999999990.00')) AS "creditLimit",
                   settlement_method AS "settlementMethod",
                   COALESCE(owner_name, '') AS "ownerName",
                   COALESCE(remark, '') AS remark,
                   CASE WHEN enabled THEN '启用' ELSE '禁用' END AS status,
                   CASE WHEN audit_status = 'AUDITED' THEN '已审核' ELSE '草稿' END AS "auditStatus"
            FROM md_customer
            ORDER BY code
            """));
    }

    private List<Map<String, ?>> realSupplierRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   system_no::text AS "systemNo",
                   code,
                   name,
                   COALESCE(short_name, '') AS "shortName",
                   supplier_level AS "supplierLevel",
                   COALESCE(contact, '') AS contact,
                   COALESCE(phone, '') AS phone,
                   COALESCE(tax_no, '') AS "taxNo",
                   COALESCE(address, '') AS address,
                   COALESCE(bank_account, '') AS "bankAccount",
                   settlement_method AS "settlementMethod",
                   COALESCE(owner_name, '') AS "ownerName",
                   COALESCE(remark, '') AS remark,
                   CASE WHEN enabled THEN '启用' ELSE '禁用' END AS status,
                   CASE WHEN audit_status = 'AUDITED' THEN '已审核' ELSE '草稿' END AS "auditStatus"
            FROM md_supplier
            ORDER BY code
            """));
    }

    private List<Map<String, ?>> realWarehouseRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   system_no::text AS "systemNo",
                   code,
                   name,
                   warehouse_type AS "warehouseType",
                   COALESCE(manager, '') AS manager,
                   COALESCE(phone, '') AS phone,
                   COALESCE(address, '') AS address,
                   CASE WHEN allow_negative_stock THEN '允许负库存' ELSE '不允许负库存' END AS stockPolicy,
                   COALESCE(remark, '') AS remark,
                   CASE WHEN enabled THEN '启用' ELSE '禁用' END AS status,
                   CASE WHEN audit_status = 'AUDITED' THEN '已审核' ELSE '草稿' END AS "auditStatus"
            FROM md_warehouse
            ORDER BY code
            """));
    }

    private List<Map<String, ?>> realProductionDepartmentRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   system_no::text AS "systemNo",
                   code,
                   name,
                   COALESCE(manager, '') AS manager,
                   COALESCE(remark, '') AS remark,
                   CASE WHEN enabled THEN '启用' ELSE '禁用' END AS status,
                   CASE WHEN audit_status = 'AUDITED' THEN '已审核' ELSE '草稿' END AS "auditStatus",
                   to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS "updatedAt"
            FROM md_production_department
            ORDER BY code
            """));
    }

    private List<Map<String, ?>> realInventoryRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT b.id::text AS id,
                   p.code,
                   p.name,
                   COALESCE(p.spec, '') AS spec,
                   COALESCE(p.unit, '') AS unit,
                   trim(to_char(p.net_weight, 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(p.gross_weight, 'FM9999999990.00')) AS "grossWeight",
                   w.name AS warehouse,
                   trim(to_char(b.qty_on_hand, 'FM9999999990.####')) AS "onHand",
                   trim(to_char(b.qty_available, 'FM9999999990.####')) AS available,
                   CASE WHEN b.qty_available <= 20 THEN '低库存' ELSE '正常' END AS status
            FROM inv_stock_balance b
            JOIN md_product p ON p.id = b.product_id
            JOIN md_warehouse w ON w.id = b.warehouse_id
            ORDER BY p.code, w.code
            """));
    }

    private List<Map<String, ?>> stockAlertRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT s.id::text AS id,
                   p.code AS "productCode",
                   p.name AS "productName",
                   COALESCE(p.category, '') AS "productCategory",
                   COALESCE(p.spec, '') AS spec,
                   p.unit,
                   trim(to_char(p.net_weight, 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(p.gross_weight, 'FM9999999990.00')) AS "grossWeight",
                   w.code AS "warehouseCode",
                   w.name AS "warehouseName",
                   trim(to_char(b.qty_on_hand, 'FM9999999990.####')) AS "onHand",
                   trim(to_char(b.qty_available, 'FM9999999990.####')) AS available,
                   trim(to_char(s.safety_qty, 'FM9999999990.####')) AS "safetyQty",
                   trim(to_char(s.max_qty, 'FM9999999990.####')) AS "maxQty",
                   CASE
                       WHEN b.qty_available < s.safety_qty THEN '低于安全库存'
                       WHEN s.max_qty IS NOT NULL AND b.qty_available > s.max_qty THEN '高于库存上限'
                       ELSE '正常'
                   END AS status,
                   CASE
                       WHEN b.qty_available < s.safety_qty THEN trim(to_char(s.safety_qty - b.qty_available, 'FM9999999990.####'))
                       WHEN s.max_qty IS NOT NULL AND b.qty_available > s.max_qty THEN trim(to_char(b.qty_available - s.max_qty, 'FM9999999990.####'))
                       ELSE '0'
                   END AS "diffQty"
            FROM inv_safety_stock_setting s
            JOIN inv_stock_balance b ON b.product_id = s.product_id AND b.warehouse_id = s.warehouse_id
            JOIN md_product p ON p.id = s.product_id
            JOIN md_warehouse w ON w.id = s.warehouse_id
            WHERE b.qty_available < s.safety_qty
               OR (s.max_qty IS NOT NULL AND b.qty_available > s.max_qty)
            ORDER BY
                CASE WHEN b.qty_available < s.safety_qty THEN 0 ELSE 1 END,
                p.code,
                w.code
            """));
    }

    private List<Map<String, ?>> salesRows() {
        var realRows = new ArrayList<Map<String, ?>>(jdbcTemplate.queryForList("""
            SELECT so.id::text AS id,
                   so.bill_no AS "billNo",
                   c.code AS "customerCode",
                   c.name AS customer,
                   to_char(so.bill_date, 'YYYY-MM-DD') AS "billDate",
                   COALESCE(to_char(extra.plan_delivery_date, 'YYYY-MM-DD'), '') AS "planDeliveryDate",
                   CASE WHEN so.status = 'DRAFT' THEN '草稿' WHEN so.status = 'VOID' THEN '已作废' ELSE '已审核' END AS status,
                   CASE
                       WHEN so.out_status = 'ALL_OUT' THEN '全部出库'
                       WHEN so.out_status = 'PART_OUT' THEN '部分出库'
                       ELSE '未出库'
                   END AS "outStatus",
                   so.close_status AS "closeStatus",
                   so.frozen_status AS "frozenStatus",
                   trim(to_char(COALESCE(extra.qty, 0), 'FM9999999990.####')) AS qty,
                   trim(to_char(COALESCE(extra.shipped_qty, 0), 'FM9999999990.####')) AS "shippedQty",
                   trim(to_char(GREATEST(0, COALESCE(extra.qty, 0) - COALESCE(extra.shipped_qty, 0)), 'FM9999999990.####')) AS "remainingQty",
                   trim(to_char(COALESCE(extra.amount, 0), 'FM9999999990.00')) AS amount,
                   trim(to_char(so.total_amount, 'FM9999999990.00')) AS "priceTaxTotal",
                   COALESCE(so.remark, '') AS remark,
                   COALESCE(so.owner_name, '') AS owner
            FROM sales_order so
            JOIN md_customer c ON c.id = so.customer_id
            LEFT JOIN (
                SELECT order_id,
                       MIN(plan_delivery_date) AS plan_delivery_date,
                       SUM(qty) AS qty,
                       SUM(shipped_qty) AS shipped_qty,
                       SUM(amount) AS amount
                FROM sales_order_line
                GROUP BY order_id
            ) extra ON extra.order_id = so.id
            ORDER BY so.updated_at DESC
            """));
        realRows.addAll(Stream.<Map<String, ?>>of(
            Map.ofEntries(
                Map.entry("id", "so1"),
                Map.entry("billNo", "XSDD-00001"),
                Map.entry("customer", "广州测试客户"),
                Map.entry("billDate", "2026-06-23"),
                Map.entry("status", "已审核"),
                Map.entry("qty", "20"),
                Map.entry("shippedQty", "20"),
                Map.entry("remainingQty", "0"),
                Map.entry("amount", "1,522.12"),
                Map.entry("priceTaxTotal", "1,720.00"),
                Map.entry("owner", "本地管理员")
            ),
            Map.ofEntries(
                Map.entry("id", "so2"),
                Map.entry("billNo", "XSDD-00002"),
                Map.entry("customer", "佛山测试客户"),
                Map.entry("billDate", "2026-06-22"),
                Map.entry("status", "草稿"),
                Map.entry("qty", "8"),
                Map.entry("shippedQty", "0"),
                Map.entry("remainingQty", "8"),
                Map.entry("amount", "867.26"),
                Map.entry("priceTaxTotal", "980.00"),
                Map.entry("owner", "本地管理员")
            ),
            Map.ofEntries(
                Map.entry("id", "so3"),
                Map.entry("billNo", "XSDD-00003"),
                Map.entry("customer", "东莞备用客户"),
                Map.entry("billDate", "2026-06-21"),
                Map.entry("status", "草稿"),
                Map.entry("qty", "12"),
                Map.entry("shippedQty", "0"),
                Map.entry("remainingQty", "12"),
                Map.entry("amount", "2,176.99"),
                Map.entry("priceTaxTotal", "2,460.00"),
                Map.entry("owner", "销售部")
            )
        ).toList());
        return realRows;
    }

    private List<Map<String, ?>> purchaseOrderRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT po.id::text AS id,
                   po.bill_no AS "billNo",
                   s.code AS "supplierCode",
                   s.name AS supplier,
                   to_char(po.bill_date, 'YYYY-MM-DD') AS "billDate",
                   CASE WHEN po.status = 'DRAFT' THEN '草稿' WHEN po.status = 'VOID' THEN '已作废' ELSE '已审核' END AS status,
                   CASE
                       WHEN po.in_status = 'ALL_IN' THEN '全部入库'
                       WHEN po.in_status = 'PART_IN' THEN '部分入库'
                       ELSE '未入库'
                   END AS "inStatus",
                   po.close_status AS "closeStatus",
                   po.frozen_status AS "frozenStatus",
                   trim(to_char(COALESCE(extra.qty, 0), 'FM9999999990.####')) AS qty,
                   trim(to_char(COALESCE(extra.received_qty, 0), 'FM9999999990.####')) AS "receivedQty",
                   trim(to_char(GREATEST(0, COALESCE(extra.qty, 0) - COALESCE(extra.received_qty, 0)), 'FM9999999990.####')) AS "remainingQty",
                   trim(to_char(COALESCE(extra.amount, 0), 'FM9999999990.00')) AS amount,
                   trim(to_char(po.total_amount, 'FM9999999990.00')) AS "priceTaxTotal",
                   COALESCE(po.owner_name, '') AS owner
            FROM purchase_order po
            JOIN md_supplier s ON s.id = po.supplier_id
            LEFT JOIN (
                SELECT pol.order_id,
                       SUM(pol.qty) AS qty,
                       SUM(GREATEST(COALESCE(pol.received_qty, 0), COALESCE(in_qty.received_qty, 0))) AS received_qty,
                       SUM(pol.amount) AS amount
                FROM purchase_order_line pol
                JOIN purchase_order po2 ON po2.id = pol.order_id
                LEFT JOIN (
                    SELECT pil.source_order_no,
                           pil.source_line_no,
                           SUM(pil.qty) AS received_qty
                    FROM purchase_in_line pil
                    JOIN purchase_in pi ON pi.id = pil.bill_id
                    WHERE pi.status <> 'VOID'
                    GROUP BY pil.source_order_no, pil.source_line_no
                ) in_qty ON in_qty.source_order_no = po2.bill_no AND in_qty.source_line_no = pol.line_no
                GROUP BY pol.order_id
            ) extra ON extra.order_id = po.id
            ORDER BY po.updated_at DESC
            """));
    }

    private List<Map<String, ?>> salesQuoteRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT sq.id::text AS id,
                   sq.bill_no AS "billNo",
                   c.code AS "customerCode",
                   c.name AS customer,
                   to_char(sq.bill_date, 'YYYY-MM-DD') AS "billDate",
                   COALESCE(to_char(extra.plan_delivery_date, 'YYYY-MM-DD'), '') AS "planDeliveryDate",
                   to_char(sq.valid_until, 'YYYY-MM-DD') AS "validUntil",
                   CASE
                       WHEN sq.status = 'DRAFT' THEN '草稿'
                       WHEN sq.status = 'REVERSED' THEN '已反审核'
                       WHEN sq.status = 'VOID' THEN '已作废'
                       ELSE '已审核'
                   END AS status,
                   CASE
                       WHEN sq.status <> 'AUDITED' THEN '未生效'
                       WHEN sq.enabled = FALSE THEN '已失效'
                       WHEN sq.valid_until < CURRENT_DATE THEN '已过期'
                       ELSE '有效'
                   END AS "validStatus",
                   trim(to_char(COALESCE(extra.amount, 0), 'FM9999999990.00')) AS amount,
                   trim(to_char(sq.total_amount, 'FM9999999990.00')) AS "priceTaxTotal",
                   COALESCE(sq.remark, '') AS remark,
                   COALESCE(sq.owner_name, '') AS owner
            FROM sales_quote sq
            JOIN md_customer c ON c.id = sq.customer_id
            LEFT JOIN (
                SELECT quote_id,
                       MIN(plan_delivery_date) AS plan_delivery_date,
                       SUM(amount) AS amount
                FROM sales_quote_line
                GROUP BY quote_id
            ) extra ON extra.quote_id = sq.id
            ORDER BY sq.updated_at DESC
            """));
    }

    private List<Map<String, ?>> purchaseInRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT pi.id::text AS id,
                   pi.bill_no AS "billNo",
                   s.code AS "supplierCode",
                   s.name AS supplier,
                   to_char(pi.bill_date, 'YYYY-MM-DD') AS "billDate",
                   CASE
                       WHEN pi.status = 'DRAFT' THEN '草稿'
                       WHEN pi.status = 'REVERSED' THEN '已反审核'
                       WHEN pi.status = 'RED_REVERSED' THEN '已红冲'
                       WHEN pi.status = 'VOID' THEN '已作废'
                       ELSE '已审核'
                   END AS status,
                   trim(to_char(COALESCE(extra.qty, 0), 'FM9999999990.####')) AS qty,
                   trim(to_char(COALESCE(extra.amount, 0), 'FM9999999990.00')) AS amount,
                   trim(to_char(pi.total_amount, 'FM9999999990.00')) AS "priceTaxTotal",
                   COALESCE(src.source_bill_no, '') AS "sourceBillNo",
                   COALESCE(w.name, '') AS warehouse
            FROM purchase_in pi
            JOIN md_supplier s ON s.id = pi.supplier_id
            LEFT JOIN purchase_in_line l ON l.bill_id = pi.id AND l.line_no = 1
            LEFT JOIN (
                SELECT bill_id, string_agg(DISTINCT source_order_no, '、' ORDER BY source_order_no) AS source_bill_no
                FROM purchase_in_line
                WHERE source_order_no IS NOT NULL AND source_order_no <> ''
                GROUP BY bill_id
            ) src ON src.bill_id = pi.id
            LEFT JOIN (
                SELECT bill_id,
                       SUM(qty) AS qty,
                       SUM(amount) AS amount
                FROM purchase_in_line
                GROUP BY bill_id
            ) extra ON extra.bill_id = pi.id
            LEFT JOIN md_warehouse w ON w.id = l.warehouse_id
            ORDER BY pi.updated_at DESC
            """));
    }

    private List<Map<String, ?>> purchaseReturnRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT pr.id::text AS id,
                   pr.bill_no AS "billNo",
                   s.code AS "supplierCode",
                   s.name AS supplier,
                   to_char(pr.bill_date, 'YYYY-MM-DD') AS "billDate",
                   CASE
                       WHEN pr.status = 'DRAFT' THEN '草稿'
                       WHEN pr.status = 'REVERSED' THEN '已反审核'
                       WHEN pr.status = 'VOID' THEN '已作废'
                       ELSE '已审核'
                   END AS status,
                   pr.close_status AS "closeStatus",
                   pr.frozen_status AS "frozenStatus",
                   trim(to_char(COALESCE(extra.qty, 0), 'FM9999999990.####')) AS qty,
                   trim(to_char(COALESCE(extra.amount, 0), 'FM9999999990.00')) AS amount,
                   trim(to_char(pr.total_amount, 'FM9999999990.00')) AS "priceTaxTotal",
                   COALESCE(src.source_bill_no, '') AS "sourceBillNo",
                   COALESCE(w.name, '') AS warehouse,
                   COALESCE(pr.remark, '') AS remark,
                   COALESCE(pr.owner_name, '') AS owner
            FROM purchase_return pr
            JOIN md_supplier s ON s.id = pr.supplier_id
            LEFT JOIN purchase_return_line l ON l.bill_id = pr.id AND l.line_no = 1
            LEFT JOIN (
                SELECT bill_id, string_agg(DISTINCT source_in_no, '、' ORDER BY source_in_no) AS source_bill_no
                FROM purchase_return_line
                WHERE source_in_no IS NOT NULL AND source_in_no <> ''
                GROUP BY bill_id
            ) src ON src.bill_id = pr.id
            LEFT JOIN (
                SELECT bill_id,
                       SUM(qty) AS qty,
                       SUM(amount) AS amount
                FROM purchase_return_line
                GROUP BY bill_id
            ) extra ON extra.bill_id = pr.id
            LEFT JOIN md_warehouse w ON w.id = l.warehouse_id
            ORDER BY pr.updated_at DESC
            """));
    }

    private List<Map<String, ?>> purchaseSummaryRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            WITH order_lines AS (
                SELECT s.code AS supplier_code,
                       s.name AS supplier,
                       p.code AS product_code,
                       p.name AS product_name,
                       SUM(l.qty) AS order_qty,
                       SUM(l.amount) AS order_amount,
                       SUM(l.price_tax_total) AS order_tax_amount
                FROM purchase_order po
                JOIN md_supplier s ON s.id = po.supplier_id
                JOIN purchase_order_line l ON l.order_id = po.id
                JOIN md_product p ON p.id = l.product_id
                WHERE po.status = 'AUDITED'
                GROUP BY s.code, s.name, p.code, p.name
            ),
            in_lines AS (
                SELECT s.code AS supplier_code,
                       p.code AS product_code,
                       SUM(l.qty) AS in_qty,
                       SUM(l.amount) AS in_amount,
                       SUM(l.price_tax_total) AS in_tax_amount
                FROM purchase_in pi
                JOIN md_supplier s ON s.id = pi.supplier_id
                JOIN purchase_in_line l ON l.bill_id = pi.id
                JOIN md_product p ON p.id = l.product_id
                WHERE pi.status = 'AUDITED'
                GROUP BY s.code, p.code
            ),
            return_lines AS (
                SELECT s.code AS supplier_code,
                       p.code AS product_code,
                       SUM(l.qty) AS return_qty,
                       SUM(l.amount) AS return_amount,
                       SUM(l.price_tax_total) AS return_tax_amount
                FROM purchase_return pr
                JOIN md_supplier s ON s.id = pr.supplier_id
                JOIN purchase_return_line l ON l.bill_id = pr.id
                JOIN md_product p ON p.id = l.product_id
                WHERE pr.status = 'AUDITED'
                GROUP BY s.code, p.code
            )
            SELECT concat(COALESCE(o.supplier_code, i.supplier_code, r.supplier_code), '-', COALESCE(o.product_code, i.product_code, r.product_code)) AS id,
                   COALESCE(o.supplier_code, i.supplier_code, r.supplier_code) AS "supplierCode",
                   COALESCE(o.supplier, s.name, '') AS supplier,
                   COALESCE(o.product_code, i.product_code, r.product_code) AS "productCode",
                   COALESCE(o.product_name, p.name, '') AS "productName",
                   COALESCE(p.unit, '') AS unit,
                   trim(to_char(p.net_weight, 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(p.gross_weight, 'FM9999999990.00')) AS "grossWeight",
                   trim(to_char(COALESCE(o.order_qty, 0), 'FM9999999990.####')) AS "orderQty",
                   trim(to_char(COALESCE(i.in_qty, 0), 'FM9999999990.####')) AS "inQty",
                   trim(to_char(COALESCE(r.return_qty, 0), 'FM9999999990.####')) AS "returnQty",
                   trim(to_char(GREATEST(0, COALESCE(o.order_qty, 0) - COALESCE(i.in_qty, 0) + COALESCE(r.return_qty, 0)), 'FM9999999990.####')) AS "remainingQty",
                   trim(to_char(COALESCE(o.order_amount, 0), 'FM9999999990.00')) AS "orderAmount",
                   trim(to_char(COALESCE(i.in_amount, 0), 'FM9999999990.00')) AS "inAmount",
                   trim(to_char(COALESCE(r.return_amount, 0), 'FM9999999990.00')) AS "returnAmount",
                   trim(to_char(COALESCE(i.in_tax_amount, 0) - COALESCE(r.return_tax_amount, 0), 'FM9999999990.00')) AS "netPurchaseAmount"
            FROM order_lines o
            FULL JOIN in_lines i ON i.supplier_code = o.supplier_code AND i.product_code = o.product_code
            FULL JOIN return_lines r ON r.supplier_code = COALESCE(o.supplier_code, i.supplier_code) AND r.product_code = COALESCE(o.product_code, i.product_code)
            LEFT JOIN md_supplier s ON s.code = COALESCE(o.supplier_code, i.supplier_code, r.supplier_code)
            LEFT JOIN md_product p ON p.code = COALESCE(o.product_code, i.product_code, r.product_code)
            ORDER BY COALESCE(o.supplier_code, i.supplier_code, r.supplier_code), COALESCE(o.product_code, i.product_code, r.product_code)
            """));
    }

    private List<Map<String, ?>> salesOutRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT so.id::text AS id,
                   so.bill_no AS "billNo",
                   c.code AS "customerCode",
                   c.name AS customer,
                   to_char(so.bill_date, 'YYYY-MM-DD') AS "billDate",
                   COALESCE(to_char(extra.plan_delivery_date, 'YYYY-MM-DD'), '') AS "planDeliveryDate",
                   CASE
                       WHEN so.status = 'DRAFT' THEN '草稿'
                       WHEN so.status = 'REVERSED' THEN '已反审核'
                       WHEN so.status = 'RED_REVERSED' THEN '已红冲'
                       WHEN so.status = 'VOID' THEN '已作废'
                       ELSE '已审核'
                   END AS status,
                   trim(to_char(COALESCE(extra.amount, 0), 'FM9999999990.00')) AS amount,
                   trim(to_char(so.total_amount, 'FM9999999990.00')) AS "priceTaxTotal",
                   COALESCE(so.remark, '') AS remark,
                   COALESCE(src.source_bill_no, '') AS "sourceBillNo",
                   COALESCE(w.name, '') AS warehouse
            FROM sales_out so
            JOIN md_customer c ON c.id = so.customer_id
            LEFT JOIN sales_out_line l ON l.bill_id = so.id AND l.line_no = 1
            LEFT JOIN (
                SELECT bill_id, string_agg(DISTINCT COALESCE(source_delivery_notice_no, source_order_no), '、' ORDER BY COALESCE(source_delivery_notice_no, source_order_no)) AS source_bill_no
                FROM sales_out_line
                WHERE COALESCE(source_delivery_notice_no, source_order_no) IS NOT NULL AND COALESCE(source_delivery_notice_no, source_order_no) <> ''
                GROUP BY bill_id
            ) src ON src.bill_id = so.id
            LEFT JOIN (
                SELECT bill_id,
                       MIN(plan_delivery_date) AS plan_delivery_date,
                       SUM(amount) AS amount
                FROM sales_out_line
                GROUP BY bill_id
            ) extra ON extra.bill_id = so.id
            LEFT JOIN md_warehouse w ON w.id = l.warehouse_id
            ORDER BY so.updated_at DESC
            """));
    }

    private List<Map<String, ?>> deliveryNoticeRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT dn.id::text AS id,
                   dn.bill_no AS "billNo",
                   c.code AS "customerCode",
                   c.name AS customer,
                   to_char(dn.bill_date, 'YYYY-MM-DD') AS "billDate",
                   COALESCE(to_char(extra.plan_delivery_date, 'YYYY-MM-DD'), '') AS "planDeliveryDate",
                   CASE
                       WHEN dn.status = 'DRAFT' THEN '草稿'
                       WHEN dn.status = 'REVERSED' THEN '已反审核'
                       WHEN dn.status = 'VOID' THEN '已作废'
                       ELSE '已审核'
                   END AS status,
                   trim(to_char(COALESCE(extra.amount, 0), 'FM9999999990.00')) AS amount,
                   trim(to_char(dn.total_amount, 'FM9999999990.00')) AS "priceTaxTotal",
                   COALESCE(dn.remark, '') AS remark,
                   COALESCE(src.source_bill_no, '') AS "sourceBillNo",
                   COALESCE(w.name, '') AS warehouse
            FROM delivery_notice dn
            JOIN md_customer c ON c.id = dn.customer_id
            LEFT JOIN delivery_notice_line l ON l.bill_id = dn.id AND l.line_no = 1
            LEFT JOIN (
                SELECT bill_id, string_agg(DISTINCT source_order_no, '、' ORDER BY source_order_no) AS source_bill_no
                FROM delivery_notice_line
                WHERE source_order_no IS NOT NULL AND source_order_no <> ''
                GROUP BY bill_id
            ) src ON src.bill_id = dn.id
            LEFT JOIN (
                SELECT bill_id,
                       MIN(plan_delivery_date) AS plan_delivery_date,
                       SUM(amount) AS amount
                FROM delivery_notice_line
                GROUP BY bill_id
            ) extra ON extra.bill_id = dn.id
            LEFT JOIN md_warehouse w ON w.id = l.warehouse_id
            ORDER BY dn.updated_at DESC
            """));
    }

    private List<Map<String, ?>> otherStockInRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT b.id::text AS id,
                   b.bill_no AS "billNo",
                   to_char(b.bill_date, 'YYYY-MM-DD') AS "billDate",
                   b.business_type AS "businessType",
                   CASE
                       WHEN b.status = 'DRAFT' THEN '草稿'
                       WHEN b.status = 'REVERSED' THEN '已反审核'
                       WHEN b.status = 'VOID' THEN '已作废'
                       ELSE '已审核'
                   END AS status,
                   COALESCE(b.department, '') AS department,
                   COALESCE(l.product_code_snapshot, p.code, '') AS "productCode",
                   COALESCE(l.product_name_snapshot, p.name, '') AS "productName",
                   COALESCE(w.name, '') AS warehouse,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                   trim(to_char(COALESCE(l.qty, 0), 'FM9999999990.####')) AS qty,
                   trim(to_char(COALESCE(l.unit_price, 0), 'FM9999999990.00')) AS "unitCost",
                   trim(to_char(COALESCE(l.amount, 0), 'FM9999999990.00')) AS "inCost"
            FROM other_stock_in b
            LEFT JOIN other_stock_in_line l ON l.bill_id = b.id AND l.line_no = 1
            LEFT JOIN md_product p ON p.id = l.product_id
            LEFT JOIN md_warehouse w ON w.id = l.warehouse_id
            ORDER BY b.updated_at DESC
            """));
    }

    private List<Map<String, ?>> otherStockOutRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT b.id::text AS id,
                   b.bill_no AS "billNo",
                   to_char(b.bill_date, 'YYYY-MM-DD') AS "billDate",
                   b.business_type AS "businessType",
                   CASE
                       WHEN b.status = 'DRAFT' THEN '草稿'
                       WHEN b.status = 'REVERSED' THEN '已反审核'
                       WHEN b.status = 'VOID' THEN '已作废'
                       ELSE '已审核'
                   END AS status,
                   COALESCE(b.department, '') AS department,
                   COALESCE(l.product_code_snapshot, p.code, '') AS "productCode",
                   COALESCE(l.product_name_snapshot, p.name, '') AS "productName",
                   COALESCE(w.name, '') AS warehouse,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                   trim(to_char(COALESCE(l.qty, 0), 'FM9999999990.####')) AS qty,
                   trim(to_char(COALESCE(l.unit_price, 0), 'FM9999999990.00')) AS "unitCost",
                   trim(to_char(COALESCE(l.amount, 0), 'FM9999999990.00')) AS "outCost"
            FROM other_stock_out b
            LEFT JOIN other_stock_out_line l ON l.bill_id = b.id AND l.line_no = 1
            LEFT JOIN md_product p ON p.id = l.product_id
            LEFT JOIN md_warehouse w ON w.id = l.warehouse_id
            ORDER BY b.updated_at DESC
            """));
    }

    private List<Map<String, ?>> stockTransferRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT b.id::text AS id,
                   b.bill_no AS "billNo",
                   to_char(b.bill_date, 'YYYY-MM-DD') AS "billDate",
                   b.business_type AS "businessType",
                   CASE
                       WHEN b.status = 'DRAFT' THEN '草稿'
                       WHEN b.status = 'REVERSED' THEN '已反审核'
                       WHEN b.status = 'VOID' THEN '已作废'
                       ELSE '已审核'
                   END AS status,
                   COALESCE(b.department, '') AS department,
                   COALESCE(l.product_code_snapshot, p.code, '') AS "productCode",
                   COALESCE(l.product_name_snapshot, p.name, '') AS "productName",
                   COALESCE(sw.name, '') AS "sourceWarehouse",
                   COALESCE(tw.name, '') AS "targetWarehouse",
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                   trim(to_char(COALESCE(l.qty, 0), 'FM9999999990.####')) AS qty
            FROM stock_transfer b
            LEFT JOIN stock_transfer_line l ON l.bill_id = b.id AND l.line_no = 1
            LEFT JOIN md_product p ON p.id = l.product_id
            LEFT JOIN md_warehouse sw ON sw.id = l.source_warehouse_id
            LEFT JOIN md_warehouse tw ON tw.id = l.target_warehouse_id
            ORDER BY b.updated_at DESC
            """));
    }

    private List<Map<String, ?>> receivableRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT ar.id::text AS id,
                   ar.bill_no AS "billNo",
                   COALESCE(ar.source_bill_no, '') AS "sourceBillNo",
                   c.name AS customer,
                   to_char(ar.bill_date, 'YYYY-MM-DD') AS "billDate",
                   trim(to_char(ar.amount, 'FM9999999990.00')) AS amount,
                   trim(to_char(ar.received_amount, 'FM9999999990.00')) AS "receivedAmount",
                   CASE
                       WHEN ar.status = 'SETTLED' THEN '已核销'
                       WHEN ar.status = 'PART_SETTLED' THEN '部分核销'
                       ELSE '未核销'
                   END AS status
            FROM ar_receivable ar
            JOIN md_customer c ON c.id = ar.customer_id
            ORDER BY ar.updated_at DESC
            """));
    }

    private List<Map<String, ?>> payableRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT ap.id::text AS id,
                   ap.bill_no AS "billNo",
                   COALESCE(ap.source_bill_no, '') AS "sourceBillNo",
                   s.name AS supplier,
                   to_char(ap.bill_date, 'YYYY-MM-DD') AS "billDate",
                   trim(to_char(ap.amount, 'FM9999999990.00')) AS amount,
                   trim(to_char(ap.paid_amount, 'FM9999999990.00')) AS "paidAmount",
                   CASE
                       WHEN ap.status = 'SETTLED' THEN '已核销'
                       WHEN ap.status = 'PART_SETTLED' THEN '部分核销'
                       ELSE '未核销'
                   END AS status
            FROM ap_payable ap
            JOIN md_supplier s ON s.id = ap.supplier_id
            ORDER BY ap.updated_at DESC
            """));
    }

    private List<Map<String, ?>> productionTaskRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT t.id::text AS id,
                   t.bill_no AS "billNo",
                   COALESCE(pl.bill_no, '') AS "planNo",
                   b.code AS "bomCode",
                   COALESCE(t.product_code_snapshot, p.code) AS "productCode",
                   COALESCE(t.product_name_snapshot, p.name) AS "productName",
                   COALESCE(t.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(t.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(t.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                   w.name AS warehouse,
                   trim(to_char(t.qty, 'FM9999999990.####')) AS qty,
                   trim(to_char(t.issued_qty, 'FM9999999990.####')) AS "issuedQty",
                   trim(to_char(t.completed_qty, 'FM9999999990.####')) AS "completedQty",
                   CASE
                       WHEN t.status = 'COMPLETED' THEN '已完工'
                       WHEN t.status = 'ISSUED' THEN '已领料'
                       WHEN t.status = 'AUDITED' THEN '已审核'
                       ELSE '草稿'
                   END AS status
            FROM production_task t
            LEFT JOIN production_plan pl ON pl.id = t.plan_id
            JOIN prod_bom b ON b.id = t.bom_id
            JOIN md_product p ON p.id = t.product_id
            JOIN md_warehouse w ON w.id = t.warehouse_id
            ORDER BY t.updated_at DESC
            """));
    }

    private List<Map<String, ?>> productionPlanRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT pl.id::text AS id,
                   pl.bill_no AS "billNo",
                   b.code AS "bomCode",
                   COALESCE(pl.product_code_snapshot, p.code) AS "productCode",
                   COALESCE(pl.product_name_snapshot, p.name) AS "productName",
                   COALESCE(pl.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(pl.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(pl.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                   COALESCE(pl.department_code, '') AS "departmentCode",
                   w.name AS warehouse,
                   trim(to_char(pl.planned_qty, 'FM9999999990.####')) AS qty,
                   trim(to_char(COALESCE(task_qty.assigned_qty, 0), 'FM9999999990.####')) AS "assignedQty",
                   trim(to_char(GREATEST(pl.planned_qty - COALESCE(task_qty.assigned_qty, 0), 0), 'FM9999999990.####')) AS "remainingQty",
                   CASE
                       WHEN pl.source_type = 'SELF' THEN '自发计划'
                       ELSE pl.source_type
                   END AS "sourceType",
                   CASE
                       WHEN pl.status = 'AUDITED' THEN '已审核'
                       ELSE '草稿'
                   END AS status
            FROM production_plan pl
            JOIN prod_bom b ON b.id = pl.bom_id
            JOIN md_product p ON p.id = pl.product_id
            JOIN md_warehouse w ON w.id = pl.warehouse_id
            LEFT JOIN (
                SELECT plan_id, SUM(qty) AS assigned_qty
                FROM production_task
                WHERE plan_id IS NOT NULL
                GROUP BY plan_id
            ) task_qty ON task_qty.plan_id = pl.id
            ORDER BY pl.updated_at DESC
            """));
    }

    private List<Map<String, ?>> kitAnalysisRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT (pl.id::text || '-' || s.line_no::text) AS id,
                   pl.bill_no AS "planNo",
                   b.code AS "bomCode",
                   COALESCE(pl.product_code_snapshot, finished.code) AS "productCode",
                   COALESCE(pl.product_name_snapshot, finished.name) AS "productName",
                   material.code AS "materialCode",
                   material.name AS "materialName",
                   COALESCE(material.unit, '') AS unit,
                   trim(to_char(s.qty * pl.planned_qty, 'FM9999999990.####')) AS "requiredQty",
                   trim(to_char(COALESCE(stock.qty_available, 0), 'FM9999999990.####')) AS "availableQty",
                   trim(to_char(GREATEST(s.qty * pl.planned_qty - COALESCE(stock.qty_available, 0), 0), 'FM9999999990.####')) AS "shortageQty",
                   CASE WHEN COALESCE(stock.qty_available, 0) >= s.qty * pl.planned_qty THEN '齐套' ELSE '缺料' END AS status
            FROM production_plan pl
            JOIN prod_bom b ON b.id = pl.bom_id
            JOIN md_product finished ON finished.id = pl.product_id
            JOIN prod_bom_line s ON s.bom_id = b.id
            JOIN md_product material ON material.id = s.material_id
            LEFT JOIN (
                SELECT product_id, SUM(qty_available) AS qty_available
                FROM inv_stock_balance
                GROUP BY product_id
            ) stock ON stock.product_id = s.material_id
            WHERE pl.status = 'AUDITED'
            ORDER BY pl.updated_at DESC, s.line_no
            """));
    }

    private List<Map<String, ?>> materialIssueRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT i.id::text AS id,
                   i.bill_no AS "billNo",
                   t.bill_no AS "sourceOrderNo",
                   to_char(i.created_at, 'YYYY-MM-DD') AS "billDate",
                   CASE
                       WHEN i.status = 'DRAFT' THEN '草稿'
                       WHEN i.status = 'REVERSED' THEN '已反审核'
                       WHEN i.status = 'RED_REVERSED' THEN '已红冲'
                       ELSE '已审核'
                   END AS status,
                   trim(to_char(COALESCE((
                       SELECT SUM(il.amount)
                       FROM production_material_issue_line il
                       WHERE il.issue_id = i.id
                   ), 0), 'FM9999999990.00')) AS amount,
                   COALESCE((
                       SELECT w.name
                       FROM production_material_issue_line il
                       JOIN md_warehouse w ON w.id = il.warehouse_id
                       WHERE il.issue_id = i.id
                       ORDER BY il.line_no
                       LIMIT 1
                   ), '') AS warehouse
            FROM production_material_issue i
            JOIN production_task t ON t.id = i.task_id
            ORDER BY i.created_at DESC
            """));
    }

    private List<Map<String, ?>> productInRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT c.id::text AS id,
                   c.bill_no AS "billNo",
                   t.bill_no AS "sourceOrderNo",
                   to_char(c.created_at, 'YYYY-MM-DD') AS "billDate",
                   CASE
                       WHEN c.status = 'REVERSED' THEN '已反审核'
                       WHEN c.status = 'RED_REVERSED' THEN '已红冲'
                       ELSE '已审核'
                   END AS status,
                   trim(to_char(COALESCE((
                       SELECT SUM(cl.amount)
                       FROM production_completion_line cl
                       WHERE cl.completion_id = c.id
                   ), 0), 'FM9999999990.00')) AS amount,
                   COALESCE((
                       SELECT w.name
                       FROM production_completion_line cl
                       JOIN md_warehouse w ON w.id = cl.warehouse_id
                       WHERE cl.completion_id = c.id
                       ORDER BY cl.line_no
                       LIMIT 1
                   ), '') AS warehouse
            FROM production_completion c
            JOIN production_task t ON t.id = c.task_id
            ORDER BY c.created_at DESC
            """));
    }

    private List<Map<String, ?>> outsourcingSurfaceRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT o.id::text AS id,
                   o.bill_no AS "billNo",
                   COALESCE(o.source_bill_no, '') AS "sourceOrderNo",
                   COALESCE(o.product_code_snapshot, p.code) AS "productCode",
                   COALESCE(o.product_name_snapshot, p.name) AS "productName",
                   COALESCE(o.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(o.qty, 'FM9999999990.####')) AS qty,
                   COALESCE(o.surface_treatment, '') AS "surfaceTreatment",
                   COALESCE(o.processor_supplier_name_snapshot, s.name, '') AS "supplier",
                   CASE
                       WHEN o.status = 'COMPLETED' THEN '已完成'
                       WHEN o.status = 'AUDITED' THEN '已发出'
                       ELSE '草稿'
                   END AS status,
                   to_char(o.created_at, 'YYYY-MM-DD') AS "billDate"
            FROM outsourcing_surface_process o
            JOIN md_product p ON p.id = o.product_id
            LEFT JOIN md_supplier s ON s.id = o.processor_supplier_id
            ORDER BY o.updated_at DESC
            """));
    }

    private List<Map<String, ?>> bomRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT b.id::text AS id,
                   b.code,
                   p.code AS "productCode",
                   p.name AS "productName",
                   COALESCE(p.unit, '') AS unit,
                   trim(to_char(p.net_weight, 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(p.gross_weight, 'FM9999999990.00')) AS "grossWeight",
                   trim(to_char(b.qty, 'FM9999999990.####')) AS qty,
                   CASE WHEN b.enabled THEN '启用' ELSE '禁用' END AS status
            FROM prod_bom b
            JOIN md_product p ON p.id = b.product_id
            ORDER BY b.code
            """));
    }

    private List<Map<String, ?>> roleRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT r.id::text AS id,
                   r.code,
                   r.name,
                   CASE WHEN r.enabled THEN '启用' ELSE '禁用' END AS status,
                   COALESCE(string_agg(p.permission_code, ', ' ORDER BY p.permission_code) FILTER (WHERE p.enabled), '') AS permissions
            FROM sys_role r
            LEFT JOIN sys_permission p ON p.role_id = r.id
            GROUP BY r.id, r.code, r.name, r.enabled
            ORDER BY r.code
            """));
    }

    private List<Map<String, ?>> operationLogRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT l.id::text AS id,
                   l.module_code AS module,
                   l.action_code AS action,
                   l.target_type AS "targetType",
                   COALESCE(so.bill_no, pi.bill_no, osi.bill_no, sor.bill_no, po.bill_no, pt.bill_no, pmi.bill_no, pc.bill_no, ar.bill_no, ap.bill_no, b.code, tu.username, '') AS "targetNo",
                   COALESCE(l.target_id::text, '') AS "targetId",
                   COALESCE(u.display_name, '本地管理员') AS operator,
                   CASE WHEN l.success THEN '成功' ELSE '失败' END AS status,
                   COALESCE(l.failure_reason, '') AS reason,
                   to_char(l.operated_at, 'YYYY-MM-DD HH24:MI:SS') AS "operatedAt"
            FROM sys_operation_log l
            LEFT JOIN sales_out so ON l.target_type = 'sales_out' AND so.id = l.target_id
            LEFT JOIN purchase_in pi ON l.target_type = 'purchase_in' AND pi.id = l.target_id
            LEFT JOIN other_stock_in osi ON l.target_type = 'other_stock_in' AND osi.id = l.target_id
            LEFT JOIN sales_order sor ON l.target_type = 'sales_order' AND sor.id = l.target_id
            LEFT JOIN purchase_order po ON l.target_type = 'purchase_order' AND po.id = l.target_id
            LEFT JOIN production_task pt ON l.target_type = 'production_task' AND pt.id = l.target_id
            LEFT JOIN production_material_issue pmi ON l.target_type = 'production_material_issue' AND pmi.id = l.target_id
            LEFT JOIN production_completion pc ON l.target_type = 'production_completion' AND pc.id = l.target_id
            LEFT JOIN ar_receivable ar ON l.target_type = 'ar_receivable' AND ar.id = l.target_id
            LEFT JOIN ap_payable ap ON l.target_type = 'ap_payable' AND ap.id = l.target_id
            LEFT JOIN prod_bom b ON l.target_type = 'prod_bom' AND b.id = l.target_id
            LEFT JOIN sys_user tu ON l.target_type = 'sys_user' AND tu.id = l.target_id
            LEFT JOIN sys_user u ON u.id = l.operated_by
            ORDER BY l.operated_at DESC
            """));
    }
}
