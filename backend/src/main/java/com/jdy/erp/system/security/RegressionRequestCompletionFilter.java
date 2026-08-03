package com.jdy.erp.system.security;

import java.io.IOException;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.core.Ordered;
import org.springframework.session.web.http.SessionRepositoryFilter;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Wraps SessionRepositoryFilter so tracked requests remain active until the Redis-backed
 * HttpSession has been saved. MVC interceptor completion is too early for this boundary.
 */
@Component
public final class RegressionRequestCompletionFilter extends OncePerRequestFilter implements Ordered {
    private static final String FENCE_PATH = "/api/system/regression-request-fence";

    private final RegressionActiveRequestTracker requestTracker;
    private final RegressionSharedAdminLoginGuard accessGuard;

    public RegressionRequestCompletionFilter(
        RegressionActiveRequestTracker requestTracker,
        RegressionSharedAdminLoginGuard accessGuard
    ) {
        this.requestTracker = requestTracker;
        this.accessGuard = accessGuard;
    }

    @Override
    public int getOrder() {
        return SessionRepositoryFilter.DEFAULT_ORDER - 1;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        var requestPath = requestPath(request);
        if (FENCE_PATH.equals(requestPath)) {
            return true;
        }
        return !accessGuard.isSharedAdminLoginGuardActive(request)
            && !accessGuard.shouldTrackPotentialSharedAdminCredentialUse(request);
    }

    @Override
    protected void doFilterInternal(
        HttpServletRequest request,
        HttpServletResponse response,
        FilterChain filterChain
    ) throws ServletException, IOException {
        requestTracker.openRequestScope(request);
        try {
            filterChain.doFilter(request, response);
        } finally {
            requestTracker.closeRequestScope(request);
        }
    }

    private String requestPath(HttpServletRequest request) {
        var requestUri = request.getRequestURI();
        var contextPath = request.getContextPath();
        return contextPath.isEmpty() ? requestUri : requestUri.substring(contextPath.length());
    }
}
