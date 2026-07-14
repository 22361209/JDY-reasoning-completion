package com.jdy.erp.reports.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

class ReportQueryParserPlannerTest {
    private final ReportQueryParser parser = new ReportQueryParser();
    private final ReportQueryPlanner planner = new ReportQueryPlanner();
    private final ReportQuerySpec spec = ReportQuerySpecRegistryTest.fixtureSpec();

    @Test
    void normalizesStrictQueryAndBuildsWhitelistedAndOrPredicateWithEscapedLikeTerms() {
        var customerId = "00000000-0000-0000-0000-000000000145";
        var raw = new LinkedHashMap<String, List<String>>();
        raw.put("dateFrom", List.of("2026-07-01"));
        raw.put("dateTo", List.of("2026-07-14"));
        raw.put("keyword", List.of("  SO%   _A!  "));
        raw.put("customerId", List.of(customerId));
        raw.put("currency", List.of("USD"));
        raw.put("billNumber", List.of("A_100%"));
        raw.put("page", List.of("2"));
        raw.put("pageSize", List.of("50"));
        raw.put("sortField", List.of("amount"));
        raw.put("sortOrder", List.of("desc"));

        var query = parser.parse(spec, raw);
        var plan = planner.plan(spec, query);

        assertThat(query.page()).isEqualTo(2);
        assertThat(query.pageSize()).isEqualTo(50);
        assertThat(query.dateFrom()).isEqualTo(LocalDate.of(2026, 7, 1));
        assertThat(query.filters())
            .containsEntry("customerId", UUID.fromString(customerId))
            .containsEntry("currency", "USD")
            .containsEntry("billNumber", "A_100%");
        assertThat(query.echo())
            .containsEntry("dateFrom", "2026-07-01")
            .containsEntry("dateTo", "2026-07-14")
            .containsEntry("keyword", "SO% _A!")
            .containsEntry("sortField", "amount")
            .containsEntry("sortOrder", "desc");

        assertThat(plan.factPredicateSql()).isEqualTo("TRUE");
        assertThat(plan.factPredicateParameters()).isEmpty();
        assertThat(plan.resultPredicateSql())
            .contains("report_row.\"businessDate\" >= ?", "report_row.\"businessDate\" <= ?")
            .contains("report_row.\"billNo\" ILIKE ? ESCAPE '!' OR report_row.\"customerName\" ILIKE ? ESCAPE '!'")
            .contains("report_row.\"customerId\" = ?", "report_row.\"currency\" = ?")
            .contains("report_row.\"billNo\" ILIKE ? ESCAPE '!'")
            .doesNotContain("SO%", customerId, "USD");
        assertThat(plan.resultPredicateParameters()).containsExactly(
            LocalDate.of(2026, 7, 1),
            LocalDate.of(2026, 7, 14),
            "%SO!%%", "%SO!%%",
            "%!_A!!%", "%!_A!!%",
            UUID.fromString(customerId),
            "USD",
            "%A!_100!%%"
        );
        assertThat(plan.orderBySql()).isEqualTo(
            "report_row.\"amount\" DESC, report_row.\"businessDate\" DESC, "
                + "report_row.\"billNo\" ASC, report_row.\"id\" ASC"
        );
    }

    @Test
    void rejectsUnknownScopeJsonOperatorSortDateEnumPagingAndDuplicateInputsBeforePlanningSql() {
        assertBadRequest(Map.of("scope", List.of("all")));
        assertBadRequest(Map.of("tenantId", List.of("other")));
        assertBadRequest(Map.of("columnFilters", List.of("{}")));
        assertBadRequest(Map.of("operator", List.of("eq")));
        assertBadRequest(Map.of("sortField", List.of("amount desc; drop table x")));
        assertBadRequest(Map.of("sortOrder", List.of("desc")));
        assertBadRequest(Map.of("dateFrom", List.of("2026/07/01"), "dateTo", List.of("2026-07-14")));
        assertBadRequest(Map.of("dateFrom", List.of("2026-07-15"), "dateTo", List.of("2026-07-14")));
        assertBadRequest(validDatesWith("currency", List.of("EUR")));
        assertBadRequest(validDatesWith("pageSize", List.of("501")));
        assertBadRequest(validDatesWith("page", List.of("0")));
        assertBadRequest(validDatesWith("page", List.of("10001")));
        assertBadRequest(Map.of(
            "dateFrom", List.of("2026-07-01"),
            "dateTo", List.of("2026-07-14"),
            "page", List.of("3000"),
            "pageSize", List.of("500")
        ));
        assertBadRequest(validDatesWith("page", List.of("1", "2")));
    }

    @Test
    void requiresBothIsoDatesAndUsesTheDefinitionDefaultStableOrder() {
        assertBadRequest(Map.of());
        assertBadRequest(Map.of("dateFrom", List.of("2026-07-01")));

        var query = parser.parse(spec, validDatesWith(null, null));
        var plan = planner.plan(spec, query);

        assertThat(query.sortField()).isEqualTo("businessDate");
        assertThat(query.sortDirection()).isEqualTo(ReportQuerySpec.SortDirection.DESC);
        assertThat(plan.orderBySql()).isEqualTo(
            "report_row.\"businessDate\" DESC, report_row.\"billNo\" ASC, report_row.\"id\" ASC"
        );
    }

    @Test
    void summaryAndOpeningShapeBindsRepeatedDatesInsideFixedSourceWithoutAddingAnOuterDatePredicate() {
        var summary = ReportQuerySpec.builder(
            "fixture-summary",
            "report.fixture.view",
            """
                SELECT party_id AS "partyId", currency AS "currency",
                       party_id::text || ':' || currency AS "rowKey",
                       SUM(CASE WHEN business_date < ? THEN amount_delta ELSE 0 END) AS "openingAmount",
                       SUM(CASE WHEN business_date BETWEEN ? AND ? THEN occurrence_delta ELSE 0 END) AS "periodAmount",
                       SUM(CASE WHEN business_date <= ? THEN amount_delta ELSE 0 END) AS "endingAmount"
                FROM ar_fact
                GROUP BY party_id, currency
                """
        )
            .requiredDateRange()
            .bindSourceDateFrom()
            .bindSourceDateFrom()
            .bindSourceDateTo()
            .bindSourceDateTo()
            .filter(ReportQuerySpec.FilterDefinition.enumEquals("currency", "currency", "CNY", "USD"))
            .sortField("partyId", "partyId")
            .sortField("rowKey", "rowKey")
            .defaultSort("partyId", ReportQuerySpec.SortDirection.ASC)
            .uniqueNonNullStableSort("rowKey", ReportQuerySpec.SortDirection.ASC)
            .totalGroupColumns("currency")
            .totalSum("openingAmount", "openingAmount")
            .totalSum("periodAmount", "periodAmount")
            .totalSum("endingAmount", "endingAmount")
            .csvColumn("往来单位", "partyId", true)
            .csvColumn("币种", "currency", true)
            .csvColumn("期初", "openingAmount", false)
            .csvColumn("本期", "periodAmount", false)
            .csvColumn("期末", "endingAmount", false)
            .build();
        var query = parser.parse(summary, Map.of(
            "dateFrom", List.of("2026-07-01"),
            "dateTo", List.of("2026-07-14"),
            "currency", List.of("USD")
        ));

        var plan = planner.plan(summary, query);

        assertThat(summary.requiresDateRange()).isTrue();
        assertThat(summary.hasOuterDatePredicate()).isFalse();
        assertThat(plan.factPredicateSql()).isEqualTo("TRUE");
        assertThat(plan.resultPredicateSql()).isEqualTo("report_row.\"currency\" = ?");
        assertThat(plan.parametersWithSource(summary)).containsExactly(
            LocalDate.of(2026, 7, 1),
            LocalDate.of(2026, 7, 1),
            LocalDate.of(2026, 7, 14),
            LocalDate.of(2026, 7, 14),
            "USD"
        );
        assertThat(summary.sourceSql())
            .contains("business_date < ?", "business_date BETWEEN ? AND ?", "business_date <= ?")
            .doesNotContain("2026-07-01", "2026-07-14", "USD");
    }

    @Test
    void twoStageSummaryNormalizesDimensionDefaultAndPlacesAllDetailPredicatesBeforeAggregation() {
        var summary = twoStageSummarySpec();
        var customerId = "00000000-0000-0000-0000-000000000145";

        var query = parser.parse(summary, Map.of(
            "dateFrom", List.of("2026-07-01"),
            "dateTo", List.of("2026-07-14"),
            "keyword", List.of("Acme P-1"),
            "customerId", List.of(customerId),
            "currency", List.of("USD")
        ));
        var plan = planner.plan(summary, query);

        assertThat(query.filters()).containsEntry("dimension", "CUSTOMER");
        assertThat(query.echo()).containsEntry("dimension", "CUSTOMER");
        assertThat(plan.factPredicateSql())
            .contains(
                "report_fact_source.\"businessDate\" >= ?",
                "report_fact_source.\"businessDate\" <= ?",
                "report_fact_source.\"customerName\" ILIKE ? ESCAPE '!' OR "
                    + "report_fact_source.\"productName\" ILIKE ? ESCAPE '!'",
                "report_fact_source.\"customerId\" = ?",
                "report_fact_source.\"currency\" = ?"
            )
            .doesNotContain("dimension", "report_row");
        assertThat(plan.factPredicateSql().split("ILIKE", -1)).hasSize(5);
        assertThat(plan.resultPredicateSql()).isEqualTo("TRUE");
        assertThat(plan.resultPredicateParameters()).isEmpty();
        assertThat(plan.parametersWithSource(summary)).containsExactly(
            LocalDate.of(2026, 7, 1),
            LocalDate.of(2026, 7, 14),
            "%Acme%", "%Acme%",
            "%P-1%", "%P-1%",
            UUID.fromString(customerId),
            "USD",
            "CUSTOMER", "CUSTOMER", "CUSTOMER"
        );
        assertThat(summary.resultSql())
            .contains("FROM report_fact", "SUM(amount)")
            .doesNotContain("Acme", customerId, "USD");

        var productQuery = parser.parse(summary, Map.of(
            "dateFrom", List.of("2026-07-01"),
            "dateTo", List.of("2026-07-14"),
            "dimension", List.of("PRODUCT")
        ));
        var productPlan = planner.plan(summary, productQuery);
        assertThat(productQuery.filters()).containsEntry("dimension", "PRODUCT");
        assertThat(productQuery.echo()).containsEntry("dimension", "PRODUCT");
        assertThat(productPlan.factPredicateSql()).isEqualTo("report_fact_source.\"businessDate\" >= ? AND "
            + "report_fact_source.\"businessDate\" <= ?");
        assertThat(productPlan.resultPredicateSql()).isEqualTo("TRUE");
        assertThat(productPlan.parametersWithSource(summary)).containsExactly(
            LocalDate.of(2026, 7, 1),
            LocalDate.of(2026, 7, 14),
            "PRODUCT", "PRODUCT", "PRODUCT"
        );
        assertThat(summary.resultSql()).doesNotContain("PRODUCT");
    }

    @Test
    void codeDefinedRequiredEnumRejectsMissingAndInvalidWhileDefaultEnumIsEchoed() {
        var required = ReportQuerySpec.builder(
            "required-dimension",
            "report.fixture.view",
            "SELECT id AS \"id\", dimension AS \"dimension\" FROM report_fixture"
        )
            .filter(ReportQuerySpec.FilterDefinition.requiredEnumEquals(
                "dimension",
                "dimension",
                ReportQuerySpec.PredicatePlacement.RESULT,
                "CUSTOMER",
                "PRODUCT"
            ))
            .sortField("id", "id")
            .defaultSort("id", ReportQuerySpec.SortDirection.ASC)
            .uniqueNonNullStableSort("id", ReportQuerySpec.SortDirection.ASC)
            .csvColumn("ID", "id", true)
            .build();

        assertThatThrownBy(() -> parser.parse(required, Map.of()))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST))
            .hasMessageContaining("dimension");
        assertThatThrownBy(() -> parser.parse(required, Map.of("dimension", List.of("WAREHOUSE"))))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST));
        assertThatThrownBy(() -> parser.parse(twoStageSummarySpec(), Map.of(
            "dateFrom", List.of("2026-07-01"),
            "dateTo", List.of("2026-07-14"),
            "dimension", List.of("PRODUCT) FROM tenant_x.report_fixture --")
        )))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST));

        var defaulted = parser.parse(twoStageSummarySpec(), Map.of(
            "dateFrom", List.of("2026-07-01"),
            "dateTo", List.of("2026-07-14")
        ));
        assertThat(defaulted.filters()).containsEntry("dimension", "CUSTOMER");
        assertThat(defaulted.echo()).containsEntry("dimension", "CUSTOMER");
    }

    @Test
    void serverOwnedDataScopeCannotBeSubmittedOrEchoedAndRequiresOneResolvedImmutableSnapshot() {
        var scoped = dataScopeSpec();

        for (var forgedName : List.of(
            "scope", "scopeId", "schema", "accountSetId", "tenantId",
            "dataScope", "dataScopeId", "reporting", "reportScopeId"
        )) {
            assertThatThrownBy(() -> parser.parse(scoped, Map.of(
                forgedName, List.of("00000000-0000-0000-0000-000000000999")
            )))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                    .isEqualTo(HttpStatus.BAD_REQUEST));
        }

        var query = parser.parse(scoped, Map.of());
        var unresolved = planner.plan(scoped, query);
        assertThat(query.filters()).isEmpty();
        assertThat(query.echo()).doesNotContainKeys("scope", "scopeId", "dataScope", "dataScopeId", "reporting");
        assertThatThrownBy(() -> unresolved.parametersWithSource(scoped))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("data scope was not resolved");

        var scopeId = "00000000-0000-0000-0000-000000000145";
        var resolved = unresolved.withDataScopes(Map.of("reporting", scopeId));
        assertThat(resolved.dataScopeIds()).containsOnlyKeys("reporting").containsValue(scopeId);
        assertThat(resolved.parametersWithSource(scoped)).containsExactly(scopeId, scopeId, scopeId);
        assertThatThrownBy(() -> resolved.dataScopeIds().put("reporting", "forged"))
            .isInstanceOf(UnsupportedOperationException.class);
        assertThat(query.echo().values()).doesNotContain(scopeId);
    }

    @Test
    void decimalFilterRemainsBigDecimalThroughTypedParserAndPlanUntilTheApiResponseBoundary() {
        var decimalSpec = ReportQuerySpec.builder(
            "fixture-decimal-report",
            "report.fixture.view",
            "SELECT id AS \"id\", amount AS \"amount\" FROM report_fixture"
        )
            .filter(ReportQuerySpec.FilterDefinition.equals(
                "minimumAmount",
                "amount",
                ReportQuerySpec.ValueType.DECIMAL,
                ReportQuerySpec.PredicatePlacement.FACT
            ))
            .sortField("id", "id")
            .defaultSort("id", ReportQuerySpec.SortDirection.ASC)
            .uniqueNonNullStableSort("id", ReportQuerySpec.SortDirection.ASC)
            .csvColumn("金额", "amount", false)
            .build();
        var expected = new BigDecimal("9007199254740993.1200");

        var query = parser.parse(decimalSpec, Map.of(
            "minimumAmount", List.of(expected.toPlainString())
        ));
        var plan = planner.plan(decimalSpec, query);

        assertThat(query.filters()).containsEntry("minimumAmount", expected);
        assertThat(query.echo()).containsEntry("minimumAmount", expected);
        assertThat(plan.factPredicateParameters()).containsExactly(expected);
    }

    static ReportQuerySpec twoStageSummarySpec() {
        return ReportQuerySpec.builder(
            "fixture-two-stage-summary",
            "report.fixture.view",
            """
                SELECT id AS "id", business_date AS "businessDate",
                       customer_id AS "customerId", customer_name AS "customerName",
                       product_id AS "productId", product_name AS "productName",
                       currency AS "currency", quantity AS "quantity", amount AS "amount"
                FROM report_fixture
                """
        )
            .resultSql("""
                SELECT CASE WHEN ? = 'CUSTOMER' THEN customer_id ELSE product_id END AS "dimensionId",
                       currency AS "currency", SUM(amount) AS "amount",
                       (CASE WHEN ? = 'CUSTOMER' THEN customer_id ELSE product_id END)::text
                           || ':' || currency AS "rowKey"
                FROM report_fact
                GROUP BY CASE WHEN ? = 'CUSTOMER' THEN customer_id ELSE product_id END, currency
                """)
            .requiredDateRange("businessDate", ReportQuerySpec.PredicatePlacement.FACT)
            .keywordColumns(
                ReportQuerySpec.PredicatePlacement.FACT,
                "customerName",
                "productName"
            )
            .filter(ReportQuerySpec.FilterDefinition.enumEqualsDefault(
                "dimension",
                "dimensionId",
                ReportQuerySpec.PredicatePlacement.BOUND_ONLY,
                "CUSTOMER",
                "CUSTOMER",
                "PRODUCT"
            ))
            .bindResultFilter("dimension")
            .bindResultFilter("dimension")
            .bindResultFilter("dimension")
            .filter(ReportQuerySpec.FilterDefinition.equals(
                "customerId",
                "customerId",
                ReportQuerySpec.ValueType.UUID,
                ReportQuerySpec.PredicatePlacement.FACT
            ))
            .filter(ReportQuerySpec.FilterDefinition.enumEquals(
                "currency",
                "currency",
                ReportQuerySpec.PredicatePlacement.FACT,
                "CNY",
                "USD"
            ))
            .sortField("dimensionId", "dimensionId")
            .sortField("rowKey", "rowKey")
            .defaultSort("dimensionId", ReportQuerySpec.SortDirection.ASC)
            .uniqueNonNullStableSort("rowKey", ReportQuerySpec.SortDirection.ASC)
            .totalGroupColumns("currency")
            .totalSum("amount", "amount")
            .csvColumn("维度", "dimensionId", true)
            .csvColumn("币种", "currency", true)
            .csvColumn("金额", "amount", false)
            .build();
    }

    static ReportQuerySpec dataScopeSpec() {
        return ReportQuerySpec.builder(
            "fixture-data-scope",
            "report.fixture.view",
            "SELECT id AS \"id\", amount AS \"amount\" FROM report_fixture WHERE report_scope_id = ?::uuid"
        )
            .bindSourceDataScope("reporting")
            .resultSql("SELECT report_fact.* FROM report_fact WHERE ?::uuid = ?::uuid")
            .bindResultDataScope("reporting")
            .bindResultDataScope("reporting")
            .sortField("id", "id")
            .defaultSort("id", ReportQuerySpec.SortDirection.ASC)
            .uniqueNonNullStableSort("id", ReportQuerySpec.SortDirection.ASC)
            .totalSum("amount", "amount")
            .csvColumn("ID", "id", true)
            .csvColumn("金额", "amount", false)
            .build();
    }

    private Map<String, List<String>> validDatesWith(String key, List<String> value) {
        var parameters = new LinkedHashMap<String, List<String>>();
        parameters.put("dateFrom", List.of("2026-07-01"));
        parameters.put("dateTo", List.of("2026-07-14"));
        if (key != null) {
            parameters.put(key, value);
        }
        return parameters;
    }

    private void assertBadRequest(Map<String, List<String>> parameters) {
        assertThatThrownBy(() -> parser.parse(spec, parameters))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST));
    }
}
