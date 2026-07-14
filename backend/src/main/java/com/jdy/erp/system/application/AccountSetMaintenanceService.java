package com.jdy.erp.system.application;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.jdy.erp.shared.application.OperationLogCommand;
import com.jdy.erp.shared.application.OperationLogFailureService;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.shared.application.OperationLogService.TenantTarget;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantSchemaProvisioner;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

@Service
public class AccountSetMaintenanceService {
    private static final DateTimeFormatter BACKUP_TIMESTAMP = DateTimeFormatter.ofPattern("yyyyMMddHHmmss");

    private final JdbcTemplate platformJdbcTemplate;
    private final CurrentSessionService currentSessionService;
    private final TenantSchemaProvisioner tenantSchemaProvisioner;
    private final OperationLogService operationLogService;
    private final OperationLogFailureService operationLogFailureService;
    private final TransactionTemplate platformTransactions;

    public AccountSetMaintenanceService(
        @Qualifier("platformJdbcTemplate") JdbcTemplate platformJdbcTemplate,
        CurrentSessionService currentSessionService,
        TenantSchemaProvisioner tenantSchemaProvisioner,
        OperationLogService operationLogService,
        OperationLogFailureService operationLogFailureService,
        @Qualifier("platformTransactionManager") PlatformTransactionManager platformTransactionManager
    ) {
        this.platformJdbcTemplate = platformJdbcTemplate;
        this.currentSessionService = currentSessionService;
        this.tenantSchemaProvisioner = tenantSchemaProvisioner;
        this.operationLogService = operationLogService;
        this.operationLogFailureService = operationLogFailureService;
        this.platformTransactions = new TransactionTemplate(platformTransactionManager);
    }

    public List<Map<String, Object>> currentBackups() {
        var accountSet = currentSessionService.currentAccountSet();
        return platformJdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   backup_name AS "backupName",
                   backup_schema_name AS "backupSchemaName",
                   account_set_code AS "accountSetCode",
                   account_set_name AS "accountSetName",
                   attachment_prefix AS "attachmentPrefix",
                   table_count AS "tableCount",
                   row_count AS "rowCount",
                   to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS "createdAt",
                   to_char(restored_at, 'YYYY-MM-DD HH24:MI:SS') AS "restoredAt"
            FROM sys_account_set_backup
            WHERE account_set_id = ?::uuid
            ORDER BY created_at DESC
            """, accountSet.get("id"));
    }

    @Transactional(transactionManager = "platformTransactionManager")
    public Map<String, Object> backupCurrentAccountSet() {
        var accountSet = currentSessionService.currentAccountSet();
        var schema = schemaName(accountSet);
        tenantSchemaProvisioner.provisionSchema(schema);

        var backupName = "BK-" + accountSet.get("code") + "-" + BACKUP_TIMESTAMP.format(LocalDateTime.now());
        var backupSchema = backupSchemaName(String.valueOf(accountSet.get("code")));
        platformJdbcTemplate.execute("CREATE SCHEMA " + quoteIdentifier(backupSchema));

        long rowCount = 0;
        int tableCount = 0;
        for (var table : tenantSchemaProvisioner.tenantTableNames()) {
            if (!tableExists(schema, table)) {
                continue;
            }
            platformJdbcTemplate.execute("""
                CREATE TABLE %s.%s AS TABLE %s.%s
                """.formatted(
                    quoteIdentifier(backupSchema),
                    quoteIdentifier(table),
                    quoteIdentifier(schema),
                    quoteIdentifier(table)
                ));
            rowCount += countRows(schema, table);
            tableCount += 1;
        }

        var backup = platformJdbcTemplate.queryForMap("""
            INSERT INTO sys_account_set_backup (
                account_set_id, account_set_code, account_set_name, backup_name, backup_schema_name,
                attachment_prefix, table_count, row_count, created_by
            )
            VALUES (?::uuid, ?, ?, ?, ?, ?, ?, ?, ?::uuid)
            RETURNING id::text AS id,
                      backup_name AS "backupName",
                      backup_schema_name AS "backupSchemaName",
                      account_set_code AS "accountSetCode",
                      account_set_name AS "accountSetName",
                      attachment_prefix AS "attachmentPrefix",
                      table_count AS "tableCount",
                      row_count AS "rowCount",
                      to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS "createdAt",
                      '' AS "restoredAt"
            """,
            accountSet.get("id"),
            accountSet.get("code"),
            accountSet.get("name"),
            backupName,
            backupSchema,
            accountSet.get("attachmentPrefix"),
            tableCount,
            rowCount,
            currentSessionService.currentUserId()
        );
        logAccountSetOperation(accountSet, schema, "BACKUP_ACCOUNT_SET", backupName);
        return Map.of(
            "ok", true,
            "backup", backup,
            "backups", currentBackups(),
            "message", "当前账套已备份。"
        );
    }

    public Map<String, Object> restoreCurrentAccountSet(String backupName) {
        var accountSet = currentSessionService.currentAccountSet();
        var schema = schemaName(accountSet);
        try {
            return platformTransactions.execute(status -> restoreWithinTransaction(accountSet, schema, backupName));
        } catch (RuntimeException exception) {
            logRestoreFailure(accountSet, schema, backupName, exception);
            throw exception;
        }
    }

    private Map<String, Object> restoreWithinTransaction(
        Map<String, Object> accountSet,
        String schema,
        String backupName
    ) {
        if (tenantSchemaProvisioner.isPlatformSchema(schema)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "public 过渡账套暂不支持恢复，请在 tenant schema 测试账套执行。");
        }
        var backup = backupByName(String.valueOf(accountSet.get("id")), backupName);
        var backupSchema = String.valueOf(backup.get("backupSchemaName"));
        if (!schemaExists(backupSchema)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "备份 schema 不存在：" + backupSchema);
        }

        tenantSchemaProvisioner.provisionSchema(schema);
        var restoreTables = restorePlans(schema, backupSchema);
        if (restoreTables.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "备份中没有可恢复的数据表");
        }
        platformJdbcTemplate.execute("TRUNCATE TABLE " + qualifiedTableList(schema, restoreTables) + " RESTART IDENTITY");
        for (var restorePlan : restoreTables) {
            var columns = restorePlan.columns().stream()
                .map(this::quoteIdentifier)
                .reduce((left, right) -> left + ", " + right)
                .orElseThrow();
            platformJdbcTemplate.execute("""
                INSERT INTO %s.%s (%s)
                SELECT %s FROM %s.%s
                """.formatted(
                    quoteIdentifier(schema),
                    quoteIdentifier(restorePlan.tableName()),
                    columns,
                    columns,
                    quoteIdentifier(backupSchema),
                    quoteIdentifier(restorePlan.tableName())
                ));
        }
        expireRestoredImportBatches(schema);
        platformJdbcTemplate.update("""
            UPDATE sys_account_set_backup
            SET restored_at = now(),
                restored_by = ?::uuid
            WHERE id = ?::uuid
            """, currentSessionService.currentUserId(), backup.get("id"));
        logAccountSetOperation(accountSet, schema, "RESTORE_ACCOUNT_SET", String.valueOf(backup.get("backupName")));
        return Map.of(
            "ok", true,
            "backup", backupByName(String.valueOf(accountSet.get("id")), backupName),
            "backups", currentBackups(),
            "message", "当前账套已从备份恢复。"
        );
    }

    private void expireRestoredImportBatches(String schema) {
        platformJdbcTemplate.update("""
            UPDATE %s.md_import_batch
            SET status = 'EXPIRED',
                committed_rows = 0,
                committed_at = NULL,
                rows_payload = '[]'::jsonb,
                payload_cleared_at = GREATEST(now(), created_at),
                updated_at = GREATEST(now(), created_at),
                version = version + 1
            WHERE status IN ('VALIDATED', 'INVALID', 'STALE', 'FAILED')
            """.formatted(quoteIdentifier(schema)));
    }

    private Map<String, Object> backupByName(String accountSetId, String backupName) {
        var normalizedBackupName = backupName == null ? "" : backupName.trim();
        if (normalizedBackupName.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "请选择备份");
        }
        var rows = platformJdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   backup_name AS "backupName",
                   backup_schema_name AS "backupSchemaName",
                   account_set_code AS "accountSetCode",
                   account_set_name AS "accountSetName",
                   attachment_prefix AS "attachmentPrefix",
                   table_count AS "tableCount",
                   row_count AS "rowCount",
                   to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS "createdAt",
                   to_char(restored_at, 'YYYY-MM-DD HH24:MI:SS') AS "restoredAt"
            FROM sys_account_set_backup
            WHERE account_set_id = ?::uuid
              AND backup_name = ?
            LIMIT 1
            """, accountSetId, normalizedBackupName);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "备份不存在");
        }
        return rows.get(0);
    }

    private String schemaName(Map<String, Object> accountSet) {
        var schema = String.valueOf(accountSet.get("schemaName"));
        if (schema == null || schema.isBlank() || "null".equalsIgnoreCase(schema)) {
            return "public";
        }
        return tenantSchemaProvisioner.normalizeSchemaName(schema);
    }

    private String backupSchemaName(String accountSetCode) {
        var normalizedCode = accountSetCode == null ? "tenant" : accountSetCode.toLowerCase();
        normalizedCode = normalizedCode.replaceAll("[^a-z0-9]+", "_").replaceAll("^_+|_+$", "");
        if (normalizedCode.isBlank()) {
            normalizedCode = "tenant";
        }
        if (normalizedCode.length() > 28) {
            normalizedCode = normalizedCode.substring(0, 28);
        }
        var rawName = "bk_" + normalizedCode + "_" + BACKUP_TIMESTAMP.format(LocalDateTime.now());
        var schemaName = tenantSchemaProvisioner.normalizeSchemaName(rawName);
        if (schemaExists(schemaName)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "备份 schema 已存在，请稍后重试");
        }
        return schemaName;
    }

    private List<RestorePlan> restorePlans(String schema, String backupSchema) {
        var plans = new ArrayList<RestorePlan>();
        for (var table : tenantSchemaProvisioner.tenantTableNames()) {
            if ("sys_operation_log".equals(table)) {
                continue;
            }
            if (!tableExists(schema, table)) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "目标 tenant 缺少受管表：" + table);
            }
            if (!tableExists(backupSchema, table)) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "备份缺少受管表：" + table);
            }
            var missingRequiredColumns = platformJdbcTemplate.queryForList("""
                    SELECT target.column_name
                    FROM information_schema.columns target
                    WHERE target.table_schema = ?
                      AND target.table_name = ?
                      AND target.is_nullable = 'NO'
                      AND target.column_default IS NULL
                      AND target.is_identity = 'NO'
                      AND target.is_generated = 'NEVER'
                      AND NOT EXISTS (
                          SELECT 1
                          FROM information_schema.columns backup
                          WHERE backup.table_schema = ?
                            AND backup.table_name = target.table_name
                            AND backup.column_name = target.column_name
                      )
                    ORDER BY target.ordinal_position
                """, String.class, schema, table, backupSchema);
            if (!missingRequiredColumns.isEmpty()) {
                throw new ResponseStatusException(
                    HttpStatus.CONFLICT,
                    "备份表缺少目标表必填列：" + table + "." + String.join(",", missingRequiredColumns)
                );
            }
            var commonColumns = platformJdbcTemplate.queryForList("""
                    SELECT target.column_name
                    FROM information_schema.columns target
                    JOIN information_schema.columns backup
                      ON backup.table_schema = ?
                     AND backup.table_name = target.table_name
                     AND backup.column_name = target.column_name
                    WHERE target.table_schema = ?
                      AND target.table_name = ?
                    ORDER BY target.ordinal_position
                """, String.class, backupSchema, schema, table);
            if (commonColumns.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "备份表与目标表没有可恢复的共同列：" + table);
            }
            plans.add(new RestorePlan(table, List.copyOf(commonColumns)));
        }
        return plans;
    }

    private boolean schemaExists(String schema) {
        return Boolean.TRUE.equals(platformJdbcTemplate.queryForObject(
            "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = ?)",
            Boolean.class,
            schema
        ));
    }

    private boolean tableExists(String schema, String table) {
        return Boolean.TRUE.equals(platformJdbcTemplate.queryForObject(
            "SELECT to_regclass(?) IS NOT NULL",
            Boolean.class,
            schema + "." + table
        ));
    }

    private long countRows(String schema, String table) {
        var count = platformJdbcTemplate.queryForObject(
            "SELECT count(*)::bigint FROM " + quoteIdentifier(schema) + "." + quoteIdentifier(table),
            Long.class
        );
        return count == null ? 0 : count;
    }

    private String qualifiedTableList(String schema, List<RestorePlan> restorePlans) {
        return restorePlans.stream()
            .map(plan -> quoteIdentifier(schema) + "." + quoteIdentifier(plan.tableName()))
            .reduce((left, right) -> left + ", " + right)
            .orElseThrow();
    }

    private record RestorePlan(String tableName, List<String> columns) {
    }

    void logAccountSetOperation(Map<String, Object> accountSet, String schema, String action, String backupName) {
        var command = OperationLogCommand.success(
            "SYSTEM",
            action,
            "sys_account_set",
            UUID.fromString(String.valueOf(accountSet.get("id"))),
            String.valueOf(accountSet.get("code")),
            OperationLogCommand.ActorMode.CURRENT_USER,
            null,
            Map.of(),
            OperationLogCommand.state(OperationLogCommand.StateField.BACKUP_NAME, backupName),
            null
        );
        operationLogService.logTenant(tenantTarget(accountSet, schema), command);
    }

    private void logRestoreFailure(
        Map<String, Object> accountSet,
        String schema,
        String backupName,
        RuntimeException exception
    ) {
        var reason = exception instanceof ResponseStatusException response && response.getReason() != null
            ? response.getReason()
            : "账套恢复失败";
        var command = OperationLogCommand.failure(
            "SYSTEM",
            "RESTORE_ACCOUNT_SET",
            "sys_account_set",
            UUID.fromString(String.valueOf(accountSet.get("id"))),
            String.valueOf(accountSet.get("code")),
            OperationLogCommand.ActorMode.CURRENT_USER,
            null,
            OperationLogCommand.state(OperationLogCommand.StateField.BACKUP_NAME, backupName),
            Map.of(),
            reason
        );
        operationLogFailureService.logTenantOnce(tenantTarget(accountSet, schema), command);
    }

    private TenantTarget tenantTarget(Map<String, Object> accountSet, String schema) {
        return new TenantTarget(
            UUID.fromString(String.valueOf(accountSet.get("id"))),
            String.valueOf(accountSet.get("code")),
            String.valueOf(accountSet.get("name")),
            schema
        );
    }

    private String quoteIdentifier(String identifier) {
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }
}
