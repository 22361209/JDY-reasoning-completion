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
                   CASE WHEN so.status = 'DRAFT' THEN '草稿' ELSE '已审核' END AS status,
                   CASE WHEN so.out_status = 'ALL_OUT' THEN '全部出库' ELSE '未出库' END AS "outStatus",
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
                   CASE WHEN po.status = 'DRAFT' THEN '草稿' ELSE '已审核' END AS status,
                   CASE WHEN po.in_status = 'ALL_IN' THEN '全部入库' ELSE '未入库' END AS "inStatus",
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
                   CASE WHEN pi.status = 'DRAFT' THEN '草稿' ELSE '已审核' END AS status,
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
                   CASE WHEN so.status = 'DRAFT' THEN '草稿' ELSE '已审核' END AS status,
                   trim(to_char(so.total_amount, 'FM9999999990.00')) AS amount,
                   COALESCE(w.name, '') AS warehouse
            FROM sales_out so
            JOIN md_customer c ON c.id = so.customer_id
            LEFT JOIN sales_out_line l ON l.bill_id = so.id AND l.line_no = 1
            LEFT JOIN md_warehouse w ON w.id = l.warehouse_id
            ORDER BY so.updated_at DESC
            """));
    }
}
