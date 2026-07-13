package com.jdy.erp.shared.application;

import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;

import jakarta.servlet.http.HttpServletRequest;

import com.jdy.erp.shared.application.OperationLogService.TenantTarget;
import com.jdy.erp.system.tenant.TenantContext;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import org.springframework.web.servlet.HandlerMapping;

@Service
public final class OperationLogFailureService {
    private static final String REQUEST_FAILURE_KEYS = OperationLogFailureService.class.getName() + ".failureKeys";
    private static final String REQUEST_FAILURE_HANDLED = OperationLogFailureService.class.getName() + ".handled";

    private final OperationLogService operationLogService;
    private final TransactionTemplate primaryRequiresNew;
    private final TransactionTemplate platformRequiresNew;

    public OperationLogFailureService(
        OperationLogService operationLogService,
        @Qualifier("transactionManager") PlatformTransactionManager transactionManager,
        @Qualifier("platformTransactionManager") PlatformTransactionManager platformTransactionManager
    ) {
        this.operationLogService = operationLogService;
        this.primaryRequiresNew = requiresNew(transactionManager);
        this.platformRequiresNew = requiresNew(platformTransactionManager);
    }

    public UUID logCurrentOnce(OperationLogCommand failure) {
        requireFailure(failure);
        var context = TenantContext.current().orElse(null);
        var transaction = context != null && context.isTenant() ? primaryRequiresNew : platformRequiresNew;
        return logOnce("current", failure, () -> transaction.execute(status -> operationLogService.writeCurrent(failure)));
    }

    public UUID logPlatformOnce(OperationLogCommand failure) {
        requireFailure(failure);
        return logOnce("platform", failure, () -> platformRequiresNew.execute(status -> operationLogService.writePlatform(failure)));
    }

    public UUID logTenantOnce(TenantTarget target, OperationLogCommand failure) {
        requireFailure(failure);
        if (target == null) {
            throw new IllegalArgumentException("失败日志 tenant 目标不能为空");
        }
        return logOnce(
            "tenant:" + target.accountSetId(),
            failure,
            () -> platformRequiresNew.execute(status -> operationLogService.writeTenant(target, failure))
        );
    }

    public UUID logPermissionDeniedOnce(HttpServletRequest request, String reason) {
        return logEndpointFailureOnce(request, "WRITE_DENIED", reason);
    }

    public UUID logDeclaredWriteFailureOnce(HttpServletRequest request, String reason) {
        return logEndpointFailureOnce(request, "WRITE_FAILED", reason);
    }

    private UUID logEndpointFailureOnce(HttpServletRequest request, String action, String reason) {
        if (request == null) {
            return null;
        }
        var command = OperationLogCommand.failure(
            "SECURITY",
            action,
            "http_endpoint",
            null,
            endpointPattern(request),
            OperationLogCommand.ActorMode.CURRENT_USER,
            null,
            Map.of(),
            Map.of(),
            limitedReason(reason)
        );
        return logCurrentOnce(command);
    }

    public boolean hasLoggedFailure(HttpServletRequest request) {
        return request != null && Boolean.TRUE.equals(request.getAttribute(REQUEST_FAILURE_HANDLED));
    }

    private UUID logOnce(String scope, OperationLogCommand failure, Supplier<UUID> writer) {
        var request = currentRequest();
        var key = scope + "|" + failure.failureKey();
        if (request != null && failureKeys(request).contains(key)) {
            return null;
        }
        var id = writer.get();
        if (request != null) {
            failureKeys(request).add(key);
            request.setAttribute(REQUEST_FAILURE_HANDLED, Boolean.TRUE);
        }
        return id;
    }

    @SuppressWarnings("unchecked")
    private Set<String> failureKeys(HttpServletRequest request) {
        var existing = request.getAttribute(REQUEST_FAILURE_KEYS);
        if (existing instanceof Set<?> keys) {
            return (Set<String>) keys;
        }
        var keys = new LinkedHashSet<String>();
        request.setAttribute(REQUEST_FAILURE_KEYS, keys);
        return keys;
    }

    private void requireFailure(OperationLogCommand command) {
        if (command == null || command.outcome() != OperationLogCommand.Outcome.FAILURE) {
            throw new IllegalArgumentException("只能通过 OperationLogFailureService 写入失败日志");
        }
    }

    private String endpointPattern(HttpServletRequest request) {
        var rawPattern = request.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE);
        if (rawPattern == null || String.valueOf(rawPattern).isBlank()) {
            return null;
        }
        var endpoint = (request.getMethod() + " " + rawPattern).trim();
        return endpoint.length() <= 200 ? endpoint : endpoint.substring(0, 200);
    }

    private String limitedReason(String reason) {
        var normalized = reason == null || reason.isBlank() ? "业务操作失败" : reason.trim();
        return normalized.length() <= 1_000 ? normalized : normalized.substring(0, 1_000);
    }

    private TransactionTemplate requiresNew(PlatformTransactionManager transactionManager) {
        var template = new TransactionTemplate(transactionManager);
        template.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        return template;
    }

    private HttpServletRequest currentRequest() {
        var attributes = RequestContextHolder.getRequestAttributes();
        if (attributes instanceof ServletRequestAttributes servletAttributes) {
            return servletAttributes.getRequest();
        }
        return null;
    }
}
