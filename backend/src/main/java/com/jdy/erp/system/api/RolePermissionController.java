package com.jdy.erp.system.api;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.jdy.erp.system.security.RequirePermission;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/system")
public class RolePermissionController {
    private final JdbcTemplate jdbcTemplate;

    public RolePermissionController(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @GetMapping("/role-permissions")
    public Map<String, Object> rolePermissions() {
        var permissions = jdbcTemplate.queryForList("""
            SELECT permission_code AS "permissionCode",
                   module_name AS "moduleName",
                   permission_name AS "permissionName",
                   sort_no AS "sortNo"
            FROM sys_permission_catalog
            WHERE enabled = TRUE
            ORDER BY sort_no, permission_code
            """);
        var roleRows = jdbcTemplate.queryForList("""
            SELECT r.id::text AS id,
                   r.code,
                   r.name,
                   r.enabled
            FROM sys_role r
            ORDER BY CASE r.code WHEN 'ADMIN' THEN 0 WHEN 'WAREHOUSE' THEN 1 WHEN 'FINANCE' THEN 2 ELSE 3 END, r.code
            """);
        var roleByCode = new LinkedHashMap<String, Map<String, Object>>();
        for (var row : roleRows) {
            var role = new LinkedHashMap<String, Object>();
            role.put("id", row.get("id"));
            role.put("code", row.get("code"));
            role.put("name", row.get("name"));
            role.put("enabled", row.get("enabled"));
            role.put("permissionCodes", new ArrayList<String>());
            roleByCode.put(String.valueOf(row.get("code")), role);
        }
        jdbcTemplate.query("""
            SELECT r.code AS role_code,
                   p.permission_code
            FROM sys_permission p
            JOIN sys_role r ON r.id = p.role_id
            LEFT JOIN sys_permission_catalog c ON c.permission_code = p.permission_code
            WHERE p.enabled = TRUE
            ORDER BY r.code, c.sort_no, p.permission_code
            """, rs -> {
                var role = roleByCode.get(rs.getString("role_code"));
                if (role != null) {
                    @SuppressWarnings("unchecked")
                    var permissionCodes = (ArrayList<String>) role.get("permissionCodes");
                    permissionCodes.add(rs.getString("permission_code"));
                }
            });
        var roles = List.copyOf(roleByCode.values());
        return Map.of("permissions", permissions, "roles", roles);
    }

    @PutMapping("/roles/{roleCode}/permissions")
    @RequirePermission("system.role_permission.manage")
    @Transactional
    public Map<String, Object> saveRolePermissions(@PathVariable String roleCode, @RequestBody RolePermissionRequest request) {
        var normalizedRoleCode = roleCode == null ? "" : roleCode.trim();
        var roleRows = jdbcTemplate.queryForList("""
            SELECT id::text AS id, code, name, enabled
            FROM sys_role
            WHERE code = ?
            """, normalizedRoleCode);
        if (roleRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "角色不存在");
        }
        var requestedCodes = request.permissionCodes == null ? List.<String>of() : request.permissionCodes.stream()
            .filter(code -> code != null && !code.isBlank())
            .map(String::trim)
            .distinct()
            .toList();
        if (!requestedCodes.isEmpty()) {
            var placeholders = String.join(", ", requestedCodes.stream().map(code -> "?").toList());
            var knownCount = jdbcTemplate.queryForObject("""
                SELECT count(*)
                FROM sys_permission_catalog
                WHERE enabled = TRUE
                  AND permission_code IN (%s)
                """.formatted(placeholders), Integer.class, requestedCodes.toArray());
            if (knownCount == null || knownCount != requestedCodes.size()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "包含未知权限码");
            }
        }
        var roleId = String.valueOf(roleRows.get(0).get("id"));
        jdbcTemplate.update("""
            UPDATE sys_permission
            SET enabled = FALSE
            WHERE role_id = ?::uuid
            """, roleId);
        for (var permissionCode : requestedCodes) {
            jdbcTemplate.update("""
                INSERT INTO sys_permission (role_id, permission_code, enabled)
                VALUES (?::uuid, ?, TRUE)
                ON CONFLICT (role_id, permission_code) DO UPDATE
                SET enabled = TRUE
                """, roleId, permissionCode);
        }
        log("SYSTEM", "SAVE_ROLE_PERMISSION", "sys_role", roleId, true, null);
        return rolePermissions();
    }

    private void log(String module, String action, String targetType, String targetId, boolean success, String reason) {
        jdbcTemplate.update("""
            INSERT INTO sys_operation_log (module_code, action_code, target_type, target_id, success, failure_reason)
            VALUES (?, ?, ?, ?::uuid, ?, ?)
            """, module, action, targetType, targetId, success, reason);
    }

    public record RolePermissionRequest(List<String> permissionCodes) {
    }
}
