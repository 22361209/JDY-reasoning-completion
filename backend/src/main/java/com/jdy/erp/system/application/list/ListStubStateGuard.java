package com.jdy.erp.system.application.list;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;
import com.jdy.erp.system.security.CurrentPermissionService;

@Component
public class ListStubStateGuard {
    private final CurrentPermissionService currentPermissionService;

    public ListStubStateGuard(CurrentPermissionService currentPermissionService) {
        this.currentPermissionService = currentPermissionService;
    }

    public void assertReadable(String listKey) {
        assertReadable(listKey, "current");
    }

    public void assertReadable(String listKey, String scope) {
        if ("permission-denied-list".equals(listKey)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "No permission for this list");
        }
        if ("error-list".equals(listKey)) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Stub error for list state");
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
