package com.jdy.erp.reports.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;

import com.jdy.erp.reports.application.ReportQuerySpec.SortDirection;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

class ReportQuerySpecRegistryTest {
    @Test
    void productionFoundationMayStartWithNoBusinessKeysAndUnknownIsExact404() {
        var registry = new ReportQuerySpecRegistry(List.of());

        assertThat(registry.size()).isZero();
        for (var key : List.of(
            "sales-detail",
            "inventory-movement-detail",
            "receivable-detail",
            "material-scrap-summary",
            "random-report"
        )) {
            assertThatThrownBy(() -> registry.require(key))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                    .isEqualTo(HttpStatus.NOT_FOUND));
        }
    }

    @Test
    void productionComponentWiringContributesNoSampleOrBusinessDefinition() {
        try (var context = new AnnotationConfigApplicationContext()) {
            context.register(ReportQuerySpecRegistry.class);
            context.refresh();

            assertThat(context.getBean(ReportQuerySpecRegistry.class).size()).isZero();
            assertThat(context.getBeansOfType(ReportQuerySpec.class)).isEmpty();
        }
    }

    @Test
    void duplicateKeysFailApplicationStartupInsteadOfChoosingADefault() {
        var first = fixtureSpec();
        var second = fixtureSpec();

        assertThatThrownBy(() -> new ReportQuerySpecRegistry(List.of(first, second)))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("duplicate report key");
    }

    @Test
    void trustedDefinitionRejectsSqlChainingUnsafeColumnsAndIncompleteOrdering() {
        assertThatThrownBy(() -> ReportQuerySpec.builder(
            "fixture-report",
            "report.fixture.view",
            "SELECT 1 AS \"id\"; DELETE FROM anything"
        ).build()).isInstanceOf(IllegalArgumentException.class).hasMessageContaining("one comment-free statement");

        assertThatThrownBy(() -> ReportQuerySpec.builder(
            "fixture-report",
            "report.fixture.view",
            "SELECT 1 AS \"id\""
        ).sortField("id", "id;drop")
            .defaultSort("id", SortDirection.ASC)
            .stableSort("id", SortDirection.ASC)
            .csvColumn("ID", "id", true)
            .build())
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("sort column is invalid");

        assertThatThrownBy(() -> ReportQuerySpec.builder(
            "fixture-report",
            "report.fixture.view",
            "SELECT 1 AS \"id\""
        ).sortField("id", "id")
            .defaultSort("id", SortDirection.ASC)
            .csvColumn("ID", "id", true)
            .build())
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("stable sort must not be empty");

        assertThatThrownBy(() -> ReportQuerySpec.builder(
            "fixture-report",
            "report.fixture.view",
            "SELECT 1 AS \"id\""
        ).sortField("id", "id")
            .defaultSort("id", SortDirection.ASC)
            .stableSort("id", SortDirection.ASC)
            .csvColumn("ID", "id", true)
            .build())
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("unique and non-null field");

        for (var schemaQualifiedRelation : List.of(
            "SELECT * FROM PUBLIC   . md_product",
            "SELECT * FROM \"public\" \n . md_product",
            "SELECT * FROM tenant_a.report_fixture",
            "SELECT * FROM \"tenant_a\" . \"report_fixture\"",
            "SELECT a.id FROM report_fixture a JOIN tenant_b.customer b ON b.id = a.customer_id",
            "SELECT * FROM LATERAL tenant_c.report_rows()",
            "SELECT * FROM report_fixture a, tenant_d.customer b",
            "SELECT * FROM ONLY (tenant_e.report_fixture)",
            "WITH base AS (SELECT * FROM tenant_f.report_fixture) SELECT * FROM base",
            "WITH base AS (SELECT 1 AS id) TABLE tenant_g.report_fixture",
            "SELECT * FROM (SELECT * FROM \"tenant h\" . \"report fixture\") nested",
            "SELECT * FROM report_fixture a LEFT JOIN LATERAL tenant_i.rows(a.id) r ON TRUE",
            "SELECT * FROM (report_fixture a JOIN tenant_l.customer b ON b.id = a.customer_id) joined",
            "SELECT * FROM (report_fixture a JOIN (customer b JOIN tenant_m.address c ON TRUE) ON TRUE) joined",
            "SELECT * FROM ONLY ((tenant_n.report_fixture))"
        )) {
            assertThatThrownBy(() -> ReportQuerySpec.builder(
                "fixture-report",
                "report.fixture.view",
                schemaQualifiedRelation
            ).build())
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("relations must be unqualified");
        }

        assertThatThrownBy(() -> ReportQuerySpec.builder(
            "fixture-report",
            "report.fixture.view",
            "SELECT * FROM U&\"tenant_j\".report_fixture"
        ).build())
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("Unicode escape quoting");

        assertThatThrownBy(() -> ReportQuerySpec.builder(
            "fixture-report",
            "report.fixture.view",
            "WITH changed AS (DELETE FROM tenant_k.report_fixture RETURNING *) SELECT * FROM changed"
        ).build())
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("read-only SELECT");

        for (var allowedSource : List.of(
            "SELECT id FROM report_fixture",
            "SELECT a.id FROM report_fixture a JOIN customer b ON b.id = a.customer_id",
            "WITH base AS (SELECT id FROM report_fixture) SELECT id FROM base",
            "SELECT EXTRACT(YEAR FROM a.bill_date) AS id FROM report_fixture a",
            "SELECT id FROM report_fixture a, customer b WHERE b.id = a.customer_id",
            "SELECT * FROM LATERAL report_rows()",
            "SELECT a.id FROM (report_fixture a JOIN customer b ON b.id = a.customer_id)"
        )) {
            assertThat(minimalBuilder(allowedSource).build().sourceSql()).isEqualTo(allowedSource);
        }
    }

    @Test
    void requiredDateRangeAndUniqueSortContractsFailClosedAtDefinitionStartup() {
        assertThatThrownBy(() -> minimalBuilder().requiredDateRange().build())
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("both DATE_FROM and DATE_TO");

        assertThatThrownBy(() -> minimalBuilder()
            .requiredDateRange()
            .bindSourceDateFrom()
            .build())
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("both DATE_FROM and DATE_TO");

        assertThatThrownBy(() -> minimalBuilder()
            .requiredDateRange()
            .bindSourceDateTo()
            .build())
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("both DATE_FROM and DATE_TO");

        assertThatThrownBy(() -> ReportQuerySpec.builder(
            "fixture-report",
            "report.fixture.view",
            "SELECT 1 AS \"id\""
        ).uniqueNonNullStableSort(null, SortDirection.ASC))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("sort field");

        assertThat(fixtureSpec().uniqueNonNullStableSort())
            .isEqualTo(new ReportQuerySpec.SortTerm("id", SortDirection.ASC));
    }

    @Test
    void resultStageOnlyReadsControlledFactAndBoundFiltersCannotLeakIntoResultPredicate() {
        for (var unsafeResult : List.of(
            "SELECT * FROM tenant_a.report_fact",
            "SELECT * FROM other_fact",
            "WITH leaked AS (SELECT * FROM report_fact) SELECT * FROM leaked",
            "SELECT * FROM report_fact; DELETE FROM report_fixture"
        )) {
            assertThatThrownBy(() -> minimalBuilder()
                .resultSql(unsafeResult)
                .build())
                .isInstanceOf(IllegalArgumentException.class);
        }

        assertThat(minimalBuilder()
            .resultSql("SELECT report_fact.* FROM report_fact")
            .build()
            .resultSql()).isEqualTo("SELECT report_fact.* FROM report_fact");

        assertThat(minimalBuilder()
            .resultSql("SELECT nested.* FROM (SELECT report_fact.* FROM report_fact) nested")
            .build()
            .resultSql()).contains("FROM report_fact");

        assertThatThrownBy(() -> minimalBuilder()
            .filter(ReportQuerySpec.FilterDefinition.enumEqualsDefault(
                "dimension",
                "dimension",
                ReportQuerySpec.PredicatePlacement.BOUND_ONLY,
                "CUSTOMER",
                "CUSTOMER",
                "PRODUCT"
            ))
            .build())
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("must have a source or result binding");

        assertThatThrownBy(() -> minimalBuilder()
            .filter(ReportQuerySpec.FilterDefinition.contains(
                "dimension",
                "dimension",
                ReportQuerySpec.PredicatePlacement.BOUND_ONLY
            ))
            .bindResultFilter("dimension")
            .build())
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("bound-only filter cannot use contains");

        assertThatThrownBy(() -> minimalBuilder()
            .filter(ReportQuerySpec.FilterDefinition.enumEquals(
                "dimension",
                "dimension",
                ReportQuerySpec.PredicatePlacement.RESULT,
                "CUSTOMER",
                "PRODUCT"
            ))
            .bindSourceFilter("dimension")
            .build())
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("must not be repeated as a result predicate");
    }

    @Test
    void dataScopeDefinitionAcceptsOnlyCanonicalServerOwnedNamespaces() {
        var scoped = ReportQueryParserPlannerTest.dataScopeSpec();

        assertThat(scoped.dataScopeNamespaces()).containsExactly("reporting");
        assertThat(scoped.sourceParameters()).singleElement().satisfies(binding -> {
            assertThat(binding.kind()).isEqualTo(ReportQuerySpec.SourceParameterKind.DATA_SCOPE);
            assertThat(binding.dataScopeNamespace()).isEqualTo("reporting");
            assertThat(binding.filterParameter()).isNull();
            assertThat(binding.fixedValue()).isNull();
        });
        assertThatThrownBy(() -> minimalBuilder()
            .bindSourceDataScope("Reporting; DROP SCHEMA public")
            .build())
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("data-scope namespace");
        assertThatThrownBy(() -> minimalBuilder()
            .filter(ReportQuerySpec.FilterDefinition.equals(
                "dataScopeId",
                "id",
                ReportQuerySpec.ValueType.UUID
            )))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("reserved");
        assertThatThrownBy(() -> minimalBuilder()
            .bindSourceDataScope("page")
            .build())
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("must not overlap a client parameter");
        assertThatThrownBy(() -> minimalBuilder()
            .filter(ReportQuerySpec.FilterDefinition.equals(
                "reporting",
                "id",
                ReportQuerySpec.ValueType.UUID
            ))
            .bindSourceDataScope("reporting")
            .build())
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("must not overlap a client parameter");
    }

    static ReportQuerySpec fixtureSpec() {
        return ReportQuerySpec.builder(
            "fixture-report",
            "report.fixture.view",
            """
                SELECT id AS "id", bill_date AS "businessDate", bill_no AS "billNo", customer_id AS "customerId",
                       customer_name AS "customerName", amount AS "amount", currency AS "currency"
                FROM report_fixture
                WHERE audit_status = 'AUDITED'
                """
        )
            .requiredDateRange("businessDate")
            .keywordColumns("billNo", "customerName")
            .filter(ReportQuerySpec.FilterDefinition.equals(
                "customerId", "customerId", ReportQuerySpec.ValueType.UUID
            ))
            .filter(ReportQuerySpec.FilterDefinition.enumEquals(
                "currency", "currency", "CNY", "USD"
            ))
            .filter(ReportQuerySpec.FilterDefinition.contains("billNumber", "billNo"))
            .sortField("businessDate", "businessDate")
            .sortField("billNo", "billNo")
            .sortField("amount", "amount")
            .sortField("id", "id")
            .defaultSort("businessDate", SortDirection.DESC)
            .stableSort("businessDate", SortDirection.DESC)
            .stableSort("billNo", SortDirection.ASC)
            .uniqueNonNullStableSort("id", SortDirection.ASC)
            .totalGroupColumns("currency")
            .totalSum("amount", "amount")
            .csvColumn("单号", "billNo", true)
            .csvColumn("客户", "customerName", false)
            .csvColumn("金额", "amount", false)
            .csvColumn("币种", "currency", true)
            .build();
    }

    private ReportQuerySpec.Builder minimalBuilder() {
        return minimalBuilder("SELECT 1 AS \"id\"");
    }

    private ReportQuerySpec.Builder minimalBuilder(String sourceSql) {
        return ReportQuerySpec.builder(
            "fixture-report",
            "report.fixture.view",
            sourceSql
        )
            .sortField("id", "id")
            .defaultSort("id", SortDirection.ASC)
            .uniqueNonNullStableSort("id", SortDirection.ASC)
            .csvColumn("ID", "id", true);
    }
}
