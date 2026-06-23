package com.jdy.erp.system.api;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;

@RestController
@RequestMapping("/api/lists")
public class ListStubController {
    private final ObjectMapper objectMapper;

    public ListStubController(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
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
            case "product-master-list" -> List.of(
                Map.of("id", "p1", "code", "CP-001", "name", "控制臂总成", "spec", "左前 / 黑色", "category", "成品总成", "unit", "只", "status", "启用", "updatedAt", "2026-06-23 10:20"),
                Map.of("id", "p2", "code", "PJ-014", "name", "衬套", "spec", "65mm / 加强", "category", "零配件", "unit", "件", "status", "启用", "updatedAt", "2026-06-22 15:40"),
                Map.of("id", "p3", "code", "CP-118", "name", "后摆臂总成", "spec", "右后 / 银色", "category", "成品总成", "unit", "只", "status", "禁用", "updatedAt", "2026-06-20 09:12")
            );
            case "customer-master-list" -> List.of(
                Map.of("id", "c1", "code", "KH-001", "name", "广州测试客户", "contact", "陈经理", "phone", "13800000001", "region", "广东广州", "status", "启用"),
                Map.of("id", "c2", "code", "KH-002", "name", "佛山测试客户", "contact", "李主管", "phone", "13800000002", "region", "广东佛山", "status", "启用"),
                Map.of("id", "c3", "code", "KH-009", "name", "东莞备用客户", "contact", "周工", "phone", "13800000009", "region", "广东东莞", "status", "禁用")
            );
            case "supplier-master-list" -> List.of(
                Map.of("id", "s1", "code", "GYS-001", "name", "广州钢材供应商", "contact", "王经理", "phone", "13900000001", "status", "启用"),
                Map.of("id", "s2", "code", "GYS-002", "name", "佛山电泳加工厂", "contact", "赵主管", "phone", "13900000002", "status", "启用")
            );
            case "purchase-in-list" -> List.of(
                Map.of("id", "pin1", "billNo", "CGRK-00001", "supplier", "广州钢材供应商", "billDate", "2026-06-23", "status", "已审核", "amount", "12,600.00", "warehouse", "原料仓"),
                Map.of("id", "pin2", "billNo", "CGRK-00002", "supplier", "佛山电泳加工厂", "billDate", "2026-06-22", "status", "草稿", "amount", "3,200.00", "warehouse", "半成品仓")
            );
            case "inventory-query-list" -> List.of(
                Map.of("id", "inv1", "code", "CP-001", "name", "控制臂总成", "spec", "左前 / 黑色", "warehouse", "成品仓", "onHand", "1,280", "available", "1,120", "status", "正常"),
                Map.of("id", "inv2", "code", "PJ-014", "name", "衬套", "spec", "65mm / 加强", "warehouse", "原料仓", "onHand", "320", "available", "280", "status", "正常"),
                Map.of("id", "inv3", "code", "CP-118", "name", "后摆臂总成", "spec", "右后 / 银色", "warehouse", "成品仓", "onHand", "18", "available", "12", "status", "低库存")
            );
            default -> salesRows();
        };
    }

    private List<Map<String, ?>> salesRows() {
        return Stream.<Map<String, ?>>of(
            Map.of("id", "so1", "billNo", "XSDD-00001", "customer", "广州测试客户", "billDate", "2026-06-23", "status", "已审核", "amount", "1,720.00", "owner", "本地管理员"),
            Map.of("id", "so2", "billNo", "XSDD-00002", "customer", "佛山测试客户", "billDate", "2026-06-22", "status", "草稿", "amount", "980.00", "owner", "本地管理员"),
            Map.of("id", "so3", "billNo", "XSDD-00003", "customer", "东莞备用客户", "billDate", "2026-06-21", "status", "草稿", "amount", "2,460.00", "owner", "销售部")
        ).toList();
    }
}
