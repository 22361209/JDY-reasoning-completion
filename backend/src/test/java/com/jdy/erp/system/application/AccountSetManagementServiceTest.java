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
    private CurrentSessionService currentSessionService;

    @Autowired
    @Qualifier("platformJdbcTemplate")
    private JdbcTemplate platformJdbcTemplate;

    @Autowired
    private TenantDataSourceRegistry tenantDataSourceRegistry;

    private final List<String> createdCodes = new ArrayList<>();
    private final List<String> createdSchemas = new ArrayList<>();

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
        assertThat(countRows(schema, "md_warehouse")).isEqualTo(1);

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

    private String quoteIdentifier(String identifier) {
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }
}
