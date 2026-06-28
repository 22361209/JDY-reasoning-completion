package com.jdy.erp.outsourcing.api;

import java.util.Map;

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

    public OutsourcingController(OutsourcingSurfaceAppService surfaceAppService) {
        this.surfaceAppService = surfaceAppService;
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
