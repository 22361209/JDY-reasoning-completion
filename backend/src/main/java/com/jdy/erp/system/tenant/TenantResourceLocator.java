package com.jdy.erp.system.tenant;

import org.springframework.stereotype.Service;

@Service
public class TenantResourceLocator {
    public String redisKey(String rawKey) {
        var normalizedKey = normalize(rawKey);
        var context = TenantContext.current().orElseGet(() -> TenantContext.Snapshot.platform());
        return context.redisKeyPrefix() + ":" + normalizedKey;
    }

    public String attachmentPath(String relativePath) {
        var normalizedPath = normalize(relativePath);
        var context = TenantContext.current().orElseGet(() -> TenantContext.Snapshot.platform());
        return stripTrailingSlash(context.attachmentPrefix()) + "/" + normalizedPath;
    }

    private String normalize(String value) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("资源 key/path 不能为空");
        }
        var normalized = value.trim();
        while (normalized.startsWith("/")) {
            normalized = normalized.substring(1);
        }
        if (normalized.contains("..")) {
            throw new IllegalArgumentException("资源 key/path 不能包含上级目录");
        }
        return normalized;
    }

    private String stripTrailingSlash(String value) {
        var normalized = value == null || value.isBlank() ? "platform" : value.trim();
        while (normalized.endsWith("/")) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        return normalized;
    }
}
