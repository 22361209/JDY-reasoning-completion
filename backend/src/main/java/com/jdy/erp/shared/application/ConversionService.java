package com.jdy.erp.shared.application;

import java.math.BigDecimal;
import java.util.Set;

import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

@Service
public class ConversionService {
    private static final Set<String> TABLES = Set.of("sales_order", "sales_order_line");
    private static final Set<String> QUANTITY_COLUMNS = Set.of("shipped_qty", "qty");
    private static final Set<String> STATUS_COLUMNS = Set.of("out_status");

    private final JdbcTemplate jdbcTemplate;

    public ConversionService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public void increaseExecutedQuantity(SourceExecutionSpec spec, String sourceId, Object sourceLineNo, BigDecimal qty) {
        guard(spec);
        var updated = jdbcTemplate.update("""
            UPDATE %s
            SET %s = %s + ?
            WHERE %s = ?::uuid
              AND %s = ?
              AND %s + ? <= %s
            """.formatted(
                spec.lineTable(),
                spec.executedQtyColumn(),
                spec.executedQtyColumn(),
                spec.lineOwnerColumn(),
                spec.lineNoColumn(),
                spec.executedQtyColumn(),
                spec.totalQtyColumn()
            ), qty, sourceId, sourceLineNo, qty);
        if (updated == 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, spec.overQuantityMessage());
        }
    }

    public void decreaseExecutedQuantity(SourceExecutionSpec spec, String sourceId, Object sourceLineNo, BigDecimal qty) {
        guard(spec);
        jdbcTemplate.update("""
            UPDATE %s
            SET %s = GREATEST(0, %s - ?)
            WHERE %s = ?::uuid AND %s = ?
            """.formatted(
                spec.lineTable(),
                spec.executedQtyColumn(),
                spec.executedQtyColumn(),
                spec.lineOwnerColumn(),
                spec.lineNoColumn()
            ), qty, sourceId, sourceLineNo);
    }

    public void refreshSourceStatus(SourceExecutionSpec spec, String sourceId) {
        guard(spec);
        jdbcTemplate.update("""
            UPDATE %s
            SET %s = CASE
                    WHEN NOT EXISTS (SELECT 1 FROM %s WHERE %s = ?::uuid AND %s > 0) THEN 'NOT_OUT'
                    WHEN NOT EXISTS (SELECT 1 FROM %s WHERE %s = ?::uuid AND %s < %s) THEN 'ALL_OUT'
                    ELSE 'PART_OUT'
                END,
                updated_at = now(),
                version = version + 1
            WHERE id = ?::uuid
            """.formatted(
                spec.headerTable(),
                spec.statusColumn(),
                spec.lineTable(),
                spec.lineOwnerColumn(),
                spec.executedQtyColumn(),
                spec.lineTable(),
                spec.lineOwnerColumn(),
                spec.executedQtyColumn(),
                spec.totalQtyColumn()
            ), sourceId, sourceId, sourceId);
    }

    private void guard(SourceExecutionSpec spec) {
        if (!TABLES.contains(spec.headerTable()) || !TABLES.contains(spec.lineTable())) {
            throw new IllegalArgumentException("Unsupported conversion table");
        }
        if (!QUANTITY_COLUMNS.contains(spec.executedQtyColumn()) || !QUANTITY_COLUMNS.contains(spec.totalQtyColumn())) {
            throw new IllegalArgumentException("Unsupported quantity column");
        }
        if (!STATUS_COLUMNS.contains(spec.statusColumn())) {
            throw new IllegalArgumentException("Unsupported status column");
        }
        if (!"order_id".equals(spec.lineOwnerColumn()) || !"line_no".equals(spec.lineNoColumn())) {
            throw new IllegalArgumentException("Unsupported source line key");
        }
    }

    public record SourceExecutionSpec(
        String headerTable,
        String lineTable,
        String lineOwnerColumn,
        String lineNoColumn,
        String executedQtyColumn,
        String totalQtyColumn,
        String statusColumn,
        String overQuantityMessage
    ) {
    }
}
