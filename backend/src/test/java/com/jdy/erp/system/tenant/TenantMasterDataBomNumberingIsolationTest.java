package com.jdy.erp.system.tenant;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.jdy.erp.masterdata.api.MasterDataController;
import com.jdy.erp.production.application.ProductionTaskAppService;
import com.jdy.erp.shared.application.NumberingService;
import com.jdy.erp.system.application.AccountSetManagementService;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.testsupport.IsolatedAdminFixture;
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
class TenantMasterDataBomNumberingIsolationTest {
    private static final JsonNodeFactory JSON = JsonNodeFactory.instance;

    @Autowired
    private AccountSetManagementService accountSetManagementService;

    @Autowired
    private CurrentSessionService currentSessionService;

    @Autowired
    private MasterDataController masterDataController;

    @Autowired
    private ProductionTaskAppService productionTaskAppService;

    @Autowired
    private NumberingService numberingService;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    @Qualifier("platformJdbcTemplate")
    private JdbcTemplate platformJdbcTemplate;

    @Autowired
    private TenantDataSourceRegistry tenantDataSourceRegistry;

    private final List<String> createdCodes = new ArrayList<>();
    private final List<String> createdSchemas = new ArrayList<>();
    private IsolatedAdminFixture.Identity fixture;

    @BeforeEach
    void bindRequest() {
        fixture = IsolatedAdminFixture.create(platformJdbcTemplate, "masterdata");
        useTenant("BLD-TEST");
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
        IsolatedAdminFixture.remove(platformJdbcTemplate, fixture);
    }

    @Test
    void masterDataBomAndNumberingAreTenantScoped() {
        var tenantA = createManagedAccountSet("A119MDA");
        var tenantB = createManagedAccountSet("A119MDB");

        useTenant(tenantA);
        createAuditedMaterial("A119-M", "A119 账套A母件");
        createAuditedMaterial("A119-C", "A119 账套A子件");
        createAuditedBom();
        numberingService.saveRule("salesOrder", "TA", 4, JSON.textNode("0"), true, JSON.textNode("0"));
        assertThat(numberingService.nextBillNo("salesOrder")).isEqualTo("TA0001");
        assertThat(productName("A119-M")).isEqualTo("A119 账套A母件");
        assertThat(bomProductName()).isEqualTo("A119 账套A母件");

        useTenant(tenantB);
        createAuditedMaterial("A119-M", "A119 账套B母件");
        createAuditedMaterial("A119-C", "A119 账套B子件");
        createAuditedBom();
        numberingService.saveRule("salesOrder", "TB", 4, JSON.textNode("9"), true, JSON.textNode("0"));
        assertThat(numberingService.nextBillNo("salesOrder")).isEqualTo("TB0010");
        assertThat(productName("A119-M")).isEqualTo("A119 账套B母件");
        assertThat(bomProductName()).isEqualTo("A119 账套B母件");
        assertThat(countProductsNamed("A119 账套A母件")).isZero();

        useTenant(tenantA);
        assertThat(productName("A119-M")).isEqualTo("A119 账套A母件");
        assertThat(bomProductName()).isEqualTo("A119 账套A母件");
        assertThat(numberingService.nextBillNo("salesOrder")).isEqualTo("TA0002");
        assertThat(countProductsNamed("A119 账套B母件")).isZero();
    }

    private String createManagedAccountSet(String prefix) {
        var code = prefix + "-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();
        createdCodes.add(code);
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
        var row = (Map<String, Object>) result.get("accountSet");
        createdSchemas.add(String.valueOf(row.get("schemaName")));
        return code;
    }

    private void useTenant(String code) {
        TenantContext.clear();
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(new MockHttpServletRequest()));
        currentSessionService.login(fixture.username(), IsolatedAdminFixture.PASSWORD, code);
        TenantContext.setTenant(currentSessionService.currentAccountSet());
    }

    private void createAuditedMaterial(String code, String name) {
        var nameCode = "PN-" + code;
        masterDataController.create("productName", Map.of(
            "code", nameCode,
            "name", name
        ));
        masterDataController.audit("productName", nameCode);
        masterDataController.create("product", Map.of(
            "code", code,
            "name", name,
            "category", "RAW",
            "unit", "PCS",
            "isInventory", "true",
            "isProduce", "true"
        ));
        masterDataController.audit("product", code);
    }

    private void createAuditedBom() {
        productionTaskAppService.saveBom(new ProductionTaskAppService.BomRequest(
            "BOM-A119",
            "A119-M",
            BigDecimal.ONE,
            "自制BOM",
            "",
            List.of(new ProductionTaskAppService.BomLineRequest(
                "A119-C",
                BigDecimal.ONE,
                BigDecimal.ONE,
                BigDecimal.ONE,
                BigDecimal.ONE,
                "手工领料",
                null,
                BigDecimal.ZERO,
                BigDecimal.ZERO,
                null
            ))
        ));
        productionTaskAppService.auditBom("BOM-A119");
    }

    private String productName(String code) {
        return jdbcTemplate.queryForObject(
            "SELECT name FROM md_product WHERE code = ?",
            String.class,
            code
        );
    }

    private int countProductsNamed(String name) {
        return jdbcTemplate.queryForObject(
            "SELECT count(*)::int FROM md_product WHERE name = ?",
            Integer.class,
            name
        );
    }

    private String bomProductName() {
        @SuppressWarnings("unchecked")
        var detail = (Map<String, Object>) productionTaskAppService.bomDetail("BOM-A119");
        return String.valueOf(detail.get("productName"));
    }

    private String quoteIdentifier(String identifier) {
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }
}
