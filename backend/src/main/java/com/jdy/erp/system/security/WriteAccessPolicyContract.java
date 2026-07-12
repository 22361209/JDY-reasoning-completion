package com.jdy.erp.system.security;

import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

import com.jdy.erp.system.security.WriteAccess.Policy;
import org.springframework.beans.factory.SmartInitializingSingleton;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.core.annotation.AnnotationUtils;
import org.springframework.stereotype.Component;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.mvc.method.RequestMappingInfo;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;

/**
 * Executable contract for the deliberately narrow write endpoints that do not use a permission annotation.
 * The registered Spring mappings remain the source of truth; this component only verifies that every named
 * exception is attached to exactly one matching handler before the application starts serving requests.
 */
@Component
public class WriteAccessPolicyContract implements SmartInitializingSingleton {
    private final RequestMappingHandlerMapping handlerMapping;

    public WriteAccessPolicyContract(
        @Qualifier("requestMappingHandlerMapping") RequestMappingHandlerMapping handlerMapping
    ) {
        this.handlerMapping = handlerMapping;
    }

    @Override
    public void afterSingletonsInstantiated() {
        validate(handlerMapping.getHandlerMethods());
    }

    static void validate(Map<RequestMappingInfo, HandlerMethod> handlerMethods) {
        var registrations = new EnumMap<Policy, List<String>>(Policy.class);
        var violations = new ArrayList<String>();

        handlerMethods.forEach((mapping, handler) -> {
            var declaration = find(handler);
            if (declaration == null) {
                return;
            }
            var policy = declaration.value();
            var methods = mapping.getMethodsCondition().getMethods();
            var paths = mapping.getPatternValues();
            var endpoint = methods + " " + paths + " -> "
                + handler.getBeanType().getSimpleName() + "." + handler.getMethod().getName();
            registrations.computeIfAbsent(policy, ignored -> new ArrayList<>()).add(endpoint);

            if (methods.size() != 1 || paths.size() != 1) {
                violations.add(policy + " must map to exactly one HTTP method and one path, found " + endpoint);
                return;
            }
            var actualMethod = methods.iterator().next();
            var actualPath = paths.iterator().next();
            if (actualMethod != policy.method() || !actualPath.equals(policy.path())) {
                violations.add(policy + " expects " + policy.method() + " " + policy.path() + ", found " + endpoint);
            }
        });

        for (var policy : Policy.values()) {
            var endpoints = registrations.getOrDefault(policy, List.of());
            if (endpoints.isEmpty()) {
                violations.add(policy + " is not attached to a registered handler");
            } else if (endpoints.size() > 1) {
                violations.add(policy + " is attached to multiple registered handlers: " + endpoints);
            }
        }

        if (!violations.isEmpty()) {
            throw new IllegalStateException("WriteAccess policy contract violation:\n- " + String.join("\n- ", violations));
        }
    }

    static WriteAccess find(HandlerMethod handler) {
        return AnnotationUtils.findAnnotation(handler.getMethod(), WriteAccess.class);
    }
}
