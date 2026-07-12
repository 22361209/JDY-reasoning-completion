package com.jdy.erp.system.api;

import java.time.OffsetDateTime;
import java.util.Map;

import com.jdy.erp.inventory.application.InventoryTestAdjustmentAccessPolicy;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/system")
public class SystemHealthController {
    private final InventoryTestAdjustmentAccessPolicy inventoryTestAdjustmentAccessPolicy;

    public SystemHealthController(InventoryTestAdjustmentAccessPolicy inventoryTestAdjustmentAccessPolicy) {
        this.inventoryTestAdjustmentAccessPolicy = inventoryTestAdjustmentAccessPolicy;
    }

    @GetMapping("/health")
    public Map<String, Object> health() {
        return Map.of(
            "status", "UP",
            "service", "jdy-erp",
            "testInventoryAdjustmentApi", inventoryTestAdjustmentAccessPolicy.isEnabledForAccountSet("BLD-TEST"),
            "time", OffsetDateTime.now().toString()
        );
    }
}
