package com.jdy.erp.shared.api;

import java.util.LinkedHashMap;
import java.util.Map;

import jakarta.servlet.http.HttpServletRequest;

import com.jdy.erp.shared.application.OperationLogFailureService;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.security.RequireDocumentPermission;
import com.jdy.erp.system.security.RequirePermission;
import com.jdy.erp.system.security.WriteAccess;
import org.springframework.core.annotation.AnnotationUtils;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.HandlerMapping;

@RestControllerAdvice
public class ResponseStatusExceptionHandler {
    private final OperationLogFailureService operationLogFailureService;
    private final CurrentSessionService currentSessionService;

    public ResponseStatusExceptionHandler(
        OperationLogFailureService operationLogFailureService,
        CurrentSessionService currentSessionService
    ) {
        this.operationLogFailureService = operationLogFailureService;
        this.currentSessionService = currentSessionService;
    }

    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> handle(ResponseStatusException exception, HttpServletRequest request) {
        String reason = exception.getReason() == null || exception.getReason().isBlank()
            ? exception.getStatusCode().toString()
            : exception.getReason();
        if (shouldAudit(exception, request)) {
            operationLogFailureService.logDeclaredWriteFailureOnce(request, reason);
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", exception.getStatusCode().value());
        body.put("error", exception.getStatusCode().toString());
        body.put("message", reason);
        body.put("reason", reason);
        return ResponseEntity.status(exception.getStatusCode()).body(body);
    }

    private boolean shouldAudit(ResponseStatusException exception, HttpServletRequest request) {
        var status = exception.getStatusCode().value();
        if (!java.util.Set.of("POST", "PUT", "PATCH", "DELETE").contains(request.getMethod())) {
            return false;
        }
        if (status == 404 || status >= 500) {
            return false;
        }
        if (operationLogFailureService.hasLoggedFailure(request) || !currentSessionService.isAuthenticated()) {
            return false;
        }
        var handler = request.getAttribute(HandlerMapping.BEST_MATCHING_HANDLER_ATTRIBUTE);
        if (!(handler instanceof HandlerMethod handlerMethod)) {
            return false;
        }
        var permission = AnnotationUtils.findAnnotation(handlerMethod.getMethod(), RequirePermission.class);
        if (permission == null) {
            permission = AnnotationUtils.findAnnotation(handlerMethod.getBeanType(), RequirePermission.class);
        }
        var documentPermission = AnnotationUtils.findAnnotation(handlerMethod.getMethod(), RequireDocumentPermission.class);
        if (documentPermission == null) {
            documentPermission = AnnotationUtils.findAnnotation(handlerMethod.getBeanType(), RequireDocumentPermission.class);
        }
        var writeAccess = AnnotationUtils.findAnnotation(handlerMethod.getMethod(), WriteAccess.class);
        return permission != null
            || documentPermission != null
            || (writeAccess != null && writeAccess.value().mode() != WriteAccess.Mode.PUBLIC);
    }
}
