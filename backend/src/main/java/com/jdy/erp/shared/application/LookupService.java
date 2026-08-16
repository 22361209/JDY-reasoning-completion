package com.jdy.erp.shared.application;

import java.util.Set;

import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class LookupService {
    private static final Set<String> ENABLED_LOOKUP_TABLES = Set.of(
        "md_customer",
        "md_supplier",
        "md_product",
        "md_warehouse",
        "md_product_category",
        "md_unit",
        "md_production_department"
    );

    private final JdbcTemplate jdbcTemplate;
    private final ValidationService validationService;

    public LookupService(JdbcTemplate jdbcTemplate, ValidationService validationService) {
        this.jdbcTemplate = jdbcTemplate;
        this.validationService = validationService;
    }

    public String lookupEnabledId(String table, String code, String label) {
        return lookupEnabledId(table, code, label, false);
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public String lookupEnabledIdForReference(String table, String code, String label) {
        return lookupEnabledId(table, code, label, true);
    }

    private String lookupEnabledId(String table, String code, String label, boolean lockForReference) {
        if (!ENABLED_LOOKUP_TABLES.contains(table)) {
            throw new IllegalArgumentException("Unsupported lookup table: " + table);
        }
        var normalizedCode = validationService.required(code, label + "编码");
        var rows = jdbcTemplate.queryForList(
            "SELECT id::text AS id FROM " + table
                + " WHERE code = ? AND enabled = TRUE AND audit_status = 'AUDITED'"
                + (lockForReference ? " FOR KEY SHARE" : ""),
            normalizedCode
        );
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不存在、未审核或已禁用");
        }
        return String.valueOf(rows.get(0).get("id"));
    }
}
