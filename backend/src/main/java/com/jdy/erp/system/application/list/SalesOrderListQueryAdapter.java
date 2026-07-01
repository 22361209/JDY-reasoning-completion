package com.jdy.erp.system.application.list;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

@Component
public class SalesOrderListQueryAdapter implements ListQueryAdapter {
    private final JdbcTemplate jdbcTemplate;

    public SalesOrderListQueryAdapter(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @Override
    public String key() {
        return "salesOrder";
    }

    @Override
    public ListQueryResult query(ListQueryRequest request, ListQueryContract contract, ListQuerySupport support, ListSeedRowsProvider seedRowsProvider) {
        if (!"salesOrder".equals(contract.adapterKey())) {
            throw new IllegalArgumentException("SalesOrderListQueryAdapter received unsupported contract: " + contract);
        }
        return "detail".equals(contract.returnShape())
            ? detailRows(request, support)
            : headerRows(request, support);
    }

    private ListQueryResult headerRows(ListQueryRequest request, ListQuerySupport support) {
        var where = new StringBuilder(" WHERE 1 = 1");
        var args = new ArrayList<Object>();
        appendDateFilter(where, args, "so.bill_date", request);
        appendHeaderKeywordFilter(where, args, support.keywordTokens(request.keyword()));
        appendColumnFilters(where, args, support.columnFilters(request), headerFilterExpressions());

        var from = """
            FROM sales_order so
            JOIN md_customer c ON c.id = so.customer_id
            LEFT JOIN (
                SELECT order_id,
                       MIN(plan_delivery_date) AS plan_delivery_date,
                       SUM(qty) AS qty,
                       SUM(shipped_qty) AS shipped_qty,
                       SUM(amount) AS amount
                FROM sales_order_line
                GROUP BY order_id
            ) extra ON extra.order_id = so.id
            """;
        var total = jdbcTemplate.queryForObject("SELECT count(*) " + from + where, Long.class, args.toArray());
        var sql = new StringBuilder("""
            SELECT so.id::text AS id,
                   so.bill_no AS "billNo",
                   c.code AS "customerCode",
                   c.name AS customer,
                   to_char(so.bill_date, 'YYYY-MM-DD') AS "billDate",
                   COALESCE(to_char(extra.plan_delivery_date, 'YYYY-MM-DD'), '') AS "planDeliveryDate",
                   CASE WHEN so.status = 'DRAFT' THEN '草稿' WHEN so.status = 'VOID' THEN '已作废' ELSE '已审核' END AS status,
                   CASE
                       WHEN so.out_status = 'ALL_OUT' THEN '全部出库'
                       WHEN so.out_status = 'PART_OUT' THEN '部分出库'
                       ELSE '未出库'
                   END AS "outStatus",
                   so.close_status AS "closeStatus",
                   so.close_mode AS "closeMode",
                   CASE
                       WHEN so.close_status = 'OPEN' THEN '未关闭'
                       WHEN so.close_status = 'CLOSED' AND so.close_mode = 'AUTO' THEN '自动关闭'
                       WHEN so.close_status = 'CLOSED' AND so.close_mode = 'MANUAL' THEN '手动关闭'
                       WHEN so.close_status = 'CLOSED' THEN '历史已关闭'
                       ELSE COALESCE(so.close_status, '')
                   END AS "closeStatusLabel",
                   so.frozen_status AS "frozenStatus",
                   CASE WHEN so.frozen_status = 'FROZEN' THEN '已冻结' ELSE '正常' END AS "frozenStatusLabel",
                   %s AS qty,
                   %s AS "shippedQty",
                   %s AS "remainingQty",
                   %s AS amount,
                   %s AS "priceTaxTotal",
                   COALESCE(so.remark, '') AS remark,
                   COALESCE(so.owner_name, '') AS owner
            """.formatted(
                HEADER_QTY_TEXT,
                HEADER_SHIPPED_QTY_TEXT,
                HEADER_REMAINING_QTY_TEXT,
                HEADER_AMOUNT_TEXT,
                HEADER_PRICE_TAX_TOTAL_TEXT
            ));
        sql.append(from).append(where);
        appendOrderAndPage(sql, args, request, headerSortExpressions(), "so.updated_at DESC, so.id DESC");
        return new ListQueryResult(request.page(), request.pageSize(), request.normalizedView(), request.sortField(), request.sortOrder(), total == null ? 0 : total, new ArrayList<Map<String, ?>>(jdbcTemplate.queryForList(sql.toString(), args.toArray())));
    }

    private ListQueryResult detailRows(ListQueryRequest request, ListQuerySupport support) {
        var where = new StringBuilder(" WHERE 1 = 1");
        var args = new ArrayList<Object>();
        appendDateFilter(where, args, "so.bill_date", request);
        appendDetailKeywordFilter(where, args, support.keywordTokens(request.keyword()));
        appendColumnFilters(where, args, support.columnFilters(request), detailFilterExpressions());

        var from = """
            FROM sales_order so
            JOIN sales_order_line l ON l.order_id = so.id
            JOIN md_customer c ON c.id = so.customer_id
            JOIN md_product p ON p.id = l.product_id
            LEFT JOIN md_warehouse w ON w.id = l.warehouse_id
            """;
        var total = jdbcTemplate.queryForObject("SELECT count(*) " + from + where, Long.class, args.toArray());
        var sql = new StringBuilder("""
            SELECT concat(so.id::text, '-', l.line_no) AS id,
                   so.bill_no AS "billNo",
                   c.code AS "customerCode",
                   COALESCE(l.customer_material_code, '') AS "customerMaterialCode",
                   COALESCE(l.customer_order_no, '') AS "customerOrderNo",
                   to_char(so.bill_date, 'YYYY-MM-DD') AS "billDate",
                   to_char(l.plan_delivery_date, 'YYYY-MM-DD') AS "planDeliveryDate",
                   c.name AS partner,
                   CASE WHEN so.status = 'DRAFT' THEN '草稿' WHEN so.status = 'VOID' THEN '已作废' ELSE '已审核' END AS status,
                   so.close_status AS "closeStatus",
                   so.close_mode AS "closeMode",
                   CASE
                       WHEN so.close_status = 'OPEN' THEN '未关闭'
                       WHEN so.close_status = 'CLOSED' AND so.close_mode = 'AUTO' THEN '自动关闭'
                       WHEN so.close_status = 'CLOSED' AND so.close_mode = 'MANUAL' THEN '手动关闭'
                       WHEN so.close_status = 'CLOSED' THEN '历史已关闭'
                       ELSE COALESCE(so.close_status, '')
                   END AS "closeStatusLabel",
                   so.frozen_status AS "frozenStatus",
                   CASE WHEN so.frozen_status = 'FROZEN' THEN '已冻结' ELSE '正常' END AS "frozenStatusLabel",
                   l.line_no AS "lineNo",
                   COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                   COALESCE(l.product_name_snapshot, p.name) AS "productName",
                   COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                   COALESCE(w.name, '') AS warehouse,
                   %s AS qty,
                   %s AS "shippedQty",
                   %s AS "remainingQty",
                   %s AS "unitPrice",
                   %s AS "taxInclusiveUnitPrice",
                   %s AS amount,
                   %s AS "priceTaxTotal",
                   COALESCE(l.line_remark, '') AS "lineRemark",
                   '' AS "sourceBillNo",
                   '' AS "sourceLineNo"
            """.formatted(
                DETAIL_QTY_TEXT,
                DETAIL_SHIPPED_QTY_TEXT,
                DETAIL_REMAINING_QTY_TEXT,
                DETAIL_UNIT_PRICE_TEXT,
                DETAIL_TAX_INCLUSIVE_UNIT_PRICE_TEXT,
                DETAIL_AMOUNT_TEXT,
                DETAIL_PRICE_TAX_TOTAL_TEXT
            ));
        sql.append(from).append(where);
        appendOrderAndPage(sql, args, request, detailSortExpressions(), "so.updated_at DESC, l.line_no");
        return new ListQueryResult(request.page(), request.pageSize(), request.normalizedView(), request.sortField(), request.sortOrder(), total == null ? 0 : total, new ArrayList<Map<String, ?>>(jdbcTemplate.queryForList(sql.toString(), args.toArray())));
    }

    private void appendDateFilter(StringBuilder where, List<Object> args, String expression, ListQueryRequest request) {
        if (request.dateFrom() != null && !request.dateFrom().isBlank()) {
            where.append(" AND ").append(expression).append(" >= ?::date");
            args.add(request.dateFrom());
        }
        if (request.dateTo() != null && !request.dateTo().isBlank()) {
            where.append(" AND ").append(expression).append(" <= ?::date");
            args.add(request.dateTo());
        }
    }

    private void appendHeaderKeywordFilter(StringBuilder where, List<Object> args, List<String> tokens) {
        for (var token : tokens) {
            where.append("""
                 AND (
                    so.bill_no ILIKE ?
                    OR c.code ILIKE ?
                    OR c.name ILIKE ?
                    OR COALESCE(so.remark, '') ILIKE ?
                    OR EXISTS (
                        SELECT 1
                        FROM sales_order_line line
                        JOIN md_product product ON product.id = line.product_id
                        WHERE line.order_id = so.id
                          AND (
                            COALESCE(line.product_code_snapshot, product.code, '') ILIKE ?
                            OR COALESCE(line.product_name_snapshot, product.name, '') ILIKE ?
                            OR COALESCE(line.product_spec_snapshot, product.spec, '') ILIKE ?
                            OR COALESCE(line.customer_material_code, '') ILIKE ?
                            OR COALESCE(line.customer_order_no, '') ILIKE ?
                            OR COALESCE(line.line_remark, '') ILIKE ?
                          )
                    )
                )
                """);
            appendRepeatedLike(args, token, 10);
        }
    }

    private void appendDetailKeywordFilter(StringBuilder where, List<Object> args, List<String> tokens) {
        for (var token : tokens) {
            where.append("""
                 AND (
                    so.bill_no ILIKE ?
                    OR c.code ILIKE ?
                    OR c.name ILIKE ?
                    OR COALESCE(so.remark, '') ILIKE ?
                    OR COALESCE(l.product_code_snapshot, p.code, '') ILIKE ?
                    OR COALESCE(l.product_name_snapshot, p.name, '') ILIKE ?
                    OR COALESCE(l.product_spec_snapshot, p.spec, '') ILIKE ?
                    OR COALESCE(l.customer_material_code, '') ILIKE ?
                    OR COALESCE(l.customer_order_no, '') ILIKE ?
                    OR COALESCE(l.line_remark, '') ILIKE ?
                )
                """);
            appendRepeatedLike(args, token, 10);
        }
    }

    private void appendColumnFilters(StringBuilder where, List<Object> args, Map<String, Map<String, String>> filters, Map<String, String> expressions) {
        filters.forEach((field, filter) -> {
            var expression = expressions.get(field);
            if (expression == null) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unsupported sales order list column filter: " + field);
            }
            var operator = filter.getOrDefault("operator", "包含");
            var value = filter.getOrDefault("value", "");
            switch (operator) {
                case "不包含" -> {
                    where.append(" AND ").append(expression).append(" NOT ILIKE ?");
                    args.add("%" + value + "%");
                }
                case "等于" -> {
                    where.append(" AND ").append(expression).append(" = ?");
                    args.add(value);
                }
                case "不等于" -> {
                    where.append(" AND ").append(expression).append(" <> ?");
                    args.add(value);
                }
                case "以……开始" -> {
                    where.append(" AND ").append(expression).append(" ILIKE ?");
                    args.add(value + "%");
                }
                case "以……结束" -> {
                    where.append(" AND ").append(expression).append(" ILIKE ?");
                    args.add("%" + value);
                }
                case "为空" -> where.append(" AND COALESCE(").append(expression).append(", '') = ''");
                case "不为空" -> where.append(" AND COALESCE(").append(expression).append(", '') <> ''");
                default -> {
                    where.append(" AND ").append(expression).append(" ILIKE ?");
                    args.add("%" + value + "%");
                }
            }
        });
    }

    private void appendOrderAndPage(StringBuilder sql, List<Object> args, ListQueryRequest request, Map<String, String> sortExpressions, String defaultSort) {
        var sortExpression = sortExpressions.get(request.sortField());
        if (sortExpression == null || sortExpression.isBlank()) {
            sql.append(" ORDER BY ").append(defaultSort);
        } else {
            sql.append(" ORDER BY ").append(sortExpression).append(" ").append("desc".equalsIgnoreCase(request.sortOrder()) ? "DESC" : "ASC");
        }
        if (!request.exportMode()) {
            sql.append(" LIMIT ? OFFSET ?");
            args.add(request.pageSize());
            args.add((Math.max(1, request.page()) - 1) * request.pageSize());
        }
    }

    private void appendRepeatedLike(List<Object> args, String token, int count) {
        var like = "%" + token + "%";
        for (int index = 0; index < count; index += 1) {
            args.add(like);
        }
    }

    private Map<String, String> headerFilterExpressions() {
        var expressions = new LinkedHashMap<String, String>();
        expressions.put("billNo", "so.bill_no");
        expressions.put("customerCode", "c.code");
        expressions.put("customer", "c.name");
        expressions.put("billDate", "to_char(so.bill_date, 'YYYY-MM-DD')");
        expressions.put("planDeliveryDate", "COALESCE(to_char(extra.plan_delivery_date, 'YYYY-MM-DD'), '')");
        expressions.put("status", "CASE WHEN so.status = 'DRAFT' THEN '草稿' WHEN so.status = 'VOID' THEN '已作废' ELSE '已审核' END");
        expressions.put("outStatus", "CASE WHEN so.out_status = 'ALL_OUT' THEN '全部出库' WHEN so.out_status = 'PART_OUT' THEN '部分出库' ELSE '未出库' END");
        expressions.put("closeStatus", "COALESCE(so.close_status, '')");
        expressions.put("closeMode", "COALESCE(so.close_mode, '')");
        expressions.put("closeStatusLabel", "CASE WHEN so.close_status = 'OPEN' THEN '未关闭' WHEN so.close_status = 'CLOSED' AND so.close_mode = 'AUTO' THEN '自动关闭' WHEN so.close_status = 'CLOSED' AND so.close_mode = 'MANUAL' THEN '手动关闭' WHEN so.close_status = 'CLOSED' THEN '历史已关闭' ELSE COALESCE(so.close_status, '') END");
        expressions.put("frozenStatus", "COALESCE(so.frozen_status, '')");
        expressions.put("frozenStatusLabel", "CASE WHEN so.frozen_status = 'FROZEN' THEN '已冻结' ELSE '正常' END");
        expressions.put("qty", HEADER_QTY_TEXT);
        expressions.put("shippedQty", HEADER_SHIPPED_QTY_TEXT);
        expressions.put("remainingQty", HEADER_REMAINING_QTY_TEXT);
        expressions.put("amount", HEADER_AMOUNT_TEXT);
        expressions.put("priceTaxTotal", HEADER_PRICE_TAX_TOTAL_TEXT);
        expressions.put("remark", "COALESCE(so.remark, '')");
        expressions.put("owner", "COALESCE(so.owner_name, '')");
        return expressions;
    }

    private Map<String, String> detailFilterExpressions() {
        var expressions = new LinkedHashMap<>(headerFilterExpressions());
        expressions.put("partner", "c.name");
        expressions.put("lineNo", "l.line_no::text");
        expressions.put("productCode", "COALESCE(l.product_code_snapshot, p.code, '')");
        expressions.put("productName", "COALESCE(l.product_name_snapshot, p.name, '')");
        expressions.put("spec", "COALESCE(l.product_spec_snapshot, p.spec, '')");
        expressions.put("customerMaterialCode", "COALESCE(l.customer_material_code, '')");
        expressions.put("customerOrderNo", "COALESCE(l.customer_order_no, '')");
        expressions.put("lineRemark", "COALESCE(l.line_remark, '')");
        expressions.put("warehouse", "COALESCE(w.name, '')");
        expressions.put("unit", "COALESCE(l.product_unit_snapshot, p.unit, '')");
        expressions.put("netWeight", "trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00'))");
        expressions.put("grossWeight", "trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00'))");
        expressions.put("qty", DETAIL_QTY_TEXT);
        expressions.put("shippedQty", DETAIL_SHIPPED_QTY_TEXT);
        expressions.put("remainingQty", DETAIL_REMAINING_QTY_TEXT);
        expressions.put("unitPrice", DETAIL_UNIT_PRICE_TEXT);
        expressions.put("taxInclusiveUnitPrice", DETAIL_TAX_INCLUSIVE_UNIT_PRICE_TEXT);
        expressions.put("amount", DETAIL_AMOUNT_TEXT);
        expressions.put("priceTaxTotal", DETAIL_PRICE_TAX_TOTAL_TEXT);
        expressions.put("sourceBillNo", "''");
        expressions.put("sourceLineNo", "''");
        return expressions;
    }

    private Map<String, String> headerSortExpressions() {
        var expressions = new LinkedHashMap<String, String>();
        expressions.put("billNo", "so.bill_no");
        expressions.put("customerCode", "c.code");
        expressions.put("customer", "c.name");
        expressions.put("billDate", "so.bill_date");
        expressions.put("status", "so.status");
        expressions.put("planDeliveryDate", "extra.plan_delivery_date");
        expressions.put("qty", "extra.qty");
        expressions.put("shippedQty", "extra.shipped_qty");
        expressions.put("remainingQty", "GREATEST(0, COALESCE(extra.qty, 0) - COALESCE(extra.shipped_qty, 0))");
        expressions.put("amount", "extra.amount");
        expressions.put("priceTaxTotal", "so.total_amount");
        return expressions;
    }

    private Map<String, String> detailSortExpressions() {
        var expressions = new LinkedHashMap<>(headerSortExpressions());
        expressions.put("lineNo", "l.line_no");
        expressions.put("productCode", "COALESCE(l.product_code_snapshot, p.code, '')");
        expressions.put("productName", "COALESCE(l.product_name_snapshot, p.name, '')");
        expressions.put("spec", "COALESCE(l.product_spec_snapshot, p.spec, '')");
        expressions.put("qty", "l.qty");
        expressions.put("shippedQty", "COALESCE(l.shipped_qty, 0)");
        expressions.put("remainingQty", "GREATEST(0, l.qty - COALESCE(l.shipped_qty, 0))");
        expressions.put("unitPrice", "l.unit_price");
        expressions.put("amount", "l.amount");
        expressions.put("priceTaxTotal", "l.price_tax_total");
        return expressions;
    }

    private static final String HEADER_QTY_TEXT = "trim(to_char(COALESCE(extra.qty, 0), 'FM9999999990.####'))";
    private static final String HEADER_SHIPPED_QTY_TEXT = "trim(to_char(COALESCE(extra.shipped_qty, 0), 'FM9999999990.####'))";
    private static final String HEADER_REMAINING_QTY_TEXT = "trim(to_char(GREATEST(0, COALESCE(extra.qty, 0) - COALESCE(extra.shipped_qty, 0)), 'FM9999999990.####'))";
    private static final String HEADER_AMOUNT_TEXT = "trim(to_char(COALESCE(extra.amount, 0), 'FM9999999990.00'))";
    private static final String HEADER_PRICE_TAX_TOTAL_TEXT = "trim(to_char(so.total_amount, 'FM9999999990.00'))";
    private static final String DETAIL_QTY_TEXT = "trim(to_char(l.qty, 'FM9999999990.####'))";
    private static final String DETAIL_SHIPPED_QTY_TEXT = "trim(to_char(COALESCE(l.shipped_qty, 0), 'FM9999999990.####'))";
    private static final String DETAIL_REMAINING_QTY_TEXT = "trim(to_char(GREATEST(0, l.qty - COALESCE(l.shipped_qty, 0)), 'FM9999999990.####'))";
    private static final String DETAIL_UNIT_PRICE_TEXT = "trim(to_char(l.unit_price, 'FM9999999990.00'))";
    private static final String DETAIL_TAX_INCLUSIVE_UNIT_PRICE_TEXT = "trim(to_char(CASE WHEN so.is_tax_inclusive THEN l.unit_price ELSE round(l.unit_price * (1 + COALESCE(l.tax_rate, 0) / 100), 2) END, 'FM9999999990.00'))";
    private static final String DETAIL_AMOUNT_TEXT = "trim(to_char(l.amount, 'FM9999999990.00'))";
    private static final String DETAIL_PRICE_TAX_TOTAL_TEXT = "trim(to_char(l.price_tax_total, 'FM9999999990.00'))";
}
