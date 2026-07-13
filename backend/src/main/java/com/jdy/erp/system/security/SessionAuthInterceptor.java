package com.jdy.erp.system.security;

import java.util.Set;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import com.jdy.erp.shared.application.OperationActorProvider;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.HandlerInterceptor;

@Component
public class SessionAuthInterceptor implements HandlerInterceptor {
    private static final Set<String> WRITE_METHODS = Set.of("POST", "PUT", "PATCH", "DELETE");
    private static final Set<PublicReadEndpoint> PUBLIC_READ_ENDPOINTS = Set.of(
        new PublicReadEndpoint("GET", "/api/system/health"),
        new PublicReadEndpoint("GET", "/api/system/session"),
        new PublicReadEndpoint("GET", "/api/system/account-sets")
    );

    private final CurrentSessionService currentSessionService;
    private final OperationActorProvider operationActorProvider;

    public SessionAuthInterceptor(
        CurrentSessionService currentSessionService,
        OperationActorProvider operationActorProvider
    ) {
        this.currentSessionService = currentSessionService;
        this.operationActorProvider = operationActorProvider;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        if (!(handler instanceof HandlerMethod handlerMethod)) {
            return true;
        }
        if (isPublicRead(request) || isPublicWrite(request, handlerMethod)) {
            return true;
        }
        if (currentSessionService.isAuthenticated()) {
            if (WRITE_METHODS.contains(request.getMethod())) {
                operationActorProvider.captureCurrentUser();
            }
            return true;
        }
        throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "请先登录");
    }

    private boolean isPublicRead(HttpServletRequest request) {
        return PUBLIC_READ_ENDPOINTS.contains(new PublicReadEndpoint(request.getMethod(), requestPath(request)));
    }

    private boolean isPublicWrite(HttpServletRequest request, HandlerMethod handler) {
        var declaration = WriteAccessPolicyContract.find(handler);
        if (declaration == null || declaration.value().mode() != WriteAccess.Mode.PUBLIC) {
            return false;
        }
        return declaration.value().matches(request.getMethod(), requestPath(request));
    }

    private String requestPath(HttpServletRequest request) {
        var requestUri = request.getRequestURI();
        var contextPath = request.getContextPath();
        return contextPath.isEmpty() ? requestUri : requestUri.substring(contextPath.length());
    }

    private record PublicReadEndpoint(String method, String path) {
    }
}
