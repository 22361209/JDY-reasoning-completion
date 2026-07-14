package com.jdy.erp.system.application.list;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.when;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;

import com.jdy.erp.production.application.MaterialScrapAppServiceIntegrationTest.Fixture;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantContext;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

@SpringBootTest
class MaterialScrapListQueryAdapterIntegrationTest {
    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private MaterialScrapListQueryAdapter adapter;

    @Autowired
    private ListQueryContractRegistry contractRegistry;

    @Autowired
    private ListQuerySupport support;

    @MockitoBean
    private CurrentSessionService currentSessionService;

    private Map<String, Object> accountSet;
    private Fixture fixture;

    @BeforeEach
    void setUp() {
        accountSet = jdbcTemplate.queryForMap("""
            SELECT id::text AS id,
                   code,
                   name,
                   COALESCE(database_name, '') AS "databaseName",
                   COALESCE(schema_name, '') AS "schemaName",
                   COALESCE(redis_key_prefix, '') AS "redisKeyPrefix",
                   COALESCE(attachment_prefix, '') AS "attachmentPrefix"
            FROM sys_account_set
            WHERE code = 'BLD-TEST'
            """);
        when(currentSessionService.currentAccountSetId()).thenReturn(String.valueOf(accountSet.get("id")));
        when(currentSessionService.currentAccountSetCode()).thenReturn("BLD-TEST");
        TenantContext.setTenant(accountSet);
        var request = new MockHttpServletRequest();
        request.getSession(true).setAttribute(CurrentSessionService.SESSION_USERNAME, "admin");
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
        fixture = new Fixture(jdbcTemplate, String.valueOf(accountSet.get("id")));
    }

    @AfterEach
    void tearDown() {
        try {
            if (fixture != null) {
                fixture.clean();
            }
        } finally {
            TenantContext.clear();
            RequestContextHolder.resetRequestAttributes();
        }
    }

    @Test
    void formalListUsesRealCountLimitOffsetStatusAndDetailPredicates() {
        var older = fixture.insertScrap("LIST-OLD", "DRAFT", LocalDate.of(2026, 7, 13), BigDecimal.ONE);
        var newer = fixture.insertScrap("LIST-NEW", "AUDITED", LocalDate.of(2026, 7, 14), new BigDecimal("2"));
        var contract = contractRegistry.contractFor("material-scrap-form-list", "header");

        var firstPage = adapter.query(
            request("material-scrap-form-list", fixture.prefix(), "", 1, 1, "header", ""),
            contract,
            support,
            noSeedRows()
        );
        var secondPage = adapter.query(
            request("material-scrap-form-list", fixture.prefix(), "", 2, 1, "header", ""),
            contract,
            support,
            noSeedRows()
        );
        assertThat(firstPage.total()).isEqualTo(2);
        assertThat(firstPage.rows()).hasSize(1);
        assertThat(secondPage.total()).isEqualTo(2);
        assertThat(secondPage.rows()).hasSize(1);
        assertThat(List.of(
            String.valueOf(firstPage.rows().getFirst().get("billNo")),
            String.valueOf(secondPage.rows().getFirst().get("billNo"))
        )).containsExactlyInAnyOrder(older.billNo(), newer.billNo());

        var auditedOnly = adapter.query(
            request("material-scrap-form-list", fixture.prefix(), "AUDITED", 1, 20, "header", ""),
            contract,
            support,
            noSeedRows()
        );
        assertThat(auditedOnly.total()).isEqualTo(1);
        assertThat(auditedOnly.rows()).singleElement().satisfies(row -> {
            assertThat(String.valueOf(row.get("billNo"))).isEqualTo(newer.billNo());
            assertThat(String.valueOf(row.get("statusCode"))).isEqualTo("AUDITED");
        });

        var detailContract = contractRegistry.contractFor("material-scrap-form-list", "detail");
        var detail = adapter.query(
            request("material-scrap-form-list", fixture.productCode(), "", 1, 20, "detail", ""),
            detailContract,
            support,
            noSeedRows()
        );
        assertThat(detail.total()).isEqualTo(2);
        assertThat(detail.rows()).allSatisfy(row -> {
            assertThat(String.valueOf(row.get("productCode"))).isEqualTo(fixture.productCode());
            assertThat(String.valueOf(row.get("sourceIssueNo"))).isEqualTo(fixture.sourceIssueNo());
        });
    }

    @Test
    void sourceSelectorSharesTheExecutablePredicateAndAuditedQuota() {
        fixture.insertScrap("SOURCE-DRAFT", "DRAFT", LocalDate.of(2026, 7, 13), new BigDecimal("4"));
        fixture.insertScrap("SOURCE-AUDITED", "AUDITED", LocalDate.of(2026, 7, 14), new BigDecimal("2"));
        var contract = contractRegistry.contractFor("material-scrap-source-selector", "detail");

        var result = adapter.query(
            request("material-scrap-source-selector", fixture.sourceIssueNo(), "", 1, 20, "detail", ""),
            contract,
            support,
            noSeedRows()
        );

        assertThat(result.total()).isEqualTo(1);
        assertThat(result.rows()).singleElement().satisfies(row -> {
            assertThat(String.valueOf(row.get("billNo"))).isEqualTo(fixture.sourceIssueNo());
            assertThat(String.valueOf(row.get("sourceIssueLineId"))).isEqualTo(fixture.sourceIssueLineId());
            assertThat((BigDecimal) row.get("availableScrapQty")).isEqualByComparingTo("3");
        });

        fixture.insertScrap("SOURCE-EXHAUSTED", "AUDITED", LocalDate.of(2026, 7, 14), new BigDecimal("3"));
        assertThat(adapter.query(
            request("material-scrap-source-selector", fixture.sourceIssueNo(), "", 1, 20, "detail", ""),
            contract,
            support,
            noSeedRows()
        ).rows()).isEmpty();
    }

    @Test
    void sourceSelectorDynamicallyRechecksEveryExecutableSourcePredicate() {
        var contract = contractRegistry.contractFor("material-scrap-source-selector", "detail");
        assertSourceAvailable(contract, "baseline");

        jdbcTemplate.update(
            "UPDATE production_material_issue SET status = 'DRAFT' WHERE id = ?::uuid",
            fixture.sourceIssueId()
        );
        assertSourceEmpty(contract, "source status");
        jdbcTemplate.update(
            "UPDATE production_material_issue SET status = 'AUDITED' WHERE id = ?::uuid",
            fixture.sourceIssueId()
        );
        assertSourceAvailable(contract, "source status restored");

        jdbcTemplate.update(
            "UPDATE production_material_issue SET close_status = 'CLOSED' WHERE id = ?::uuid",
            fixture.sourceIssueId()
        );
        assertSourceEmpty(contract, "source close status");
        jdbcTemplate.update(
            "UPDATE production_material_issue SET close_status = 'OPEN' WHERE id = ?::uuid",
            fixture.sourceIssueId()
        );
        assertSourceAvailable(contract, "source close status restored");

        jdbcTemplate.update(
            "UPDATE production_material_issue SET frozen_status = 'FROZEN' WHERE id = ?::uuid",
            fixture.sourceIssueId()
        );
        assertSourceEmpty(contract, "source frozen status");
        jdbcTemplate.update(
            "UPDATE production_material_issue SET frozen_status = 'NORMAL' WHERE id = ?::uuid",
            fixture.sourceIssueId()
        );
        assertSourceAvailable(contract, "source frozen status restored");

        var redId = jdbcTemplate.queryForObject("""
            INSERT INTO production_material_issue (bill_no, task_id, red_source_bill_id, status)
            VALUES (?, ?::uuid, ?::uuid, 'DRAFT')
            RETURNING id::text
            """, String.class, fixture.prefix() + "-SELECTOR-RED", fixture.taskId(), fixture.sourceIssueId());
        assertSourceEmpty(contract, "non-VOID red child");
        jdbcTemplate.update("DELETE FROM production_material_issue WHERE id = ?::uuid", redId);
        assertSourceAvailable(contract, "red child removed");

        jdbcTemplate.update(
            "UPDATE md_production_department SET enabled = FALSE WHERE code = ?",
            fixture.workshopCode()
        );
        assertSourceEmpty(contract, "workshop disabled");
        jdbcTemplate.update(
            "UPDATE md_production_department SET enabled = TRUE, audit_status = 'DRAFT' WHERE code = ?",
            fixture.workshopCode()
        );
        assertSourceEmpty(contract, "workshop unaudited");
        jdbcTemplate.update(
            "UPDATE md_production_department SET audit_status = 'AUDITED' WHERE code = ?",
            fixture.workshopCode()
        );
        assertSourceAvailable(contract, "workshop restored");
    }

    @Test
    void adapterRejectsEveryContractOutsideItsTwoExplicitKeys() {
        var unsupported = new ListQueryContract(
            "material-issue-form-list",
            "header",
            List.of(),
            "billDate",
            "row",
            "header",
            "materialScrap",
            false
        );
        assertThatThrownBy(() -> adapter.query(
            request("material-issue-form-list", "", "", 1, 20, "header", ""),
            unsupported,
            support,
            noSeedRows()
        )).isInstanceOfSatisfying(org.springframework.web.server.ResponseStatusException.class, error ->
            assertThat(error.getStatusCode()).isEqualTo(org.springframework.http.HttpStatus.NOT_FOUND));

        var wrongAdapter = new ListQueryContract(
            "material-scrap-form-list",
            "header",
            List.of(),
            "billDate",
            "row",
            "header",
            "default",
            false
        );
        assertThatThrownBy(() -> adapter.query(
            request("material-scrap-form-list", "", "", 1, 20, "header", ""),
            wrongAdapter,
            support,
            noSeedRows()
        )).isInstanceOf(IllegalArgumentException.class);
    }

    private ListQueryRequest request(
        String listKey,
        String keyword,
        String status,
        int page,
        int pageSize,
        String view,
        String columnFilters
    ) {
        return new ListQueryRequest(
            listKey,
            keyword,
            status,
            page,
            pageSize,
            view,
            "",
            "desc",
            columnFilters,
            "",
            "",
            "",
            "",
            "",
            "current",
            "",
            "",
            false
        );
    }

    private void assertSourceAvailable(ListQueryContract contract, String predicate) {
        var result = querySource(contract);
        assertThat(result.total()).as(predicate).isEqualTo(1);
        assertThat(result.rows()).as(predicate).hasSize(1);
    }

    private void assertSourceEmpty(ListQueryContract contract, String predicate) {
        var result = querySource(contract);
        assertThat(result.total()).as(predicate).isZero();
        assertThat(result.rows()).as(predicate).isEmpty();
    }

    private ListQueryResult querySource(ListQueryContract contract) {
        return adapter.query(
            request("material-scrap-source-selector", fixture.sourceIssueNo(), "", 1, 20, "detail", ""),
            contract,
            support,
            noSeedRows()
        );
    }

    private ListSeedRowsProvider noSeedRows() {
        return (listKey, view, pageSize) -> {
            throw new AssertionError("material scrap adapter must never use seed rows");
        };
    }
}
