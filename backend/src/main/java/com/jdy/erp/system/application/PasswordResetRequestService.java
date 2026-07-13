package com.jdy.erp.system.application;

import java.util.Map;
import java.util.UUID;

import com.jdy.erp.shared.application.OperationLogCommand;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.system.security.PasswordResetRateLimiter;
import com.jdy.erp.system.security.PasswordResetRequestProperties;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class PasswordResetRequestService {
    private static final long PENDING_GATE_LOCK = 0x4a445950525354L;

    private final JdbcTemplate jdbcTemplate;
    private final PasswordResetRateLimiter rateLimiter;
    private final PasswordResetRequestProperties properties;
    private final TransactionTemplate transactions;
    private final OperationLogService operationLogService;

    public PasswordResetRequestService(
        @Qualifier("platformJdbcTemplate") JdbcTemplate jdbcTemplate,
        PasswordResetRateLimiter rateLimiter,
        PasswordResetRequestProperties properties,
        @Qualifier("platformTransactionManager") PlatformTransactionManager transactionManager,
        OperationLogService operationLogService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.rateLimiter = rateLimiter;
        this.properties = properties;
        this.transactions = new TransactionTemplate(transactionManager);
        this.operationLogService = operationLogService;
    }

    public void submit(String username, String contactNote, String remoteAddress) {
        try {
            if (!rateLimiter.tryAcquire(remoteAddress, username)) {
                return;
            }
        } catch (RuntimeException ignored) {
            return;
        }

        var users = jdbcTemplate.queryForList("""
            SELECT id::text AS id
            FROM sys_user
            WHERE username = ?
              AND enabled = TRUE
            """, username);
        if (users.isEmpty()) {
            return;
        }
        var userId = String.valueOf(users.getFirst().get("id"));
        transactions.executeWithoutResult(ignored -> createPendingRequest(username, contactNote, userId));
    }

    private void createPendingRequest(String username, String contactNote, String expectedUserId) {
        acquirePendingGate();
        var users = jdbcTemplate.queryForList("""
            SELECT id::text AS id
            FROM sys_user
            WHERE id = ?::uuid
              AND username = ?
              AND enabled = TRUE
            """, expectedUserId, username);
        if (users.isEmpty()) {
            return;
        }
        var userId = String.valueOf(users.getFirst().get("id"));
        expireStalePendingRequests();

        var state = jdbcTemplate.queryForMap("""
            SELECT EXISTS (
                       SELECT 1
                       FROM sys_password_reset_request
                       WHERE requested_user_id = ?::uuid
                         AND status = 'PENDING'
                   ) AS "hasPending",
                   EXISTS (
                       SELECT 1
                       FROM sys_password_reset_request
                       WHERE requested_user_id = ?::uuid
                         AND requested_at > now() - (? * INTERVAL '1 millisecond')
                   ) AS "inCooldown"
            """, userId, userId, properties.accountCooldown().toMillis());
        if (Boolean.TRUE.equals(state.get("hasPending")) || Boolean.TRUE.equals(state.get("inCooldown"))) {
            return;
        }

        var pendingCount = jdbcTemplate.queryForObject("""
            SELECT count(*)
            FROM sys_password_reset_request
            WHERE status = 'PENDING'
            """, Integer.class);
        if (pendingCount == null || pendingCount >= properties.maxPending()) {
            return;
        }

        var inserted = jdbcTemplate.queryForList("""
            INSERT INTO sys_password_reset_request (username, contact_note, requested_user_id)
            VALUES (?, ?, ?::uuid)
            ON CONFLICT (requested_user_id) WHERE status = 'PENDING' DO NOTHING
            RETURNING id::text AS id
            """, username, contactNote, userId);
        if (inserted.isEmpty()) {
            return;
        }
        var requestId = String.valueOf(inserted.getFirst().get("id"));
        operationLogService.logPlatform(OperationLogCommand.success(
            "SYSTEM",
            "PASSWORD_RESET_REQUEST",
            "sys_user",
            UUID.fromString(userId),
            "",
            OperationLogCommand.ActorMode.ANONYMOUS,
            null,
            Map.of(),
            OperationLogCommand.state(OperationLogCommand.StateField.REQUEST_STATUS, "PENDING"),
            "申请编号 " + requestId
        ));
    }

    @Scheduled(
        fixedDelayString = "${jdy.security.password-reset.cleanup-fixed-delay-ms:3600000}",
        initialDelayString = "${jdy.security.password-reset.cleanup-initial-delay-ms:60000}"
    )
    @Transactional(transactionManager = "platformTransactionManager")
    public void cleanupExpiredAndOldRequests() {
        acquirePendingGate();
        expireStalePendingRequests();
        deleteTerminalHistory();
    }

    int expireStalePendingRequests() {
        return jdbcTemplate.update("""
            UPDATE sys_password_reset_request
            SET status = 'EXPIRED',
                handled_at = now(),
                handle_note = '待处理申请已过期',
                version = version + 1
            WHERE status = 'PENDING'
              AND requested_at <= now() - (? * INTERVAL '1 millisecond')
            """, properties.pendingExpiry().toMillis());
    }

    int deleteTerminalHistory() {
        return jdbcTemplate.update("""
            DELETE FROM sys_password_reset_request
            WHERE id IN (
                SELECT id
                FROM sys_password_reset_request
                WHERE status IN ('DONE', 'REJECTED', 'EXPIRED')
                  AND COALESCE(handled_at, requested_at) <= now() - (? * INTERVAL '1 millisecond')
                ORDER BY COALESCE(handled_at, requested_at), id
                LIMIT ?
            )
            """, properties.historyRetention().toMillis(), properties.cleanupBatchSize());
    }

    private void acquirePendingGate() {
        jdbcTemplate.queryForObject(
            "SELECT pg_advisory_xact_lock(?)",
            (resultSet, rowNumber) -> Boolean.TRUE,
            PENDING_GATE_LOCK
        );
    }
}
