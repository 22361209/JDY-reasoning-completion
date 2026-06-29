package com.jdy.erp.system.security;

import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class CurrentPermissionService {
    private final JdbcTemplate jdbcTemplate;
    private final CurrentSessionService currentSessionService;

    public CurrentPermissionService(@Qualifier("platformJdbcTemplate") JdbcTemplate jdbcTemplate, CurrentSessionService currentSessionService) {
        this.jdbcTemplate = jdbcTemplate;
        this.currentSessionService = currentSessionService;
    }

    public String currentRoleCode() {
        return currentSessionService.currentRoleCode();
    }

    public boolean hasPermission(String permissionCode) {
        var count = jdbcTemplate.queryForObject("""
            SELECT count(*)
            FROM sys_permission p
            JOIN sys_role r ON r.id = p.role_id
            JOIN sys_permission_catalog c ON c.permission_code = p.permission_code
            WHERE r.code = ?
              AND r.enabled = TRUE
              AND p.permission_code = ?
              AND p.enabled = TRUE
              AND c.enabled = TRUE
            """, Integer.class, currentRoleCode(), permissionCode);
        return count != null && count > 0;
    }
}
