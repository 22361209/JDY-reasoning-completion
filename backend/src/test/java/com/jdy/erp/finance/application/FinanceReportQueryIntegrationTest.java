package com.jdy.erp.finance.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

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

import com.jdy.erp.reports.application.ReportCsvWriter;
import com.jdy.erp.reports.application.ReportExportCleanupManager;
import com.jdy.erp.reports.application.ReportQueryParser;
import com.jdy.erp.reports.application.ReportQueryPlanner;
import com.jdy.erp.reports.application.ReportQueryService;
import com.jdy.erp.reports.application.ReportQuerySpec;
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
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.autoconfigure.jdbc.DataSourceProperties;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

class FinanceReportQueryIntegrationTest {
    private static final String TENANT_A_ID = "00000000-0000-0000-0000-000000000150";
    private static final String TENANT_B_ID = "00000000-0000-0000-0000-000000000250";
    private static final LocalDate DATE_FROM = LocalDate.of(2026, 7, 1);
    private static final LocalDate DATE_TO = LocalDate.of(2026, 7, 31);

    @TempDir
    Path exportDirectory;

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    @Test
    void definitionsRegisterOnlyFourExactKeysAndNeverReadSettlementSnapshots() {
        var specs = definitions();
        var registry = new ReportQuerySpecRegistry(specs);

        assertThat(registry.size()).isEqualTo(4);
        for (var key : List.of(
            "receivable-detail",
            "receivable-summary",
            "payable-detail",
            "payable-summary"
        )) {
            var spec = registry.require(key);
            assertThat(spec.requiredPermission()).isEqualTo("finance.report.view");
            assertThat(spec.requiresDateRange()).isTrue();
            assertThat(spec.sourceSql())
                .doesNotContain("received_amount", "paid_amount", "return_offset_amount")
                .doesNotContain("DefaultStub", "SeedRows", "sales_order");
        }

        assertThat(registry.require("receivable-detail").sourceSql())
            .contains(
                "receivable.status IN ('OPEN', 'PART_SETTLED', 'SETTLED')",
                "receipt.status = 'AUDITED'",
                "sales_return.status = 'AUDITED'",
                "-allocation.settlement_amount",
                "-allocation.offset_amount"
            )
            .doesNotContain("receivable.status = 'AUDITED'");
        assertThat(registry.require("payable-detail").sourceSql())
            .contains(
                "payable.status IN ('OPEN', 'PART_SETTLED', 'SETTLED')",
                "payment.status = 'AUDITED'",
                "-allocation.settlement_amount"
            )
            .doesNotContain("payable.status = 'AUDITED'");

        var parser = new ReportQueryParser();
        var planner = new ReportQueryPlanner();
        var summary = registry.require("receivable-summary");
        var plan = planner.plan(summary, parser.parse(summary, query(null, null)));
        assertThat(plan.factPredicateSql()).isEqualTo("TRUE");
        assertThat(plan.parametersWithSource(summary)).containsExactly(
            DATE_FROM,
            DATE_FROM, DATE_TO,
            DATE_FROM, DATE_TO,
            DATE_FROM, DATE_TO,
            DATE_FROM, DATE_TO,
            DATE_FROM, DATE_TO,
            DATE_TO,
            DATE_TO
        );
    }

    @Test
    void routedPostgresRebuildsReceivableAndPayablePeriodsWithCurrencyIsolationAndExactDecimals()
        throws Exception {
        Class.forName("org.postgresql.Driver");
        var settings = databaseSettings();
        var databaseName = requireIsolatedDatabaseName(
            "a150_finance_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12)
        );
        var tenantASchema = "tenant_a150_a";
        var tenantBSchema = "tenant_a150_b";
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
            platformDataSource.setPoolName("a150-finance-platform");
            var platformJdbc = new JdbcTemplate(platformDataSource);

            createFinanceSchema(platformJdbc, tenantASchema);
            createFinanceSchema(platformJdbc, tenantBSchema);
            createAccountSetRegistry(platformJdbc, databaseName, tenantASchema, tenantBSchema);
            var tenantA = insertTenantAFixtures(platformJdbc, tenantASchema);
            insertTenantBDecoys(platformJdbc, tenantBSchema);

            tenantRegistry = new TenantDataSourceRegistry(properties);
            var routingDataSource = new TenantRoutingDataSource(platformDataSource, tenantRegistry);
            cleanupManager = new ReportExportCleanupManager(
                exportDirectory,
                Clock.systemUTC(),
                Duration.ofHours(2),
                () -> "a150-finance-test",
                Files::deleteIfExists
            );
            cleanupManager.afterPropertiesSet();
            var permissionService = mock(CurrentPermissionService.class);
            var service = new ReportQueryService(
                new ReportQuerySpecRegistry(definitions()),
                new ReportQueryParser(),
                new ReportQueryPlanner(),
                new SqlReportQueryExecutor(
                    new JdbcTemplate(routingDataSource),
                    new ReportCsvWriter(),
                    cleanupManager
                ),
                permissionService,
                mock(OperationLogService.class),
                new DataSourceTransactionManager(routingDataSource),
                mock(CurrentSessionService.class),
                mock(TenantDataScopeService.class),
                platformJdbc
            );

            TenantContext.setTenant(tenant(TENANT_A_ID, databaseName, tenantASchema, "A150-A"));
            assertCnyBaselines(service, tenantA);
            assertCurrencyTotalsSeparated(service);
            assertUsdEventsAndParentStatusRebuild(service, platformJdbc, tenantASchema, tenantA);
            assertTenantAndExportIsolation(service, databaseName, tenantBSchema, tenantA);

            verify(permissionService, atLeastOnce()).requirePermission("finance.report.view");
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

    private void assertCnyBaselines(ReportQueryService service, TenantAFixtures fixture) {
        var receivable = service.query(
            "receivable-summary",
            query(fixture.cnyCustomerId(), "CNY")
        );
        assertThat(receivable.total()).isEqualTo(1L);
        assertThat(receivable.rows()).singleElement().satisfies(row -> assertThat(row)
            .containsEntry("partyCode", "CUST-CNY")
            .containsEntry("currency", "CNY")
            .containsEntry("openingBalance", "1877597.16")
            .containsEntry("occurrenceAmount", "0")
            .containsEntry("settledAmount", "13210")
            .containsEntry("returnOffsetAmount", "0")
            .containsEntry("pendingRefundAmount", "0")
            .containsEntry("periodNetAmount", "-13210")
            .containsEntry("closingBalance", "1864387.16"));
        assertThat(receivable.totals()).singleElement().satisfies(total -> assertThat(total)
            .containsEntry("currency", "CNY")
            .containsEntry("closingBalance", "1864387.16"));
        assertThat(receivable.rows().getFirst().get("closingBalance")).isInstanceOf(String.class);

        var payable = service.query(
            "payable-summary",
            query(fixture.cnySupplierId(), "CNY")
        );
        assertThat(payable.total()).isEqualTo(1L);
        assertThat(payable.rows()).singleElement().satisfies(row -> assertThat(row)
            .containsEntry("partyCode", "SUP-CNY")
            .containsEntry("currency", "CNY")
            .containsEntry("openingBalance", "1414929.1")
            .containsEntry("occurrenceAmount", "0")
            .containsEntry("settledAmount", "15540")
            .containsEntry("periodNetAmount", "-15540")
            .containsEntry("closingBalance", "1399389.1"));
        assertThat(payable.totals()).singleElement().satisfies(total -> assertThat(total)
            .containsEntry("currency", "CNY")
            .containsEntry("closingBalance", "1399389.1"));

        var receiptDetail = service.query(
            "receivable-detail",
            query(fixture.cnyCustomerId(), "CNY")
        );
        assertThat(receiptDetail.total()).isEqualTo(1L);
        assertThat(receiptDetail.rows()).singleElement().satisfies(row -> assertThat(row)
            .containsEntry("eventType", "RECEIPT_ALLOCATION")
            .containsEntry("occurrenceAmount", "0")
            .containsEntry("settledAmount", "13210")
            .containsEntry("balanceDelta", "-13210"));

        var paymentDetail = service.query(
            "payable-detail",
            query(fixture.cnySupplierId(), "CNY")
        );
        assertThat(paymentDetail.total()).isEqualTo(1L);
        assertThat(paymentDetail.rows()).singleElement().satisfies(row -> assertThat(row)
            .containsEntry("eventType", "PAYMENT_ALLOCATION")
            .containsEntry("settledAmount", "15540")
            .containsEntry("balanceDelta", "-15540"));
    }

    private void assertUsdEventsAndParentStatusRebuild(
        ReportQueryService service,
        JdbcTemplate platformJdbc,
        String schema,
        TenantAFixtures fixture
    ) {
        var receivable = service.query(
            "receivable-summary",
            query(fixture.usdCustomerId(), "USD")
        );
        assertThat(receivable.rows()).singleElement().satisfies(row -> assertThat(row)
            .containsEntry("openingBalance", "1000")
            .containsEntry("occurrenceAmount", "-20")
            .containsEntry("settledAmount", "100")
            .containsEntry("returnOffsetAmount", "150")
            .containsEntry("pendingRefundAmount", "25")
            .containsEntry("periodNetAmount", "-270")
            .containsEntry("closingBalance", "730"));

        var detail = service.query(
            "receivable-detail",
            query(fixture.usdCustomerId(), "USD")
        );
        assertThat(detail.total()).isEqualTo(3L);
        assertThat(detail.rows()).extracting(row -> row.get("eventType"))
            .containsExactlyInAnyOrder("AR_FACT", "RECEIPT_ALLOCATION", "RETURN_ALLOCATION");
        assertThat(detail.rows()).filteredOn(row -> "RETURN_ALLOCATION".equals(row.get("eventType")))
            .singleElement()
            .satisfies(row -> assertThat(row)
                .containsEntry("returnOffsetAmount", "150")
                .containsEntry("pendingRefundAmount", "25")
                .containsEntry("balanceDelta", "-150"));

        var payable = service.query(
            "payable-summary",
            query(fixture.usdSupplierId(), "USD")
        );
        assertThat(payable.rows()).singleElement().satisfies(row -> assertThat(row)
            .containsEntry("openingBalance", "500")
            .containsEntry("occurrenceAmount", "-10")
            .containsEntry("settledAmount", "40")
            .containsEntry("periodNetAmount", "-50")
            .containsEntry("closingBalance", "450"));

        var payableDetail = service.query(
            "payable-detail",
            query(fixture.usdSupplierId(), "USD")
        );
        assertThat(payableDetail.total()).isEqualTo(2L);
        assertThat(payableDetail.rows()).extracting(row -> row.get("eventType"))
            .containsExactlyInAnyOrder("AP_FACT", "PAYMENT_ALLOCATION");
        assertThat(payableDetail.rows()).extracting(row -> row.get("billNo"))
            .doesNotContain("YF-USD-RETIRED-REVERSAL");

        platformJdbc.update(
            "UPDATE " + quote(schema) + ".ar_receipt SET status = 'AUDITED' WHERE id = ?::uuid",
            fixture.draftReceiptId()
        );
        assertThat(service.query("receivable-summary", query(fixture.usdCustomerId(), "USD"))
            .rows().getFirst())
            .containsEntry("settledAmount", "140")
            .containsEntry("closingBalance", "690");
        platformJdbc.update(
            "UPDATE " + quote(schema) + ".ar_receipt SET status = 'DRAFT' WHERE id = ?::uuid",
            fixture.draftReceiptId()
        );
        assertThat(service.query("receivable-summary", query(fixture.usdCustomerId(), "USD"))
            .rows().getFirst())
            .containsEntry("settledAmount", "100")
            .containsEntry("closingBalance", "730");

        platformJdbc.update(
            "UPDATE " + quote(schema) + ".sales_return SET status = 'DRAFT' WHERE id = ?::uuid",
            fixture.auditedReturnId()
        );
        assertThat(service.query("receivable-summary", query(fixture.usdCustomerId(), "USD"))
            .rows().getFirst())
            .containsEntry("returnOffsetAmount", "0")
            .containsEntry("pendingRefundAmount", "0")
            .containsEntry("closingBalance", "880");
        platformJdbc.update(
            "UPDATE " + quote(schema) + ".sales_return SET status = 'AUDITED' WHERE id = ?::uuid",
            fixture.auditedReturnId()
        );
    }

    private void assertCurrencyTotalsSeparated(ReportQueryService service) {
        var receivable = service.query("receivable-summary", query(null, null));
        assertThat(receivable.totals()).hasSize(2);
        assertThat(receivable.totals()).extracting(total -> total.get("currency"))
            .containsExactlyInAnyOrder("CNY", "USD");
        assertThat(receivable.totals()).filteredOn(total -> "CNY".equals(total.get("currency")))
            .singleElement()
            .satisfies(total -> assertThat(total).containsEntry("closingBalance", "1864387.16"));
        assertThat(receivable.totals()).filteredOn(total -> "USD".equals(total.get("currency")))
            .singleElement()
            .satisfies(total -> assertThat(total).containsEntry("closingBalance", "730"));

        var payable = service.query("payable-summary", query(null, null));
        assertThat(payable.totals()).hasSize(2);
        assertThat(payable.totals()).extracting(total -> total.get("currency"))
            .containsExactlyInAnyOrder("CNY", "USD");
        assertThat(payable.totals()).filteredOn(total -> "CNY".equals(total.get("currency")))
            .singleElement()
            .satisfies(total -> assertThat(total).containsEntry("closingBalance", "1399389.1"));
        assertThat(payable.totals()).filteredOn(total -> "USD".equals(total.get("currency")))
            .singleElement()
            .satisfies(total -> assertThat(total).containsEntry("closingBalance", "450"));
    }

    private void assertTenantAndExportIsolation(
        ReportQueryService service,
        String databaseName,
        String tenantBSchema,
        TenantAFixtures fixture
    ) throws Exception {
        var parameters = query(fixture.cnyCustomerId(), "CNY");
        var artifact = service.prepareExport("receivable-summary", parameters);
        var artifactPath = artifact.path();
        try {
            var csv = Files.readString(artifactPath, StandardCharsets.UTF_8);
            assertThat(artifact.rowCount()).isEqualTo(1L);
            assertThat(csv)
                .startsWith("\ufeff")
                .contains("CUST-CNY", "1877597.16", "13210.00", "1864387.16")
                .doesNotContain("TENANT-B-DECOY", "9999999.99");
        } finally {
            artifact.release("a150-finance-export");
        }
        assertThat(artifactPath).doesNotExist();

        TenantContext.setTenant(tenant(TENANT_B_ID, databaseName, tenantBSchema, "A150-B"));
        var tenantBResponse = service.query(
            "receivable-summary",
            query(FixtureIds.TENANT_B_CUSTOMER, "CNY")
        );
        assertThat(tenantBResponse.rows()).singleElement().satisfies(row -> assertThat(row)
            .containsEntry("partyName", "TENANT-B-DECOY")
            .containsEntry("openingBalance", "9999999.99")
            .containsEntry("closingBalance", "9999999.99"));
        assertThat(tenantBResponse.rows()).noneMatch(row -> "CNY 基准客户".equals(row.get("partyName")));
    }

    private List<ReportQuerySpec> definitions() {
        var configuration = new FinanceReportQuerySpec();
        return List.of(
            configuration.receivableDetailReportQuerySpec(),
            configuration.receivableSummaryReportQuerySpec(),
            configuration.payableDetailReportQuerySpec(),
            configuration.payableSummaryReportQuerySpec()
        );
    }

    private Map<String, List<String>> query(UUID partyId, String currency) {
        var query = new java.util.LinkedHashMap<String, List<String>>();
        query.put("dateFrom", List.of(DATE_FROM.toString()));
        query.put("dateTo", List.of(DATE_TO.toString()));
        if (partyId != null) {
            query.put("partyId", List.of(partyId.toString()));
        }
        if (currency != null) {
            query.put("currency", List.of(currency));
        }
        return Map.copyOf(query);
    }

    private TenantAFixtures insertTenantAFixtures(JdbcTemplate jdbc, String schema) {
        var cnyCustomer = UUID.fromString("00000000-0000-0000-0000-000000015001");
        var usdCustomer = UUID.fromString("00000000-0000-0000-0000-000000015002");
        var cnySupplier = UUID.fromString("00000000-0000-0000-0000-000000015003");
        var usdSupplier = UUID.fromString("00000000-0000-0000-0000-000000015004");
        insertParty(jdbc, schema, "md_customer", cnyCustomer, "CUST-CNY", "CNY 基准客户");
        insertParty(jdbc, schema, "md_customer", usdCustomer, "CUST-USD", "USD 测试客户");
        insertParty(jdbc, schema, "md_supplier", cnySupplier, "SUP-CNY", "CNY 基准供应商");
        insertParty(jdbc, schema, "md_supplier", usdSupplier, "SUP-USD", "USD 测试供应商");

        var cnyAr = insertReceivable(
            jdbc, schema, cnyCustomer, "YS-BASE", LocalDate.of(2026, 6, 30),
            "1877597.16", "CNY", "SETTLED", "999999.99", "888888.88"
        );
        insertReceiptAllocation(
            jdbc, schema, cnyAr, cnyCustomer, "SK-BASE", LocalDate.of(2026, 7, 2),
            "CNY", "AUDITED", "13210.00"
        );

        var cnyAp = insertPayable(
            jdbc, schema, cnySupplier, "YF-BASE", LocalDate.of(2026, 6, 30),
            "1414929.10", "CNY", "SETTLED", "999999.99"
        );
        insertPaymentAllocation(
            jdbc, schema, cnyAp, cnySupplier, "FK-BASE", LocalDate.of(2026, 7, 3),
            "CNY", "AUDITED", "15540.00"
        );

        var usdAr = insertReceivable(
            jdbc, schema, usdCustomer, "YS-USD", LocalDate.of(2026, 6, 29),
            "1000.00", "USD", "PART_SETTLED", "777.77", "666.66"
        );
        insertReceivable(
            jdbc, schema, usdCustomer, "YS-USD-RED", LocalDate.of(2026, 7, 4),
            "-20.00", "USD", "OPEN", "123.45", "54.32"
        );
        insertReceiptAllocation(
            jdbc, schema, usdAr, usdCustomer, "SK-USD", LocalDate.of(2026, 7, 5),
            "USD", "AUDITED", "100.00"
        );
        var draftReceipt = insertReceiptAllocation(
            jdbc, schema, usdAr, usdCustomer, "SK-USD-DRAFT", LocalDate.of(2026, 7, 6),
            "USD", "DRAFT", "40.00"
        );
        var auditedReturn = insertReturnAllocation(
            jdbc, schema, usdAr, usdCustomer, "XSTH-USD", LocalDate.of(2026, 7, 7),
            "USD", "AUDITED", "150.00", "25.00"
        );
        insertReturnAllocation(
            jdbc, schema, usdAr, usdCustomer, "XSTH-USD-DRAFT", LocalDate.of(2026, 7, 8),
            "USD", "DRAFT", "200.00", "30.00"
        );

        var usdAp = insertPayable(
            jdbc, schema, usdSupplier, "YF-USD", LocalDate.of(2026, 6, 29),
            "500.00", "USD", "PART_SETTLED", "444.44"
        );
        insertPayable(
            jdbc, schema, usdSupplier, "YF-USD-RETURN", LocalDate.of(2026, 7, 4),
            "-10.00", "USD", "OPEN", "222.22"
        );
        insertPayable(
            jdbc, schema, usdSupplier, "YF-USD-RETIRED-REVERSAL", LocalDate.of(2026, 7, 4),
            "99999.00", "USD", "REVERSED", "0"
        );
        insertPaymentAllocation(
            jdbc, schema, usdAp, usdSupplier, "FK-USD", LocalDate.of(2026, 7, 5),
            "USD", "AUDITED", "40.00"
        );
        insertPaymentAllocation(
            jdbc, schema, usdAp, usdSupplier, "FK-USD-DRAFT", LocalDate.of(2026, 7, 6),
            "USD", "DRAFT", "60.00"
        );

        return new TenantAFixtures(
            cnyCustomer,
            usdCustomer,
            cnySupplier,
            usdSupplier,
            draftReceipt,
            auditedReturn
        );
    }

    private void insertTenantBDecoys(JdbcTemplate jdbc, String schema) {
        var customer = FixtureIds.TENANT_B_CUSTOMER;
        var supplier = UUID.fromString("00000000-0000-0000-0000-000000025002");
        insertParty(jdbc, schema, "md_customer", customer, "CUST-CNY", "TENANT-B-DECOY");
        insertParty(jdbc, schema, "md_supplier", supplier, "SUP-CNY", "TENANT-B-SUPPLIER-DECOY");
        insertReceivable(
            jdbc, schema, customer, "YS-BASE", LocalDate.of(2026, 6, 30),
            "9999999.99", "CNY", "OPEN", "0", "0"
        );
        insertPayable(
            jdbc, schema, supplier, "YF-BASE", LocalDate.of(2026, 6, 30),
            "8888888.88", "CNY", "OPEN", "0"
        );
    }

    private UUID insertReceivable(
        JdbcTemplate jdbc,
        String schema,
        UUID customerId,
        String billNo,
        LocalDate billDate,
        String amount,
        String currency,
        String status,
        String receivedSnapshot,
        String returnOffsetSnapshot
    ) {
        var id = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO %s.ar_receivable (
                id, bill_no, source_bill_no, customer_id, bill_date, amount,
                received_amount, return_offset_amount, currency, status
            ) VALUES (?::uuid, ?, ?, ?::uuid, ?, ?, ?, ?, ?, ?)
            """.formatted(quote(schema)), id, billNo, "SOURCE-" + billNo, customerId, billDate,
            new BigDecimal(amount), new BigDecimal(receivedSnapshot), new BigDecimal(returnOffsetSnapshot),
            currency, status);
        return id;
    }

    private UUID insertPayable(
        JdbcTemplate jdbc,
        String schema,
        UUID supplierId,
        String billNo,
        LocalDate billDate,
        String amount,
        String currency,
        String status,
        String paidSnapshot
    ) {
        var id = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO %s.ap_payable (
                id, bill_no, source_bill_no, supplier_id, bill_date, amount,
                paid_amount, currency, status
            ) VALUES (?::uuid, ?, ?, ?::uuid, ?, ?, ?, ?, ?)
            """.formatted(quote(schema)), id, billNo, "SOURCE-" + billNo, supplierId, billDate,
            new BigDecimal(amount), new BigDecimal(paidSnapshot), currency, status);
        return id;
    }

    private UUID insertReceiptAllocation(
        JdbcTemplate jdbc,
        String schema,
        UUID receivableId,
        UUID customerId,
        String billNo,
        LocalDate billDate,
        String currency,
        String status,
        String amount
    ) {
        var receiptId = UUID.randomUUID();
        var allocationId = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO %s.ar_receipt (id, bill_no, party_id, bill_date, amount, currency, status)
            VALUES (?::uuid, ?, ?::uuid, ?, ?, ?, ?)
            """.formatted(quote(schema)), receiptId, billNo, customerId, billDate,
            new BigDecimal(amount), currency, status);
        jdbc.update("""
            INSERT INTO %s.ar_receipt_allocation (id, receipt_id, receivable_id, settlement_amount)
            VALUES (?::uuid, ?::uuid, ?::uuid, ?)
            """.formatted(quote(schema)), allocationId, receiptId, receivableId, new BigDecimal(amount));
        return receiptId;
    }

    private UUID insertPaymentAllocation(
        JdbcTemplate jdbc,
        String schema,
        UUID payableId,
        UUID supplierId,
        String billNo,
        LocalDate billDate,
        String currency,
        String status,
        String amount
    ) {
        var paymentId = UUID.randomUUID();
        var allocationId = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO %s.ap_payment (id, bill_no, party_id, bill_date, amount, currency, status)
            VALUES (?::uuid, ?, ?::uuid, ?, ?, ?, ?)
            """.formatted(quote(schema)), paymentId, billNo, supplierId, billDate,
            new BigDecimal(amount), currency, status);
        jdbc.update("""
            INSERT INTO %s.ap_payment_allocation (id, payment_id, payable_id, settlement_amount)
            VALUES (?::uuid, ?::uuid, ?::uuid, ?)
            """.formatted(quote(schema)), allocationId, paymentId, payableId, new BigDecimal(amount));
        return paymentId;
    }

    private UUID insertReturnAllocation(
        JdbcTemplate jdbc,
        String schema,
        UUID receivableId,
        UUID customerId,
        String billNo,
        LocalDate billDate,
        String currency,
        String status,
        String offset,
        String pending
    ) {
        var returnId = UUID.randomUUID();
        var allocationId = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO %s.sales_return (id, bill_no, customer_id, bill_date, currency, status)
            VALUES (?::uuid, ?, ?::uuid, ?, ?, ?)
            """.formatted(quote(schema)), returnId, billNo, customerId, billDate, currency, status);
        jdbc.update("""
            INSERT INTO %s.sales_return_finance_allocation (
                id, sales_return_id, receivable_id, currency, offset_amount, pending_refund_amount
            ) VALUES (?::uuid, ?::uuid, ?::uuid, ?, ?, ?)
            """.formatted(quote(schema)), allocationId, returnId, receivableId, currency,
            new BigDecimal(offset), new BigDecimal(pending));
        return returnId;
    }

    private void insertParty(
        JdbcTemplate jdbc,
        String schema,
        String table,
        UUID id,
        String code,
        String name
    ) {
        if (!"md_customer".equals(table) && !"md_supplier".equals(table)) {
            throw new IllegalArgumentException("unsupported fixture party table");
        }
        jdbc.update(
            "INSERT INTO " + quote(schema) + "." + table + " (id, code, name) VALUES (?::uuid, ?, ?)",
            id,
            code,
            name
        );
    }

    private void createFinanceSchema(JdbcTemplate jdbc, String schema) {
        jdbc.execute("CREATE SCHEMA " + quote(schema));
        jdbc.execute("""
            CREATE TABLE %1$s.md_customer (id UUID PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL);
            CREATE TABLE %1$s.md_supplier (id UUID PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL);
            CREATE TABLE %1$s.ar_receivable (
                id UUID PRIMARY KEY, bill_no TEXT NOT NULL, source_bill_no TEXT, customer_id UUID NOT NULL,
                bill_date DATE NOT NULL, amount NUMERIC(18, 2) NOT NULL,
                received_amount NUMERIC(18, 2) NOT NULL, return_offset_amount NUMERIC(18, 2) NOT NULL,
                currency TEXT NOT NULL, status TEXT NOT NULL
            );
            CREATE TABLE %1$s.ar_receipt (
                id UUID PRIMARY KEY, bill_no TEXT NOT NULL, party_id UUID NOT NULL, bill_date DATE NOT NULL,
                amount NUMERIC(18, 2) NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL
            );
            CREATE TABLE %1$s.ar_receipt_allocation (
                id UUID PRIMARY KEY, receipt_id UUID NOT NULL, receivable_id UUID NOT NULL,
                settlement_amount NUMERIC(18, 2) NOT NULL
            );
            CREATE TABLE %1$s.ap_payable (
                id UUID PRIMARY KEY, bill_no TEXT NOT NULL, source_bill_no TEXT, supplier_id UUID NOT NULL,
                bill_date DATE NOT NULL, amount NUMERIC(18, 2) NOT NULL,
                paid_amount NUMERIC(18, 2) NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL
            );
            CREATE TABLE %1$s.ap_payment (
                id UUID PRIMARY KEY, bill_no TEXT NOT NULL, party_id UUID NOT NULL, bill_date DATE NOT NULL,
                amount NUMERIC(18, 2) NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL
            );
            CREATE TABLE %1$s.ap_payment_allocation (
                id UUID PRIMARY KEY, payment_id UUID NOT NULL, payable_id UUID NOT NULL,
                settlement_amount NUMERIC(18, 2) NOT NULL
            );
            CREATE TABLE %1$s.sales_return (
                id UUID PRIMARY KEY, bill_no TEXT NOT NULL, customer_id UUID NOT NULL,
                bill_date DATE NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL
            );
            CREATE TABLE %1$s.sales_return_finance_allocation (
                id UUID PRIMARY KEY, sales_return_id UUID NOT NULL, receivable_id UUID NOT NULL,
                currency TEXT NOT NULL, offset_amount NUMERIC(18, 2) NOT NULL,
                pending_refund_amount NUMERIC(18, 2) NOT NULL
            )
            """.formatted(quote(schema)));
    }

    private void createAccountSetRegistry(
        JdbcTemplate jdbc,
        String databaseName,
        String tenantASchema,
        String tenantBSchema
    ) {
        jdbc.execute("""
            CREATE TABLE sys_account_set (
                id UUID PRIMARY KEY,
                database_name TEXT NOT NULL,
                schema_name TEXT NOT NULL,
                enabled BOOLEAN NOT NULL,
                initialized BOOLEAN NOT NULL
            )
            """);
        for (var route : List.of(
            List.of(TENANT_A_ID, tenantASchema),
            List.of(TENANT_B_ID, tenantBSchema)
        )) {
            jdbc.update("""
                INSERT INTO sys_account_set (id, database_name, schema_name, enabled, initialized)
                VALUES (?::uuid, ?, ?, TRUE, TRUE)
                """, route.get(0), databaseName, route.get(1));
        }
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
            throw new IllegalStateException("A150 routed PostgreSQL test refuses shared jdy_erp");
        }
        if (databaseName == null || !databaseName.matches("a150_finance_[a-z0-9]{12}")) {
            throw new IllegalArgumentException("A150 test database name is not isolated");
        }
        return databaseName;
    }

    private String databaseUrl(String baseUrl, String databaseName) {
        if (baseUrl == null || !baseUrl.startsWith("jdbc:postgresql://")) {
            throw new IllegalStateException("A150 routed PostgreSQL test requires a PostgreSQL JDBC URL");
        }
        var queryStart = baseUrl.indexOf('?');
        var main = queryStart < 0 ? baseUrl : baseUrl.substring(0, queryStart);
        var query = queryStart < 0 ? "" : baseUrl.substring(queryStart);
        var slash = main.lastIndexOf('/');
        if (slash < "jdbc:postgresql://".length()) {
            throw new IllegalStateException("A150 routed PostgreSQL JDBC URL has no database segment");
        }
        return main.substring(0, slash + 1) + databaseName + query;
    }

    private String quote(String identifier) {
        if (!identifier.matches("[a-z][a-z0-9_]{1,62}")) {
            throw new IllegalArgumentException("unsafe test identifier");
        }
        return '"' + identifier + '"';
    }

    private record TenantAFixtures(
        UUID cnyCustomerId,
        UUID usdCustomerId,
        UUID cnySupplierId,
        UUID usdSupplierId,
        UUID draftReceiptId,
        UUID auditedReturnId
    ) {
    }

    private static final class FixtureIds {
        private static final UUID TENANT_B_CUSTOMER =
            UUID.fromString("00000000-0000-0000-0000-000000025001");

        private FixtureIds() {
        }
    }

    private record DatabaseSettings(String baseUrl, String username, String password) {
    }
}
