package com.jdy.erp.system.security;

import java.util.List;
import java.util.Map;

import jakarta.servlet.http.HttpServletRequest;

import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import org.springframework.web.server.ResponseStatusException;

@Service
public class CurrentSessionService {
    public static final String SESSION_USERNAME = "jdy.username";

    private final JdbcTemplate jdbcTemplate;

    public CurrentSessionService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public String currentUsername() {
        var username = optionalCurrentUsername();
        if (username == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "请先登录");
        }
        return username;
    }

    public String optionalCurrentUsername() {
        var request = currentRequest();
        if (request == null) {
            return null;
        }
        var session = request.getSession(false);
        if (session == null) {
            return null;
        }
        var username = session.getAttribute(SESSION_USERNAME);
        return username == null || String.valueOf(username).isBlank() ? null : String.valueOf(username);
    }

    public boolean isAuthenticated() {
        return optionalCurrentUsername() != null;
    }

    public Map<String, Object> currentUser() {
        var currentUsername = currentUsername();
        var userRows = jdbcTemplate.queryForList("""
            SELECT u.username,
                   u.display_name AS "displayName",
                   r.code AS "roleCode",
                   r.name AS "roleName"
            FROM sys_user u
            JOIN sys_user_role ur ON ur.user_id = u.id
            JOIN sys_role r ON r.id = ur.role_id
            WHERE u.username = ?
              AND u.enabled = TRUE
              AND r.enabled = TRUE
            ORDER BY CASE r.code WHEN 'ADMIN' THEN 0 ELSE 1 END
            LIMIT 1
            """, currentUsername);
        if (userRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "当前用户不存在或已停用");
        }
        var roleCode = String.valueOf(userRows.get(0).get("roleCode"));
        var permissionCodes = permissionCodes(roleCode);
        return Map.of(
            "name", String.valueOf(userRows.get(0).get("displayName")),
            "username", String.valueOf(userRows.get(0).get("username")),
            "role", String.valueOf(userRows.get(0).get("roleName")),
            "roleCode", roleCode,
            "permissionCodes", permissionCodes
        );
    }

    public List<String> permissionCodes(String roleCode) {
        return jdbcTemplate.queryForList("""
            SELECT p.permission_code
            FROM sys_permission p
            JOIN sys_role r ON r.id = p.role_id
            LEFT JOIN sys_permission_catalog c ON c.permission_code = p.permission_code
            WHERE r.code = ?
              AND r.enabled = TRUE
              AND p.enabled = TRUE
              AND COALESCE(c.enabled, TRUE) = TRUE
            ORDER BY c.sort_no, p.permission_code
            """, String.class, roleCode);
    }

    public String currentRoleCode() {
        return String.valueOf(currentUser().get("roleCode"));
    }

    public void login(String username) {
        login(username, null);
    }

    public void login(String username, String password) {
        var normalizedUsername = username == null ? "" : username.trim();
        var rows = jdbcTemplate.queryForList("""
            SELECT username, COALESCE(password_hash, '') AS "passwordHash"
            FROM sys_user
            WHERE username = ?
              AND enabled = TRUE
            """, normalizedUsername);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "用户不存在或已停用");
        }
        var passwordHash = String.valueOf(rows.get(0).get("passwordHash"));
        if (!passwordHash.isBlank()) {
            var expected = passwordHash.startsWith("{noop}") ? passwordHash.substring("{noop}".length()) : passwordHash;
            if (password == null || !expected.equals(password)) {
                throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "用户名或密码错误");
            }
        }
        var request = currentRequest();
        if (request == null) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "无法创建本地会话");
        }
        request.getSession(true).setAttribute(SESSION_USERNAME, normalizedUsername);
    }

    public void verifyCurrentPassword(String password) {
        verifyPassword(currentUsername(), password);
    }

    public void verifyPassword(String username, String password) {
        var rows = jdbcTemplate.queryForList("""
            SELECT COALESCE(password_hash, '') AS "passwordHash"
            FROM sys_user
            WHERE username = ?
              AND enabled = TRUE
            """, username);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "当前用户不存在或已停用");
        }
        var passwordHash = String.valueOf(rows.get(0).get("passwordHash"));
        var expected = passwordHash.startsWith("{noop}") ? passwordHash.substring("{noop}".length()) : passwordHash;
        if (expected.isBlank() || password == null || !expected.equals(password)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "当前密码不正确");
        }
    }

    public void changeCurrentPassword(String newPassword) {
        var updated = jdbcTemplate.update("""
            UPDATE sys_user
            SET password_hash = ?,
                updated_at = now(),
                version = version + 1
            WHERE username = ?
            """, "{noop}" + newPassword, currentUsername());
        if (updated == 0) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "当前用户不存在或已停用");
        }
    }

    public void logout() {
        var request = currentRequest();
        if (request == null) {
            return;
        }
        var session = request.getSession(false);
        if (session != null) {
            session.invalidate();
        }
    }

    private HttpServletRequest currentRequest() {
        var attributes = RequestContextHolder.getRequestAttributes();
        if (attributes instanceof ServletRequestAttributes servletAttributes) {
            return servletAttributes.getRequest();
        }
        return null;
    }
}
