package com.jdy.erp.outsourcing.api;

import java.util.Map;

import com.jdy.erp.outsourcing.application.OutsourcingDocumentAppService;
import com.jdy.erp.outsourcing.application.OutsourcingDocumentAppService.QtyRequest;
import com.jdy.erp.outsourcing.application.OutsourcingDocumentAppService.WorkOrderRequest;
import com.jdy.erp.outsourcing.application.OutsourcingSurfaceAppService;
import com.jdy.erp.outsourcing.application.OutsourcingSurfaceAppService.SurfaceProcessRequest;
import com.jdy.erp.system.security.RequirePermission;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/outsourcing")
public class OutsourcingController {
    private final OutsourcingSurfaceAppService surfaceAppService;
    private final OutsourcingDocumentAppService documentAppService;

    public OutsourcingController(OutsourcingSurfaceAppService surfaceAppService, OutsourcingDocumentAppService documentAppService) {
        this.surfaceAppService = surfaceAppService;
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

    @PostMapping("/receipts/{billNo}/audit")
    @RequirePermission("production.document.audit")
    public Map<String, Object> auditReceipt(@PathVariable String billNo) {
        return documentAppService.auditReceipt(billNo);
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

    @PostMapping("/scraps/{billNo}/audit")
    @RequirePermission("production.document.audit")
    public Map<String, Object> auditScrap(@PathVariable String billNo) {
        return documentAppService.auditScrap(billNo);
    }

    @PostMapping("/surface-processes/draft")
    @RequirePermission("production.document.audit")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> saveSurfaceDraft(@RequestBody SurfaceProcessRequest request) {
        return surfaceAppService.saveDraft(request);
    }

    @PostMapping("/surface-processes/{billNo}/audit")
    @RequirePermission("production.document.audit")
    public Map<String, Object> auditSurface(@PathVariable String billNo) {
        return surfaceAppService.audit(billNo);
    }

    @PostMapping("/surface-processes/{billNo}/complete")
    @RequirePermission("production.document.audit")
    public Map<String, Object> completeSurface(@PathVariable String billNo) {
        return surfaceAppService.complete(billNo);
    }
}
