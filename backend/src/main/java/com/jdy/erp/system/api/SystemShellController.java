package com.jdy.erp.system.api;

import java.util.List;
import java.util.Map;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/system")
public class SystemShellController {

    @GetMapping("/session")
    public Map<String, Object> session() {
        return Map.of(
            "user", Map.of("name", "本地管理员", "role", "系统管理员", "roleCode", "ADMIN"),
            "tenant", Map.of("name", "博莱德机械测试账套", "environment", "本地开发"),
            "period", Map.of("accounting", "2026-06", "business", "2026-06")
        );
    }

    @GetMapping("/period")
    public Map<String, Object> period() {
        return Map.of(
            "accountingPeriod", "2026-06",
            "businessPeriod", "2026-06",
            "locked", false
        );
    }

    @GetMapping("/navigation")
    public Map<String, Object> navigation() {
        return Map.of(
            "modules", List.of(
                "销售管理",
                "采购管理",
                "库存管理",
                "应收应付",
                "生产管理",
                "委外管理",
                "基础资料",
                "系统设置",
                "快捷应用"
            ),
            "excluded", List.of("老板参谋", "客户经营", "协同助手", "自定义中心")
        );
    }
}
