package com.jdy.erp.shared.application;

import java.math.BigDecimal;
import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class ProductSnapshotService {
    private final JdbcTemplate jdbcTemplate;

    public ProductSnapshotService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public ProductSnapshot resolve(String productId, String productCode, String label) {
        return resolve(productId, productCode, label, false);
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public ProductSnapshot resolveForReference(String productId, String productCode, String label) {
        return resolve(productId, productCode, label, true);
    }

    private ProductSnapshot resolve(String productId, String productCode, String label, boolean lockForReference) {
        if (productId != null && !productId.isBlank()) {
            return byId(productId.trim(), label, lockForReference);
        }
        if (productCode == null || productCode.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不能为空");
        }
        return byCode(productCode.trim(), label, lockForReference);
    }

    public ProductSnapshot byId(String productId, String label) {
        return byId(productId, label, false);
    }

    private ProductSnapshot byId(String productId, String label, boolean lockForReference) {
        try {
            UUID.fromString(productId);
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "UUID格式不正确");
        }
        var sql = """
            SELECT id::text AS id,
                   code,
                   name,
                   COALESCE(spec, '') AS spec,
                   COALESCE(unit, '') AS unit,
                   net_weight AS "netWeight",
                   gross_weight AS "grossWeight"
            FROM md_product
            WHERE id = ?::uuid AND enabled = TRUE AND audit_status = 'AUDITED'
            """ + (lockForReference ? " FOR KEY SHARE" : "");
        var rows = jdbcTemplate.queryForList(sql, productId);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不存在、未审核或已禁用");
        }
        var row = rows.get(0);
        return new ProductSnapshot(
            String.valueOf(row.get("id")),
            String.valueOf(row.get("code")),
            String.valueOf(row.get("name")),
            String.valueOf(row.get("spec")),
            String.valueOf(row.get("unit")),
            decimal(row.get("netWeight")),
            decimal(row.get("grossWeight"))
        );
    }

    private ProductSnapshot byCode(String productCode, String label, boolean lockForReference) {
        var sql = """
            SELECT id::text AS id,
                   code,
                   name,
                   COALESCE(spec, '') AS spec,
                   COALESCE(unit, '') AS unit,
                   net_weight AS "netWeight",
                   gross_weight AS "grossWeight"
            FROM md_product
            WHERE code = ? AND enabled = TRUE AND audit_status = 'AUDITED'
            """ + (lockForReference ? " FOR KEY SHARE" : "");
        var rows = jdbcTemplate.queryForList(sql, productCode);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不存在、未审核或已禁用");
        }
        var row = rows.get(0);
        return new ProductSnapshot(
            String.valueOf(row.get("id")),
            String.valueOf(row.get("code")),
            String.valueOf(row.get("name")),
            String.valueOf(row.get("spec")),
            String.valueOf(row.get("unit")),
            decimal(row.get("netWeight")),
            decimal(row.get("grossWeight"))
        );
    }

    private BigDecimal decimal(Object value) {
        return value instanceof BigDecimal decimal ? decimal : null;
    }

    public record ProductSnapshot(String id, String code, String name, String spec, String unit, BigDecimal netWeight, BigDecimal grossWeight) {
    }
}
