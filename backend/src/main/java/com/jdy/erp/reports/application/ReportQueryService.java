package com.jdy.erp.reports.application;

import java.io.IOException;
import java.time.Clock;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;
import java.util.regex.Pattern;

import com.jdy.erp.shared.application.OperationLogCommand;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.system.security.CurrentPermissionService;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantContext;
import com.jdy.erp.system.tenant.TenantDataScopeService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.TransactionException;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

@Service
public final class ReportQueryService {
    private static final Logger LOGGER = LoggerFactory.getLogger(ReportQueryService.class);
    private static final Pattern ROUTE_NAME = Pattern.compile("[a-z][a-z0-9_]{0,62}");

    private final ReportQuerySpecRegistry registry;
    private final ReportQueryParser parser;
    private final ReportQueryPlanner planner;
    private final SqlReportQueryExecutor executor;
    private final CurrentPermissionService permissionService;
    private final OperationLogService operationLogService;
    private final TransactionTemplate readTransaction;
    private final Clock clock;
    private final Supplier<String> actorSupplier;
    private final JdbcTemplate platformJdbcTemplate;
    private final TenantDataScopeService tenantDataScopeService;

    @Autowired
    public ReportQueryService(
        ReportQuerySpecRegistry registry,
        ReportQueryParser parser,
        ReportQueryPlanner planner,
        SqlReportQueryExecutor executor,
        CurrentPermissionService permissionService,
        OperationLogService operationLogService,
        PlatformTransactionManager transactionManager,
        CurrentSessionService currentSessionService,
        TenantDataScopeService tenantDataScopeService,
        @Qualifier("platformJdbcTemplate") JdbcTemplate platformJdbcTemplate
    ) {
        this(
            registry,
            parser,
            planner,
            executor,
            permissionService,
            operationLogService,
            transactionManager,
            Clock.systemUTC(),
            currentSessionService::optionalCurrentUsername,
            tenantDataScopeService,
            platformJdbcTemplate
        );
    }

    ReportQueryService(
        ReportQuerySpecRegistry registry,
        ReportQueryParser parser,
        ReportQueryPlanner planner,
        SqlReportQueryExecutor executor,
        CurrentPermissionService permissionService,
        OperationLogService operationLogService,
        PlatformTransactionManager transactionManager,
        Clock clock,
        TenantDataScopeService tenantDataScopeService,
        JdbcTemplate platformJdbcTemplate
    ) {
        this(
            registry,
            parser,
            planner,
            executor,
            permissionService,
            operationLogService,
            transactionManager,
            clock,
            () -> null,
            tenantDataScopeService,
            platformJdbcTemplate
        );
    }

    ReportQueryService(
        ReportQuerySpecRegistry registry,
        ReportQueryParser parser,
        ReportQueryPlanner planner,
        SqlReportQueryExecutor executor,
        CurrentPermissionService permissionService,
        OperationLogService operationLogService,
        PlatformTransactionManager transactionManager,
        Clock clock,
        Supplier<String> actorSupplier,
        TenantDataScopeService tenantDataScopeService,
        JdbcTemplate platformJdbcTemplate
    ) {
        this.registry = registry;
        this.parser = parser;
        this.planner = planner;
        this.executor = executor;
        this.permissionService = permissionService;
        this.operationLogService = operationLogService;
        this.clock = clock;
        this.actorSupplier = actorSupplier;
        this.tenantDataScopeService = tenantDataScopeService;
        this.platformJdbcTemplate = platformJdbcTemplate;
        this.readTransaction = new TransactionTemplate(transactionManager);
        this.readTransaction.setReadOnly(true);
        this.readTransaction.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
        this.readTransaction.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
    }

    public ReportQueryResponse query(String reportKey, Map<String, List<String>> rawParameters) {
        try {
            var prepared = prepare(reportKey, rawParameters);
            var data = readTransaction.execute(status -> executor.query(prepared.spec(), prepared.plan()));
            if (data == null) {
                throw new IllegalStateException("report read transaction returned no result");
            }
            var query = prepared.plan().query();
            return new ReportQueryResponse(
                prepared.spec().reportKey(),
                query.page(),
                query.pageSize(),
                data.total(),
                data.rows(),
                data.totals(),
                query.echo(),
                Instant.now(clock)
            );
        } catch (ResponseStatusException exception) {
            throw exception;
        } catch (DataAccessException | TransactionException exception) {
            throw unavailable("报表查询失败，请稍后重试", exception);
        }
    }

    public ReportExportArtifact prepareExport(String reportKey, Map<String, List<String>> rawParameters) {
        var generatedArtifact = new AtomicReference<ReportExportArtifact>();
        try {
            var prepared = prepare(reportKey, rawParameters);
            var artifact = readTransaction.execute(status -> {
                var generated = executor.export(prepared.spec(), prepared.plan());
                generatedArtifact.set(generated);
                return generated;
            });
            if (artifact == null) {
                throw new IllegalStateException("report export transaction returned no result");
            }
            return artifact;
        } catch (ResponseStatusException exception) {
            deleteFailedTransactionArtifact(generatedArtifact.get(), exception);
            throw exception;
        } catch (DataAccessException | TransactionException exception) {
            deleteFailedTransactionArtifact(generatedArtifact.get(), exception);
            throw unavailable("报表引出失败，请稍后重试", exception);
        } catch (RuntimeException | Error exception) {
            deleteFailedTransactionArtifact(generatedArtifact.get(), exception);
            throw exception;
        }
    }

    public void recordSuccessfulExport(ReportExportArtifact artifact) {
        if (artifact == null || artifact.isDeleted()) {
            throw new IllegalStateException("report export artifact is unavailable for success audit");
        }
        operationLogService.logCurrent(OperationLogCommand.success(
            "REPORT",
            "EXPORT_REPORT",
            "REPORT_QUERY",
            null,
            artifact.reportKey(),
            OperationLogCommand.ActorMode.CURRENT_USER,
            null,
            Map.of(),
            OperationLogCommand.state(
                OperationLogCommand.StateField.SOURCE_COUNT, artifact.rowCount()
            ),
            artifact.auditSummary()
        ));
    }

    public void recordPostFlushAuditFailure(
        ReportExportArtifact artifact,
        String requestId,
        boolean responseCommitted
    ) {
        var context = operationalContext(requestId);
        LOGGER.error(
            "report_export_success_audit_failed errorCategory=AUDIT_PERSISTENCE_FAILURE "
                + "tenantId={} actor={} reportKey={} rowCount={} requestId={} responseCommitted={}",
            context.tenantId(),
            context.actor(),
            safeToken(artifact == null ? null : artifact.reportKey(), 64),
            artifact == null ? -1L : artifact.rowCount(),
            context.requestId(),
            responseCommitted
        );
    }

    public void recordTransferFailure(
        ReportExportArtifact artifact,
        String requestId,
        boolean responseCommitted
    ) {
        var context = operationalContext(requestId);
        LOGGER.warn(
            "report_export_transfer_failed errorCategory=RESPONSE_TRANSFER_IO_FAILURE "
                + "tenantId={} actor={} reportKey={} rowCount={} requestId={} responseCommitted={}",
            context.tenantId(),
            context.actor(),
            safeToken(artifact == null ? null : artifact.reportKey(), 64),
            artifact == null ? -1L : artifact.rowCount(),
            context.requestId(),
            responseCommitted
        );
    }

    private PreparedReport prepare(String reportKey, Map<String, List<String>> rawParameters) {
        var spec = registry.require(reportKey);
        var query = parser.parse(spec, rawParameters);
        permissionService.requirePermission(spec.requiredPermission());
        requireRoutableTenant();
        var dataScopes = resolveDataScopes(spec);
        var plan = planner.plan(spec, query).withDataScopes(dataScopes);
        return new PreparedReport(spec, plan);
    }

    private TenantContext.Snapshot requireRoutableTenant() {
        try {
            var tenant = TenantContext.requireTenant();
            var accountSetId = tenant.accountSetId();
            var parsedId = UUID.fromString(accountSetId);
            if (!parsedId.toString().equalsIgnoreCase(accountSetId)) {
                throw new IllegalArgumentException("non-canonical account set id");
            }
            if (!validRouteName(tenant.databaseName()) || !validTenantSchema(tenant.schemaName())) {
                throw new IllegalArgumentException("invalid tenant route");
            }
            var registered = platformJdbcTemplate.queryForObject("""
                SELECT EXISTS (
                    SELECT 1
                    FROM sys_account_set
                    WHERE id = ?::uuid
                      AND database_name = ?
                      AND schema_name = ?
                      AND enabled = TRUE
                      AND initialized = TRUE
                )
                """, Boolean.class, accountSetId, tenant.databaseName(), tenant.schemaName());
            if (!Boolean.TRUE.equals(registered)) {
                throw new IllegalArgumentException("tenant route does not match registry");
            }
            return tenant;
        } catch (IllegalArgumentException | IllegalStateException exception) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "业务请求缺少有效账套路由");
        }
    }

    private boolean validRouteName(String value) {
        return value != null && ROUTE_NAME.matcher(value).matches();
    }

    private boolean validTenantSchema(String value) {
        return validRouteName(value)
            && !"information_schema".equals(value)
            && !value.startsWith("pg_");
    }

    private Map<String, String> resolveDataScopes(ReportQuerySpec spec) {
        var resolved = new LinkedHashMap<String, String>();
        try {
            for (var namespace : spec.dataScopeNamespaces()) {
                var scopeId = tenantDataScopeService.currentScopeId(namespace);
                if (!safeUuid(scopeId)) {
                    throw new IllegalStateException("invalid server-owned report data scope");
                }
                resolved.put(namespace, UUID.fromString(scopeId).toString());
            }
        } catch (IllegalArgumentException | IllegalStateException invalidScope) {
            throw new ResponseStatusException(
                HttpStatus.INTERNAL_SERVER_ERROR,
                "业务请求缺少有效数据范围"
            );
        }
        return java.util.Collections.unmodifiableMap(resolved);
    }

    private ResponseStatusException unavailable(String reason, Exception cause) {
        return new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, reason, cause);
    }

    private void deleteFailedTransactionArtifact(ReportExportArtifact artifact, Throwable original) {
        if (artifact == null) {
            return;
        }
        try {
            artifact.release("transaction");
        } catch (IOException cleanupFailure) {
            original.addSuppressed(new IOException("report export artifact cleanup failed"));
        }
    }

    private OperationalContext operationalContext(String requestId) {
        var tenantId = TenantContext.current()
            .filter(TenantContext.Snapshot::isTenant)
            .map(TenantContext.Snapshot::accountSetId)
            .map(value -> safeUuid(value) ? value : "unavailable")
            .orElse("unavailable");
        String actor;
        try {
            actor = actorSupplier.get();
        } catch (RuntimeException unavailableActor) {
            actor = null;
        }
        return new OperationalContext(
            tenantId,
            safeToken(actor, 80),
            safeToken(requestId, 128)
        );
    }

    private boolean safeUuid(String value) {
        if (value == null) {
            return false;
        }
        try {
            return UUID.fromString(value).toString().equalsIgnoreCase(value);
        } catch (IllegalArgumentException exception) {
            return false;
        }
    }

    private String safeToken(String value, int maximumLength) {
        if (value == null || value.isBlank()) {
            return "unavailable";
        }
        var filtered = value.replaceAll("[^A-Za-z0-9._@:-]", "");
        if (filtered.isEmpty()) {
            return "unavailable";
        }
        return filtered.substring(0, Math.min(maximumLength, filtered.length()));
    }

    private record PreparedReport(ReportQuerySpec spec, ReportQueryPlan plan) {
    }

    private record OperationalContext(String tenantId, String actor, String requestId) {
    }

}
