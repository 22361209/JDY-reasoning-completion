package com.jdy.erp.production.api;

import java.util.Map;

import com.jdy.erp.production.application.MaterialIssueAppService;
import com.jdy.erp.production.application.MaterialIssueAppService.IssueDraftRequest;
import com.jdy.erp.production.application.MaterialIssueAppService.IssueRequest;
import com.jdy.erp.production.application.MaterialIssueAppService.RedReverseRequest;
import com.jdy.erp.production.application.ProductInAppService;
import com.jdy.erp.production.application.ProductInAppService.CompleteRequest;
import com.jdy.erp.production.application.ProductionTaskAppService;
import com.jdy.erp.production.application.ProductionTaskAppService.BomAuditRequest;
import com.jdy.erp.production.application.ProductionTaskAppService.BomRequest;
import com.jdy.erp.production.application.ProductionTaskAppService.PlanRequest;
import com.jdy.erp.production.application.ProductionTaskAppService.TaskRequest;
import com.jdy.erp.system.security.RequirePermission;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/production")
public class ProductionController {
    private final ProductionTaskAppService taskAppService;
    private final MaterialIssueAppService materialIssueAppService;
    private final ProductInAppService productInAppService;

    public ProductionController(
        ProductionTaskAppService taskAppService,
        MaterialIssueAppService materialIssueAppService,
        ProductInAppService productInAppService
    ) {
        this.taskAppService = taskAppService;
        this.materialIssueAppService = materialIssueAppService;
        this.productInAppService = productInAppService;
    }

    @GetMapping("/material-issues/{billNo}")
    public Map<String, Object> issueDetail(@PathVariable String billNo) {
        return materialIssueAppService.detail(billNo);
    }

    @GetMapping("/product-ins/{billNo}")
    public Map<String, Object> completionDetail(@PathVariable String billNo) {
        return productInAppService.detail(billNo);
    }

    @PostMapping("/boms")
    @RequirePermission("master.data.manage")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> saveBom(@RequestBody BomRequest request) {
        return taskAppService.saveBom(request);
    }

    @GetMapping("/boms/{code}")
    @RequirePermission("master.data.manage")
    public Map<String, Object> bomDetail(@PathVariable String code) {
        return taskAppService.bomDetail(code);
    }

    @GetMapping("/boms/{code}/audit-preview")
    @RequirePermission("master.data.manage")
    public Map<String, Object> bomAuditPreview(@PathVariable String code) {
        return taskAppService.bomAuditPreview(code);
    }

    @PostMapping("/boms/{code}/audit")
    @RequirePermission("master.data.manage")
    public Map<String, Object> auditBom(@PathVariable String code, @RequestBody(required = false) BomAuditRequest request) {
        return taskAppService.auditBom(code, request);
    }

    @PostMapping("/boms/{code}/reverse")
    @RequirePermission("master.data.manage")
    public Map<String, Object> reverseBom(@PathVariable String code) {
        return taskAppService.reverseBom(code);
    }

    @PostMapping("/boms/{code}/enable")
    @RequirePermission("master.data.manage")
    public Map<String, Object> enableBom(@PathVariable String code) {
        return taskAppService.setBomEnabled(code, true);
    }

    @PostMapping("/boms/{code}/disable")
    @RequirePermission("master.data.manage")
    public Map<String, Object> disableBom(@PathVariable String code) {
        return taskAppService.setBomEnabled(code, false);
    }

    @DeleteMapping("/boms/{code}")
    @RequirePermission("master.data.manage")
    public Map<String, Object> deleteBom(@PathVariable String code) {
        return taskAppService.deleteBom(code);
    }

    @PostMapping("/tasks")
    @RequirePermission("production.task.audit")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> createTask(@RequestBody TaskRequest request) {
        return taskAppService.createTask(request);
    }

    @PostMapping("/plans")
    @RequirePermission("production.task.audit")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> createPlan(@RequestBody PlanRequest request) {
        return taskAppService.createPlan(request);
    }

    @PostMapping("/plans/{billNo}/audit")
    @RequirePermission("production.task.audit")
    public Map<String, Object> auditPlan(@PathVariable String billNo) {
        return taskAppService.auditPlan(billNo);
    }

    @PostMapping("/plans/{billNo}/reverse")
    @RequirePermission("production.task.audit")
    public Map<String, Object> reversePlan(@PathVariable String billNo) {
        return taskAppService.reversePlan(billNo);
    }

    @PostMapping("/plans/next-number")
    @RequirePermission("production.task.audit")
    public Map<String, Object> nextPlanNumber() {
        return taskAppService.nextPlanNumber();
    }

    @PostMapping("/plans/{billNo}/push-down")
    @RequirePermission("production.task.audit")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> pushDownPlan(@PathVariable String billNo) {
        return taskAppService.pushDownPlan(billNo);
    }

    @PostMapping("/plans/{billNo}/tasks")
    @RequirePermission("production.task.audit")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> createTaskFromPlan(@PathVariable String billNo, @RequestBody TaskRequest request) {
        return taskAppService.createTaskFromPlan(billNo, request);
    }

    @GetMapping("/plans/{billNo}/kit-analysis")
    @RequirePermission("production.task.audit")
    public Map<String, Object> kitAnalysis(@PathVariable String billNo) {
        return Map.of("planNo", billNo, "rows", taskAppService.kitAnalysis(billNo));
    }

    @PostMapping("/tasks/{billNo}/issue")
    @RequirePermission("production.document.audit")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> issue(@PathVariable String billNo, @RequestBody IssueRequest request) {
        return materialIssueAppService.issue(billNo, request);
    }

    @PostMapping("/material-issues/draft")
    @RequirePermission("production.document.audit")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> saveIssueDraft(@RequestBody IssueDraftRequest request) {
        return materialIssueAppService.saveDraft(request);
    }

    @PostMapping("/material-issues/{billNo}/audit")
    @RequirePermission("production.document.audit")
    public Map<String, Object> auditIssue(@PathVariable String billNo) {
        return materialIssueAppService.audit(billNo);
    }

    @PostMapping("/material-issues/{billNo}/reverse")
    @RequirePermission("production.document.audit")
    public Map<String, Object> reverseIssue(@PathVariable String billNo) {
        return materialIssueAppService.reverse(billNo);
    }

    @PostMapping("/material-issues/{billNo}/red-reverse")
    @RequirePermission("production.document.audit")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> redReverseIssue(@PathVariable String billNo, @RequestBody RedReverseRequest request) {
        return materialIssueAppService.redReverse(billNo, request);
    }

    @PostMapping("/material-issues/{billNo}/push-product-in")
    @RequirePermission("production.document.audit")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> pushProductInFromIssue(@PathVariable String billNo, @RequestBody(required = false) CompleteRequest request) {
        return productInAppService.completeFromIssue(billNo, request);
    }

    @PostMapping("/tasks/{billNo}/complete")
    @RequirePermission("production.document.audit")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> complete(@PathVariable String billNo, @RequestBody CompleteRequest request) {
        return productInAppService.complete(billNo, request);
    }

    @PostMapping("/product-ins/{billNo}/reverse")
    @RequirePermission("production.document.audit")
    public Map<String, Object> reverseCompletion(@PathVariable String billNo) {
        return productInAppService.reverse(billNo);
    }

    @PostMapping("/product-ins/{billNo}/red-reverse")
    @RequirePermission("production.document.audit")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> redReverseCompletion(@PathVariable String billNo, @RequestBody RedReverseRequest request) {
        return productInAppService.redReverse(billNo, request);
    }
}
