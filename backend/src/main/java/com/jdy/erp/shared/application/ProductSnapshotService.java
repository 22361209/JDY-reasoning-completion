package com.jdy.erp.shared.application;

import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

@Service
public class ProductSnapshotService {
    private final JdbcTemplate jdbcTemplate;

    public ProductSnapshotService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public ProductSnapshot resolve(String productId, String productCode, String label) {
        if (productId != null && !productId.isBlank()) {
            return byId(productId.trim(), label);
        }
        if (productCode == null || productCode.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不能为空");
        }
        return byCode(productCode.trim(), label);
    }

    public ProductSnapshot byId(String productId, String label) {
        try {
            UUID.fromString(productId);
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "系统ID格式不正确");
        }
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   code,
                   name,
                   COALESCE(spec, '') AS spec
            FROM md_product
            WHERE id = ?::uuid
            """, productId);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不存在");
        }
        var row = rows.get(0);
        return new ProductSnapshot(
            String.valueOf(row.get("id")),
            String.valueOf(row.get("code")),
            String.valueOf(row.get("name")),
            String.valueOf(row.get("spec"))
        );
    }

    private ProductSnapshot byCode(String productCode, String label) {
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   code,
                   name,
                   COALESCE(spec, '') AS spec
            FROM md_product
            WHERE code = ? AND enabled = TRUE
            """, productCode);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不存在或已禁用");
        }
        var row = rows.get(0);
        return new ProductSnapshot(
            String.valueOf(row.get("id")),
            String.valueOf(row.get("code")),
            String.valueOf(row.get("name")),
            String.valueOf(row.get("spec"))
        );
    }

    public record ProductSnapshot(String id, String code, String name, String spec) {
    }
}
