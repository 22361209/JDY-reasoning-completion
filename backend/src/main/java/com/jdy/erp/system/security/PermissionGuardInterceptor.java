package com.jdy.erp.system.security;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.core.annotation.AnnotationUtils;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.HandlerInterceptor;

@Component
public class PermissionGuardInterceptor implements HandlerInterceptor {
    private final CurrentPermissionService permissionService;

    public PermissionGuardInterceptor(CurrentPermissionService permissionService) {
        this.permissionService = permissionService;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        if (!(handler instanceof HandlerMethod handlerMethod)) {
            return true;
        }
        var required = AnnotationUtils.findAnnotation(handlerMethod.getMethod(), RequirePermission.class);
        if (required == null) {
            required = AnnotationUtils.findAnnotation(handlerMethod.getBeanType(), RequirePermission.class);
        }
        if (required == null || permissionService.hasPermission(required.value())) {
            return true;
        }
        throw new ResponseStatusException(HttpStatus.FORBIDDEN, "当前角色无权执行该操作：" + required.value());
    }
}
