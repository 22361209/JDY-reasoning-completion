package com.jdy.erp.sales.application;

import java.math.BigDecimal;
import java.util.Map;
import java.util.UUID;

import com.jdy.erp.shared.application.LookupService;
import com.jdy.erp.shared.domain.BillStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class SalesPriceMemoryService {
    private final JdbcTemplate jdbcTemplate;
    private final LookupService lookupService;

    public SalesPriceMemoryService(JdbcTemplate jdbcTemplate, LookupService lookupService) {
        this.jdbcTemplate = jdbcTemplate;
        this.lookupService = lookupService;
    }

    @Transactional(readOnly = true)
    public Map<String, Object> unitPrice(String customerCode, String productCode) {
        var customerId = lookupService.lookupEnabledId("md_customer", customerCode, "客户");
        var productId = lookupService.lookupEnabledId("md_product", productCode, "商品");
        return unitPriceByIds(UUID.fromString(customerId), UUID.fromString(productId), customerCode.trim(), productCode.trim());
    }

    private Map<String, Object> unitPriceByIds(UUID customerId, UUID productId, String customerCode, String productCode) {
        var historyRows = jdbcTemplate.queryForList("""
            SELECT unit_price AS "unitPrice", source, bill_no AS "billNo"
            FROM (
                SELECT l.unit_price,
                       'salesOrder' AS source,
                       so.bill_no,
                       so.bill_date,
                       so.updated_at,
                       l.line_no
                FROM sales_order so
                JOIN sales_order_line l ON l.order_id = so.id
                WHERE so.customer_id = ?
                  AND l.product_id = ?
                  AND so.status = ?
                UNION ALL
                SELECT l.unit_price,
                       'salesOut' AS source,
                       so.bill_no,
                       so.bill_date,
                       so.updated_at,
                       l.line_no
                FROM sales_out so
                JOIN sales_out_line l ON l.bill_id = so.id
                WHERE so.customer_id = ?
                  AND l.product_id = ?
                  AND so.status = ?
            ) price_history
            ORDER BY bill_date DESC, updated_at DESC, bill_no DESC, line_no DESC
            LIMIT 1
            """, customerId, productId, BillStatus.AUDITED.name(), customerId, productId, BillStatus.AUDITED.name());
        if (!historyRows.isEmpty()) {
            var row = historyRows.get(0);
            return Map.of(
                "customerCode", customerCode,
                "productCode", productCode,
                "unitPrice", row.get("unitPrice"),
                "source", row.get("source"),
                "sourceBillNo", row.get("billNo")
            );
        }

        var defaultPrice = jdbcTemplate.queryForObject(
            "SELECT default_sale_price FROM md_product WHERE id = ?",
            BigDecimal.class,
            productId
        );
        if (defaultPrice != null) {
            return Map.of(
                "customerCode", customerCode,
                "productCode", productCode,
                "unitPrice", defaultPrice,
                "source", "productDefault"
            );
        }
        return Map.of(
            "customerCode", customerCode,
            "productCode", productCode,
            "unitPrice", BigDecimal.ZERO,
            "source", "zero"
        );
    }
}
