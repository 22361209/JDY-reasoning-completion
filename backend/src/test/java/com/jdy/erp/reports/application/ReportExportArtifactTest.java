package com.jdy.erp.reports.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.file.Files;
import java.time.Clock;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ReportExportArtifactTest {
    @TempDir
    java.nio.file.Path directory;

    @Test
    void failedReleaseDoesNotMarkArtifactDeletedAndSecondAttemptCanSucceed() throws Exception {
        var attempts = new AtomicInteger();
        var manager = new ReportExportCleanupManager(
            directory,
            Clock.systemUTC(),
            Duration.ofHours(1),
            () -> "operator",
            candidate -> {
                if (attempts.incrementAndGet() == 1) {
                    throw new IOException("simulated first delete failure");
                }
                return Files.deleteIfExists(candidate);
            }
        );
        manager.afterPropertiesSet();
        var path = manager.createOwnedFile("fixture-report");
        var artifact = manager.completeArtifact("fixture-report", path, 0L, 0L, "keyword=false");

        assertThatThrownBy(() -> artifact.release("request-first"))
            .isInstanceOf(IOException.class)
            .hasMessage("report export cleanup deferred to manager")
            .hasNoCause();
        assertThat(artifact.isDeleted()).isFalse();
        assertThat(path).exists();

        artifact.release("request-second");

        assertThat(attempts).hasValue(2);
        assertThat(artifact.isDeleted()).isTrue();
        assertThat(path).doesNotExist();
    }
}
