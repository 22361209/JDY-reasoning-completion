package com.jdy.erp.sales.api;

import java.util.Map;

import com.jdy.erp.sales.application.SalesReturnAppService;
import com.jdy.erp.sales.application.SalesReturnAppService.SalesReturnDraftRequest;
import com.jdy.erp.shared.application.DocumentLockService;
import com.jdy.erp.system.security.RequirePermission;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/sales-returns")
public class SalesReturnController {
    private static final String PERMISSION = "sales.out.audit";

    private final SalesReturnAppService appService;
    private final DocumentLockService lockService;

    public SalesReturnController(SalesReturnAppService appService, DocumentLockService lockService) {
        this.appService = appService;
        this.lockService = lockService;
    }

    @PostMapping("/draft")
    @RequirePermission(PERMISSION)
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> saveDraft(@RequestBody SalesReturnDraftRequest request) {
        if (request != null && request.billNo() != null && !request.billNo().isBlank()) {
            lockService.assertWritable("salesReturn", request.billNo().trim());
        }
        var result = appService.saveDraft(request);
        var document = document(result);
        lockService.releaseIfOwned("salesReturn", String.valueOf(document.get("billNo")));
        return result;
    }

    @GetMapping("/{billNo}")
    @RequirePermission(PERMISSION)
    public Map<String, Object> detail(@PathVariable String billNo) {
        return appService.detail(billNo);
    }

    @PostMapping("/{billNo}/audit")
    @RequirePermission(PERMISSION)
    public Map<String, Object> audit(@PathVariable String billNo) {
        return appService.audit(billNo);
    }

    @PostMapping("/{billNo}/reverse")
    @RequirePermission(PERMISSION)
    public Map<String, Object> reverse(@PathVariable String billNo) {
        return appService.reverse(billNo);
    }

    @DeleteMapping("/{billNo}")
    @RequirePermission(PERMISSION)
    public Map<String, Object> deleteDraft(@PathVariable String billNo) {
        return appService.deleteDraft(billNo);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> document(Map<String, Object> result) {
        return (Map<String, Object>) result.get("document");
    }
}
