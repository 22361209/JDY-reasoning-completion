package com.jdy.erp.reports.api;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.AccessDeniedException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import jakarta.servlet.ServletOutputStream;
import jakarta.servlet.WriteListener;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import com.jdy.erp.reports.application.ReportExportArtifact;
import com.jdy.erp.reports.application.ReportExportCleanupManager;
import com.jdy.erp.reports.application.ReportQueryResponse;
import com.jdy.erp.reports.application.ReportQueryService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.ArgumentCaptor;
import org.springframework.http.HttpStatus;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.server.ResponseStatusException;

class ReportQueryControllerTest {
    private final ReportQueryService service = mock(ReportQueryService.class);
    private final ReportQueryController controller = new ReportQueryController(service);
    private final org.springframework.test.web.servlet.MockMvc mockMvc = MockMvcBuilders
        .standaloneSetup(controller)
        .build();

    @TempDir
    Path testRoot;

    @Test
    void exposesDedicatedQueryEnvelopeAndForwardsAllRawParametersForStrictParsing() throws Exception {
        when(service.query(eq("fixture-report"), any())).thenReturn(new ReportQueryResponse(
            "fixture-report",
            1,
            50,
            1L,
            List.of(Map.of("billNo", "SO-1")),
            List.of(Map.of("currency", "USD", "amount", 10)),
            Map.of("page", 1, "pageSize", 50),
            Instant.parse("2026-07-14T02:00:00Z")
        ));

        mockMvc.perform(get("/api/reports/fixture-report")
                .queryParam("dateFrom", "2026-07-01")
                .queryParam("dateTo", "2026-07-14")
                .queryParam("pageSize", "50"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.reportKey").value("fixture-report"))
            .andExpect(jsonPath("$.page").value(1))
            .andExpect(jsonPath("$.pageSize").value(50))
            .andExpect(jsonPath("$.total").value(1))
            .andExpect(jsonPath("$.rows[0].billNo").value("SO-1"))
            .andExpect(jsonPath("$.totals[0].currency").value("USD"))
            .andExpect(jsonPath("$.generatedAt").value("2026-07-14T02:00:00Z"));

        @SuppressWarnings("unchecked")
        var parameters = ArgumentCaptor.forClass(Map.class);
        verify(service).query(eq("fixture-report"), parameters.capture());
        org.assertj.core.api.Assertions.assertThat(parameters.getValue())
            .containsEntry("dateFrom", List.of("2026-07-01"))
            .containsEntry("dateTo", List.of("2026-07-14"))
            .containsEntry("pageSize", List.of("50"));
    }

    @Test
    void responseRecursivelySerializesBigDecimalAsPlainStringsWithoutJsPrecisionLoss() throws Exception {
        var response = new ReportQueryResponse(
            "fixture-report",
            2,
            50,
            9_007_199_254_740_993L,
            List.of(Map.of(
                "largeAmount", new BigDecimal("9007199254740993.00"),
                "fraction", new BigDecimal("0.1000"),
                "nested", List.of(Map.of("zero", new BigDecimal("0E-20"))),
                "nullableList", java.util.Arrays.asList(new BigDecimal("2.00"), null),
                "nullableArray", new Object[] { new BigDecimal("3.00"), null }
            )),
            List.of(Map.of("amount", new BigDecimal("12345678901234567890.1200"))),
            Map.of(
                "page", 2,
                "decimalFilter", new BigDecimal("1000.5000"),
                "nested", Map.of("thresholds", new BigDecimal[] {
                    new BigDecimal("0.0100"),
                    new BigDecimal("0.000")
                })
            ),
            Instant.parse("2026-07-14T02:00:00Z")
        );
        org.assertj.core.api.Assertions.assertThat(new java.util.ArrayList<Object>(
            (List<?>) response.rows().getFirst().get("nullableList")
        ))
            .containsExactly("2", null);
        org.assertj.core.api.Assertions.assertThat(new java.util.ArrayList<Object>(
            (List<?>) response.rows().getFirst().get("nullableArray")
        ))
            .containsExactly("3", null);
        when(service.query(eq("fixture-report"), any())).thenReturn(response);

        mockMvc.perform(get("/api/reports/fixture-report"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.page").value(2))
            .andExpect(jsonPath("$.pageSize").value(50))
            .andExpect(jsonPath("$.total").value(9_007_199_254_740_993L))
            .andExpect(jsonPath("$.rows[0].largeAmount").value("9007199254740993"))
            .andExpect(jsonPath("$.rows[0].fraction").value("0.1"))
            .andExpect(jsonPath("$.rows[0].nested[0].zero").value("0"))
            .andExpect(jsonPath("$.totals[0].amount").value("12345678901234567890.12"))
            .andExpect(jsonPath("$.query.decimalFilter").value("1000.5"))
            .andExpect(jsonPath("$.query.nested.thresholds[0]").value("0.01"))
            .andExpect(jsonPath("$.query.nested.thresholds[1]").value("0"))
            .andExpect(content().string(org.hamcrest.Matchers.not(
                org.hamcrest.Matchers.containsString("9.007199254740993E15")
            )));
    }

    @Test
    void exportTransfersUtf8CsvWithSafeAttachmentNameThenAuditsAndDeletesArtifact() throws Exception {
        var bytes = "\ufeff单号\r\n\"\t001\"\r\n".getBytes(StandardCharsets.UTF_8);
        var artifact = managedArtifact(bytes, 1L, "dateFrom=2026-07-01");
        var path = artifact.path();
        when(service.prepareExport(eq("fixture-report"), any())).thenReturn(artifact);

        mockMvc.perform(get("/api/reports/fixture-report/export.csv")
                .queryParam("dateFrom", "2026-07-01")
                .queryParam("dateTo", "2026-07-14"))
            .andExpect(status().isOk())
            .andExpect(header().string("Content-Type", "text/csv;charset=UTF-8"))
            .andExpect(header().string("Content-Length", String.valueOf(bytes.length)))
            .andExpect(header().string("Content-Disposition", org.hamcrest.Matchers.containsString("fixture-report-export.csv")))
            .andExpect(content().bytes(bytes));

        verify(service).recordSuccessfulExport(artifact);
        org.assertj.core.api.Assertions.assertThat(path).doesNotExist();
        org.assertj.core.api.Assertions.assertThat(artifact.isDeleted()).isTrue();
    }

    @Test
    void exportFlushesResponseBeforeSuccessAuditAndDeletesExactArtifact() throws Exception {
        var bytes = "\ufeff单号\r\n".getBytes(StandardCharsets.UTF_8);
        var artifact = managedArtifact(bytes, 0L, "keyword=false");
        var path = artifact.path();
        var response = mock(HttpServletResponse.class);
        var destination = new ByteArrayOutputStream();
        when(response.getOutputStream()).thenReturn(servletOutputStream(destination, false));
        when(service.prepareExport(eq("fixture-report"), any())).thenReturn(artifact);

        controller.export("fixture-report", new LinkedMultiValueMap<>(), request("request-order"), response);

        org.assertj.core.api.Assertions.assertThat(destination.toByteArray()).isEqualTo(bytes);
        var order = inOrder(response, service);
        order.verify(response).flushBuffer();
        order.verify(service).recordSuccessfulExport(artifact);
        org.assertj.core.api.Assertions.assertThat(path).doesNotExist();
    }

    @Test
    void clientWriteFailureCreatesNoSuccessAuditAndLeavesNoTempResidue() throws Exception {
        var bytes = "\ufeff单号\r\nSO-1\r\n".getBytes(StandardCharsets.UTF_8);
        var artifact = managedArtifact(bytes, 1L, "keyword=false");
        var path = artifact.path();
        var response = mock(HttpServletResponse.class);
        when(response.getOutputStream()).thenReturn(servletOutputStream(new ByteArrayOutputStream(), true));
        when(response.isCommitted()).thenReturn(true);
        when(service.prepareExport(eq("fixture-report"), any())).thenReturn(artifact);

        org.assertj.core.api.Assertions.assertThatThrownBy(
            () -> controller.export(
                "fixture-report", new LinkedMultiValueMap<>(), request("request-client-failure"), response
            )
        ).isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> {
                var failure = (ResponseStatusException) error;
                org.assertj.core.api.Assertions.assertThat(failure.getReason())
                    .isEqualTo("报表引出响应失败，请重试")
                    .doesNotContain(path.toString());
                org.assertj.core.api.Assertions.assertThat(failure.getCause()).isInstanceOf(IOException.class);
            });

        verify(service, never()).recordSuccessfulExport(any());
        verify(service).recordTransferFailure(artifact, "request-client-failure", true);
        org.assertj.core.api.Assertions.assertThat(path).doesNotExist();
        org.assertj.core.api.Assertions.assertThat(artifact.isDeleted()).isTrue();
    }

    @Test
    void auditFailureAfterFlushOnlySignalsOneOperationalErrorAndStillDeletesExactArtifact() throws Exception {
        var bytes = "\ufeff单号\r\n".getBytes(StandardCharsets.UTF_8);
        var artifact = managedArtifact(bytes, 0L, "keyword=false");
        var path = artifact.path();
        var response = mock(HttpServletResponse.class);
        var destination = new ByteArrayOutputStream();
        when(response.getOutputStream()).thenReturn(servletOutputStream(destination, false));
        when(response.isCommitted()).thenReturn(true);
        when(service.prepareExport(eq("fixture-report"), any())).thenReturn(artifact);
        doThrow(new IllegalStateException("simulated audit failure"))
            .when(service).recordSuccessfulExport(artifact);
        controller.export(
            "fixture-report", new LinkedMultiValueMap<>(), request("request-audit-145"), response
        );

        var order = inOrder(response, service);
        order.verify(response).flushBuffer();
        order.verify(service).recordSuccessfulExport(artifact);
        order.verify(service).recordPostFlushAuditFailure(artifact, "request-audit-145", true);
        org.assertj.core.api.Assertions.assertThat(destination.toByteArray()).isEqualTo(bytes);
        org.assertj.core.api.Assertions.assertThat(path).doesNotExist();
        org.assertj.core.api.Assertions.assertThat(artifact.isDeleted()).isTrue();
    }

    @Test
    void responseHeaderFailureBeforeTransferStillDeletesArtifactWithoutAudit() throws Exception {
        var bytes = "\ufeff单号\r\n".getBytes(StandardCharsets.UTF_8);
        var artifact = managedArtifact(bytes, 0L, "keyword=false");
        var path = artifact.path();
        var response = mock(HttpServletResponse.class);
        when(service.prepareExport(eq("fixture-report"), any())).thenReturn(artifact);
        doThrow(new IllegalStateException("simulated response failure"))
            .when(response).setHeader(eq("Content-Disposition"), any());

        org.assertj.core.api.Assertions.assertThatThrownBy(
            () -> controller.export(
                "fixture-report", new LinkedMultiValueMap<>(), request("request-header-failure"), response
            )
        ).isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("response failure");

        verify(service, never()).recordSuccessfulExport(any());
        org.assertj.core.api.Assertions.assertThat(path).doesNotExist();
        org.assertj.core.api.Assertions.assertThat(artifact.isDeleted()).isTrue();
    }

    @Test
    void missingArtifactUsesSafeUncommittedErrorWithoutLeakingAbsolutePath() throws Exception {
        var artifact = managedArtifact(new byte[0], 0L, "keyword=false");
        var path = artifact.path();
        Files.delete(path);
        var response = mock(HttpServletResponse.class);
        when(response.getOutputStream()).thenReturn(servletOutputStream(new ByteArrayOutputStream(), false));
        when(response.isCommitted()).thenReturn(false);
        when(service.prepareExport(eq("fixture-report"), any())).thenReturn(artifact);

        org.assertj.core.api.Assertions.assertThatThrownBy(() -> controller.export(
            "fixture-report", new LinkedMultiValueMap<>(), request("request-missing"), response
        )).isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertSafeTransferFailure((ResponseStatusException) error, path.toString(), NoSuchFileException.class));

        verify(service, never()).recordSuccessfulExport(any());
        org.assertj.core.api.Assertions.assertThat(artifact.isDeleted()).isTrue();
    }

    @Test
    void accessDeniedUsesSafeUncommittedErrorAndStillDeletesArtifact() throws Exception {
        var artifact = managedArtifact(new byte[0], 0L, "keyword=false");
        var path = artifact.path();
        var deniedController = new ReportQueryController(service, (source, destination) -> {
            throw new AccessDeniedException(source.toString());
        });
        var response = mock(HttpServletResponse.class);
        when(response.getOutputStream()).thenReturn(servletOutputStream(new ByteArrayOutputStream(), false));
        when(response.isCommitted()).thenReturn(false);
        when(service.prepareExport(eq("fixture-report"), any())).thenReturn(artifact);

        org.assertj.core.api.Assertions.assertThatThrownBy(() -> deniedController.export(
            "fixture-report", new LinkedMultiValueMap<>(), request("request-denied"), response
        )).isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertSafeTransferFailure((ResponseStatusException) error, path.toString(), AccessDeniedException.class));

        verify(service, never()).recordSuccessfulExport(any());
        org.assertj.core.api.Assertions.assertThat(path).doesNotExist();
        org.assertj.core.api.Assertions.assertThat(artifact.isDeleted()).isTrue();
    }

    @Test
    void shortFileCopyFailsBeforeFlushOrAuditAndDeletesArtifact() throws Exception {
        var bytes = "\ufeff单号\r\nSO-1\r\n".getBytes(StandardCharsets.UTF_8);
        var artifact = managedArtifact(bytes, 1L, "keyword=false");
        var path = artifact.path();
        var shortCopyController = new ReportQueryController(service, (source, destination) -> {
            destination.write(bytes, 0, bytes.length - 1);
            return bytes.length - 1L;
        });
        var response = mock(HttpServletResponse.class);
        when(response.getOutputStream()).thenReturn(servletOutputStream(new ByteArrayOutputStream(), false));
        when(response.isCommitted()).thenReturn(false);
        when(service.prepareExport(eq("fixture-report"), any())).thenReturn(artifact);

        org.assertj.core.api.Assertions.assertThatThrownBy(() -> shortCopyController.export(
            "fixture-report", new LinkedMultiValueMap<>(), request("request-short-copy"), response
        )).isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> {
                var failure = (ResponseStatusException) error;
                org.assertj.core.api.Assertions.assertThat(failure.getReason())
                    .isEqualTo("报表引出响应失败，请重试");
                org.assertj.core.api.Assertions.assertThat(failure.getCause())
                    .isInstanceOf(IOException.class)
                    .hasMessage("report export transfer length mismatch");
            });

        verify(response, never()).flushBuffer();
        verify(service, never()).recordSuccessfulExport(any());
        verify(service).recordTransferFailure(artifact, "request-short-copy", false);
        org.assertj.core.api.Assertions.assertThat(path).doesNotExist();
    }

    @Test
    void cleanupFailureAfterCommittedTransferRemainsManagerOwnedWithoutFalseHttpFailure() throws Exception {
        var cleanupManager = cleanupManager(path -> {
            throw new IOException("raw cleanup failure " + path);
        });
        var artifact = managedArtifact(cleanupManager, new byte[0], 0L, "keyword=false");
        var noOpTransferController = new ReportQueryController(service, (source, destination) -> 0L);
        var response = mock(HttpServletResponse.class);
        when(response.getOutputStream()).thenReturn(servletOutputStream(new ByteArrayOutputStream(), false));
        when(response.isCommitted()).thenReturn(true);
        when(service.prepareExport(eq("fixture-report"), any())).thenReturn(artifact);

        noOpTransferController.export(
            "fixture-report", new LinkedMultiValueMap<>(), request("request-cleanup"), response
        );

        verify(service).recordSuccessfulExport(artifact);
        org.assertj.core.api.Assertions.assertThat(artifact.isDeleted()).isFalse();
        org.assertj.core.api.Assertions.assertThat(artifact.path()).exists();
    }

    @Test
    void unknownReportUsesServiceFailClosed404ForQueryAndExport() throws Exception {
        when(service.query(eq("unknown-report"), any()))
            .thenThrow(new ResponseStatusException(HttpStatus.NOT_FOUND, "报表不存在"));
        when(service.prepareExport(eq("unknown-report"), any()))
            .thenThrow(new ResponseStatusException(HttpStatus.NOT_FOUND, "报表不存在"));

        mockMvc.perform(get("/api/reports/unknown-report"))
            .andExpect(status().isNotFound());
        mockMvc.perform(get("/api/reports/unknown-report/export.csv"))
            .andExpect(status().isNotFound());
    }

    private ReportExportArtifact managedArtifact(byte[] bytes, long rowCount, String auditSummary) throws Exception {
        return managedArtifact(cleanupManager(Files::deleteIfExists), bytes, rowCount, auditSummary);
    }

    private ReportExportArtifact managedArtifact(
        ReportExportCleanupManager cleanupManager,
        byte[] bytes,
        long rowCount,
        String auditSummary
    ) throws Exception {
        var path = cleanupManager.createOwnedFile("fixture-report");
        Files.write(path, bytes);
        return cleanupManager.completeArtifact(
            "fixture-report",
            path,
            rowCount,
            bytes.length,
            auditSummary
        );
    }

    private ReportExportCleanupManager cleanupManager(ReportExportCleanupManager.FileDeleter deleter) {
        var manager = new ReportExportCleanupManager(
            testRoot.resolve(UUID.randomUUID().toString()),
            Clock.systemUTC(),
            Duration.ofHours(1),
            () -> "operator",
            deleter
        );
        manager.afterPropertiesSet();
        return manager;
    }

    private ServletOutputStream servletOutputStream(ByteArrayOutputStream destination, boolean fail) {
        return new ServletOutputStream() {
            @Override
            public boolean isReady() {
                return true;
            }

            @Override
            public void setWriteListener(WriteListener writeListener) {
                // Synchronous controller path only.
            }

            @Override
            public void write(int value) throws IOException {
                if (fail) {
                    throw new IOException("simulated client disconnect");
                }
                destination.write(value);
            }

            @Override
            public void write(byte[] bytes, int offset, int length) throws IOException {
                if (fail) {
                    throw new IOException("simulated client disconnect");
                }
                destination.write(bytes, offset, length);
            }
        };
    }

    private HttpServletRequest request(String requestId) {
        var request = mock(HttpServletRequest.class);
        when(request.getRequestId()).thenReturn(requestId);
        return request;
    }

    private void assertSafeTransferFailure(
        ResponseStatusException failure,
        String absolutePath,
        Class<? extends IOException> causeType
    ) {
        org.assertj.core.api.Assertions.assertThat(failure.getStatusCode())
            .isEqualTo(HttpStatus.INTERNAL_SERVER_ERROR);
        org.assertj.core.api.Assertions.assertThat(failure.getReason())
            .isEqualTo("报表引出响应失败，请重试")
            .doesNotContain(absolutePath);
        org.assertj.core.api.Assertions.assertThat(failure.getMessage()).doesNotContain(absolutePath);
        org.assertj.core.api.Assertions.assertThat(failure.getCause()).isInstanceOf(causeType);
    }
}
