package com.jdy.erp.system.application;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.jdy.erp.shared.application.OperationLogCommand;
import com.jdy.erp.shared.application.OperationLogService;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class NotificationRetryService {
    private static final int MAX_RETRY_COUNT = 3;
    private final JdbcTemplate jdbcTemplate;
    private final NotificationProviderService notificationProviderService;
    private final OperationLogService operationLogService;

    public NotificationRetryService(
        @Qualifier("platformJdbcTemplate") JdbcTemplate jdbcTemplate,
        NotificationProviderService notificationProviderService,
        OperationLogService operationLogService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.notificationProviderService = notificationProviderService;
        this.operationLogService = operationLogService;
    }

    @Scheduled(fixedDelayString = "${jdy.notification.retry-fixed-delay-ms:5000}")
    @Transactional(transactionManager = "platformTransactionManager")
    public void retryDueNotifications() {
        var rows = dueNotificationRows();
        var providerCode = notificationProviderService.currentProviderCode();
        for (var row : rows) {
            var notificationId = String.valueOf(row.get("id"));
            var retryCount = Number.class.cast(row.getOrDefault("retryCount", 0)).intValue();
            var updated = jdbcTemplate.update("""
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
                  AND status IN ('FAILED', 'PENDING')
                  AND provider_receipt_status IS NULL
                  AND retry_count < ?
                """, providerCode, providerCode, notificationId, MAX_RETRY_COUNT);
            if (updated > 0) {
                operationLogService.logPlatform(OperationLogCommand.success(
                    "SYSTEM",
                    "AUTO_RETRY_NOTIFICATION",
                    "sys_notification_outbox",
                    UUID.fromString(notificationId),
                    notificationId,
                    OperationLogCommand.ActorMode.SYSTEM,
                    null,
                    OperationLogCommand.state(
                        OperationLogCommand.StateField.STATUS, String.valueOf(row.get("status")),
                        OperationLogCommand.StateField.RETRY_COUNT, retryCount
                    ),
                    OperationLogCommand.state(
                        OperationLogCommand.StateField.STATUS, "SENT",
                        OperationLogCommand.StateField.RETRY_COUNT, retryCount + 1,
                        OperationLogCommand.StateField.PROVIDER, providerCode
                    ),
                    null
                ));
            }
        }
    }

    private List<Map<String, Object>> dueNotificationRows() {
        return jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   status,
                   retry_count AS "retryCount"
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

}
