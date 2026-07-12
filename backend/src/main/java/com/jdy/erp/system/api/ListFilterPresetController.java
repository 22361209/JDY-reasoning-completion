package com.jdy.erp.system.api;

import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.jdy.erp.system.application.ListFilterPresetAccessPolicy;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.security.WriteAccess;
import com.jdy.erp.system.security.WriteAccess.Policy;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/list-presets")
public class ListFilterPresetController {
    private final JdbcTemplate jdbcTemplate;
    private final ObjectMapper objectMapper;
    private final ListFilterPresetAccessPolicy accessPolicy;
    private final CurrentSessionService currentSessionService;

    public ListFilterPresetController(
        JdbcTemplate jdbcTemplate,
        ObjectMapper objectMapper,
        ListFilterPresetAccessPolicy accessPolicy,
        CurrentSessionService currentSessionService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.objectMapper = objectMapper;
        this.accessPolicy = accessPolicy;
        this.currentSessionService = currentSessionService;
    }

    @GetMapping("/{listKey}")
    public List<Map<String, Object>> presets(@PathVariable String listKey) {
        var currentScope = accessPolicy.currentPersonalScope();
        return jdbcTemplate.query("""
            SELECT id::text AS id,
                   list_key AS "listKey",
                   name,
                   role_code AS "roleCode",
                   user_name AS "userName",
                   query::text AS query,
                   column_filters::text AS "columnFilters",
                   shared,
                   is_default AS "isDefault",
                   read_only AS "readOnly",
                   to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS') AS "updatedAt"
            FROM sys_list_filter_preset
            WHERE list_key = ?
              AND (
                  (user_name = ? AND role_code IS NOT DISTINCT FROM ?)
                  OR (user_name IS NULL AND role_code = ?)
                  OR (user_name IS NULL AND role_code IS NULL)
              )
            ORDER BY
              CASE
                WHEN user_name = ? AND role_code IS NOT DISTINCT FROM ? THEN 0
                WHEN user_name IS NULL AND role_code = ? THEN 1
                ELSE 2
              END,
              is_default DESC,
              updated_at DESC,
              name
            """, (rs, rowNum) -> Map.ofEntries(
                Map.entry("id", rs.getString("id")),
                Map.entry("listKey", rs.getString("listKey")),
                Map.entry("name", rs.getString("name")),
                Map.entry("roleCode", rs.getString("roleCode") == null ? "" : rs.getString("roleCode")),
                Map.entry("userName", rs.getString("userName") == null ? "" : rs.getString("userName")),
                Map.entry("query", parseJson(rs.getString("query"))),
                Map.entry("columnFilters", parseJson(rs.getString("columnFilters"))),
                Map.entry("shared", rs.getBoolean("shared")),
                Map.entry("isDefault", rs.getBoolean("isDefault")),
                Map.entry("readOnly", rs.getBoolean("readOnly")),
                Map.entry("updatedAt", rs.getString("updatedAt"))
            ),
            listKey,
            currentScope.userName(), currentScope.roleCode(),
            currentScope.roleCode(),
            currentScope.userName(), currentScope.roleCode(),
            currentScope.roleCode()
        );
    }

    @PostMapping("/{listKey}")
    @WriteAccess(Policy.SAVE_LIST_PRESET)
    public Map<String, Object> save(@PathVariable String listKey, @RequestBody PresetRequest request) {
        var name = request.name == null || request.name.isBlank() ? "未命名预设" : request.name.trim();
        var scope = accessPolicy.resolveWriteScope(request.scope, request.roleCode);
        var readOnlyRows = jdbcTemplate.queryForList("""
            SELECT id::text
            FROM sys_list_filter_preset
            WHERE list_key = ?
              AND name = ?
              AND role_code IS NOT DISTINCT FROM ?
              AND user_name IS NOT DISTINCT FROM ?
              AND read_only = TRUE
            """, listKey, name, scope.roleCode(), scope.userName());
        if (!readOnlyRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "系统预设不可覆盖");
        }
        var query = toJson(request.query == null ? Map.of() : request.query);
        var columnFilters = toJson(request.columnFilters == null ? Map.of() : request.columnFilters);
        var isDefault = request.isDefault != null && request.isDefault;
        if (isDefault) {
            jdbcTemplate.update("""
                UPDATE sys_list_filter_preset
                SET is_default = FALSE,
                    updated_at = now()
                WHERE list_key = ?
                  AND role_code IS NOT DISTINCT FROM ?
                  AND user_name IS NOT DISTINCT FROM ?
                """, listKey, scope.roleCode(), scope.userName());
        }
        var existingRows = jdbcTemplate.queryForList("""
            SELECT id::text
            FROM sys_list_filter_preset
            WHERE list_key = ?
              AND name = ?
              AND role_code IS NOT DISTINCT FROM ?
              AND user_name IS NOT DISTINCT FROM ?
            """, listKey, name, scope.roleCode(), scope.userName());
        if (!existingRows.isEmpty()) {
            jdbcTemplate.update("""
                UPDATE sys_list_filter_preset
                SET query = ?::jsonb,
                    column_filters = ?::jsonb,
                    shared = ?,
                    is_default = ?,
                    updated_at = now()
                WHERE id = ?::uuid
                  AND read_only = FALSE
                """, query, columnFilters, request.shared == null || request.shared, isDefault, existingRows.getFirst().get("id"));
        } else {
            var creatorUserId = currentSessionService.currentUserId();
            jdbcTemplate.update("""
                INSERT INTO sys_list_filter_preset (
                    list_key, name, role_code, user_name, query, column_filters,
                    shared, is_default, read_only, created_by, updated_at
                )
                VALUES (?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, FALSE, ?::uuid, now())
                """, listKey, name, scope.roleCode(), scope.userName(), query, columnFilters,
                request.shared == null || request.shared, isDefault, creatorUserId);
        }
        var rows = jdbcTemplate.query("""
            SELECT id::text, list_key, name, role_code, user_name, query::text, column_filters::text, shared, is_default, read_only,
                      to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS') AS updated_at
            FROM sys_list_filter_preset
            WHERE list_key = ?
              AND name = ?
              AND role_code IS NOT DISTINCT FROM ?
              AND user_name IS NOT DISTINCT FROM ?
            """, (rs, rowNum) -> Map.<String, Object>ofEntries(
                Map.entry("id", rs.getString("id")),
                Map.entry("listKey", rs.getString("list_key")),
                Map.entry("name", rs.getString("name")),
                Map.entry("roleCode", rs.getString("role_code") == null ? "" : rs.getString("role_code")),
                Map.entry("userName", rs.getString("user_name") == null ? "" : rs.getString("user_name")),
                Map.entry("query", parseJson(rs.getString("query"))),
                Map.entry("columnFilters", parseJson(rs.getString("column_filters"))),
                Map.entry("shared", rs.getBoolean("shared")),
                Map.entry("isDefault", rs.getBoolean("is_default")),
                Map.entry("readOnly", rs.getBoolean("read_only")),
                Map.entry("updatedAt", rs.getString("updated_at"))
            ), listKey, name, scope.roleCode(), scope.userName());
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "系统预设不可覆盖");
        }
        return rows.getFirst();
    }

    @DeleteMapping("/{listKey}/{id}")
    @WriteAccess(Policy.DELETE_LIST_PRESET)
    public Map<String, Object> delete(@PathVariable String listKey, @PathVariable String id) {
        var targetRows = jdbcTemplate.queryForList("""
            SELECT role_code AS "roleCode",
                   user_name AS "userName",
                   read_only AS "readOnly"
            FROM sys_list_filter_preset
            WHERE list_key = ?
              AND id = ?::uuid
            """, listKey, id);
        if (targetRows.isEmpty()) {
            return Map.of("deleted", 0);
        }
        var target = targetRows.getFirst();
        var roleCode = target.get("roleCode") == null ? null : String.valueOf(target.get("roleCode"));
        var userName = target.get("userName") == null ? null : String.valueOf(target.get("userName"));
        accessPolicy.requireCanModifyStoredScope(roleCode, userName);
        if (Boolean.TRUE.equals(target.get("readOnly"))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "系统预设不可删除");
        }
        var deleted = jdbcTemplate.update("""
            DELETE FROM sys_list_filter_preset
            WHERE list_key = ?
              AND id = ?::uuid
              AND read_only = FALSE
              AND role_code IS NOT DISTINCT FROM ?
              AND user_name IS NOT DISTINCT FROM ?
            """, listKey, id, roleCode, userName);
        return Map.of("deleted", deleted);
    }

    private Map<String, Object> parseJson(String json) {
        if (json == null || json.isBlank()) {
            return Map.of();
        }
        try {
            return objectMapper.readValue(json, new TypeReference<>() {});
        } catch (Exception ignored) {
            return Map.of();
        }
    }

    private String toJson(Map<String, Object> value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (Exception ignored) {
            return "{}";
        }
    }

    public record PresetRequest(
        String name,
        String scope,
        String roleCode,
        String userName,
        Map<String, Object> query,
        Map<String, Object> columnFilters,
        Boolean shared,
        Boolean isDefault
    ) {}

}
