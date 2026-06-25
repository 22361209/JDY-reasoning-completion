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

        var rows = filteredRows(listKey, keyword, status, pageSize, columnFilters, module, action, operator, targetType, dateFrom, dateTo);
        if (!sortField.isBlank()) {
            rows = rows.stream()
                .sorted(comparator(sortField, sortOrder))
                .toList();
        }
        return Map.of(
            "page", page,
            "pageSize", pageSize,
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
        var rows = filteredRows(listKey, keyword, status, pageSize, columnFilters, module, action, operator, targetType, dateFrom, dateTo);
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
        return expandRowsForLargePage(listKey, seedRows(listKey), pageSize).stream()
            .filter(row -> keyword.isBlank() || row.values().stream().anyMatch(value -> String.valueOf(value).contains(keyword)))
            .filter(row -> status.isBlank() || status.equals(row.get("status")))
            .filter(row -> matchesOperationLogFilters(listKey, row, module, action, operator, targetType, dateFrom, dateTo))
            .filter(row -> matchesColumnFilters(row, filters))
            .toList();
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

    private List<Map<String, ?>> seedRows(String listKey) {
        return switch (listKey) {
            case "product-master-list" -> realProductRows();
            case "customer-master-list" -> realCustomerRows();
            case "supplier-master-list" -> realSupplierRows();
            case "warehouse-master-list" -> realWarehouseRows();
            case "purchase-order-form-list" -> purchaseOrderRows();
            case "purchase-in-list", "purchase-in-form-list" -> purchaseInRows();
            case "sales-out-list", "sales-out-form-list" -> salesOutRows();
            case "other-in-list", "other-in-form-list" -> otherStockInRows();
            case "inventory-query-list" -> realInventoryRows();
            case "receivable-list", "ar-receivable-list" -> receivableRows();
            case "payable-list", "ap-payable-list" -> payableRows();
            case "bom-list" -> bomRows();
            case "production-task-list", "production-task-form-list" -> productionTaskRows();
            case "material-issue-list", "material-issue-form-list" -> materialIssueRows();
            case "product-in-list", "product-in-form-list" -> productInRows();
            case "role-list", "user-role-list" -> roleRows();
            case "operation-log-list" -> operationLogRows();
            default -> salesRows();
        };
    }

    private List<Map<String, ?>> realProductRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   code,
                   name,
                   COALESCE(spec, '') AS spec,
                   category,
                   unit,
                   CASE WHEN enabled THEN '启用' ELSE '禁用' END AS status,
                   to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS "updatedAt"
            FROM md_product
            ORDER BY code
            """));
    }

    private List<Map<String, ?>> realCustomerRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   code,
                   name,
                   COALESCE(contact, '') AS contact,
                   COALESCE(phone, '') AS phone,
                   COALESCE(region, '') AS region,
                   CASE WHEN enabled THEN '启用' ELSE '禁用' END AS status
            FROM md_customer
            ORDER BY code
            """));
    }

    private List<Map<String, ?>> realSupplierRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   code,
                   name,
                   COALESCE(contact, '') AS contact,
                   COALESCE(phone, '') AS phone,
                   CASE WHEN enabled THEN '启用' ELSE '禁用' END AS status
            FROM md_supplier
            ORDER BY code
            """));
    }

    private List<Map<String, ?>> realWarehouseRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   code,
                   name,
                   CASE WHEN allow_negative_stock THEN '允许负库存' ELSE '不允许负库存' END AS stockPolicy,
                   CASE WHEN enabled THEN '启用' ELSE '禁用' END AS status
            FROM md_warehouse
            ORDER BY code
            """));
    }

    private List<Map<String, ?>> realInventoryRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT b.id::text AS id,
                   p.code,
                   p.name,
                   COALESCE(p.spec, '') AS spec,
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

    private List<Map<String, ?>> salesRows() {
        var realRows = new ArrayList<Map<String, ?>>(jdbcTemplate.queryForList("""
            SELECT so.id::text AS id,
                   so.bill_no AS "billNo",
                   c.name AS customer,
                   to_char(so.bill_date, 'YYYY-MM-DD') AS "billDate",
                   CASE WHEN so.status = 'DRAFT' THEN '草稿' WHEN so.status = 'VOID' THEN '已作废' ELSE '已审核' END AS status,
                   CASE
                       WHEN so.out_status = 'ALL_OUT' THEN '全部出库'
                       WHEN so.out_status = 'PART_OUT' THEN '部分出库'
                       ELSE '未出库'
                   END AS "outStatus",
                   trim(to_char(so.total_amount, 'FM9999999990.00')) AS amount,
                   COALESCE(so.owner_name, '') AS owner
            FROM sales_order so
            JOIN md_customer c ON c.id = so.customer_id
            ORDER BY so.updated_at DESC
            """));
        realRows.addAll(Stream.<Map<String, ?>>of(
            Map.of("id", "so1", "billNo", "XSDD-00001", "customer", "广州测试客户", "billDate", "2026-06-23", "status", "已审核", "amount", "1,720.00", "owner", "本地管理员"),
            Map.of("id", "so2", "billNo", "XSDD-00002", "customer", "佛山测试客户", "billDate", "2026-06-22", "status", "草稿", "amount", "980.00", "owner", "本地管理员"),
            Map.of("id", "so3", "billNo", "XSDD-00003", "customer", "东莞备用客户", "billDate", "2026-06-21", "status", "草稿", "amount", "2,460.00", "owner", "销售部")
        ).toList());
        return realRows;
    }

    private List<Map<String, ?>> purchaseOrderRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT po.id::text AS id,
                   po.bill_no AS "billNo",
                   s.name AS supplier,
                   to_char(po.bill_date, 'YYYY-MM-DD') AS "billDate",
                   CASE WHEN po.status = 'DRAFT' THEN '草稿' WHEN po.status = 'VOID' THEN '已作废' ELSE '已审核' END AS status,
                   CASE
                       WHEN po.in_status = 'ALL_IN' THEN '全部入库'
                       WHEN po.in_status = 'PART_IN' THEN '部分入库'
                       ELSE '未入库'
                   END AS "inStatus",
                   trim(to_char(po.total_amount, 'FM9999999990.00')) AS amount,
                   COALESCE(po.owner_name, '') AS owner
            FROM purchase_order po
            JOIN md_supplier s ON s.id = po.supplier_id
            ORDER BY po.updated_at DESC
            """));
    }

    private List<Map<String, ?>> purchaseInRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT pi.id::text AS id,
                   pi.bill_no AS "billNo",
                   s.name AS supplier,
                   to_char(pi.bill_date, 'YYYY-MM-DD') AS "billDate",
                   CASE
                       WHEN pi.status = 'DRAFT' THEN '草稿'
                       WHEN pi.status = 'REVERSED' THEN '已反审核'
                       WHEN pi.status = 'RED_REVERSED' THEN '已红冲'
                       WHEN pi.status = 'VOID' THEN '已作废'
                       ELSE '已审核'
                   END AS status,
                   trim(to_char(pi.total_amount, 'FM9999999990.00')) AS amount,
                   COALESCE(w.name, '') AS warehouse
            FROM purchase_in pi
            JOIN md_supplier s ON s.id = pi.supplier_id
            LEFT JOIN purchase_in_line l ON l.bill_id = pi.id AND l.line_no = 1
            LEFT JOIN md_warehouse w ON w.id = l.warehouse_id
            ORDER BY pi.updated_at DESC
            """));
    }

    private List<Map<String, ?>> salesOutRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT so.id::text AS id,
                   so.bill_no AS "billNo",
                   c.name AS customer,
                   to_char(so.bill_date, 'YYYY-MM-DD') AS "billDate",
                   CASE
                       WHEN so.status = 'DRAFT' THEN '草稿'
                       WHEN so.status = 'REVERSED' THEN '已反审核'
                       WHEN so.status = 'RED_REVERSED' THEN '已红冲'
                       WHEN so.status = 'VOID' THEN '已作废'
                       ELSE '已审核'
                   END AS status,
                   trim(to_char(so.total_amount, 'FM9999999990.00')) AS amount,
                   COALESCE(w.name, '') AS warehouse
            FROM sales_out so
            JOIN md_customer c ON c.id = so.customer_id
            LEFT JOIN sales_out_line l ON l.bill_id = so.id AND l.line_no = 1
            LEFT JOIN md_warehouse w ON w.id = l.warehouse_id
            ORDER BY so.updated_at DESC
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
                   COALESCE(p.code, '') AS "productCode",
                   COALESCE(p.name, '') AS "productName",
                   COALESCE(w.name, '') AS warehouse,
                   COALESCE(p.unit, '') AS unit,
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
                   b.code AS "bomCode",
                   p.code AS "productCode",
                   p.name AS "productName",
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
            JOIN prod_bom b ON b.id = t.bom_id
            JOIN md_product p ON p.id = t.product_id
            JOIN md_warehouse w ON w.id = t.warehouse_id
            ORDER BY t.updated_at DESC
            """));
    }

    private List<Map<String, ?>> materialIssueRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT i.id::text AS id,
                   i.bill_no AS "billNo",
                   t.bill_no AS "sourceOrderNo",
                   to_char(i.created_at, 'YYYY-MM-DD') AS "billDate",
                   CASE
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

    private List<Map<String, ?>> bomRows() {
        return List.copyOf(jdbcTemplate.queryForList("""
            SELECT b.id::text AS id,
                   b.code,
                   p.code AS "productCode",
                   p.name AS "productName",
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
