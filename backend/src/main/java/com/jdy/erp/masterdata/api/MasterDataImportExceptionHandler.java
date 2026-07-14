package com.jdy.erp.masterdata.api;

import java.util.LinkedHashMap;
import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.multipart.MultipartException;

@RestControllerAdvice(assignableTypes = MasterDataImportController.class)
public final class MasterDataImportExceptionHandler {
    @ExceptionHandler(MaxUploadSizeExceededException.class)
    public ResponseEntity<Map<String, Object>> tooLarge() {
        return response(HttpStatus.PAYLOAD_TOO_LARGE, "Excel 文件不能超过 10 MiB");
    }

    @ExceptionHandler(MultipartException.class)
    public ResponseEntity<Map<String, Object>> malformedMultipart(MultipartException exception) {
        if (hasTooLargeCause(exception)) {
            return tooLarge();
        }
        return response(HttpStatus.BAD_REQUEST, "上传请求不是有效的 multipart/form-data");
    }

    private boolean hasTooLargeCause(Throwable error) {
        var current = error;
        while (current != null) {
            if (current instanceof MaxUploadSizeExceededException) {
                return true;
            }
            current = current.getCause();
        }
        return false;
    }

    private ResponseEntity<Map<String, Object>> response(HttpStatus status, String message) {
        var body = new LinkedHashMap<String, Object>();
        body.put("status", status.value());
        body.put("error", status.toString());
        body.put("message", message);
        body.put("reason", message);
        return ResponseEntity.status(status).body(body);
    }
}
