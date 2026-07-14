package com.jdy.erp.system.tenant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.jdy.erp.production.application.MaterialScrapAppService;
import com.jdy.erp.production.application.MaterialScrapAppService.ScrapDraftRequest;
import com.jdy.erp.production.application.MaterialScrapAppService.ScrapLineRequest;
import com.jdy.erp.production.application.MaterialScrapAppServiceIntegrationTest.Fixture;
import com.jdy.erp.system.application.AccountSetManagementService;
import com.jdy.erp.system.application.list.ListQueryContractRegistry;
import com.jdy.erp.system.application.list.ListQueryRequest;
import com.jdy.erp.system.application.list.ListQueryService;
import com.jdy.erp.system.application.list.ListSeedRowsProvider;
import com.jdy.erp.system.security.CurrentSessionService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import org.springframework.web.server.ResponseStatusException;

@SpringBootTest
class TenantMaterialScrapIsolationTest {
    @Autowired
    private AccountSetManagementService accountSetManagementService;

    @Autowired
    private CurrentSessionService currentSessionService;

    @Autowired
    private MaterialScrapAppService materialScrapAppService;

    @Autowired
    private ListQueryService listQueryService;

    @Autowired
    private ListQueryContractRegistry contractRegistry;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    @Qualifier("platformJdbcTemplate")
    private JdbcTemplate platformJdbcTemplate;

    @Autowired
    private TenantDataSourceRegistry tenantDataSourceRegistry;

    @Autowired
    private TenantDataScopeService tenantDataScopeService;

    private final List<String> createdCodes = new ArrayList<>();
    private final List<String> createdSchemas = new ArrayList<>();
    private String tenantA;
    private String tenantB;
    private Fixture fixtureA;
    private Fixture fixtureB;

    @BeforeEach
    void setUp() {
        useTenant("BLD-TEST");
        tenantA = createManagedAccountSet("A151MSA");
        tenantB = createManagedAccountSet("A151MSB");
    }

    @AfterEach
    void tearDown() {
        try {
            if (fixtureA != null && tenantA != null) {
                useTenant(tenantA);
                fixtureA.clean();
            }
            if (fixtureB != null && tenantB != null) {
                useTenant(tenantB);
                fixtureB.clean();
            }
        } finally {
            TenantContext.clear();
            RequestContextHolder.resetRequestAttributes();
            tenantDataSourceRegistry.close();
            for (var schema : createdSchemas) {
                platformJdbcTemplate.execute("DROP SCHEMA IF EXISTS " + quoteIdentifier(schema) + " CASCADE");
            }
            for (var code : createdCodes) {
                platformJdbcTemplate.update("DELETE FROM sys_account_set_backup WHERE account_set_code = ?", code);
                platformJdbcTemplate.update("""
                    DELETE FROM sys_user_account_set
                    WHERE account_set_id IN (SELECT id FROM sys_account_set WHERE code = ?)
                    """, code);
                platformJdbcTemplate.update("DELETE FROM sys_account_set WHERE code = ?", code);
            }
        }
    }

    @Test
    void sameBillNumberFactsListsInventoryAndLogsStayInsideEachRoutedTenant() {
        useTenant(tenantA);
        seedFixtureReferences();
        fixtureA = new Fixture(jdbcTemplate, tenantDataScopeService.currentScopeId("inventory"));
        var a = createAndAudit(fixtureA, "A tenant reason");
        assertThat(fixtureA.scrapTxnCount(a.id())).isEqualTo(1);
        assertThat(fixtureA.balance(fixtureA.targetWarehouseId())).isEqualByComparingTo("1");
        assertThat(queryList(fixtureA.prefix())).singleElement().satisfies(row -> {
            assertThat(String.valueOf(row.get("billNo"))).isEqualTo(a.billNo());
            assertThat(String.valueOf(row.get("workshopCode"))).isEqualTo(fixtureA.workshopCode());
        });

        useTenant(tenantB);
        assertThatThrownBy(() -> materialScrapAppService.detail(a.billNo()))
            .isInstanceOfSatisfying(ResponseStatusException.class, error ->
                assertThat(error.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));
        assertThat(queryList(fixtureA.prefix())).isEmpty();
        assertThat(fixtureA.balance(fixtureA.targetWarehouseId())).isEqualByComparingTo("0");
        seedFixtureReferences();
        fixtureB = new Fixture(jdbcTemplate, tenantDataScopeService.currentScopeId("inventory"));
        var b = createAndAudit(fixtureB, "B tenant reason");

        assertThat(b.billNo()).isEqualTo(a.billNo());
        assertThat(fixtureB.scrapTxnCount(b.id())).isEqualTo(1);
        assertThat(fixtureB.balance(fixtureB.targetWarehouseId())).isEqualByComparingTo("1");
        assertThat(queryList(fixtureB.prefix())).singleElement().satisfies(row -> {
            assertThat(String.valueOf(row.get("billNo"))).isEqualTo(b.billNo());
            assertThat(String.valueOf(row.get("workshopCode"))).isEqualTo(fixtureB.workshopCode());
        });
        assertThat(document(materialScrapAppService.detail(b.billNo())))
            .containsEntry("sourceIssueNo", fixtureB.sourceIssueNo())
            .doesNotContainEntry("sourceIssueNo", fixtureA.sourceIssueNo());
        assertThat(jdbcTemplate.queryForObject("""
            SELECT count(*)::int
            FROM sys_operation_log
            WHERE target_no = ?
              AND account_set_code = ?
            """, Integer.class, b.billNo(), tenantB)).isPositive();

        useTenant(tenantA);
        assertThat(fixtureA.balance(fixtureA.targetWarehouseId())).isEqualByComparingTo("1");
        assertThat(fixtureB.balance(fixtureB.targetWarehouseId())).isEqualByComparingTo("0");
        assertThat(document(materialScrapAppService.detail(a.billNo())))
            .containsEntry("sourceIssueNo", fixtureA.sourceIssueNo())
            .doesNotContainEntry("sourceIssueNo", fixtureB.sourceIssueNo());
        assertThat(queryList(fixtureB.prefix())).isEmpty();
        assertThat(jdbcTemplate.queryForObject("""
            SELECT count(*)::int
            FROM sys_operation_log
            WHERE target_no = ?
              AND account_set_code = ?
            """, Integer.class, a.billNo(), tenantA)).isPositive();

        assertThat(platformJdbcTemplate.queryForObject("""
            SELECT count(*)::int
            FROM public.production_material_scrap
            WHERE workshop_code_snapshot IN (?, ?)
            """, Integer.class, fixtureA.workshopCode(), fixtureB.workshopCode())).isZero();
        assertThat(platformJdbcTemplate.queryForObject("""
            SELECT count(*)::int
            FROM public.inv_stock_balance
            WHERE warehouse_id IN (?::uuid, ?::uuid)
            """, Integer.class, fixtureA.targetWarehouseId(), fixtureB.targetWarehouseId())).isZero();
        for (var tenantIdentity : List.of(a, b)) {
            assertThat(platformJdbcTemplate.queryForObject("""
                SELECT count(*)::int
                FROM public.sys_operation_log
                WHERE target_id = ?::uuid
                   OR target_no = ?
                """, Integer.class, tenantIdentity.id(), tenantIdentity.billNo()))
                .as(tenantIdentity.id())
                .isZero();
        }
    }

    private ScrapIdentity createAndAudit(Fixture fixture, String reason) {
        var pushed = fixture.trackScrap(materialScrapAppService.pushFromIssue(fixture.sourceIssueNo(), null));
        var billNo = String.valueOf(pushed.get("billNo"));
        materialScrapAppService.saveDraft(new ScrapDraftRequest(
            billNo,
            fixture.sourceIssueNo(),
            LocalDate.of(2026, 7, 14),
            "PRODUCTION_SCRAP",
            List.of(new ScrapLineRequest(
                fixture.sourceIssueLineId(),
                BigDecimal.ONE,
                reason,
                BigDecimal.ZERO,
                true,
                fixture.targetWarehouseCode()
            ))
        ));
        materialScrapAppService.audit(billNo);
        materialScrapAppService.stockIn(billNo);
        return new ScrapIdentity(String.valueOf(pushed.get("id")), billNo);
    }

    private List<Map<String, ?>> queryList(String keyword) {
        var result = listQueryService.query(new ListQueryRequest(
            "material-scrap-form-list",
            keyword,
            "",
            1,
            20,
            "header",
            "",
            "desc",
            "",
            "",
            "",
            "",
            "",
            "",
            "current",
            "",
            "",
            false
        ), noSeedRows());
        assertThat(contractRegistry.contractFor("material-scrap-form-list", "header").adapterKey())
            .isEqualTo("materialScrap");
        return result.rows();
    }

    private ListSeedRowsProvider noSeedRows() {
        return (listKey, view, pageSize) -> {
            throw new AssertionError("material scrap must not read seed rows");
        };
    }

    private void seedFixtureReferences() {
        jdbcTemplate.update("""
            INSERT INTO md_product_category (code, name, sort_no, enabled)
            VALUES ('YCL', 'A151 材料报废原材料', 20, TRUE)
            ON CONFLICT (code) DO NOTHING
            """);
        jdbcTemplate.update("""
            INSERT INTO md_unit (code, name, decimal_places, sort_no, enabled)
            VALUES ('PCS', 'A151 材料报废 PCS', 0, 10, TRUE)
            ON CONFLICT (code) DO NOTHING
            """);
    }

    private String createManagedAccountSet(String prefix) {
        var code = prefix + "-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();
        createdCodes.add(code);
        var result = accountSetManagementService.createAccountSet(new AccountSetManagementService.AccountSetCreateRequest(
            code,
            code + " 材料报废隔离账套",
            "A151 tenant isolation",
            null,
            null,
            null,
            null,
            "2026-07",
            "2026-07"
        ));
        @SuppressWarnings("unchecked")
        var row = (Map<String, Object>) result.get("accountSet");
        createdSchemas.add(String.valueOf(row.get("schemaName")));
        return code;
    }

    private void useTenant(String code) {
        TenantContext.clear();
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(new MockHttpServletRequest()));
        currentSessionService.login("admin", "admin123", code);
        TenantContext.setTenant(currentSessionService.currentAccountSet());
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> document(Map<String, Object> result) {
        return (Map<String, Object>) result.get("document");
    }

    private String quoteIdentifier(String value) {
        if (value == null || !value.matches("[A-Za-z_][A-Za-z0-9_]{0,62}")) {
            throw new IllegalArgumentException("Unsafe identifier: " + value);
        }
        return '"' + value + '"';
    }

    private record ScrapIdentity(String id, String billNo) {
    }
}
