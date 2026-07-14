package com.jdy.erp.shared.application;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.EnumMap;
import java.util.Map;
import java.util.UUID;

public record OperationLogCommand(
    String module,
    String action,
    String targetType,
    UUID targetId,
    String targetNo,
    Outcome outcome,
    String reason,
    Map<StateField, Object> beforeState,
    Map<StateField, Object> afterState,
    ActorMode actorMode,
    OperationActor explicitActor
) {
    private static final int MAX_REASON_LENGTH = 1_000;

    public enum Outcome {
        SUCCESS,
        FAILURE
    }

    public enum ActorMode {
        CURRENT_USER,
        EXPLICIT_USER,
        SYSTEM,
        ANONYMOUS
    }

    public enum StateField {
        STATUS("status"),
        AUDIT_STATUS("auditStatus"),
        CLOSE_STATUS("closeStatus"),
        CLOSE_MODE("closeMode"),
        FROZEN_STATUS("frozenStatus"),
        STOCK_IN_STATUS("stockInStatus"),
        LINE_NO("lineNo"),
        LINE_CLOSE_STATUS("lineCloseStatus"),
        LINE_FROZEN_STATUS("lineFrozenStatus"),
        ENABLED("enabled"),
        INITIALIZED("initialized"),
        ROLE_CODE("roleCode"),
        PERMISSION_CODES("permissionCodes"),
        ACCOUNT_SET_CODES("accountSetCodes"),
        DEFAULT_ACCOUNT_SET_CODE("defaultAccountSetCode"),
        DISPLAY_NAME("displayName"),
        LOCKED("locked"),
        SESSION_GENERATION("sessionGeneration"),
        PASSWORD_MIN_LENGTH("passwordMinLength"),
        REQUIRE_UPPERCASE("requireUppercase"),
        REQUIRE_LOWERCASE("requireLowercase"),
        REQUIRE_DIGIT("requireDigit"),
        REQUIRE_SYMBOL("requireSymbol"),
        REQUEST_STATUS("requestStatus"),
        PROVIDER("provider"),
        DRY_RUN("dryRun"),
        RETRY_COUNT("retryCount"),
        RECEIPT_STATUS("receiptStatus"),
        AMOUNT("amount"),
        CURRENCY("currency"),
        VERSION("version"),
        SOURCE_COUNT("sourceCount"),
        QUANTITY("quantity"),
        ACCOUNT_COUNT("accountCount"),
        SETTLED_AMOUNT("settledAmount"),
        OUTSTANDING_AMOUNT("outstandingAmount"),
        PREFIX("prefix"),
        WIDTH("width"),
        LAST_NUMBER("lastNumber"),
        BACKUP_NAME("backupName"),
        CLEARED_BUSINESS_DATA("clearedBusinessData");

        private final String jsonName;

        StateField(String jsonName) {
            this.jsonName = jsonName;
        }

        public String jsonName() {
            return jsonName;
        }
    }

    public OperationLogCommand {
        module = required(module, "module", 80);
        action = required(action, "action", 80);
        targetType = required(targetType, "targetType", 120);
        targetNo = optional(targetNo, 200);
        if (outcome == null) {
            throw new IllegalArgumentException("操作日志 outcome 不能为空");
        }
        reason = optional(reason, MAX_REASON_LENGTH);
        if (outcome == Outcome.FAILURE && reason == null) {
            throw new IllegalArgumentException("失败操作日志必须包含失败原因");
        }
        if (actorMode == null) {
            throw new IllegalArgumentException("操作日志 actor mode 不能为空");
        }
        if (actorMode == ActorMode.EXPLICIT_USER) {
            if (explicitActor == null || explicitActor.type() != OperationActor.Type.USER) {
                throw new IllegalArgumentException("EXPLICIT_USER 必须提供 USER actor");
            }
            explicitActor.validateForNewWrite();
        } else if (explicitActor != null) {
            throw new IllegalArgumentException(actorMode + " 不得携带 explicit actor");
        }
        beforeState = immutableState(beforeState);
        afterState = immutableState(afterState);
    }

    public static OperationLogCommand success(
        String module,
        String action,
        String targetType,
        UUID targetId,
        String targetNo,
        ActorMode actorMode,
        OperationActor explicitActor,
        Map<StateField, Object> beforeState,
        Map<StateField, Object> afterState,
        String reason
    ) {
        return new OperationLogCommand(
            module, action, targetType, targetId, targetNo, Outcome.SUCCESS, reason,
            beforeState, afterState, actorMode, explicitActor
        );
    }

    public static OperationLogCommand success(
        String module,
        String action,
        String targetType,
        UUID targetId,
        String targetNo,
        Map<StateField, Object> beforeState,
        Map<StateField, Object> afterState
    ) {
        return success(module, action, targetType, targetId, targetNo, ActorMode.CURRENT_USER, null, beforeState, afterState, null);
    }

    public static OperationLogCommand failure(
        String module,
        String action,
        String targetType,
        UUID targetId,
        String targetNo,
        ActorMode actorMode,
        OperationActor explicitActor,
        Map<StateField, Object> beforeState,
        Map<StateField, Object> afterState,
        String reason
    ) {
        return new OperationLogCommand(
            module, action, targetType, targetId, targetNo, Outcome.FAILURE, reason,
            beforeState, afterState, actorMode, explicitActor
        );
    }

    public static Map<StateField, Object> state(Object... entries) {
        if (entries == null || entries.length == 0) {
            return Map.of();
        }
        if (entries.length % 2 != 0) {
            throw new IllegalArgumentException("状态字段必须按 key/value 成对提供");
        }
        var state = new EnumMap<StateField, Object>(StateField.class);
        for (int index = 0; index < entries.length; index += 2) {
            if (!(entries[index] instanceof StateField field)) {
                throw new IllegalArgumentException("状态 key 必须是 StateField");
            }
            state.put(field, entries[index + 1]);
        }
        return immutableState(state);
    }

    public String failureKey() {
        return String.join("|",
            module,
            action,
            targetType,
            targetId == null ? "" : targetId.toString(),
            targetNo == null ? "" : targetNo,
            actorMode.name()
        );
    }

    private static Map<StateField, Object> immutableState(Map<StateField, Object> value) {
        if (value == null || value.isEmpty()) {
            return Map.of();
        }
        var copied = new EnumMap<StateField, Object>(StateField.class);
        value.forEach((field, fieldValue) -> {
            if (field == null) {
                throw new IllegalArgumentException("状态字段不能为空");
            }
            validateStateValue(fieldValue);
            copied.put(
                field,
                fieldValue instanceof Collection<?> collection
                    ? Collections.unmodifiableList(new ArrayList<>(collection))
                    : fieldValue
            );
        });
        return Collections.unmodifiableMap(copied);
    }

    private static void validateStateValue(Object value) {
        if (value == null || value instanceof String || value instanceof Boolean || value instanceof Number || value instanceof UUID) {
            return;
        }
        if (value instanceof Collection<?> collection && collection.stream().allMatch(OperationLogCommand::isScalar)) {
            return;
        }
        throw new IllegalArgumentException("状态值只允许标量或标量列表");
    }

    private static boolean isScalar(Object value) {
        return value == null || value instanceof String || value instanceof Boolean || value instanceof Number || value instanceof UUID || value instanceof BigDecimal;
    }

    private static String required(String value, String label, int maxLength) {
        var normalized = optional(value, maxLength);
        if (normalized == null) {
            throw new IllegalArgumentException("操作日志 " + label + " 不能为空");
        }
        return normalized;
    }

    private static String optional(String value, int maxLength) {
        if (value == null || value.isBlank()) {
            return null;
        }
        var normalized = value.trim();
        if (normalized.length() > maxLength) {
            throw new IllegalArgumentException("操作日志字段长度超过 " + maxLength);
        }
        return normalized;
    }
}
