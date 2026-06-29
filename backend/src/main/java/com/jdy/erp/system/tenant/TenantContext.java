package com.jdy.erp.system.tenant;

import java.util.Map;
import java.util.Optional;

public final class TenantContext {
    private static final ThreadLocal<Snapshot> CURRENT = new ThreadLocal<>();

    private TenantContext() {
    }

    public static void setPlatform() {
        CURRENT.set(Snapshot.platform());
    }

    public static void setTenant(Map<String, Object> accountSet) {
        CURRENT.set(Snapshot.tenant(
            stringValue(accountSet.get("id")),
            stringValue(accountSet.get("code")),
            stringValue(accountSet.get("databaseName")),
            stringValue(accountSet.get("schemaName")),
            stringValue(accountSet.get("redisKeyPrefix")),
            stringValue(accountSet.get("attachmentPrefix"))
        ));
    }

    public static Optional<Snapshot> current() {
        return Optional.ofNullable(CURRENT.get());
    }

    public static Snapshot requireTenant() {
        var snapshot = CURRENT.get();
        if (snapshot == null || snapshot.scope() != Scope.TENANT) {
            throw new IllegalStateException("业务请求缺少账套上下文");
        }
        return snapshot;
    }

    public static void clear() {
        CURRENT.remove();
    }

    private static String stringValue(Object value) {
        return value == null ? "" : String.valueOf(value);
    }

    public enum Scope {
        PLATFORM,
        TENANT
    }

    public record Snapshot(
        Scope scope,
        String accountSetId,
        String accountSetCode,
        String databaseName,
        String schemaName,
        String redisKeyPrefix,
        String attachmentPrefix
    ) {
        static Snapshot platform() {
            return new Snapshot(Scope.PLATFORM, "", "platform", "", "", "platform", "platform");
        }

        static Snapshot tenant(
            String accountSetId,
            String accountSetCode,
            String databaseName,
            String schemaName,
            String redisKeyPrefix,
            String attachmentPrefix
        ) {
            var normalizedCode = accountSetCode == null || accountSetCode.isBlank() ? "tenant" : accountSetCode;
            return new Snapshot(
                Scope.TENANT,
                accountSetId,
                normalizedCode,
                databaseName == null ? "" : databaseName,
                schemaName == null ? "" : schemaName,
                redisKeyPrefix == null || redisKeyPrefix.isBlank() ? normalizedCode : redisKeyPrefix,
                attachmentPrefix == null || attachmentPrefix.isBlank() ? "account-sets/" + normalizedCode : attachmentPrefix
            );
        }

        public boolean isTenant() {
            return scope == Scope.TENANT;
        }
    }
}
