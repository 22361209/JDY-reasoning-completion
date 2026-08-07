package com.jdy.erp.system.api;

import java.time.OffsetDateTime;
import java.util.Map;

import com.jdy.erp.inventory.application.InventoryTestAdjustmentAccessPolicy;
import com.jdy.erp.system.security.RegressionSharedAdminLoginGuard;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/system")
public class SystemHealthController {
    private final InventoryTestAdjustmentAccessPolicy inventoryTestAdjustmentAccessPolicy;
    private final RegressionSharedAdminLoginGuard regressionSharedAdminLoginGuard;
    private final String devBuildFingerprint;

    public SystemHealthController(
        InventoryTestAdjustmentAccessPolicy inventoryTestAdjustmentAccessPolicy,
        RegressionSharedAdminLoginGuard regressionSharedAdminLoginGuard,
        @Value("${jdy.dev.build-fingerprint:}") String devBuildFingerprint
    ) {
        this.inventoryTestAdjustmentAccessPolicy = inventoryTestAdjustmentAccessPolicy;
        this.regressionSharedAdminLoginGuard = regressionSharedAdminLoginGuard;
        this.devBuildFingerprint = devBuildFingerprint == null ? "" : devBuildFingerprint.trim();
    }

    @GetMapping("/health")
    public Map<String, Object> health(HttpServletRequest request) {
        return Map.of(
            "status", "UP",
            "service", "jdy-erp",
            "devBuildFingerprint", devBuildFingerprint,
            "testInventoryAdjustmentApi", inventoryTestAdjustmentAccessPolicy.isEnabledForAccountSet("BLD-TEST"),
            "regressionSharedAdminLoginGuard", regressionSharedAdminLoginGuard.isSharedAdminLoginGuardActive(request),
            "regressionSharedAdminLoginActiveCount", regressionSharedAdminLoginGuard.activeSharedAdminLoginCount(request),
            "time", OffsetDateTime.now().toString()
        );
    }
}
