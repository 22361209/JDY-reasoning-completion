package com.jdy.erp.masterdata.api;

import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/master-data")
public class MasterDataController {
    private final JdbcTemplate jdbcTemplate;

    public MasterDataController(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @PostMapping("/{type}")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> create(@PathVariable String type, @RequestBody Map<String, String> payload) {
        var code = required(payload, "code");
        var name = required(payload, "name");
        var enabled = !"禁用".equals(payload.getOrDefault("status", "启用"));
        return switch (type) {
            case "product" -> createProduct(code, name, payload, enabled);
            case "customer" -> createCustomer(code, name, payload, enabled);
            case "supplier" -> createSupplier(code, name, payload, enabled);
            case "warehouse" -> createWarehouse(code, name, payload, enabled);
            default -> throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Unsupported master data type");
        };
    }

    @PutMapping("/{type}/{code}")
    public Map<String, Object> update(@PathVariable String type, @PathVariable String code, @RequestBody Map<String, String> payload) {
        var name = required(payload, "name");
        var enabled = !"禁用".equals(payload.getOrDefault("status", "启用"));
        return switch (type) {
            case "product" -> updateProduct(code, name, payload, enabled);
            case "customer" -> updateCustomer(code, name, payload, enabled);
            case "supplier" -> updateSupplier(code, name, payload, enabled);
            case "warehouse" -> updateWarehouse(code, name, payload, enabled);
            default -> throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Unsupported master data type");
        };
    }

    @PatchMapping("/{type}/{code}/status")
    public Map<String, Object> updateStatus(@PathVariable String type, @PathVariable String code, @RequestBody Map<String, String> payload) {
        var enabled = !"禁用".equals(payload.getOrDefault("status", "启用"));
        return setEnabled(tableName(type), code, enabled);
    }

    @DeleteMapping("/{type}/{code}")
    public Map<String, Object> delete(@PathVariable String type, @PathVariable String code) {
        return setEnabled(tableName(type), code, false);
    }

    private Map<String, Object> createProduct(String code, String name, Map<String, String> payload, boolean enabled) {
        return jdbcTemplate.queryForMap("""
            INSERT INTO md_product (code, name, spec, category, unit, enabled)
            VALUES (?, ?, ?, ?, ?, ?)
            RETURNING id::text AS id, code, name
            """,
            code,
            name,
            payload.getOrDefault("spec", ""),
            payload.getOrDefault("category", "成品总成"),
            payload.getOrDefault("unit", "只"),
            enabled
        );
    }

    private Map<String, Object> createCustomer(String code, String name, Map<String, String> payload, boolean enabled) {
        return jdbcTemplate.queryForMap("""
            INSERT INTO md_customer (code, name, contact, phone, region, enabled)
            VALUES (?, ?, ?, ?, ?, ?)
            RETURNING id::text AS id, code, name
            """,
            code,
            name,
            payload.getOrDefault("contact", ""),
            payload.getOrDefault("phone", ""),
            payload.getOrDefault("region", ""),
            enabled
        );
    }

    private Map<String, Object> createSupplier(String code, String name, Map<String, String> payload, boolean enabled) {
        return jdbcTemplate.queryForMap("""
            INSERT INTO md_supplier (code, name, contact, phone, enabled)
            VALUES (?, ?, ?, ?, ?)
            RETURNING id::text AS id, code, name
            """,
            code,
            name,
            payload.getOrDefault("contact", ""),
            payload.getOrDefault("phone", ""),
            enabled
        );
    }

    private Map<String, Object> createWarehouse(String code, String name, Map<String, String> payload, boolean enabled) {
        var allowNegative = "允许负库存".equals(payload.getOrDefault("stockPolicy", "不允许负库存"));
        return jdbcTemplate.queryForMap("""
            INSERT INTO md_warehouse (code, name, allow_negative_stock, enabled)
            VALUES (?, ?, ?, ?)
            RETURNING id::text AS id, code, name
            """,
            code,
            name,
            allowNegative,
            enabled
        );
    }

    private Map<String, Object> updateProduct(String code, String name, Map<String, String> payload, boolean enabled) {
        return updateAndReturn("""
            UPDATE md_product
            SET name = ?, spec = ?, category = ?, unit = ?, enabled = ?, updated_at = now(), version = version + 1
            WHERE code = ?
            RETURNING id::text AS id, code, name
            """,
            name,
            payload.getOrDefault("spec", ""),
            payload.getOrDefault("category", "成品总成"),
            payload.getOrDefault("unit", "只"),
            enabled,
            code
        );
    }

    private Map<String, Object> updateCustomer(String code, String name, Map<String, String> payload, boolean enabled) {
        return updateAndReturn("""
            UPDATE md_customer
            SET name = ?, contact = ?, phone = ?, region = ?, enabled = ?, updated_at = now(), version = version + 1
            WHERE code = ?
            RETURNING id::text AS id, code, name
            """,
            name,
            payload.getOrDefault("contact", ""),
            payload.getOrDefault("phone", ""),
            payload.getOrDefault("region", ""),
            enabled,
            code
        );
    }

    private Map<String, Object> updateSupplier(String code, String name, Map<String, String> payload, boolean enabled) {
        return updateAndReturn("""
            UPDATE md_supplier
            SET name = ?, contact = ?, phone = ?, enabled = ?, updated_at = now(), version = version + 1
            WHERE code = ?
            RETURNING id::text AS id, code, name
            """,
            name,
            payload.getOrDefault("contact", ""),
            payload.getOrDefault("phone", ""),
            enabled,
            code
        );
    }

    private Map<String, Object> updateWarehouse(String code, String name, Map<String, String> payload, boolean enabled) {
        var allowNegative = "允许负库存".equals(payload.getOrDefault("stockPolicy", "不允许负库存"));
        return updateAndReturn("""
            UPDATE md_warehouse
            SET name = ?, allow_negative_stock = ?, enabled = ?, updated_at = now(), version = version + 1
            WHERE code = ?
            RETURNING id::text AS id, code, name
            """,
            name,
            allowNegative,
            enabled,
            code
        );
    }

    private Map<String, Object> setEnabled(String table, String code, boolean enabled) {
        return updateAndReturn("UPDATE " + table + " SET enabled = ?, updated_at = now(), version = version + 1 WHERE code = ? RETURNING id::text AS id, code, name",
            enabled,
            code
        );
    }

    private Map<String, Object> updateAndReturn(String sql, Object... args) {
        var rows = jdbcTemplate.queryForList(sql, args);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "master data not found");
        }
        return rows.get(0);
    }

    private String tableName(String type) {
        return switch (type) {
            case "product" -> "md_product";
            case "customer" -> "md_customer";
            case "supplier" -> "md_supplier";
            case "warehouse" -> "md_warehouse";
            default -> throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Unsupported master data type");
        };
    }

    private String required(Map<String, String> payload, String field) {
        var value = payload.getOrDefault(field, "").trim();
        if (value.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, field + " is required");
        }
        return value;
    }

    @ExceptionHandler(DataIntegrityViolationException.class)
    @ResponseStatus(HttpStatus.CONFLICT)
    public Map<String, String> conflict() {
        return Map.of("message", "code already exists");
    }
}
