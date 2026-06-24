package com.jdy.erp.system.security;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class PermissionWebConfig implements WebMvcConfigurer {
    private final PermissionGuardInterceptor permissionGuardInterceptor;

    public PermissionWebConfig(PermissionGuardInterceptor permissionGuardInterceptor) {
        this.permissionGuardInterceptor = permissionGuardInterceptor;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(permissionGuardInterceptor).addPathPatterns("/api/**");
    }
}
