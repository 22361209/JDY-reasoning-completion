package com.jdy.erp.shared.application;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import java.util.UUID;

import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantContext;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

@SpringBootTest
class OperationLogServiceIntegrationTest {
    @Autowired
    private OperationLogService operationLogService;

    @Autowired
    private OperationActorProvider operationActorProvider;

    @Autowired
    private CurrentSessionService currentSessionService;

    @Autowired
    @Qualifier("platformJdbcTemplate")
    private JdbcTemplate platformJdbcTemplate;

    private UUID platformLogId;
    private UUID tenantLogId;
    private UUID tenantAccountSetId;
    private String tenantCode;
    private String tenantSchema;

    @BeforeEach
    void bindAuthenticatedRequest() {
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(new MockHttpServletRequest()));
        currentSessionService.login("admin", "admin123", "BLD-TEST");
    }

    @AfterEach
    void cleanUp() {
        TenantContext.clear();
        if (tenantSchema != null) {
            platformJdbcTemplate.execute("DROP SCHEMA IF EXISTS " + quoteIdentifier(tenantSchema) + " CASCADE");
        }
        if (tenantAccountSetId != null) {
            platformJdbcTemplate.update("DELETE FROM public.sys_account_set WHERE id = ?::uuid", tenantAccountSetId);
        }
        if (platformLogId != null) {
            platformJdbcTemplate.update("DELETE FROM public.sys_operation_log WHERE id = ?::uuid", platformLogId);
        }
        RequestContextHolder.resetRequestAttributes();
    }

    @Test
    void authenticatedActorSnapshotSurvivesOwnDisplayDisableAndSessionGenerationMutation() {
        var original = platformJdbcTemplate.queryForMap("""
            SELECT id::text AS id,
                   display_name AS "displayName",
                   enabled,
                   session_generation AS "sessionGeneration"
            FROM public.sys_user
            WHERE username = 'admin'
            """);
        var actorId = UUID.fromString(String.valueOf(original.get("id")));
        var originalDisplayName = String.valueOf(original.get("displayName"));
        var originalEnabled = Boolean.TRUE.equals(original.get("enabled"));
        var originalGeneration = Number.class.cast(original.get("sessionGeneration")).intValue();

        operationActorProvider.captureCurrentUser();
        try {
            platformJdbcTemplate.update("""
                UPDATE public.sys_user
                SET display_name = 'A136 已修改显示名',
                    enabled = FALSE,
                    session_generation = session_generation + 1
                WHERE id = ?::uuid
                """, actorId);

            platformLogId = operationLogService.logPlatform(OperationLogCommand.success(
                "SYSTEM",
                "A136_ACTOR_SNAPSHOT_RACE",
                "sys_user",
                actorId,
                "admin",
                OperationLogCommand.state(OperationLogCommand.StateField.DISPLAY_NAME, originalDisplayName),
                OperationLogCommand.state(OperationLogCommand.StateField.DISPLAY_NAME, "A136 已修改显示名")
            ));

            var log = platformJdbcTemplate.queryForMap("""
                SELECT operated_by::text AS "operatedBy",
                       actor_type AS "actorType",
                       actor_username AS "actorUsername",
                       actor_display_name AS "actorDisplayName"
                FROM public.sys_operation_log
                WHERE id = ?::uuid
                """, platformLogId);
            assertThat(log).containsEntry("operatedBy", actorId.toString());
            assertThat(log).containsEntry("actorType", "USER");
            assertThat(log).containsEntry("actorUsername", "admin");
            assertThat(log).containsEntry("actorDisplayName", originalDisplayName);
        } finally {
            platformJdbcTemplate.update("""
                UPDATE public.sys_user
                SET display_name = ?, enabled = ?, session_generation = ?
                WHERE id = ?::uuid
                """, originalDisplayName, originalEnabled, originalGeneration, actorId);
        }
    }

    @Test
    void nextAuthenticatedRequestCapturesTheRenamedDisplaySnapshot() {
        var original = platformJdbcTemplate.queryForMap("""
            SELECT id::text AS id, display_name AS "displayName"
            FROM public.sys_user
            WHERE username = 'admin'
            """);
        var actorId = UUID.fromString(String.valueOf(original.get("id")));
        var originalDisplayName = String.valueOf(original.get("displayName"));
        var renamedDisplayName = "A136 新请求显示名";

        try {
            platformJdbcTemplate.update(
                "UPDATE public.sys_user SET display_name = ? WHERE id = ?::uuid",
                renamedDisplayName,
                actorId
            );
            RequestContextHolder.resetRequestAttributes();
            RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(new MockHttpServletRequest()));
            currentSessionService.login("admin", "admin123", "BLD-TEST");

            platformLogId = operationLogService.logPlatform(OperationLogCommand.success(
                "SYSTEM",
                "A136_RENAMED_ACTOR_NEW_REQUEST",
                "sys_user",
                actorId,
                "admin",
                Map.of(),
                OperationLogCommand.state(OperationLogCommand.StateField.DISPLAY_NAME, renamedDisplayName)
            ));

            assertThat(platformJdbcTemplate.queryForObject("""
                SELECT actor_display_name
                FROM public.sys_operation_log
                WHERE id = ?::uuid
                """, String.class, platformLogId)).isEqualTo(renamedDisplayName);
        } finally {
            platformJdbcTemplate.update(
                "UPDATE public.sys_user SET display_name = ? WHERE id = ?::uuid",
                originalDisplayName,
                actorId
            );
        }
    }

    @Test
    void explicitTenantSystemWriteUsesOnlyTheDeclaredTenantDestination() {
        var suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        tenantAccountSetId = UUID.randomUUID();
        tenantCode = "A136" + suffix.toUpperCase();
        tenantSchema = "tenant_a136_" + suffix;
        platformJdbcTemplate.execute("CREATE SCHEMA " + quoteIdentifier(tenantSchema));
        platformJdbcTemplate.execute("""
            CREATE TABLE %s.sys_operation_log
            (LIKE public.sys_operation_log INCLUDING ALL)
            """.formatted(quoteIdentifier(tenantSchema)));
        platformJdbcTemplate.update("""
            INSERT INTO public.sys_account_set (id, code, name, schema_name, initialized)
            VALUES (?::uuid, ?, ?, ?, TRUE)
            """, tenantAccountSetId, tenantCode, "A136 审计目标账套", tenantSchema);
        var target = new OperationLogService.TenantTarget(
            tenantAccountSetId,
            tenantCode,
            "A136 审计目标账套",
            tenantSchema
        );

        tenantLogId = operationLogService.logTenant(target, OperationLogCommand.success(
            "SYSTEM",
            "A136_EXPLICIT_TENANT",
            "sys_account_set",
            target.accountSetId(),
            target.code(),
            OperationLogCommand.ActorMode.SYSTEM,
            null,
            Map.of(),
            Map.of(),
            null
        ));

        var tenantLog = platformJdbcTemplate.queryForMap("""
            SELECT actor_type AS "actorType",
                   operated_by::text AS "operatedBy",
                   account_set_id::text AS "accountSetId",
                   account_set_code AS "accountSetCode",
                   target_no AS "targetNo"
            FROM %s.sys_operation_log
            WHERE id = ?::uuid
            """.formatted(quoteIdentifier(tenantSchema)), tenantLogId);
        assertThat(tenantLog).containsEntry("actorType", "SYSTEM");
        assertThat(tenantLog.get("operatedBy")).isNull();
        assertThat(tenantLog).containsEntry("accountSetId", target.accountSetId().toString());
        assertThat(tenantLog).containsEntry("accountSetCode", target.code());
        assertThat(tenantLog).containsEntry("targetNo", target.code());

        var platformCount = platformJdbcTemplate.queryForObject(
            "SELECT count(*) FROM public.sys_operation_log WHERE id = ?::uuid",
            Integer.class,
            tenantLogId
        );
        assertThat(platformCount).isZero();
    }

    private String quoteIdentifier(String identifier) {
        if (identifier == null || !identifier.matches("[a-z][a-z0-9_]{0,62}")) {
            throw new IllegalArgumentException("非法 schema");
        }
        return '"' + identifier.replace("\"", "\"\"") + '"';
    }
}
