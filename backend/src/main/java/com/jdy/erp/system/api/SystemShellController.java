package com.jdy.erp.system.api;

import java.util.List;
import java.util.Map;

import com.jdy.erp.system.security.CurrentSessionService;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/system")
public class SystemShellController {
    private final JdbcTemplate jdbcTemplate;
    private final CurrentSessionService currentSessionService;

    public SystemShellController(JdbcTemplate jdbcTemplate, CurrentSessionService currentSessionService) {
        this.jdbcTemplate = jdbcTemplate;
        this.currentSessionService = currentSessionService;
    }

    @GetMapping("/session")
    public Map<String, Object> session() {
        if (!currentSessionService.isAuthenticated()) {
            return Map.of(
                "authenticated", false,
                "tenant", Map.of("name", "博莱德机械测试账套", "environment", "本地开发"),
                "period", Map.of("accounting", "2026-06", "business", "2026-06")
            );
        }
        return Map.of(
            "authenticated", true,
            "user", currentSessionService.currentUser(),
            "tenant", Map.of("name", "博莱德机械测试账套", "environment", "本地开发"),
            "period", Map.of("accounting", "2026-06", "business", "2026-06")
        );
    }

    @GetMapping("/users")
    public Map<String, Object> users() {
        var users = jdbcTemplate.queryForList("""
            SELECT u.username,
                   u.display_name AS "displayName",
                   r.code AS "roleCode",
                   r.name AS "roleName"
            FROM sys_user u
            JOIN sys_user_role ur ON ur.user_id = u.id
            JOIN sys_role r ON r.id = ur.role_id
            WHERE u.enabled = TRUE
              AND r.enabled = TRUE
            ORDER BY CASE r.code WHEN 'ADMIN' THEN 0 WHEN 'WAREHOUSE' THEN 1 WHEN 'FINANCE' THEN 2 ELSE 3 END, u.username
            """);
        return Map.of("users", users);
    }

    @PostMapping("/login")
    public Map<String, Object> login(@RequestBody LoginRequest request) {
        currentSessionService.login(request.username(), request.password());
        return session();
    }

    @PostMapping("/logout")
    public Map<String, Object> logout() {
        currentSessionService.logout();
        return Map.of("ok", true);
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

    public record LoginRequest(String username, String password) {
    }
}
