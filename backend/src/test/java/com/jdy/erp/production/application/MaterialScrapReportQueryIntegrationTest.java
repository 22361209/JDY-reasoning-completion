package com.jdy.erp.production.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.time.Clock;
import java.time.Duration;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.jdy.erp.reports.application.ReportCsvWriter;
import com.jdy.erp.reports.application.ReportExportCleanupManager;
import com.jdy.erp.reports.application.ReportQueryParser;
import com.jdy.erp.reports.application.ReportQueryPlanner;
import com.jdy.erp.reports.application.ReportQueryService;
import com.jdy.erp.reports.application.ReportQuerySpecRegistry;
import com.jdy.erp.reports.application.SqlReportQueryExecutor;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.system.security.CurrentPermissionService;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantContext;
import com.jdy.erp.system.tenant.TenantDataScopeService;
import com.jdy.erp.system.tenant.TenantDataSourceRegistry;
import com.jdy.erp.system.tenant.TenantRoutingDataSource;
import com.zaxxer.hikari.HikariDataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.autoconfigure.jdbc.DataSourceProperties;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.web.server.ResponseStatusException;

class MaterialScrapReportQueryIntegrationTest {
    private static final String PUBLIC_ACCOUNT_SET = "00000000-0000-0000-0000-000000000001";
    private static final String TENANT_ACCOUNT_SET = "00000000-0000-0000-0000-000000000152";

    @TempDir
    Path exportDirectory;

    @Test
    void routedPostgresKeepsAuditedTenantGroupingFiltersPaginationTotalsAndCsvExact() throws Exception {
        assertThatThrownBy(() -> requireIsolatedDatabaseName("jdy_erp"))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("shared jdy_erp");

        Class.forName("org.postgresql.Driver");
        var settings = databaseSettings();
        var databaseName = requireIsolatedDatabaseName(
            "a152_scrap_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12)
        );
        var tenantSchema = "tenant_a152";
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
            platformDataSource.setMaximumPoolSize(3);
            platformDataSource.setPoolName("a152-material-scrap-platform");
            var platformJdbc = new JdbcTemplate(platformDataSource);
            tenantRegistry = new TenantDataSourceRegistry(properties);
            var routingDataSource = new TenantRoutingDataSource(platformDataSource, tenantRegistry);
            var tenantJdbc = new JdbcTemplate(routingDataSource);
            cleanupManager = new ReportExportCleanupManager(
                exportDirectory,
                Clock.systemUTC(),
                Duration.ofHours(2),
                () -> "a152-material-scrap-test",
                Files::deleteIfExists
            );
            cleanupManager.afterPropertiesSet();

            createAccountSetRegistry(platformJdbc, databaseName, tenantSchema);
            createFixtureTables(platformJdbc, "public");
            platformJdbc.execute("CREATE SCHEMA " + quote(tenantSchema));
            createFixtureTables(platformJdbc, tenantSchema);
            insertBusinessFixtures(platformJdbc, "public", "PUBLIC", 0);
            insertBusinessFixtures(platformJdbc, tenantSchema, "TENANT", 10);
            insertPaginationFixtures(platformJdbc, "public", "PUBLIC");

            var permissionService = mock(CurrentPermissionService.class);
            var currentSession = mock(CurrentSessionService.class);
            when(currentSession.optionalCurrentUsername()).thenReturn("admin");
            var spec = new MaterialScrapReportQuerySpec().materialScrapSummaryReportQuerySpec();
            var service = new ReportQueryService(
                new ReportQuerySpecRegistry(List.of(spec)),
                new ReportQueryParser(),
                new ReportQueryPlanner(),
                new SqlReportQueryExecutor(tenantJdbc, new ReportCsvWriter(), cleanupManager),
                permissionService,
                mock(OperationLogService.class),
                new DataSourceTransactionManager(routingDataSource),
                currentSession,
                new TenantDataScopeService(currentSession),
                platformJdbc
            );

            TenantContext.setTenant(tenant(PUBLIC_ACCOUNT_SET, databaseName, "public", "BLD-TEST"));
            assertLifecycleStatusContract(service, platformJdbc, "public", "PUBLIC");
            assertScopeGroupingTotalsAndCsv(service, "PUBLIC", "TENANT", "11", "5", "4", "7");
            assertSameBillNoTenantIsolation(service, "PUBLIC", "TENANT", "31");
            assertFilters(service, "PUBLIC");
            assertStablePagination(service);

            TenantContext.setTenant(tenant(TENANT_ACCOUNT_SET, databaseName, tenantSchema, "A152-TENANT"));
            assertLifecycleStatusContract(service, platformJdbc, tenantSchema, "TENANT");
            assertScopeGroupingTotalsAndCsv(service, "TENANT", "PUBLIC", "41", "25", "14", "17");
            assertSameBillNoTenantIsolation(service, "TENANT", "PUBLIC", "41");
            assertFilters(service, "TENANT");

            doThrow(new ResponseStatusException(HttpStatus.FORBIDDEN, "forbidden"))
                .when(permissionService).requirePermission("production.document.audit");
            assertThatThrownBy(() -> service.query(MaterialScrapReportQuerySpec.REPORT_KEY, dateQuery("2026-07-14")))
                .isInstanceOfSatisfying(ResponseStatusException.class, failure ->
                    assertThat(failure.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN)
                );
            verify(permissionService, atLeastOnce()).requirePermission("production.document.audit");
            try (var files = Files.list(exportDirectory)) {
                assertThat(files).isEmpty();
            }
        } finally {
            TenantContext.clear();
            if (cleanupManager != null) cleanupManager.destroy();
            if (tenantRegistry != null) tenantRegistry.close();
            if (platformDataSource != null) platformDataSource.close();
            if (created) {
                dropDatabase(settings, databaseName);
                assertThat(databaseExists(settings, databaseName)).isFalse();
            }
        }
    }

    private void assertLifecycleStatusContract(
        ReportQueryService service,
        JdbcTemplate jdbc,
        String schema,
        String prefix
    ) {
        var reversibleBillNo = prefix + "-REVERSE-AUDITED";
        var audited = queryByKeyword(service, reversibleBillNo);
        assertThat(audited.total()).isEqualTo(1L);
        assertThat(audited.rows()).singleElement().satisfies(row -> assertThat(row)
            .containsEntry("productCode", prefix + "-P-REVERSE")
            .containsEntry("scrapQty", "9"));

        jdbc.update(
            "UPDATE " + quote(schema) + ".production_material_scrap SET status = 'DRAFT' WHERE bill_no = ?",
            reversibleBillNo
        );
        var reversed = queryByKeyword(service, reversibleBillNo);
        assertThat(reversed.total()).isZero();
        assertThat(reversed.rows()).isEmpty();
        assertThat(reversed.totals()).isEmpty();

        jdbc.update(
            "UPDATE " + quote(schema) + ".production_material_scrap SET status = 'AUDITED' WHERE bill_no = ?",
            reversibleBillNo
        );
        assertThat(queryByKeyword(service, reversibleBillNo).total()).isEqualTo(1L);
        jdbc.update(
            "UPDATE " + quote(schema) + ".production_material_scrap SET status = 'DRAFT' WHERE bill_no = ?",
            reversibleBillNo
        );
    }

    private void assertScopeGroupingTotalsAndCsv(
        ReportQueryService service,
        String expectedPrefix,
        String excludedPrefix,
        String expectedPcsTotal,
        String expectedMergedQty,
        String expectedBoxQty,
        String expectedKgQty
    ) throws Exception {
        var response = service.query(MaterialScrapReportQuerySpec.REPORT_KEY, dateQuery("2026-07-14"));

        assertThat(response.reportKey()).isEqualTo("material-scrap-summary");
        assertThat(response.total()).isEqualTo(4L);
        assertThat(response.rows()).hasSize(4).allSatisfy(row -> {
            assertThat(String.valueOf(row.get("workshopCode"))).startsWith(expectedPrefix);
            assertThat(String.valueOf(row.get("productCode"))).startsWith(expectedPrefix);
            assertThat(row).doesNotContainKeys("currency", "amount", "cost");
        });
        assertThat(response.rows()).noneSatisfy(row ->
            assertThat(String.valueOf(row.get("productCode"))).contains(excludedPrefix)
        );
        assertThat(response.rows()).anySatisfy(row -> assertThat(row)
            .containsEntry("workshopCode", expectedPrefix + "-W-01")
            .containsEntry("productCode", expectedPrefix + "-P-01")
            .containsEntry("unit", "PCS")
            .containsEntry("scrapQty", expectedMergedQty));
        assertThat(response.rows()).anySatisfy(row -> assertThat(row)
            .containsEntry("workshopCode", expectedPrefix + "-W-01")
            .containsEntry("productCode", expectedPrefix + "-P-01")
            .containsEntry("unit", "BOX")
            .containsEntry("scrapQty", expectedBoxQty));
        assertThat(response.totals()).hasSize(3).anySatisfy(total -> assertThat(total)
            .containsEntry("unit", "PCS")
            .containsEntry("scrapQty", expectedPcsTotal));
        assertThat(response.totals()).anySatisfy(total -> assertThat(total)
            .containsEntry("unit", "KG")
            .containsEntry("scrapQty", expectedKgQty));

        var artifact = service.prepareExport(MaterialScrapReportQuerySpec.REPORT_KEY, dateQuery("2026-07-14"));
        var path = artifact.path();
        try {
            var csv = Files.readString(path, StandardCharsets.UTF_8);
            assertThat(artifact.rowCount()).isEqualTo(response.total());
            assertThat(csv)
                .contains("报废数量")
                .contains(expectedPrefix + "-W-01")
                .contains(expectedPrefix + "-P-01")
                .doesNotContain(excludedPrefix)
                .doesNotContain(expectedPrefix + "-DRAFT")
                .doesNotContain(expectedPrefix + "-VOID")
                .doesNotContain("金额")
                .doesNotContain("币种")
                .doesNotContain("成本");
        } finally {
            artifact.release("a152-tenant-scope-proof");
        }
        assertThat(Files.exists(path)).isFalse();
    }

    private void assertFilters(ReportQueryService service, String prefix) {
        var workshopId = deterministicId(prefix + ":WORKSHOP:01");
        var productId = deterministicId(prefix + ":PRODUCT:01");
        var response = service.query(MaterialScrapReportQuerySpec.REPORT_KEY, Map.of(
            "dateFrom", List.of("2026-07-14"),
            "dateTo", List.of("2026-07-14"),
            "businessType", List.of("PRODUCTION_SCRAP"),
            "workshopId", List.of(workshopId),
            "productId", List.of(productId),
            "scrapReason", List.of("edge"),
            "keyword", List.of(prefix + " CORE"),
            "sortField", List.of("scrapQty"),
            "sortOrder", List.of("desc")
        ));

        assertThat(response.total()).isEqualTo(2L);
        assertThat(response.rows()).extracting(row -> row.get("unit"))
            .containsExactlyInAnyOrder("PCS", "BOX");
        assertThat(response.totals()).hasSize(2);
        assertThat(response.query())
            .containsEntry("businessType", "PRODUCTION_SCRAP")
            .containsEntry("workshopId", workshopId)
            .containsEntry("productId", productId)
            .containsEntry("scrapReason", "edge");

        assertThatThrownBy(() -> service.query(MaterialScrapReportQuerySpec.REPORT_KEY, Map.of(
            "dateFrom", List.of("2026-07-14"),
            "dateTo", List.of("2026-07-14"),
            "businessType", List.of("OTHER")
        ))).isInstanceOfSatisfying(ResponseStatusException.class, failure ->
            assertThat(failure.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST)
        );

        assertThatThrownBy(() -> service.query(MaterialScrapReportQuerySpec.REPORT_KEY, Map.of(
            "dateFrom", List.of("2026-07-14"),
            "dateTo", List.of("2026-07-14"),
            "currency", List.of("USD")
        ))).isInstanceOfSatisfying(ResponseStatusException.class, failure ->
            assertThat(failure.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST)
        );
    }

    private void assertSameBillNoTenantIsolation(
        ReportQueryService service,
        String expectedPrefix,
        String excludedPrefix,
        String expectedQty
    ) throws Exception {
        var query = new LinkedHashMap<String, List<String>>();
        query.put("dateFrom", List.of("2026-07-16"));
        query.put("dateTo", List.of("2026-07-16"));
        query.put("keyword", List.of("A152-SHARED-BILL"));
        var response = service.query(MaterialScrapReportQuerySpec.REPORT_KEY, query);

        assertThat(response.total()).isEqualTo(1L);
        assertThat(response.rows()).singleElement().satisfies(row -> assertThat(row)
            .containsEntry("productCode", expectedPrefix + "-P-SHARED")
            .containsEntry("scrapQty", expectedQty));
        assertThat(response.rows()).noneSatisfy(row ->
            assertThat(String.valueOf(row.get("productCode"))).contains(excludedPrefix)
        );

        var artifact = service.prepareExport(MaterialScrapReportQuerySpec.REPORT_KEY, query);
        try {
            assertThat(Files.readString(artifact.path(), StandardCharsets.UTF_8))
                .contains(expectedPrefix + "-P-SHARED")
                .doesNotContain(excludedPrefix + "-P-SHARED");
        } finally {
            artifact.release("a152-shared-bill-tenant-proof");
        }
    }

    private void assertStablePagination(ReportQueryService service) {
        var pageOneQuery = new LinkedHashMap<String, List<String>>();
        pageOneQuery.put("dateFrom", List.of("2026-07-15"));
        pageOneQuery.put("dateTo", List.of("2026-07-15"));
        pageOneQuery.put("page", List.of("1"));
        pageOneQuery.put("pageSize", List.of("20"));
        pageOneQuery.put("sortField", List.of("workshopCode"));
        pageOneQuery.put("sortOrder", List.of("asc"));
        var pageOne = service.query(MaterialScrapReportQuerySpec.REPORT_KEY, pageOneQuery);
        var pageOneRepeat = service.query(MaterialScrapReportQuerySpec.REPORT_KEY, pageOneQuery);
        var pageTwo = service.query(MaterialScrapReportQuerySpec.REPORT_KEY, Map.of(
            "dateFrom", List.of("2026-07-15"),
            "dateTo", List.of("2026-07-15"),
            "page", List.of("2"),
            "pageSize", List.of("20"),
            "sortField", List.of("workshopCode"),
            "sortOrder", List.of("asc")
        ));

        assertThat(pageOne.total()).isEqualTo(21L);
        assertThat(pageOne.rows()).hasSize(20).isEqualTo(pageOneRepeat.rows());
        assertThat(pageTwo.rows()).hasSize(1);
        var firstPageKeys = pageOne.rows().stream().map(row -> row.get("rowKey")).toList();
        var secondPageKeys = pageTwo.rows().stream().map(row -> row.get("rowKey")).toList();
        assertThat(firstPageKeys).doesNotContainAnyElementsOf(secondPageKeys);
        assertThat(pageTwo.totals()).isEqualTo(pageOne.totals());
    }

    private com.jdy.erp.reports.application.ReportQueryResponse queryByKeyword(
        ReportQueryService service,
        String keyword
    ) {
        return service.query(MaterialScrapReportQuerySpec.REPORT_KEY, Map.of(
            "dateFrom", List.of("2026-07-14"),
            "dateTo", List.of("2026-07-14"),
            "keyword", List.of(keyword)
        ));
    }

    private Map<String, List<String>> dateQuery(String date) {
        return Map.of("dateFrom", List.of(date), "dateTo", List.of(date));
    }

    private void createFixtureTables(JdbcTemplate jdbc, String schema) {
        var prefix = quote(schema) + ".";
        jdbc.execute("""
            CREATE TABLE %sproduction_material_scrap (
                id UUID PRIMARY KEY,
                bill_no TEXT NOT NULL UNIQUE,
                bill_date DATE NOT NULL,
                business_type TEXT NOT NULL,
                workshop_id UUID NOT NULL,
                workshop_code_snapshot TEXT NOT NULL,
                workshop_name_snapshot TEXT NOT NULL,
                status TEXT NOT NULL
            )
            """.formatted(prefix));
        jdbc.execute("""
            CREATE TABLE %sproduction_material_scrap_line (
                id UUID PRIMARY KEY,
                scrap_id UUID NOT NULL,
                product_id UUID NOT NULL,
                product_code_snapshot TEXT NOT NULL,
                product_name_snapshot TEXT NOT NULL,
                product_spec_snapshot TEXT,
                product_unit_snapshot TEXT NOT NULL,
                scrap_reason TEXT,
                scrap_qty NUMERIC(18, 4) NOT NULL
            )
            """.formatted(prefix));
    }

    private void insertBusinessFixtures(JdbcTemplate jdbc, String schema, String prefix, int offset) {
        var workshopOne = deterministicId(prefix + ":WORKSHOP:01");
        var workshopTwo = deterministicId(prefix + ":WORKSHOP:02");
        var productOne = deterministicId(prefix + ":PRODUCT:01");
        var productTwo = deterministicId(prefix + ":PRODUCT:02");
        insertScrap(jdbc, schema, prefix + "-CORE-001", LocalDate.of(2026, 7, 14), "AUDITED",
            workshopOne, prefix + "-W-01", prefix + " Workshop 01", productOne, prefix + "-P-01",
            prefix + " Product 01", "M8", "PCS", "broken edge", 2 + offset);
        insertScrap(jdbc, schema, prefix + "-CORE-002", LocalDate.of(2026, 7, 14), "AUDITED",
            workshopOne, prefix + "-W-01", prefix + " Workshop 01", productOne, prefix + "-P-01",
            prefix + " Product 01", "M8", "PCS", "broken edge", 3 + offset);
        insertScrap(jdbc, schema, prefix + "-CORE-BOX", LocalDate.of(2026, 7, 14), "AUDITED",
            workshopOne, prefix + "-W-01", prefix + " Workshop 01", productOne, prefix + "-P-01",
            prefix + " Product 01", "M8", "BOX", "broken edge", 4 + offset);
        insertScrap(jdbc, schema, prefix + "-OTHER-WORKSHOP", LocalDate.of(2026, 7, 14), "AUDITED",
            workshopTwo, prefix + "-W-02", prefix + " Workshop 02", productOne, prefix + "-P-01",
            prefix + " Product 01", "M8", "PCS", "heat", 6 + offset);
        insertScrap(jdbc, schema, prefix + "-OTHER-PRODUCT", LocalDate.of(2026, 7, 14), "AUDITED",
            workshopOne, prefix + "-W-01", prefix + " Workshop 01", productTwo, prefix + "-P-02",
            prefix + " Product 02", "S2", "KG", "surface", 7 + offset);
        insertScrap(jdbc, schema, prefix + "-DRAFT", LocalDate.of(2026, 7, 14), "DRAFT",
            workshopOne, prefix + "-W-01", prefix + " Workshop 01", productOne, prefix + "-P-01",
            prefix + " Product 01", "M8", "PCS", "draft decoy", 99 + offset);
        insertScrap(jdbc, schema, prefix + "-VOID", LocalDate.of(2026, 7, 14), "VOID",
            workshopOne, prefix + "-W-01", prefix + " Workshop 01", productOne, prefix + "-P-01",
            prefix + " Product 01", "M8", "PCS", "void decoy", 88 + offset);
        insertScrap(jdbc, schema, prefix + "-REVERSE-AUDITED", LocalDate.of(2026, 7, 14), "AUDITED",
            deterministicId(prefix + ":WORKSHOP:REVERSE"), prefix + "-W-REVERSE", prefix + " Reverse Workshop",
            deterministicId(prefix + ":PRODUCT:REVERSE"), prefix + "-P-REVERSE", prefix + " Reverse Product",
            "R", "PCS", "reverse lifecycle", 9);
        insertScrap(jdbc, schema, "A152-SHARED-BILL", LocalDate.of(2026, 7, 16), "AUDITED",
            deterministicId(prefix + ":WORKSHOP:SHARED"), prefix + "-W-SHARED", prefix + " Shared Workshop",
            deterministicId(prefix + ":PRODUCT:SHARED"), prefix + "-P-SHARED", prefix + " Shared Product",
            "SHARED", "PCS", "same bill tenant isolation", 31 + offset);
    }

    private void insertPaginationFixtures(JdbcTemplate jdbc, String schema, String prefix) {
        for (var index = 1; index <= 21; index++) {
            var suffix = String.format("%02d", index);
            insertScrap(jdbc, schema, prefix + "-PAGE-" + suffix, LocalDate.of(2026, 7, 15), "AUDITED",
                deterministicId(prefix + ":PAGE:WORKSHOP:" + suffix), prefix + "-PW-" + suffix,
                prefix + " Page Workshop " + suffix, deterministicId(prefix + ":PAGE:PRODUCT:" + suffix),
                prefix + "-PP-" + suffix, prefix + " Page Product " + suffix, suffix, "PCS", "page", index);
        }
    }

    private void insertScrap(
        JdbcTemplate jdbc,
        String schema,
        String billNo,
        LocalDate billDate,
        String status,
        String workshopId,
        String workshopCode,
        String workshopName,
        String productId,
        String productCode,
        String productName,
        String productSpec,
        String unit,
        String reason,
        int quantity
    ) {
        var tablePrefix = quote(schema) + ".";
        var headerId = deterministicId(schema + ":HEADER:" + billNo);
        var lineId = deterministicId(schema + ":LINE:" + billNo);
        jdbc.update("""
            INSERT INTO %sproduction_material_scrap (
                id, bill_no, bill_date, business_type, workshop_id,
                workshop_code_snapshot, workshop_name_snapshot, status
            ) VALUES (?::uuid, ?, ?, 'PRODUCTION_SCRAP', ?::uuid, ?, ?, ?)
            """.formatted(tablePrefix),
            headerId, billNo, billDate, workshopId, workshopCode, workshopName, status
        );
        jdbc.update("""
            INSERT INTO %sproduction_material_scrap_line (
                id, scrap_id, product_id, product_code_snapshot, product_name_snapshot,
                product_spec_snapshot, product_unit_snapshot, scrap_reason, scrap_qty
            ) VALUES (?::uuid, ?::uuid, ?::uuid, ?, ?, ?, ?, ?, ?)
            """.formatted(tablePrefix),
            lineId, headerId, productId, productCode, productName, productSpec, unit, reason, quantity
        );
    }

    private void createAccountSetRegistry(JdbcTemplate jdbc, String databaseName, String tenantSchema) {
        jdbc.execute("""
            CREATE TABLE sys_account_set (
                id UUID PRIMARY KEY,
                database_name TEXT NOT NULL,
                schema_name TEXT NOT NULL,
                enabled BOOLEAN NOT NULL,
                initialized BOOLEAN NOT NULL
            )
            """);
        jdbc.update("INSERT INTO sys_account_set VALUES (?::uuid, ?, 'public', TRUE, TRUE)", PUBLIC_ACCOUNT_SET, databaseName);
        jdbc.update("INSERT INTO sys_account_set VALUES (?::uuid, ?, ?, TRUE, TRUE)", TENANT_ACCOUNT_SET, databaseName, tenantSchema);
    }

    private Map<String, Object> tenant(String id, String databaseName, String schema, String code) {
        return Map.of(
            "id", id,
            "code", code,
            "name", code,
            "databaseName", databaseName,
            "schemaName", schema
        );
    }

    private String deterministicId(String value) {
        return UUID.nameUUIDFromBytes(value.getBytes(StandardCharsets.UTF_8)).toString();
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
            throw new IllegalStateException("A152 test refuses shared jdy_erp");
        }
        if (databaseName == null || !databaseName.matches("a152_scrap_[a-z0-9]{12}")) {
            throw new IllegalArgumentException("A152 database name is not isolated");
        }
        return databaseName;
    }

    private String databaseUrl(String baseUrl, String databaseName) {
        if (baseUrl == null || !baseUrl.startsWith("jdbc:postgresql://")) {
            throw new IllegalStateException("A152 requires PostgreSQL");
        }
        var queryStart = baseUrl.indexOf('?');
        var main = queryStart < 0 ? baseUrl : baseUrl.substring(0, queryStart);
        var query = queryStart < 0 ? "" : baseUrl.substring(queryStart);
        var slash = main.lastIndexOf('/');
        return main.substring(0, slash + 1) + databaseName + query;
    }

    private String quote(String identifier) {
        if (identifier == null || !identifier.matches("[a-z][a-z0-9_]{1,62}")) {
            throw new IllegalArgumentException("unsafe test identifier");
        }
        return '"' + identifier + '"';
    }

    private record DatabaseSettings(String baseUrl, String username, String password) {
    }
}
