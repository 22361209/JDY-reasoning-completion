package com.jdy.erp.system.api;

import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/lists")
public class ListStubController {

    @GetMapping("/{listKey}")
    public Map<String, Object> rows(
        @PathVariable String listKey,
        @RequestParam(defaultValue = "") String keyword,
        @RequestParam(defaultValue = "") String status,
        @RequestParam(defaultValue = "1") int page,
        @RequestParam(defaultValue = "20") int pageSize
    ) {
        var rows = seedRows(listKey).stream()
            .filter(row -> keyword.isBlank() || row.values().stream().anyMatch(value -> String.valueOf(value).contains(keyword)))
            .filter(row -> status.isBlank() || status.equals(row.get("status")))
            .toList();
        return Map.of(
            "page", page,
            "pageSize", pageSize,
            "total", rows.size(),
            "rows", rows.stream().skip((long) (page - 1) * pageSize).limit(pageSize).toList()
        );
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
