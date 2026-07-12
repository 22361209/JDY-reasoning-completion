package com.jdy.erp.inventory.api;

import java.util.Map;

import com.jdy.erp.shared.application.BillLifecycleService.VoidRequest;
import com.jdy.erp.shared.application.DocumentLockService;
import com.jdy.erp.inventory.application.StockCountAppService;
import com.jdy.erp.inventory.application.StockCountAppService.StockCountDraftRequest;
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
@RequestMapping("/api/stock-counts")
public class StockCountController {
    private final StockCountAppService appService;
    private final DocumentLockService lockService;

    public StockCountController(StockCountAppService appService, DocumentLockService lockService) {
        this.appService = appService;
        this.lockService = lockService;
    }

    @GetMapping("/{billNo}")
    public Map<String, Object> detail(@PathVariable String billNo) {
        return appService.detail(billNo);
    }

    @PostMapping("/draft")
    @RequirePermission("inventory.stock_count.audit")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> saveDraft(@RequestBody StockCountDraftRequest request) {
        lockService.assertWritable("stockCount", request.billNo());
        var result = appService.saveDraft(request);
        lockService.releaseIfOwned("stockCount", String.valueOf(result.getOrDefault("billNo", request.billNo())));
        return result;
    }

    @PostMapping("/{billNo}/audit")
    @RequirePermission("inventory.stock_count.audit")
    public Map<String, Object> audit(@PathVariable String billNo) {
        return appService.audit(billNo);
    }

    @PostMapping("/{billNo}/reverse")
    @RequirePermission("inventory.stock_count.audit")
    public Map<String, Object> reverse(@PathVariable String billNo) {
        return appService.reverse(billNo);
    }

    @PostMapping("/{billNo}/void")
    @RequirePermission("inventory.stock_count.audit")
    public Map<String, Object> voidBill(@PathVariable String billNo, @RequestBody VoidRequest request) {
        return appService.voidBill(billNo, request);
    }
}
