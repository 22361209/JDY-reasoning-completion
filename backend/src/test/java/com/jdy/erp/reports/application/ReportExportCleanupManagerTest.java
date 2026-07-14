package com.jdy.erp.reports.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.attribute.FileTime;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.jdy.erp.system.tenant.TenantContext;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.slf4j.LoggerFactory;

class ReportExportCleanupManagerTest {
    private static final Instant NOW = Instant.parse("2026-07-14T04:00:00Z");
    private static final Duration GRACE = Duration.ofMinutes(30);

    @TempDir
    java.nio.file.Path directory;

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    @Test
    void periodicSweepNeverDeletesThisProcessActiveArtifactEvenWhenItsTimestampIsOld() throws Exception {
        var manager = manager(Files::deleteIfExists);
        manager.afterPropertiesSet();
        var path = manager.createOwnedFile("fixture-report");
        Files.setLastModifiedTime(path, FileTime.from(NOW.minus(GRACE).minusSeconds(1)));

        manager.periodicSweep();

        assertThat(path).exists();
        assertThat(manager.activeCount()).isEqualTo(1);
        assertThat(manager.pendingCount()).isZero();
    }

    @Test
    void startupDeletesOnlyStaleOrphanAndKeepsAnotherInstanceFreshArtifact() throws Exception {
        Files.createDirectories(directory);
        var stale = directory.resolve("export-00000000000000000000000000000145.csv");
        var fresh = directory.resolve("export-00000000000000000000000000000146.csv");
        Files.writeString(stale, "stale");
        Files.writeString(fresh, "fresh");
        Files.setLastModifiedTime(stale, FileTime.from(NOW.minus(GRACE).minusSeconds(1)));
        Files.setLastModifiedTime(fresh, FileTime.from(NOW.minus(GRACE).plusSeconds(1)));

        var manager = manager(Files::deleteIfExists);
        manager.afterPropertiesSet();

        assertThat(stale).doesNotExist();
        assertThat(fresh).exists();
        assertThat(manager.activeCount()).isZero();
        assertThat(manager.pendingCount()).isZero();
    }

    @Test
    void generationFailureHandsOffToManagerAndPeriodicSweepKeepsResponsibilityUntilDeleteSucceeds()
        throws Exception {
        var attempts = new AtomicInteger();
        var manager = manager(path -> {
            if (attempts.incrementAndGet() == 1) {
                throw new IOException("raw /secret/path tenant_a SELECT failure");
            }
            return Files.deleteIfExists(path);
        });
        manager.afterPropertiesSet();
        var path = manager.createOwnedFile("fixture-report");

        assertThatThrownBy(() -> manager.abandonGeneration(path, "fixture-report"))
            .isInstanceOf(IOException.class)
            .hasMessage("report export cleanup deferred to manager")
            .hasNoCause();
        assertThat(path).exists();
        assertThat(manager.activeCount()).isZero();
        assertThat(manager.pendingCount()).isEqualTo(1);

        manager.periodicSweep();

        assertThat(path).doesNotExist();
        assertThat(manager.pendingCount()).isZero();
        assertThat(attempts).hasValue(2);
    }

    @Test
    void shutdownRetriesOwnPendingArtifactWithoutDeletingUnreleasedActiveArtifact() throws Exception {
        var attempts = new AtomicInteger();
        var manager = manager(path -> {
            if (attempts.incrementAndGet() == 1) {
                throw new IOException("first failure");
            }
            return Files.deleteIfExists(path);
        });
        manager.afterPropertiesSet();
        var pendingPath = manager.createOwnedFile("fixture-report");
        var pendingArtifact = manager.completeArtifact("fixture-report", pendingPath, 0L, 0L, "keyword=false");
        assertThatThrownBy(() -> pendingArtifact.release("request-pending"))
            .isInstanceOf(IOException.class);
        var activePath = manager.createOwnedFile("fixture-report");

        manager.destroy();

        assertThat(pendingPath).doesNotExist();
        assertThat(pendingArtifact.isDeleted()).isTrue();
        assertThat(activePath).exists();
        assertThat(manager.activeCount()).isEqualTo(1);
        assertThat(manager.pendingCount()).isZero();
    }

    @Test
    void cleanupFailureLogContainsOnlyBoundedIdentityAndSafeCategory() throws Exception {
        var rawPathMarker = "secret-path-tenant_a-SELECT";
        TenantContext.setTenant(Map.of(
            "id", "00000000-0000-0000-0000-000000000145",
            "code", "A145",
            "name", "A145",
            "databaseName", "jdy_erp",
            "schemaName", "tenant_a"
        ));
        var logger = (ch.qos.logback.classic.Logger) LoggerFactory.getLogger(ReportExportCleanupManager.class);
        var appender = new ListAppender<ILoggingEvent>();
        appender.start();
        logger.addAppender(appender);
        var manager = new ReportExportCleanupManager(
            directory,
            Clock.fixed(NOW, ZoneOffset.UTC),
            GRACE,
            () -> "actor/../../" + "x".repeat(200),
            path -> {
                throw new IOException(rawPathMarker + " " + path);
            }
        );
        manager.afterPropertiesSet();
        var path = manager.createOwnedFile("fixture-report");

        try {
            assertThatThrownBy(() -> manager.abandonGeneration(path, "fixture-report"))
                .isInstanceOf(IOException.class)
                .hasNoCause();

            var messages = appender.list.stream().map(ILoggingEvent::getFormattedMessage).toList();
            assertThat(messages).singleElement().satisfies(message -> assertThat(message)
                .contains(
                    "errorCategory=ARTIFACT_DELETE_IO_FAILURE",
                    "tenantId=00000000-0000-0000-0000-000000000145",
                    "actor=actor.." ,
                    "reportKey=fixture-report",
                    "retained=true"
                )
                .doesNotContain(rawPathMarker, path.toString(), "tenant_a", "SELECT", "secret"));
        } finally {
            logger.detachAppender(appender);
        }
    }

    private ReportExportCleanupManager manager(ReportExportCleanupManager.FileDeleter deleter) {
        return new ReportExportCleanupManager(
            directory,
            Clock.fixed(NOW, ZoneOffset.UTC),
            GRACE,
            () -> "operator",
            deleter
        );
    }
}
