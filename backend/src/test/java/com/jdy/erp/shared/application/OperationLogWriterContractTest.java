package com.jdy.erp.shared.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;

import com.jdy.erp.production.application.ProductionTaskAppService;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantDataScopeService;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.jdbc.core.JdbcTemplate;

class OperationLogWriterContractTest {
    private static final Path MAIN_SOURCE = Path.of("src/main/java");
    private static final Path MIGRATION_SOURCE = Path.of("src/main/resources/db/migration");
    private static final Pattern RAW_OPERATION_LOG_INSERT = Pattern.compile(
        "(?is)INSERT\\s+INTO\\s+(?:(?:%s|[a-zA-Z0-9_\\\".]+)\\.)?sys_operation_log\\b"
    );
    private static final Pattern LEGACY_PRIMITIVE_WRITER = Pattern.compile(
        "\\boperationLogService\\s*\\.\\s*log\\s*\\("
    );

    @Test
    void operationLogWritesAreCentralizedAndTyped() throws IOException {
        var rawInsertViolations = new ArrayList<String>();
        var legacyWriterViolations = new ArrayList<String>();

        try (var paths = Files.walk(MAIN_SOURCE)) {
            for (var path : paths.filter(candidate -> candidate.toString().endsWith(".java")).toList()) {
                var source = Files.readString(path);
                if (RAW_OPERATION_LOG_INSERT.matcher(source).find()
                    && !path.endsWith("OperationLogService.java")) {
                    rawInsertViolations.add(path.toString());
                }
                if (LEGACY_PRIMITIVE_WRITER.matcher(source).find()) {
                    legacyWriterViolations.add(path.toString());
                }
            }
        }

        assertThat(rawInsertViolations)
            .as("sys_operation_log 只能由 OperationLogService 写入")
            .isEmpty();
        assertThat(legacyWriterViolations)
            .as("业务调用必须使用 OperationLogCommand，不得保留 primitive log overload")
            .isEmpty();

        var writerSource = Files.readString(
            MAIN_SOURCE.resolve("com/jdy/erp/shared/application/OperationLogService.java")
        );
        assertThat(writerSource).contains("INSERT INTO %s (");
        assertThat(writerSource).contains("actor_type", "actor_username", "actor_display_name", "target_no");

        var failureWriterSource = Files.readString(
            MAIN_SOURCE.resolve("com/jdy/erp/shared/application/OperationLogFailureService.java")
        );
        assertThat(failureWriterSource)
            .as("失败审计不得从真实 URI 或 path variable 猜业务身份")
            .doesNotContain("getRequestURI()", "URI_TEMPLATE_VARIABLES_ATTRIBUTE", "RequestTarget");
    }

    @Test
    void commandRejectsHistoricalActorUntypedStateAndMissingFailureReason() {
        var historicalActor = new OperationActor(
            OperationActor.Type.HISTORICAL_UNKNOWN,
            null,
            null,
            null
        );
        assertThatThrownBy(historicalActor::validateForNewWrite)
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("HISTORICAL_UNKNOWN");

        assertThatThrownBy(() -> OperationLogCommand.success(
            "SYSTEM",
            "FORGED_HISTORICAL",
            "sys_user",
            UUID.randomUUID(),
            null,
            OperationLogCommand.ActorMode.EXPLICIT_USER,
            historicalActor,
            Map.of(),
            Map.of(),
            null
        )).isInstanceOf(IllegalArgumentException.class);

        assertThatThrownBy(() -> OperationLogCommand.state("status", "DRAFT"))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("StateField");
        assertThatThrownBy(() -> OperationLogCommand.state(
            OperationLogCommand.StateField.STATUS,
            Map.of("unbounded", "request")
        )).isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("标量");

        assertThatThrownBy(() -> OperationLogCommand.failure(
            "SYSTEM",
            "FAILED_ACTION",
            "sys_user",
            UUID.randomUUID(),
            null,
            OperationLogCommand.ActorMode.SYSTEM,
            null,
            Map.of(),
            Map.of(),
            null
        )).isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("失败原因");
    }

    @Test
    void idempotentBomEnableLogsTheQueriedStateInsteadOfAnInferredInverse() {
        var jdbcTemplate = mock(JdbcTemplate.class);
        var validationService = mock(ValidationService.class);
        var operationLogService = mock(OperationLogService.class);
        var currentSessionService = mock(CurrentSessionService.class);
        var bomId = UUID.randomUUID();
        var userId = UUID.randomUUID();

        when(validationService.required("BOM-001", "BOM 编码")).thenReturn("BOM-001");
        when(currentSessionService.currentUserId()).thenReturn(userId.toString());
        when(jdbcTemplate.queryForList(anyString(), any(Object[].class))).thenAnswer(invocation -> {
            String sql = invocation.getArgument(0);
            if (sql.contains("FROM prod_bom\n") && sql.contains("LIMIT 1")) {
                return List.of(Map.of(
                    "id", bomId.toString(),
                    "productId", UUID.randomUUID().toString(),
                    "code", "BOM-001",
                    "auditStatus", "AUDITED",
                    "enabled", true,
                    "isCurrent", true
                ));
            }
            return List.of();
        });
        when(jdbcTemplate.queryForMap(anyString(), any(Object[].class))).thenReturn(Map.of(
            "id", bomId.toString(),
            "code", "BOM-001",
            "enabled", true
        ));

        var service = new ProductionTaskAppService(
            jdbcTemplate,
            mock(LookupService.class),
            validationService,
            operationLogService,
            mock(NumberingService.class),
            mock(TenantDataScopeService.class),
            currentSessionService
        );

        service.setBomEnabled("BOM-001", true);

        var command = ArgumentCaptor.forClass(OperationLogCommand.class);
        verify(operationLogService).logCurrent(command.capture());
        assertThat(command.getValue().beforeState())
            .containsEntry(OperationLogCommand.StateField.ENABLED, true);
        assertThat(command.getValue().afterState())
            .containsEntry(OperationLogCommand.StateField.ENABLED, true);
    }

    @Test
    void migrationDiscoversOnlyRegisteredSafeAndExistingTenantSchemas() throws IOException {
        var migration = Files.readString(
            MIGRATION_SOURCE.resolve("V97__operation_log_actor_provenance.sql")
        );

        assertThat(migration)
            .contains("FROM public.sys_account_set account_set")
            .contains("tenant_schema !~ '^[a-z][a-z0-9_]{0,62}$'")
            .contains("WHERE namespace.nspname = tenant_schema")
            .contains("to_regclass(format('%I.sys_operation_log', tenant_schema)) IS NULL")
            .doesNotContain("namespace.nspname LIKE 'tenant\\_%'");
    }
}
