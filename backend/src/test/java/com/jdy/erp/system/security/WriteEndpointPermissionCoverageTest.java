package com.jdy.erp.system.security;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.Set;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.core.annotation.AnnotationUtils;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;

@SpringBootTest
@ActiveProfiles("test")
class WriteEndpointPermissionCoverageTest {
    private static final Set<RequestMethod> WRITE_METHODS = Set.of(
        RequestMethod.POST,
        RequestMethod.PUT,
        RequestMethod.PATCH,
        RequestMethod.DELETE
    );

    @Autowired
    @Qualifier("requestMappingHandlerMapping")
    private RequestMappingHandlerMapping handlerMapping;

    @Test
    void everyRegisteredApiWriteHandlerHasExactlyOneExplicitAccessSemantic() {
        var violations = new ArrayList<String>();
        var registeredWrites = new LinkedHashSet<String>();

        handlerMapping.getHandlerMethods().forEach((mapping, handler) -> {
            var methods = mapping.getMethodsCondition().getMethods();
            if (methods.stream().noneMatch(WRITE_METHODS::contains)) {
                return;
            }
            for (var path : mapping.getPatternValues()) {
                if (!path.startsWith("/api/")) {
                    continue;
                }
                for (var method : methods) {
                    if (!WRITE_METHODS.contains(method)) {
                        continue;
                    }
                    var endpoint = method + " " + path + " -> " + handler.getBeanType().getSimpleName()
                        + "." + handler.getMethod().getName();
                    registeredWrites.add(endpoint);
                    var semanticCount = accessSemanticCount(handler);
                    if (semanticCount != 1) {
                        violations.add(endpoint + " declares " + semanticCount + " access semantics");
                    }
                }
            }
        });

        assertThat(registeredWrites)
            .as("Spring must expose real /api write handlers for the coverage gate")
            .isNotEmpty();
        assertThat(registeredWrites)
            .noneMatch(endpoint -> endpoint.contains("POST /api/inventory/sales-out"))
            .noneMatch(endpoint -> endpoint.contains("POST /api/inventory/purchase-in"));
        assertThat(violations)
            .as("Every registered /api write handler must have one fixed, document, request-scoped, authenticated, or public access semantic")
            .isEmpty();
    }

    private int accessSemanticCount(HandlerMethod handler) {
        var fixedPermission = find(handler, RequirePermission.class) == null ? 0 : 1;
        var documentPermission = find(handler, RequireDocumentPermission.class) == null ? 0 : 1;
        var writeAccess = find(handler, WriteAccess.class) == null ? 0 : 1;
        return fixedPermission + documentPermission + writeAccess;
    }

    private <A extends java.lang.annotation.Annotation> A find(HandlerMethod handler, Class<A> annotationType) {
        var annotation = AnnotationUtils.findAnnotation(handler.getMethod(), annotationType);
        return annotation == null
            ? AnnotationUtils.findAnnotation(handler.getBeanType(), annotationType)
            : annotation;
    }
}
