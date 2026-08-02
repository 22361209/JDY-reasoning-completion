package com.jdy.erp.purchase.api;

import java.util.Map;

import com.jdy.erp.purchase.application.PurchasePlanAppService;
import com.jdy.erp.system.security.RequirePermission;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/purchase-plans")
public class PurchasePlanController {
    private final PurchasePlanAppService appService;

    public PurchasePlanController(PurchasePlanAppService appService) {
        this.appService = appService;
    }

    @GetMapping("/{billNo}")
    @RequirePermission("purchase.order.audit")
    public Map<String, Object> detail(@PathVariable String billNo) {
        return appService.detail(billNo);
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

    @DeleteMapping("/{billNo}")
    @RequirePermission("purchase.order.audit")
    public Map<String, Object> deleteDraft(@PathVariable String billNo) {
        return appService.deleteDraft(billNo);
    }
}
