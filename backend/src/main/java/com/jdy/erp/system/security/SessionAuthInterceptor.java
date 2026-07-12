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
    private static final Set<PublicEndpoint> PUBLIC_API_ENDPOINTS = Set.of(
        new PublicEndpoint("GET", "/api/system/health"),
        new PublicEndpoint("GET", "/api/system/session"),
        new PublicEndpoint("GET", "/api/system/account-sets"),
        new PublicEndpoint("POST", "/api/system/login"),
        new PublicEndpoint("POST", "/api/system/logout"),
        new PublicEndpoint("POST", "/api/system/password-reset-requests")
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
        if (isPublicApiEndpoint(request.getMethod(), request.getRequestURI())) {
            return true;
        }
        if (currentSessionService.isAuthenticated()) {
            return true;
        }
        throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "请先登录");
    }

    private boolean isPublicApiEndpoint(String method, String requestUri) {
        return PUBLIC_API_ENDPOINTS.contains(new PublicEndpoint(method, requestUri));
    }

    private record PublicEndpoint(String method, String path) {
    }
}
