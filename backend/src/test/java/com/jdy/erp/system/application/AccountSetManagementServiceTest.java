package com.jdy.erp.system.application;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantContext;
import com.jdy.erp.system.tenant.TenantDataSourceRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

@SpringBootTest
class AccountSetManagementServiceTest {
    @Autowired
    private AccountSetManagementService accountSetManagementService;

    @Autowired
    private AccountSetInitializationService initializationService;

    @Autowired
    private AccountSetMaintenanceService maintenanceService;

    @Autowired
    private CurrentSessionService currentSessionService;

    @Autowired
    @Qualifier("platformJdbcTemplate")
    private JdbcTemplate platformJdbcTemplate;

    @Autowired
    private TenantDataSourceRegistry tenantDataSourceRegistry;

    private final List<String> createdCodes = new ArrayList<>();
    private final List<String> createdSchemas = new ArrayList<>();
    private final List<String> createdBackupSchemas = new ArrayList<>();

    @BeforeEach
    void bindRequest() {
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(new MockHttpServletRequest()));
        currentSessionService.login("admin", "admin123", "BLD-TEST");
    }

    @AfterEach
    void cleanUp() {
        TenantContext.clear();
        RequestContextHolder.resetRequestAttributes();
        tenantDataSourceRegistry.close();
        for (var schema : createdBackupSchemas) {
            platformJdbcTemplate.execute("DROP SCHEMA IF EXISTS " + quoteIdentifier(schema) + " CASCADE");
        }
        for (var schema : createdSchemas) {
            platformJdbcTemplate.execute("DROP SCHEMA IF EXISTS " + quoteIdentifier(schema) + " CASCADE");
        }
        for (var code : createdCodes) {
            platformJdbcTemplate.update("""
                DELETE FROM sys_user_account_set
                WHERE account_set_id IN (SELECT id FROM sys_account_set WHERE code = ?)
                """, code);
            platformJdbcTemplate.update("DELETE FROM sys_account_set WHERE code = ?", code);
        }
    }

    @Test
    void createAccountSetCreatesTenantSchemaSeedsAndAdminGrant() {
        var code = nextCode("A119C");
        var result = accountSetManagementService.createAccountSet(new AccountSetManagementService.AccountSetCreateRequest(
            code,
            code + " 账套",
            "测试",
            null,
            null,
            null,
            null,
            "2026-06",
            "2026-06"
        ));
        var accountSet = result.get("accountSet");
        assertThat(accountSet).isInstanceOf(java.util.Map.class);
        @SuppressWarnings("unchecked")
        var row = (java.util.Map<String, Object>) accountSet;
        var schema = String.valueOf(row.get("schemaName"));
        createdSchemas.add(schema);

        assertThat(schema).startsWith("tenant_a119c");
        assertThat(tableExists(schema, "md_product")).isTrue();
        assertThat(tableExists(schema, "sales_order")).isTrue();
        assertThat(tableExists(schema, "document_number_sequence")).isTrue();
        assertThat(countRows(schema, "md_unit")).isGreaterThanOrEqualTo(5);
        assertThat(warehouseNames(schema)).containsExactly(
            "冲压区材料仓",
            "冲压区片件仓",
            "焊接区片件仓",
            "焊接区配件仓",
            "安装区成品仓",
            "安装区配件仓",
            "安装区辅材仓",
            "安装区毛坯仓"
        );
        assertThat(productionDepartmentCodes(schema)).containsExactly("AZ", "BZ", "CY", "HJ", "JG");

        var grants = platformJdbcTemplate.queryForObject("""
            SELECT count(*)::int
            FROM sys_user_account_set uas
            JOIN sys_user u ON u.id = uas.user_id
            JOIN sys_account_set a ON a.id = uas.account_set_id
            WHERE u.username = 'admin'
              AND a.code = ?
              AND uas.enabled = TRUE
            """, Integer.class, code);
        assertThat(grants).isEqualTo(1);

        bindRequest();
        currentSessionService.login("admin", "admin123", code);
        assertThat(currentSessionService.currentAccountSetCode()).isEqualTo(code);
    }

    @Test
    void initializeCurrentAccountSetClearsOnlyCurrentTenantSchema() {
        var codeA = createManagedAccountSet("A119A");
        var codeB = createManagedAccountSet("A119B");
        var schemaA = schemaFor(codeA);
        var schemaB = schemaFor(codeB);

        platformJdbcTemplate.update("""
            INSERT INTO %s.sales_order (bill_no, customer_id, bill_date)
            VALUES (?, gen_random_uuid(), current_date)
            """.formatted(quoteIdentifier(schemaA)), codeA + "-SO");
        platformJdbcTemplate.update("""
            INSERT INTO %s.sales_order (bill_no, customer_id, bill_date)
            VALUES (?, gen_random_uuid(), current_date)
            """.formatted(quoteIdentifier(schemaB)), codeB + "-SO");

        bindRequest();
        currentSessionService.login("admin", "admin123", codeA);
        TenantContext.setTenant(currentSessionService.currentAccountSet());

        initializationService.initializeCurrentAccountSet(true);

        assertThat(countRows(schemaA, "sales_order")).isZero();
        assertThat(countRows(schemaB, "sales_order")).isEqualTo(1);
        var initialized = platformJdbcTemplate.queryForObject(
            "SELECT initialized FROM sys_account_set WHERE code = ?",
            Boolean.class,
            codeA
        );
        assertThat(initialized).isTrue();
    }

    @Test
    void backupAndRestoreCurrentAccountSetKeepsTenantDataAndLogsAccountSet() {
        var code = createManagedAccountSet("A119OPS");
        var schema = schemaFor(code);
        bindRequest();
        currentSessionService.login("admin", "admin123", code);
        TenantContext.setTenant(currentSessionService.currentAccountSet());

        platformJdbcTemplate.update("""
            INSERT INTO %s.md_product_category (code, name, sort_no, enabled, audit_status)
            VALUES ('OPS', '运维恢复测试', 99, TRUE, 'AUDITED')
            ON CONFLICT (code) DO UPDATE
            SET name = EXCLUDED.name,
                enabled = TRUE,
                audit_status = 'AUDITED'
            """.formatted(quoteIdentifier(schema)));

        var backupResult = maintenanceService.backupCurrentAccountSet();
        @SuppressWarnings("unchecked")
        var backup = (java.util.Map<String, Object>) backupResult.get("backup");
        createdBackupSchemas.add(String.valueOf(backup.get("backupSchemaName")));

        platformJdbcTemplate.update("DELETE FROM %s.md_product_category WHERE code = 'OPS'".formatted(quoteIdentifier(schema)));
        assertThat(countRowsWhere(schema, "md_product_category", "code = 'OPS'")).isZero();

        maintenanceService.restoreCurrentAccountSet(String.valueOf(backup.get("backupName")));

        assertThat(countRowsWhere(schema, "md_product_category", "code = 'OPS'")).isEqualTo(1);
        var logRows = platformJdbcTemplate.queryForList("""
            SELECT account_set_code AS "accountSetCode",
                   account_set_name AS "accountSetName"
            FROM %s.sys_operation_log
            WHERE action_code = 'RESTORE_ACCOUNT_SET'
            ORDER BY operated_at DESC
            LIMIT 1
            """.formatted(quoteIdentifier(schema)));
        assertThat(logRows).hasSize(1);
        assertThat(logRows.get(0).get("accountSetCode")).isEqualTo(code);
        assertThat(logRows.get(0).get("accountSetName")).isEqualTo(code + " 账套");
    }

    private String createManagedAccountSet(String prefix) {
        var code = nextCode(prefix);
        var result = accountSetManagementService.createAccountSet(new AccountSetManagementService.AccountSetCreateRequest(
            code,
            code + " 账套",
            "测试",
            null,
            null,
            null,
            null,
            "2026-06",
            "2026-06"
        ));
        @SuppressWarnings("unchecked")
        var row = (java.util.Map<String, Object>) result.get("accountSet");
        createdSchemas.add(String.valueOf(row.get("schemaName")));
        return code;
    }

    private String nextCode(String prefix) {
        var code = prefix + "-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();
        createdCodes.add(code);
        return code;
    }

    private String schemaFor(String code) {
        return platformJdbcTemplate.queryForObject(
            "SELECT schema_name FROM sys_account_set WHERE code = ?",
            String.class,
            code
        );
    }

    private boolean tableExists(String schema, String tableName) {
        return Boolean.TRUE.equals(platformJdbcTemplate.queryForObject(
            "SELECT to_regclass(?) IS NOT NULL",
            Boolean.class,
            schema + "." + tableName
        ));
    }

    private int countRows(String schema, String tableName) {
        return platformJdbcTemplate.queryForObject(
            "SELECT count(*)::int FROM " + quoteIdentifier(schema) + "." + quoteIdentifier(tableName),
            Integer.class
        );
    }

    private int countRowsWhere(String schema, String tableName, String whereClause) {
        return platformJdbcTemplate.queryForObject(
            "SELECT count(*)::int FROM " + quoteIdentifier(schema) + "." + quoteIdentifier(tableName) + " WHERE " + whereClause,
            Integer.class
        );
    }

    private List<String> productionDepartmentCodes(String schema) {
        return platformJdbcTemplate.queryForList(
            "SELECT code FROM " + quoteIdentifier(schema) + ".md_production_department ORDER BY code",
            String.class
        );
    }

    private List<String> warehouseNames(String schema) {
        return platformJdbcTemplate.queryForList(
            "SELECT name FROM " + quoteIdentifier(schema) + ".md_warehouse ORDER BY code",
            String.class
        );
    }

    private String quoteIdentifier(String identifier) {
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }
}
