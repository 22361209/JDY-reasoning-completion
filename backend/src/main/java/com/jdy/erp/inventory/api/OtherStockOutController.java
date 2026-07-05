package com.jdy.erp.inventory.api;

import java.util.Map;

import com.jdy.erp.shared.application.BillLifecycleService.VoidRequest;
import com.jdy.erp.shared.application.DocumentLockService;
import com.jdy.erp.inventory.application.OtherStockOutAppService;
import com.jdy.erp.inventory.application.OtherStockOutAppService.OtherStockOutDraftRequest;
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
@RequestMapping("/api/other-stock-outs")
public class OtherStockOutController {
    private final OtherStockOutAppService appService;
    private final DocumentLockService lockService;

    public OtherStockOutController(OtherStockOutAppService appService, DocumentLockService lockService) {
        this.appService = appService;
        this.lockService = lockService;
    }

    @GetMapping("/{billNo}")
    public Map<String, Object> detail(@PathVariable String billNo) {
        return appService.detail(billNo);
    }

    @PostMapping("/draft")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> saveDraft(@RequestBody OtherStockOutDraftRequest request) {
        lockService.assertWritable("otherStockOut", request.billNo());
        var result = appService.saveDraft(request);
        lockService.releaseIfOwned("otherStockOut", String.valueOf(result.getOrDefault("billNo", request.billNo())));
        return result;
    }

    @PostMapping("/{billNo}/audit")
    @RequirePermission("inventory.other_stock_out.audit")
    public Map<String, Object> audit(@PathVariable String billNo) {
        return appService.audit(billNo);
    }

    @PostMapping("/{billNo}/reverse")
    @RequirePermission("inventory.other_stock_out.audit")
    public Map<String, Object> reverse(@PathVariable String billNo) {
        return appService.reverse(billNo);
    }

    @PostMapping("/{billNo}/void")
    @RequirePermission("inventory.other_stock_out.audit")
    public Map<String, Object> voidBill(@PathVariable String billNo, @RequestBody VoidRequest request) {
        return appService.voidBill(billNo, request);
    }
}
