package com.jdy.erp.shared.api;

import java.util.Map;

import com.jdy.erp.shared.application.NumberingService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/numbering")
public class NumberingController {
    private final NumberingService numberingService;

    public NumberingController(NumberingService numberingService) {
        this.numberingService = numberingService;
    }

    @GetMapping("/{documentType}/next")
    public Map<String, Object> nextBillNo(@PathVariable String documentType) {
        return Map.of("documentType", documentType, "billNo", numberingService.nextBillNo(documentType));
    }
}
