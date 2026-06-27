package com.jdy.erp.sales.application;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
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

    @Transactional(readOnly = true)
    public Map<String, Object> unitPriceSources(String customerCode, String productCodes) {
        var normalizedCustomerCode = customerCode == null ? "" : customerCode.trim();
        var customerId = UUID.fromString(lookupService.lookupEnabledId("md_customer", normalizedCustomerCode, "客户"));
        var codes = Arrays.stream((productCodes == null ? "" : productCodes).split(","))
            .map(String::trim)
            .filter(code -> !code.isBlank())
            .distinct()
            .limit(100)
            .toList();
        var products = new LinkedHashMap<String, Object>();
        for (var code : codes) {
            var productId = UUID.fromString(lookupService.lookupEnabledId("md_product", code, "商品"));
            products.put(code, priceSourcesByIds(customerId, productId, code));
        }
        return Map.of(
            "customerCode", normalizedCustomerCode,
            "products", products
        );
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

    private Map<String, Object> priceSourcesByIds(UUID customerId, UUID productId, String productCode) {
        var result = new LinkedHashMap<String, Object>();
        var defaultPrice = jdbcTemplate.queryForObject(
            "SELECT default_sale_price FROM md_product WHERE id = ?",
            BigDecimal.class,
            productId
        );
        putSource(result, "defaultPrice", defaultPrice, defaultPrice == null ? "商品默认销售价未维护" : "商品默认销售价", null);

        var recentRows = salesPriceHistoryRows(customerId, productId, """
            ORDER BY bill_date DESC, updated_at DESC, bill_no DESC, line_no DESC
            LIMIT 1
            """);
        if (recentRows.isEmpty()) {
            putSource(result, "recentPrice", null, "无已审核销售成交记录", null);
        } else {
            var row = recentRows.get(0);
            putSource(result, "recentPrice", price(row.get("unitPrice")), "最近成交价", String.valueOf(row.get("billNo")));
        }

        var stats = jdbcTemplate.queryForMap("""
            SELECT MIN(unit_price) AS "minPrice",
                   MAX(unit_price) AS "maxPrice",
                   AVG(unit_price) AS "avgPrice"
            FROM (
                SELECT l.unit_price
                FROM sales_order so
                JOIN sales_order_line l ON l.order_id = so.id
                WHERE so.customer_id = ?
                  AND l.product_id = ?
                  AND so.status = ?
                UNION ALL
                SELECT l.unit_price
                FROM delivery_notice dn
                JOIN delivery_notice_line l ON l.bill_id = dn.id
                WHERE dn.customer_id = ?
                  AND l.product_id = ?
                  AND dn.status = ?
                UNION ALL
                SELECT l.unit_price
                FROM sales_out so
                JOIN sales_out_line l ON l.bill_id = so.id
                WHERE so.customer_id = ?
                  AND l.product_id = ?
                  AND so.status = ?
            ) price_history
            """, customerId, productId, BillStatus.AUDITED.name(), customerId, productId, BillStatus.AUDITED.name(), customerId, productId, BillStatus.AUDITED.name());
        putSource(result, "historyMaxPrice", price(stats.get("maxPrice")), "历史最高价", null);
        putSource(result, "historyMinPrice", price(stats.get("minPrice")), "历史最低价", null);
        putSource(result, "historyAvgPrice", rounded(price(stats.get("avgPrice"))), "历史平均价", null);

        var costPrice = jdbcTemplate.queryForObject("""
            SELECT CASE
                     WHEN SUM(qty_on_hand) FILTER (WHERE unit_cost IS NOT NULL AND qty_on_hand > 0) IS NULL THEN NULL
                     ELSE SUM(qty_on_hand * unit_cost) FILTER (WHERE unit_cost IS NOT NULL AND qty_on_hand > 0)
                          / NULLIF(SUM(qty_on_hand) FILTER (WHERE unit_cost IS NOT NULL AND qty_on_hand > 0), 0)
                   END
            FROM inv_stock_balance
            WHERE product_id = ?
            """, BigDecimal.class, productId);
        putSource(result, "costPrice", rounded(costPrice), costPrice == null ? "暂无库存成本来源" : "库存加权成本价", null);
        result.put("productCode", productCode);
        return result;
    }

    private List<Map<String, Object>> salesPriceHistoryRows(UUID customerId, UUID productId, String orderAndLimitSql) {
        return jdbcTemplate.queryForList("""
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
                       'deliveryNotice' AS source,
                       dn.bill_no,
                       dn.bill_date,
                       dn.updated_at,
                       l.line_no
                FROM delivery_notice dn
                JOIN delivery_notice_line l ON l.bill_id = dn.id
                WHERE dn.customer_id = ?
                  AND l.product_id = ?
                  AND dn.status = ?
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
            """ + orderAndLimitSql, customerId, productId, BillStatus.AUDITED.name(), customerId, productId, BillStatus.AUDITED.name(), customerId, productId, BillStatus.AUDITED.name());
    }

    private void putSource(Map<String, Object> target, String key, BigDecimal price, String label, String sourceBillNo) {
        var source = new LinkedHashMap<String, Object>();
        source.put("value", price);
        source.put("available", price != null);
        source.put("label", label);
        if (sourceBillNo != null && !sourceBillNo.isBlank()) {
            source.put("sourceBillNo", sourceBillNo);
        }
        target.put(key, source);
    }

    private BigDecimal price(Object value) {
        return value instanceof BigDecimal decimal ? decimal : null;
    }

    private BigDecimal rounded(BigDecimal value) {
        return value == null ? null : value.setScale(6, RoundingMode.HALF_UP);
    }
}
