package com.jdy.erp.sales.api;

import static org.assertj.core.api.Assertions.assertThat;

import java.lang.reflect.RecordComponent;
import java.math.BigDecimal;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

import com.jdy.erp.sales.application.SalesReturnAppService;
import com.jdy.erp.sales.application.SalesReturnAppService.SalesReturnDraftRequest;
import com.jdy.erp.sales.application.SalesReturnAppService.SalesReturnLineRequest;
import com.jdy.erp.shared.application.DocumentLockService;
import com.jdy.erp.system.security.RequirePermission;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.ResponseStatus;

class SalesReturnControllerIntegrationTest {
    @Test
    void requestRecordsExposeOnlyTheFrozenNarrowWriteContract() {
        assertThat(componentNames(SalesReturnDraftRequest.class))
            .containsExactly("billNo", "version", "billDate", "remark", "lines");
        assertThat(componentNames(SalesReturnLineRequest.class))
            .containsExactly("sourceOutNo", "sourceLineNo", "qty", "lineRemark");
    }

    @Test
    void everyReadAndWriteEndpointRequiresTheExistingSalesOutPermission() {
        for (var methodName : List.of("saveDraft", "detail", "audit", "reverse", "deleteDraft")) {
            var method = Arrays.stream(SalesReturnController.class.getDeclaredMethods())
                .filter(candidate -> candidate.getName().equals(methodName))
                .findFirst()
                .orElseThrow();
            var permission = method.getAnnotation(RequirePermission.class);
            assertThat(permission).as(methodName).isNotNull();
            assertThat(permission.value()).as(methodName).isEqualTo("sales.out.audit");
        }
        assertThat(Arrays.stream(SalesReturnController.class.getDeclaredMethods())
            .filter(method -> method.getName().equals("saveDraft"))
            .findFirst()
            .orElseThrow()
            .getAnnotation(ResponseStatus.class)
            .value()).isEqualTo(HttpStatus.CREATED);
    }

    @Test
    void controllerChecksDraftEditLockAndReleasesTheOwnedDocumentAfterSave() {
        var appService = org.mockito.Mockito.mock(SalesReturnAppService.class);
        var lockService = org.mockito.Mockito.mock(DocumentLockService.class);
        var controller = new SalesReturnController(appService, lockService);
        var request = new SalesReturnDraftRequest(
            "XSTH000001",
            com.fasterxml.jackson.databind.node.TextNode.valueOf("0"),
            "2026-07-14",
            null,
            List.of(new SalesReturnLineRequest("XSCK000001", 1, BigDecimal.ONE, null))
        );
        org.mockito.Mockito.when(appService.saveDraft(request)).thenReturn(Map.of(
            "action", "DETAIL",
            "document", Map.of("billNo", "XSTH000001"),
            "lines", List.of()
        ));

        controller.saveDraft(request);

        org.mockito.Mockito.verify(lockService).assertWritable("salesReturn", "XSTH000001");
        org.mockito.Mockito.verify(lockService).releaseIfOwned("salesReturn", "XSTH000001");
    }

    private List<String> componentNames(Class<?> recordType) {
        return Arrays.stream(recordType.getRecordComponents()).map(RecordComponent::getName).toList();
    }
}
