package com.jdy.erp.system.security;

import java.util.Set;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.HandlerInterceptor;

@Component
public class SessionAuthInterceptor implements HandlerInterceptor {
    private static final Set<String> PUBLIC_API_PATHS = Set.of(
        "/api/system/health",
        "/api/system/session",
        "/api/system/account-sets",
        "/api/system/users",
        "/api/system/login",
        "/api/system/logout",
        "/api/system/password-reset-requests"
    );

    private final CurrentSessionService currentSessionService;

    public SessionAuthInterceptor(CurrentSessionService currentSessionService) {
        this.currentSessionService = currentSessionService;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        if (!(handler instanceof HandlerMethod)) {
            return true;
        }
        if (isPublicApiPath(request.getRequestURI())) {
            return true;
        }
        if (currentSessionService.isAuthenticated()) {
            return true;
        }
        throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "请先登录");
    }

    private boolean isPublicApiPath(String requestUri) {
        return PUBLIC_API_PATHS.contains(requestUri) || requestUri.startsWith("/api/system/password-reset-requests");
    }
}
