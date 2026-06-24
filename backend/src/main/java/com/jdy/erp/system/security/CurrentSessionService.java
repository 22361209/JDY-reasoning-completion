package com.jdy.erp.system.security;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

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
    public static final String SESSION_TOKEN = "jdy.sessionToken";
    public static final String SESSION_GENERATION = "jdy.sessionGeneration";
    private static final int MAX_FAILED_LOGIN = 5;
    private static final String REPEATED_LOGIN_POLICY_KEY = "security.repeated_login_policy";
    private static final String REPEATED_LOGIN_POLICY_SINGLE_ACTIVE = "SINGLE_ACTIVE";
    private static final String REPEATED_LOGIN_POLICY_ALLOW_CONCURRENT = "ALLOW_CONCURRENT";

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
        if (username == null || String.valueOf(username).isBlank()) {
            return null;
        }
        var sessionToken = session.getAttribute(SESSION_TOKEN);
        if (sessionToken == null || String.valueOf(sessionToken).isBlank()) {
            session.invalidate();
            return null;
        }
        var sessionGeneration = session.getAttribute(SESSION_GENERATION);
        if (sessionGeneration == null || !isCurrentSessionGeneration(String.valueOf(username), Number.class.cast(sessionGeneration).intValue())) {
            session.invalidate();
            return null;
        }
        var normalizedUsername = String.valueOf(username);
        if (isSingleActiveSessionPolicy() && !isActiveSessionToken(normalizedUsername, String.valueOf(sessionToken))) {
            session.invalidate();
            return null;
        }
        return normalizedUsername;
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
            SELECT id::text AS id,
                   username,
                   COALESCE(password_hash, '') AS "passwordHash",
                   failed_login_count AS "failedLoginCount",
                   locked_until AS "lockedUntil",
                   active_session_token AS "activeSessionToken",
                   session_generation AS "sessionGeneration"
            FROM sys_user
            WHERE username = ?
              AND enabled = TRUE
            """, normalizedUsername);
        if (rows.isEmpty()) {
            logLogin("LOGIN", null, null, false, "用户不存在或已停用：" + normalizedUsername);
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "用户不存在或已停用");
        }
        var userId = String.valueOf(rows.get(0).get("id"));
        if (isLocked(rows.get(0).get("lockedUntil"))) {
            logLogin("LOGIN_LOCKED", userId, null, false, "账号已锁定");
            throw new ResponseStatusException(HttpStatus.LOCKED, "账号已锁定，请稍后再试");
        }
        var passwordHash = String.valueOf(rows.get(0).get("passwordHash"));
        if (!passwordHash.isBlank()) {
            var expected = passwordHash.startsWith("{noop}") ? passwordHash.substring("{noop}".length()) : passwordHash;
            if (password == null || !expected.equals(password)) {
                var failedCount = Number.class.cast(rows.get(0).get("failedLoginCount")).intValue() + 1;
                if (failedCount >= MAX_FAILED_LOGIN) {
                    jdbcTemplate.update("""
                        UPDATE sys_user
                        SET failed_login_count = ?,
                            locked_until = now() + interval '15 minutes',
                            updated_at = now(),
                            version = version + 1
                        WHERE id = ?::uuid
                        """, failedCount, userId);
                    logLogin("LOGIN_LOCKED", userId, null, false, "连续登录失败，账号锁定 15 分钟");
                    throw new ResponseStatusException(HttpStatus.LOCKED, "连续登录失败，账号已锁定 15 分钟");
                }
                jdbcTemplate.update("""
                    UPDATE sys_user
                    SET failed_login_count = ?,
                        updated_at = now(),
                        version = version + 1
                    WHERE id = ?::uuid
                    """, failedCount, userId);
                logLogin("LOGIN", userId, null, false, "用户名或密码错误");
                throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "用户名或密码错误");
            }
        }
        var request = currentRequest();
        if (request == null) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "无法创建本地会话");
        }
        var newSessionToken = UUID.randomUUID().toString();
        var oldSessionToken = rows.get(0).get("activeSessionToken");
        var sessionGeneration = Number.class.cast(rows.get(0).get("sessionGeneration")).intValue();
        var singleActiveSession = isSingleActiveSessionPolicy();
        if (singleActiveSession) {
            jdbcTemplate.update("""
                UPDATE sys_user
                SET failed_login_count = 0,
                    locked_until = NULL,
                    last_login_at = now(),
                    active_session_token = ?,
                    active_session_started_at = now(),
                    last_session_replaced_at = CASE
                        WHEN active_session_token IS NOT NULL AND active_session_token <> ? THEN now()
                        ELSE last_session_replaced_at
                    END,
                    updated_at = now(),
                    version = version + 1
                WHERE id = ?::uuid
                """, newSessionToken, newSessionToken, userId);
        } else {
            jdbcTemplate.update("""
                UPDATE sys_user
                SET failed_login_count = 0,
                    locked_until = NULL,
                    last_login_at = now(),
                    active_session_token = ?,
                    active_session_started_at = now(),
                    updated_at = now(),
                    version = version + 1
                WHERE id = ?::uuid
                """, newSessionToken, userId);
        }
        var session = request.getSession(true);
        session.setAttribute(SESSION_USERNAME, normalizedUsername);
        session.setAttribute(SESSION_TOKEN, newSessionToken);
        session.setAttribute(SESSION_GENERATION, sessionGeneration);
        if (singleActiveSession && oldSessionToken != null && !String.valueOf(oldSessionToken).isBlank()) {
            logLogin("LOGIN_REPLACED", userId, userId, true, "重复登录，新会话已替换旧会话");
        }
        logLogin("LOGIN", userId, userId, true, null);
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
        var username = currentUsername();
        var updated = jdbcTemplate.update("""
            UPDATE sys_user
            SET password_hash = ?,
                active_session_token = NULL,
                active_session_started_at = NULL,
                last_session_replaced_at = now(),
                session_generation = session_generation + 1,
                updated_at = now(),
                version = version + 1
            WHERE username = ?
            """, "{noop}" + newPassword, username);
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
            var username = session.getAttribute(SESSION_USERNAME);
            var sessionToken = session.getAttribute(SESSION_TOKEN);
            if (username != null && sessionToken != null) {
                jdbcTemplate.update("""
                    UPDATE sys_user
                    SET active_session_token = NULL,
                        active_session_started_at = NULL,
                        updated_at = now(),
                        version = version + 1
                    WHERE username = ?
                      AND active_session_token = ?
                    """, String.valueOf(username), String.valueOf(sessionToken));
            }
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

    private boolean isLocked(Object lockedUntil) {
        if (lockedUntil == null) {
            return false;
        }
        if (lockedUntil instanceof OffsetDateTime offsetDateTime) {
            return offsetDateTime.toInstant().isAfter(Instant.now());
        }
        if (lockedUntil instanceof java.sql.Timestamp timestamp) {
            return timestamp.toInstant().isAfter(Instant.now());
        }
        return false;
    }

    private boolean isActiveSessionToken(String username, String sessionToken) {
        var activeTokens = jdbcTemplate.queryForList("""
            SELECT active_session_token
            FROM sys_user
            WHERE username = ?
              AND enabled = TRUE
            """, String.class, username);
        return !activeTokens.isEmpty() && sessionToken.equals(activeTokens.get(0));
    }

    private boolean isCurrentSessionGeneration(String username, int sessionGeneration) {
        var generations = jdbcTemplate.queryForList("""
            SELECT session_generation
            FROM sys_user
            WHERE username = ?
              AND enabled = TRUE
            """, Integer.class, username);
        return !generations.isEmpty() && generations.get(0) == sessionGeneration;
    }

    private boolean isSingleActiveSessionPolicy() {
        return REPEATED_LOGIN_POLICY_SINGLE_ACTIVE.equals(repeatedLoginPolicy());
    }

    public String repeatedLoginPolicy() {
        var policies = jdbcTemplate.queryForList("""
            SELECT setting_value
            FROM sys_setting
            WHERE setting_key = ?
            """, String.class, REPEATED_LOGIN_POLICY_KEY);
        if (policies.isEmpty()) {
            return REPEATED_LOGIN_POLICY_SINGLE_ACTIVE;
        }
        var policy = policies.get(0);
        if (REPEATED_LOGIN_POLICY_ALLOW_CONCURRENT.equals(policy)) {
            return REPEATED_LOGIN_POLICY_ALLOW_CONCURRENT;
        }
        return REPEATED_LOGIN_POLICY_SINGLE_ACTIVE;
    }

    public void updateRepeatedLoginPolicy(String policy) {
        var normalizedPolicy = policy == null ? "" : policy.trim().toUpperCase();
        if (!List.of(REPEATED_LOGIN_POLICY_SINGLE_ACTIVE, REPEATED_LOGIN_POLICY_ALLOW_CONCURRENT).contains(normalizedPolicy)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "重复登录策略不正确");
        }
        jdbcTemplate.update("""
            INSERT INTO sys_setting (setting_key, setting_value, updated_by)
            VALUES (?, ?, (SELECT id FROM sys_user WHERE username = ?))
            ON CONFLICT (setting_key) DO UPDATE
            SET setting_value = EXCLUDED.setting_value,
                updated_at = now(),
                updated_by = EXCLUDED.updated_by,
                version = sys_setting.version + 1
            """, REPEATED_LOGIN_POLICY_KEY, normalizedPolicy, currentUsername());
        logSetting("UPDATE_SECURITY_SETTING", normalizedPolicy);
    }

    private void logSetting(String action, String reason) {
        jdbcTemplate.update("""
            INSERT INTO sys_operation_log (module_code, action_code, target_type, success, failure_reason, operated_by)
            SELECT 'SYSTEM', ?, 'sys_setting', TRUE, ?, id
            FROM sys_user
            WHERE username = ?
            """, action, reason, currentUsername());
    }

    private void logLogin(String action, String targetUserId, String operatedBy, boolean success, String reason) {
        jdbcTemplate.update("""
            INSERT INTO sys_operation_log (module_code, action_code, target_type, target_id, success, failure_reason, operated_by)
            VALUES ('SYSTEM', ?, 'sys_user', ?::uuid, ?, ?, ?::uuid)
            """, action, targetUserId, success, reason, operatedBy);
    }
}
