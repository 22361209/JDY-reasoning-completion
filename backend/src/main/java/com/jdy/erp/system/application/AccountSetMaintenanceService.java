package com.jdy.erp.system.application;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantSchemaProvisioner;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class AccountSetMaintenanceService {
    private static final DateTimeFormatter BACKUP_TIMESTAMP = DateTimeFormatter.ofPattern("yyyyMMddHHmmss");

    private final JdbcTemplate platformJdbcTemplate;
    private final CurrentSessionService currentSessionService;
    private final TenantSchemaProvisioner tenantSchemaProvisioner;

    public AccountSetMaintenanceService(
        @Qualifier("platformJdbcTemplate") JdbcTemplate platformJdbcTemplate,
        CurrentSessionService currentSessionService,
        TenantSchemaProvisioner tenantSchemaProvisioner
    ) {
        this.platformJdbcTemplate = platformJdbcTemplate;
        this.currentSessionService = currentSessionService;
        this.tenantSchemaProvisioner = tenantSchemaProvisioner;
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
        logTenantOperation(schema, accountSet, "BACKUP_ACCOUNT_SET", backupName);
        return Map.of(
            "ok", true,
            "backup", backup,
            "backups", currentBackups(),
            "message", "当前账套已备份。"
        );
    }

    @Transactional(transactionManager = "platformTransactionManager")
    public Map<String, Object> restoreCurrentAccountSet(String backupName) {
        var accountSet = currentSessionService.currentAccountSet();
        var schema = schemaName(accountSet);
        if (tenantSchemaProvisioner.isPlatformSchema(schema)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "public 过渡账套暂不支持恢复，请在 tenant schema 测试账套执行。");
        }
        var backup = backupByName(String.valueOf(accountSet.get("id")), backupName);
        var backupSchema = String.valueOf(backup.get("backupSchemaName"));
        if (!schemaExists(backupSchema)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "备份 schema 不存在：" + backupSchema);
        }

        tenantSchemaProvisioner.provisionSchema(schema);
        var restoreTables = restorableTables(schema, backupSchema);
        if (restoreTables.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "备份中没有可恢复的数据表");
        }
        platformJdbcTemplate.execute("TRUNCATE TABLE " + qualifiedTableList(schema, restoreTables) + " RESTART IDENTITY CASCADE");
        for (var table : restoreTables) {
            platformJdbcTemplate.execute("""
                INSERT INTO %s.%s
                SELECT * FROM %s.%s
                """.formatted(
                    quoteIdentifier(schema),
                    quoteIdentifier(table),
                    quoteIdentifier(backupSchema),
                    quoteIdentifier(table)
                ));
        }
        platformJdbcTemplate.update("""
            UPDATE sys_account_set_backup
            SET restored_at = now(),
                restored_by = ?::uuid
            WHERE id = ?::uuid
            """, currentSessionService.currentUserId(), backup.get("id"));
        logTenantOperation(schema, accountSet, "RESTORE_ACCOUNT_SET", String.valueOf(backup.get("backupName")));
        return Map.of(
            "ok", true,
            "backup", backupByName(String.valueOf(accountSet.get("id")), backupName),
            "backups", currentBackups(),
            "message", "当前账套已从备份恢复。"
        );
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

    private List<String> restorableTables(String schema, String backupSchema) {
        var tables = new ArrayList<String>();
        for (var table : tenantSchemaProvisioner.tenantTableNames()) {
            if (tableExists(schema, table) && tableExists(backupSchema, table)) {
                tables.add(table);
            }
        }
        return tables;
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

    private String qualifiedTableList(String schema, List<String> tables) {
        return tables.stream()
            .map(table -> quoteIdentifier(schema) + "." + quoteIdentifier(table))
            .reduce((left, right) -> left + ", " + right)
            .orElseThrow();
    }

    private void logTenantOperation(String schema, Map<String, Object> accountSet, String action, String reason) {
        platformJdbcTemplate.update("""
            INSERT INTO %s.sys_operation_log (
                module_code, action_code, target_type, target_id, success, failure_reason, operated_by,
                account_set_id, account_set_code, account_set_name
            )
            VALUES ('SYSTEM', ?, 'sys_account_set', ?::uuid, TRUE, ?, ?::uuid, ?::uuid, ?, ?)
            """.formatted(quoteIdentifier(schema)),
            action,
            accountSet.get("id"),
            reason,
            currentSessionService.currentUserId(),
            accountSet.get("id"),
            accountSet.get("code"),
            accountSet.get("name")
        );
    }

    private String quoteIdentifier(String identifier) {
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }
}
