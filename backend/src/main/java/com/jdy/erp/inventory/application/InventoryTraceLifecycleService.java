package com.jdy.erp.inventory.application;

import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Protects immutable inventory history when a reversed draft replaces or
 * deletes its current source lines. Historical facts are never retargeted to
 * the replacement rows; only their trace metadata may be degraded.
 */
@Service
public class InventoryTraceLifecycleService {
    private final JdbcTemplate jdbcTemplate;

    public InventoryTraceLifecycleService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public int prepareForLineReplacement(String sourceBillType, Object sourceBillId) {
        if (sourceBillType == null || sourceBillType.isBlank() || sourceBillId == null) {
            throw new IllegalArgumentException("库存来源单据身份不能为空");
        }
        return jdbcTemplate.update("""
            UPDATE inv_stock_txn
            SET trace_quality = 'HEADER_ONLY',
                source_bill_line_id = NULL
            WHERE source_bill_type = ?
              AND source_bill_id = ?::uuid
              AND source_bill_line_id IS NOT NULL
              AND trace_quality = 'EXACT'
            """, sourceBillType.trim(), sourceBillId);
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void assertNoPostingHistory(Object sourceBillId) {
        if (sourceBillId == null) {
            throw new IllegalArgumentException("库存来源单据 id 不能为空");
        }
        var count = jdbcTemplate.queryForObject("""
            SELECT count(*)
            FROM inv_stock_txn
            WHERE source_bill_id = ?::uuid
            """, Long.class, sourceBillId);
        if (count != null && count > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "单据已有库存过账历史，不能物理删除");
        }
    }
}
