package com.jdy.erp.shared.application;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.jdy.erp.system.tenant.TenantContext;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public final class OperationLogService {
    private static final int MAX_STATE_JSON_LENGTH = 8 * 1024;

    private final JdbcTemplate routedJdbcTemplate;
    private final JdbcTemplate platformJdbcTemplate;
    private final OperationActorProvider actorProvider;
    private final ObjectMapper objectMapper;

    public OperationLogService(
        JdbcTemplate routedJdbcTemplate,
        @Qualifier("platformJdbcTemplate") JdbcTemplate platformJdbcTemplate,
        OperationActorProvider actorProvider,
        ObjectMapper objectMapper
    ) {
        this.routedJdbcTemplate = routedJdbcTemplate;
        this.platformJdbcTemplate = platformJdbcTemplate;
        this.actorProvider = actorProvider;
        this.objectMapper = objectMapper;
    }

    public UUID logCurrent(OperationLogCommand success) {
        requireSuccess(success);
        return writeCurrent(success);
    }

    public UUID logPlatform(OperationLogCommand success) {
        requireSuccess(success);
        return writePlatform(success);
    }

    public UUID logTenant(TenantTarget target, OperationLogCommand success) {
        requireSuccess(success);
        return writeTenant(target, success);
    }

    UUID writeCurrent(OperationLogCommand command) {
        var context = TenantContext.current().orElseThrow(() -> new IllegalStateException("操作日志缺少请求 scope"));
        if (context.isTenant()) {
            return insert(routedJdbcTemplate, command, actorProvider.resolve(command), new AccountScope(
                uuid(context.accountSetId(), "tenant accountSetId"),
                required(context.accountSetCode(), "tenant accountSetCode"),
                required(context.accountSetName(), "tenant accountSetName")
            ), null);
        }
        return insert(platformJdbcTemplate, command, actorProvider.resolve(command), AccountScope.platform(), null);
    }

    UUID writePlatform(OperationLogCommand command) {
        return insert(platformJdbcTemplate, command, actorProvider.resolve(command), AccountScope.platform(), null);
    }

    UUID writeTenant(TenantTarget target, OperationLogCommand command) {
        var validated = validatedTarget(target);
        return insert(platformJdbcTemplate, command, actorProvider.resolve(command), validated.scope(), validated.schemaName());
    }

    private UUID insert(
        JdbcTemplate jdbcTemplate,
        OperationLogCommand command,
        OperationActor actor,
        AccountScope scope,
        String schemaName
    ) {
        actor.validateForNewWrite();
        var beforeState = json(command.beforeState());
        var afterState = json(command.afterState());
        var table = schemaName == null ? "sys_operation_log" : quoteIdentifier(schemaName) + ".sys_operation_log";
        var rows = jdbcTemplate.queryForList("""
            INSERT INTO %s (
                module_code, action_code, target_type, target_id, target_no,
                before_state, after_state, success, failure_reason,
                operated_by, actor_type, actor_username, actor_display_name,
                account_set_id, account_set_code, account_set_name
            )
            VALUES (?, ?, ?, ?::uuid, ?, ?::jsonb, ?::jsonb, ?, ?, ?::uuid, ?, ?, ?, ?::uuid, ?, ?)
            RETURNING id::text AS id
            """.formatted(table),
            command.module(),
            command.action(),
            command.targetType(),
            command.targetId() == null ? null : command.targetId().toString(),
            command.targetNo() == null ? "" : command.targetNo(),
            beforeState,
            afterState,
            command.outcome() == OperationLogCommand.Outcome.SUCCESS,
            command.reason(),
            actor.operatedBy() == null ? null : actor.operatedBy().toString(),
            actor.type().name(),
            actor.username(),
            actor.displayName(),
            scope.accountSetId() == null ? null : scope.accountSetId().toString(),
            scope.code(),
            scope.name()
        );
        return UUID.fromString(String.valueOf(rows.getFirst().get("id")));
    }

    private TenantTarget validatedTarget(TenantTarget target) {
        if (target == null) {
            throw new IllegalArgumentException("显式 tenant 日志目标不能为空");
        }
        var rows = platformJdbcTemplate.queryForList("""
            SELECT id::text AS id, code, name, schema_name AS "schemaName"
            FROM sys_account_set
            WHERE id = ?::uuid
              AND code = ?
              AND name = ?
              AND schema_name = ?
            """, target.accountSetId(), target.code(), target.name(), target.schemaName());
        if (rows.isEmpty()) {
            throw new IllegalArgumentException("显式 tenant 日志目标与账套注册表不一致");
        }
        return target;
    }

    private String json(Map<OperationLogCommand.StateField, Object> state) {
        if (state == null || state.isEmpty()) {
            return null;
        }
        var jsonState = new LinkedHashMap<String, Object>();
        state.forEach((field, value) -> jsonState.put(field.jsonName(), value));
        try {
            var json = objectMapper.writeValueAsString(jsonState);
            if (json.getBytes(StandardCharsets.UTF_8).length > MAX_STATE_JSON_LENGTH) {
                throw new IllegalArgumentException("操作日志状态快照超过 8KiB");
            }
            return json;
        } catch (JsonProcessingException exception) {
            throw new IllegalArgumentException("操作日志状态快照无法序列化", exception);
        }
    }

    private void requireSuccess(OperationLogCommand command) {
        if (command == null || command.outcome() != OperationLogCommand.Outcome.SUCCESS) {
            throw new IllegalArgumentException("失败日志必须通过 OperationLogFailureService 写入");
        }
    }

    private UUID uuid(String value, String label) {
        try {
            return UUID.fromString(required(value, label));
        } catch (IllegalArgumentException exception) {
            throw new IllegalStateException(label + " 不是有效 UUID", exception);
        }
    }

    private String required(String value, String label) {
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(label + " 不能为空");
        }
        return value.trim();
    }

    private String quoteIdentifier(String identifier) {
        if (identifier == null || !identifier.matches("[a-z][a-z0-9_]{0,62}")) {
            throw new IllegalArgumentException("tenant schema 名称非法");
        }
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }

    private record AccountScope(UUID accountSetId, String code, String name) {
        static AccountScope platform() {
            return new AccountScope(null, "platform", "平台");
        }
    }

    public record TenantTarget(UUID accountSetId, String code, String name, String schemaName) {
        public TenantTarget {
            if (accountSetId == null || code == null || code.isBlank() || name == null || name.isBlank()
                || schemaName == null || schemaName.isBlank()) {
                throw new IllegalArgumentException("显式 tenant 日志目标字段不完整");
            }
            code = code.trim();
            name = name.trim();
            schemaName = schemaName.trim();
        }

        AccountScope scope() {
            return new AccountScope(accountSetId, code, name);
        }
    }
}
