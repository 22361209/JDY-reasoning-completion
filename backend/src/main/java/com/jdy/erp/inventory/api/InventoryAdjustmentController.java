package com.jdy.erp.inventory.api;

import java.math.BigDecimal;
import java.util.Map;

import com.jdy.erp.inventory.application.InventoryPostingService;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/inventory")
public class InventoryAdjustmentController {
    private final InventoryPostingService postingService;

    public InventoryAdjustmentController(InventoryPostingService postingService) {
        this.postingService = postingService;
    }

    @PostMapping("/adjustments")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> adjust(@RequestBody InventoryAdjustmentRequest request) {
        return postingService.post(
            request.productCode(),
            request.warehouseCode(),
            request.qtyDelta(),
            request.txnType() == null || request.txnType().isBlank() ? "ADJUST" : request.txnType(),
            request.sourceBillType() == null || request.sourceBillType().isBlank() ? "MANUAL_ADJUSTMENT" : request.sourceBillType()
        );
    }

    public record InventoryAdjustmentRequest(
        String productCode,
        String warehouseCode,
        BigDecimal qtyDelta,
        String txnType,
        String sourceBillType
    ) {
    }
}
