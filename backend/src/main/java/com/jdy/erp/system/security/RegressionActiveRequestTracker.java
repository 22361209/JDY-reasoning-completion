package com.jdy.erp.system.security;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;

import jakarta.servlet.http.HttpServletRequest;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

/**
 * In-memory request fence used only by the loopback regression control endpoint.
 * Every authenticated request for an explicitly opened fixture is counted so a fence cannot
 * race with request handling or the final Redis-backed session save.
 */
@Component
public final class RegressionActiveRequestTracker {
    private static final Pattern FIXTURE_USERNAME = Pattern.compile("^r_[a-z0-9_]{1,58}_[0-9a-f]{12,32}$");
    private static final String REQUEST_SCOPE_ATTRIBUTE =
        RegressionActiveRequestTracker.class.getName() + ".requestScope";
    private static final Lease UNTRACKED = () -> {
    };

    private final ConcurrentMap<UUID, Entry> entries = new ConcurrentHashMap<>();

    public Lease begin(UUID userId) {
        return begin(userId, false, null);
    }

    private Lease begin(UUID userId, boolean registrationRequired, Long expectedGeneration) {
        Objects.requireNonNull(userId, "userId");
        if (expectedGeneration != null && expectedGeneration < 0) {
            throw new IllegalArgumentException("expectedGeneration must be non-negative");
        }
        if (registrationRequired && expectedGeneration == null) {
            throw new IllegalArgumentException("required fixture registration needs an expected generation");
        }
        var entry = entries.get(userId);
        if (entry == null) {
            if (registrationRequired) {
                throw new ResponseStatusException(
                    HttpStatus.LOCKED,
                    "回归测试身份请求门未在当前后端进程登记"
                );
            }
            return UNTRACKED;
        }
        synchronized (entry) {
            if (expectedGeneration != null && expectedGeneration != entry.generation) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "回归测试身份请求门代际已失效");
            }
            if (entry.closed) {
                throw new ResponseStatusException(HttpStatus.LOCKED, "回归测试身份已关闭新请求");
            }
            entry.activeCount += 1;
            return new TrackedLease(entry);
        }
    }

    void openRequestScope(HttpServletRequest request) {
        Objects.requireNonNull(request, "request");
        if (request.getAttribute(REQUEST_SCOPE_ATTRIBUTE) != null) {
            throw new IllegalStateException("regression request scope is already open");
        }
        request.setAttribute(REQUEST_SCOPE_ATTRIBUTE, new RequestScope());
    }

    public void trackRegisteredIdentity(HttpServletRequest request, UUID userId) {
        trackRegisteredIdentity(request, userId, false, null);
    }

    public void trackRegisteredIdentity(
        HttpServletRequest request,
        UUID userId,
        boolean registrationRequired,
        Long expectedGeneration
    ) {
        Objects.requireNonNull(request, "request");
        Objects.requireNonNull(userId, "userId");
        var scopeValue = request.getAttribute(REQUEST_SCOPE_ATTRIBUTE);
        if (!(scopeValue instanceof RequestScope)) {
            if (registrationRequired) {
                throw new ResponseStatusException(
                    HttpStatus.LOCKED,
                    "回归测试身份请求未进入完成追踪边界"
                );
            }
            return;
        }
        var lease = begin(userId, registrationRequired, expectedGeneration);
        if (lease == UNTRACKED) {
            return;
        }
        attachLease(request, lease, true);
    }

    public void trackRequiredLease(HttpServletRequest request, Lease lease) {
        Objects.requireNonNull(request, "request");
        Objects.requireNonNull(lease, "lease");
        attachLease(request, lease, true);
    }

    private void attachLease(HttpServletRequest request, Lease lease, boolean registrationRequired) {
        var scopeValue = request.getAttribute(REQUEST_SCOPE_ATTRIBUTE);
        if (!(scopeValue instanceof RequestScope scope)) {
            lease.close();
            if (registrationRequired) {
                throw new ResponseStatusException(
                    HttpStatus.LOCKED,
                    "回归测试请求未进入完成追踪边界"
                );
            }
            return;
        }
        try {
            scope.leases.add(lease);
        } catch (RuntimeException | Error exception) {
            lease.close();
            throw exception;
        }
    }

    public static boolean isFixtureUsername(String username) {
        return username != null && FIXTURE_USERNAME.matcher(username).matches();
    }

    public boolean hasOpenRequestScope(HttpServletRequest request) {
        return request != null && request.getAttribute(REQUEST_SCOPE_ATTRIBUTE) instanceof RequestScope;
    }

    void closeRequestScope(HttpServletRequest request) {
        Objects.requireNonNull(request, "request");
        var scopeValue = request.getAttribute(REQUEST_SCOPE_ATTRIBUTE);
        request.removeAttribute(REQUEST_SCOPE_ATTRIBUTE);
        if (!(scopeValue instanceof RequestScope scope)) {
            return;
        }
        RuntimeException firstFailure = null;
        for (var index = scope.leases.size() - 1; index >= 0; index -= 1) {
            try {
                scope.leases.get(index).close();
            } catch (RuntimeException exception) {
                if (firstFailure == null) {
                    firstFailure = exception;
                } else {
                    firstFailure.addSuppressed(exception);
                }
            }
        }
        if (firstFailure != null) {
            throw firstFailure;
        }
    }

    public Snapshot open(UUID userId, long generation) {
        Objects.requireNonNull(userId, "userId");
        if (generation < 0) {
            throw new IllegalArgumentException("generation must be non-negative");
        }
        var entry = entries.computeIfAbsent(userId, ignored -> new Entry(generation));
        synchronized (entry) {
            if (generation < entry.generation) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "回归测试身份请求门代际已失效");
            }
            if (generation == entry.generation) {
                if (entry.closed) {
                    throw new ResponseStatusException(HttpStatus.CONFLICT, "回归测试身份请求门已终局关闭");
                }
                return snapshot(entry);
            }
            if (entry.activeCount != 0) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "回归测试身份尚有未排空请求");
            }
            entry.generation = generation;
            entry.closed = false;
            return snapshot(entry);
        }
    }

    public Snapshot closeAndDrain(UUID userId, long generation, Duration timeout) {
        Objects.requireNonNull(userId, "userId");
        Objects.requireNonNull(timeout, "timeout");
        if (generation < 0) {
            throw new IllegalArgumentException("generation must be non-negative");
        }
        if (timeout.isZero() || timeout.isNegative()) {
            throw new IllegalArgumentException("timeout must be positive");
        }
        var entry = entries.computeIfAbsent(userId, ignored -> new Entry(generation));
        var timeoutNanos = timeout.toNanos();
        var deadline = System.nanoTime() + timeoutNanos;
        synchronized (entry) {
            if (generation < entry.generation) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "回归测试身份请求门代际已失效");
            }
            if (generation > entry.generation) {
                if (entry.activeCount != 0) {
                    throw new ResponseStatusException(HttpStatus.CONFLICT, "回归测试身份尚有旧代际请求");
                }
                entry.generation = generation;
            }
            entry.closed = true;
            while (entry.activeCount != 0) {
                var remainingNanos = deadline - System.nanoTime();
                if (remainingNanos <= 0) {
                    throw new ResponseStatusException(
                        HttpStatus.GATEWAY_TIMEOUT,
                        "回归测试请求排空超时"
                    );
                }
                try {
                    TimeUnit.NANOSECONDS.timedWait(entry, remainingNanos);
                } catch (InterruptedException exception) {
                    Thread.currentThread().interrupt();
                    throw new ResponseStatusException(
                        HttpStatus.SERVICE_UNAVAILABLE,
                        "回归测试请求排空被中断",
                        exception
                    );
                }
            }
            return snapshot(entry);
        }
    }

    public Snapshot snapshot(UUID userId) {
        Objects.requireNonNull(userId, "userId");
        var entry = entries.get(userId);
        if (entry == null) {
            return new Snapshot(FenceState.OPEN, 0);
        }
        synchronized (entry) {
            return snapshot(entry);
        }
    }

    int trackedIdentityCount() {
        return entries.size();
    }

    private Snapshot snapshot(Entry entry) {
        return new Snapshot(entry.closed ? FenceState.CLOSED : FenceState.OPEN, entry.activeCount);
    }

    public interface Lease extends AutoCloseable {
        @Override
        void close();
    }

    public enum FenceState {
        OPEN,
        CLOSED
    }

    public record Snapshot(FenceState state, int activeCount) {
    }

    private static final class Entry {
        private long generation;
        private boolean closed;
        private int activeCount;

        private Entry(long generation) {
            this.generation = generation;
        }
    }

    private static final class RequestScope {
        private final List<Lease> leases = new ArrayList<>();
    }

    private static final class TrackedLease implements Lease {
        private final Entry entry;
        private final AtomicBoolean closed = new AtomicBoolean();

        private TrackedLease(Entry entry) {
            this.entry = entry;
        }

        @Override
        public void close() {
            if (!closed.compareAndSet(false, true)) {
                return;
            }
            synchronized (entry) {
                if (entry.activeCount <= 0) {
                    throw new IllegalStateException("regression request tracker count underflow");
                }
                entry.activeCount -= 1;
                if (entry.activeCount == 0) {
                    entry.notifyAll();
                }
            }
        }
    }
}
