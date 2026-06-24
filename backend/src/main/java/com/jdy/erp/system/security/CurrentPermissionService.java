package com.jdy.erp.system.security;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class CurrentPermissionService {
    private static final String LOCAL_USERNAME = "admin";

    private final JdbcTemplate jdbcTemplate;

    public CurrentPermissionService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public String currentRoleCode() {
        var rows = jdbcTemplate.queryForList("""
            SELECT r.code
            FROM sys_user u
            JOIN sys_user_role ur ON ur.user_id = u.id
            JOIN sys_role r ON r.id = ur.role_id
            WHERE u.username = ?
              AND u.enabled = TRUE
              AND r.enabled = TRUE
            ORDER BY CASE r.code WHEN 'ADMIN' THEN 0 ELSE 1 END
            LIMIT 1
            """, String.class, LOCAL_USERNAME);
        return rows.isEmpty() ? "ADMIN" : rows.get(0);
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
