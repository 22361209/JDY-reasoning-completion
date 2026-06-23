package com.jdy.erp.masterdata.api;

import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
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
