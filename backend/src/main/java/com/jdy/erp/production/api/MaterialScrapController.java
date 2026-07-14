package com.jdy.erp.production.api;

import java.util.Map;

import com.jdy.erp.production.application.MaterialScrapAppService;
import com.jdy.erp.production.application.MaterialScrapAppService.ScrapDraftRequest;
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
@RequestMapping("/api")
@RequirePermission("production.document.audit")
public class MaterialScrapController {
    private final MaterialScrapAppService materialScrapAppService;

    public MaterialScrapController(MaterialScrapAppService materialScrapAppService) {
        this.materialScrapAppService = materialScrapAppService;
    }

    @GetMapping("/production/material-scraps/{billNo}")
    public Map<String, Object> detail(@PathVariable String billNo) {
        return materialScrapAppService.detail(billNo);
    }

    @GetMapping("/production/material-issues/{billNo}/material-scrap-preview")
    public Map<String, Object> previewFromIssue(@PathVariable String billNo) {
        return materialScrapAppService.previewFromIssue(billNo);
    }

    @PostMapping("/production/material-issues/{billNo}/push-material-scrap")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> pushFromIssue(
        @PathVariable String billNo,
        @RequestBody(required = false) ScrapDraftRequest request
    ) {
        return materialScrapAppService.pushFromIssue(billNo, request);
    }

    @PostMapping("/production/material-scraps/draft")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> saveDraft(@RequestBody ScrapDraftRequest request) {
        return materialScrapAppService.saveDraft(request);
    }

    @DeleteMapping("/production/material-scraps/{billNo}")
    public Map<String, Object> deleteDraft(@PathVariable String billNo) {
        return materialScrapAppService.deleteDraft(billNo);
    }

    @PostMapping("/production/material-scraps/{billNo}/audit")
    public Map<String, Object> audit(@PathVariable String billNo) {
        return materialScrapAppService.audit(billNo);
    }

    @PostMapping("/production/material-scraps/{billNo}/reverse")
    public Map<String, Object> reverse(@PathVariable String billNo) {
        return materialScrapAppService.reverse(billNo);
    }

    @PostMapping("/production/material-scraps/{billNo}/stock-in")
    public Map<String, Object> stockIn(@PathVariable String billNo) {
        return materialScrapAppService.stockIn(billNo);
    }

    @PostMapping("/production/material-scraps/{billNo}/reverse-stock-in")
    public Map<String, Object> reverseStockIn(@PathVariable String billNo) {
        return materialScrapAppService.reverseStockIn(billNo);
    }
}
