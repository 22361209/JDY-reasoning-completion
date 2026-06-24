package com.jdy.erp.system.application;

import java.util.List;
import java.util.Map;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class NotificationRetryService {
    private static final int MAX_RETRY_COUNT = 3;
    private final JdbcTemplate jdbcTemplate;

    public NotificationRetryService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @Scheduled(fixedDelayString = "${jdy.notification.retry-fixed-delay-ms:5000}")
    @Transactional
    public void retryDueNotifications() {
        var rows = dueNotificationRows();
        for (var row : rows) {
            var notificationId = String.valueOf(row.get("id"));
            var recipientUsername = String.valueOf(row.get("recipientUsername"));
            var updated = jdbcTemplate.update("""
                UPDATE sys_notification_outbox
                SET status = 'SENT',
                    provider = 'LOCAL',
                    retry_count = retry_count + 1,
                    last_attempt_at = now(),
                    sent_at = now(),
                    failure_reason = NULL,
                    provider_receipt_status = NULL,
                    provider_receipt_at = NULL,
                    provider_message_id = 'LOCAL-' || replace(id::text, '-', '')
                WHERE id = ?::uuid
                  AND status IN ('FAILED', 'PENDING')
                  AND provider_receipt_status IS NULL
                  AND retry_count < ?
                """, notificationId, MAX_RETRY_COUNT);
            if (updated > 0) {
                logAutoRetry(notificationId, recipientUsername);
            }
        }
    }

    private List<Map<String, Object>> dueNotificationRows() {
        return jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   recipient_username AS "recipientUsername"
            FROM sys_notification_outbox
            WHERE template_code LIKE 'PASSWORD_RESET_%'
              AND status IN ('FAILED', 'PENDING')
              AND provider_receipt_status IS NULL
              AND retry_count < ?
              AND (last_attempt_at IS NULL OR last_attempt_at <= now() - interval '2 seconds')
            ORDER BY COALESCE(last_attempt_at, created_at), created_at
            LIMIT 20
            """, MAX_RETRY_COUNT);
    }

    private void logAutoRetry(String notificationId, String recipientUsername) {
        jdbcTemplate.update("""
            INSERT INTO sys_operation_log (module_code, action_code, target_type, target_id, success, failure_reason)
            VALUES ('SYSTEM', 'AUTO_RETRY_NOTIFICATION', 'sys_notification_outbox', ?::uuid, TRUE, ?)
            """, notificationId, "自动重试给 " + recipientUsername);
    }
}
