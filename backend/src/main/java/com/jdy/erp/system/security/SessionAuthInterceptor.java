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
    private static final String FENCE_PATH = "/api/system/regression-request-fence";
    private static final Set<String> TRACKING_EXCLUDED_PUBLIC_WRITE_PATHS = Set.of(FENCE_PATH);
    private static final Set<String> WRITE_METHODS = Set.of("POST", "PUT", "PATCH", "DELETE");
    private static final Set<PublicReadEndpoint> PUBLIC_READ_ENDPOINTS = Set.of(
        new PublicReadEndpoint("GET", "/api/system/health"),
        new PublicReadEndpoint("GET", "/api/system/session"),
        new PublicReadEndpoint("GET", "/api/system/account-sets")
    );

    private final CurrentSessionService currentSessionService;
    private final OperationActorProvider operationActorProvider;
    private final RegressionActiveRequestTracker regressionActiveRequestTracker;

    public SessionAuthInterceptor(
        CurrentSessionService currentSessionService,
        OperationActorProvider operationActorProvider,
        RegressionActiveRequestTracker regressionActiveRequestTracker
    ) {
        this.currentSessionService = currentSessionService;
        this.operationActorProvider = operationActorProvider;
        this.regressionActiveRequestTracker = regressionActiveRequestTracker;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        if (!(handler instanceof HandlerMethod handlerMethod)) {
            return true;
        }
        var publicRead = isPublicRead(request);
        var publicWrite = isPublicWrite(request, handlerMethod);
        if (publicWrite && TRACKING_EXCLUDED_PUBLIC_WRITE_PATHS.contains(requestPath(request))) {
            return true;
        }
        if (regressionActiveRequestTracker.hasOpenRequestScope(request)) {
            var fixtureSessionLoaded = false;
            try {
                if (currentSessionService.isAuthenticated()) {
                    var username = currentSessionService.currentUsername();
                    fixtureSessionLoaded = RegressionActiveRequestTracker.isFixtureUsername(username);
                    var userId = java.util.UUID.fromString(currentSessionService.currentUserId());
                    regressionActiveRequestTracker.trackRegisteredIdentity(
                        request,
                        userId,
                        RegressionActiveRequestTracker.isFixtureUsername(username),
                        (long) currentSessionService.currentSessionGeneration()
                    );
                    var actor = operationActorProvider.captureCurrentUser();
                    if (!actor.operatedBy().equals(userId)) {
                        throw new ResponseStatusException(HttpStatus.CONFLICT, "请求身份在认证期间发生变化");
                    }
                    return true;
                }
                if (publicRead || publicWrite) {
                    return true;
                }
                throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "请先登录");
            } catch (RuntimeException | Error exception) {
                // Only the run-scoped fixture session may be invalidated after its fence closes.
                // A shared admin request can fail for unrelated DB/actor reasons while the suite
                // lock exists; deleting that pre-existing session would violate the invariant the
                // regression fence is designed to preserve.
                if (fixtureSessionLoaded) {
                    currentSessionService.invalidateCurrentRequestSession();
                }
                throw exception;
            }
        }
        if (publicRead || publicWrite) {
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
