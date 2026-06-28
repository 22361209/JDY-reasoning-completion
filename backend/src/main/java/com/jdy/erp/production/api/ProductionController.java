package com.jdy.erp.production.api;

import java.util.Map;

import com.jdy.erp.production.application.MaterialIssueAppService;
import com.jdy.erp.production.application.MaterialIssueAppService.IssueRequest;
import com.jdy.erp.production.application.MaterialIssueAppService.RedReverseRequest;
import com.jdy.erp.production.application.ProductInAppService;
import com.jdy.erp.production.application.ProductInAppService.CompleteRequest;
import com.jdy.erp.production.application.ProductionTaskAppService;
import com.jdy.erp.production.application.ProductionTaskAppService.BomRequest;
import com.jdy.erp.production.application.ProductionTaskAppService.PlanRequest;
import com.jdy.erp.production.application.ProductionTaskAppService.TaskRequest;
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

    @PostMapping("/tasks/{billNo}/issue")
    @RequirePermission("production.document.audit")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> issue(@PathVariable String billNo, @RequestBody IssueRequest request) {
        return materialIssueAppService.issue(billNo, request);
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
