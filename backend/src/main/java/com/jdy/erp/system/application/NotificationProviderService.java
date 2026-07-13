package com.jdy.erp.system.application;

import java.util.List;
import java.util.Map;

import com.jdy.erp.shared.application.OperationLogCommand;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.system.security.CurrentSessionService;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class NotificationProviderService {
    private static final String PROVIDER_CODE_KEY = "notification.provider.code";
    private static final String SENDER_NAME_KEY = "notification.provider.sender_name";
    private static final String ENDPOINT_URL_KEY = "notification.provider.endpoint_url";
    private static final String WEBHOOK_SECRET_KEY = "notification.provider.webhook_secret";
    private static final String DRY_RUN_KEY = "notification.provider.dry_run";
    private static final String DEFAULT_PROVIDER_CODE = "LOCAL";

    private final JdbcTemplate jdbcTemplate;
    private final CurrentSessionService currentSessionService;
    private final OperationLogService operationLogService;

    public NotificationProviderService(
        @Qualifier("platformJdbcTemplate") JdbcTemplate jdbcTemplate,
        CurrentSessionService currentSessionService,
        OperationLogService operationLogService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.currentSessionService = currentSessionService;
        this.operationLogService = operationLogService;
    }

    public Map<String, Object> settings() {
        var webhookSecret = setting(WEBHOOK_SECRET_KEY, "");
        return Map.of(
            "providerCode", currentProviderCode(),
            "providerLabel", providerLabel(currentProviderCode()),
            "senderName", setting(SENDER_NAME_KEY, "本地通知"),
            "endpointUrl", setting(ENDPOINT_URL_KEY, ""),
            "webhookSecretConfigured", !webhookSecret.isBlank(),
            "dryRun", Boolean.parseBoolean(setting(DRY_RUN_KEY, "true"))
        );
    }

    @Transactional(transactionManager = "platformTransactionManager")
    public void updateSettings(String providerCode, String senderName, String endpointUrl, String webhookSecret, Boolean dryRun) {
        var beforeSettings = settings();
        var normalizedProviderCode = normalizeProviderCode(providerCode);
        var normalizedSenderName = optionalLimited(senderName, 80);
        if (normalizedSenderName.isBlank()) {
            normalizedSenderName = "本地通知";
        }
        var normalizedEndpointUrl = optionalLimited(endpointUrl, 240);
        if (!"LOCAL".equals(normalizedProviderCode) && normalizedEndpointUrl.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "非本地供应商需填写接口地址");
        }
        upsert(PROVIDER_CODE_KEY, normalizedProviderCode);
        upsert(SENDER_NAME_KEY, normalizedSenderName);
        upsert(ENDPOINT_URL_KEY, normalizedEndpointUrl);
        upsert(DRY_RUN_KEY, String.valueOf(dryRun == null || dryRun));
        if (webhookSecret != null && !webhookSecret.isBlank()) {
            upsert(WEBHOOK_SECRET_KEY, optionalLimited(webhookSecret, 160));
        }
        operationLogService.logPlatform(OperationLogCommand.success(
            "SYSTEM",
            "UPDATE_NOTIFICATION_PROVIDER_SETTING",
            "sys_setting",
            null,
            "notification-provider",
            OperationLogCommand.ActorMode.CURRENT_USER,
            null,
            OperationLogCommand.state(
                OperationLogCommand.StateField.PROVIDER, beforeSettings.get("providerCode"),
                OperationLogCommand.StateField.DRY_RUN, beforeSettings.get("dryRun")
            ),
            OperationLogCommand.state(
                OperationLogCommand.StateField.PROVIDER, normalizedProviderCode,
                OperationLogCommand.StateField.DRY_RUN, dryRun == null || dryRun
            ),
            null
        ));
    }

    public String currentProviderCode() {
        return normalizeProviderCode(setting(PROVIDER_CODE_KEY, DEFAULT_PROVIDER_CODE));
    }

    public String providerMessageId(String notificationId) {
        return currentProviderCode() + "-" + notificationId.replace("-", "");
    }

    private String providerLabel(String providerCode) {
        if ("SIMULATED_HTTP".equals(providerCode)) {
            return "模拟 HTTP 供应商";
        }
        if ("SIMULATED_SMTP".equals(providerCode)) {
            return "模拟 SMTP 供应商";
        }
        return "本地通知";
    }

    private String normalizeProviderCode(String providerCode) {
        var normalized = providerCode == null ? "" : providerCode.trim().toUpperCase();
        if (normalized.isBlank()) {
            return DEFAULT_PROVIDER_CODE;
        }
        if (!List.of("LOCAL", "SIMULATED_HTTP", "SIMULATED_SMTP").contains(normalized)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "通知供应商不正确");
        }
        return normalized;
    }

    private String setting(String key, String defaultValue) {
        var values = jdbcTemplate.queryForList("SELECT setting_value FROM sys_setting WHERE setting_key = ?", String.class, key);
        if (values.isEmpty()) {
            return defaultValue;
        }
        return values.get(0) == null ? defaultValue : values.get(0);
    }

    private void upsert(String key, String value) {
        jdbcTemplate.update("""
            INSERT INTO sys_setting (setting_key, setting_value, updated_by)
            VALUES (?, ?, (SELECT id FROM sys_user WHERE username = ?))
            ON CONFLICT (setting_key) DO UPDATE
            SET setting_value = EXCLUDED.setting_value,
                updated_at = now(),
                updated_by = EXCLUDED.updated_by,
                version = sys_setting.version + 1
            """, key, value, currentSessionService.currentUsername());
    }

    private String optionalLimited(String value, int maxLength) {
        if (value == null || value.isBlank()) {
            return "";
        }
        var normalized = value.trim();
        return normalized.length() > maxLength ? normalized.substring(0, maxLength) : normalized;
    }

}
