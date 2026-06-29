package com.jdy.erp.system.security;

import com.jdy.erp.system.tenant.TenantContextInterceptor;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class PermissionWebConfig implements WebMvcConfigurer {
    private final SessionAuthInterceptor sessionAuthInterceptor;
    private final TenantContextInterceptor tenantContextInterceptor;
    private final PermissionGuardInterceptor permissionGuardInterceptor;
    private final com.jdy.erp.shared.api.DocumentLockGuardInterceptor documentLockGuardInterceptor;

    public PermissionWebConfig(
        SessionAuthInterceptor sessionAuthInterceptor,
        TenantContextInterceptor tenantContextInterceptor,
        PermissionGuardInterceptor permissionGuardInterceptor,
        com.jdy.erp.shared.api.DocumentLockGuardInterceptor documentLockGuardInterceptor
    ) {
        this.sessionAuthInterceptor = sessionAuthInterceptor;
        this.tenantContextInterceptor = tenantContextInterceptor;
        this.permissionGuardInterceptor = permissionGuardInterceptor;
        this.documentLockGuardInterceptor = documentLockGuardInterceptor;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(sessionAuthInterceptor).addPathPatterns("/api/**");
        registry.addInterceptor(tenantContextInterceptor).addPathPatterns("/api/**");
        registry.addInterceptor(permissionGuardInterceptor).addPathPatterns("/api/**");
        registry.addInterceptor(documentLockGuardInterceptor).addPathPatterns("/api/**");
    }
}
