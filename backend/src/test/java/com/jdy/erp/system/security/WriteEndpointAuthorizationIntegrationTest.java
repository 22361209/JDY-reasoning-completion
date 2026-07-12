package com.jdy.erp.system.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.lang.reflect.Method;
import java.util.Map;

import com.jdy.erp.shared.application.DocumentPermissionPolicy;
import jakarta.servlet.http.HttpServletResponse;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.HandlerMapping;

class WriteEndpointAuthorizationIntegrationTest {
    private final HttpServletResponse response = mock(HttpServletResponse.class);

    @Test
    void unclassifiedWriteFailsClosedWhileUnclassifiedReadRemainsAuthenticatedOnly() throws Exception {
        var interceptor = permissionInterceptor(mock(CurrentPermissionService.class), mock(DocumentPermissionPolicy.class));

        assertStatus(
            HttpStatus.FORBIDDEN,
            () -> interceptor.preHandle(request("POST", "/api/test"), response, handler("unclassified"))
        );
        assertThat(interceptor.preHandle(request("GET", "/api/test"), response, handler("unclassified"))).isTrue();
    }

    @Test
    void documentPermissionIsResolvedFromTheRouteBeforeControllerExecution() throws Exception {
        var documentPolicy = mock(DocumentPermissionPolicy.class);
        var interceptor = permissionInterceptor(mock(CurrentPermissionService.class), documentPolicy);
        var request = request("POST", "/api/document-lifecycle/salesOrder/XSDD000001/close");
        request.setAttribute(HandlerMapping.URI_TEMPLATE_VARIABLES_ATTRIBUTE, Map.of("type", "salesOrder"));

        assertThat(interceptor.preHandle(request, response, handler("documentScoped"))).isTrue();

        verify(documentPolicy).requirePermission("salesOrder");
    }

    @Test
    void missingDocumentTypeAndConflictingDeclarationsFailClosed() throws Exception {
        var interceptor = permissionInterceptor(mock(CurrentPermissionService.class), mock(DocumentPermissionPolicy.class));

        assertStatus(
            HttpStatus.INTERNAL_SERVER_ERROR,
            () -> interceptor.preHandle(request("POST", "/api/document-lifecycle/missing"), response, handler("documentScoped"))
        );
        assertStatus(
            HttpStatus.INTERNAL_SERVER_ERROR,
            () -> interceptor.preHandle(request("POST", "/api/conflict"), response, handler("conflicting"))
        );
    }

    @Test
    void fixedPermissionStillReturnsForbiddenBeforeTheHandlerWhenMissing() throws Exception {
        var permissionService = mock(CurrentPermissionService.class);
        when(permissionService.hasPermission("sales.order.audit")).thenReturn(false);
        var interceptor = permissionInterceptor(permissionService, mock(DocumentPermissionPolicy.class));

        assertStatus(
            HttpStatus.FORBIDDEN,
            () -> interceptor.preHandle(request("POST", "/api/sales-orders/draft"), response, handler("fixedPermission"))
        );
        verify(permissionService).hasPermission("sales.order.audit");
    }

    @Test
    void explicitPublicAuthenticatedAndRequestScopedWritesReachTheirDedicatedPolicies() throws Exception {
        var interceptor = permissionInterceptor(mock(CurrentPermissionService.class), mock(DocumentPermissionPolicy.class));

        assertThat(interceptor.preHandle(
            mappedRequest("POST", "/api/system/login", "/api/system/login"),
            response,
            handler("publicWrite")
        )).isTrue();
        assertThat(interceptor.preHandle(
            mappedRequest("PUT", "/api/system/password", "/api/system/password"),
            response,
            handler("authenticatedWrite")
        )).isTrue();
        assertThat(interceptor.preHandle(
            mappedRequest("POST", "/api/list-presets/test", "/api/list-presets/{listKey}"),
            response,
            handler("requestScopedWrite")
        )).isTrue();
    }

    @Test
    void runtimeWritePolicyMethodOrMappingDriftFailsClosed() throws Exception {
        var interceptor = permissionInterceptor(mock(CurrentPermissionService.class), mock(DocumentPermissionPolicy.class));
        var wrongPattern = request("POST", "/api/system/login");
        wrongPattern.setAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE, "/api/system/logout");

        assertStatus(
            HttpStatus.INTERNAL_SERVER_ERROR,
            () -> interceptor.preHandle(request("POST", "/api/system/login"), response, handler("publicWrite"))
        );
        assertStatus(
            HttpStatus.INTERNAL_SERVER_ERROR,
            () -> interceptor.preHandle(request("GET", "/api/system/login"), response, handler("publicWrite"))
        );
        assertStatus(
            HttpStatus.INTERNAL_SERVER_ERROR,
            () -> interceptor.preHandle(wrongPattern, response, handler("publicWrite"))
        );
    }

    @Test
    void sessionPublicBoundaryUsesMethodAndExactPath() throws Exception {
        var sessionService = mock(CurrentSessionService.class);
        when(sessionService.isAuthenticated()).thenReturn(false);
        var interceptor = new SessionAuthInterceptor(sessionService);

        assertThat(interceptor.preHandle(request("POST", "/api/system/login"), response, handler("publicWrite"))).isTrue();
        assertThat(interceptor.preHandle(
            request("POST", "/api/system/password-reset-requests"),
            response,
            handler("passwordResetPublicWrite")
        )).isTrue();
        assertStatus(
            HttpStatus.UNAUTHORIZED,
            () -> interceptor.preHandle(request("GET", "/api/system/login"), response, handler("publicWrite"))
        );
        assertStatus(
            HttpStatus.UNAUTHORIZED,
            () -> interceptor.preHandle(request("POST", "/api/system/logout"), response, handler("publicWrite"))
        );
        assertStatus(
            HttpStatus.UNAUTHORIZED,
            () -> interceptor.preHandle(request("GET", "/api/system/users"), response, handler("unclassified"))
        );
        assertStatus(
            HttpStatus.UNAUTHORIZED,
            () -> interceptor.preHandle(
                request("PUT", "/api/system/password-reset-requests/request-id"),
                response,
                handler("unclassified")
            )
        );
    }

    private PermissionGuardInterceptor permissionInterceptor(
        CurrentPermissionService permissionService,
        DocumentPermissionPolicy documentPermissionPolicy
    ) {
        return new PermissionGuardInterceptor(permissionService, documentPermissionPolicy);
    }

    private MockHttpServletRequest request(String method, String path) {
        return new MockHttpServletRequest(method, path);
    }

    private MockHttpServletRequest mappedRequest(String method, String path, String matchingPattern) {
        var request = request(method, path);
        request.setAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE, matchingPattern);
        return request;
    }

    private HandlerMethod handler(String methodName) throws Exception {
        Method method = TestHandlers.class.getDeclaredMethod(methodName);
        return new HandlerMethod(new TestHandlers(), method);
    }

    private void assertStatus(HttpStatus expected, ThrowingCall call) {
        assertThatThrownBy(call::run)
            .isInstanceOfSatisfying(ResponseStatusException.class, error ->
                assertThat(error.getStatusCode()).isEqualTo(expected));
    }

    @FunctionalInterface
    private interface ThrowingCall {
        void run() throws Exception;
    }

    private static class TestHandlers {
        void unclassified() {
        }

        @RequirePermission("sales.order.audit")
        void fixedPermission() {
        }

        @RequireDocumentPermission
        void documentScoped() {
        }

        @WriteAccess(WriteAccess.Policy.LOGIN)
        void publicWrite() {
        }

        @WriteAccess(WriteAccess.Policy.REQUEST_PASSWORD_RESET)
        void passwordResetPublicWrite() {
        }

        @WriteAccess(WriteAccess.Policy.CHANGE_OWN_PASSWORD)
        void authenticatedWrite() {
        }

        @WriteAccess(WriteAccess.Policy.SAVE_LIST_PRESET)
        void requestScopedWrite() {
        }

        @RequirePermission("sales.order.audit")
        @WriteAccess(WriteAccess.Policy.CHANGE_OWN_PASSWORD)
        void conflicting() {
        }
    }
}
