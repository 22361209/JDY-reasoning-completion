package com.jdy.erp.system.api;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;

import com.jdy.erp.shared.application.OperationLogCommand;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.system.security.RequirePermission;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/system")
public class RolePermissionController {
    private static final Pattern ROLE_CODE = Pattern.compile("[A-Z][A-Z0-9_-]{0,79}");

    private final JdbcTemplate jdbcTemplate;
    private final OperationLogService operationLogService;

    public RolePermissionController(
        @Qualifier("platformJdbcTemplate") JdbcTemplate jdbcTemplate,
        OperationLogService operationLogService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.operationLogService = operationLogService;
    }

    @GetMapping("/role-permissions")
    @RequirePermission("system.role_permission.manage")
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

    @PostMapping("/roles")
    @RequirePermission("system.role_permission.manage")
    @ResponseStatus(HttpStatus.CREATED)
    @Transactional(transactionManager = "platformTransactionManager")
    public Map<String, Object> createRole(@RequestBody RoleCreateRequest request) {
        if (request == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "角色请求不能为空");
        }
        var roleCode = required(request.code(), "角色编码", 80).toUpperCase(Locale.ROOT);
        if (roleCode.length() > 80 || !ROLE_CODE.matcher(roleCode).matches()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "角色编码须以字母开头，且只能包含大写字母、数字、下划线或连字符");
        }
        var roleName = required(request.name(), "角色名称", 120);
        var permissionCodes = normalizePermissionCodes(request.permissionCodes());
        var roleId = UUID.randomUUID();
        var insertedRoles = jdbcTemplate.queryForList("""
            INSERT INTO sys_role (id, code, name, enabled)
            VALUES (?::uuid, ?, ?, TRUE)
            ON CONFLICT (code) DO NOTHING
            RETURNING id::text AS id
            """, roleId.toString(), roleCode, roleName);
        if (insertedRoles.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "角色编码已存在");
        }
        savePermissions(roleId.toString(), permissionCodes);
        operationLogService.logPlatform(OperationLogCommand.success(
            "SYSTEM",
            "CREATE_ROLE",
            "sys_role",
            roleId,
            roleCode,
            OperationLogCommand.ActorMode.CURRENT_USER,
            null,
            Map.of(),
            OperationLogCommand.state(
                OperationLogCommand.StateField.ROLE_CODE, roleCode,
                OperationLogCommand.StateField.DISPLAY_NAME, roleName,
                OperationLogCommand.StateField.ENABLED, true,
                OperationLogCommand.StateField.PERMISSION_CODES, permissionCodes
            ),
            "nameLength=" + roleName.length()
        ));
        return rolePermissions();
    }

    @PutMapping("/roles/{roleCode}/permissions")
    @RequirePermission("system.role_permission.manage")
    @Transactional(transactionManager = "platformTransactionManager")
    public Map<String, Object> saveRolePermissions(@PathVariable String roleCode, @RequestBody RolePermissionRequest request) {
        if (request == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "权限请求不能为空");
        }
        var normalizedRoleCode = roleCode == null ? "" : roleCode.trim();
        var roleRows = jdbcTemplate.queryForList("""
            SELECT id::text AS id, code, name, enabled
            FROM sys_role
            WHERE code = ?
            """, normalizedRoleCode);
        if (roleRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "角色不存在");
        }
        var requestedCodes = normalizePermissionCodes(request.permissionCodes);
        var roleId = String.valueOf(roleRows.get(0).get("id"));
        var beforePermissionCodes = jdbcTemplate.queryForList("""
            SELECT permission_code
            FROM sys_permission
            WHERE role_id = ?::uuid
              AND enabled = TRUE
            ORDER BY permission_code
            """, String.class, roleId);
        jdbcTemplate.update("UPDATE sys_permission SET enabled = FALSE WHERE role_id = ?::uuid", roleId);
        savePermissions(roleId, requestedCodes);
        operationLogService.logPlatform(OperationLogCommand.success(
            "SYSTEM",
            "SAVE_ROLE_PERMISSION",
            "sys_role",
            UUID.fromString(roleId),
            normalizedRoleCode,
            OperationLogCommand.ActorMode.CURRENT_USER,
            null,
            OperationLogCommand.state(OperationLogCommand.StateField.PERMISSION_CODES, beforePermissionCodes),
            OperationLogCommand.state(OperationLogCommand.StateField.PERMISSION_CODES, requestedCodes),
            null
        ));
        return rolePermissions();
    }

    public record RolePermissionRequest(List<String> permissionCodes) {
    }

    public record RoleCreateRequest(String code, String name, List<String> permissionCodes) {
    }

    private List<String> normalizePermissionCodes(List<String> rawCodes) {
        var permissionCodes = rawCodes == null ? List.<String>of() : rawCodes.stream()
            .filter(code -> code != null && !code.isBlank())
            .map(String::trim)
            .distinct()
            .sorted()
            .toList();
        if (permissionCodes.isEmpty()) {
            return permissionCodes;
        }
        var placeholders = String.join(", ", permissionCodes.stream().map(code -> "?").toList());
        var knownCount = jdbcTemplate.queryForObject("""
            SELECT count(*)
            FROM sys_permission_catalog
            WHERE enabled = TRUE
              AND permission_code IN (%s)
            """.formatted(placeholders), Integer.class, permissionCodes.toArray());
        if (knownCount == null || knownCount != permissionCodes.size()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "包含未知权限码");
        }
        return permissionCodes;
    }

    private void savePermissions(String roleId, List<String> permissionCodes) {
        for (var permissionCode : permissionCodes) {
            jdbcTemplate.update("""
                INSERT INTO sys_permission (role_id, permission_code, enabled)
                VALUES (?::uuid, ?, TRUE)
                ON CONFLICT (role_id, permission_code) DO UPDATE
                SET enabled = TRUE
                """, roleId, permissionCode);
        }
    }

    private String required(String value, String label, int maxLength) {
        var normalized = value == null ? "" : value.trim();
        if (normalized.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不能为空");
        }
        if (normalized.length() > maxLength) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不能超过" + maxLength + "个字符");
        }
        return normalized;
    }
}
