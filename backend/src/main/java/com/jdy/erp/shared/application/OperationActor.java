package com.jdy.erp.shared.application;

import java.util.UUID;

public record OperationActor(
    Type type,
    UUID operatedBy,
    String username,
    String displayName
) {
    public enum Type {
        USER,
        SYSTEM,
        ANONYMOUS,
        HISTORICAL_UNKNOWN
    }

    public OperationActor {
        if (type == null) {
            throw new IllegalArgumentException("操作日志 actor type 不能为空");
        }
        username = normalized(username);
        displayName = normalized(displayName);
    }

    public static OperationActor user(UUID operatedBy, String username, String displayName) {
        return new OperationActor(Type.USER, operatedBy, username, displayName);
    }

    public static OperationActor system() {
        return new OperationActor(Type.SYSTEM, null, null, null);
    }

    public static OperationActor anonymous() {
        return new OperationActor(Type.ANONYMOUS, null, null, null);
    }

    public void validateForNewWrite() {
        switch (type) {
            case USER -> {
                if (operatedBy == null || username == null || displayName == null) {
                    throw new IllegalArgumentException("USER 操作日志必须包含用户 UUID、用户名和显示名快照");
                }
            }
            case SYSTEM, ANONYMOUS -> {
                if (operatedBy != null || username != null || displayName != null) {
                    throw new IllegalArgumentException(type + " 操作日志不得携带用户身份字段");
                }
            }
            case HISTORICAL_UNKNOWN -> throw new IllegalArgumentException("新日志不得写入 HISTORICAL_UNKNOWN actor");
        }
    }

    private static String normalized(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        return value.trim();
    }
}
