package com.jdy.erp.production.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.lang.reflect.Method;
import java.lang.reflect.RecordComponent;
import java.util.Arrays;
import java.util.List;

import jakarta.servlet.http.HttpServletRequest;

import com.jdy.erp.production.application.MaterialScrapAppService;
import com.jdy.erp.production.application.MaterialScrapAppService.ScrapDraftRequest;
import com.jdy.erp.production.application.MaterialScrapAppService.ScrapLineRequest;
import com.jdy.erp.shared.api.ResponseStatusExceptionHandler;
import com.jdy.erp.shared.application.OperationLogFailureService;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.security.RequirePermission;
import org.junit.jupiter.api.Test;
import org.springframework.core.annotation.AnnotationUtils;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class MaterialScrapControllerIntegrationTest {
    @Test
    void requestRecordsExposeOnlyTheFrozenNarrowWriteContract() {
        assertThat(componentNames(ScrapDraftRequest.class))
            .containsExactly("billNo", "sourceIssueNo", "billDate", "businessType", "lines");
        assertThat(componentNames(ScrapLineRequest.class))
            .containsExactly(
                "sourceIssueLineId",
                "scrapQty",
                "scrapReason",
                "reissueQty",
                "isStockIn",
                "targetWarehouseCode"
            );
        assertThat(ScrapDraftRequest.class.getRecordComponents()[2].getType())
            .isEqualTo(java.time.LocalDate.class);
        assertThat(ScrapLineRequest.class.getRecordComponents()[4].getType())
            .isEqualTo(Boolean.class);
    }

    @Test
    void controllerPublishesExactlyTheFrozenApiUnderTheApiPrefix() {
        assertThat(MaterialScrapController.class.getAnnotation(RequestMapping.class).value())
            .containsExactly("/api");
        assertRoute("detail", GetMapping.class, "/production/material-scraps/{billNo}");
        assertRoute("previewFromIssue", GetMapping.class, "/production/material-issues/{billNo}/material-scrap-preview");
        assertRoute("pushFromIssue", PostMapping.class, "/production/material-issues/{billNo}/push-material-scrap");
        assertRoute("saveDraft", PostMapping.class, "/production/material-scraps/draft");
        assertRoute("deleteDraft", DeleteMapping.class, "/production/material-scraps/{billNo}");
        assertRoute("audit", PostMapping.class, "/production/material-scraps/{billNo}/audit");
        assertRoute("reverse", PostMapping.class, "/production/material-scraps/{billNo}/reverse");
        assertRoute("stockIn", PostMapping.class, "/production/material-scraps/{billNo}/stock-in");
        assertRoute("reverseStockIn", PostMapping.class, "/production/material-scraps/{billNo}/reverse-stock-in");

        for (var methodName : List.of(
            "detail", "previewFromIssue", "pushFromIssue", "saveDraft", "deleteDraft",
            "audit", "reverse", "stockIn", "reverseStockIn"
        )) {
            var method = method(methodName);
            var permission = AnnotationUtils.findAnnotation(method, RequirePermission.class);
            if (permission == null) {
                permission = AnnotationUtils.findAnnotation(MaterialScrapController.class, RequirePermission.class);
            }
            assertThat(permission).as(methodName).isNotNull();
            assertThat(permission.value()).as(methodName).isEqualTo("production.document.audit");
        }
    }

    @Test
    void aWriteConflictUsesTheUnifiedHttpFailureAuditExactlyOnce() throws Exception {
        var appService = mock(MaterialScrapAppService.class);
        when(appService.audit("CLBF000001"))
            .thenThrow(new ResponseStatusException(HttpStatus.CONFLICT, "可报废数量不足"));
        var failures = mock(OperationLogFailureService.class);
        var session = mock(CurrentSessionService.class);
        when(session.isAuthenticated()).thenReturn(true);
        when(failures.hasLoggedFailure(any(HttpServletRequest.class))).thenReturn(false);
        var mockMvc = MockMvcBuilders
            .standaloneSetup(new MaterialScrapController(appService))
            .setControllerAdvice(new ResponseStatusExceptionHandler(failures, session))
            .build();

        mockMvc.perform(post("/api/production/material-scraps/CLBF000001/audit"))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.message").value("可报废数量不足"));

        verify(failures, times(1)).logDeclaredWriteFailureOnce(any(HttpServletRequest.class), eq("可报废数量不足"));
    }

    private List<String> componentNames(Class<?> recordType) {
        return Arrays.stream(recordType.getRecordComponents()).map(RecordComponent::getName).toList();
    }

    private Method method(String name) {
        return Arrays.stream(MaterialScrapController.class.getDeclaredMethods())
            .filter(candidate -> candidate.getName().equals(name))
            .findFirst()
            .orElseThrow();
    }

    private <A extends java.lang.annotation.Annotation> void assertRoute(
        String methodName,
        Class<A> annotationType,
        String expected
    ) {
        var method = method(methodName);
        var annotation = method.getAnnotation(annotationType);
        assertThat(annotation).as(methodName).isNotNull();
        String[] values;
        if (annotation instanceof GetMapping mapping) {
            values = mapping.value();
        } else if (annotation instanceof PostMapping mapping) {
            values = mapping.value();
        } else if (annotation instanceof DeleteMapping mapping) {
            values = mapping.value();
        } else {
            throw new AssertionError("Unsupported mapping annotation: " + annotationType.getName());
        }
        assertThat(values).as(methodName).containsExactly(expected);
    }
}
