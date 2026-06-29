package com.jdy.erp.system.tenant;

import java.nio.charset.StandardCharsets;
import java.util.UUID;

import com.jdy.erp.system.security.CurrentSessionService;
import org.springframework.stereotype.Service;

@Service
public class TenantDataScopeService {
    private final CurrentSessionService currentSessionService;

    public TenantDataScopeService(CurrentSessionService currentSessionService) {
        this.currentSessionService = currentSessionService;
    }

    public String currentScopeId(String namespace) {
        var normalizedNamespace = namespace == null ? "" : namespace.trim().toLowerCase();
        if (normalizedNamespace.isBlank()) {
            throw new IllegalArgumentException("数据范围命名空间不能为空");
        }
        var context = TenantContext.current().orElse(null);
        if (context == null || !context.isTenant() || isPlatformSchema(context.schemaName())) {
            return currentSessionService.currentAccountSetId();
        }
        return UUID.nameUUIDFromBytes((
            normalizedNamespace + ":" + context.databaseName() + ":" + context.schemaName()
        ).getBytes(StandardCharsets.UTF_8)).toString();
    }

    private boolean isPlatformSchema(String schemaName) {
        return schemaName == null || schemaName.isBlank() || "public".equalsIgnoreCase(schemaName);
    }
}
