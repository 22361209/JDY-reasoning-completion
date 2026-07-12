package com.jdy.erp.system.api;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;

import com.jdy.erp.system.application.NotificationProviderService;
import com.jdy.erp.system.application.PasswordResetRequestService;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.security.PasswordPolicy;
import com.jdy.erp.system.security.RequirePermission;
import com.jdy.erp.system.security.WriteAccess;
import com.jdy.erp.system.security.WriteAccess.Policy;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Qualifier;
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
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/system")
public class UserManagementController {
    private static final Map<String, Object> PASSWORD_RESET_REQUEST_RESPONSE = Map.of(
        "ok", true,
        "message", "已提交找回申请，请联系管理员完成身份核验和密码重置。"
    );

    private final JdbcTemplate jdbcTemplate;
    private final CurrentSessionService currentSessionService;
    private final PasswordPolicy passwordPolicy;
    private final NotificationProviderService notificationProviderService;
    private final PasswordResetRequestService passwordResetRequestService;

    public UserManagementController(
        @Qualifier("platformJdbcTemplate") JdbcTemplate jdbcTemplate,
        CurrentSessionService currentSessionService,
        PasswordPolicy passwordPolicy,
        NotificationProviderService notificationProviderService,
        PasswordResetRequestService passwordResetRequestService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.currentSessionService = currentSessionService;
        this.passwordPolicy = passwordPolicy;
        this.notificationProviderService = notificationProviderService;
        this.passwordResetRequestService = passwordResetRequestService;
    }

    @GetMapping("/managed-users")
    @RequirePermission("system.role_permission.manage")
    public Map<String, Object> managedUsers() {
        return Map.of(
            "users", userRows(),
            "roles", roleRows(),
            "accountSets", accountSetRows(),
            "passwordResetRequests", passwordResetRequestRows(),
            "notificationOutbox", notificationRows("")
        );
    }

    @GetMapping("/notification-outbox")
    @RequirePermission("system.role_permission.manage")
    public Map<String, Object> notificationOutbox(@RequestParam(name = "status", required = false) String status) {
        return Map.of("notificationOutbox", notificationRows(status));
    }

    @PutMapping("/notification-outbox/{notificationId}/resend")
    @RequirePermission("system.role_permission.manage")
    @Transactional(transactionManager = "platformTransactionManager")
    public Map<String, Object> resendNotification(@PathVariable String notificationId) {
        var normalizedNotificationId = required(notificationId, "通知ID");
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   recipient_username AS "recipientUsername",
                   status
            FROM sys_notification_outbox
            WHERE id = ?::uuid
            """, normalizedNotificationId);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "通知不存在");
        }
        var providerCode = notificationProviderService.currentProviderCode();
        jdbcTemplate.update("""
            UPDATE sys_notification_outbox
            SET status = 'SENT',
                provider = ?,
                retry_count = retry_count + 1,
                last_attempt_at = now(),
                sent_at = now(),
                failure_reason = NULL,
                provider_receipt_status = NULL,
                provider_receipt_at = NULL,
                provider_message_id = ? || '-' || replace(id::text, '-', '')
            WHERE id = ?::uuid
            """, providerCode, providerCode, normalizedNotificationId);
        log("SYSTEM", "RESEND_NOTIFICATION", "sys_notification_outbox", normalizedNotificationId, true, "重发给 " + rows.get(0).get("recipientUsername"));
        return Map.of("notificationOutbox", notificationRows(""));
    }

    @PutMapping("/notification-outbox/{notificationId}/receipt")
    @RequirePermission("system.role_permission.manage")
    @Transactional(transactionManager = "platformTransactionManager")
    public Map<String, Object> syncNotificationReceipt(@PathVariable String notificationId, @RequestBody NotificationReceiptRequest request) {
        var normalizedNotificationId = required(notificationId, "通知ID");
        var receiptStatus = required(request.providerReceiptStatus(), "回执状态").toUpperCase();
        if (!List.of("DELIVERED", "FAILED", "BOUNCED").contains(receiptStatus)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "回执状态只能是 DELIVERED、FAILED 或 BOUNCED");
        }
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   recipient_username AS "recipientUsername"
            FROM sys_notification_outbox
            WHERE id = ?::uuid
            """, normalizedNotificationId);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "通知不存在");
        }
        var nextStatus = "DELIVERED".equals(receiptStatus) ? "SENT" : "FAILED";
        var providerMessageId = optionalLimited(request.providerMessageId(), 160);
        var failureReason = "DELIVERED".equals(receiptStatus)
            ? null
            : optionalLimited(request.failureReason(), 240);
        if (!"DELIVERED".equals(receiptStatus) && (failureReason == null || failureReason.isBlank())) {
            failureReason = "供应商回执：" + receiptStatus;
        }
        jdbcTemplate.update("""
            UPDATE sys_notification_outbox
            SET status = ?,
                provider_message_id = COALESCE(NULLIF(?, ''), provider_message_id, provider || '-' || replace(id::text, '-', '')),
                provider_receipt_status = ?,
                provider_receipt_at = now(),
                failure_reason = ?,
                sent_at = CASE WHEN ? = 'SENT' THEN COALESCE(sent_at, now()) ELSE sent_at END
            WHERE id = ?::uuid
            """, nextStatus, providerMessageId, receiptStatus, failureReason, nextStatus, normalizedNotificationId);
        log("SYSTEM", "SYNC_NOTIFICATION_RECEIPT", "sys_notification_outbox", normalizedNotificationId, true, receiptStatus + "：" + rows.get(0).get("recipientUsername"));
        return Map.of("notificationOutbox", notificationRows(""));
    }

    @PostMapping("/password-reset-requests")
    @WriteAccess(Policy.REQUEST_PASSWORD_RESET)
    public Map<String, Object> requestPasswordReset(
        @RequestBody PasswordResetRequest request,
        HttpServletRequest servletRequest
    ) {
        var username = requiredLimited(request.username(), "用户名", 80);
        var contactNote = optionalStrictLimited(request.contactNote(), "联系方式/说明", 240);
        passwordResetRequestService.submit(username, contactNote, servletRequest.getRemoteAddr());
        return PASSWORD_RESET_REQUEST_RESPONSE;
    }

    @PostMapping("/managed-users")
    @RequirePermission("system.role_permission.manage")
    @Transactional(transactionManager = "platformTransactionManager")
    public Map<String, Object> createUser(@RequestBody UserRequest request) {
        var username = required(request.username(), "用户名");
        var displayName = required(request.displayName(), "姓名");
        var roleCode = required(request.roleCode(), "角色");
        var password = required(request.password(), "初始密码");
        passwordPolicy.validate(password);
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
            saveUserAccountSetGrants(String.valueOf(user.get("id")), request.accountSetCodes(), request.defaultAccountSetCode());
        } catch (DuplicateKeyException ex) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "用户名已存在");
        }
        return managedUsers();
    }

    @PutMapping("/managed-users/{username}")
    @RequirePermission("system.role_permission.manage")
    @Transactional(transactionManager = "platformTransactionManager")
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
        if (request.accountSetCodes() != null || request.defaultAccountSetCode() != null) {
            saveUserAccountSetGrants(userId, request.accountSetCodes(), request.defaultAccountSetCode());
        }
        return managedUsers();
    }

    @PutMapping("/managed-users/{username}/account-sets")
    @RequirePermission("system.role_permission.manage")
    @Transactional(transactionManager = "platformTransactionManager")
    public Map<String, Object> saveUserAccountSets(@PathVariable String username, @RequestBody AccountSetGrantRequest request) {
        var normalizedUsername = required(username, "用户名");
        var userId = userId(normalizedUsername);
        saveUserAccountSetGrants(userId, request.accountSetCodes(), request.defaultAccountSetCode());
        log("SYSTEM", "SAVE_USER_ACCOUNT_SETS", "sys_user", userId, true, null);
        return managedUsers();
    }

    @PutMapping("/managed-users/{username}/password")
    @RequirePermission("system.role_permission.manage")
    @Transactional(transactionManager = "platformTransactionManager")
    public Map<String, Object> resetPassword(@PathVariable String username, @RequestBody PasswordRequest request) {
        var normalizedUsername = required(username, "用户名");
        var password = required(request.password(), "新密码");
        passwordPolicy.validate(password);
        var userId = userId(normalizedUsername);
        var updated = jdbcTemplate.update("""
            UPDATE sys_user
            SET password_hash = ?,
                failed_login_count = 0,
                locked_until = NULL,
                active_session_token = NULL,
                active_session_started_at = NULL,
                last_session_replaced_at = now(),
                session_generation = session_generation + 1,
                updated_at = now(),
                version = version + 1
            WHERE id = ?::uuid
            """, "{noop}" + password, userId);
        if (updated == 0) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "用户不存在");
        }
        var pendingRequests = jdbcTemplate.queryForList("""
            UPDATE sys_password_reset_request
            SET status = 'DONE',
                handled_at = now(),
                handled_by = (SELECT id FROM sys_user WHERE username = ?),
                handle_note = '管理员已重置密码',
                version = version + 1
            WHERE requested_user_id = ?::uuid
              AND status = 'PENDING'
            RETURNING id::text AS id,
                      COALESCE(contact_note, '') AS "contactNote"
            """, currentSessionService.currentUsername(), userId);
        if (!pendingRequests.isEmpty()) {
            var resetRequest = pendingRequests.get(0);
            createNotification(
                userId,
                normalizedUsername,
                String.valueOf(resetRequest.get("contactNote")),
                "PASSWORD_RESET_DONE",
                "密码已重置",
                "管理员已完成身份核验并重置密码，请使用新密码登录后及时修改。",
                "sys_password_reset_request",
                String.valueOf(resetRequest.get("id"))
            );
        }
        log("SYSTEM", "RESET_PASSWORD", "sys_user", userId, true, null);
        return Map.of("ok", true);
    }

    @PutMapping("/password-reset-requests/{requestId}")
    @RequirePermission("system.role_permission.manage")
    @Transactional(transactionManager = "platformTransactionManager")
    public Map<String, Object> handlePasswordResetRequest(@PathVariable String requestId, @RequestBody PasswordResetHandleRequest request) {
        var normalizedRequestId = required(requestId, "申请ID");
        var status = required(request.status(), "处理状态").toUpperCase();
        if (!List.of("DONE", "REJECTED").contains(status)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "处理状态只能是 DONE 或 REJECTED");
        }
        var note = optionalLimited(request.note(), 240);
        var rows = jdbcTemplate.queryForList("""
            UPDATE sys_password_reset_request
            SET status = ?,
                handled_at = now(),
                handled_by = (SELECT id FROM sys_user WHERE username = ?),
                handle_note = ?,
                version = version + 1
            WHERE id = ?::uuid
              AND status = 'PENDING'
            RETURNING requested_user_id::text AS "requestedUserId",
                      username,
                      COALESCE(contact_note, '') AS "contactNote"
            """, status, currentSessionService.currentUsername(), note, normalizedRequestId);
        if (rows.isEmpty()) {
            var exists = jdbcTemplate.queryForObject(
                "SELECT EXISTS (SELECT 1 FROM sys_password_reset_request WHERE id = ?::uuid)",
                Boolean.class,
                normalizedRequestId
            );
            if (Boolean.TRUE.equals(exists)) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "找回申请已处理");
            }
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "找回申请不存在");
        }
        var targetUserId = rows.get(0).get("requestedUserId") == null ? null : String.valueOf(rows.get(0).get("requestedUserId"));
        if ("REJECTED".equals(status) && targetUserId != null) {
            createNotification(
                targetUserId,
                String.valueOf(rows.get(0).get("username")),
                String.valueOf(rows.get(0).get("contactNote")),
                "PASSWORD_RESET_REJECTED",
                "找回申请已驳回",
                "管理员未通过本次身份核验，请核对资料后重新提交找回申请。",
                "sys_password_reset_request",
                normalizedRequestId
            );
        }
        log("SYSTEM", "HANDLE_PASSWORD_RESET_REQUEST", "sys_user", targetUserId, true, status + (note == null || note.isBlank() ? "" : "：" + note));
        return managedUsers();
    }

    @PutMapping("/managed-users/{username}/unlock")
    @RequirePermission("system.role_permission.manage")
    public Map<String, Object> unlockUser(@PathVariable String username) {
        var normalizedUsername = required(username, "用户名");
        var userId = userId(normalizedUsername);
        jdbcTemplate.update("""
            UPDATE sys_user
            SET failed_login_count = 0,
                locked_until = NULL,
                updated_at = now(),
                version = version + 1
            WHERE id = ?::uuid
            """, userId);
        log("SYSTEM", "UNLOCK_USER", "sys_user", userId, true, null);
        return managedUsers();
    }

    @PutMapping("/password")
    @WriteAccess(Policy.CHANGE_OWN_PASSWORD)
    public Map<String, Object> changePassword(@RequestBody ChangePasswordRequest request) {
        var currentPassword = required(request.currentPassword(), "当前密码");
        var newPassword = required(request.newPassword(), "新密码");
        passwordPolicy.validate(newPassword);
        currentSessionService.verifyCurrentPassword(currentPassword);
        if (currentPassword.equals(newPassword)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "新密码不能与当前密码相同");
        }
        currentSessionService.changeCurrentPassword(newPassword);
        return Map.of("ok", true);
    }

    private List<Map<String, Object>> userRows() {
        return jdbcTemplate.queryForList("""
            SELECT u.id::text AS id,
                   u.username,
                   u.display_name AS "displayName",
                   r.code AS "roleCode",
                   r.name AS "roleName",
                   u.enabled,
                   u.failed_login_count AS "failedLoginCount",
                   CASE WHEN u.locked_until IS NOT NULL AND u.locked_until > now() THEN TRUE ELSE FALSE END AS locked,
                   COALESCE(to_char(u.locked_until, 'YYYY-MM-DD HH24:MI:SS'), '') AS "lockedUntil",
                   COALESCE(to_char(u.last_login_at, 'YYYY-MM-DD HH24:MI:SS'), '') AS "lastLoginAt",
                   CASE WHEN u.active_session_token IS NULL THEN FALSE ELSE TRUE END AS "activeSession",
                   COALESCE(to_char(u.active_session_started_at, 'YYYY-MM-DD HH24:MI:SS'), '') AS "activeSessionStartedAt",
                   COALESCE(to_char(u.last_session_replaced_at, 'YYYY-MM-DD HH24:MI:SS'), '') AS "lastSessionReplacedAt",
                   COALESCE(default_account_set.code, '') AS "defaultAccountSetCode",
                   COALESCE(string_agg(account_set.code, ',' ORDER BY account_set.created_at, account_set.code) FILTER (WHERE account_set.code IS NOT NULL), '') AS "accountSetCodes",
                   CASE WHEN EXISTS (
                       SELECT 1
                       FROM sys_password_reset_request pr
                       WHERE pr.requested_user_id = u.id
                         AND pr.status = 'PENDING'
                   ) THEN TRUE ELSE FALSE END AS "pendingPasswordReset"
            FROM sys_user u
            LEFT JOIN sys_user_role ur ON ur.user_id = u.id
            LEFT JOIN sys_role r ON r.id = ur.role_id
            LEFT JOIN sys_account_set default_account_set ON default_account_set.id = u.default_account_set_id
            LEFT JOIN sys_user_account_set uas ON uas.user_id = u.id AND uas.enabled = TRUE
            LEFT JOIN sys_account_set account_set ON account_set.id = uas.account_set_id AND account_set.enabled = TRUE
            GROUP BY u.id, u.username, u.display_name, r.code, r.name, u.enabled, u.failed_login_count,
                     u.locked_until, u.last_login_at, u.active_session_token, u.active_session_started_at,
                     u.last_session_replaced_at, default_account_set.code
            ORDER BY CASE r.code WHEN 'ADMIN' THEN 0 WHEN 'WAREHOUSE' THEN 1 WHEN 'FINANCE' THEN 2 ELSE 3 END, u.username
            """);
    }

    private List<Map<String, Object>> passwordResetRequestRows() {
        return jdbcTemplate.queryForList("""
            SELECT pr.id::text AS id,
                   pr.username,
                   COALESCE(u.display_name, '') AS "displayName",
                   COALESCE(pr.contact_note, '') AS "contactNote",
                   pr.status,
                   COALESCE(to_char(pr.requested_at, 'YYYY-MM-DD HH24:MI:SS'), '') AS "requestedAt",
                   COALESCE(to_char(pr.handled_at, 'YYYY-MM-DD HH24:MI:SS'), '') AS "handledAt",
                   COALESCE(handler.display_name, '') AS "handledBy",
                   COALESCE(pr.handle_note, '') AS "handleNote"
            FROM sys_password_reset_request pr
            LEFT JOIN sys_user u ON u.id = pr.requested_user_id
            LEFT JOIN sys_user handler ON handler.id = pr.handled_by
            ORDER BY CASE pr.status WHEN 'PENDING' THEN 0 ELSE 1 END, pr.requested_at DESC
            LIMIT 50
            """);
    }

    private List<Map<String, Object>> notificationRows(String status) {
        var normalizedStatus = status == null ? "" : status.trim().toUpperCase();
        if (!normalizedStatus.isBlank() && !List.of("PENDING", "SENT", "FAILED").contains(normalizedStatus)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "通知状态不正确");
        }
        var sql = """
            SELECT id::text AS id,
                   channel,
                   template_code AS "templateCode",
                   recipient_username AS "recipientUsername",
                   COALESCE(recipient_contact, '') AS "recipientContact",
                   title,
                   body,
                   COALESCE(source_type, '') AS "sourceType",
                   COALESCE(source_id::text, '') AS "sourceId",
                   status,
                   provider,
                   retry_count AS "retryCount",
                   COALESCE(to_char(last_attempt_at, 'YYYY-MM-DD HH24:MI:SS'), '') AS "lastAttemptAt",
                   COALESCE(failure_reason, '') AS "failureReason",
                   COALESCE(provider_receipt_status, '') AS "providerReceiptStatus",
                   COALESCE(to_char(provider_receipt_at, 'YYYY-MM-DD HH24:MI:SS'), '') AS "providerReceiptAt",
                   COALESCE(to_char(created_at, 'YYYY-MM-DD HH24:MI:SS'), '') AS "createdAt",
                   COALESCE(to_char(sent_at, 'YYYY-MM-DD HH24:MI:SS'), '') AS "sentAt"
            FROM sys_notification_outbox
            WHERE template_code LIKE 'PASSWORD_RESET_%'
              AND (? = '' OR status = ?)
            ORDER BY created_at DESC
            LIMIT 50
            """;
        return jdbcTemplate.queryForList(sql, normalizedStatus, normalizedStatus);
    }

    private List<Map<String, Object>> roleRows() {
        return jdbcTemplate.queryForList("""
            SELECT code, name, enabled
            FROM sys_role
            WHERE enabled = TRUE
            ORDER BY CASE code WHEN 'ADMIN' THEN 0 WHEN 'WAREHOUSE' THEN 1 WHEN 'FINANCE' THEN 2 ELSE 3 END, code
            """);
    }

    private List<Map<String, Object>> accountSetRows() {
        return jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   code,
                   name,
                   environment,
                   enabled,
                   initialized
            FROM sys_account_set
            WHERE enabled = TRUE
            ORDER BY created_at, code
            """);
    }

    private void saveUserAccountSetGrants(String userId, List<String> requestedAccountSetCodes, String requestedDefaultAccountSetCode) {
        var accountSetCodes = normalizeCodes(requestedAccountSetCodes);
        var defaultAccountSetCode = requestedDefaultAccountSetCode == null ? "" : requestedDefaultAccountSetCode.trim();
        if (accountSetCodes.isEmpty()) {
            if (!defaultAccountSetCode.isBlank()) {
                accountSetCodes.add(defaultAccountSetCode);
            } else {
                accountSetCodes.add(defaultAccountSetCode(userId));
            }
        }
        if (defaultAccountSetCode.isBlank() || !accountSetCodes.contains(defaultAccountSetCode)) {
            defaultAccountSetCode = accountSetCodes.get(0);
        }
        var knownAccountSets = accountSetIdsByCode(accountSetCodes);
        if (knownAccountSets.size() != accountSetCodes.size()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "包含不存在或已停用的账套");
        }
        var defaultAccountSetId = knownAccountSets.get(defaultAccountSetCode);
        if (defaultAccountSetId == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "默认账套必须在授权账套范围内");
        }
        var roleCode = roleCodeOfUser(userId);
        jdbcTemplate.update("""
            UPDATE sys_user_account_set
            SET enabled = FALSE,
                is_default = FALSE,
                updated_at = now(),
                version = version + 1
            WHERE user_id = ?::uuid
            """, userId);
        for (var accountSetCode : accountSetCodes) {
            jdbcTemplate.update("""
                INSERT INTO sys_user_account_set (user_id, account_set_id, role_code, is_default, enabled)
                VALUES (?::uuid, ?::uuid, ?, ?, TRUE)
                ON CONFLICT (user_id, account_set_id) DO UPDATE
                SET role_code = EXCLUDED.role_code,
                    is_default = EXCLUDED.is_default,
                    enabled = TRUE,
                    updated_at = now(),
                    version = sys_user_account_set.version + 1
                """, userId, knownAccountSets.get(accountSetCode), "ADMIN".equals(roleCode) ? "ADMIN" : "MEMBER", accountSetCode.equals(defaultAccountSetCode));
        }
        jdbcTemplate.update("""
            UPDATE sys_user
            SET default_account_set_id = ?::uuid,
                updated_at = now(),
                version = version + 1
            WHERE id = ?::uuid
            """, defaultAccountSetId, userId);
    }

    private ArrayList<String> normalizeCodes(List<String> rawCodes) {
        var normalized = new LinkedHashSet<String>();
        if (rawCodes != null) {
            for (var code : rawCodes) {
                if (code != null && !code.isBlank()) {
                    normalized.add(code.trim());
                }
            }
        }
        return new ArrayList<>(normalized);
    }

    private Map<String, String> accountSetIdsByCode(List<String> accountSetCodes) {
        var placeholders = String.join(", ", accountSetCodes.stream().map(code -> "?").toList());
        var rows = jdbcTemplate.queryForList("""
            SELECT code, id::text AS id
            FROM sys_account_set
            WHERE enabled = TRUE
              AND code IN (%s)
            """.formatted(placeholders), accountSetCodes.toArray());
        return rows.stream().collect(java.util.stream.Collectors.toMap(
            row -> String.valueOf(row.get("code")),
            row -> String.valueOf(row.get("id"))
        ));
    }

    private String defaultAccountSetCode(String userId) {
        var rows = jdbcTemplate.queryForList("""
            SELECT a.code
            FROM sys_account_set a
            LEFT JOIN sys_user u ON u.default_account_set_id = a.id AND u.id = ?::uuid
            WHERE a.enabled = TRUE
            ORDER BY CASE WHEN u.id IS NULL THEN 1 ELSE 0 END, a.created_at, a.code
            LIMIT 1
            """, userId);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "未配置可用账套");
        }
        return String.valueOf(rows.get(0).get("code"));
    }

    private String roleCodeOfUser(String userId) {
        var rows = jdbcTemplate.queryForList("""
            SELECT r.code
            FROM sys_user_role ur
            JOIN sys_role r ON r.id = ur.role_id
            WHERE ur.user_id = ?::uuid
              AND r.enabled = TRUE
            ORDER BY CASE r.code WHEN 'ADMIN' THEN 0 ELSE 1 END, r.code
            LIMIT 1
            """, userId);
        return rows.isEmpty() ? "MEMBER" : String.valueOf(rows.get(0).get("code"));
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

    private String requiredLimited(String value, String label, int maxLength) {
        var normalized = required(value, label);
        if (normalized.length() > maxLength) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不能超过" + maxLength + "个字符");
        }
        return normalized;
    }

    private String optionalStrictLimited(String value, String label, int maxLength) {
        if (value == null || value.isBlank()) {
            return "";
        }
        var normalized = value.trim();
        if (normalized.length() > maxLength) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不能超过" + maxLength + "个字符");
        }
        return normalized;
    }

    private String optionalLimited(String value, int maxLength) {
        if (value == null || value.isBlank()) {
            return "";
        }
        var normalized = value.trim();
        return normalized.length() > maxLength ? normalized.substring(0, maxLength) : normalized;
    }

    private void log(String module, String action, String targetType, String targetId, boolean success, String reason) {
        jdbcTemplate.update("""
            INSERT INTO sys_operation_log (module_code, action_code, target_type, target_id, success, failure_reason, operated_by)
            SELECT ?, ?, ?, ?::uuid, ?, ?, id
            FROM sys_user
            WHERE username = ?
            """, module, action, targetType, targetId, success, reason, currentSessionService.currentUsername());
    }

    private void createNotification(
        String recipientUserId,
        String recipientUsername,
        String recipientContact,
        String templateCode,
        String title,
        String body,
        String sourceType,
        String sourceId
    ) {
        var providerCode = notificationProviderService.currentProviderCode();
        jdbcTemplate.update("""
            INSERT INTO sys_notification_outbox (
                channel,
                template_code,
                recipient_user_id,
                recipient_username,
                recipient_contact,
                title,
                body,
                source_type,
                source_id,
                status,
                provider,
                provider_message_id,
                retry_count,
                last_attempt_at,
                sent_at
            )
            VALUES ('IN_APP', ?, ?::uuid, ?, ?, ?, ?, ?, ?::uuid, 'SENT', ?, ? || '-' || replace(gen_random_uuid()::text, '-', ''), 0, now(), now())
            """,
            templateCode,
            recipientUserId,
            recipientUsername,
            optionalLimited(recipientContact, 240),
            title,
            body,
            sourceType,
            sourceId,
            providerCode,
            providerCode
        );
        log("SYSTEM", "SEND_PASSWORD_RESET_NOTICE", "sys_notification_outbox", null, true, templateCode + "：" + recipientUsername);
    }

    public record UserRequest(
        String username,
        String displayName,
        String roleCode,
        String password,
        Boolean enabled,
        List<String> accountSetCodes,
        String defaultAccountSetCode
    ) {
    }

    public record AccountSetGrantRequest(List<String> accountSetCodes, String defaultAccountSetCode) {
    }

    public record PasswordRequest(String password) {
    }

    public record ChangePasswordRequest(String currentPassword, String newPassword) {
    }

    public record PasswordResetRequest(String username, String contactNote) {
    }

    public record PasswordResetHandleRequest(String status, String note) {
    }

    public record NotificationReceiptRequest(String providerReceiptStatus, String providerMessageId, String failureReason) {
    }
}
