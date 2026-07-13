package com.jdy.erp.system.application.list;

import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;
import com.jdy.erp.system.security.CurrentPermissionService;

@Component
public class ListStubStateGuard {
    private static final Map<String, String> READ_PERMISSIONS = Map.of(
        "purchase-summary-report", "purchase.order.audit",
        "task-track-report", "production.task.audit",
        "production-task-list", "production.task.audit",
        "production-task-form-list", "production.task.audit",
        "stock-count-list", "inventory.stock_count.audit",
        "stock-count-form-list", "inventory.stock_count.audit",
        "stock-count-gain-list", "inventory.stock_count_gain.audit",
        "stock-count-gain-form-list", "inventory.stock_count_gain.audit",
        "stock-count-loss-list", "inventory.stock_count_loss.audit",
        "stock-count-loss-form-list", "inventory.stock_count_loss.audit"
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
