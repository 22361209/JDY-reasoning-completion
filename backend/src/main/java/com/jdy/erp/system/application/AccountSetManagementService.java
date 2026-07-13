package com.jdy.erp.system.application;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.jdy.erp.shared.application.OperationLogCommand;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantSchemaProvisioner;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class AccountSetManagementService {
    private final JdbcTemplate platformJdbcTemplate;
    private final CurrentSessionService currentSessionService;
    private final TenantSchemaProvisioner tenantSchemaProvisioner;
    private final OperationLogService operationLogService;

    public AccountSetManagementService(
        @Qualifier("platformJdbcTemplate") JdbcTemplate platformJdbcTemplate,
        CurrentSessionService currentSessionService,
        TenantSchemaProvisioner tenantSchemaProvisioner,
        OperationLogService operationLogService
    ) {
        this.platformJdbcTemplate = platformJdbcTemplate;
        this.currentSessionService = currentSessionService;
        this.tenantSchemaProvisioner = tenantSchemaProvisioner;
        this.operationLogService = operationLogService;
    }

    @Transactional(transactionManager = "platformTransactionManager")
    public Map<String, Object> createAccountSet(AccountSetCreateRequest request) {
        var code = normalizeCode(required(request.code(), "账套编码"));
        var name = required(request.name(), "账套名称");
        var environment = optionalText(request.environment(), "本地开发");
        var accountingPeriod = periodOrDefault(request.accountingPeriod());
        var businessPeriod = periodOrDefault(request.businessPeriod());
        var databaseName = currentDatabaseName();
        var schemaName = tenantSchemaProvisioner.normalizeSchemaName(
            optionalText(request.schemaName(), tenantSchemaProvisioner.defaultSchemaName(code))
        );
        var attachmentPrefix = optionalText(request.attachmentPrefix(), "account-sets/" + code);
        var redisKeyPrefix = optionalText(request.redisKeyPrefix(), code);

        if (Boolean.TRUE.equals(platformJdbcTemplate.queryForObject(
            "SELECT EXISTS (SELECT 1 FROM sys_account_set WHERE code = ?)",
            Boolean.class,
            code
        ))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "账套编码已存在");
        }
        if (Boolean.TRUE.equals(platformJdbcTemplate.queryForObject("""
            SELECT EXISTS (
                SELECT 1
                FROM sys_account_set
                WHERE lower(btrim(schema_name)) = lower(btrim(?))
                  AND lower(btrim(schema_name)) <> 'public'
            )
            """, Boolean.class, schemaName))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "账套 schema 已被其他账套使用");
        }
        if (Boolean.TRUE.equals(platformJdbcTemplate.queryForObject(
            "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = ?)",
            Boolean.class,
            schemaName
        ))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "账套 schema 已存在，不允许收编现有 schema");
        }

        Map<String, Object> accountSet;
        try {
            accountSet = platformJdbcTemplate.queryForMap("""
                INSERT INTO sys_account_set (
                    code, name, environment, database_name, schema_name, attachment_prefix, redis_key_prefix,
                    accounting_period, business_period, enabled, initialized
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE, FALSE)
                RETURNING id::text AS id,
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
                """, code, name, environment, databaseName, schemaName, attachmentPrefix, redisKeyPrefix, accountingPeriod, businessPeriod);
        } catch (DuplicateKeyException exception) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "账套编码或 schema 已存在，请刷新后重试");
        }

        tenantSchemaProvisioner.provisionNewSchema(schemaName);
        grantCurrentUserAndAdmins(String.valueOf(accountSet.get("id")));
        logAccountSetOperation(
            "CREATE_ACCOUNT_SET",
            String.valueOf(accountSet.get("id")),
            code,
            Map.of(),
            OperationLogCommand.state(
                OperationLogCommand.StateField.ENABLED, true,
                OperationLogCommand.StateField.INITIALIZED, false
            ),
            "account_set=" + code
        );
        return Map.of(
            "ok", true,
            "accountSet", accountSet,
            "accountSets", currentSessionService.availableAccountSets(),
            "message", "账套已创建，tenant schema 已初始化。切换到账套后可执行本账套初始化。"
        );
    }

    public List<Map<String, Object>> accountSets() {
        return currentSessionService.availableAccountSets();
    }

    public List<Map<String, Object>> managedAccountSets() {
        return platformJdbcTemplate.queryForList("""
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
                   initialized,
                   COALESCE(disabled_reason, '') AS "disabledReason"
            FROM sys_account_set
            ORDER BY created_at, code
            """);
    }

    @Transactional(transactionManager = "platformTransactionManager")
    public Map<String, Object> setEnabled(String accountSetCode, boolean enabled, String reason) {
        var normalizedCode = normalizeCode(required(accountSetCode, "账套编码"));
        if (!enabled && normalizedCode.equalsIgnoreCase(currentSessionService.currentAccountSetCode())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "不能禁用当前正在使用的账套，请先切换到其他账套。");
        }
        var rows = platformJdbcTemplate.queryForList("""
            SELECT id::text AS id, code, name, enabled
            FROM sys_account_set
            WHERE code = ?
            LIMIT 1
            """, normalizedCode);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "账套不存在");
        }
        var accountSet = rows.get(0);
        platformJdbcTemplate.update("""
            UPDATE sys_account_set
            SET enabled = ?,
                disabled_at = CASE WHEN ? = FALSE THEN now() ELSE NULL END,
                disabled_reason = CASE WHEN ? = FALSE THEN ? ELSE '' END,
                updated_at = now(),
                version = version + 1
            WHERE id = ?::uuid
            """, enabled, enabled, enabled, optionalText(reason, ""), accountSet.get("id"));
        logAccountSetOperation(
            enabled ? "ENABLE_ACCOUNT_SET" : "DISABLE_ACCOUNT_SET",
            String.valueOf(accountSet.get("id")),
            String.valueOf(accountSet.get("code")),
            OperationLogCommand.state(OperationLogCommand.StateField.ENABLED, accountSet.get("enabled")),
            OperationLogCommand.state(OperationLogCommand.StateField.ENABLED, enabled),
            optionalText(reason, enabled ? "enabled=true" : "enabled=false")
        );
        return Map.of(
            "ok", true,
            "accountSets", managedAccountSets(),
            "message", enabled ? "账套已启用。" : "账套已禁用。"
        );
    }

    private void grantCurrentUserAndAdmins(String accountSetId) {
        var currentUsername = currentSessionService.currentUsername();
        platformJdbcTemplate.update("""
            INSERT INTO sys_user_account_set (user_id, account_set_id, role_code, is_default, enabled)
            SELECT u.id,
                   ?::uuid,
                   CASE WHEN bool_or(r.code = 'ADMIN') THEN 'ADMIN' ELSE 'MEMBER' END,
                   FALSE,
                   TRUE
            FROM sys_user u
            LEFT JOIN sys_user_role ur ON ur.user_id = u.id
            LEFT JOIN sys_role r ON r.id = ur.role_id AND r.enabled = TRUE
            WHERE u.username = ?
              AND u.enabled = TRUE
            GROUP BY u.id
            ON CONFLICT (user_id, account_set_id) DO UPDATE
            SET enabled = TRUE,
                role_code = EXCLUDED.role_code,
                updated_at = now(),
                version = sys_user_account_set.version + 1
            """, accountSetId, currentUsername);
        platformJdbcTemplate.update("""
            INSERT INTO sys_user_account_set (user_id, account_set_id, role_code, is_default, enabled)
            SELECT u.id,
                   ?::uuid,
                   'ADMIN',
                   FALSE,
                   TRUE
            FROM sys_user u
            JOIN sys_user_role ur ON ur.user_id = u.id
            JOIN sys_role r ON r.id = ur.role_id AND r.code = 'ADMIN' AND r.enabled = TRUE
            WHERE u.enabled = TRUE
            ON CONFLICT (user_id, account_set_id) DO UPDATE
            SET role_code = 'ADMIN',
                enabled = TRUE,
                updated_at = now(),
                version = sys_user_account_set.version + 1
            """, accountSetId);
    }

    void logAccountSetOperation(
        String action,
        String accountSetId,
        String accountSetCode,
        Map<OperationLogCommand.StateField, Object> beforeState,
        Map<OperationLogCommand.StateField, Object> afterState,
        String reason
    ) {
        operationLogService.logPlatform(OperationLogCommand.success(
            "SYSTEM",
            action,
            "sys_account_set",
            UUID.fromString(accountSetId),
            accountSetCode,
            OperationLogCommand.ActorMode.CURRENT_USER,
            null,
            beforeState,
            afterState,
            reason
        ));
    }

    private String currentDatabaseName() {
        return platformJdbcTemplate.queryForObject("SELECT current_database()", String.class);
    }

    private String required(String value, String label) {
        var normalized = value == null ? "" : value.trim();
        if (normalized.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不能为空");
        }
        return normalized;
    }

    private String optionalText(String value, String defaultValue) {
        var normalized = value == null ? "" : value.trim();
        return normalized.isBlank() ? defaultValue : normalized;
    }

    private String normalizeCode(String code) {
        var normalized = code.toUpperCase();
        if (!normalized.matches("[A-Z0-9_-]{2,40}")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "账套编码只能使用 2-40 位字母、数字、下划线或短横线");
        }
        return normalized;
    }

    private String periodOrDefault(String value) {
        var normalized = value == null ? "" : value.trim();
        if (normalized.isBlank()) {
            return "2026-06";
        }
        if (!normalized.matches("\\d{4}-\\d{2}")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "期间格式必须为 YYYY-MM");
        }
        return normalized;
    }

    public record AccountSetCreateRequest(
        String code,
        String name,
        String environment,
        String databaseName,
        String schemaName,
        String attachmentPrefix,
        String redisKeyPrefix,
        String accountingPeriod,
        String businessPeriod
    ) {
    }
}
