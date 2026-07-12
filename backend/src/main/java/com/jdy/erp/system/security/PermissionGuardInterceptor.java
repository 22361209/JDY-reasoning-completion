package com.jdy.erp.system.security;

import java.util.Map;
import java.util.Set;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import com.jdy.erp.shared.application.DocumentPermissionPolicy;
import org.springframework.core.annotation.AnnotationUtils;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.HandlerMapping;

@Component
public class PermissionGuardInterceptor implements HandlerInterceptor {
    private static final Set<String> WRITE_METHODS = Set.of("POST", "PUT", "PATCH", "DELETE");

    private final CurrentPermissionService permissionService;
    private final DocumentPermissionPolicy documentPermissionPolicy;

    public PermissionGuardInterceptor(
        CurrentPermissionService permissionService,
        DocumentPermissionPolicy documentPermissionPolicy
    ) {
        this.permissionService = permissionService;
        this.documentPermissionPolicy = documentPermissionPolicy;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        if (!(handler instanceof HandlerMethod handlerMethod)) {
            return true;
        }
        var required = AnnotationUtils.findAnnotation(handlerMethod.getMethod(), RequirePermission.class);
        if (required == null) {
            required = AnnotationUtils.findAnnotation(handlerMethod.getBeanType(), RequirePermission.class);
        }
        var documentPermission = AnnotationUtils.findAnnotation(handlerMethod.getMethod(), RequireDocumentPermission.class);
        if (documentPermission == null) {
            documentPermission = AnnotationUtils.findAnnotation(handlerMethod.getBeanType(), RequireDocumentPermission.class);
        }
        var writeAccess = WriteAccessPolicyContract.find(handlerMethod);
        var declarationCount = (required == null ? 0 : 1)
            + (documentPermission == null ? 0 : 1)
            + (writeAccess == null ? 0 : 1);
        if (declarationCount > 1) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "接口存在冲突的访问语义声明");
        }
        if (required != null && permissionService.hasPermission(required.value())) {
            return true;
        }
        if (required != null) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "当前角色无权执行该操作：" + required.value());
        }
        if (documentPermission != null) {
            documentPermissionPolicy.requirePermission(documentType(request));
            return true;
        }
        if (writeAccess != null) {
            requireMatchingWritePolicy(request, writeAccess.value());
            return true;
        }
        if (WRITE_METHODS.contains(request.getMethod())) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "写接口未声明访问语义");
        }
        return true;
    }

    @SuppressWarnings("unchecked")
    private String documentType(HttpServletRequest request) {
        var variables = (Map<String, String>) request.getAttribute(HandlerMapping.URI_TEMPLATE_VARIABLES_ATTRIBUTE);
        var type = variables == null ? null : variables.get("type");
        if (type == null || type.isBlank()) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "单据权限路由缺少 type 参数");
        }
        return type;
    }

    private void requireMatchingWritePolicy(HttpServletRequest request, WriteAccess.Policy policy) {
        var matchingPattern = request.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE);
        var methodMatches = policy.method().name().equals(request.getMethod());
        var pathMatches = matchingPattern != null && policy.path().equals(matchingPattern.toString());
        if (!methodMatches || !pathMatches) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "接口访问 policy 与实际映射不一致");
        }
    }
}
