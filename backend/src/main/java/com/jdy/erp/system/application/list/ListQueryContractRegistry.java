package com.jdy.erp.system.application.list;

import java.util.List;

import org.springframework.stereotype.Component;

@Component
public class ListQueryContractRegistry {
    public ListQueryContract contractFor(String listKey, String view) {
        var normalizedView = "detail".equalsIgnoreCase(view) ? "detail" : "header";
        if (listKey.endsWith("-master-list")) {
            return new ListQueryContract(
                listKey,
                normalizedView,
                List.of("code", "name", "spec", "category", "contact", "phone", "warehouseCode", "warehouseName"),
                "updatedAt",
                "row",
                normalizedView,
                "default",
                false
            );
        }
        if ("sales-order-form-list".equals(listKey)) {
            return salesOrderContract(normalizedView);
        }
        return switch (listKey) {
            case "operation-log-list" -> new ListQueryContract(
                listKey,
                normalizedView,
                List.of("module", "action", "targetType", "targetNo", "operator", "reason", "operatedAt"),
                "operatedAt",
                "row",
                normalizedView,
                "default",
                false
            );
            case "sales-quote-form-list", "delivery-notice-form-list", "sales-out-list", "sales-out-form-list" ->
                new ListQueryContract(listKey, normalizedView, List.of("billNo", "customerCode", "customer", "partner", "productCode", "productName", "spec", "customerMaterialCode", "customerOrderNo", "remark", "lineRemark"), "billDate", "exists", normalizedView, "default", false);
            case "purchase-order-form-list", "purchase-in-list", "purchase-in-form-list", "purchase-return-list", "purchase-return-form-list" ->
                new ListQueryContract(listKey, normalizedView, List.of("billNo", "supplierCode", "supplier", "partner", "productCode", "productName", "spec", "sourceBillNo", "lineRemark"), "billDate", "exists", normalizedView, "default", false);
            case "inventory-query-list", "stock-alert-list" ->
                new ListQueryContract(listKey, normalizedView, List.of("code", "name", "productCode", "productName", "spec", "warehouse", "warehouseCode", "warehouseName", "status"), "", "row", normalizedView, "default", false);
            default -> new ListQueryContract(listKey, normalizedView, List.of(), "", "row", normalizedView, "default", false);
        };
    }

    private ListQueryContract salesOrderContract(String view) {
        return new ListQueryContract(
            "sales-order-form-list",
            view,
            List.of("billNo", "customerCode", "customer", "partner", "productCode", "productName", "spec", "customerMaterialCode", "customerOrderNo", "remark", "lineRemark"),
            "billDate",
            "header".equals(view) ? "exists" : "join",
            view,
            "salesOrder",
            true
        );
    }
}
