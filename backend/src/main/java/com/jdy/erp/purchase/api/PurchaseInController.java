package com.jdy.erp.purchase.api;

import java.util.Map;

import com.jdy.erp.purchase.application.PurchaseInAppService;
import com.jdy.erp.purchase.application.PurchaseInAppService.PurchaseInDraftRequest;
import com.jdy.erp.purchase.application.PurchaseInAppService.RedReverseRequest;
import com.jdy.erp.system.security.RequirePermission;
import org.springframework.http.HttpStatus;
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

    public PurchaseInController(PurchaseInAppService appService) {
        this.appService = appService;
    }

    @GetMapping("/{billNo}")
    public Map<String, Object> detail(@PathVariable String billNo) {
        return appService.detail(billNo);
    }

    @PostMapping("/draft")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> saveDraft(@RequestBody PurchaseInDraftRequest request) {
        return appService.saveDraft(request);
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
