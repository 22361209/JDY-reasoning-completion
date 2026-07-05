package com.jdy.erp.outsourcing.api;

import java.util.List;
import java.util.Map;

import com.jdy.erp.outsourcing.application.OutsourcingDocumentAppService;
import com.jdy.erp.outsourcing.application.OutsourcingDocumentAppService.QtyRequest;
import com.jdy.erp.outsourcing.application.OutsourcingDocumentAppService.WorkOrderRequest;
import com.jdy.erp.system.security.RequirePermission;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/outsourcing")
public class OutsourcingController {
    private final OutsourcingDocumentAppService documentAppService;

    public OutsourcingController(OutsourcingDocumentAppService documentAppService) {
        this.documentAppService = documentAppService;
    }

    @PostMapping("/work-orders/draft")
    @RequirePermission("production.document.audit")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> saveWorkOrder(@RequestBody WorkOrderRequest request) {
        return documentAppService.saveWorkOrder(request);
    }

    @PostMapping("/work-orders/{billNo}/audit")
    @RequirePermission("production.document.audit")
    public Map<String, Object> auditWorkOrder(@PathVariable String billNo) {
        return documentAppService.auditWorkOrder(billNo);
    }

    @GetMapping("/work-orders/{billNo}")
    @RequirePermission("production.document.audit")
    public Map<String, Object> workOrderDetail(@PathVariable String billNo) {
        return documentAppService.workOrderDetail(billNo);
    }

    @PostMapping("/work-orders/{billNo}/reverse")
    @RequirePermission("production.document.audit")
    public Map<String, Object> reverseWorkOrder(@PathVariable String billNo) {
        return documentAppService.reverseWorkOrder(billNo);
    }

    @GetMapping("/work-orders/sources")
    @RequirePermission("production.document.audit")
    public List<Map<String, Object>> workOrderSources(@RequestParam(defaultValue = "issue") String target) {
        return documentAppService.workOrderSources(target);
    }

    @PostMapping("/work-orders/{billNo}/push-issue")
    @RequirePermission("production.document.audit")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> pushIssue(@PathVariable String billNo) {
        return documentAppService.pushIssue(billNo);
    }

    @PostMapping("/work-orders/{billNo}/push-receipt")
    @RequirePermission("production.document.audit")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> pushReceipt(@PathVariable String billNo, @RequestBody(required = false) QtyRequest request) {
        return documentAppService.pushReceipt(billNo, request);
    }

    @PostMapping("/issues/{billNo}/audit")
    @RequirePermission("production.document.audit")
    public Map<String, Object> auditIssue(@PathVariable String billNo) {
        return documentAppService.auditIssue(billNo);
    }

    @GetMapping("/issues/{billNo}")
    @RequirePermission("production.document.audit")
    public Map<String, Object> issueDetail(@PathVariable String billNo) {
        return documentAppService.issueDetail(billNo);
    }

    @PostMapping("/issues/{billNo}/reverse")
    @RequirePermission("production.document.audit")
    public Map<String, Object> reverseIssue(@PathVariable String billNo) {
        return documentAppService.reverseIssue(billNo);
    }

    @PostMapping("/receipts/{billNo}/audit")
    @RequirePermission("production.document.audit")
    public Map<String, Object> auditReceipt(@PathVariable String billNo) {
        return documentAppService.auditReceipt(billNo);
    }

    @GetMapping("/receipts/{billNo}")
    @RequirePermission("production.document.audit")
    public Map<String, Object> receiptDetail(@PathVariable String billNo) {
        return documentAppService.receiptDetail(billNo);
    }

    @PostMapping("/receipts/{billNo}/reverse")
    @RequirePermission("production.document.audit")
    public Map<String, Object> reverseReceipt(@PathVariable String billNo) {
        return documentAppService.reverseReceipt(billNo);
    }

    @GetMapping("/receipts/sources")
    @RequirePermission("production.document.audit")
    public List<Map<String, Object>> receiptSources(@RequestParam(defaultValue = "return") String target) {
        return documentAppService.receiptSources(target);
    }

    @PostMapping("/receipts/{billNo}/push-return")
    @RequirePermission("production.document.audit")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> pushReturn(@PathVariable String billNo, @RequestBody(required = false) QtyRequest request) {
        return documentAppService.pushReturn(billNo, request);
    }

    @PostMapping("/receipts/{billNo}/push-scrap")
    @RequirePermission("production.document.audit")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> pushScrap(@PathVariable String billNo, @RequestBody(required = false) QtyRequest request) {
        return documentAppService.pushScrap(billNo, request);
    }

    @PostMapping("/returns/{billNo}/audit")
    @RequirePermission("production.document.audit")
    public Map<String, Object> auditReturn(@PathVariable String billNo) {
        return documentAppService.auditReturn(billNo);
    }

    @GetMapping("/returns/{billNo}")
    @RequirePermission("production.document.audit")
    public Map<String, Object> returnDetail(@PathVariable String billNo) {
        return documentAppService.returnDetail(billNo);
    }

    @PostMapping("/returns/{billNo}/reverse")
    @RequirePermission("production.document.audit")
    public Map<String, Object> reverseReturn(@PathVariable String billNo) {
        return documentAppService.reverseReturn(billNo);
    }

    @PostMapping("/scraps/{billNo}/audit")
    @RequirePermission("production.document.audit")
    public Map<String, Object> auditScrap(@PathVariable String billNo) {
        return documentAppService.auditScrap(billNo);
    }

    @GetMapping("/scraps/{billNo}")
    @RequirePermission("production.document.audit")
    public Map<String, Object> scrapDetail(@PathVariable String billNo) {
        return documentAppService.scrapDetail(billNo);
    }

    @PostMapping("/scraps/{billNo}/reverse")
    @RequirePermission("production.document.audit")
    public Map<String, Object> reverseScrap(@PathVariable String billNo) {
        return documentAppService.reverseScrap(billNo);
    }

    @PostMapping("/surface-processes/draft")
    @RequirePermission("production.document.audit")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> saveSurfaceDraft() {
        throw retiredSurface();
    }

    @PostMapping("/surface-processes/{billNo}/audit")
    @RequirePermission("production.document.audit")
    public Map<String, Object> auditSurface(@PathVariable String billNo) {
        throw retiredSurface();
    }

    @PostMapping("/surface-processes/{billNo}/complete")
    @RequirePermission("production.document.audit")
    public Map<String, Object> completeSurface(@PathVariable String billNo) {
        throw retiredSurface();
    }

    private ResponseStatusException retiredSurface() {
        return new ResponseStatusException(HttpStatus.GONE, "委外表面处理单据已废弃，不能继续新增、审核或完成");
    }
}
