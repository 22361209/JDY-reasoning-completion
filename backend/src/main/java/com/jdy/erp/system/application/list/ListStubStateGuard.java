package com.jdy.erp.system.application.list;

import java.util.List;
import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;
import com.jdy.erp.system.security.CurrentPermissionService;

@Component
public class ListStubStateGuard {
    private static final Map<String, String> READ_PERMISSIONS = Map.ofEntries(
        Map.entry("purchase-summary-report", "purchase.order.audit"),
        Map.entry("task-track-report", "production.task.audit"),
        Map.entry("production-task-list", "production.task.audit"),
        Map.entry("production-task-form-list", "production.task.audit"),
        Map.entry("stock-count-list", "inventory.stock_count.audit"),
        Map.entry("stock-count-form-list", "inventory.stock_count.audit"),
        Map.entry("stock-count-gain-list", "inventory.stock_count_gain.audit"),
        Map.entry("stock-count-gain-form-list", "inventory.stock_count_gain.audit"),
        Map.entry("stock-count-loss-list", "inventory.stock_count_loss.audit"),
        Map.entry("stock-count-loss-form-list", "inventory.stock_count_loss.audit"),
        Map.entry("sales-return-form-list", "sales.out.audit"),
        Map.entry("sales-out-return-source-selector", "sales.out.audit"),
        Map.entry("material-scrap-form-list", "production.document.audit"),
        Map.entry("material-scrap-source-selector", "production.document.audit"),
        Map.entry("supplier-master-list", "master.data.manage")
    );
    private static final Map<String, List<String>> READ_PERMISSION_ALTERNATIVES = Map.of(
        "employee-master-list", List.of("master.data.manage", "system.role_permission.manage"),
        "employee-master-selector", List.of("master.data.manage", "system.role_permission.manage"),
        "supplier-master-selector", List.of(
            "master.data.manage",
            "purchase.order.audit",
            "purchase.in.audit",
            "purchase.return.audit",
            "inventory.other_stock_in.audit"
        ),
        "financial-account-master-list", List.of("master.data.manage", "finance.settle"),
        "financial-account-master-selector", List.of("master.data.manage", "finance.settle"),
        "financial-account-settlement-selector", List.of("finance.settle", "finance.cash_transfer.audit"),
        "ar-receipt-form-list", List.of("finance.report.view", "finance.settle"),
        "ap-payment-form-list", List.of("finance.report.view", "finance.settle"),
        "ar-receivable-settlement-source-selector", List.of("finance.settle"),
        "ap-payable-settlement-source-selector", List.of("finance.settle")
    );

    private final ListQueryContractRegistry contractRegistry;
    private final CurrentPermissionService currentPermissionService;

    public ListStubStateGuard(
        ListQueryContractRegistry contractRegistry,
        CurrentPermissionService currentPermissionService
    ) {
        this.contractRegistry = contractRegistry;
        this.currentPermissionService = currentPermissionService;
    }

    public void assertReadable(String listKey) {
        assertReadable(listKey, "current");
    }

    public void assertReadable(String listKey, String scope) {
        contractRegistry.contractFor(listKey, "header");

        var permissionAlternatives = READ_PERMISSION_ALTERNATIVES.get(listKey);
        if (permissionAlternatives != null && permissionAlternatives.stream().noneMatch(currentPermissionService::hasPermission)) {
            throw new ResponseStatusException(
                HttpStatus.FORBIDDEN,
                "Missing any permission: " + String.join(" or ", permissionAlternatives)
            );
        }
        var requiredPermission = READ_PERMISSIONS.get(listKey);
        if (requiredPermission != null) {
            currentPermissionService.requirePermission(requiredPermission);
        }
        if (!"operation-log-list".equals(listKey)) {
            return;
        }
        var normalizedScope = scope == null || scope.isBlank() ? "current" : scope.toLowerCase(java.util.Locale.ROOT);
        if (!java.util.Set.of("current", "platform", "historical").contains(normalizedScope)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unsupported operation-log scope");
        }
        currentPermissionService.requirePermission("system.audit_log.view");
        if (!"current".equals(normalizedScope)) {
            if (!"ADMIN".equals(currentPermissionService.currentRoleCode())) {
                throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Operation-log platform scopes require ADMIN");
            }
            currentPermissionService.requirePermission("system.account_set.manage");
        }
    }
}
