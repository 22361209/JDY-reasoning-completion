package com.jdy.erp.system.tenant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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
import com.jdy.erp.system.application.list.StubListSeedRowsProvider;
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
import org.springframework.web.server.ResponseStatusException;
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
    private StubListSeedRowsProvider listSeedRowsProvider;

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
        assertBomListRow("A119 账套A母件");

        useTenant(tenantB);
        createAuditedMaterial("A119-M", "A119 账套B母件");
        createAuditedMaterial("A119-C", "A119 账套B子件");
        createAuditedBom();
        numberingService.saveRule("salesOrder", "TB", 4, JSON.textNode("9"), true, JSON.textNode("0"));
        assertThat(numberingService.nextBillNo("salesOrder")).isEqualTo("TB0010");
        assertThat(productName("A119-M")).isEqualTo("A119 账套B母件");
        assertThat(bomProductName()).isEqualTo("A119 账套B母件");
        assertBomListRow("A119 账套B母件");
        assertThat(countProductsNamed("A119 账套A母件")).isZero();

        useTenant(tenantA);
        assertThat(productName("A119-M")).isEqualTo("A119 账套A母件");
        assertThat(bomProductName()).isEqualTo("A119 账套A母件");
        assertThat(numberingService.nextBillNo("salesOrder")).isEqualTo("TA0002");
        assertThat(countProductsNamed("A119 账套B母件")).isZero();
    }

    @Test
    void bomDirectSelfReferenceIsRejectedOnSavePreviewAndEveryAudit() {
        var tenant = createManagedAccountSet("A181BOM");
        useTenant(tenant);
        createAuditedMaterial("A181-M", "A181 BOM 母件");
        createAuditedMaterial("A181-C", "A181 BOM 子件");

        assertDirectSelfReferenceRejected(() -> productionTaskAppService.saveBom(
            bomRequest("BOM-A181-SAVE", "A181-M", "A181-M")
        ));
        assertThat(jdbcTemplate.queryForObject(
            "SELECT count(*)::int FROM prod_bom WHERE code = ?",
            Integer.class,
            "BOM-A181-SAVE"
        )).isZero();

        productionTaskAppService.saveBom(bomRequest("BOM-A181-AUDIT", "A181-M", "A181-C"));
        replaceBomLineMaterial("BOM-A181-AUDIT", "A181-M");

        assertDirectSelfReferenceRejected(() -> productionTaskAppService.bomAuditPreview("BOM-A181-AUDIT"));
        assertDirectSelfReferenceRejected(() -> productionTaskAppService.auditBom("BOM-A181-AUDIT"));
        assertThat(bomAuditStatus("BOM-A181-AUDIT")).isEqualTo("DRAFT");

        replaceBomLineMaterial("BOM-A181-AUDIT", "A181-C");
        productionTaskAppService.auditBom("BOM-A181-AUDIT");
        assertThat(bomAuditStatus("BOM-A181-AUDIT")).isEqualTo("AUDITED");

        productionTaskAppService.reverseBom("BOM-A181-AUDIT");
        assertThat(bomAuditStatus("BOM-A181-AUDIT")).isEqualTo("DRAFT");
        replaceBomLineMaterial("BOM-A181-AUDIT", "A181-M");

        assertDirectSelfReferenceRejected(() -> productionTaskAppService.auditBom("BOM-A181-AUDIT"));
        assertThat(bomAuditStatus("BOM-A181-AUDIT")).isEqualTo("DRAFT");
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

    private ProductionTaskAppService.BomRequest bomRequest(String bomCode, String parentCode, String materialCode) {
        return new ProductionTaskAppService.BomRequest(
            bomCode,
            parentCode,
            BigDecimal.ONE,
            "自制BOM",
            "",
            List.of(new ProductionTaskAppService.BomLineRequest(
                materialCode,
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
        );
    }

    private void replaceBomLineMaterial(String bomCode, String materialCode) {
        jdbcTemplate.update("""
            UPDATE prod_bom_line line
            SET material_id = material.id
            FROM prod_bom bom, md_product material
            WHERE line.bom_id = bom.id
              AND bom.code = ?
              AND material.code = ?
            """, bomCode, materialCode);
    }

    private String bomAuditStatus(String bomCode) {
        return jdbcTemplate.queryForObject(
            "SELECT audit_status FROM prod_bom WHERE code = ?",
            String.class,
            bomCode
        );
    }

    private void assertDirectSelfReferenceRejected(Runnable action) {
        assertThatThrownBy(action::run)
            .isInstanceOfSatisfying(ResponseStatusException.class, exception -> {
                assertThat(exception.getStatusCode().value()).isEqualTo(400);
                assertThat(exception.getReason()).contains("子件物料不能与母件相同");
            });
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

    private void assertBomListRow(String expectedProductName) {
        var row = listSeedRowsProvider.seedRows("bom-list", "header", 20).stream()
            .filter(candidate -> "BOM-A119".equals(candidate.get("code")))
            .findFirst()
            .orElseThrow();
        assertThat(String.valueOf(row.get("productName"))).isEqualTo(expectedProductName);
        assertThat(String.valueOf(row.get("auditStatus"))).isEqualTo("已审核");
        assertThat(String.valueOf(row.get("status"))).isEqualTo("启用");
        assertThat(String.valueOf(row.get("isCurrent"))).isEqualTo("是");
        assertThat(String.valueOf(row.get("updatedBy"))).isNotBlank().isNotEqualTo("-");
    }

    private String quoteIdentifier(String identifier) {
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }
}
