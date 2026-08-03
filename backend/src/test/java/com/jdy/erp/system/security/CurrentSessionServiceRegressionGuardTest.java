package com.jdy.erp.system.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

import com.jdy.erp.shared.application.OperationLogFailureService;
import com.jdy.erp.shared.application.OperationLogService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import org.springframework.web.server.ResponseStatusException;

class CurrentSessionServiceRegressionGuardTest {
    private final JdbcTemplate jdbcTemplate = mock(JdbcTemplate.class);
    private final OperationLogService operationLogService = mock(OperationLogService.class);
    private final OperationLogFailureService operationLogFailureService = mock(OperationLogFailureService.class);
    private final PlatformTransactionManager transactionManager = mock(PlatformTransactionManager.class);
    private final RegressionSharedAdminLoginGuard loginGuard = mock(RegressionSharedAdminLoginGuard.class);

    @AfterEach
    void clearRequest() {
        RequestContextHolder.resetRequestAttributes();
    }

    @Test
    void sharedAdminGuardRunsBeforeTheFirstCredentialLookupOrMutation() {
        var tracker = mock(RegressionActiveRequestTracker.class);
        var service = service(tracker);
        var request = bindRequest(8080);
        when(loginGuard.beginSharedAdminLogin("admin", request))
            .thenThrow(new ResponseStatusException(HttpStatus.LOCKED, "blocked"));

        assertThatThrownBy(() -> service.login(" admin ", "wrong-password", "BLD-TEST"))
            .isInstanceOfSatisfying(ResponseStatusException.class, exception ->
                assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.LOCKED));

        verifyNoInteractions(jdbcTemplate, operationLogService, operationLogFailureService, tracker);
    }

    @Test
    void sharedAdminSessionReplacementGuardRunsBeforeCredentialLookup() {
        var tracker = mock(RegressionActiveRequestTracker.class);
        var service = service(tracker);
        var request = bindRequest(8080);
        doThrow(new ResponseStatusException(HttpStatus.LOCKED, "blocked"))
            .when(loginGuard).rejectSharedAdminSessionReplacement("r_suite_0123456789ab", request);

        assertThatThrownBy(() -> service.login("r_suite_0123456789ab", "secret", "BLD-TEST"))
            .isInstanceOfSatisfying(ResponseStatusException.class, exception ->
                assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.LOCKED));

        verify(loginGuard).rejectSharedAdminSessionReplacement("r_suite_0123456789ab", request);
        verifyNoInteractions(jdbcTemplate, operationLogService, operationLogFailureService, tracker);
    }

    @Test
    void sharedAdminGuardAlsoRunsBeforePasswordConfirmationLookup() {
        var tracker = mock(RegressionActiveRequestTracker.class);
        var service = service(tracker);
        var request = bindRequest(8080);
        when(loginGuard.beginSharedAdminLogin("admin", request))
            .thenThrow(new ResponseStatusException(HttpStatus.LOCKED, "blocked"));

        assertThatThrownBy(() -> service.verifyPassword("admin", "admin123"))
            .isInstanceOfSatisfying(ResponseStatusException.class, exception ->
                assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.LOCKED));

        verifyNoInteractions(jdbcTemplate, operationLogService, operationLogFailureService, tracker);
    }

    @Test
    void sharedAdminPasswordConfirmationLeaseLastsUntilTheOuterRequestCompletes() throws Exception {
        var tracker = new RegressionActiveRequestTracker();
        var service = service(tracker);
        var request = bindRequest(8080);
        request.setMethod("POST");
        request.setRequestURI("/api/system/password-confirm");
        var leaseClosed = new AtomicBoolean();
        when(loginGuard.isSharedAdminLoginGuardActive(request)).thenReturn(false);
        when(loginGuard.shouldTrackPotentialSharedAdminCredentialUse(request)).thenReturn(true);
        when(loginGuard.beginSharedAdminLogin("admin", request)).thenReturn(() -> leaseClosed.set(true));
        when(jdbcTemplate.queryForList(anyString(), any(Object[].class))).thenReturn(List.of(Map.of(
            "passwordHash", "{noop}admin123"
        )));
        var filter = new RegressionRequestCompletionFilter(tracker, loginGuard);

        filter.doFilter(request, new MockHttpServletResponse(), (innerRequest, innerResponse) -> {
            service.verifyPassword("admin", "admin123");
            assertThat(leaseClosed).isFalse();
        });

        assertThat(leaseClosed).isTrue();
    }

    @Test
    void loginLeaseIsReleasedAfterTheOuterRequestChainWhenLoginFails() throws Exception {
        var tracker = new RegressionActiveRequestTracker();
        var userId = UUID.randomUUID();
        var service = service(tracker);
        var request = bindRequest(8080);
        request.setMethod("POST");
        request.setRequestURI("/api/system/login");
        tracker.open(userId, 1);
        when(loginGuard.isSharedAdminLoginGuardActive(request)).thenReturn(true);
        when(jdbcTemplate.queryForList(anyString(), any(Object[].class))).thenReturn(List.of(Map.of(
            "id", userId.toString(),
            "sessionGeneration", 1,
            "lockedUntil", OffsetDateTime.now().plusMinutes(5)
        )));
        var filter = new RegressionRequestCompletionFilter(tracker, loginGuard);

        assertThatThrownBy(() -> filter.doFilter(
            request,
            new MockHttpServletResponse(),
            (innerRequest, innerResponse) -> {
                service.login("r_suite_0123456789ab", "secret", "BLD-TEST");
            }
        ))
            .isInstanceOfSatisfying(ResponseStatusException.class, exception ->
                assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.LOCKED));

        assertThat(tracker.snapshot(userId).activeCount()).isZero();
    }

    @Test
    void fencedLoginInvalidatesAnAlreadyLoadedSessionInsteadOfResavingIt() throws Exception {
        var tracker = new RegressionActiveRequestTracker();
        var userId = UUID.randomUUID();
        var service = service(tracker);
        var request = bindRequest(8080);
        request.setMethod("POST");
        request.setRequestURI("/api/system/login");
        var existingSession = (MockHttpSession) request.getSession(true);
        existingSession.setAttribute(CurrentSessionService.SESSION_USERNAME, "r_suite_0123456789ab");
        tracker.closeAndDrain(userId, 1, java.time.Duration.ofMillis(100));
        when(loginGuard.isSharedAdminLoginGuardActive(request)).thenReturn(true);
        when(jdbcTemplate.queryForList(anyString(), any(Object[].class))).thenReturn(List.of(Map.of(
            "id", userId.toString(),
            "sessionGeneration", 1
        )));
        var filter = new RegressionRequestCompletionFilter(tracker, loginGuard);

        assertThatThrownBy(() -> filter.doFilter(
            request,
            new MockHttpServletResponse(),
            (innerRequest, innerResponse) -> service.login(
                "r_suite_0123456789ab",
                "secret",
                "BLD-TEST"
            )
        )).isInstanceOfSatisfying(ResponseStatusException.class, exception ->
            assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.LOCKED));

        assertThat(existingSession.isInvalid()).isTrue();
        assertThat(tracker.snapshot(userId).activeCount()).isZero();
    }

    @Test
    void fencedFixtureLoginDoesNotInvalidateAnUnrelatedSharedAdminSession() throws Exception {
        var tracker = new RegressionActiveRequestTracker();
        var userId = UUID.randomUUID();
        var service = service(tracker);
        var request = bindRequest(8080);
        request.setMethod("POST");
        request.setRequestURI("/api/system/login");
        var existingSession = (MockHttpSession) request.getSession(true);
        existingSession.setAttribute(CurrentSessionService.SESSION_USERNAME, "admin");
        tracker.closeAndDrain(userId, 1, java.time.Duration.ofMillis(100));
        when(loginGuard.isSharedAdminLoginGuardActive(request)).thenReturn(true);
        when(jdbcTemplate.queryForList(anyString(), any(Object[].class))).thenReturn(List.of(Map.of(
            "id", userId.toString(),
            "sessionGeneration", 1
        )));
        var filter = new RegressionRequestCompletionFilter(tracker, loginGuard);

        assertThatThrownBy(() -> filter.doFilter(
            request,
            new MockHttpServletResponse(),
            (innerRequest, innerResponse) -> service.login(
                "r_suite_0123456789ab",
                "secret",
                "BLD-TEST"
            )
        )).isInstanceOfSatisfying(ResponseStatusException.class, exception ->
            assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.LOCKED));

        assertThat(existingSession.isInvalid()).isFalse();
        assertThat(existingSession.getAttribute(CurrentSessionService.SESSION_USERNAME)).isEqualTo("admin");
        assertThat(tracker.snapshot(userId).activeCount()).isZero();
    }

    private CurrentSessionService service(RegressionActiveRequestTracker tracker) {
        return new CurrentSessionService(
            jdbcTemplate,
            operationLogService,
            operationLogFailureService,
            transactionManager,
            tracker,
            loginGuard
        );
    }

    private MockHttpServletRequest bindRequest(int localPort) {
        var request = new MockHttpServletRequest();
        request.setLocalPort(localPort);
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
        return request;
    }
}
