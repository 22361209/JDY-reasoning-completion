package com.jdy.erp.inventory.api;

import java.util.Map;

import com.jdy.erp.inventory.application.OtherStockInAppService;
import com.jdy.erp.inventory.application.OtherStockInAppService.OtherStockInDraftRequest;
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
@RequestMapping("/api/other-stock-ins")
public class OtherStockInController {
    private final OtherStockInAppService appService;

    public OtherStockInController(OtherStockInAppService appService) {
        this.appService = appService;
    }

    @GetMapping("/{billNo}")
    public Map<String, Object> detail(@PathVariable String billNo) {
        return appService.detail(billNo);
    }

    @PostMapping("/draft")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> saveDraft(@RequestBody OtherStockInDraftRequest request) {
        return appService.saveDraft(request);
    }

    @PostMapping("/{billNo}/audit")
    @RequirePermission("inventory.other_stock_in.audit")
    public Map<String, Object> audit(@PathVariable String billNo) {
        return appService.audit(billNo);
    }

    @PostMapping("/{billNo}/reverse")
    @RequirePermission("inventory.other_stock_in.audit")
    public Map<String, Object> reverse(@PathVariable String billNo) {
        return appService.reverse(billNo);
    }

    @PostMapping("/{billNo}/void")
    @RequirePermission("inventory.other_stock_in.audit")
    public Map<String, Object> voidBill(@PathVariable String billNo) {
        return appService.voidBill(billNo);
    }
}
