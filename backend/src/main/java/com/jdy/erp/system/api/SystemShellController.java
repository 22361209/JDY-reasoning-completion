package com.jdy.erp.system.api;

import java.util.List;
import java.util.Map;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/system")
public class SystemShellController {
    private final JdbcTemplate jdbcTemplate;

    public SystemShellController(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @GetMapping("/session")
    public Map<String, Object> session() {
        var userRows = jdbcTemplate.queryForList("""
            SELECT u.username,
                   u.display_name AS "displayName",
                   r.code AS "roleCode",
                   r.name AS "roleName"
            FROM sys_user u
            JOIN sys_user_role ur ON ur.user_id = u.id
            JOIN sys_role r ON r.id = ur.role_id
            WHERE u.username = 'admin'
            ORDER BY CASE r.code WHEN 'ADMIN' THEN 0 ELSE 1 END
            LIMIT 1
            """);
        var roleCode = userRows.isEmpty() ? "ADMIN" : String.valueOf(userRows.get(0).get("roleCode"));
        var permissionCodes = jdbcTemplate.queryForList("""
            SELECT p.permission_code
            FROM sys_permission p
            JOIN sys_role r ON r.id = p.role_id
            LEFT JOIN sys_permission_catalog c ON c.permission_code = p.permission_code
            WHERE r.code = ?
              AND p.enabled = TRUE
            ORDER BY c.sort_no, p.permission_code
            """, String.class, roleCode);
        var user = userRows.isEmpty()
            ? Map.of(
                "name", "本地管理员",
                "username", "admin",
                "role", "系统管理员",
                "roleCode", "ADMIN",
                "permissionCodes", permissionCodes
            )
            : Map.of(
                "name", String.valueOf(userRows.get(0).get("displayName")),
                "username", String.valueOf(userRows.get(0).get("username")),
                "role", String.valueOf(userRows.get(0).get("roleName")),
                "roleCode", roleCode,
                "permissionCodes", permissionCodes
            );
        return Map.of(
            "user", user,
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
