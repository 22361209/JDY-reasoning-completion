package com.jdy.erp.system.api;

import java.util.List;
import java.util.Map;

import com.jdy.erp.system.security.RequirePermission;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/system")
public class UserManagementController {
    private final JdbcTemplate jdbcTemplate;

    public UserManagementController(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @GetMapping("/managed-users")
    @RequirePermission("system.role_permission.manage")
    public Map<String, Object> managedUsers() {
        return Map.of(
            "users", userRows(),
            "roles", roleRows()
        );
    }

    @PostMapping("/managed-users")
    @RequirePermission("system.role_permission.manage")
    @Transactional
    public Map<String, Object> createUser(@RequestBody UserRequest request) {
        var username = required(request.username(), "用户名");
        var displayName = required(request.displayName(), "姓名");
        var roleCode = required(request.roleCode(), "角色");
        var password = required(request.password(), "初始密码");
        var roleId = roleId(roleCode);
        try {
            var user = jdbcTemplate.queryForMap("""
                INSERT INTO sys_user (username, display_name, password_hash, enabled)
                VALUES (?, ?, ?, ?)
                RETURNING id::text AS id
                """, username, displayName, "{noop}" + password, request.enabled() == null || request.enabled());
            jdbcTemplate.update("""
                INSERT INTO sys_user_role (user_id, role_id)
                VALUES (?::uuid, ?::uuid)
                """, user.get("id"), roleId);
        } catch (DuplicateKeyException ex) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "用户名已存在");
        }
        return managedUsers();
    }

    @PutMapping("/managed-users/{username}")
    @RequirePermission("system.role_permission.manage")
    @Transactional
    public Map<String, Object> updateUser(@PathVariable String username, @RequestBody UserRequest request) {
        var normalizedUsername = required(username, "用户名");
        var displayName = required(request.displayName(), "姓名");
        var roleCode = required(request.roleCode(), "角色");
        var userId = userId(normalizedUsername);
        var roleId = roleId(roleCode);
        jdbcTemplate.update("""
            UPDATE sys_user
            SET display_name = ?,
                enabled = ?,
                updated_at = now(),
                version = version + 1
            WHERE id = ?::uuid
            """, displayName, request.enabled() == null || request.enabled(), userId);
        jdbcTemplate.update("DELETE FROM sys_user_role WHERE user_id = ?::uuid", userId);
        jdbcTemplate.update("""
            INSERT INTO sys_user_role (user_id, role_id)
            VALUES (?::uuid, ?::uuid)
            """, userId, roleId);
        return managedUsers();
    }

    @PutMapping("/managed-users/{username}/password")
    @RequirePermission("system.role_permission.manage")
    public Map<String, Object> resetPassword(@PathVariable String username, @RequestBody PasswordRequest request) {
        var normalizedUsername = required(username, "用户名");
        var password = required(request.password(), "新密码");
        var updated = jdbcTemplate.update("""
            UPDATE sys_user
            SET password_hash = ?,
                updated_at = now(),
                version = version + 1
            WHERE username = ?
            """, "{noop}" + password, normalizedUsername);
        if (updated == 0) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "用户不存在");
        }
        return Map.of("ok", true);
    }

    private List<Map<String, Object>> userRows() {
        return jdbcTemplate.queryForList("""
            SELECT u.id::text AS id,
                   u.username,
                   u.display_name AS "displayName",
                   r.code AS "roleCode",
                   r.name AS "roleName",
                   u.enabled
            FROM sys_user u
            LEFT JOIN sys_user_role ur ON ur.user_id = u.id
            LEFT JOIN sys_role r ON r.id = ur.role_id
            ORDER BY CASE r.code WHEN 'ADMIN' THEN 0 WHEN 'WAREHOUSE' THEN 1 WHEN 'FINANCE' THEN 2 ELSE 3 END, u.username
            """);
    }

    private List<Map<String, Object>> roleRows() {
        return jdbcTemplate.queryForList("""
            SELECT code, name, enabled
            FROM sys_role
            WHERE enabled = TRUE
            ORDER BY CASE code WHEN 'ADMIN' THEN 0 WHEN 'WAREHOUSE' THEN 1 WHEN 'FINANCE' THEN 2 ELSE 3 END, code
            """);
    }

    private String userId(String username) {
        var rows = jdbcTemplate.queryForList("SELECT id::text AS id FROM sys_user WHERE username = ?", username);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "用户不存在");
        }
        return String.valueOf(rows.get(0).get("id"));
    }

    private String roleId(String roleCode) {
        var rows = jdbcTemplate.queryForList("SELECT id::text AS id FROM sys_role WHERE code = ? AND enabled = TRUE", roleCode);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "角色不存在或已停用");
        }
        return String.valueOf(rows.get(0).get("id"));
    }

    private String required(String value, String label) {
        if (value == null || value.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不能为空");
        }
        return value.trim();
    }

    public record UserRequest(String username, String displayName, String roleCode, String password, Boolean enabled) {
    }

    public record PasswordRequest(String password) {
    }
}
