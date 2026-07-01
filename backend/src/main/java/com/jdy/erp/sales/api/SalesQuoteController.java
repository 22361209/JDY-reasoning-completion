package com.jdy.erp.sales.api;

import java.util.Map;

import com.jdy.erp.sales.application.SalesQuoteAppService;
import com.jdy.erp.sales.application.SalesQuoteAppService.SalesQuoteDraftRequest;
import com.jdy.erp.shared.application.DocumentLockService;
import com.jdy.erp.system.security.RequirePermission;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/sales-quotes")
public class SalesQuoteController {
    private final SalesQuoteAppService appService;
    private final DocumentLockService lockService;

    public SalesQuoteController(SalesQuoteAppService appService, DocumentLockService lockService) {
        this.appService = appService;
        this.lockService = lockService;
    }

    @PostMapping("/draft")
    @ResponseStatus(HttpStatus.CREATED)
    @RequirePermission("sales.order.audit")
    public Map<String, Object> saveDraft(@RequestBody SalesQuoteDraftRequest request) {
        lockService.assertWritable("salesQuote", request.billNo());
        var result = appService.saveDraft(request);
        lockService.releaseIfOwned("salesQuote", String.valueOf(result.getOrDefault("billNo", request.billNo())));
        return result;
    }

    @PostMapping("/{billNo}/audit")
    @RequirePermission("sales.order.audit")
    public Map<String, Object> audit(@PathVariable String billNo) {
        return appService.audit(billNo);
    }

    @PostMapping("/{billNo}/reverse")
    @RequirePermission("sales.order.audit")
    public Map<String, Object> reverse(@PathVariable String billNo) {
        return appService.reverse(billNo);
    }

    @DeleteMapping("/{billNo}")
    @RequirePermission("sales.order.audit")
    public Map<String, Object> delete(@PathVariable String billNo) {
        return appService.delete(billNo);
    }

    @PostMapping("/{billNo}/valid")
    @RequirePermission("sales.order.audit")
    public Map<String, Object> setValid(@PathVariable String billNo, @RequestBody Map<String, Boolean> request) {
        return appService.setValid(billNo, Boolean.TRUE.equals(request.get("valid")));
    }

    @GetMapping("/{billNo}")
    public Map<String, Object> detail(@PathVariable String billNo) {
        return appService.detail(billNo);
    }

    @GetMapping("/selectable-lines")
    public Map<String, Object> selectableLines(@RequestParam String customerCode) {
        return appService.selectableLines(customerCode);
    }
}
