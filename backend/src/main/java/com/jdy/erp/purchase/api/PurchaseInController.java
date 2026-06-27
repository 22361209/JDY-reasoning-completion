package com.jdy.erp.purchase.api;

import java.util.Map;

import com.jdy.erp.shared.application.DocumentLockService;
import com.jdy.erp.purchase.application.PurchaseInAppService;
import com.jdy.erp.purchase.application.PurchaseInAppService.PurchaseInDraftRequest;
import com.jdy.erp.purchase.application.PurchaseInAppService.RedReverseRequest;
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
@RequestMapping("/api/purchase-ins")
public class PurchaseInController {
    private final PurchaseInAppService appService;
    private final DocumentLockService lockService;

    public PurchaseInController(PurchaseInAppService appService, DocumentLockService lockService) {
        this.appService = appService;
        this.lockService = lockService;
    }

    @GetMapping("/{billNo}")
    public Map<String, Object> detail(@PathVariable String billNo) {
        return appService.detail(billNo);
    }

    @PostMapping("/draft")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> saveDraft(@RequestBody PurchaseInDraftRequest request) {
        lockService.assertWritable("purchaseIn", request.billNo());
        var result = appService.saveDraft(request);
        lockService.releaseIfOwned("purchaseIn", String.valueOf(result.getOrDefault("billNo", request.billNo())));
        return result;
    }

    @PostMapping("/{billNo}/audit")
    @RequirePermission("purchase.in.audit")
    public Map<String, Object> audit(@PathVariable String billNo) {
        return appService.audit(billNo);
    }

    @PostMapping("/{billNo}/reverse")
    @RequirePermission("purchase.in.audit")
    public Map<String, Object> reverse(@PathVariable String billNo) {
        return appService.reverse(billNo);
    }

    @DeleteMapping("/{billNo}")
    @RequirePermission("purchase.in.audit")
    public Map<String, Object> delete(@PathVariable String billNo) {
        return appService.delete(billNo);
    }

    @PostMapping("/{billNo}/void")
    @RequirePermission("purchase.in.audit")
    public Map<String, Object> voidBill(@PathVariable String billNo) {
        return appService.voidBill(billNo);
    }

    @PostMapping("/{billNo}/red-reverse")
    @RequirePermission("purchase.in.audit")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> redReverse(@PathVariable String billNo, @RequestBody RedReverseRequest request) {
        return appService.redReverse(billNo, request);
    }
}
