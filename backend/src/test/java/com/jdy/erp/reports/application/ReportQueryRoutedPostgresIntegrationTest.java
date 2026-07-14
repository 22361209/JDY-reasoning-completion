package com.jdy.erp.reports.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.time.Clock;
import java.time.Duration;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.system.security.CurrentPermissionService;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantContext;
import com.jdy.erp.system.tenant.TenantDataSourceRegistry;
import com.jdy.erp.system.tenant.TenantDataScopeService;
import com.jdy.erp.system.tenant.TenantRoutingDataSource;
import com.zaxxer.hikari.HikariDataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.autoconfigure.jdbc.DataSourceProperties;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

class ReportQueryRoutedPostgresIntegrationTest {
    @TempDir
    Path exportDirectory;

    @Test
    void isolatedRandomDatabaseKeepsTenantsSeparateAndRepeatableReadKeepsOneSnapshot() throws Exception {
        assertThatThrownBy(() -> requireIsolatedDatabaseName("jdy_erp"))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("shared jdy_erp");

        Class.forName("org.postgresql.Driver");
        var settings = databaseSettings();
        var databaseName = requireIsolatedDatabaseName(
            "a145_report_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12)
        );
        var tenantASchema = "tenant_a";
        var tenantBSchema = "tenant_b";
        var publicScopeId = "00000000-0000-0000-0000-000000000001";
        var tenantAScopeId = dataScopeId(databaseName, tenantASchema);
        var tenantBScopeId = dataScopeId(databaseName, tenantBSchema);
        var created = false;
        HikariDataSource platformDataSource = null;
        TenantDataSourceRegistry tenantRegistry = null;
        ReportExportCleanupManager cleanupManager = null;
        try {
            createDatabase(settings, databaseName);
            created = true;

            var properties = new DataSourceProperties();
            properties.setUrl(databaseUrl(settings.baseUrl(), databaseName));
            properties.setUsername(settings.username());
            properties.setPassword(settings.password());
            platformDataSource = properties.initializeDataSourceBuilder().type(HikariDataSource.class).build();
            platformDataSource.setMinimumIdle(0);
            platformDataSource.setMaximumPoolSize(2);
            platformDataSource.setPoolName("a145-isolated-platform");

            var platformJdbcTemplate = new JdbcTemplate(platformDataSource);
            tenantRegistry = new TenantDataSourceRegistry(properties);
            var routingDataSource = new TenantRoutingDataSource(platformDataSource, tenantRegistry);
            var tenantJdbcTemplate = new JdbcTemplate(routingDataSource);
            cleanupManager = new ReportExportCleanupManager(
                exportDirectory,
                Clock.systemUTC(),
                Duration.ofHours(2),
                () -> "a145-postgres-test",
                Files::deleteIfExists
            );
            cleanupManager.afterPropertiesSet();
            var executor = spy(new SqlReportQueryExecutor(
                tenantJdbcTemplate,
                new ReportCsvWriter(),
                cleanupManager
            ));
            var transaction = repeatableReadTransaction(new DataSourceTransactionManager(routingDataSource));
            var currentSessionService = mock(CurrentSessionService.class);
            when(currentSessionService.currentAccountSetId())
                .thenReturn("00000000-0000-0000-0000-000000000001");
            var tenantDataScopeService = spy(new TenantDataScopeService(currentSessionService));

            assertThat(platformJdbcTemplate.queryForObject("SELECT current_database()", String.class))
                .isEqualTo(databaseName)
                .isNotEqualTo("jdy_erp");
            createFixtureSchema(
                platformJdbcTemplate,
                tenantASchema,
                "SO-SAME",
                "TENANT-A-OLD",
                "10.00",
                tenantAScopeId
            );
            insertFixtureRow(
                platformJdbcTemplate,
                tenantASchema,
                "SO-DECOY-A",
                "TENANT-A-DECOY",
                "777.00",
                "00000000-0000-0000-0000-000000009145"
            );
            createFixtureSchema(
                platformJdbcTemplate,
                tenantBSchema,
                "SO-SAME",
                "TENANT-B",
                "99.00",
                tenantBScopeId
            );
            insertFixtureRow(
                platformJdbcTemplate,
                tenantBSchema,
                "SO-DECOY-B",
                "TENANT-B-DECOY",
                "888.00",
                "00000000-0000-0000-0000-000000009146"
            );
            createFixtureTable(
                platformJdbcTemplate,
                "public",
                "SO-BLD",
                "BLD-TEST-PUBLIC",
                "999.00",
                publicScopeId
            );
            insertFixtureRow(
                platformJdbcTemplate,
                "public",
                "SO-DECOY-PUBLIC",
                "BLD-TEST-DECOY",
                "666.00",
                "00000000-0000-0000-0000-000000009001"
            );
            createAccountSetRegistry(platformJdbcTemplate, databaseName, tenantASchema, tenantBSchema);

            var spec = ReportQuerySpecRegistryTest.fixtureSpec();
            var plan = new ReportQueryPlanner().plan(spec, new ReportQueryParser().parse(spec, Map.of(
                "dateFrom", List.of("2026-07-01"),
                "dateTo", List.of("2026-07-14"),
                "keyword", List.of("SO-SAME")
            )));
            var tenantA = tenant(
                "00000000-0000-0000-0000-000000000145",
                databaseName,
                tenantASchema,
                "A145-A"
            );
            var tenantB = tenant(
                "00000000-0000-0000-0000-000000000146",
                databaseName,
                tenantBSchema,
                "A145-B"
            );

            var service = new ReportQueryService(
                new ReportQuerySpecRegistry(List.of(spec, scopedSpec())),
                new ReportQueryParser(),
                new ReportQueryPlanner(),
                executor,
                mock(CurrentPermissionService.class),
                mock(OperationLogService.class),
                new DataSourceTransactionManager(routingDataSource),
                Clock.systemUTC(),
                tenantDataScopeService,
                platformJdbcTemplate
            );
            TenantContext.setTenant(tenant(
                "00000000-0000-0000-0000-000000000001",
                databaseName,
                "public",
                "BLD-TEST"
            ));
            var publicResponse = service.query("fixture-report", Map.of(
                "dateFrom", List.of("2026-07-01"),
                "dateTo", List.of("2026-07-14"),
                "keyword", List.of("SO-BLD")
            ));
            assertThat(publicResponse.rows()).singleElement().satisfies(row -> assertThat(row)
                .containsEntry("billNo", "SO-BLD")
                .containsEntry("customerName", "BLD-TEST-PUBLIC"));
            assertScopedQueryAndExport(
                service,
                "BLD-TEST-PUBLIC",
                "BLD-TEST-DECOY",
                "999",
                "999.00"
            );
            verify(tenantDataScopeService, times(2)).currentScopeId("reporting");

            clearInvocations(executor);
            TenantContext.setTenant(tenant(
                "00000000-0000-0000-0000-000000000999",
                databaseName,
                "public",
                "FORGED-PUBLIC"
            ));
            assertThatThrownBy(() -> service.query("scoped-fixture-report", Map.of(
                "dateFrom", List.of("2026-07-01"),
                "dateTo", List.of("2026-07-14")
            )))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                    .isEqualTo(HttpStatus.INTERNAL_SERVER_ERROR));
            verifyNoInteractions(executor);
            verify(tenantDataScopeService, times(2)).currentScopeId("reporting");
            assertThat(platformJdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM public.report_fixture WHERE audit_status = 'AUDITED'",
                Long.class
            )).isEqualTo(2L);

            TenantContext.setTenant(tenantA);
            assertScopedQueryAndExport(
                service,
                "TENANT-A-OLD",
                "TENANT-A-DECOY",
                "10",
                "10.00"
            );
            verify(tenantDataScopeService, times(4)).currentScopeId("reporting");
            transaction.executeWithoutResult(ignored -> {
                assertThat(tenantJdbcTemplate.queryForObject("SELECT current_database()", String.class))
                    .isEqualTo(databaseName);
                assertThat(tenantJdbcTemplate.queryForObject("SHOW transaction_isolation", String.class))
                    .isEqualTo("repeatable read");
                assertSingleTenantRow(executor.query(spec, plan), "TENANT-A-OLD", "10.00");

                platformJdbcTemplate.update(
                    "UPDATE " + quote(tenantASchema)
                        + ".report_fixture SET customer_name = ?, amount = ? WHERE bill_no = ?",
                    "TENANT-A-NEW",
                    new BigDecimal("11.00"),
                    "SO-SAME"
                );

                assertSingleTenantRow(executor.query(spec, plan), "TENANT-A-OLD", "10.00");
            });

            assertSingleTenantRow(
                transaction.execute(ignored -> executor.query(spec, plan)),
                "TENANT-A-NEW",
                "11.00"
            );

            TenantContext.setTenant(tenantB);
            assertSingleTenantRow(
                transaction.execute(ignored -> executor.query(spec, plan)),
                "TENANT-B",
                "99.00"
            );
            assertThat(cleanupManager.activeCount()).isZero();
            assertThat(cleanupManager.pendingCount()).isZero();
            try (var files = Files.list(exportDirectory)) {
                assertThat(files).isEmpty();
            }
        } finally {
            TenantContext.clear();
            if (cleanupManager != null) {
                cleanupManager.destroy();
            }
            if (tenantRegistry != null) {
                tenantRegistry.close();
            }
            if (platformDataSource != null) {
                platformDataSource.close();
            }
            if (created) {
                dropDatabase(settings, databaseName);
                assertThat(databaseExists(settings, databaseName)).isFalse();
            }
        }
    }

    private void assertScopedQueryAndExport(
        ReportQueryService service,
        String expectedCustomer,
        String excludedCustomer,
        String expectedResponseAmount,
        String expectedCsvAmount
    ) throws Exception {
        var parameters = Map.of(
            "dateFrom", List.of("2026-07-01"),
            "dateTo", List.of("2026-07-14")
        );
        var response = service.query("scoped-fixture-report", parameters);

        assertThat(response.total()).isEqualTo(1L);
        assertThat(response.rows()).singleElement().satisfies(row -> assertThat(row)
            .containsEntry("customerName", expectedCustomer)
            .containsEntry("amount", expectedResponseAmount));
        assertThat(response.rows()).noneMatch(row -> excludedCustomer.equals(row.get("customerName")));
        assertThat(response.totals()).singleElement().satisfies(total -> assertThat(total)
            .containsEntry("currency", "USD")
            .containsEntry("amount", expectedResponseAmount));
        assertThat(response.query()).doesNotContainKeys(
            "scope",
            "schema",
            "accountSetId",
            "tenantId",
            "dataScope",
            "dataScopeId",
            "reporting"
        );

        var artifact = service.prepareExport("scoped-fixture-report", parameters);
        var artifactPath = artifact.path();
        try {
            var csv = Files.readString(artifactPath, StandardCharsets.UTF_8);
            assertThat(artifact.rowCount()).isEqualTo(1L);
            assertThat(csv)
                .contains(expectedCustomer)
                .contains(expectedCsvAmount)
                .doesNotContain(excludedCustomer);
        } finally {
            artifact.release("a145-postgres-scope");
        }
        assertThat(Files.exists(artifactPath)).isFalse();
    }

    private TransactionTemplate repeatableReadTransaction(DataSourceTransactionManager transactionManager) {
        var transaction = new TransactionTemplate(transactionManager);
        transaction.setReadOnly(true);
        transaction.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
        transaction.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        return transaction;
    }

    private void assertSingleTenantRow(SqlReportQueryExecutor.QueryData data, String customer, String amount) {
        assertThat(data.total()).isEqualTo(1L);
        assertThat(data.rows()).singleElement().satisfies(row -> assertThat(row)
            .containsEntry("billNo", "SO-SAME")
            .containsEntry("customerName", customer)
            .containsEntry("amount", new BigDecimal(amount)));
        assertThat(data.totals()).singleElement().satisfies(total -> assertThat(total)
            .containsEntry("currency", "USD")
            .containsEntry("amount", new BigDecimal(amount)));
    }

    private Map<String, Object> tenant(String id, String databaseName, String schema, String code) {
        requireIsolatedDatabaseName(databaseName);
        return Map.of(
            "id", id,
            "code", code,
            "name", code,
            "databaseName", databaseName,
            "schemaName", schema
        );
    }

    private void createAccountSetRegistry(
        JdbcTemplate platformJdbcTemplate,
        String databaseName,
        String tenantASchema,
        String tenantBSchema
    ) {
        platformJdbcTemplate.execute("""
            CREATE TABLE sys_account_set (
                id UUID PRIMARY KEY,
                database_name TEXT NOT NULL,
                schema_name TEXT NOT NULL,
                enabled BOOLEAN NOT NULL,
                initialized BOOLEAN NOT NULL
            )
            """);
        for (var route : List.of(
            List.of("00000000-0000-0000-0000-000000000001", "public"),
            List.of("00000000-0000-0000-0000-000000000145", tenantASchema),
            List.of("00000000-0000-0000-0000-000000000146", tenantBSchema)
        )) {
            platformJdbcTemplate.update("""
                INSERT INTO sys_account_set (id, database_name, schema_name, enabled, initialized)
                VALUES (?::uuid, ?, ?, TRUE, TRUE)
                """, route.get(0), databaseName, route.get(1));
        }
    }

    private void createFixtureSchema(
        JdbcTemplate platformJdbcTemplate,
        String schema,
        String billNo,
        String customer,
        String amount,
        String scopeId
    ) {
        platformJdbcTemplate.execute("CREATE SCHEMA " + quote(schema));
        createFixtureTable(platformJdbcTemplate, schema, billNo, customer, amount, scopeId);
    }

    private void createFixtureTable(
        JdbcTemplate platformJdbcTemplate,
        String schema,
        String billNo,
        String customer,
        String amount,
        String scopeId
    ) {
        platformJdbcTemplate.execute("""
            CREATE TABLE %s.report_fixture (
                id UUID PRIMARY KEY,
                report_scope_id UUID NOT NULL,
                bill_date DATE NOT NULL,
                bill_no TEXT NOT NULL,
                customer_id UUID NOT NULL,
                customer_name TEXT NOT NULL,
                amount NUMERIC(18, 2) NOT NULL,
                currency TEXT NOT NULL,
                audit_status TEXT NOT NULL
            )
            """.formatted(quote(schema)));
        insertFixtureRow(platformJdbcTemplate, schema, billNo, customer, amount, scopeId);
    }

    private void insertFixtureRow(
        JdbcTemplate platformJdbcTemplate,
        String schema,
        String billNo,
        String customer,
        String amount,
        String scopeId
    ) {
        platformJdbcTemplate.update("""
            INSERT INTO %s.report_fixture (
                id, report_scope_id, bill_date, bill_no, customer_id, customer_name, amount, currency, audit_status
            ) VALUES (?::uuid, ?::uuid, ?, ?, ?::uuid, ?, ?, 'USD', 'AUDITED')
            """.formatted(quote(schema)),
            UUID.randomUUID(),
            scopeId,
            LocalDate.of(2026, 7, 10),
            billNo,
            UUID.randomUUID(),
            customer,
            new BigDecimal(amount)
        );
    }

    private ReportQuerySpec scopedSpec() {
        return ReportQuerySpec.builder(
            "scoped-fixture-report",
            "report.fixture.view",
            """
                SELECT id AS "id", bill_date AS "businessDate", bill_no AS "billNo", customer_id AS "customerId",
                       customer_name AS "customerName", amount AS "amount", currency AS "currency"
                FROM report_fixture
                WHERE report_scope_id = ?::uuid AND audit_status = 'AUDITED'
                """
        )
            .bindSourceDataScope("reporting")
            .requiredDateRange("businessDate")
            .sortField("businessDate", "businessDate")
            .sortField("billNo", "billNo")
            .sortField("id", "id")
            .defaultSort("businessDate", ReportQuerySpec.SortDirection.DESC)
            .stableSort("businessDate", ReportQuerySpec.SortDirection.DESC)
            .stableSort("billNo", ReportQuerySpec.SortDirection.ASC)
            .uniqueNonNullStableSort("id", ReportQuerySpec.SortDirection.ASC)
            .totalGroupColumns("currency")
            .totalSum("amount", "amount")
            .csvColumn("单号", "billNo", true)
            .csvColumn("客户", "customerName", false)
            .csvColumn("金额", "amount", false)
            .csvColumn("币种", "currency", true)
            .build();
    }

    private String dataScopeId(String databaseName, String schema) {
        return UUID.nameUUIDFromBytes(
            ("reporting:" + databaseName + ":" + schema).getBytes(StandardCharsets.UTF_8)
        ).toString();
    }

    private DatabaseSettings databaseSettings() {
        return new DatabaseSettings(
            System.getenv().getOrDefault("JDY_DB_URL", "jdbc:postgresql://localhost:5432/jdy_erp"),
            System.getenv().getOrDefault("JDY_DB_USERNAME", "jdy"),
            System.getenv().getOrDefault("JDY_DB_PASSWORD", "jdy_dev")
        );
    }

    private void createDatabase(DatabaseSettings settings, String databaseName) throws Exception {
        try (var connection = DriverManager.getConnection(
            databaseUrl(settings.baseUrl(), "postgres"), settings.username(), settings.password()
        ); var statement = connection.createStatement()) {
            statement.execute("CREATE DATABASE " + quote(databaseName));
        }
    }

    private void dropDatabase(DatabaseSettings settings, String databaseName) throws Exception {
        try (var connection = DriverManager.getConnection(
            databaseUrl(settings.baseUrl(), "postgres"), settings.username(), settings.password()
        )) {
            try (var terminate = connection.prepareStatement("""
                SELECT pg_terminate_backend(pid)
                FROM pg_stat_activity
                WHERE datname = ? AND pid <> pg_backend_pid()
                """)) {
                terminate.setString(1, databaseName);
                terminate.execute();
            }
            try (var statement = connection.createStatement()) {
                statement.execute("DROP DATABASE IF EXISTS " + quote(databaseName));
            }
        }
    }

    private boolean databaseExists(DatabaseSettings settings, String databaseName) throws Exception {
        try (var connection = DriverManager.getConnection(
            databaseUrl(settings.baseUrl(), "postgres"), settings.username(), settings.password()
        ); var query = connection.prepareStatement("SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ?)")) {
            query.setString(1, databaseName);
            try (var result = query.executeQuery()) {
                result.next();
                return result.getBoolean(1);
            }
        }
    }

    private String requireIsolatedDatabaseName(String databaseName) {
        if ("jdy_erp".equalsIgnoreCase(databaseName)) {
            throw new IllegalStateException("A145 routed PostgreSQL test refuses shared jdy_erp");
        }
        if (databaseName == null || !databaseName.matches("a145_report_[a-z0-9]{12}")) {
            throw new IllegalArgumentException("A145 test database name is not isolated");
        }
        return databaseName;
    }

    private String databaseUrl(String baseUrl, String databaseName) {
        if (baseUrl == null || !baseUrl.startsWith("jdbc:postgresql://")) {
            throw new IllegalStateException("A145 routed PostgreSQL test requires a PostgreSQL JDBC URL");
        }
        var queryStart = baseUrl.indexOf('?');
        var main = queryStart < 0 ? baseUrl : baseUrl.substring(0, queryStart);
        var query = queryStart < 0 ? "" : baseUrl.substring(queryStart);
        var slash = main.lastIndexOf('/');
        if (slash < "jdbc:postgresql://".length()) {
            throw new IllegalStateException("A145 routed PostgreSQL JDBC URL has no database segment");
        }
        return main.substring(0, slash + 1) + databaseName + query;
    }

    private String quote(String identifier) {
        if (!identifier.matches("[a-z][a-z0-9_]{1,62}")) {
            throw new IllegalArgumentException("unsafe test identifier");
        }
        return '"' + identifier + '"';
    }

    private record DatabaseSettings(String baseUrl, String username, String password) {
    }
}
