package com.jdy.erp.sales.api;

import java.util.Map;

import com.jdy.erp.sales.application.SalesOrderAppService;
import com.jdy.erp.sales.application.SalesOrderAppService.SalesOrderDraftRequest;
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
@RequestMapping("/api/sales-orders")
public class SalesOrderController {
    private final SalesOrderAppService appService;

    public SalesOrderController(SalesOrderAppService appService) {
        this.appService = appService;
    }

    @PostMapping("/draft")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> saveDraft(@RequestBody SalesOrderDraftRequest request) {
        return appService.saveDraft(request);
    }

    @PostMapping("/{billNo}/audit")
    @RequirePermission("sales.order.audit")
    public Map<String, Object> audit(@PathVariable String billNo) {
        return appService.audit(billNo);
    }

    @DeleteMapping("/{billNo}")
    @RequirePermission("sales.order.audit")
    public Map<String, Object> delete(@PathVariable String billNo) {
        return appService.delete(billNo);
    }

    @GetMapping("/{billNo}")
    public Map<String, Object> detail(@PathVariable String billNo) {
        return appService.detail(billNo);
    }

    @GetMapping("/{billNo}/export")
    public Map<String, Object> export(@PathVariable String billNo) {
        return appService.export(billNo);
    }

    @GetMapping("/{billNo}/print")
    public Map<String, Object> print(@PathVariable String billNo) {
        return appService.print(billNo);
    }
}
