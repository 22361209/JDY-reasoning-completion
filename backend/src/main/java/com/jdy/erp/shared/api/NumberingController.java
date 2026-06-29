package com.jdy.erp.shared.api;

import java.util.Map;

import com.jdy.erp.shared.application.NumberingService;
import com.jdy.erp.system.security.RequirePermission;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
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

    @GetMapping("/rules")
    @RequirePermission("system.numbering_rule.manage")
    public Map<String, Object> rules() {
        return Map.of("rules", numberingService.listRules());
    }

    @PutMapping("/rules/{documentType}")
    @RequirePermission("system.numbering_rule.manage")
    public Map<String, Object> saveRule(@PathVariable String documentType, @RequestBody NumberingRuleRequest request) {
        return numberingService.saveRule(documentType, request.prefix(), request.width(), request.lastNumber(), request.enabled());
    }

    public record NumberingRuleRequest(String prefix, Integer width, Integer lastNumber, Boolean enabled) {
    }
}
