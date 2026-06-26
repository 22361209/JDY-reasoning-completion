package com.jdy.erp.sales.api;

import java.util.Map;

import com.jdy.erp.sales.application.DeliveryNoticeAppService;
import com.jdy.erp.sales.application.DeliveryNoticeAppService.DeliveryNoticeDraftRequest;
import com.jdy.erp.shared.application.DocumentLockService;
import com.jdy.erp.system.security.RequirePermission;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/delivery-notices")
public class DeliveryNoticeController {
    private final DeliveryNoticeAppService appService;
    private final DocumentLockService lockService;

    public DeliveryNoticeController(DeliveryNoticeAppService appService, DocumentLockService lockService) {
        this.appService = appService;
        this.lockService = lockService;
    }

    @GetMapping("/{billNo}")
    public Map<String, Object> detail(@PathVariable String billNo) {
        return appService.detail(billNo);
    }

    @PostMapping("/draft")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> saveDraft(@RequestBody DeliveryNoticeDraftRequest request) {
        lockService.assertWritable("deliveryNotice", request.billNo());
        var result = appService.saveDraft(request);
        lockService.releaseIfOwned("deliveryNotice", String.valueOf(result.getOrDefault("billNo", request.billNo())));
        return result;
    }

    @PostMapping("/{billNo}/audit")
    @RequirePermission("sales.out.audit")
    public Map<String, Object> audit(@PathVariable String billNo) {
        return appService.audit(billNo);
    }

    @PostMapping("/{billNo}/reverse")
    @RequirePermission("sales.out.audit")
    public Map<String, Object> reverse(@PathVariable String billNo) {
        return appService.reverse(billNo);
    }

    @GetMapping("/selectable-lines")
    public Map<String, Object> selectableLines(@RequestParam String customerCode) {
        return appService.selectableLines(customerCode);
    }

    @GetMapping("/{billNo}/stock")
    public Map<String, Object> stockSnapshot(@PathVariable String billNo) {
        return appService.stockSnapshot(billNo);
    }
}
