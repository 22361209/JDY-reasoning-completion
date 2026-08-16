package com.jdy.erp.inventory.application;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.List;
import java.util.Map;

import com.jdy.erp.shared.application.LookupService;
import com.jdy.erp.shared.application.ValidationService;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantDataScopeService;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;

@Service
public class OpeningStockService {
    private final JdbcTemplate jdbcTemplate;
    private final LookupService lookupService;
    private final ValidationService validationService;
    private final CurrentSessionService currentSessionService;
    private final TenantDataScopeService tenantDataScopeService;

    public OpeningStockService(
        JdbcTemplate jdbcTemplate,
        LookupService lookupService,
        ValidationService validationService,
        CurrentSessionService currentSessionService,
        TenantDataScopeService tenantDataScopeService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.lookupService = lookupService;
        this.validationService = validationService;
        this.currentSessionService = currentSessionService;
        this.tenantDataScopeService = tenantDataScopeService;
    }

    public List<Map<String, Object>> rows() {
        return jdbcTemplate.queryForList("""
            SELECT o.id::text AS id,
                   p.code AS "productCode",
                   p.name AS "productName",
                   COALESCE(p.spec, '') AS spec,
                   COALESCE(p.unit, '') AS unit,
                   w.code AS "warehouseCode",
                   w.name AS "warehouseName",
                   trim(to_char(o.qty, 'FM9999999990.####')) AS qty,
                   trim(to_char(o.unit_cost, 'FM9999999990.######')) AS "unitCost",
                   trim(to_char(o.amount, 'FM9999999990.00')) AS amount,
                   COALESCE(o.remark, '') AS remark,
                   to_char(o.updated_at, 'YYYY-MM-DD HH24:MI') AS "updatedAt"
            FROM inv_stock_opening o
            JOIN md_product p ON p.id = o.product_id
            JOIN md_warehouse w ON w.id = o.warehouse_id
            WHERE o.account_set_id = ?::uuid
            ORDER BY p.code, w.code
            """, inventoryScopeId());
    }

    @Transactional
    public Map<String, Object> saveRows(List<OpeningStockLineRequest> lines) {
        if (lines == null || lines.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "请至少录入一行期初库存");
        }
        var accountSetId = inventoryScopeId();
        var userId = currentSessionService.currentUserId();
        for (var line : lines) {
            saveLine(accountSetId, userId, line);
        }
        return Map.of("ok", true, "rows", rows());
    }

    private void saveLine(String accountSetId, String userId, OpeningStockLineRequest line) {
        var productCode = validationService.required(line.productCode(), "物料编码");
        var warehouseCode = validationService.required(line.warehouseCode(), "仓库编码");
        var qty = nonNegative(line.qty(), "期初数量");
        var unitCost = optionalNonNegative(line.unitCost(), "单位成本");
        var amount = unitCost == null ? null : qty.multiply(unitCost).setScale(2, RoundingMode.HALF_UP);
        var productId = lookupService.lookupEnabledIdForReference("md_product", productCode, "物料");
        var warehouseId = lookupService.lookupEnabledId("md_warehouse", warehouseCode, "仓库");
        jdbcTemplate.update("""
            INSERT INTO inv_stock_balance (
                account_set_id, product_id, warehouse_id,
                qty_on_hand, qty_available, qty_reserved
            )
            VALUES (?::uuid, ?::uuid, ?::uuid, 0, 0, 0)
            ON CONFLICT (account_set_id, product_id, warehouse_id) DO NOTHING
            """, accountSetId, productId, warehouseId);
        var oldRows = jdbcTemplate.queryForList("""
            SELECT qty_on_hand,
                   qty_reserved,
                   amount
            FROM inv_stock_balance
            WHERE account_set_id = ?::uuid
              AND product_id = ?::uuid
              AND warehouse_id = ?::uuid
            FOR UPDATE
            """, accountSetId, productId, warehouseId);
        var oldQty = BigDecimal.class.cast(oldRows.getFirst().get("qty_on_hand"));
        var oldReserved = BigDecimal.class.cast(oldRows.getFirst().get("qty_reserved"));
        var oldAmount = oldRows.getFirst().get("amount") == null
            ? BigDecimal.ZERO
            : BigDecimal.class.cast(oldRows.getFirst().get("amount"));
        if (qty.compareTo(oldReserved) < 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "期初数量不能小于已预留数量");
        }
        var opening = jdbcTemplate.queryForMap("""
            INSERT INTO inv_stock_opening (account_set_id, product_id, warehouse_id, qty, unit_cost, amount, remark, updated_by)
            VALUES (?::uuid, ?::uuid, ?::uuid, ?, ?, ?, ?, ?::uuid)
            ON CONFLICT (account_set_id, product_id, warehouse_id) DO UPDATE
            SET qty = EXCLUDED.qty,
                unit_cost = EXCLUDED.unit_cost,
                amount = EXCLUDED.amount,
                remark = EXCLUDED.remark,
                updated_by = EXCLUDED.updated_by,
                updated_at = now()
            RETURNING id::text AS id
            """, accountSetId, productId, warehouseId, qty, unitCost, amount, line.remark(), userId);
        jdbcTemplate.update("""
            UPDATE inv_stock_balance
            SET qty_on_hand = ?,
                qty_available = ?,
                unit_cost = ?,
                amount = ?,
                updated_at = now(),
                version = version + 1
            WHERE account_set_id = ?::uuid
              AND product_id = ?::uuid
              AND warehouse_id = ?::uuid
            """, qty, qty.subtract(oldReserved), unitCost, amount, accountSetId, productId, warehouseId);
        var qtyDelta = qty.subtract(oldQty);
        var amountDelta = amount == null ? null : amount.subtract(oldAmount);
        jdbcTemplate.update("""
            INSERT INTO inv_stock_txn (
                account_set_id, txn_type, product_id, warehouse_id, qty_delta,
                source_bill_type, source_bill_id, source_bill_line_id,
                source_bill_no, source_bill_date, posting_action,
                qty_on_hand_after, trace_quality, unit_cost, amount, occurred_at
            )
            SELECT
                ?::uuid, 'OPENING_STOCK', ?::uuid, ?::uuid, ?,
                'OPENING_STOCK', ?::uuid, ?::uuid,
                ?, (fact_clock.occurred_at AT TIME ZONE 'Asia/Shanghai')::date,
                'AUDIT', ?, 'CONTROLLED', ?, ?, fact_clock.occurred_at
            FROM (SELECT clock_timestamp() AS occurred_at) fact_clock
            """,
            accountSetId, productId, warehouseId, qtyDelta,
            opening.get("id"), opening.get("id"), "OPENING-" + opening.get("id"),
            qty, unitCost, amountDelta
        );
    }

    private BigDecimal nonNegative(BigDecimal value, String label) {
        if (value == null || value.compareTo(BigDecimal.ZERO) < 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不能小于 0");
        }
        return value;
    }

    private BigDecimal optionalNonNegative(BigDecimal value, String label) {
        if (value == null) {
            return null;
        }
        if (value.compareTo(BigDecimal.ZERO) < 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不能小于 0");
        }
        return value;
    }

    public record OpeningStockLineRequest(String productCode, String warehouseCode, BigDecimal qty, BigDecimal unitCost, String remark) {
    }

    private String inventoryScopeId() {
        return tenantDataScopeService.currentScopeId("inventory");
    }
}
