package com.jdy.erp.reports.application;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;

import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantContext;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Single owner for every report-export file from creation until deletion.
 *
 * <p>The dedicated directory is the durable responsibility source. In-memory
 * state distinguishes this process's active transfers from files already
 * pending deletion. Directory scans only adopt files older than the maximum
 * reasonable request lifetime, so another process's live transfer is never
 * deleted merely because it is not present in this process's memory.</p>
 */
@Component
public final class ReportExportCleanupManager implements InitializingBean, DisposableBean {
    static final Duration DEFAULT_STALE_GRACE = Duration.ofHours(2);
    private static final Logger LOGGER = LoggerFactory.getLogger(ReportExportCleanupManager.class);
    private static final String FILE_PREFIX = "export-";
    private static final String FILE_SUFFIX = ".csv";

    private final Path directory;
    private final Clock clock;
    private final Duration staleGrace;
    private final Supplier<String> actorSupplier;
    private final FileDeleter fileDeleter;
    private final Set<Path> activePaths = ConcurrentHashMap.newKeySet();
    private final Set<Path> pendingPaths = ConcurrentHashMap.newKeySet();
    private final Map<Path, CleanupContext> contexts = new ConcurrentHashMap<>();
    private final Map<Path, ReportExportArtifact> artifacts = new ConcurrentHashMap<>();
    private final Map<Path, Integer> attempts = new ConcurrentHashMap<>();
    private final AtomicBoolean initialized = new AtomicBoolean();

    @Autowired
    public ReportExportCleanupManager(CurrentSessionService currentSessionService) {
        this(
            Path.of(System.getProperty("java.io.tmpdir"), "jdy-report-exports"),
            Clock.systemUTC(),
            DEFAULT_STALE_GRACE,
            currentSessionService::optionalCurrentUsername,
            Files::deleteIfExists
        );
    }

    public ReportExportCleanupManager(
        Path directory,
        Clock clock,
        Duration staleGrace,
        Supplier<String> actorSupplier,
        FileDeleter fileDeleter
    ) {
        this.directory = directory.toAbsolutePath().normalize();
        this.clock = clock;
        this.staleGrace = staleGrace;
        this.actorSupplier = actorSupplier;
        this.fileDeleter = fileDeleter;
        if (staleGrace.isNegative() || staleGrace.isZero()) {
            throw new IllegalArgumentException("report export stale grace must be positive");
        }
    }

    @Override
    public void afterPropertiesSet() {
        ensureInitialized();
    }

    public Path createOwnedFile(String reportKey) throws IOException {
        ensureInitialized();
        for (var attempt = 0; attempt < 4; attempt++) {
            var candidate = directory.resolve(
                FILE_PREFIX + UUID.randomUUID().toString().replace("-", "") + FILE_SUFFIX
            );
            try {
                var created = Files.createFile(candidate);
                activePaths.add(created);
                contexts.put(created, operationalContext(reportKey, "generation"));
                return created;
            } catch (java.nio.file.FileAlreadyExistsException collision) {
                // A UUID collision is harmless; retry with a new ownership name.
            } catch (IOException creationFailure) {
                throw safeCleanupException();
            }
        }
        throw safeCleanupException();
    }

    public ReportExportArtifact completeArtifact(
        String reportKey,
        Path path,
        long rowCount,
        long contentLength,
        String auditSummary
    ) {
        var ownedPath = requireOwnedPath(path);
        if (!activePaths.contains(ownedPath) || pendingPaths.contains(ownedPath)) {
            throw new IllegalStateException("report export file is not active");
        }
        var artifact = new ReportExportArtifact(
            this,
            reportKey,
            ownedPath,
            rowCount,
            contentLength,
            auditSummary
        );
        artifacts.put(ownedPath, artifact);
        contexts.put(ownedPath, operationalContext(reportKey, "generation"));
        return artifact;
    }

    public void abandonGeneration(Path path, String reportKey) throws IOException {
        var ownedPath = requireOwnedPath(path);
        contexts.put(ownedPath, operationalContext(reportKey, "generation"));
        handOffAndDelete(ownedPath);
    }

    void release(ReportExportArtifact artifact, String requestId) throws IOException {
        if (artifact == null || artifact.isDeleted()) {
            return;
        }
        if (artifact.cleanupManager() != this) {
            throw new IllegalArgumentException("report export cleanup owner mismatch");
        }
        var ownedPath = requireOwnedPath(artifact.path());
        artifacts.putIfAbsent(ownedPath, artifact);
        contexts.put(ownedPath, operationalContext(artifact.reportKey(), requestId));
        handOffAndDelete(ownedPath);
    }

    @Scheduled(fixedDelayString = "${jdy.report-export.cleanup-interval-ms:30000}")
    public void periodicSweep() {
        if (!initialized.get()) {
            return;
        }
        sweepPending("periodic");
        adoptAndSweepStale("periodic");
    }

    @Override
    public void destroy() {
        if (!initialized.get()) {
            return;
        }
        // Active files may still be in a graceful-shutdown request. Only files
        // already handed off as pending are exact-owned cleanup candidates here.
        sweepPending("shutdown");
        adoptAndSweepStale("shutdown");
    }

    Path directory() {
        return directory;
    }

    int activeCount() {
        return activePaths.size();
    }

    int pendingCount() {
        return pendingPaths.size();
    }

    private void ensureInitialized() {
        if (!initialized.compareAndSet(false, true)) {
            return;
        }
        try {
            Files.createDirectories(directory);
        } catch (IOException directoryFailure) {
            initialized.set(false);
            throw new IllegalStateException("report export temp directory unavailable");
        }
        adoptAndSweepStale("startup");
    }

    private void handOffAndDelete(Path path) throws IOException {
        activePaths.remove(path);
        pendingPaths.add(path);
        if (!tryDelete(path, "immediate")) {
            throw safeCleanupException();
        }
    }

    private void sweepPending(String lifecycle) {
        for (var path : Set.copyOf(pendingPaths)) {
            tryDelete(path, lifecycle);
        }
    }

    private void adoptAndSweepStale(String lifecycle) {
        final Set<Path> candidates = new HashSet<>();
        try (var paths = Files.list(directory)) {
            paths.map(Path::toAbsolutePath).map(Path::normalize).forEach(candidates::add);
        } catch (IOException scanFailure) {
            logFailure("ARTIFACT_DIRECTORY_SCAN_IO_FAILURE", null, lifecycle, 0);
            return;
        }
        for (var path : candidates) {
            if (activePaths.contains(path) || pendingPaths.contains(path) || !isManagedFile(path)) {
                continue;
            }
            if (isStale(path, lifecycle)) {
                contexts.putIfAbsent(path, CleanupContext.unavailable());
                pendingPaths.add(path);
                tryDelete(path, lifecycle);
            }
        }
    }

    private boolean isStale(Path path, String lifecycle) {
        try {
            var modifiedAt = Files.getLastModifiedTime(path).toInstant();
            return !modifiedAt.isAfter(Instant.now(clock).minus(staleGrace));
        } catch (IOException metadataFailure) {
            logFailure("ARTIFACT_METADATA_IO_FAILURE", path, lifecycle, 0);
            return false;
        }
    }

    private boolean tryDelete(Path path, String lifecycle) {
        var attempt = attempts.merge(path, 1, Integer::sum);
        try {
            fileDeleter.deleteIfExists(path);
            var context = contexts.getOrDefault(path, CleanupContext.unavailable());
            if (attempt > 1) {
                logSuccess(context, lifecycle, attempt);
            }
            completeOwnership(path);
            return true;
        } catch (IOException | RuntimeException deletionFailure) {
            pendingPaths.add(path);
            logFailure("ARTIFACT_DELETE_IO_FAILURE", path, lifecycle, attempt);
            return false;
        }
    }

    private void completeOwnership(Path path) {
        activePaths.remove(path);
        pendingPaths.remove(path);
        attempts.remove(path);
        contexts.remove(path);
        var artifact = artifacts.remove(path);
        if (artifact != null) {
            artifact.markDeleted();
        }
    }

    private Path requireOwnedPath(Path path) {
        if (path == null) {
            throw new IllegalArgumentException("report export path must not be null");
        }
        var normalized = path.toAbsolutePath().normalize();
        if (!directory.equals(normalized.getParent()) || !isManagedFile(normalized)) {
            throw new IllegalArgumentException("report export path is outside the managed directory");
        }
        return normalized;
    }

    private boolean isManagedFile(Path path) {
        var parent = path.getParent();
        var name = path.getFileName() == null ? "" : path.getFileName().toString();
        return directory.equals(parent)
            && name.matches("export-[a-f0-9]{32}\\.csv");
    }

    private void logFailure(String category, Path path, String lifecycle, int attempt) {
        var context = path == null ? CleanupContext.unavailable() : contexts.getOrDefault(
            path,
            CleanupContext.unavailable()
        );
        LOGGER.warn(
            "report_export_cleanup_failed errorCategory={} tenantId={} actor={} reportKey={} "
                + "requestId={} lifecycle={} attempt={} retained={}",
            category,
            context.tenantId(),
            context.actor(),
            context.reportKey(),
            context.requestId(),
            safeToken(lifecycle, 32),
            attempt,
            path != null && pendingPaths.contains(path)
        );
    }

    private void logSuccess(CleanupContext context, String lifecycle, int attempt) {
        LOGGER.info(
            "report_export_cleanup_succeeded errorCategory=NONE tenantId={} actor={} reportKey={} "
                + "requestId={} lifecycle={} attempt={}",
            context.tenantId(),
            context.actor(),
            context.reportKey(),
            context.requestId(),
            safeToken(lifecycle, 32),
            attempt
        );
    }

    private CleanupContext operationalContext(String reportKey, String requestId) {
        var tenantId = TenantContext.current()
            .filter(TenantContext.Snapshot::isTenant)
            .map(TenantContext.Snapshot::accountSetId)
            .filter(this::isCanonicalUuid)
            .orElse("unavailable");
        String actor;
        try {
            actor = actorSupplier.get();
        } catch (RuntimeException actorFailure) {
            actor = null;
        }
        return new CleanupContext(
            tenantId,
            safeToken(actor, 80),
            safeToken(reportKey, 64),
            safeToken(requestId, 128)
        );
    }

    private boolean isCanonicalUuid(String value) {
        if (value == null) {
            return false;
        }
        try {
            return UUID.fromString(value).toString().equalsIgnoreCase(value);
        } catch (IllegalArgumentException invalidUuid) {
            return false;
        }
    }

    private String safeToken(String value, int maximumLength) {
        if (value == null || value.isBlank()) {
            return "unavailable";
        }
        var filtered = value.replaceAll("[^A-Za-z0-9._@:-]", "");
        if (filtered.isEmpty()) {
            return "unavailable";
        }
        return filtered.substring(0, Math.min(maximumLength, filtered.length()));
    }

    private IOException safeCleanupException() {
        return new IOException("report export cleanup deferred to manager");
    }

    private record CleanupContext(String tenantId, String actor, String reportKey, String requestId) {
        private static CleanupContext unavailable() {
            return new CleanupContext("unavailable", "unavailable", "unavailable", "unavailable");
        }
    }

    @FunctionalInterface
    public interface FileDeleter {
        boolean deleteIfExists(Path path) throws IOException;
    }
}
