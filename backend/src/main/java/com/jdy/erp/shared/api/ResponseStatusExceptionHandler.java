package com.jdy.erp.shared.api;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.server.ResponseStatusException;

@RestControllerAdvice
public class ResponseStatusExceptionHandler {

    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> handle(ResponseStatusException exception) {
        String reason = exception.getReason() == null || exception.getReason().isBlank()
            ? exception.getStatusCode().toString()
            : exception.getReason();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", exception.getStatusCode().value());
        body.put("error", exception.getStatusCode().toString());
        body.put("message", reason);
        body.put("reason", reason);
        return ResponseEntity.status(exception.getStatusCode()).body(body);
    }
}
