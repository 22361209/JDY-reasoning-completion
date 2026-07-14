package com.jdy.erp.reports.application;

import java.nio.file.Path;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicBoolean;

/** Request-scoped, bounded CSV artifact that must be deleted by the controller. */
public final class ReportExportArtifact {
    private final String reportKey;
    private final Path path;
    private final long rowCount;
    private final long contentLength;
    private final String auditSummary;
    private final ReportExportCleanupManager cleanupManager;
    private final AtomicBoolean deleted = new AtomicBoolean();

    ReportExportArtifact(
        ReportExportCleanupManager cleanupManager,
        String reportKey,
        Path path,
        long rowCount,
        long contentLength,
        String auditSummary
    ) {
        this.cleanupManager = Objects.requireNonNull(cleanupManager, "report export cleanup manager must not be null");
        if (reportKey == null || reportKey.isBlank()) {
            throw new IllegalArgumentException("report export key must not be blank");
        }
        this.reportKey = reportKey;
        this.path = Objects.requireNonNull(path, "report export path must not be null").toAbsolutePath().normalize();
        if (rowCount < 0 || contentLength < 0) {
            throw new IllegalArgumentException("report export counts must not be negative");
        }
        this.rowCount = rowCount;
        this.contentLength = contentLength;
        this.auditSummary = auditSummary == null ? "" : auditSummary;
    }

    public String reportKey() {
        return reportKey;
    }

    public Path path() {
        return path;
    }

    public long rowCount() {
        return rowCount;
    }

    public long contentLength() {
        return contentLength;
    }

    public String auditSummary() {
        return auditSummary;
    }

    public boolean isDeleted() {
        return deleted.get();
    }

    public void release(String requestId) throws java.io.IOException {
        cleanupManager.release(this, requestId);
    }

    ReportExportCleanupManager cleanupManager() {
        return cleanupManager;
    }

    void markDeleted() {
        deleted.set(true);
    }
}
