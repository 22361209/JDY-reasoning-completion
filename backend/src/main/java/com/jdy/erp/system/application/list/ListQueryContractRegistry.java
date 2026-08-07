package com.jdy.erp.system.application.list;

import java.util.List;
import java.util.Set;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

@Component
public class ListQueryContractRegistry {
    private static final Set<String> MASTER_LIST_KEYS = Set.of(
        "product-master-list",
        "unit-master-list",
        "customer-master-list",
        "supplier-master-list",
        "warehouse-master-list",
        "employee-master-list",
        "financial-account-master-list"
    );

    private static final Set<String> MASTER_SELECTOR_KEYS = Set.of(
        "employee-master-selector",
        "financial-account-master-selector",
        "financial-account-settlement-selector"
    );

    private static final Set<String> SOURCE_SELECTOR_KEYS = Set.of(
        "sales-quote-source-selector",
        "sales-order-source-selector",
        "delivery-notice-source-selector",
        "sales-out-return-source-selector",
        "purchase-requisition-source-selector",
        "purchase-order-source-selector",
        "purchase-in-source-selector",
        "ar-receivable-settlement-source-selector",
        "ap-payable-settlement-source-selector",
        "production-task-source-selector",
        "outsourcing-work-order-issue-source-selector",
        "outsourcing-work-order-receipt-source-selector",
        "outsourcing-receipt-return-source-selector",
        "outsourcing-receipt-scrap-source-selector"
    );

    private static final Set<String> GENERIC_LIST_KEYS = Set.of(
        "product-category-list",
        "product-name-list",
        "production-department-list",
        "purchase-requisition-list",
        "other-in-list",
        "other-in-form-list",
        "other-out-list",
        "other-out-form-list",
        "stock-transfer-list",
        "stock-transfer-form-list",
        "receivable-list",
        "ar-receivable-list",
        "ar-receipt-form-list",
        "payable-list",
        "ap-payable-list",
        "ap-payment-form-list",
        "bom-list",
        "production-plan-list",
        "kit-analysis-list",
        "material-issue-list",
        "material-issue-form-list",
        "product-in-list",
        "product-in-form-list",
        "outsourcing-surface-list",
        "outsourcing-work-order-list",
        "outsourcing-issue-list",
        "outsourcing-receipt-list",
        "outsourcing-return-list",
        "outsourcing-scrap-list",
        "role-list",
        "user-role-list"
    );

    public ListQueryContract contractFor(String listKey, String view) {
        if (listKey == null || listKey.isBlank()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Unknown list key: " + listKey);
        }
        var normalizedView = "detail".equalsIgnoreCase(view) ? "detail" : "header";
        if (MASTER_SELECTOR_KEYS.contains(listKey)) {
            return masterSelectorContract(listKey, normalizedView);
        }
        if (MASTER_LIST_KEYS.contains(listKey)) {
            if ("employee-master-list".equals(listKey) || "financial-account-master-list".equals(listKey)) {
                return a140MasterContract(listKey, normalizedView);
            }
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
        if ("material-scrap-form-list".equals(listKey)) {
            return new ListQueryContract(
                listKey,
                normalizedView,
                List.of("billNo", "sourceIssueNo", "businessType", "workshopCode", "workshopName", "productCode", "productName", "spec", "scrapReason"),
                "billDate",
                "header".equals(normalizedView) ? "exists" : "join",
                normalizedView,
                "materialScrap",
                true
            );
        }
        if ("material-scrap-source-selector".equals(listKey)) {
            return new ListQueryContract(
                listKey,
                "detail",
                List.of("billNo", "workshopCode", "workshopName", "productCode", "productName", "spec", "unit", "sourceWarehouseCode"),
                "billDate",
                "row",
                "detail",
                "materialScrap",
                true
            );
        }
        if (SOURCE_SELECTOR_KEYS.contains(listKey)) {
            return new ListQueryContract(
                listKey,
                "detail",
                List.of(
                    "billNo",
                    "sourceBillNo",
                    "sourceOrderNo",
                    "customerCode",
                    "customer",
                    "supplierCode",
                    "supplier",
                    "supplierName",
                    "productCode",
                    "productName",
                    "spec",
                    "unit",
                    "warehouseCode",
                    "customerMaterialCode",
                    "customerOrderNo",
                    "supplierMaterialCode",
                    "partyId",
                    "partyCode",
                    "partyName",
                    "currency",
                    "lineRemark"
                ),
                "billDate",
                "row",
                "detail",
                "sourceSelector",
                false
            );
        }
        return switch (listKey == null ? "" : listKey) {
            case "operation-log-list" -> new ListQueryContract(
                listKey,
                normalizedView,
                List.of("id", "module", "action", "actorType", "actorUsername", "actorDisplayName", "operator", "accountSetCode", "accountSetName", "targetType", "targetId", "targetNo", "reason", "operatedAt"),
                "operatedAt",
                "row",
                normalizedView,
                "operationLog",
                true
            );
            case "sales-quote-form-list", "delivery-notice-form-list", "sales-out-list", "sales-out-form-list" ->
                new ListQueryContract(listKey, normalizedView, List.of("billNo", "customerCode", "customer", "partner", "productCode", "productName", "spec", "customerMaterialCode", "customerOrderNo", "remark", "lineRemark"), "billDate", "exists", normalizedView, "default", false);
            case "sales-return-form-list" ->
                new ListQueryContract(listKey, normalizedView, List.of("billNo", "sourceBillNo", "customerCode", "customer", "partner", "currency", "productCode", "productName", "spec", "remark", "lineRemark"), "billDate", "exists", normalizedView, "default", false);
            case "purchase-order-form-list", "purchase-in-list", "purchase-in-form-list", "purchase-return-list", "purchase-return-form-list" ->
                new ListQueryContract(listKey, normalizedView, List.of("billNo", "supplierCode", "supplier", "partner", "productCode", "productName", "spec", "sourceBillNo", "lineRemark"), "billDate", "exists", normalizedView, "default", false);
            case "ar-receipt-form-list", "ap-payment-form-list" ->
                new ListQueryContract(listKey, normalizedView, List.of("billNo", "sourceBillNo", "partyCode", "partyName", "currency", "remark"), "billDate", "row", normalizedView, "default", false);
            case "inventory-query-list", "stock-alert-list" ->
                new ListQueryContract(listKey, normalizedView, List.of("code", "name", "productCode", "productName", "spec", "warehouse", "warehouseCode", "warehouseName", "status"), "", "row", normalizedView, "default", false);
            case "purchase-summary-report" ->
                new ListQueryContract(listKey, normalizedView, List.of("supplierCode", "supplier", "productCode", "productName"), "", "row", normalizedView, "default", false);
            case "stock-count-list", "stock-count-form-list" ->
                new ListQueryContract(listKey, normalizedView, List.of("billNo", "businessType", "department", "productCode", "productName", "warehouse"), "billDate", "row", normalizedView, "default", false);
            case "stock-count-gain-list", "stock-count-gain-form-list", "stock-count-loss-list", "stock-count-loss-form-list" ->
                new ListQueryContract(listKey, normalizedView, List.of("billNo", "sourceBillNo", "productCode", "productName", "warehouse"), "billDate", "row", normalizedView, "default", false);
            case "production-task-list", "production-task-form-list", "task-track-report" ->
                new ListQueryContract(listKey, normalizedView, List.of("billNo", "planNo", "bomCode", "productCode", "productName", "warehouse"), "", "row", normalizedView, "default", false);
            default -> genericContractOrThrow(listKey, normalizedView);
        };
    }

    private ListQueryContract genericContractOrThrow(String listKey, String view) {
        if (!GENERIC_LIST_KEYS.contains(listKey)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Unknown list key: " + listKey);
        }
        return new ListQueryContract(listKey, view, List.of(), "", "row", view, "default", false);
    }

    private ListQueryContract a140MasterContract(String listKey, String view) {
        var employee = "employee-master-list".equals(listKey);
        return new ListQueryContract(
            listKey,
            view,
            employee
                ? List.of("code", "name", "position", "department", "phone", "email")
                : List.of("code", "name", "accountType", "bankName", "accountNo", "accountHolder", "currency"),
            "updatedAt",
            "row",
            view,
            "default",
            false
        );
    }

    private ListQueryContract masterSelectorContract(String listKey, String view) {
        var employee = "employee-master-selector".equals(listKey);
        var settlementAccount = "financial-account-settlement-selector".equals(listKey);
        return new ListQueryContract(
            listKey,
            view,
            employee
                ? List.of("code", "name", "position", "department")
                : settlementAccount
                    ? List.of("code", "name", "accountType", "bankName", "currency")
                    : List.of("code", "name", "accountType", "bankName", "accountNo", "accountHolder", "currency"),
            "updatedAt",
            "row",
            view,
            "default",
            false
        );
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
