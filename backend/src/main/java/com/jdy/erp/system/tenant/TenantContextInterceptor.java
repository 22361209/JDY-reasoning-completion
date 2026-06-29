package com.jdy.erp.system.tenant;

import java.util.List;
import java.util.Set;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import com.jdy.erp.system.security.CurrentSessionService;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.HandlerInterceptor;

@Component
public class TenantContextInterceptor implements HandlerInterceptor {
    private static final Set<String> PLATFORM_EXACT_PATHS = Set.of(
        "/api/system/health",
        "/api/system/session",
        "/api/system/users",
        "/api/system/login",
        "/api/system/logout",
        "/api/system/account-sets/current",
        "/api/system/account-sets"
    );
    private static final List<String> PLATFORM_PREFIXES = List.of(
        "/api/system/managed-users",
        "/api/system/role-permissions",
        "/api/system/roles",
        "/api/system/security-settings",
        "/api/system/notification-provider-settings",
        "/api/system/notification-outbox",
        "/api/system/password",
        "/api/system/password-reset-requests"
    );

    private final CurrentSessionService currentSessionService;

    public TenantContextInterceptor(CurrentSessionService currentSessionService) {
        this.currentSessionService = currentSessionService;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        if (!(handler instanceof HandlerMethod) || !request.getRequestURI().startsWith("/api/")) {
            return true;
        }
        if (isPlatformPath(request.getRequestURI())) {
            TenantContext.setPlatform();
            return true;
        }
        if (!currentSessionService.isAuthenticated()) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "请先登录");
        }
        TenantContext.setTenant(currentSessionService.currentAccountSet());
        return true;
    }

    @Override
    public void afterCompletion(HttpServletRequest request, HttpServletResponse response, Object handler, Exception ex) {
        TenantContext.clear();
    }

    boolean isPlatformPath(String requestUri) {
        return PLATFORM_EXACT_PATHS.contains(requestUri) || PLATFORM_PREFIXES.stream().anyMatch(requestUri::startsWith);
    }
}
