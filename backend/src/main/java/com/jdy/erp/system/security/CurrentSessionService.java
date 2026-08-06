package com.jdy.erp.system.security;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import jakarta.servlet.http.HttpServletRequest;

import com.jdy.erp.shared.application.OperationLogCommand;
import com.jdy.erp.shared.application.OperationLogFailureService;
import com.jdy.erp.shared.application.OperationLogService;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import org.springframework.web.server.ResponseStatusException;

@Service
public class CurrentSessionService {
    public static final String SESSION_USERNAME = "jdy.username";
    public static final String SESSION_TOKEN = "jdy.sessionToken";
    public static final String SESSION_GENERATION = "jdy.sessionGeneration";
    public static final String SESSION_ACCOUNT_SET_ID = "jdy.accountSetId";
    public static final String SESSION_ACCOUNT_SET_CODE = "jdy.accountSetCode";
    public static final String SESSION_ACCOUNT_SET_SCOPE_TOKEN = "jdy.accountSetScopeToken";
    private static final int MAX_FAILED_LOGIN = 5;
    private static final int DEFAULT_SESSION_TIMEOUT_MINUTES = 30;
    private static final int MIN_SESSION_TIMEOUT_MINUTES = 5;
    private static final int MAX_SESSION_TIMEOUT_MINUTES = 480;
    private static final String REPEATED_LOGIN_POLICY_KEY = "security.repeated_login_policy";
    private static final String SESSION_TIMEOUT_MINUTES_KEY = "security.session_timeout_minutes";
    private static final String REPEATED_LOGIN_POLICY_SINGLE_ACTIVE = "SINGLE_ACTIVE";
    private static final String REPEATED_LOGIN_POLICY_ALLOW_CONCURRENT = "ALLOW_CONCURRENT";

    private final JdbcTemplate jdbcTemplate;
    private final OperationLogService operationLogService;
    private final OperationLogFailureService operationLogFailureService;
    private final TransactionTemplate platformTransactions;
    private final RegressionActiveRequestTracker regressionActiveRequestTracker;
    private final RegressionSharedAdminLoginGuard regressionSharedAdminLoginGuard;

    public CurrentSessionService(
        @Qualifier("platformJdbcTemplate") JdbcTemplate jdbcTemplate,
        OperationLogService operationLogService,
        OperationLogFailureService operationLogFailureService,
        @Qualifier("platformTransactionManager") PlatformTransactionManager platformTransactionManager,
        RegressionActiveRequestTracker regressionActiveRequestTracker,
        RegressionSharedAdminLoginGuard regressionSharedAdminLoginGuard
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.operationLogService = operationLogService;
        this.operationLogFailureService = operationLogFailureService;
        this.platformTransactions = new TransactionTemplate(platformTransactionManager);
        this.regressionActiveRequestTracker = regressionActiveRequestTracker;
        this.regressionSharedAdminLoginGuard = regressionSharedAdminLoginGuard;
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
        applySessionTimeout(session);
        return normalizedUsername;
    }

    public boolean isAuthenticated() {
        return optionalCurrentUsername() != null;
    }

    public int currentSessionGeneration() {
        var username = currentUsername();
        var request = currentRequest();
        var session = request == null ? null : request.getSession(false);
        var generation = session == null ? null : session.getAttribute(SESSION_GENERATION);
        if (!(generation instanceof Number number)
            || !isCurrentSessionGeneration(username, number.intValue())) {
            invalidateCurrentRequestSession();
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "会话代际已失效，请重新登录");
        }
        return number.intValue();
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

    public String currentUserId() {
        return userIdByUsername(currentUsername());
    }

    public List<Map<String, Object>> availableAccountSets() {
        var username = optionalCurrentUsername();
        if (username == null) {
            return enabledAccountSets();
        }
        var userId = userIdByUsername(username);
        if (canAccessAllAccountSets(userId)) {
            return enabledAccountSets();
        }
        return authorizedAccountSets(userId);
    }

    private List<Map<String, Object>> enabledAccountSets() {
        return jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   code,
                   name,
                   environment,
                   COALESCE(database_name, '') AS "databaseName",
                   COALESCE(schema_name, '') AS "schemaName",
                   COALESCE(attachment_prefix, '') AS "attachmentPrefix",
                   COALESCE(redis_key_prefix, '') AS "redisKeyPrefix",
                   accounting_period AS "accountingPeriod",
                   business_period AS "businessPeriod",
                   enabled,
                   initialized
            FROM sys_account_set
            WHERE enabled = TRUE
            ORDER BY created_at, code
            """);
    }

    public Map<String, Object> currentAccountSet() {
        return accountSetById(currentAccountSetId());
    }

    public String currentAccountSetId() {
        var accountSetId = optionalCurrentAccountSetId();
        if (accountSetId != null && !accountSetId.isBlank()) {
            var username = optionalCurrentUsername();
            if (username == null) {
                return accountSetId;
            }
            var userId = userIdByUsername(username);
            if (canAccessAccountSetId(userId, accountSetId)) {
                return accountSetId;
            }
            return String.valueOf(resolveAuthorizedDefaultAccountSet(userId).get("id"));
        }
        var username = optionalCurrentUsername();
        if (username != null) {
            return String.valueOf(resolveAuthorizedDefaultAccountSet(userIdByUsername(username)).get("id"));
        }
        return defaultAccountSetId();
    }

    public String currentAccountSetCode() {
        return String.valueOf(currentAccountSet().get("code"));
    }

    public void switchAccountSet(String accountSetCode) {
        var userId = currentUserId();
        var accountSet = accountSetByCode(accountSetCode);
        assertCanAccessAccountSet(userId, String.valueOf(accountSet.get("id")));
        var request = currentRequest();
        if (request == null) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "无法切换当前账套");
        }
        var session = request.getSession(false);
        if (session == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "请先登录");
        }
        var scopeToken = platformTransactions.execute(ignored -> {
            var rotatedScopeToken = rotatePersistedAccountScope(session, userId, accountSet);
            logSetting("SWITCH_ACCOUNT_SET", "account_set=" + accountSet.get("code"));
            return rotatedScopeToken;
        });
        if (scopeToken == null) {
            throw new IllegalStateException("账套作用域事务没有返回令牌");
        }
        // The database row is the security authority. Publish the request snapshot only after commit.
        setSessionAccountSet(session, accountSet, scopeToken);
    }

    private String optionalCurrentAccountSetId() {
        var request = currentRequest();
        if (request == null) {
            return null;
        }
        var session = request.getSession(false);
        if (session == null) {
            return null;
        }
        var accountSetId = session.getAttribute(SESSION_ACCOUNT_SET_ID);
        return accountSetId == null ? null : String.valueOf(accountSetId);
    }

    public String currentDisplayName() {
        return String.valueOf(currentUser().get("name"));
    }

    public boolean requiresRegressionFixtureFence(HttpServletRequest request) {
        return regressionSharedAdminLoginGuard.isSharedAdminLoginGuardActive(request);
    }

    public void login(String username) {
        login(username, null, null);
    }

    public void login(String username, String password) {
        login(username, password, null);
    }

    public void login(String username, String password, String accountSetCode) {
        var normalizedUsername = username == null ? "" : username.trim();
        var request = currentRequest();
        regressionSharedAdminLoginGuard.rejectSharedAdminSessionReplacement(
            normalizedUsername,
            request
        );
        var sharedAdminLoginLease = regressionSharedAdminLoginGuard.beginSharedAdminLogin(
            normalizedUsername,
            request
        );
        if (sharedAdminLoginLease != null) {
            regressionActiveRequestTracker.trackRequiredLease(request, sharedAdminLoginLease);
        }
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
            logAnonymousLogin("LOGIN", null, "用户不存在或已停用");
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "用户不存在或已停用");
        }
        var userId = String.valueOf(rows.get(0).get("id"));
        if (request != null) {
            try {
                regressionActiveRequestTracker.trackRegisteredIdentity(
                    request,
                    UUID.fromString(userId),
                    RegressionActiveRequestTracker.isFixtureUsername(normalizedUsername)
                        && regressionSharedAdminLoginGuard.isSharedAdminLoginGuardActive(request),
                    Number.class.cast(rows.getFirst().get("sessionGeneration")).longValue()
                );
            } catch (RuntimeException | Error exception) {
                invalidateCurrentRequestSessionIfFixture(normalizedUsername);
                throw exception;
            }
        }
        completeLogin(rows.getFirst(), normalizedUsername, password, accountSetCode, userId);
    }

    private void completeLogin(
        Map<String, Object> user,
        String normalizedUsername,
        String password,
        String accountSetCode,
        String userId
    ) {
        if (isLocked(user.get("lockedUntil"))) {
            logAnonymousLogin("LOGIN_LOCKED", userId, "账号已锁定");
            throw new ResponseStatusException(HttpStatus.LOCKED, "账号已锁定，请稍后再试");
        }
        var passwordHash = String.valueOf(user.get("passwordHash"));
        if (!passwordHash.isBlank()) {
            var expected = passwordHash.startsWith("{noop}") ? passwordHash.substring("{noop}".length()) : passwordHash;
            if (password == null || !expected.equals(password)) {
                var failedCount = Number.class.cast(user.get("failedLoginCount")).intValue() + 1;
                if (failedCount >= MAX_FAILED_LOGIN) {
                    jdbcTemplate.update("""
                        UPDATE sys_user
                        SET failed_login_count = ?,
                            locked_until = now() + interval '15 minutes',
                            updated_at = now(),
                            version = version + 1
                        WHERE id = ?::uuid
                        """, failedCount, userId);
                    logAnonymousLogin("LOGIN_LOCKED", userId, "连续登录失败，账号锁定 15 分钟");
                    throw new ResponseStatusException(HttpStatus.LOCKED, "连续登录失败，账号已锁定 15 分钟");
                }
                jdbcTemplate.update("""
                    UPDATE sys_user
                    SET failed_login_count = ?,
                        updated_at = now(),
                        version = version + 1
                    WHERE id = ?::uuid
                    """, failedCount, userId);
                logAnonymousLogin("LOGIN", userId, "用户名或密码错误");
                throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "用户名或密码错误");
            }
        }
        var request = currentRequest();
        if (request == null) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "无法创建本地会话");
        }
        var newSessionToken = UUID.randomUUID().toString();
        var oldSessionToken = user.get("activeSessionToken");
        var sessionGeneration = Number.class.cast(user.get("sessionGeneration")).intValue();
        var singleActiveSession = isSingleActiveSessionPolicy();
        var accountSet = resolveLoginAccountSet(accountSetCode, userId);
        var scopeToken = UUID.randomUUID().toString();
        platformTransactions.executeWithoutResult(ignored -> {
            if (singleActiveSession) {
                var updated = jdbcTemplate.update("""
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
                      AND enabled = TRUE
                      AND session_generation = ?
                    """, newSessionToken, newSessionToken, userId, sessionGeneration);
                if (updated != 1) {
                    throw new ResponseStatusException(HttpStatus.LOCKED, "用户已停用或会话代际已失效");
                }
                jdbcTemplate.update("DELETE FROM sys_session_account_scope WHERE user_id = ?::uuid", userId);
            } else {
                var updated = jdbcTemplate.update("""
                    UPDATE sys_user
                    SET failed_login_count = 0,
                        locked_until = NULL,
                        last_login_at = now(),
                        active_session_token = ?,
                        active_session_started_at = now(),
                        updated_at = now(),
                        version = version + 1
                    WHERE id = ?::uuid
                      AND enabled = TRUE
                      AND session_generation = ?
                    """, newSessionToken, userId, sessionGeneration);
                if (updated != 1) {
                    throw new ResponseStatusException(HttpStatus.LOCKED, "用户已停用或会话代际已失效");
                }
            }
            jdbcTemplate.update("""
                INSERT INTO sys_session_account_scope (
                    session_token, user_id, account_set_id, scope_token
                )
                VALUES (?::uuid, ?::uuid, ?::uuid, ?::uuid)
                """, newSessionToken, userId, accountSet.get("id"), scopeToken);
        });
        var session = request.getSession(true);
        applySessionTimeout(session);
        session.setAttribute(SESSION_USERNAME, normalizedUsername);
        session.setAttribute(SESSION_TOKEN, newSessionToken);
        session.setAttribute(SESSION_GENERATION, sessionGeneration);
        setSessionAccountSet(session, accountSet, scopeToken);
        if (singleActiveSession && oldSessionToken != null && !String.valueOf(oldSessionToken).isBlank()) {
            logUserLogin("LOGIN_REPLACED", userId, "重复登录，新会话已替换旧会话");
        }
        logUserLogin("LOGIN", userId, null);
    }

    public void verifyCurrentPassword(String password) {
        verifyPassword(currentUsername(), password);
    }

    public void verifyPassword(String username, String password) {
        var request = currentRequest();
        var sharedAdminCredentialLease = regressionSharedAdminLoginGuard.beginSharedAdminLogin(username, request);
        if (sharedAdminCredentialLease != null) {
            regressionActiveRequestTracker.trackRequiredLease(request, sharedAdminCredentialLease);
        }
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

    @Transactional(transactionManager = "platformTransactionManager")
    public void changeCurrentPassword(String newPassword) {
        var username = currentUsername();
        var userId = currentUserId();
        var beforeGeneration = jdbcTemplate.queryForObject(
            "SELECT session_generation FROM sys_user WHERE id = ?::uuid",
            Integer.class,
            userId
        );
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
            operationLogFailureService.logPlatformOnce(OperationLogCommand.failure(
                "SYSTEM",
                "CHANGE_OWN_PASSWORD",
                "sys_user",
                UUID.fromString(userId),
                username,
                OperationLogCommand.ActorMode.CURRENT_USER,
                null,
                OperationLogCommand.state(OperationLogCommand.StateField.SESSION_GENERATION, beforeGeneration),
                Map.of(),
                "当前用户不存在或已停用"
            ));
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "当前用户不存在或已停用");
        }
        jdbcTemplate.update("DELETE FROM sys_session_account_scope WHERE user_id = ?::uuid", userId);
        operationLogService.logPlatform(OperationLogCommand.success(
            "SYSTEM",
            "CHANGE_OWN_PASSWORD",
            "sys_user",
            UUID.fromString(userId),
            username,
            OperationLogCommand.ActorMode.CURRENT_USER,
            null,
            OperationLogCommand.state(OperationLogCommand.StateField.SESSION_GENERATION, beforeGeneration),
            OperationLogCommand.state(OperationLogCommand.StateField.SESSION_GENERATION, beforeGeneration == null ? null : beforeGeneration + 1),
            null
        ));
    }

    public void logCurrentPasswordChangeFailure(String reason) {
        var username = currentUsername();
        var userId = currentUserId();
        var before = jdbcTemplate.queryForMap("""
            SELECT session_generation AS "sessionGeneration",
                   (locked_until IS NOT NULL AND locked_until > now()) AS locked
            FROM sys_user
            WHERE id = ?::uuid
            """, userId);
        operationLogFailureService.logPlatformOnce(OperationLogCommand.failure(
            "SYSTEM",
            "CHANGE_OWN_PASSWORD",
            "sys_user",
            UUID.fromString(userId),
            username,
            OperationLogCommand.ActorMode.CURRENT_USER,
            null,
            OperationLogCommand.state(
                OperationLogCommand.StateField.SESSION_GENERATION, before.get("sessionGeneration"),
                OperationLogCommand.StateField.LOCKED, before.get("locked")
            ),
            Map.of(),
            reason == null || reason.isBlank() ? "修改本人密码失败" : reason
        ));
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
                deletePersistedAccountScope(String.valueOf(sessionToken));
            }
            session.invalidate();
        }
    }

    void invalidateCurrentRequestSession() {
        var request = currentRequest();
        if (request == null) {
            return;
        }
        try {
            var session = request.getSession(false);
            if (session != null) {
                session.invalidate();
            }
        } catch (IllegalStateException ignored) {
            // The session is already invalid and SessionRepositoryFilter will persist its deletion.
        }
    }

    void invalidateCurrentRequestSessionIfFixture(String expectedUsername) {
        if (!RegressionActiveRequestTracker.isFixtureUsername(expectedUsername)) {
            return;
        }
        var request = currentRequest();
        if (request == null) {
            return;
        }
        try {
            var session = request.getSession(false);
            if (session == null) {
                return;
            }
            var loadedUsername = session.getAttribute(SESSION_USERNAME);
            if (loadedUsername != null
                && expectedUsername.equalsIgnoreCase(String.valueOf(loadedUsername).trim())) {
                session.invalidate();
            }
        } catch (IllegalStateException ignored) {
            // The matching fixture session was already invalidated by the fence path.
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
        logSetting("UPDATE_SECURITY_SETTING", "repeated_login_policy=" + normalizedPolicy);
    }

    public int sessionTimeoutMinutes() {
        var values = jdbcTemplate.queryForList("""
            SELECT setting_value
            FROM sys_setting
            WHERE setting_key = ?
            """, String.class, SESSION_TIMEOUT_MINUTES_KEY);
        if (values.isEmpty()) {
            return DEFAULT_SESSION_TIMEOUT_MINUTES;
        }
        return normalizeSessionTimeoutMinutes(values.get(0));
    }

    public int currentSessionMaxInactiveIntervalSeconds() {
        var request = currentRequest();
        if (request == null) {
            return sessionTimeoutMinutes() * 60;
        }
        var session = request.getSession(false);
        if (session == null) {
            return sessionTimeoutMinutes() * 60;
        }
        return session.getMaxInactiveInterval();
    }

    public void updateSessionTimeoutMinutes(Integer minutes) {
        var normalizedMinutes = normalizeSessionTimeoutMinutes(minutes);
        jdbcTemplate.update("""
            INSERT INTO sys_setting (setting_key, setting_value, updated_by)
            VALUES (?, ?, (SELECT id FROM sys_user WHERE username = ?))
            ON CONFLICT (setting_key) DO UPDATE
            SET setting_value = EXCLUDED.setting_value,
                updated_at = now(),
                updated_by = EXCLUDED.updated_by,
                version = sys_setting.version + 1
            """, SESSION_TIMEOUT_MINUTES_KEY, String.valueOf(normalizedMinutes), currentUsername());
        applySessionTimeoutToCurrentSession(normalizedMinutes);
        logSetting("UPDATE_SECURITY_SETTING", "session_timeout_minutes=" + normalizedMinutes);
    }

    private void applySessionTimeoutToCurrentSession(int minutes) {
        var request = currentRequest();
        if (request == null) {
            return;
        }
        var session = request.getSession(false);
        if (session != null) {
            session.setMaxInactiveInterval(minutes * 60);
        }
    }

    private void applySessionTimeout(jakarta.servlet.http.HttpSession session) {
        session.setMaxInactiveInterval(sessionTimeoutMinutes() * 60);
    }

    void setSessionAccountSet(jakarta.servlet.http.HttpSession session, Map<String, Object> accountSet) {
        setSessionAccountSet(session, accountSet, UUID.randomUUID().toString());
    }

    private void setSessionAccountSet(
        jakarta.servlet.http.HttpSession session,
        Map<String, Object> accountSet,
        String scopeToken
    ) {
        synchronized (session) {
            session.setAttribute(SESSION_ACCOUNT_SET_ID, String.valueOf(accountSet.get("id")));
            session.setAttribute(SESSION_ACCOUNT_SET_CODE, String.valueOf(accountSet.get("code")));
            session.setAttribute(SESSION_ACCOUNT_SET_SCOPE_TOKEN, scopeToken);
        }
    }

    private String rotatePersistedAccountScope(
        jakarta.servlet.http.HttpSession session,
        String userId,
        Map<String, Object> accountSet
    ) {
        var sessionToken = requiredSessionUuid(session, SESSION_TOKEN, "当前会话令牌已失效");
        var scopeToken = UUID.randomUUID().toString();
        var updated = jdbcTemplate.update("""
            UPDATE sys_session_account_scope
            SET account_set_id = ?::uuid,
                scope_token = ?::uuid,
                updated_at = now(),
                version = version + 1
            WHERE session_token = ?::uuid
              AND user_id = ?::uuid
            """, accountSet.get("id"), scopeToken, sessionToken, userId);
        if (updated != 1) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "当前会话账套作用域已失效，请重新登录");
        }
        return scopeToken;
    }

    private String requiredSessionUuid(
        jakarta.servlet.http.HttpSession session,
        String attributeName,
        String message
    ) {
        var value = session.getAttribute(attributeName);
        if (value == null || String.valueOf(value).isBlank()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, message);
        }
        try {
            return UUID.fromString(String.valueOf(value)).toString();
        } catch (IllegalArgumentException exception) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, message, exception);
        }
    }

    private void deletePersistedAccountScope(String sessionToken) {
        try {
            jdbcTemplate.update(
                "DELETE FROM sys_session_account_scope WHERE session_token = ?::uuid",
                UUID.fromString(sessionToken).toString()
            );
        } catch (IllegalArgumentException ignored) {
            // A malformed legacy session is invalidated below and must not select another row.
        }
    }

    private Map<String, Object> resolveLoginAccountSet(String accountSetCode, String userId) {
        var normalizedCode = accountSetCode == null ? "" : accountSetCode.trim();
        if (normalizedCode.isBlank()) {
            return resolveAuthorizedDefaultAccountSet(userId);
        }
        var accountSet = accountSetByCode(normalizedCode);
        assertCanAccessAccountSet(userId, String.valueOf(accountSet.get("id")));
        return accountSet;
    }

    private Map<String, Object> accountSetByCode(String accountSetCode) {
        var normalizedCode = accountSetCode == null ? "" : accountSetCode.trim();
        if (normalizedCode.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "请选择账套");
        }
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   code,
                   name,
                   environment,
                   COALESCE(database_name, '') AS "databaseName",
                   COALESCE(schema_name, '') AS "schemaName",
                   COALESCE(attachment_prefix, '') AS "attachmentPrefix",
                   COALESCE(redis_key_prefix, '') AS "redisKeyPrefix",
                   accounting_period AS "accountingPeriod",
                   business_period AS "businessPeriod",
                   enabled,
                   initialized
            FROM sys_account_set
            WHERE code = ?
              AND enabled = TRUE
            LIMIT 1
            """, normalizedCode);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "账套不存在或已停用");
        }
        return rows.get(0);
    }

    private Map<String, Object> accountSetById(String accountSetId) {
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   code,
                   name,
                   environment,
                   COALESCE(database_name, '') AS "databaseName",
                   COALESCE(schema_name, '') AS "schemaName",
                   COALESCE(attachment_prefix, '') AS "attachmentPrefix",
                   COALESCE(redis_key_prefix, '') AS "redisKeyPrefix",
                   accounting_period AS "accountingPeriod",
                   business_period AS "businessPeriod",
                   enabled,
                   initialized
            FROM sys_account_set
            WHERE id = ?::uuid
              AND enabled = TRUE
            LIMIT 1
            """, accountSetId);
        if (rows.isEmpty()) {
            return accountSetById(defaultAccountSetId());
        }
        return rows.get(0);
    }

    private String userIdByUsername(String username) {
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id
            FROM sys_user
            WHERE username = ?
              AND enabled = TRUE
            """, username);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "当前用户不存在或已停用");
        }
        return String.valueOf(rows.get(0).get("id"));
    }

    private Map<String, Object> resolveAuthorizedDefaultAccountSet(String userId) {
        if (canAccessAllAccountSets(userId)) {
            var rows = defaultAccountSetRows(userId);
            if (!rows.isEmpty()) {
                return rows.get(0);
            }
        }
        var rows = authorizedAccountSets(userId);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "当前用户未授权任何可用账套");
        }
        return rows.get(0);
    }

    private List<Map<String, Object>> defaultAccountSetRows(String userId) {
        return jdbcTemplate.queryForList("""
            SELECT a.id::text AS id,
                   a.code,
                   a.name,
                   a.environment,
                   COALESCE(a.database_name, '') AS "databaseName",
                   COALESCE(a.schema_name, '') AS "schemaName",
                   COALESCE(a.attachment_prefix, '') AS "attachmentPrefix",
                   COALESCE(a.redis_key_prefix, '') AS "redisKeyPrefix",
                   a.accounting_period AS "accountingPeriod",
                   a.business_period AS "businessPeriod",
                   a.enabled,
                   a.initialized
            FROM sys_account_set a
            LEFT JOIN sys_user u ON u.default_account_set_id = a.id AND u.id = ?::uuid
            WHERE a.enabled = TRUE
            ORDER BY CASE WHEN u.id IS NULL THEN 1 ELSE 0 END, a.created_at, a.code
            LIMIT 1
            """, userId);
    }

    private List<Map<String, Object>> authorizedAccountSets(String userId) {
        return jdbcTemplate.queryForList("""
            SELECT a.id::text AS id,
                   a.code,
                   a.name,
                   a.environment,
                   COALESCE(a.database_name, '') AS "databaseName",
                   COALESCE(a.schema_name, '') AS "schemaName",
                   COALESCE(a.attachment_prefix, '') AS "attachmentPrefix",
                   COALESCE(a.redis_key_prefix, '') AS "redisKeyPrefix",
                   a.accounting_period AS "accountingPeriod",
                   a.business_period AS "businessPeriod",
                   a.enabled,
                   a.initialized
            FROM sys_user_account_set uas
            JOIN sys_account_set a ON a.id = uas.account_set_id
            LEFT JOIN sys_user u ON u.id = uas.user_id
            WHERE uas.user_id = ?::uuid
              AND uas.enabled = TRUE
              AND a.enabled = TRUE
            ORDER BY CASE WHEN uas.is_default = TRUE THEN 0 ELSE 1 END,
                     CASE WHEN u.default_account_set_id = a.id THEN 0 ELSE 1 END,
                     a.created_at,
                     a.code
            """, userId);
    }

    private void assertCanAccessAccountSet(String userId, String accountSetId) {
        if (!canAccessAccountSetId(userId, accountSetId)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "无权进入该账套");
        }
    }

    private boolean canAccessAccountSetId(String userId, String accountSetId) {
        if (canAccessAllAccountSets(userId)) {
            return true;
        }
        var counts = jdbcTemplate.queryForList("""
            SELECT count(*)::int
            FROM sys_user_account_set uas
            JOIN sys_account_set a ON a.id = uas.account_set_id
            WHERE uas.user_id = ?::uuid
              AND uas.account_set_id = ?::uuid
              AND uas.enabled = TRUE
              AND a.enabled = TRUE
            """, Integer.class, userId, accountSetId);
        return !counts.isEmpty() && counts.get(0) > 0;
    }

    private boolean canAccessAllAccountSets(String userId) {
        var counts = jdbcTemplate.queryForList("""
            SELECT count(*)::int
            FROM sys_user_role ur
            JOIN sys_role r ON r.id = ur.role_id
            LEFT JOIN sys_permission p
              ON p.role_id = r.id
             AND p.permission_code = 'system.account_set.manage'
             AND p.enabled = TRUE
            LEFT JOIN sys_permission_catalog c
              ON c.permission_code = p.permission_code
            WHERE ur.user_id = ?::uuid
              AND r.enabled = TRUE
              AND (r.code = 'ADMIN' OR (p.id IS NOT NULL AND COALESCE(c.enabled, TRUE) = TRUE))
            """, Integer.class, userId);
        return !counts.isEmpty() && counts.get(0) > 0;
    }

    private String defaultAccountSetId() {
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id
            FROM sys_account_set
            WHERE enabled = TRUE
            ORDER BY created_at, code
            LIMIT 1
            """);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "未配置可用账套");
        }
        return String.valueOf(rows.get(0).get("id"));
    }

    private int normalizeSessionTimeoutMinutes(Object rawMinutes) {
        int minutes;
        try {
            if (rawMinutes instanceof Number number) {
                minutes = number.intValue();
            } else {
                minutes = Integer.parseInt(String.valueOf(rawMinutes).trim());
            }
        } catch (RuntimeException exception) {
            minutes = DEFAULT_SESSION_TIMEOUT_MINUTES;
        }
        if (minutes < MIN_SESSION_TIMEOUT_MINUTES || minutes > MAX_SESSION_TIMEOUT_MINUTES) {
            throw new ResponseStatusException(
                HttpStatus.BAD_REQUEST,
                "会话超时分钟数需在 " + MIN_SESSION_TIMEOUT_MINUTES + "-" + MAX_SESSION_TIMEOUT_MINUTES + " 之间"
            );
        }
        return minutes;
    }

    private void logSetting(String action, String reason) {
        operationLogService.logPlatform(OperationLogCommand.success(
            "SYSTEM",
            action,
            "sys_setting",
            null,
            null,
            OperationLogCommand.ActorMode.CURRENT_USER,
            null,
            Map.of(),
            Map.of(),
            reason
        ));
    }

    private void logAnonymousLogin(String action, String targetUserId, String reason) {
        operationLogFailureService.logPlatformOnce(OperationLogCommand.failure(
            "SYSTEM",
            action,
            "sys_user",
            targetUserId == null ? null : UUID.fromString(targetUserId),
            null,
            OperationLogCommand.ActorMode.ANONYMOUS,
            null,
            Map.of(),
            Map.of(),
            reason
        ));
    }

    private void logUserLogin(String action, String targetUserId, String reason) {
        operationLogService.logPlatform(OperationLogCommand.success(
            "SYSTEM",
            action,
            "sys_user",
            UUID.fromString(targetUserId),
            null,
            OperationLogCommand.ActorMode.CURRENT_USER,
            null,
            Map.of(),
            Map.of(),
            reason
        ));
    }
}
