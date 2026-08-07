package com.jdy.erp.system.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.session.web.http.SessionRepositoryFilter;
import org.springframework.web.server.ResponseStatusException;

class RegressionRequestCompletionFilterTest {
    private final RegressionActiveRequestTracker tracker = new RegressionActiveRequestTracker();
    private final RegressionSharedAdminLoginGuard accessGuard = mock(RegressionSharedAdminLoginGuard.class);
    private final RegressionRequestCompletionFilter filter = new RegressionRequestCompletionFilter(tracker, accessGuard);

    @Test
    void wrapsSessionRepositoryFilterAndReleasesOnlyAfterTheInnerChainReturns() throws Exception {
        var userId = UUID.randomUUID();
        tracker.open(userId, 1);
        var request = request("/api/system/session");
        var response = new MockHttpServletResponse();
        when(accessGuard.isSharedAdminLoginGuardActive(request)).thenReturn(true);
        var closing = new AtomicReference<java.util.concurrent.Future<RegressionActiveRequestTracker.Snapshot>>();

        try (var executor = Executors.newSingleThreadExecutor()) {
            filter.doFilter(request, response, (innerRequest, innerResponse) -> {
                tracker.trackRegisteredIdentity((MockHttpServletRequest) innerRequest, userId, true, 1L);
                closing.set(executor.submit(() -> tracker.closeAndDrain(userId, 1, Duration.ofSeconds(2))));
                awaitState(userId, RegressionActiveRequestTracker.FenceState.CLOSED);
                assertThat(closing.get().isDone()).isFalse();
                // Returning represents SessionRepositoryFilter completing its Redis session save.
            });

            assertThat(closing.get().get(1, TimeUnit.SECONDS).activeCount()).isZero();
        }

        assertThat(filter.getOrder()).isLessThan(SessionRepositoryFilter.DEFAULT_ORDER);
        assertThat(tracker.snapshot(userId).activeCount()).isZero();
    }

    @Test
    void excludesFenceControlAndInactiveGuardWithoutOpeningARequestScope() throws Exception {
        var userId = UUID.randomUUID();
        tracker.open(userId, 1);
        var fenceRequest = request("/api/system/regression-request-fence");
        when(accessGuard.isSharedAdminLoginGuardActive(fenceRequest)).thenReturn(true);

        assertThatThrownBy(() -> filter.doFilter(
            fenceRequest,
            new MockHttpServletResponse(),
            (innerRequest, innerResponse) -> tracker.trackRegisteredIdentity(
                (MockHttpServletRequest) innerRequest,
                userId,
                true,
                1L
            )
        ))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode().value()).isEqualTo(423));

        var inactiveRequest = request("/api/system/session");
        assertThatThrownBy(() -> filter.doFilter(
            inactiveRequest,
            new MockHttpServletResponse(),
            (innerRequest, innerResponse) -> tracker.trackRegisteredIdentity(
                (MockHttpServletRequest) innerRequest,
                userId,
                true,
                1L
            )
        ))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode().value()).isEqualTo(423));

        assertThat(tracker.snapshot(userId).activeCount()).isZero();
    }

    @Test
    void tracksPotentialSharedAdminLoginBeforeTheSuiteLockExists() throws Exception {
        var request = request("/api/system/login");
        request.setMethod("POST");
        var leaseClosed = new AtomicBoolean();
        when(accessGuard.isSharedAdminLoginGuardActive(request)).thenReturn(false);
        when(accessGuard.shouldTrackPotentialSharedAdminCredentialUse(request)).thenReturn(true);

        filter.doFilter(request, new MockHttpServletResponse(), (innerRequest, innerResponse) -> {
            tracker.trackRequiredLease(
                (MockHttpServletRequest) innerRequest,
                () -> leaseClosed.set(true)
            );
            assertThat(leaseClosed).isFalse();
        });

        assertThat(leaseClosed).isTrue();
    }

    private MockHttpServletRequest request(String path) {
        return new MockHttpServletRequest("GET", path);
    }

    private void awaitState(UUID userId, RegressionActiveRequestTracker.FenceState expected) {
        var deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
        while (tracker.snapshot(userId).state() != expected && System.nanoTime() < deadline) {
            Thread.onSpinWait();
        }
        assertThat(tracker.snapshot(userId).state()).isEqualTo(expected);
    }
}
