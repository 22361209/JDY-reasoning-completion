package com.jdy.erp.inventory.api;

import java.util.Map;

import com.jdy.erp.shared.application.DocumentLockService;
import com.jdy.erp.inventory.application.StockCountLossAppService;
import com.jdy.erp.inventory.application.StockCountLossAppService.StockCountLossDraftRequest;
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
@RequestMapping("/api/stock-count-losses")
public class StockCountLossController {
    private final StockCountLossAppService appService;
    private final DocumentLockService lockService;

    public StockCountLossController(StockCountLossAppService appService, DocumentLockService lockService) {
        this.appService = appService;
        this.lockService = lockService;
    }

    @GetMapping("/{billNo}")
    public Map<String, Object> detail(@PathVariable String billNo) {
        return appService.detail(billNo);
    }

    @PostMapping("/draft")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> saveDraft(@RequestBody StockCountLossDraftRequest request) {
        lockService.assertWritable("stockCountLoss", request.billNo());
        var result = appService.saveDraft(request);
        lockService.releaseIfOwned("stockCountLoss", String.valueOf(result.getOrDefault("billNo", request.billNo())));
        return result;
    }

    @PostMapping("/{billNo}/audit")
    @RequirePermission("inventory.stock_count_loss.audit")
    public Map<String, Object> audit(@PathVariable String billNo) {
        return appService.audit(billNo);
    }

    @PostMapping("/{billNo}/reverse")
    @RequirePermission("inventory.stock_count_loss.audit")
    public Map<String, Object> reverse(@PathVariable String billNo) {
        return appService.reverse(billNo);
    }

    @PostMapping("/{billNo}/void")
    @RequirePermission("inventory.stock_count_loss.audit")
    public Map<String, Object> voidBill(@PathVariable String billNo) {
        return appService.voidBill(billNo);
    }
}
