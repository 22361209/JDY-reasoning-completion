package com.jdy.erp.inventory.application;

import java.math.BigDecimal;
import java.util.Map;

import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class InventoryPostingService {
    private final JdbcTemplate jdbcTemplate;

    public InventoryPostingService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @Transactional
    public Map<String, Object> post(String productCode, String warehouseCode, BigDecimal qtyDelta, String txnType, String sourceBillType) {
        var productId = lookupId("md_product", productCode, "商品");
        var warehouseId = lookupId("md_warehouse", warehouseCode, "仓库");
        if (qtyDelta == null || BigDecimal.ZERO.compareTo(qtyDelta) == 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "数量不能为 0");
        }

        jdbcTemplate.update("""
            INSERT INTO inv_stock_balance (product_id, warehouse_id, qty_on_hand, qty_available, qty_reserved)
            VALUES (?::uuid, ?::uuid, 0, 0, 0)
            ON CONFLICT (product_id, warehouse_id) DO NOTHING
            """, productId, warehouseId);

        Map<String, Object> updated;
        try {
            updated = jdbcTemplate.queryForMap("""
                UPDATE inv_stock_balance
                SET qty_on_hand = qty_on_hand + ?,
                    qty_available = qty_available + ?,
                    updated_at = now(),
                    version = version + 1
                WHERE product_id = ?::uuid
                  AND warehouse_id = ?::uuid
                  AND qty_on_hand + ? >= 0
                  AND qty_available + ? >= 0
                RETURNING id::text AS id,
                          trim(to_char(qty_on_hand, 'FM9999999990.####')) AS "onHand",
                          trim(to_char(qty_available, 'FM9999999990.####')) AS available
                """, qtyDelta, qtyDelta, productId, warehouseId, qtyDelta, qtyDelta);
        } catch (EmptyResultDataAccessException exception) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "库存不足，不能调整为负数");
        }

        jdbcTemplate.update("""
            INSERT INTO inv_stock_txn (txn_type, product_id, warehouse_id, qty_delta, source_bill_type, source_bill_id, amount)
            VALUES (?, ?::uuid, ?::uuid, ?, ?, gen_random_uuid(), 0)
            """,
            txnType == null || txnType.isBlank() ? "ADJUST" : txnType,
            productId,
            warehouseId,
            qtyDelta,
            sourceBillType == null || sourceBillType.isBlank() ? "MANUAL_ADJUSTMENT" : sourceBillType
        );
        return updated;
    }

    private String lookupId(String table, String code, String label) {
        if (code == null || code.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "编码不能为空");
        }
        var rows = jdbcTemplate.queryForList("SELECT id::text AS id FROM " + table + " WHERE code = ? AND enabled = TRUE", code.trim());
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不存在或已禁用");
        }
        return String.valueOf(rows.get(0).get("id"));
    }
}
