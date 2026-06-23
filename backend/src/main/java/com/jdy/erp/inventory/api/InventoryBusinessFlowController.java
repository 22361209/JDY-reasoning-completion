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
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/inventory")
public class InventoryBusinessFlowController {
    private final InventoryPostingService postingService;

    public InventoryBusinessFlowController(InventoryPostingService postingService) {
        this.postingService = postingService;
    }

    @PostMapping("/sales-out")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> salesOut(@RequestBody InventoryBusinessPostRequest request) {
        return postingService.post(
            request.productCode(),
            request.warehouseCode(),
            positiveQty(request.qty()).negate(),
            "SALES_OUT",
            sourceBillType(request.sourceBillNo(), "SALES_OUT")
        );
    }

    @PostMapping("/purchase-in")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> purchaseIn(@RequestBody InventoryBusinessPostRequest request) {
        return postingService.post(
            request.productCode(),
            request.warehouseCode(),
            positiveQty(request.qty()),
            "PURCHASE_IN",
            sourceBillType(request.sourceBillNo(), "PURCHASE_IN")
        );
    }

    private BigDecimal positiveQty(BigDecimal qty) {
        if (qty == null || qty.compareTo(BigDecimal.ZERO) <= 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "数量必须大于 0");
        }
        return qty;
    }

    private String sourceBillType(String sourceBillNo, String fallback) {
        return sourceBillNo == null || sourceBillNo.isBlank() ? fallback : fallback + ":" + sourceBillNo.trim();
    }

    public record InventoryBusinessPostRequest(
        String productCode,
        String warehouseCode,
        BigDecimal qty,
        String sourceBillNo
    ) {
    }
}
