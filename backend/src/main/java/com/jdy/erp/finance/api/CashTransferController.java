package com.jdy.erp.finance.api;

import java.util.Map;

import com.jdy.erp.finance.application.CashTransferAppService;
import com.jdy.erp.finance.application.CashTransferAppService.CashTransferDraftRequest;
import com.jdy.erp.shared.application.DocumentLockService;
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
@RequestMapping("/api/cash-transfers")
public class CashTransferController {
    private final CashTransferAppService appService;
    private final DocumentLockService lockService;

    public CashTransferController(CashTransferAppService appService, DocumentLockService lockService) {
        this.appService = appService;
        this.lockService = lockService;
    }

    @GetMapping("/{billNo}")
    @RequirePermission("finance.cash_transfer.audit")
    public Map<String, Object> detail(@PathVariable String billNo) {
        return appService.detail(billNo);
    }

    @PostMapping("/draft")
    @RequirePermission("finance.cash_transfer.audit")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> saveDraft(@RequestBody CashTransferDraftRequest request) {
        lockService.assertWritable("cashTransfer", request.billNo());
        var result = appService.saveDraft(request);
        lockService.releaseIfOwned("cashTransfer", String.valueOf(result.getOrDefault("billNo", request.billNo())));
        return result;
    }

    @PostMapping("/{billNo}/audit")
    @RequirePermission("finance.cash_transfer.audit")
    public Map<String, Object> audit(@PathVariable String billNo) {
        return appService.audit(billNo);
    }

    @PostMapping("/{billNo}/reverse")
    @RequirePermission("finance.cash_transfer.audit")
    public Map<String, Object> reverse(@PathVariable String billNo) {
        return appService.reverse(billNo);
    }
}
