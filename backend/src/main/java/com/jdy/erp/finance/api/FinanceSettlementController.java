package com.jdy.erp.finance.api;

import java.util.Map;

import com.jdy.erp.finance.application.FinanceSettlementAppService;
import com.jdy.erp.finance.application.FinanceSettlementAppService.SettlementDraftRequest;
import com.jdy.erp.finance.application.FinanceSettlementAppService.SettlementKind;
import com.jdy.erp.system.security.CurrentPermissionService;
import com.jdy.erp.system.security.RequirePermission;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/finance")
public class FinanceSettlementController {
    private static final String SETTLE_PERMISSION = "finance.settle";
    private static final String REPORT_PERMISSION = "finance.report.view";

    private final FinanceSettlementAppService settlementService;
    private final CurrentPermissionService permissionService;

    public FinanceSettlementController(
        FinanceSettlementAppService settlementService,
        CurrentPermissionService permissionService
    ) {
        this.settlementService = settlementService;
        this.permissionService = permissionService;
    }

    @PostMapping("/receipts/draft")
    @RequirePermission(SETTLE_PERMISSION)
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> createReceiptDraft(@RequestBody SettlementDraftRequest request) {
        return settlementService.createDraft(SettlementKind.RECEIPT, request);
    }

    @PutMapping("/receipts/{billNo}/draft")
    @RequirePermission(SETTLE_PERMISSION)
    public Map<String, Object> updateReceiptDraft(
        @PathVariable String billNo,
        @RequestBody SettlementDraftRequest request
    ) {
        return settlementService.updateDraft(SettlementKind.RECEIPT, billNo, request);
    }

    @GetMapping("/receipts/{billNo}")
    public Map<String, Object> receiptDetail(@PathVariable String billNo) {
        requireReadPermission();
        return settlementService.detail(SettlementKind.RECEIPT, billNo);
    }

    @PostMapping("/receipts/{billNo}/audit")
    @RequirePermission(SETTLE_PERMISSION)
    public Map<String, Object> auditReceipt(@PathVariable String billNo) {
        return settlementService.audit(SettlementKind.RECEIPT, billNo);
    }

    @PostMapping("/receipts/{billNo}/reverse")
    @RequirePermission(SETTLE_PERMISSION)
    public Map<String, Object> reverseReceipt(@PathVariable String billNo) {
        return settlementService.reverse(SettlementKind.RECEIPT, billNo);
    }

    @DeleteMapping("/receipts/{billNo}")
    @RequirePermission(SETTLE_PERMISSION)
    public Map<String, Object> deleteReceiptDraft(@PathVariable String billNo) {
        return settlementService.deleteDraft(SettlementKind.RECEIPT, billNo);
    }

    @PostMapping("/payments/draft")
    @RequirePermission(SETTLE_PERMISSION)
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> createPaymentDraft(@RequestBody SettlementDraftRequest request) {
        return settlementService.createDraft(SettlementKind.PAYMENT, request);
    }

    @PutMapping("/payments/{billNo}/draft")
    @RequirePermission(SETTLE_PERMISSION)
    public Map<String, Object> updatePaymentDraft(
        @PathVariable String billNo,
        @RequestBody SettlementDraftRequest request
    ) {
        return settlementService.updateDraft(SettlementKind.PAYMENT, billNo, request);
    }

    @GetMapping("/payments/{billNo}")
    public Map<String, Object> paymentDetail(@PathVariable String billNo) {
        requireReadPermission();
        return settlementService.detail(SettlementKind.PAYMENT, billNo);
    }

    @PostMapping("/payments/{billNo}/audit")
    @RequirePermission(SETTLE_PERMISSION)
    public Map<String, Object> auditPayment(@PathVariable String billNo) {
        return settlementService.audit(SettlementKind.PAYMENT, billNo);
    }

    @PostMapping("/payments/{billNo}/reverse")
    @RequirePermission(SETTLE_PERMISSION)
    public Map<String, Object> reversePayment(@PathVariable String billNo) {
        return settlementService.reverse(SettlementKind.PAYMENT, billNo);
    }

    @DeleteMapping("/payments/{billNo}")
    @RequirePermission(SETTLE_PERMISSION)
    public Map<String, Object> deletePaymentDraft(@PathVariable String billNo) {
        return settlementService.deleteDraft(SettlementKind.PAYMENT, billNo);
    }

    @PostMapping("/receivables/{billNo}/receipt")
    @RequirePermission(SETTLE_PERMISSION)
    public void retiredImmediateReceipt(@PathVariable String billNo) {
        throw new ResponseStatusException(
            HttpStatus.GONE,
            "旧立即收款接口已退役，请使用 /api/finance/receipts/draft 创建正式收款单"
        );
    }

    @PostMapping("/payables/{billNo}/payment")
    @RequirePermission(SETTLE_PERMISSION)
    public void retiredImmediatePayment(@PathVariable String billNo) {
        throw new ResponseStatusException(
            HttpStatus.GONE,
            "旧立即付款接口已退役，请使用 /api/finance/payments/draft 创建正式付款单"
        );
    }

    private void requireReadPermission() {
        if (!permissionService.hasPermission(REPORT_PERMISSION)
            && !permissionService.hasPermission(SETTLE_PERMISSION)) {
            throw new ResponseStatusException(
                HttpStatus.FORBIDDEN,
                "当前角色无权查看收付款单"
            );
        }
    }
}
