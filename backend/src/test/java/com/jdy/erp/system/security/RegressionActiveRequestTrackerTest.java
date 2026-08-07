package com.jdy.erp.system.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.server.ResponseStatusException;

class RegressionActiveRequestTrackerTest {
    private final RegressionActiveRequestTracker tracker = new RegressionActiveRequestTracker();
    private final UUID userId = UUID.randomUUID();

    @Test
    void closesBeforeWaitingAndRejectsNewWritesUntilTheEnteredWriteLeaves() throws Exception {
        tracker.open(userId, 1);
        var entered = tracker.begin(userId);
        var closeStarted = new CountDownLatch(1);
        try (var executor = Executors.newSingleThreadExecutor()) {
            var close = executor.submit(() -> {
                closeStarted.countDown();
                return tracker.closeAndDrain(userId, 1, Duration.ofSeconds(2));
            });

            assertThat(closeStarted.await(1, TimeUnit.SECONDS)).isTrue();
            awaitState(RegressionActiveRequestTracker.FenceState.CLOSED);
            assertThat(close.isDone()).isFalse();
            assertThatThrownBy(() -> tracker.begin(userId))
                .isInstanceOfSatisfying(ResponseStatusException.class, exception ->
                    assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.LOCKED));

            entered.close();
            assertThat(close.get(1, TimeUnit.SECONDS))
                .isEqualTo(new RegressionActiveRequestTracker.Snapshot(
                    RegressionActiveRequestTracker.FenceState.CLOSED,
                    0
                ));
        }
    }

    @Test
    void leasesAreIdempotentAndExceptionPathsDoNotLeakCounts() {
        tracker.open(userId, 1);
        assertThatThrownBy(() -> {
            try (var ignored = tracker.begin(userId)) {
                throw new IllegalStateException("injected handler failure");
            }
        }).isInstanceOf(IllegalStateException.class);
        assertThat(tracker.snapshot(userId).activeCount()).isZero();

        var lease = tracker.begin(userId);
        lease.close();
        lease.close();

        assertThat(tracker.snapshot(userId).activeCount()).isZero();
    }

    @Test
    void missingInMemoryStateCanBeClosedAndOnlyReopenedExplicitly() {
        try (var ignored = tracker.begin(userId)) {
            assertThat(tracker.trackedIdentityCount()).isZero();
        }
        assertThat(tracker.closeAndDrain(userId, 1, Duration.ofMillis(100)))
            .isEqualTo(new RegressionActiveRequestTracker.Snapshot(
                RegressionActiveRequestTracker.FenceState.CLOSED,
                0
            ));
        assertThatThrownBy(() -> tracker.begin(userId)).isInstanceOf(ResponseStatusException.class);

        assertThatThrownBy(() -> tracker.open(userId, 1))
            .isInstanceOfSatisfying(ResponseStatusException.class, exception ->
                assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.CONFLICT));
        assertThat(tracker.open(userId, 2).state()).isEqualTo(RegressionActiveRequestTracker.FenceState.OPEN);
        try (var ignored = tracker.begin(userId)) {
            assertThat(tracker.snapshot(userId).activeCount()).isOne();
        }
        assertThat(tracker.snapshot(userId).activeCount()).isZero();
    }

    @Test
    void lateOpenFromClosedGenerationCannotReopenAfterDrainReturns() {
        tracker.open(userId, 7);
        assertThat(tracker.closeAndDrain(userId, 7, Duration.ofMillis(100)).state())
            .isEqualTo(RegressionActiveRequestTracker.FenceState.CLOSED);

        assertThatThrownBy(() -> tracker.open(userId, 7))
            .isInstanceOfSatisfying(ResponseStatusException.class, exception ->
                assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.CONFLICT));
        assertThat(tracker.snapshot(userId))
            .isEqualTo(new RegressionActiveRequestTracker.Snapshot(
                RegressionActiveRequestTracker.FenceState.CLOSED,
                0
            ));
    }

    @Test
    void requiredFixtureRegistrationFailsClosedAfterBackendRestartLosesMemoryState() {
        var request = new MockHttpServletRequest();
        tracker.openRequestScope(request);

        assertThatThrownBy(() -> tracker.trackRegisteredIdentity(request, userId, true, 4L))
            .isInstanceOfSatisfying(ResponseStatusException.class, exception ->
                assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.LOCKED));
        assertThat(tracker.trackedIdentityCount()).isZero();

        tracker.open(userId, 4);
        tracker.trackRegisteredIdentity(request, userId, true, 4L);
        assertThat(tracker.snapshot(userId).activeCount()).isOne();
        tracker.closeRequestScope(request);
        assertThat(tracker.snapshot(userId).activeCount()).isZero();
    }

    @Test
    void delayedOldGenerationCannotAcquireANewerReopenedFence() {
        var request = new MockHttpServletRequest();
        tracker.openRequestScope(request);
        tracker.open(userId, 7);
        tracker.closeAndDrain(userId, 7, Duration.ofMillis(100));
        tracker.open(userId, 8);

        assertThatThrownBy(() -> tracker.trackRegisteredIdentity(request, userId, true, 7L))
            .isInstanceOfSatisfying(ResponseStatusException.class, exception ->
                assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.CONFLICT));
        assertThat(tracker.snapshot(userId).activeCount()).isZero();

        tracker.trackRegisteredIdentity(request, userId, true, 8L);
        assertThat(tracker.snapshot(userId).activeCount()).isOne();
        tracker.closeRequestScope(request);
    }

    private void awaitState(RegressionActiveRequestTracker.FenceState expected) {
        var deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
        while (tracker.snapshot(userId).state() != expected && System.nanoTime() < deadline) {
            Thread.onSpinWait();
        }
        assertThat(tracker.snapshot(userId).state()).isEqualTo(expected);
    }
}
