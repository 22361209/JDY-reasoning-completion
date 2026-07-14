package com.jdy.erp.shared.api;

import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import com.jdy.erp.shared.application.NumberingService;
import com.jdy.erp.system.security.RequirePermission;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/numbering")
public class NumberingController {
    private final NumberingService numberingService;

    public NumberingController(NumberingService numberingService) {
        this.numberingService = numberingService;
    }

    @GetMapping("/{documentType}/next")
    public Map<String, Object> nextBillNo(@PathVariable String documentType) {
        throw new ResponseStatusException(HttpStatus.GONE, "单据编号不支持预取号，请在首次保存草稿时由系统自动生成");
    }

    @GetMapping("/rules")
    @RequirePermission("system.numbering_rule.manage")
    public Map<String, Object> rules() {
        return Map.of("rules", numberingService.listRules());
    }

    @PutMapping("/rules/{documentType}")
    @RequirePermission("system.numbering_rule.manage")
    public Map<String, Object> saveRule(@PathVariable String documentType, @RequestBody NumberingRuleRequest request) {
        return numberingService.saveRule(
            documentType,
            request.prefix(),
            request.width(),
            request.lastNumber(),
            request.enabled(),
            request.version()
        );
    }

    public record NumberingRuleRequest(
        String prefix,
        Integer width,
        JsonNode lastNumber,
        Boolean enabled,
        JsonNode version
    ) {
    }
}
