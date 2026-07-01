package com.jdy.erp.sales.api;

import java.util.Map;

import com.jdy.erp.shared.application.DocumentLockService;
import com.jdy.erp.shared.application.BillLifecycleService.VoidRequest;
import com.jdy.erp.sales.application.SalesOutAppService;
import com.jdy.erp.sales.application.SalesOutAppService.RedReverseRequest;
import com.jdy.erp.sales.application.SalesOutAppService.SalesOutDraftRequest;
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
@RequestMapping("/api/sales-outs")
public class SalesOutController {
    private final SalesOutAppService salesOutAppService;
    private final DocumentLockService lockService;

    public SalesOutController(SalesOutAppService salesOutAppService, DocumentLockService lockService) {
        this.salesOutAppService = salesOutAppService;
        this.lockService = lockService;
    }

    @GetMapping("/{billNo}")
    public Map<String, Object> detail(@PathVariable String billNo) {
        return salesOutAppService.detail(billNo);
    }

    @PostMapping("/draft")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> saveDraft(@RequestBody SalesOutDraftRequest request) {
        lockService.assertWritable("salesOut", request.billNo());
        var result = salesOutAppService.saveDraft(request);
        lockService.releaseIfOwned("salesOut", String.valueOf(result.getOrDefault("billNo", request.billNo())));
        return result;
    }

    @PostMapping("/{billNo}/audit")
    @RequirePermission("sales.out.audit")
    public Map<String, Object> audit(@PathVariable String billNo) {
        return salesOutAppService.audit(billNo);
    }

    @PostMapping("/{billNo}/reverse")
    @RequirePermission("sales.out.audit")
    public Map<String, Object> reverse(@PathVariable String billNo) {
        return salesOutAppService.reverse(billNo);
    }

    @PostMapping("/{billNo}/void")
    @RequirePermission("sales.out.audit")
    public Map<String, Object> voidBill(@PathVariable String billNo, @RequestBody VoidRequest request) {
        return salesOutAppService.voidBill(billNo, request);
    }

    @DeleteMapping("/{billNo}")
    @RequirePermission("sales.out.audit")
    public Map<String, Object> delete(@PathVariable String billNo) {
        return salesOutAppService.delete(billNo);
    }

    @PostMapping("/{billNo}/red-reverse")
    @RequirePermission("sales.out.audit")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> redReverse(@PathVariable String billNo, @RequestBody RedReverseRequest request) {
        return salesOutAppService.redReverse(billNo, request);
    }
}
