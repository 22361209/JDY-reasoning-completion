package com.jdy.erp.inventory.api;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

import com.jdy.erp.shared.application.LookupService;
import com.jdy.erp.system.security.RequirePermission;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.transaction.annotation.Transactional;

@RestController
@RequestMapping("/api/inventory/stock-alert-settings")
public class StockAlertSettingController {
    private final JdbcTemplate jdbcTemplate;
    private final LookupService lookupService;

    public StockAlertSettingController(JdbcTemplate jdbcTemplate, LookupService lookupService) {
        this.jdbcTemplate = jdbcTemplate;
        this.lookupService = lookupService;
    }

    @GetMapping
    @RequirePermission("inventory.stock.view")
    public List<Map<String, Object>> list() {
        return jdbcTemplate.queryForList("""
            SELECT s.id::text AS id,
                   p.code AS "productCode",
                   p.name AS "productName",
                   COALESCE(p.spec, '') AS spec,
                   p.unit,
                   w.code AS "warehouseCode",
                   w.name AS "warehouseName",
                   trim(to_char(s.safety_qty, 'FM9999999990.####')) AS "safetyQty",
                   trim(to_char(s.max_qty, 'FM9999999990.####')) AS "maxQty",
                   to_char(s.updated_at, 'YYYY-MM-DD HH24:MI') AS "updatedAt"
            FROM inv_safety_stock_setting s
            JOIN md_product p ON p.id = s.product_id
            JOIN md_warehouse w ON w.id = s.warehouse_id
            ORDER BY p.code, w.code
            """);
    }

    @PutMapping
    @RequirePermission("inventory.stock_alert.manage")
    @Transactional
    public Map<String, Object> upsert(@RequestBody StockAlertSettingRequest request) {
        var productId = lookupService.lookupEnabledIdForReference("md_product", request.productCode(), "商品");
        var warehouseId = lookupService.lookupEnabledId("md_warehouse", request.warehouseCode(), "仓库");
        var safetyQty = positiveOrZero(request.safetyQty(), "最低安全量不能小于 0");
        var maxQty = request.maxQty();
        if (maxQty != null && maxQty.compareTo(safetyQty) < 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "最高库存不能小于最低安全量");
        }
        return jdbcTemplate.queryForMap("""
            INSERT INTO inv_safety_stock_setting (product_id, warehouse_id, safety_qty, max_qty)
            VALUES (?::uuid, ?::uuid, ?, ?)
            ON CONFLICT (product_id, warehouse_id) DO UPDATE
            SET safety_qty = EXCLUDED.safety_qty,
                max_qty = EXCLUDED.max_qty,
                updated_at = now(),
                version = inv_safety_stock_setting.version + 1
            RETURNING id::text AS id
            """, productId, warehouseId, safetyQty, maxQty);
    }

    @DeleteMapping("/{id}")
    @RequirePermission("inventory.stock_alert.manage")
    public Map<String, Object> delete(@PathVariable String id) {
        var deleted = jdbcTemplate.update("DELETE FROM inv_safety_stock_setting WHERE id = ?::uuid", id);
        if (deleted == 0) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "安全库存设置不存在");
        }
        return Map.of("deleted", true);
    }

    private BigDecimal positiveOrZero(BigDecimal value, String message) {
        if (value == null || value.compareTo(BigDecimal.ZERO) < 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
        }
        return value;
    }

    @ExceptionHandler(DataIntegrityViolationException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public Map<String, Object> handleDataIntegrity(DataIntegrityViolationException exception) {
        return Map.of("message", "安全库存设置不符合库存阈值约束");
    }

    public record StockAlertSettingRequest(
        String productCode,
        String warehouseCode,
        BigDecimal safetyQty,
        BigDecimal maxQty
    ) {
    }
}
