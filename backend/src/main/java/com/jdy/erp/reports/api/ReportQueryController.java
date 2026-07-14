package com.jdy.erp.reports.api;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.charset.StandardCharsets;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import com.jdy.erp.reports.application.ReportExportArtifact;
import com.jdy.erp.reports.application.ReportQueryResponse;
import com.jdy.erp.reports.application.ReportQueryService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/reports")
public final class ReportQueryController {
    private static final MediaType CSV_UTF_8 = new MediaType("text", "csv", StandardCharsets.UTF_8);

    private final ReportQueryService reportQueryService;
    private final FileTransfer fileTransfer;

    @Autowired
    public ReportQueryController(ReportQueryService reportQueryService) {
        this(reportQueryService, Files::copy);
    }

    ReportQueryController(ReportQueryService reportQueryService, FileTransfer fileTransfer) {
        this.reportQueryService = reportQueryService;
        this.fileTransfer = fileTransfer;
    }

    @GetMapping("/{reportKey}")
    public ReportQueryResponse query(
        @PathVariable String reportKey,
        @RequestParam MultiValueMap<String, String> parameters
    ) {
        return reportQueryService.query(reportKey, parameters);
    }

    @GetMapping(value = "/{reportKey}/export.csv", produces = "text/csv;charset=UTF-8")
    public void export(
        @PathVariable String reportKey,
        @RequestParam MultiValueMap<String, String> parameters,
        HttpServletRequest request,
        HttpServletResponse response
    ) {
        var artifact = reportQueryService.prepareExport(reportKey, parameters);
        transferAndAudit(artifact, request, response);
    }

    private void transferAndAudit(
        ReportExportArtifact artifact,
        HttpServletRequest request,
        HttpServletResponse response
    ) {
        Throwable failure = null;
        try {
            var disposition = ContentDisposition.attachment()
                .filename(artifact.reportKey() + "-export.csv", StandardCharsets.UTF_8)
                .build();
            response.setHeader(HttpHeaders.CONTENT_DISPOSITION, disposition.toString());
            response.setContentType(CSV_UTF_8.toString());
            response.setCharacterEncoding(StandardCharsets.UTF_8.name());
            response.setContentLengthLong(artifact.contentLength());
            var transferredBytes = fileTransfer.copy(artifact.path(), response.getOutputStream());
            if (transferredBytes != artifact.contentLength()) {
                throw new IOException("report export transfer length mismatch");
            }
            response.flushBuffer();
            try {
                reportQueryService.recordSuccessfulExport(artifact);
            } catch (RuntimeException exception) {
                // The CSV response is already committed. This structured ERROR is the
                // first operational compensation signal; an HTTP failure can no longer
                // be delivered truthfully to the client at this point.
                reportQueryService.recordPostFlushAuditFailure(
                    artifact,
                    requestId(request),
                    response.isCommitted()
                );
            }
        } catch (IOException exception) {
            var safeFailure = new ResponseStatusException(
                HttpStatus.INTERNAL_SERVER_ERROR,
                "报表引出响应失败，请重试",
                exception
            );
            failure = safeFailure;
            reportQueryService.recordTransferFailure(
                artifact,
                requestId(request),
                response.isCommitted()
            );
            throw safeFailure;
        } catch (RuntimeException | Error exception) {
            failure = exception;
            throw exception;
        } finally {
            try {
                artifact.release(requestId(request));
            } catch (IOException cleanupFailure) {
                if (failure != null) {
                    failure.addSuppressed(new IOException("report export artifact cleanup failed"));
                }
            }
        }
    }

    private String requestId(HttpServletRequest request) {
        var value = request == null ? null : request.getRequestId();
        if (value == null || value.isBlank()) {
            return "unavailable";
        }
        var safe = value.replaceAll("[^A-Za-z0-9._:-]", "");
        return safe.isEmpty() ? "unavailable" : safe.substring(0, Math.min(128, safe.length()));
    }

    @FunctionalInterface
    interface FileTransfer {
        long copy(java.nio.file.Path source, java.io.OutputStream destination) throws IOException;
    }
}
