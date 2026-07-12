package com.jdy.erp.system.application;

import java.util.Locale;

import com.jdy.erp.system.security.CurrentPermissionService;
import com.jdy.erp.system.security.CurrentSessionService;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

@Service
public class ListFilterPresetAccessPolicy {
    private static final String MANAGE_SHARED_PRESET_PERMISSION = "system.role_permission.manage";

    private final CurrentSessionService currentSessionService;
    private final CurrentPermissionService currentPermissionService;

    public ListFilterPresetAccessPolicy(
        CurrentSessionService currentSessionService,
        CurrentPermissionService currentPermissionService
    ) {
        this.currentSessionService = currentSessionService;
        this.currentPermissionService = currentPermissionService;
    }

    public PresetScope currentPersonalScope() {
        return new PresetScope(
            currentSessionService.currentRoleCode(),
            currentSessionService.currentDisplayName()
        );
    }

    public PresetScope resolveWriteScope(String requestedScope, String requestedRoleCode) {
        var scope = requestedScope == null ? "" : requestedScope.trim().toUpperCase(Locale.ROOT);
        if (!scope.isEmpty() && !"PERSONAL".equals(scope) && !"ROLE".equals(scope) && !"GENERAL".equals(scope)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "预设作用域只能是 PERSONAL、ROLE 或 GENERAL");
        }
        if ("GENERAL".equals(scope)) {
            requireSharedPresetPermission();
            return new PresetScope(null, null);
        }
        var roleCode = requestedRoleCode == null ? "" : requestedRoleCode.trim();
        if ("ROLE".equals(scope) || (!"PERSONAL".equals(scope) && !roleCode.isEmpty())) {
            if (roleCode.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "角色作用域必须指定角色");
            }
            requireSharedPresetPermission();
            return new PresetScope(roleCode, null);
        }
        return currentPersonalScope();
    }

    public void requireCanModifyStoredScope(String roleCode, String userName) {
        if (userName == null) {
            requireSharedPresetPermission();
            return;
        }
        var currentScope = currentPersonalScope();
        if (userName.equals(currentScope.userName()) && equalsNullable(roleCode, currentScope.roleCode())) {
            return;
        }
        throw new ResponseStatusException(HttpStatus.FORBIDDEN, "当前用户无权修改其他用户的筛选预设");
    }

    private void requireSharedPresetPermission() {
        if (currentPermissionService.hasPermission(MANAGE_SHARED_PRESET_PERMISSION)) {
            return;
        }
        throw new ResponseStatusException(
            HttpStatus.FORBIDDEN,
            "当前角色无权执行该操作：" + MANAGE_SHARED_PRESET_PERMISSION
        );
    }

    private boolean equalsNullable(String left, String right) {
        return left == null ? right == null : left.equals(right);
    }

    public record PresetScope(String roleCode, String userName) {
    }
}
