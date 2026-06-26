package com.jdy.erp.purchase.api;

import java.util.Map;

import com.jdy.erp.shared.application.DocumentLockService;
import com.jdy.erp.purchase.application.PurchaseOrderAppService;
import com.jdy.erp.purchase.application.PurchaseOrderAppService.PurchaseOrderDraftRequest;
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
@RequestMapping("/api/purchase-orders")
public class PurchaseOrderController {
    private final PurchaseOrderAppService appService;
    private final DocumentLockService lockService;

    public PurchaseOrderController(PurchaseOrderAppService appService, DocumentLockService lockService) {
        this.appService = appService;
        this.lockService = lockService;
    }

    @GetMapping("/{billNo}")
    public Map<String, Object> detail(@PathVariable String billNo) {
        return appService.detail(billNo);
    }

    @PostMapping("/draft")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> saveDraft(@RequestBody PurchaseOrderDraftRequest request) {
        lockService.assertWritable("purchaseOrder", request.billNo());
        var result = appService.saveDraft(request);
        lockService.releaseIfOwned("purchaseOrder", String.valueOf(result.getOrDefault("billNo", request.billNo())));
        return result;
    }

    @PostMapping("/{billNo}/audit")
    @RequirePermission("purchase.order.audit")
    public Map<String, Object> audit(@PathVariable String billNo) {
        return appService.audit(billNo);
    }
}
