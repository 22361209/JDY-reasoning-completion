package com.jdy.erp.purchase.api;

import java.util.Map;

import com.jdy.erp.purchase.application.PurchaseRequisitionAppService;
import com.jdy.erp.purchase.application.PurchaseRequisitionAppService.PurchaseRequisitionDraftRequest;
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
@RequestMapping("/api/purchase-requisitions")
public class PurchaseRequisitionController {
    private final PurchaseRequisitionAppService appService;

    public PurchaseRequisitionController(PurchaseRequisitionAppService appService) {
        this.appService = appService;
    }

    @GetMapping("/{billNo}")
    @RequirePermission("purchase.order.audit")
    public Map<String, Object> detail(@PathVariable String billNo) {
        return appService.detail(billNo);
    }

    @PostMapping("/draft")
    @RequirePermission("purchase.order.audit")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> saveDraft(@RequestBody PurchaseRequisitionDraftRequest request) {
        return appService.saveDraft(request);
    }

    @PostMapping("/{billNo}/audit")
    @RequirePermission("purchase.order.audit")
    public Map<String, Object> audit(@PathVariable String billNo) {
        return appService.audit(billNo);
    }

    @PostMapping("/{billNo}/reverse")
    @RequirePermission("purchase.order.audit")
    public Map<String, Object> reverse(@PathVariable String billNo) {
        return appService.reverse(billNo);
    }

    @PostMapping("/{billNo}/push-down")
    @RequirePermission("purchase.order.audit")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> pushDown(@PathVariable String billNo) {
        return appService.pushDown(billNo);
    }
}
