package com.jdy.erp.system.application.list;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

/**
 * SQL-backed list contracts for the production material-scrap document.
 *
 * <p>This adapter deliberately owns both the document list and its eligible
 * material-issue selector so they cannot fall through to demo seed rows.</p>
 */
@Component
public class MaterialScrapListQueryAdapter implements ListQueryAdapter {
    private final JdbcTemplate jdbcTemplate;

    public MaterialScrapListQueryAdapter(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @Override
    public String key() {
        return "materialScrap";
    }

    @Override
    public ListQueryResult query(
        ListQueryRequest request,
        ListQueryContract contract,
        ListQuerySupport support,
        ListSeedRowsProvider seedRowsProvider
    ) {
        if (!key().equals(contract.adapterKey())) {
            throw new IllegalArgumentException("MaterialScrapListQueryAdapter received unsupported contract: " + contract);
        }
        var spec = switch (request.listKey()) {
            case "material-scrap-form-list" -> "detail".equals(contract.view())
                ? documentDetailSpec()
                : documentHeaderSpec();
            case "material-scrap-source-selector" -> sourceSelectorSpec();
            default -> throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Unknown material scrap list key: " + request.listKey());
        };
        return execute(request, contract, support, spec);
    }

    private ListQueryResult execute(
        ListQueryRequest request,
        ListQueryContract contract,
        ListQuerySupport support,
        QuerySpec spec
    ) {
        var where = new StringBuilder(" WHERE 1 = 1");
        var args = new ArrayList<Object>();
        appendDateRange(where, args, contract.dateField(), request);
        appendKeywords(where, args, support.keywordTokens(request.keyword()), spec.keywordFields(), support);
        appendColumnFilters(where, args, support.columnFilters(request), spec.filterExpressions());

        var from = " FROM (" + spec.sql() + ") source";
        var total = jdbcTemplate.queryForObject("SELECT COUNT(*)" + from + where, Long.class, args.toArray());
        var rowArgs = new ArrayList<>(args);
        var rowSql = new StringBuilder("SELECT *").append(from).append(where);
        appendOrderAndPage(rowSql, rowArgs, request, spec);
        var rows = jdbcTemplate.queryForList(rowSql.toString(), rowArgs.toArray());
        return new ListQueryResult(
            Math.max(1, request.page()),
            Math.max(1, request.pageSize()),
            spec.view(),
            request.sortField(),
            support.normalizedSortOrder(request.sortOrder()),
            total == null ? 0 : total,
            new ArrayList<Map<String, ?>>(rows)
        );
    }

    private void appendDateRange(StringBuilder where, List<Object> args, String field, ListQueryRequest request) {
        if (field == null || field.isBlank()) {
            return;
        }
        var expression = quoted(field);
        if (request.dateFrom() != null && !request.dateFrom().isBlank()) {
            where.append(" AND source.").append(expression).append(" >= ?");
            args.add(request.dateFrom());
        }
        if (request.dateTo() != null && !request.dateTo().isBlank()) {
            where.append(" AND source.").append(expression).append(" <= ?");
            args.add(request.dateTo());
        }
    }

    private void appendKeywords(
        StringBuilder where,
        List<Object> args,
        List<String> tokens,
        List<String> fields,
        ListQuerySupport support
    ) {
        for (var token : tokens) {
            where.append(" AND (");
            for (var index = 0; index < fields.size(); index += 1) {
                if (index > 0) {
                    where.append(" OR ");
                }
                where.append("LOWER(COALESCE(CAST(source.")
                    .append(quoted(fields.get(index)))
                    .append(" AS text), '')) LIKE ?");
                args.add(support.likeToken(token));
            }
            where.append(")");
        }
    }

    private void appendColumnFilters(
        StringBuilder where,
        List<Object> args,
        Map<String, Map<String, String>> filters,
        Map<String, String> expressions
    ) {
        filters.forEach((field, filter) -> {
            var expression = expressions.get(field);
            if (expression == null) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unsupported material scrap list column filter: " + field);
            }
            var textExpression = "COALESCE(CAST(source." + quoted(expression) + " AS text), '')";
            var operator = filter.getOrDefault("operator", "包含");
            var value = filter.getOrDefault("value", "");
            switch (operator) {
                case "不包含" -> {
                    where.append(" AND ").append(textExpression).append(" NOT ILIKE ?");
                    args.add("%" + value + "%");
                }
                case "等于" -> {
                    where.append(" AND ").append(textExpression).append(" = ?");
                    args.add(value);
                }
                case "不等于" -> {
                    where.append(" AND ").append(textExpression).append(" <> ?");
                    args.add(value);
                }
                case "以……开始" -> {
                    where.append(" AND ").append(textExpression).append(" ILIKE ?");
                    args.add(value + "%");
                }
                case "以……结束" -> {
                    where.append(" AND ").append(textExpression).append(" ILIKE ?");
                    args.add("%" + value);
                }
                case "为空" -> where.append(" AND ").append(textExpression).append(" = ''");
                case "不为空" -> where.append(" AND ").append(textExpression).append(" <> ''");
                default -> {
                    where.append(" AND ").append(textExpression).append(" ILIKE ?");
                    args.add("%" + value + "%");
                }
            }
        });
    }

    private void appendOrderAndPage(StringBuilder sql, List<Object> args, ListQueryRequest request, QuerySpec spec) {
        var sortExpression = spec.sortExpressions().get(request.sortField());
        if (sortExpression == null) {
            sql.append(" ORDER BY ").append(spec.defaultSort());
        } else {
            sql.append(" ORDER BY source.").append(quoted(sortExpression)).append(' ')
                .append("desc".equalsIgnoreCase(request.sortOrder()) ? "DESC" : "ASC")
                .append(", ").append(spec.stableSort());
        }
        if (!request.exportMode()) {
            var page = Math.max(1, request.page());
            var pageSize = Math.max(1, request.pageSize());
            sql.append(" LIMIT ? OFFSET ?");
            args.add(pageSize);
            args.add((page - 1) * pageSize);
        }
    }

    private QuerySpec documentHeaderSpec() {
        return new QuerySpec("""
            SELECT scrap.id::text AS id,
                   scrap.bill_no AS "billNo",
                   to_char(scrap.bill_date, 'YYYY-MM-DD') AS "billDate",
                   scrap.business_type AS "businessType",
                   issue.bill_no AS "sourceIssueNo",
                   scrap.workshop_code_snapshot AS "workshopCode",
                   scrap.workshop_name_snapshot AS "workshopName",
                   scrap.status AS "statusCode",
                   CASE scrap.status WHEN 'DRAFT' THEN '草稿' WHEN 'AUDITED' THEN '已审核' WHEN 'VOID' THEN '已作废' ELSE scrap.status END AS status,
                   CASE scrap.status WHEN 'DRAFT' THEN '未审核' WHEN 'AUDITED' THEN '已审核' WHEN 'VOID' THEN '已作废' ELSE scrap.status END AS "auditStatus",
                   CASE WHEN scrap.status = 'VOID' THEN '已作废' ELSE '未作废' END AS "voidStatus",
                   scrap.close_status AS "closeStatus",
                   scrap.frozen_status AS "frozenStatus",
                   COALESCE(SUM(line.scrap_qty), 0) AS "scrapQty",
                   COALESCE(SUM(line.reissue_qty), 0) AS "reissueQty",
                   COALESCE(string_agg(line.product_code_snapshot, ' ' ORDER BY line.line_no), '') AS "productCode",
                   COALESCE(string_agg(line.product_name_snapshot, ' ' ORDER BY line.line_no), '') AS "productName",
                   COALESCE(string_agg(line.product_spec_snapshot, ' ' ORDER BY line.line_no), '') AS spec,
                   COALESCE(string_agg(line.scrap_reason, ' ' ORDER BY line.line_no), '') AS "scrapReason",
                   CASE
                       WHEN COUNT(line.id) FILTER (WHERE line.is_stock_in) = 0 THEN 'NOT_REQUIRED'
                       WHEN BOOL_AND(line.stock_in_status = 'STOCKED_IN') FILTER (WHERE line.is_stock_in) THEN 'STOCKED_IN'
                       WHEN BOOL_AND(line.stock_in_status = 'REVERSED') FILTER (WHERE line.is_stock_in) THEN 'REVERSED'
                       ELSE 'PENDING'
                   END AS "stockInStatus",
                   scrap.updated_at AS "updatedAt"
            FROM production_material_scrap scrap
            JOIN production_material_issue issue ON issue.id = scrap.source_issue_id
            LEFT JOIN production_material_scrap_line line ON line.scrap_id = scrap.id
            GROUP BY scrap.id, issue.bill_no
            """, "header",
            List.of("billNo", "sourceIssueNo", "businessType", "workshopCode", "workshopName", "status", "productCode", "productName", "spec", "scrapReason"),
            documentFilters("billNo", "billDate", "businessType", "sourceIssueNo", "workshopCode", "workshopName", "statusCode", "auditStatus", "voidStatus", "stockInStatus", "productCode", "productName", "spec", "scrapReason"),
            fields("billNo", "billDate", "businessType", "sourceIssueNo", "workshopCode", "workshopName", "statusCode", "scrapQty", "reissueQty", "productCode", "productName", "stockInStatus", "updatedAt"),
            "source.\"billDate\" DESC, source.\"billNo\" DESC",
            "source.\"billNo\" ASC");
    }

    private QuerySpec documentDetailSpec() {
        return new QuerySpec("""
            SELECT concat(scrap.id::text, '-', line.line_no) AS id,
                   scrap.bill_no AS "billNo",
                   to_char(scrap.bill_date, 'YYYY-MM-DD') AS "billDate",
                   scrap.business_type AS "businessType",
                   issue.bill_no AS "sourceIssueNo",
                   scrap.workshop_code_snapshot AS "workshopCode",
                   scrap.workshop_name_snapshot AS "workshopName",
                   scrap.status AS "statusCode",
                   CASE scrap.status WHEN 'DRAFT' THEN '草稿' WHEN 'AUDITED' THEN '已审核' WHEN 'VOID' THEN '已作废' ELSE scrap.status END AS status,
                   line.line_no AS "lineNo",
                   line.product_code_snapshot AS "productCode",
                   line.product_name_snapshot AS "productName",
                   line.product_spec_snapshot AS spec,
                   line.product_unit_snapshot AS unit,
                   line.source_warehouse_code_snapshot AS "sourceWarehouseCode",
                   line.issue_qty_snapshot AS "issueQty",
                   line.available_scrap_qty_snapshot AS "availableScrapQty",
                   line.scrap_qty AS "scrapQty",
                   COALESCE(line.scrap_reason, '') AS "scrapReason",
                   line.reissue_qty AS "reissueQty",
                   line.is_stock_in AS "isStockIn",
                   COALESCE(line.target_warehouse_code_snapshot, '') AS "targetWarehouseCode",
                   line.stock_in_status AS "stockInStatus",
                   scrap.updated_at AS "updatedAt"
            FROM production_material_scrap scrap
            JOIN production_material_issue issue ON issue.id = scrap.source_issue_id
            JOIN production_material_scrap_line line ON line.scrap_id = scrap.id
            """, "detail",
            List.of("billNo", "sourceIssueNo", "businessType", "workshopCode", "workshopName", "productCode", "productName", "spec", "scrapReason"),
            documentFilters("billNo", "billDate", "businessType", "sourceIssueNo", "workshopCode", "workshopName", "statusCode", "productCode", "productName", "spec", "unit", "sourceWarehouseCode", "scrapReason", "isStockIn", "targetWarehouseCode", "stockInStatus"),
            fields("billNo", "billDate", "businessType", "sourceIssueNo", "workshopCode", "workshopName", "statusCode", "lineNo", "productCode", "productName", "sourceWarehouseCode", "issueQty", "availableScrapQty", "scrapQty", "reissueQty", "stockInStatus", "updatedAt"),
            "source.\"billDate\" DESC, source.\"billNo\" DESC, source.\"lineNo\" ASC",
            "source.\"billNo\" ASC, source.\"lineNo\" ASC");
    }

    private QuerySpec sourceSelectorSpec() {
        return new QuerySpec("""
            SELECT concat(issue.id::text, '-', line.id::text) AS id,
                   issue.bill_no AS "billNo",
                   to_char(issue.created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS "billDate",
                   department.code AS "workshopCode",
                   department.name AS "workshopName",
                   line.id::text AS "sourceIssueLineId",
                   line.line_no AS "lineNo",
                   line.product_id::text AS "productId",
                   COALESCE(line.product_code_snapshot, product.code) AS "productCode",
                   COALESCE(line.product_name_snapshot, product.name) AS "productName",
                   COALESCE(line.product_spec_snapshot, product.spec, '') AS spec,
                   COALESCE(line.product_unit_snapshot, product.unit, '') AS unit,
                   warehouse.code AS "sourceWarehouseCode",
                   line.qty AS "issueQty",
                   GREATEST(line.qty - COALESCE(used.scrap_qty, 0), 0) AS "availableScrapQty",
                   issue.status AS "statusCode",
                   issue.close_status AS "closeStatus",
                   issue.frozen_status AS "frozenStatus",
                   issue.updated_at AS "updatedAt"
            FROM production_material_issue issue
            JOIN production_task task ON task.id = issue.task_id
            JOIN md_production_department department
              ON department.code = task.department_code
             AND department.enabled = TRUE
             AND department.audit_status = 'AUDITED'
            JOIN production_material_issue_line line ON line.issue_id = issue.id
            JOIN md_product product ON product.id = line.product_id
            JOIN md_warehouse warehouse ON warehouse.id = line.warehouse_id
            LEFT JOIN (
                SELECT scrap_line.source_issue_line_id, SUM(scrap_line.scrap_qty) AS scrap_qty
                FROM production_material_scrap_line scrap_line
                JOIN production_material_scrap scrap ON scrap.id = scrap_line.scrap_id
                WHERE scrap.status = 'AUDITED'
                GROUP BY scrap_line.source_issue_line_id
            ) used ON used.source_issue_line_id = line.id
            WHERE issue.status = 'AUDITED'
              AND issue.close_status = 'OPEN'
              AND issue.frozen_status = 'NORMAL'
              AND issue.red_source_bill_id IS NULL
              AND NOT EXISTS (
                  SELECT 1
                  FROM production_material_issue red
                  WHERE red.red_source_bill_id = issue.id
                    AND red.status <> 'VOID'
              )
              AND line.qty - COALESCE(used.scrap_qty, 0) > 0
            """, "detail",
            List.of("billNo", "workshopCode", "workshopName", "productCode", "productName", "spec", "unit", "sourceWarehouseCode"),
            fields("billNo", "billDate", "workshopCode", "workshopName", "productCode", "productName", "spec", "unit", "sourceWarehouseCode", "statusCode"),
            fields("billNo", "billDate", "workshopCode", "workshopName", "lineNo", "productCode", "productName", "sourceWarehouseCode", "issueQty", "availableScrapQty", "updatedAt"),
            "source.\"billDate\" DESC, source.\"billNo\" DESC, source.\"lineNo\" ASC",
            "source.\"billNo\" ASC, source.\"lineNo\" ASC");
    }

    private Map<String, String> fields(String... names) {
        var fields = new LinkedHashMap<String, String>();
        for (var name : names) {
            fields.put(name, name);
        }
        return Map.copyOf(fields);
    }

    private Map<String, String> documentFilters(String... names) {
        var fields = new LinkedHashMap<>(fields(names));
        fields.put("status", "status");
        return Map.copyOf(fields);
    }

    private String quoted(String identifier) {
        if (identifier == null || !identifier.matches("[A-Za-z][A-Za-z0-9]*")) {
            throw new IllegalArgumentException("Unsafe material scrap list identifier: " + identifier);
        }
        return '"' + identifier + '"';
    }

    private record QuerySpec(
        String sql,
        String view,
        List<String> keywordFields,
        Map<String, String> filterExpressions,
        Map<String, String> sortExpressions,
        String defaultSort,
        String stableSort
    ) {
    }
}
