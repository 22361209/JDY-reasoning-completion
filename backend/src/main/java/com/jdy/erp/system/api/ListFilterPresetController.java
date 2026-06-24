package com.jdy.erp.system.api;

import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
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

    public ListFilterPresetController(JdbcTemplate jdbcTemplate, ObjectMapper objectMapper) {
        this.jdbcTemplate = jdbcTemplate;
        this.objectMapper = objectMapper;
    }

    @GetMapping("/{listKey}")
    public List<Map<String, Object>> presets(@PathVariable String listKey) {
        return jdbcTemplate.query("""
            SELECT id::text AS id,
                   list_key AS "listKey",
                   name,
                   query::text AS query,
                   column_filters::text AS "columnFilters",
                   shared,
                   is_default AS "isDefault",
                   read_only AS "readOnly",
                   to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS') AS "updatedAt"
            FROM sys_list_filter_preset
            WHERE list_key = ?
            ORDER BY is_default DESC, updated_at DESC, name
            """, (rs, rowNum) -> Map.of(
                "id", rs.getString("id"),
                "listKey", rs.getString("listKey"),
                "name", rs.getString("name"),
                "query", parseJson(rs.getString("query")),
                "columnFilters", parseJson(rs.getString("columnFilters")),
                "shared", rs.getBoolean("shared"),
                "isDefault", rs.getBoolean("isDefault"),
                "readOnly", rs.getBoolean("readOnly"),
                "updatedAt", rs.getString("updatedAt")
            ), listKey);
    }

    @PostMapping("/{listKey}")
    public Map<String, Object> save(@PathVariable String listKey, @RequestBody PresetRequest request) {
        var name = request.name == null || request.name.isBlank() ? "未命名预设" : request.name.trim();
        var readOnlyRows = jdbcTemplate.queryForList("""
            SELECT id::text
            FROM sys_list_filter_preset
            WHERE list_key = ?
              AND name = ?
              AND read_only = TRUE
            """, listKey, name);
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
                """, listKey);
        }
        var rows = jdbcTemplate.query("""
            INSERT INTO sys_list_filter_preset (list_key, name, query, column_filters, shared, is_default, read_only, updated_at)
            VALUES (?, ?, ?::jsonb, ?::jsonb, ?, ?, FALSE, now())
            ON CONFLICT (list_key, name) DO UPDATE
            SET query = EXCLUDED.query,
                column_filters = EXCLUDED.column_filters,
                shared = EXCLUDED.shared,
                is_default = EXCLUDED.is_default,
                updated_at = now()
            WHERE sys_list_filter_preset.read_only = FALSE
            RETURNING id::text, list_key, name, query::text, column_filters::text, shared, is_default, read_only,
                      to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS') AS updated_at
            """, (rs, rowNum) -> Map.<String, Object>of(
                "id", rs.getString("id"),
                "listKey", rs.getString("list_key"),
                "name", rs.getString("name"),
                "query", parseJson(rs.getString("query")),
                "columnFilters", parseJson(rs.getString("column_filters")),
                "shared", rs.getBoolean("shared"),
                "isDefault", rs.getBoolean("is_default"),
                "readOnly", rs.getBoolean("read_only"),
                "updatedAt", rs.getString("updated_at")
            ), listKey, name, query, columnFilters, request.shared == null || request.shared, isDefault);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "系统预设不可覆盖");
        }
        return rows.getFirst();
    }

    @DeleteMapping("/{listKey}/{id}")
    public Map<String, Object> delete(@PathVariable String listKey, @PathVariable String id) {
        var readOnlyRows = jdbcTemplate.queryForList("""
            SELECT id::text
            FROM sys_list_filter_preset
            WHERE list_key = ?
              AND id = ?::uuid
              AND read_only = TRUE
            """, listKey, id);
        if (!readOnlyRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "系统预设不可删除");
        }
        var deleted = jdbcTemplate.update("DELETE FROM sys_list_filter_preset WHERE list_key = ? AND id = ?::uuid AND read_only = FALSE", listKey, id);
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
        Map<String, Object> query,
        Map<String, Object> columnFilters,
        Boolean shared,
        Boolean isDefault
    ) {}
}
