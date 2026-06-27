package com.jdy.erp.sales.api;

import java.util.Map;

import com.jdy.erp.sales.application.SalesPriceMemoryService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/sales-prices")
public class SalesPriceController {
    private final SalesPriceMemoryService priceMemoryService;

    public SalesPriceController(SalesPriceMemoryService priceMemoryService) {
        this.priceMemoryService = priceMemoryService;
    }

    @GetMapping("/unit-price")
    public Map<String, Object> unitPrice(@RequestParam String customerCode, @RequestParam String productCode) {
        return priceMemoryService.unitPrice(customerCode, productCode);
    }

    @GetMapping("/unit-price-sources")
    public Map<String, Object> unitPriceSources(@RequestParam String customerCode, @RequestParam String productCodes) {
        return priceMemoryService.unitPriceSources(customerCode, productCodes);
    }
}
