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
        @RequestParam(defaultValue = "") String columnFilters
    ) {
        if ("permission-denied-list".equals(listKey)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "No permission for this list");
        }
        if ("error-list".equals(listKey)) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Stub error for list state");
        }

        var filters = parseColumnFilters(columnFilters);
        var rows = expandRowsForLargePage(seedRows(listKey), pageSize).stream()
            .filter(row -> keyword.isBlank() || row.values().stream().anyMatch(value -> String.valueOf(value).contains(keyword)))
            .filter(row -> status.isBlank() || status.equals(row.get("status")))
            .filter(row -> matchesColumnFilters(row, filters))
            .toList();
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

    private List<Map<String, ?>> expandRowsForLargePage(List<Map<String, ?>> seedRows, int pageSize) {
        if (pageSize < 1000 || seedRows.isEmpty()) {
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

    private List<Map<String, ?>> seedRows(String listKey) {
        return switch (listKey) {
            case "product-master-list" -> realProductRows();
            case "customer-master-list" -> realCustomerRows();
            case "supplier-master-list" -> realSupplierRows();
            case "warehouse-master-list" -> realWarehouseRows();
            case "purchase-order-form-list" -> purchaseOrderRows();
            case "purchase-in-list", "purchase-in-form-list" -> purchaseInRows();
            case "sales-out-list", "sales-out-form-list" -> salesOutRows();
            case "inventory-query-list" -> realInventoryRows();
            case "receivable-list", "ar-receivable-list" -> receivableRows();
            case "payable-list", "ap-payable-list" -> payableRows();
            case "bom-list" -> bomRows();
            case "production-task-list", "production-task-form-list" -> productionTaskRows();
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
                   COALESCE(l.target_id::text, '') AS "targetId",
                   CASE WHEN l.success THEN '成功' ELSE '失败' END AS status,
                   COALESCE(l.failure_reason, '') AS reason,
                   to_char(l.operated_at, 'YYYY-MM-DD HH24:MI:SS') AS "operatedAt"
            FROM sys_operation_log l
            ORDER BY l.operated_at DESC
            LIMIT 500
            """));
    }
}
