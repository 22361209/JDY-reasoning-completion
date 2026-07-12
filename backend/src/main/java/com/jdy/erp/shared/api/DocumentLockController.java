package com.jdy.erp.shared.api;

import java.util.Map;

import com.jdy.erp.shared.application.DocumentLockService;
import com.jdy.erp.system.security.RequirePermission;
import com.jdy.erp.system.security.RequireDocumentPermission;
import com.jdy.erp.system.security.WriteAccess;
import com.jdy.erp.system.security.WriteAccess.Policy;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/document-locks")
public class DocumentLockController {
    private final DocumentLockService lockService;

    public DocumentLockController(DocumentLockService lockService) {
        this.lockService = lockService;
    }

    @GetMapping("/{type}/{billNo}")
    @RequireDocumentPermission
    public Map<String, Object> status(@PathVariable String type, @PathVariable String billNo) {
        return lockService.status(type, billNo);
    }

    @PostMapping("/{type}/{billNo}/acquire")
    @RequireDocumentPermission
    public Map<String, Object> acquire(@PathVariable String type, @PathVariable String billNo) {
        return lockService.acquire(type, billNo);
    }

    @PostMapping("/{type}/{billNo}/override")
    @RequirePermission("document.lock.override")
    public Map<String, Object> override(@PathVariable String type, @PathVariable String billNo) {
        return lockService.override(type, billNo);
    }

    @DeleteMapping("/{type}/{billNo}")
    @WriteAccess(Policy.RELEASE_OWN_DOCUMENT_LOCK)
    public Map<String, Object> release(@PathVariable String type, @PathVariable String billNo) {
        return lockService.release(type, billNo);
    }
}
