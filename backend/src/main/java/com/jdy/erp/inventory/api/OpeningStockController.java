package com.jdy.erp.inventory.api;

import java.util.List;
import java.util.Map;

import com.jdy.erp.inventory.application.OpeningStockService;
import com.jdy.erp.inventory.application.OpeningStockService.OpeningStockLineRequest;
import com.jdy.erp.system.security.RequirePermission;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/inventory/opening-stock")
@RequirePermission("inventory.opening_stock.manage")
public class OpeningStockController {
    private final OpeningStockService openingStockService;

    public OpeningStockController(OpeningStockService openingStockService) {
        this.openingStockService = openingStockService;
    }

    @GetMapping
    public Map<String, Object> rows() {
        return Map.of("rows", openingStockService.rows());
    }

    @PutMapping
    public Map<String, Object> save(@RequestBody OpeningStockRequest request) {
        return openingStockService.saveRows(request.lines());
    }

    public record OpeningStockRequest(List<OpeningStockLineRequest> lines) {
    }
}
