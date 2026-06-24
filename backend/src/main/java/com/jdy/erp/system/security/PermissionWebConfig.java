package com.jdy.erp.system.security;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class PermissionWebConfig implements WebMvcConfigurer {
    private final SessionAuthInterceptor sessionAuthInterceptor;
    private final PermissionGuardInterceptor permissionGuardInterceptor;

    public PermissionWebConfig(SessionAuthInterceptor sessionAuthInterceptor, PermissionGuardInterceptor permissionGuardInterceptor) {
        this.sessionAuthInterceptor = sessionAuthInterceptor;
        this.permissionGuardInterceptor = permissionGuardInterceptor;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(sessionAuthInterceptor).addPathPatterns("/api/**");
        registry.addInterceptor(permissionGuardInterceptor).addPathPatterns("/api/**");
    }
}
