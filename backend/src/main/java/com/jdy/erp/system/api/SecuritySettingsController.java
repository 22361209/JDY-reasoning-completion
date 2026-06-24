package com.jdy.erp.system.api;

import java.util.Map;

import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.security.RequirePermission;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/system/security-settings")
public class SecuritySettingsController {
    private final CurrentSessionService currentSessionService;

    public SecuritySettingsController(CurrentSessionService currentSessionService) {
        this.currentSessionService = currentSessionService;
    }

    @GetMapping
    @RequirePermission("system.security.manage")
    public Map<String, Object> settings() {
        var sessionTimeoutMinutes = currentSessionService.sessionTimeoutMinutes();
        return Map.of(
            "repeatedLoginPolicy", currentSessionService.repeatedLoginPolicy(),
            "repeatedLoginPolicyLabel", repeatedLoginPolicyLabel(currentSessionService.repeatedLoginPolicy()),
            "sessionTimeoutMinutes", sessionTimeoutMinutes,
            "sessionTimeoutSeconds", sessionTimeoutMinutes * 60
        );
    }

    @PutMapping
    @RequirePermission("system.security.manage")
    public Map<String, Object> updateSettings(@RequestBody SecuritySettingsRequest request) {
        currentSessionService.updateRepeatedLoginPolicy(request.repeatedLoginPolicy());
        currentSessionService.updateSessionTimeoutMinutes(request.sessionTimeoutMinutes());
        return settings();
    }

    private String repeatedLoginPolicyLabel(String policy) {
        if ("ALLOW_CONCURRENT".equals(policy)) {
            return "允许同账号多端同时在线";
        }
        return "后登录踢下线旧会话";
    }

    public record SecuritySettingsRequest(String repeatedLoginPolicy, Integer sessionTimeoutMinutes) {
    }
}
