package com.jdy.erp.inventory.api;

import java.math.BigDecimal;
import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/inventory")
public class InventoryAdjustmentController {
    private final JdbcTemplate jdbcTemplate;

    public InventoryAdjustmentController(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @PostMapping("/adjustments")
    @ResponseStatus(HttpStatus.CREATED)
    @Transactional
    public Map<String, Object> adjust(@RequestBody InventoryAdjustmentRequest request) {
        var productId = lookupId("md_product", request.productCode(), "商品");
        var warehouseId = lookupId("md_warehouse", request.warehouseCode(), "仓库");
        var qtyDelta = request.qtyDelta();
        if (qtyDelta == null || BigDecimal.ZERO.compareTo(qtyDelta) == 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "调整数量不能为 0");
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
            request.txnType() == null || request.txnType().isBlank() ? "ADJUST" : request.txnType(),
            productId,
            warehouseId,
            qtyDelta,
            request.sourceBillType() == null || request.sourceBillType().isBlank() ? "MANUAL_ADJUSTMENT" : request.sourceBillType()
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

    public record InventoryAdjustmentRequest(
        String productCode,
        String warehouseCode,
        BigDecimal qtyDelta,
        String txnType,
        String sourceBillType
    ) {
    }
}
