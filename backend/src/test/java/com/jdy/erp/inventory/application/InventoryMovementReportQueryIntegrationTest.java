package com.jdy.erp.inventory.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.time.Clock;
import java.time.Duration;
import java.time.LocalDate;
import java.time.OffsetDateTime;
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

class InventoryMovementReportQueryIntegrationTest {
    private static final String PUBLIC_ACCOUNT_SET = "00000000-0000-0000-0000-000000000001";
    private static final String TENANT_ACCOUNT_SET = "00000000-0000-0000-0000-000000000148";
    private static final String DECOY_SCOPE = "00000000-0000-0000-0000-000000009148";

    @TempDir
    Path exportDirectory;

    @Test
    void publicAndTenantScopesKeepCountRowsTotalsAndCsvIsolatedWithHonestTraceFallback() throws Exception {
        assertThatThrownBy(() -> requireIsolatedDatabaseName("jdy_erp"))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("shared jdy_erp");

        Class.forName("org.postgresql.Driver");
        var settings = databaseSettings();
        var databaseName = requireIsolatedDatabaseName(
            "a148_report_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12)
        );
        var tenantSchema = "tenant_a148";
        var tenantScope = dataScopeId(databaseName, tenantSchema);
        var created = false;
        HikariDataSource platformDataSource = null;
        TenantDataSourceRegistry tenantRegistry = null;
        ReportExportCleanupManager cleanupManager = null;
        try {
            createDatabase(settings, databaseName);
            created = true;
            setDatabaseTimeZone(settings, databaseName, "America/Los_Angeles");

            var properties = new DataSourceProperties();
            properties.setUrl(databaseUrl(settings.baseUrl(), databaseName));
            properties.setUsername(settings.username());
            properties.setPassword(settings.password());
            platformDataSource = properties.initializeDataSourceBuilder().type(HikariDataSource.class).build();
            platformDataSource.setMinimumIdle(0);
            platformDataSource.setMaximumPoolSize(3);
            platformDataSource.setPoolName("a148-isolated-platform");
            var platformJdbc = new JdbcTemplate(platformDataSource);
            tenantRegistry = new TenantDataSourceRegistry(properties);
            var routingDataSource = new TenantRoutingDataSource(platformDataSource, tenantRegistry);
            var tenantJdbc = new JdbcTemplate(routingDataSource);
            cleanupManager = new ReportExportCleanupManager(
                exportDirectory,
                Clock.systemUTC(),
                Duration.ofHours(2),
                () -> "a148-inventory-test",
                Files::deleteIfExists
            );
            cleanupManager.afterPropertiesSet();

            createAccountSetRegistry(platformJdbc, databaseName, tenantSchema);
            createFixtureTables(platformJdbc, "public");
            platformJdbc.execute("CREATE SCHEMA " + quote(tenantSchema));
            createFixtureTables(platformJdbc, tenantSchema);
            insertFixture(platformJdbc, "public", PUBLIC_ACCOUNT_SET, DECOY_SCOPE, "PUBLIC");
            insertFixture(platformJdbc, tenantSchema, tenantScope, DECOY_SCOPE, "TENANT");
            insertMovementBatch(platformJdbc, "public", PUBLIC_ACCOUNT_SET, "PUBLIC", LocalDate.of(2026, 7, 15), 21, "PAGE");
            insertMovementBatch(platformJdbc, "public", PUBLIC_ACCOUNT_SET, "PUBLIC", LocalDate.of(2026, 7, 17), 20_001, "LIMIT");
            insertDrillFixtures(platformJdbc, "public", PUBLIC_ACCOUNT_SET, "PUBLIC", LocalDate.of(2026, 7, 18));

            var permissionService = mock(CurrentPermissionService.class);
            var currentSession = mock(CurrentSessionService.class);
            when(currentSession.currentAccountSetId()).thenReturn(PUBLIC_ACCOUNT_SET);
            when(currentSession.optionalCurrentUsername()).thenReturn("admin");
            var dataScopeService = spy(new TenantDataScopeService(currentSession));
            var spec = new InventoryMovementReportQuerySpec().inventoryMovementDetailReportQuerySpec();
            var service = new ReportQueryService(
                new ReportQuerySpecRegistry(List.of(spec)),
                new ReportQueryParser(),
                new ReportQueryPlanner(),
                new SqlReportQueryExecutor(tenantJdbc, new ReportCsvWriter(), cleanupManager),
                permissionService,
                mock(OperationLogService.class),
                new DataSourceTransactionManager(routingDataSource),
                currentSession,
                dataScopeService,
                platformJdbc
            );

            TenantContext.setTenant(tenant(PUBLIC_ACCOUNT_SET, databaseName, "public", "BLD-TEST"));
            assertScope(service, "PUBLIC", "PUBLIC-DECOY");
            assertFilterContract(service, "PUBLIC-GEAR");
            assertStablePagination(service);
            assertEmptyResult(service);
            assertInvalidQuery(service);
            assertExportLimit(service);
            assertAllMappedExactDrills(service);

            TenantContext.setTenant(tenant(TENANT_ACCOUNT_SET, databaseName, tenantSchema, "A148-TENANT"));
            assertScope(service, "TENANT", "TENANT-DECOY");

            doThrow(new ResponseStatusException(HttpStatus.FORBIDDEN, "forbidden"))
                .when(permissionService).requirePermission("inventory.stock.view");
            assertThatThrownBy(() -> service.query(InventoryMovementReportQuerySpec.REPORT_KEY, validQuery("2026-07-14")))
                .isInstanceOfSatisfying(ResponseStatusException.class, failure ->
                    assertThat(failure.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN));

            verify(permissionService, times(12)).requirePermission("inventory.stock.view");
            verify(dataScopeService, times(11)).currentScopeId("inventory");
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

    private void assertScope(ReportQueryService service, String prefix, String excludedPrefix) throws Exception {
        var parameters = Map.of(
            "dateFrom", List.of("2026-07-14"),
            "dateTo", List.of("2026-07-14"),
            "page", List.of("1"),
            "pageSize", List.of("20")
        );
        var response = service.query(InventoryMovementReportQuerySpec.REPORT_KEY, parameters);

        assertThat(response.reportKey()).isEqualTo("inventory-movement-detail");
        assertThat(response.total()).isEqualTo(4L);
        assertThat(response.rows()).hasSize(4);
        assertThat(response.rows()).extracting(row -> row.get("sourceBillNo"))
            .containsExactlyInAnyOrder(
                prefix + "-SO-TRACE",
                prefix + "-SO-TRACE",
                prefix + "-LEGACY-001",
                prefix + "-OPEN-001"
            )
            .noneMatch(value -> String.valueOf(value).contains(excludedPrefix));
        assertThat(response.rows()).anySatisfy(row -> assertThat(row)
            .containsEntry("sourceBillNo", prefix + "-SO-TRACE")
            .containsEntry("sourceTarget", "salesOut")
            .containsEntry("sourceLineNo", 3)
            .containsEntry("traceQuality", "EXACT")
            .containsEntry("inboundQty", "12.34")
            .containsEntry("outboundQty", "0"));
        assertThat(response.rows()).anySatisfy(row -> {
            assertThat(row)
                .containsEntry("sourceBillNo", prefix + "-LEGACY-001")
                .containsEntry("dateBasis", "POSTING_FALLBACK")
                .containsEntry("traceQuality", "LEGACY")
                .containsEntry("inboundQty", "0")
                .containsEntry("outboundQty", "2.5")
                .containsEntry("qtyOnHandAfter", null)
                .containsEntry("sourceTarget", null);
            assertThat(String.valueOf(row.get("businessDate"))).startsWith("2026-07-14");
        });
        assertThat(response.totals()).hasSize(3).anySatisfy(total -> assertThat(total)
            .containsEntry("productCode", prefix + "-P-001")
            .containsEntry("unit", "PCS")
            .containsEntry("inboundQty", "12.34")
            .containsEntry("outboundQty", "2.5"));
        assertThat(response.totals()).anySatisfy(total -> assertThat(total)
            .containsEntry("productCode", prefix + "-P-002")
            .containsEntry("unit", "kg")
            .containsEntry("inboundQty", "1.125")
            .containsEntry("outboundQty", "0"));
        assertThat(response.totals()).anySatisfy(total -> assertThat(total)
            .containsEntry("productCode", prefix + "-P-003")
            .containsEntry("unit", "PCS")
            .containsEntry("inboundQty", "4.25")
            .containsEntry("outboundQty", "0"));
        assertThat(response.query()).doesNotContainKeys(
            "scope", "schema", "accountSetId", "tenantId", "dataScope", "inventory"
        );

        var artifact = service.prepareExport(InventoryMovementReportQuerySpec.REPORT_KEY, parameters);
        var path = artifact.path();
        try {
            var csv = Files.readString(path, StandardCharsets.UTF_8);
            assertThat(artifact.rowCount()).isEqualTo(response.total());
            assertThat(csv)
                .contains(prefix + "-SO-TRACE")
                .contains(prefix + "-LEGACY-001")
                .contains("12.3400")
                .contains("2.5000")
                .contains("1.1250")
                .contains("4.2500")
                .contains("POSTING_FALLBACK")
                .contains("历史记账日期（业务日期缺失）")
                .contains("历史结存不可精确还原")
                .contains("历史流水（源单不可定位）")
                .doesNotContain(excludedPrefix)
                .doesNotContain("金额")
                .doesNotContain("币种")
                .doesNotContain("单价");
        } finally {
            artifact.release("a148-scope-proof");
        }
        assertThat(Files.exists(path)).isFalse();
    }

    private void assertFilterContract(ReportQueryService service, String expectedProductName) {
        var response = service.query(InventoryMovementReportQuerySpec.REPORT_KEY, Map.of(
            "dateFrom", List.of("2026-07-14"),
            "dateTo", List.of("2026-07-14"),
            "keyword", List.of("SO TRACE"),
            "sourceType", List.of("SALES"),
            "sourceBillNo", List.of("SO-TRACE"),
            "product", List.of("Gear"),
            "warehouse", List.of("Main"),
            "sortField", List.of("productCode"),
            "sortOrder", List.of("asc")
        ));
        assertThat(response.total()).isEqualTo(1L);
        assertThat(response.rows()).singleElement().satisfies(row -> assertThat(row)
            .containsEntry("productName", expectedProductName));
        assertThat(response.totals()).singleElement().satisfies(total -> assertThat(total)
            .containsEntry("unit", "kg")
            .containsEntry("inboundQty", "1.125"));
    }

    private void assertStablePagination(ReportQueryService service) {
        var pageOneQuery = Map.of(
            "dateFrom", List.of("2026-07-15"),
            "dateTo", List.of("2026-07-15"),
            "page", List.of("1"),
            "pageSize", List.of("20"),
            "sortField", List.of("businessDate"),
            "sortOrder", List.of("desc")
        );
        var pageOne = service.query(InventoryMovementReportQuerySpec.REPORT_KEY, pageOneQuery);
        var pageOneRepeat = service.query(InventoryMovementReportQuerySpec.REPORT_KEY, pageOneQuery);
        var pageTwo = service.query(InventoryMovementReportQuerySpec.REPORT_KEY, Map.of(
            "dateFrom", List.of("2026-07-15"),
            "dateTo", List.of("2026-07-15"),
            "page", List.of("2"),
            "pageSize", List.of("20"),
            "sortField", List.of("businessDate"),
            "sortOrder", List.of("desc")
        ));

        assertThat(pageOne.total()).isEqualTo(21L);
        assertThat(pageOne.rows()).hasSize(20).isEqualTo(pageOneRepeat.rows());
        assertThat(pageTwo.rows()).hasSize(1);
        var firstPageIds = pageOne.rows().stream().map(row -> row.get("id")).toList();
        var secondPageIds = pageTwo.rows().stream().map(row -> row.get("id")).toList();
        assertThat(firstPageIds).doesNotContainAnyElementsOf(secondPageIds);
    }

    private void assertEmptyResult(ReportQueryService service) {
        var response = service.query(InventoryMovementReportQuerySpec.REPORT_KEY, validQuery("2026-07-16"));
        assertThat(response.total()).isZero();
        assertThat(response.rows()).isEmpty();
        assertThat(response.totals()).isEmpty();
    }

    private void assertInvalidQuery(ReportQueryService service) {
        assertThatThrownBy(() -> service.query(InventoryMovementReportQuerySpec.REPORT_KEY, Map.of(
            "dateFrom", List.of("2026-07-14"),
            "dateTo", List.of("2026-07-14"),
            "unknownFilter", List.of("forbidden")
        ))).isInstanceOfSatisfying(ResponseStatusException.class, failure ->
            assertThat(failure.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));
    }

    private void assertExportLimit(ReportQueryService service) {
        assertThatThrownBy(() -> service.prepareExport(
            InventoryMovementReportQuerySpec.REPORT_KEY,
            validQuery("2026-07-17")
        )).isInstanceOfSatisfying(ResponseStatusException.class, failure ->
            assertThat(failure.getStatusCode()).isEqualTo(HttpStatus.PAYLOAD_TOO_LARGE));
    }

    private Map<String, List<String>> validQuery(String date) {
        return Map.of("dateFrom", List.of(date), "dateTo", List.of(date));
    }

    private void assertAllMappedExactDrills(ReportQueryService service) {
        var response = service.query(InventoryMovementReportQuerySpec.REPORT_KEY, validQuery("2026-07-18"));
        assertThat(response.total()).isEqualTo(drillMappings().size());
        assertThat(response.rows()).hasSize(drillMappings().size());
        for (var mapping : drillMappings()) {
            assertThat(response.rows()).anySatisfy(row -> assertThat(row)
                .containsEntry("sourceBillType", mapping.sourceType())
                .containsEntry("sourceTarget", mapping.target())
                .containsEntry("sourceLineNo", 7)
                .containsEntry("traceQuality", "EXACT"));
        }
    }

    private void createFixtureTables(JdbcTemplate jdbc, String schema) {
        var prefix = quote(schema) + ".";
        jdbc.execute("""
            CREATE TABLE %smd_product (
                id UUID PRIMARY KEY,
                code TEXT NOT NULL,
                name TEXT NOT NULL,
                spec TEXT,
                unit TEXT NOT NULL
            )
            """.formatted(prefix));
        jdbc.execute("""
            CREATE TABLE %smd_warehouse (
                id UUID PRIMARY KEY,
                code TEXT NOT NULL,
                name TEXT NOT NULL
            )
            """.formatted(prefix));
        for (var mapping : drillMappings()) {
            jdbc.execute("CREATE TABLE " + prefix + quote(mapping.headerTable()) + " (id UUID PRIMARY KEY, bill_no TEXT NOT NULL)");
            jdbc.execute("CREATE TABLE " + prefix + quote(mapping.lineTable()) + " (id UUID PRIMARY KEY, "
                + quote(mapping.lineForeignKey()) + " UUID NOT NULL, line_no INTEGER NOT NULL)");
        }
        jdbc.execute("""
            CREATE TABLE %sinv_stock_txn (
                id UUID PRIMARY KEY,
                account_set_id UUID NOT NULL,
                txn_type TEXT NOT NULL,
                product_id UUID NOT NULL,
                warehouse_id UUID NOT NULL,
                qty_delta NUMERIC(18, 4) NOT NULL,
                source_bill_type TEXT NOT NULL,
                source_bill_id UUID NOT NULL,
                source_bill_line_id UUID,
                source_bill_no TEXT,
                source_bill_date DATE,
                posting_action TEXT,
                qty_on_hand_after NUMERIC(18, 4),
                trace_quality TEXT,
                occurred_at TIMESTAMPTZ NOT NULL
            )
            """.formatted(prefix));
    }

    private void insertFixture(JdbcTemplate jdbc, String schema, String scopeId, String decoyScope, String prefix) {
        var tablePrefix = quote(schema) + ".";
        var product = deterministicId(prefix + ":PRODUCT:PCS");
        var gear = deterministicId(prefix + ":PRODUCT:KG");
        var washer = deterministicId(prefix + ":PRODUCT:PCS:SECOND");
        var warehouse = deterministicId(prefix + ":WAREHOUSE");
        var header = deterministicId(prefix + ":SALES_OUT");
        var line = deterministicId(prefix + ":SALES_OUT_LINE:3");
        var gearLine = deterministicId(prefix + ":SALES_OUT_LINE:4");
        var billNo = prefix + "-SO-TRACE";
        jdbc.update("INSERT INTO " + tablePrefix + "md_product (id, code, name, spec, unit) VALUES (?::uuid, ?, ?, ?, ?)",
            product, prefix + "-P-001", prefix + "-Bolt", "M8", "PCS");
        jdbc.update("INSERT INTO " + tablePrefix + "md_product (id, code, name, spec, unit) VALUES (?::uuid, ?, ?, ?, ?)",
            gear, prefix + "-P-002", prefix + "-GEAR", "20T", "kg");
        jdbc.update("INSERT INTO " + tablePrefix + "md_product (id, code, name, spec, unit) VALUES (?::uuid, ?, ?, ?, ?)",
            washer, prefix + "-P-003", prefix + "-WASHER", "M8", "PCS");
        jdbc.update("INSERT INTO " + tablePrefix + "md_warehouse (id, code, name) VALUES (?::uuid, ?, ?)",
            warehouse, prefix + "-WH", "Main Warehouse");
        jdbc.update("INSERT INTO " + tablePrefix + "sales_out (id, bill_no) VALUES (?::uuid, ?)", header, billNo);
        jdbc.update("INSERT INTO " + tablePrefix + "sales_out_line (id, bill_id, line_no) VALUES (?::uuid, ?::uuid, 3)", line, header);
        jdbc.update("INSERT INTO " + tablePrefix + "sales_out_line (id, bill_id, line_no) VALUES (?::uuid, ?::uuid, 4)", gearLine, header);

        insertTxn(jdbc, tablePrefix, deterministicId(prefix + ":TXN:EXACT"), scopeId, product, warehouse,
            "12.3400", "SALES_OUT", header, line, billNo, LocalDate.of(2026, 7, 14), "AUDIT", "12.3400", "EXACT",
            OffsetDateTime.parse("2026-07-14T02:00:00Z"));
        insertTxn(jdbc, tablePrefix, deterministicId(prefix + ":TXN:GEAR"), scopeId, gear, warehouse,
            "1.1250", "SALES_OUT", header, gearLine, billNo, LocalDate.of(2026, 7, 14), "AUDIT", "1.1250", "EXACT",
            OffsetDateTime.parse("2026-07-14T02:01:00Z"));
        insertTxn(jdbc, tablePrefix, deterministicId(prefix + ":TXN:LEGACY"), scopeId, product, warehouse,
            "-2.5000", "LEGACY:" + prefix + "-LEGACY-001", deterministicId(prefix + ":LEGACY:H"), null,
            prefix + "-LEGACY-001", null, "AUDIT", null, "LEGACY", OffsetDateTime.parse("2026-07-13T16:30:00Z"));
        insertTxn(jdbc, tablePrefix, deterministicId(prefix + ":TXN:CONTROLLED"), scopeId, washer, warehouse,
            "4.2500", "OPENING_STOCK", deterministicId(prefix + ":OPENING:H"), null,
            prefix + "-OPEN-001", LocalDate.of(2026, 7, 14), "AUDIT", "4.2500", "CONTROLLED",
            OffsetDateTime.parse("2026-07-14T02:02:00Z"));

        insertTxn(jdbc, tablePrefix, deterministicId(prefix + ":TXN:DECOY"), decoyScope, product, warehouse,
            "999.0000", "SALES_OUT", header, line, billNo, LocalDate.of(2026, 7, 14), "AUDIT", "999.0000", "EXACT",
            OffsetDateTime.parse("2026-07-14T02:00:00Z"));
        insertTxn(jdbc, tablePrefix, deterministicId(prefix + ":TXN:TEST"), scopeId, product, warehouse,
            "888.0000", "A148:TEST", deterministicId(prefix + ":TEST:H"), deterministicId(prefix + ":TEST:L"),
            "A148-TEST", null, "AUDIT", "888.0000", "TEST", OffsetDateTime.parse("2026-07-13T16:30:00Z"));
        insertTxn(jdbc, tablePrefix, deterministicId(prefix + ":TXN:ZERO"), scopeId, product, warehouse,
            "0.0000", "SALES_OUT", header, line, billNo, LocalDate.of(2026, 7, 14), "RESERVE", "12.3400", "EXACT",
            OffsetDateTime.parse("2026-07-14T03:00:00Z"));
        insertTxn(jdbc, tablePrefix, deterministicId(prefix + ":TXN:MISSING_DATE"), scopeId, product, warehouse,
            "777.0000", "SALES_OUT", header, null, billNo, null, "AUDIT", "777.0000", "HEADER_ONLY",
            OffsetDateTime.parse("2026-07-13T16:30:00Z"));
    }

    private void insertMovementBatch(
        JdbcTemplate jdbc,
        String schema,
        String scopeId,
        String fixturePrefix,
        LocalDate businessDate,
        int count,
        String batchCode
    ) {
        var tablePrefix = quote(schema) + ".";
        jdbc.update("""
            INSERT INTO %sinv_stock_txn (
                id, account_set_id, txn_type, product_id, warehouse_id, qty_delta,
                source_bill_type, source_bill_id, source_bill_line_id, source_bill_no,
                source_bill_date, posting_action, qty_on_hand_after, trace_quality, occurred_at
            )
            SELECT md5(CAST(? AS text) || ':TXN:' || series_no)::uuid,
                   ?::uuid,
                   'MOVEMENT',
                   ?::uuid,
                   ?::uuid,
                   1.0000,
                   'OPENING_STOCK',
                   md5(CAST(? AS text) || ':SOURCE:' || series_no)::uuid,
                   NULL,
                   CAST(? AS text) || '-' || lpad(series_no::text, 6, '0'),
                   ?::date,
                   'AUDIT',
                   series_no::numeric,
                   'CONTROLLED',
                   (?::date::timestamp AT TIME ZONE 'UTC') + series_no * interval '1 microsecond'
            FROM generate_series(1, ?) generated(series_no)
            """.formatted(tablePrefix),
            batchCode,
            scopeId,
            deterministicId(fixturePrefix + ":PRODUCT:PCS"),
            deterministicId(fixturePrefix + ":WAREHOUSE"),
            batchCode,
            batchCode,
            businessDate,
            businessDate,
            count
        );
    }

    private void insertDrillFixtures(
        JdbcTemplate jdbc,
        String schema,
        String scopeId,
        String fixturePrefix,
        LocalDate businessDate
    ) {
        var tablePrefix = quote(schema) + ".";
        var productId = deterministicId(fixturePrefix + ":PRODUCT:PCS");
        var warehouseId = deterministicId(fixturePrefix + ":WAREHOUSE");
        for (var mapping : drillMappings()) {
            var headerId = deterministicId(fixturePrefix + ":DRILL:" + mapping.sourceType() + ":HEADER");
            var lineId = deterministicId(fixturePrefix + ":DRILL:" + mapping.sourceType() + ":LINE");
            var billNo = fixturePrefix + "-DRILL-" + mapping.sourceType();
            jdbc.update("INSERT INTO " + tablePrefix + quote(mapping.headerTable()) + " (id, bill_no) VALUES (?::uuid, ?)",
                headerId, billNo);
            jdbc.update("INSERT INTO " + tablePrefix + quote(mapping.lineTable()) + " (id, "
                    + quote(mapping.lineForeignKey()) + ", line_no) VALUES (?::uuid, ?::uuid, 7)",
                lineId, headerId);
            insertTxn(
                jdbc,
                tablePrefix,
                deterministicId(fixturePrefix + ":DRILL:" + mapping.sourceType() + ":TXN"),
                scopeId,
                productId,
                warehouseId,
                "1.0000",
                mapping.sourceType(),
                headerId,
                lineId,
                billNo,
                businessDate,
                "AUDIT",
                "1.0000",
                "EXACT",
                OffsetDateTime.parse("2026-07-18T02:00:00Z")
            );
        }
    }

    private List<DrillMapping> drillMappings() {
        return List.of(
            new DrillMapping("SALES_OUT", "sales_out", "sales_out_line", "bill_id", "salesOut"),
            new DrillMapping("SALES_RETURN", "sales_return", "sales_return_line", "bill_id", "salesReturn"),
            new DrillMapping("PURCHASE_IN", "purchase_in", "purchase_in_line", "bill_id", "purchaseIn"),
            new DrillMapping("PURCHASE_RETURN", "purchase_return", "purchase_return_line", "bill_id", "purchaseReturn"),
            new DrillMapping("PRODUCTION_MATERIAL_ISSUE", "production_material_issue", "production_material_issue_line", "issue_id", "materialIssue"),
            new DrillMapping("PRODUCTION_COMPLETION", "production_completion", "production_completion_line", "completion_id", "productIn"),
            new DrillMapping("OTHER_STOCK_IN", "other_stock_in", "other_stock_in_line", "bill_id", "otherStockIn"),
            new DrillMapping("OTHER_STOCK_OUT", "other_stock_out", "other_stock_out_line", "bill_id", "otherStockOut"),
            new DrillMapping("STOCK_TRANSFER", "stock_transfer", "stock_transfer_line", "bill_id", "stockTransfer"),
            new DrillMapping("STOCK_COUNT_GAIN", "stock_count_gain", "stock_count_gain_line", "bill_id", "stockCountGain"),
            new DrillMapping("STOCK_COUNT_LOSS", "stock_count_loss", "stock_count_loss_line", "bill_id", "stockCountLoss")
        );
    }

    private void insertTxn(
        JdbcTemplate jdbc,
        String tablePrefix,
        String id,
        String accountSetId,
        String productId,
        String warehouseId,
        String quantity,
        String sourceType,
        String sourceId,
        String sourceLineId,
        String sourceNo,
        LocalDate sourceDate,
        String action,
        String balance,
        String quality,
        OffsetDateTime occurredAt
    ) {
        jdbc.update("""
            INSERT INTO %sinv_stock_txn (
                id, account_set_id, txn_type, product_id, warehouse_id, qty_delta,
                source_bill_type, source_bill_id, source_bill_line_id, source_bill_no,
                source_bill_date, posting_action, qty_on_hand_after, trace_quality, occurred_at
            ) VALUES (
                ?::uuid, ?::uuid, 'MOVEMENT', ?::uuid, ?::uuid, ?, ?, ?::uuid, ?::uuid, ?, ?, ?, ?, ?, ?
            )
            """.formatted(tablePrefix),
            id, accountSetId, productId, warehouseId, new BigDecimal(quantity), sourceType, sourceId,
            sourceLineId, sourceNo, sourceDate, action, balance == null ? null : new BigDecimal(balance), quality, occurredAt
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

    private String dataScopeId(String databaseName, String schema) {
        return UUID.nameUUIDFromBytes(
            ("inventory:" + databaseName + ":" + schema).getBytes(StandardCharsets.UTF_8)
        ).toString();
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

    private void setDatabaseTimeZone(DatabaseSettings settings, String databaseName, String timeZone) throws Exception {
        try (var connection = DriverManager.getConnection(
            databaseUrl(settings.baseUrl(), "postgres"), settings.username(), settings.password()
        ); var statement = connection.createStatement()) {
            statement.execute("ALTER DATABASE " + quote(databaseName) + " SET timezone TO '" + timeZone + "'");
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
            throw new IllegalStateException("A148 test refuses shared jdy_erp");
        }
        if (databaseName == null || !databaseName.matches("a148_report_[a-z0-9]{12}")) {
            throw new IllegalArgumentException("A148 database name is not isolated");
        }
        return databaseName;
    }

    private String databaseUrl(String baseUrl, String databaseName) {
        if (baseUrl == null || !baseUrl.startsWith("jdbc:postgresql://")) {
            throw new IllegalStateException("A148 requires PostgreSQL");
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

    private record DrillMapping(
        String sourceType,
        String headerTable,
        String lineTable,
        String lineForeignKey,
        String target
    ) {
    }

    private record DatabaseSettings(String baseUrl, String username, String password) {
    }
}
