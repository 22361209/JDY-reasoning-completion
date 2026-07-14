package com.jdy.erp.reports.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.jdy.erp.shared.application.OperationLogCommand;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.system.security.CurrentPermissionService;
import com.jdy.erp.system.tenant.TenantContext;
import com.jdy.erp.system.tenant.TenantDataScopeService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.ArgumentCaptor;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.TransactionSystemException;
import org.springframework.transaction.support.SimpleTransactionStatus;
import org.springframework.web.server.ResponseStatusException;

class ReportQueryServiceTest {
    private static final Instant GENERATED_AT = Instant.parse("2026-07-14T02:00:00Z");

    @TempDir
    Path testRoot;

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    @Test
    void unknownKeyReturns404BeforeParserPermissionTransactionOrBusinessJdbc() {
        var harness = new Harness();

        assertStatus(HttpStatus.NOT_FOUND, () -> harness.service.query("unknown-report", Map.of()));

        verifyNoInteractions(
            harness.permissionService,
            harness.executor,
            harness.transactionManager,
            harness.operationLogService,
            harness.platformJdbcTemplate
        );
    }

    @Test
    void illegalQueryReturns400BeforePermissionTransactionOrBusinessJdbc() {
        var harness = new Harness();

        assertStatus(HttpStatus.BAD_REQUEST, () -> harness.service.query(
            "fixture-report",
            Map.of("scope", List.of("all"))
        ));

        verifyNoInteractions(
            harness.permissionService,
            harness.executor,
            harness.transactionManager,
            harness.operationLogService,
            harness.platformJdbcTemplate
        );
    }

    @Test
    void permissionDenialHappensBeforeTenantTransactionAndBusinessJdbc() {
        var harness = new Harness();
        doThrow(new ResponseStatusException(HttpStatus.FORBIDDEN, "denied"))
            .when(harness.permissionService).requirePermission("report.fixture.view");

        assertStatus(HttpStatus.FORBIDDEN, () -> harness.service.query("fixture-report", validQuery()));

        verify(harness.permissionService).requirePermission("report.fixture.view");
        verifyNoInteractions(
            harness.executor,
            harness.transactionManager,
            harness.operationLogService,
            harness.platformJdbcTemplate
        );
    }

    @Test
    void missingTenantCannotFallBackToPlatformJdbc() {
        var harness = new Harness();

        assertStatus(HttpStatus.INTERNAL_SERVER_ERROR, () -> harness.service.query("fixture-report", validQuery()));

        verify(harness.permissionService).requirePermission("report.fixture.view");
        verifyNoInteractions(
            harness.executor,
            harness.transactionManager,
            harness.operationLogService,
            harness.platformJdbcTemplate
        );
    }

    @Test
    void incompleteOrReservedTenantRouteCannotAcquirePlatformOrBusinessJdbc() {
        for (var tenant : List.of(
            Map.<String, Object>of(
                "id", "not-a-uuid", "code", "BAD-ID", "name", "BAD-ID",
                "databaseName", "jdy_erp", "schemaName", "tenant_a"
            ),
            Map.<String, Object>of(
                "id", "00000000-0000-0000-0000-000000000145", "code", "NO-DB", "name", "NO-DB",
                "databaseName", "", "schemaName", "tenant_a"
            ),
            Map.<String, Object>of(
                "id", "00000000-0000-0000-0000-000000000145", "code", "PG", "name", "PG",
                "databaseName", "jdy_erp", "schemaName", "pg_catalog"
            ),
            Map.<String, Object>of(
                "id", "00000000-0000-0000-0000-000000000145", "code", "INFO", "name", "INFO",
                "databaseName", "jdy_erp", "schemaName", "information_schema"
            )
        )) {
            var harness = new Harness();
            TenantContext.setTenant(tenant);

            assertStatus(
                HttpStatus.INTERNAL_SERVER_ERROR,
                () -> harness.service.query("fixture-report", validQuery())
            );

            verify(harness.permissionService).requirePermission("report.fixture.view");
            verifyNoInteractions(
                harness.executor,
                harness.transactionManager,
                harness.operationLogService,
                harness.platformJdbcTemplate
            );
            TenantContext.clear();
        }
    }

    @Test
    void registeredEnabledInitializedPublicRouteIsAllowedBeforeRoutedBusinessTransaction() {
        var harness = new Harness();
        setTenant("00000000-0000-0000-0000-000000000001", "BLD-TEST", "public");
        when(harness.executor.query(any(), any())).thenReturn(new SqlReportQueryExecutor.QueryData(
            0L,
            List.of(),
            List.of()
        ));

        var response = harness.service.query("fixture-report", validQuery());

        assertThat(response.total()).isZero();
        var registrySql = ArgumentCaptor.forClass(String.class);
        var registryArguments = ArgumentCaptor.forClass(Object[].class);
        verify(harness.platformJdbcTemplate).queryForObject(
            registrySql.capture(),
            eq(Boolean.class),
            registryArguments.capture()
        );
        assertThat(registrySql.getValue())
            .contains("FROM sys_account_set", "enabled = TRUE", "initialized = TRUE")
            .doesNotContain("report_fixture");
        assertThat(registryArguments.getValue()).containsExactly(
            "00000000-0000-0000-0000-000000000001",
            "jdy_erp",
            "public"
        );
        verify(harness.executor).query(any(), any());
        verify(harness.transactionManager).getTransaction(any());
    }

    @Test
    void forgedOrStalePublicBindingFailsClosedBeforeRoutedBusinessTransaction() {
        var harness = new Harness(false);
        setTenant("00000000-0000-0000-0000-000000000145", "FORGED", "public");

        assertStatus(
            HttpStatus.INTERNAL_SERVER_ERROR,
            () -> harness.service.query("fixture-report", validQuery())
        );

        verify(harness.platformJdbcTemplate).queryForObject(anyString(), eq(Boolean.class), any(Object[].class));
        verifyNoInteractions(harness.executor, harness.transactionManager, harness.operationLogService);
    }

    @Test
    void queryUsesRepeatableReadReadOnlyTransactionAndReturnsFixedEnvelopeWithoutLogging() {
        var harness = new Harness();
        setTenant("00000000-0000-0000-0000-000000000145", "TENANT-A");
        when(harness.executor.query(any(), any())).thenReturn(new SqlReportQueryExecutor.QueryData(
            1L,
            List.of(Map.of("billNo", "SO-A")),
            List.of(Map.of("currency", "USD", "amount", 10))
        ));

        var response = harness.service.query("fixture-report", validQuery());

        assertThat(response.reportKey()).isEqualTo("fixture-report");
        assertThat(response.page()).isEqualTo(1);
        assertThat(response.pageSize()).isEqualTo(100);
        assertThat(response.total()).isEqualTo(1L);
        assertThat(response.generatedAt()).isEqualTo(GENERATED_AT);
        assertThat(response.query())
            .containsEntry("dateFrom", "2026-07-01")
            .containsEntry("dateTo", "2026-07-14")
            .containsEntry("sortField", "businessDate")
            .containsEntry("sortOrder", "desc");
        verify(harness.permissionService).requirePermission("report.fixture.view");
        verify(harness.executor).query(any(), any());
        verifyNoInteractions(harness.operationLogService);

        var transaction = ArgumentCaptor.forClass(TransactionDefinition.class);
        verify(harness.transactionManager).getTransaction(transaction.capture());
        assertThat(transaction.getValue().isReadOnly()).isTrue();
        assertThat(transaction.getValue().getIsolationLevel())
            .isEqualTo(TransactionDefinition.ISOLATION_REPEATABLE_READ);
        assertThat(transaction.getValue().getPropagationBehavior())
            .isEqualTo(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
    }

    @Test
    void serverOwnedDataScopeResolvesOnceAfterRouteRegistryAndBeforeTenantJdbcForTheWholePlan() {
        var scoped = ReportQueryParserPlannerTest.dataScopeSpec();
        var harness = new Harness(scoped);
        var scopeId = "00000000-0000-0000-0000-000000000245";
        when(harness.tenantDataScopeService.currentScopeId("reporting")).thenReturn(scopeId);
        setTenant("00000000-0000-0000-0000-000000000145", "TENANT-A");
        when(harness.executor.query(eq(scoped), any())).thenReturn(new SqlReportQueryExecutor.QueryData(
            0L,
            List.of(),
            List.of()
        ));

        var response = harness.service.query(scoped.reportKey(), Map.of());

        var plan = ArgumentCaptor.forClass(ReportQueryPlan.class);
        var order = inOrder(
            harness.permissionService,
            harness.platformJdbcTemplate,
            harness.tenantDataScopeService,
            harness.transactionManager,
            harness.executor
        );
        order.verify(harness.permissionService).requirePermission("report.fixture.view");
        order.verify(harness.platformJdbcTemplate)
            .queryForObject(anyString(), eq(Boolean.class), any(Object[].class));
        order.verify(harness.tenantDataScopeService).currentScopeId("reporting");
        order.verify(harness.transactionManager).getTransaction(any());
        order.verify(harness.executor).query(eq(scoped), plan.capture());

        assertThat(plan.getValue().dataScopeIds()).containsOnlyKeys("reporting").containsValue(scopeId);
        assertThat(plan.getValue().parametersWithSource(scoped)).containsExactly(scopeId, scopeId, scopeId);
        assertThat(response.query())
            .doesNotContainKeys("scope", "scopeId", "dataScope", "dataScopeId", "reporting");
        assertThat(response.query().values()).doesNotContain(scopeId);
    }

    @Test
    void clientCannotForgeServerOwnedDataScopeBeforePermissionRegistryResolutionOrTenantJdbc() {
        var scoped = ReportQueryParserPlannerTest.dataScopeSpec();
        var harness = new Harness(scoped);

        assertStatus(HttpStatus.BAD_REQUEST, () -> harness.service.query(
            scoped.reportKey(),
            Map.of("dataScopeId", List.of("00000000-0000-0000-0000-000000000999"))
        ));

        verifyNoInteractions(
            harness.permissionService,
            harness.platformJdbcTemplate,
            harness.tenantDataScopeService,
            harness.transactionManager,
            harness.executor,
            harness.operationLogService
        );
    }

    @Test
    void exportPreparationRunsInTransactionAndSuccessAuditIsAnExplicitPostTransferStep() throws Exception {
        var harness = new Harness();
        setTenant("00000000-0000-0000-0000-000000000145", "TENANT-A");
        var artifact = managedArtifact(
            harness,
            "fixture-report",
            2L,
            "\ufeff单号\r\n",
            "dateFrom=2026-07-01,dateTo=2026-07-14,keyword=false"
        );
        when(harness.executor.export(any(), any())).thenReturn(artifact);

        try {
            var result = harness.service.prepareExport("fixture-report", validQuery());

            assertThat(result).isSameAs(artifact);
            assertThat(result.rowCount()).isEqualTo(2L);
            verifyNoInteractions(harness.operationLogService);

            harness.service.recordSuccessfulExport(result);

            var order = inOrder(harness.permissionService, harness.executor, harness.operationLogService);
            order.verify(harness.permissionService).requirePermission("report.fixture.view");
            order.verify(harness.executor).export(any(), any());
            var log = ArgumentCaptor.forClass(OperationLogCommand.class);
            order.verify(harness.operationLogService).logCurrent(log.capture());
            assertThat(log.getValue().module()).isEqualTo("REPORT");
            assertThat(log.getValue().action()).isEqualTo("EXPORT_REPORT");
            assertThat(log.getValue().targetNo()).isEqualTo("fixture-report");
            assertThat(log.getValue().afterState())
                .containsEntry(OperationLogCommand.StateField.SOURCE_COUNT, 2L);
            assertThat(log.getValue().reason())
                .contains("dateFrom=2026-07-01,dateTo=2026-07-14")
                .contains("keyword=false")
                .doesNotContain("SO-A", "单号");
        } finally {
            artifact.release("service-test");
        }
    }

    @Test
    void failedOrOversizedExportWritesNoSuccessLog() {
        var harness = new Harness();
        setTenant("00000000-0000-0000-0000-000000000145", "TENANT-A");
        doThrow(new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE, "too many"))
            .when(harness.executor).export(any(), any());

        assertStatus(HttpStatus.PAYLOAD_TOO_LARGE, () -> harness.service.prepareExport("fixture-report", validQuery()));

        verifyNoInteractions(harness.operationLogService);
    }

    @Test
    void successfulExportCallbackFollowedByCommitFailureDeletesGeneratedArtifact() throws Exception {
        var harness = new Harness();
        setTenant("00000000-0000-0000-0000-000000000145", "TENANT-A");
        var artifact = managedArtifact(harness, "fixture-report", 0L, "\ufeff单号\r\n", "keyword=false");
        var path = artifact.path();
        when(harness.executor.export(any(), any())).thenReturn(artifact);
        doThrow(new TransactionSystemException("simulated commit failure"))
            .when(harness.transactionManager).commit(any());

        assertStatus(
            HttpStatus.INTERNAL_SERVER_ERROR,
            () -> harness.service.prepareExport("fixture-report", validQuery())
        );

        assertThat(path).doesNotExist();
        assertThat(artifact.isDeleted()).isTrue();
        verifyNoInteractions(harness.operationLogService);
    }

    @Test
    void transactionCleanupFailureIsSuppressedOnCommitFailureAndArtifactRemainsRetryable() throws Exception {
        var deleteAttempts = new AtomicInteger();
        var harness = new Harness(
            true,
            () -> "operator",
            candidate -> {
                if (deleteAttempts.getAndIncrement() == 0) {
                    throw new java.io.IOException("simulated cleanup failure with /secret/path tenant_a145 SELECT");
                }
                return Files.deleteIfExists(candidate);
            }
        );
        setTenant("00000000-0000-0000-0000-000000000145", "TENANT-A");
        var artifact = managedArtifact(harness, "fixture-report", 0L, "", "keyword=false");
        var path = artifact.path();
        when(harness.executor.export(any(), any())).thenReturn(artifact);
        doThrow(new TransactionSystemException("simulated commit failure"))
            .when(harness.transactionManager).commit(any());

        assertThatThrownBy(() -> harness.service.prepareExport("fixture-report", validQuery()))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> {
                var cause = ((ResponseStatusException) error).getCause();
                assertThat(cause).isInstanceOf(TransactionSystemException.class);
                assertThat(cause.getSuppressed()).singleElement()
                    .isInstanceOf(java.io.IOException.class)
                    .satisfies(cleanup -> assertThat(cleanup.getMessage())
                        .isEqualTo("report export artifact cleanup failed")
                        .doesNotContain("/secret/path", "tenant_a145", "SELECT"));
            });

        assertThat(artifact.isDeleted()).isFalse();
        assertThat(harness.cleanupManager.pendingCount()).isEqualTo(1);
        harness.cleanupManager.periodicSweep();
        assertThat(artifact.isDeleted()).isTrue();
        assertThat(path).doesNotExist();
    }

    @Test
    void postFlushAuditLogContainsOnlyBoundedIdentityAndSafeCategory() throws Exception {
        var harness = new Harness(true, () -> "actor\nDROP SCHEMA secret;" + "x".repeat(120), Files::deleteIfExists);
        setTenant("00000000-0000-0000-0000-000000000145", "TENANT-A");
        var artifact = managedArtifact(harness, "fixture-report", 0L, "", "keyword=false");
        var path = artifact.path();
        var logger = (ch.qos.logback.classic.Logger) LoggerFactory.getLogger(ReportQueryService.class);
        var appender = new ListAppender<ILoggingEvent>();
        appender.start();
        logger.addAppender(appender);

        try {
            harness.service.recordPostFlushAuditFailure(artifact, "request\n145", true);
        } finally {
            logger.detachAppender(appender);
            appender.stop();
            artifact.release("service-test");
        }

        assertThat(appender.list).singleElement().satisfies(event -> {
            assertThat(event.getLevel()).isEqualTo(Level.ERROR);
            assertThat(event.getFormattedMessage())
                .contains(
                    "report_export_success_audit_failed",
                    "errorCategory=AUDIT_PERSISTENCE_FAILURE",
                    "tenantId=00000000-0000-0000-0000-000000000145",
                    "actor=actorDROPSCHEMAsecret",
                    "requestId=request145"
                );
        });
        assertThat(appender.list).allSatisfy(event -> assertThat(event.getFormattedMessage())
            .doesNotContain(
                path.toString(),
                "/absolute/secret",
                "tenant_a145",
                "SELECT * FROM payroll",
                "keyword=false",
                "DROP SCHEMA secret;"
            ));
    }

    @Test
    void deletedArtifactCannotBeRecordedAsSuccessful() throws Exception {
        var harness = new Harness();
        var artifact = managedArtifact(harness, "fixture-report", 0L, "", "keyword=false");
        var path = artifact.path();
        artifact.release("service-test");

        assertThatThrownBy(() -> harness.service.recordSuccessfulExport(artifact))
            .isInstanceOf(IllegalStateException.class);

        verifyNoInteractions(harness.operationLogService);
        assertThat(path).doesNotExist();
    }

    private Map<String, List<String>> validQuery() {
        return Map.of(
            "dateFrom", List.of("2026-07-01"),
            "dateTo", List.of("2026-07-14")
        );
    }

    private void setTenant(String id, String code) {
        setTenant(id, code, "tenant_a145");
    }

    private void setTenant(String id, String code, String schemaName) {
        TenantContext.setTenant(Map.of(
            "id", id,
            "code", code,
            "name", code,
            "databaseName", "jdy_erp",
            "schemaName", schemaName
        ));
    }

    private ReportExportArtifact managedArtifact(
        Harness harness,
        String reportKey,
        long rowCount,
        String content,
        String auditSummary
    ) throws Exception {
        var path = harness.cleanupManager.createOwnedFile(reportKey);
        Files.writeString(path, content);
        return harness.cleanupManager.completeArtifact(
            reportKey,
            path,
            rowCount,
            Files.size(path),
            auditSummary
        );
    }

    private void assertStatus(HttpStatus status, Runnable action) {
        assertThatThrownBy(action::run)
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode()).isEqualTo(status));
    }

    private final class Harness {
        private final CurrentPermissionService permissionService = mock(CurrentPermissionService.class);
        private final OperationLogService operationLogService = mock(OperationLogService.class);
        private final SqlReportQueryExecutor executor = mock(SqlReportQueryExecutor.class);
        private final PlatformTransactionManager transactionManager = mock(PlatformTransactionManager.class);
        private final JdbcTemplate platformJdbcTemplate = mock(JdbcTemplate.class);
        private final TenantDataScopeService tenantDataScopeService = mock(TenantDataScopeService.class);
        private final ReportExportCleanupManager cleanupManager;
        private final ReportQueryService service;

        private Harness() {
            this(true);
        }

        private Harness(boolean registeredRoute) {
            this(registeredRoute, () -> null, Files::deleteIfExists);
        }

        private Harness(ReportQuerySpec definition) {
            this(true, () -> null, Files::deleteIfExists, List.of(definition));
        }

        private Harness(
            boolean registeredRoute,
            Supplier<String> actorSupplier,
            ReportExportCleanupManager.FileDeleter fileDeleter
        ) {
            this(
                registeredRoute,
                actorSupplier,
                fileDeleter,
                List.of(ReportQuerySpecRegistryTest.fixtureSpec())
            );
        }

        private Harness(
            boolean registeredRoute,
            Supplier<String> actorSupplier,
            ReportExportCleanupManager.FileDeleter fileDeleter,
            List<ReportQuerySpec> definitions
        ) {
            when(transactionManager.getTransaction(any())).thenReturn(new SimpleTransactionStatus());
            when(platformJdbcTemplate.queryForObject(anyString(), eq(Boolean.class), any(Object[].class)))
                .thenReturn(registeredRoute);
            when(tenantDataScopeService.currentScopeId(anyString()))
                .thenReturn("00000000-0000-0000-0000-000000000145");
            cleanupManager = new ReportExportCleanupManager(
                testRoot.resolve(UUID.randomUUID().toString()),
                Clock.fixed(GENERATED_AT, ZoneOffset.UTC),
                Duration.ofHours(1),
                actorSupplier,
                fileDeleter
            );
            cleanupManager.afterPropertiesSet();
            service = new ReportQueryService(
                new ReportQuerySpecRegistry(definitions),
                new ReportQueryParser(),
                new ReportQueryPlanner(),
                executor,
                permissionService,
                operationLogService,
                transactionManager,
                Clock.fixed(GENERATED_AT, ZoneOffset.UTC),
                actorSupplier,
                tenantDataScopeService,
                platformJdbcTemplate
            );
        }
    }
}
