package com.jdy.erp.system.application.list;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.jdy.erp.system.tenant.TenantContext;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

@Component
public class OperationLogListQueryAdapter implements ListQueryAdapter {
    private static final ZoneId BUSINESS_ZONE = ZoneId.of("Asia/Shanghai");
    private static final Set<String> SCOPES = Set.of("current", "platform", "historical");
    private static final Set<String> ACTOR_TYPES = Set.of("USER", "SYSTEM", "ANONYMOUS", "HISTORICAL_UNKNOWN");
    private static final Set<String> FILTER_OPERATORS = Set.of("包含", "不包含", "等于", "不等于", "以……开始", "以……结束", "为空", "不为空");
    private static final String ACTOR_LABEL_SQL = """
        CASE l.actor_type
          WHEN 'USER' THEN CASE
            WHEN COALESCE(l.actor_display_name, '') <> '' THEN l.actor_display_name || '（' || COALESCE(l.actor_username, '') || '）'
            ELSE COALESCE(l.actor_username, '')
          END
          WHEN 'SYSTEM' THEN '系统任务'
          WHEN 'ANONYMOUS' THEN '未认证请求'
          WHEN 'HISTORICAL_UNKNOWN' THEN '历史未知'
          ELSE '历史未知'
        END
        """;
    private static final String SELECT_SQL = """
        SELECT l.id::text AS id,
               to_char(l.operated_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') AS operated_at,
               l.module_code,
               l.action_code,
               l.actor_type,
               COALESCE(l.actor_username, '') AS actor_username,
               COALESCE(l.actor_display_name, '') AS actor_display_name,
               """ + ACTOR_LABEL_SQL + " AS operator,\n" + """
               COALESCE(l.account_set_id::text, '') AS account_set_id,
               COALESCE(l.account_set_code, '') AS account_set_code,
               COALESCE(l.account_set_name, '') AS account_set_name,
               l.target_type,
               COALESCE(l.target_id::text, '') AS target_id,
               COALESCE(l.target_no, '') AS target_no,
               l.success,
               CASE WHEN l.success THEN '成功' ELSE '失败' END AS status,
               COALESCE(l.failure_reason, '') AS reason,
               l.before_state::text AS before_state,
               l.after_state::text AS after_state
        FROM sys_operation_log l
        """;

    private final JdbcTemplate tenantJdbcTemplate;
    private final JdbcTemplate platformJdbcTemplate;
    private final ObjectMapper objectMapper;

    public OperationLogListQueryAdapter(
        JdbcTemplate tenantJdbcTemplate,
        @Qualifier("platformJdbcTemplate") JdbcTemplate platformJdbcTemplate,
        ObjectMapper objectMapper
    ) {
        this.tenantJdbcTemplate = tenantJdbcTemplate;
        this.platformJdbcTemplate = platformJdbcTemplate;
        this.objectMapper = objectMapper;
    }

    @Override
    public String key() {
        return "operationLog";
    }

    @Override
    public ListQueryResult query(ListQueryRequest request, ListQueryContract contract, ListQuerySupport support, ListSeedRowsProvider seedRowsProvider) {
        if (!"header".equals(request.normalizedView())) {
            throw badRequest("Operation-log detail view uses the row detail endpoint");
        }
        var scope = normalizedScope(request.scope());
        var jdbcTemplate = jdbcTemplate(scope);
        var where = new WhereClause();
        appendScope(where, scope);
        appendRequestFilters(where, request, support);

        var sortField = normalizedSortField(request.sortField());
        var sortOrder = hasText(request.sortField()) ? support.normalizedSortOrder(request.sortOrder()) : "desc";
        var orderBy = orderBy(sortField, sortOrder);
        var total = jdbcTemplate.queryForObject(
            "SELECT count(*) FROM sys_operation_log l WHERE " + where.sql(),
            Long.class,
            where.parameters().toArray()
        );
        var queryParameters = new ArrayList<>(where.parameters());
        var sql = SELECT_SQL + " WHERE " + where.sql() + " ORDER BY " + orderBy;
        var pageSize = Math.max(1, Math.min(request.pageSize(), 1000));
        if (!request.exportMode()) {
            sql += " LIMIT ? OFFSET ?";
            queryParameters.add(pageSize);
            queryParameters.add((long) (request.page() - 1) * pageSize);
        }
        var rows = jdbcTemplate.query(sql, this::mapRow, queryParameters.toArray()).stream()
            .map(OperationLogRow::toMap)
            .toList();
        return new ListQueryResult(
            request.page(),
            pageSize,
            "header",
            sortField,
            sortOrder,
            total == null ? 0L : total,
            rows
        );
    }

    public OperationLogRow detail(String id, String requestedScope) {
        try {
            UUID.fromString(id);
        } catch (RuntimeException exception) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Operation log not found");
        }
        var scope = normalizedScope(requestedScope);
        var where = new WhereClause();
        appendScope(where, scope);
        where.add("l.id = ?::uuid", id);
        var rows = jdbcTemplate(scope).query(
            SELECT_SQL + " WHERE " + where.sql(),
            this::mapRow,
            where.parameters().toArray()
        );
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Operation log not found in selected scope");
        }
        return rows.get(0);
    }

    private void appendScope(WhereClause where, String scope) {
        switch (scope) {
            case "current" -> {
                var tenant = TenantContext.requireTenant();
                where.add("l.account_set_id = ?::uuid", tenant.accountSetId());
                where.add("l.account_set_code = ?", tenant.accountSetCode());
            }
            case "platform" -> {
                where.add("l.account_set_id IS NULL");
                where.add("l.account_set_code = 'platform'");
            }
            case "historical" -> {
                where.add("l.account_set_id IS NULL");
                where.add("l.account_set_code = ''");
            }
            default -> throw badRequest("Unsupported operation-log scope");
        }
    }

    private void appendRequestFilters(WhereClause where, ListQueryRequest request, ListQuerySupport support) {
        addExact(where, "l.module_code", request.module());
        addExact(where, "l.action_code", request.action());
        addExact(where, "l.target_type", request.targetType());
        if (hasText(request.actorType())) {
            var actorType = request.actorType().trim().toUpperCase(Locale.ROOT);
            if (!ACTOR_TYPES.contains(actorType)) {
                throw badRequest("Unsupported actor type");
            }
            where.add("l.actor_type = ?", actorType);
        }
        if (hasText(request.operator())) {
            where.add("lower(" + ACTOR_LABEL_SQL + ") LIKE ?", likeValue(request.operator(), "contains"));
        }
        appendDateRange(where, request.dateFrom(), request.dateTo());

        var keywordExpressions = List.of(
            "l.id::text", "l.module_code", "l.action_code", "l.actor_type", "COALESCE(l.actor_username, '')",
            "COALESCE(l.actor_display_name, '')", ACTOR_LABEL_SQL, "COALESCE(l.account_set_code, '')",
            "COALESCE(l.account_set_name, '')", "l.target_type", "COALESCE(l.target_id::text, '')",
            "COALESCE(l.target_no, '')", "COALESCE(l.failure_reason, '')"
        );
        for (var token : support.keywordTokens(request.keyword())) {
            var clauses = keywordExpressions.stream().map(expression -> "lower(" + expression + ") LIKE ?").toList();
            where.add("(" + String.join(" OR ", clauses) + ")", java.util.Collections.nCopies(clauses.size(), likeValue(token, "contains")));
        }
        appendColumnFilters(where, request);
    }

    private void appendColumnFilters(WhereClause where, ListQueryRequest request) {
        var filters = parseColumnFilters(request.columnFiltersJson());
        if (hasText(request.legacyStatus()) && !filters.containsKey("status")) {
            filters.put("status", Map.of("operator", "等于", "value", request.legacyStatus()));
        }
        for (var entry : filters.entrySet()) {
            var expression = filterExpressions().get(entry.getKey());
            if (expression == null) {
                throw badRequest("Unsupported operation-log filter field: " + entry.getKey());
            }
            var filter = entry.getValue();
            var operator = filter == null ? "包含" : String.valueOf(filter.getOrDefault("operator", "包含"));
            var value = filter == null ? "" : String.valueOf(filter.getOrDefault("value", ""));
            if (!FILTER_OPERATORS.contains(operator)) {
                throw badRequest("Unsupported operation-log filter operator: " + operator);
            }
            switch (operator) {
                case "包含" -> where.add("lower(" + expression + ") LIKE ?", likeValue(value, "contains"));
                case "不包含" -> where.add("lower(" + expression + ") NOT LIKE ?", likeValue(value, "contains"));
                case "等于" -> where.add("lower(" + expression + ") = ?", value.toLowerCase(Locale.ROOT));
                case "不等于" -> where.add("lower(" + expression + ") <> ?", value.toLowerCase(Locale.ROOT));
                case "以……开始" -> where.add("lower(" + expression + ") LIKE ?", likeValue(value, "starts"));
                case "以……结束" -> where.add("lower(" + expression + ") LIKE ?", likeValue(value, "ends"));
                case "为空" -> where.add("COALESCE(" + expression + ", '') = ''");
                case "不为空" -> where.add("COALESCE(" + expression + ", '') <> ''");
                default -> throw badRequest("Unsupported operation-log filter operator");
            }
        }
    }

    private LinkedHashMap<String, Map<String, String>> parseColumnFilters(String json) {
        if (!hasText(json)) {
            return new LinkedHashMap<>();
        }
        try {
            return new LinkedHashMap<>(objectMapper.readValue(json, new TypeReference<Map<String, Map<String, String>>>() {}));
        } catch (JsonProcessingException | IllegalArgumentException exception) {
            throw badRequest("Invalid operation-log column filters");
        }
    }

    private Map<String, String> filterExpressions() {
        return Map.ofEntries(
            Map.entry("id", "l.id::text"),
            Map.entry("operatedAt", "to_char(l.operated_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS')"),
            Map.entry("module", "l.module_code"),
            Map.entry("action", "l.action_code"),
            Map.entry("actorType", "l.actor_type"),
            Map.entry("actorUsername", "COALESCE(l.actor_username, '')"),
            Map.entry("actorDisplayName", "COALESCE(l.actor_display_name, '')"),
            Map.entry("operator", ACTOR_LABEL_SQL),
            Map.entry("accountSetId", "COALESCE(l.account_set_id::text, '')"),
            Map.entry("accountSetCode", "COALESCE(l.account_set_code, '')"),
            Map.entry("accountSetName", "COALESCE(l.account_set_name, '')"),
            Map.entry("targetType", "l.target_type"),
            Map.entry("targetId", "COALESCE(l.target_id::text, '')"),
            Map.entry("targetNo", "COALESCE(l.target_no, '')"),
            Map.entry("status", "CASE WHEN l.success THEN '成功' ELSE '失败' END"),
            Map.entry("reason", "COALESCE(l.failure_reason, '')"),
            Map.entry("beforeState", "COALESCE(l.before_state::text, '')"),
            Map.entry("afterState", "COALESCE(l.after_state::text, '')")
        );
    }

    private Map<String, String> sortExpressions() {
        return Map.ofEntries(
            Map.entry("id", "l.id"),
            Map.entry("operatedAt", "l.operated_at"),
            Map.entry("module", "l.module_code"),
            Map.entry("action", "l.action_code"),
            Map.entry("actorType", "l.actor_type"),
            Map.entry("actorUsername", "l.actor_username"),
            Map.entry("actorDisplayName", "l.actor_display_name"),
            Map.entry("operator", ACTOR_LABEL_SQL),
            Map.entry("accountSetCode", "l.account_set_code"),
            Map.entry("accountSetName", "l.account_set_name"),
            Map.entry("targetType", "l.target_type"),
            Map.entry("targetId", "l.target_id"),
            Map.entry("targetNo", "l.target_no"),
            Map.entry("status", "l.success"),
            Map.entry("reason", "l.failure_reason")
        );
    }

    private String normalizedSortField(String requested) {
        if (!hasText(requested)) {
            return "operatedAt";
        }
        if (!sortExpressions().containsKey(requested)) {
            throw badRequest("Unsupported operation-log sort field");
        }
        return requested;
    }

    private String orderBy(String sortField, String sortOrder) {
        var direction = "desc".equals(sortOrder) ? "DESC" : "ASC";
        var primary = sortExpressions().get(sortField) + " " + direction;
        return "id".equals(sortField) ? primary : primary + ", l.id " + direction;
    }

    private void appendDateRange(WhereClause where, String dateFrom, String dateTo) {
        try {
            if (hasText(dateFrom)) {
                where.add("l.operated_at >= ?", LocalDate.parse(dateFrom).atStartOfDay(BUSINESS_ZONE).toOffsetDateTime());
            }
            if (hasText(dateTo)) {
                where.add("l.operated_at < ?", LocalDate.parse(dateTo).plusDays(1).atStartOfDay(BUSINESS_ZONE).toOffsetDateTime());
            }
        } catch (DateTimeParseException exception) {
            throw badRequest("Invalid operation-log date range");
        }
    }

    private void addExact(WhereClause where, String expression, String value) {
        if (hasText(value)) {
            where.add(expression + " = ?", value.trim());
        }
    }

    private String likeValue(String value, String mode) {
        var escaped = String.valueOf(value == null ? "" : value).toLowerCase(Locale.ROOT)
            .replace("\\", "\\\\")
            .replace("%", "\\%")
            .replace("_", "\\_");
        return switch (mode) {
            case "starts" -> escaped + "%";
            case "ends" -> "%" + escaped;
            default -> "%" + escaped + "%";
        };
    }

    private String normalizedScope(String requested) {
        var scope = hasText(requested) ? requested.trim().toLowerCase(Locale.ROOT) : "current";
        if (!SCOPES.contains(scope)) {
            throw badRequest("Unsupported operation-log scope");
        }
        return scope;
    }

    private JdbcTemplate jdbcTemplate(String scope) {
        return "current".equals(scope) ? tenantJdbcTemplate : platformJdbcTemplate;
    }

    private OperationLogRow mapRow(ResultSet resultSet, int rowNumber) throws SQLException {
        return new OperationLogRow(
            resultSet.getString("id"),
            resultSet.getString("operated_at"),
            resultSet.getString("module_code"),
            resultSet.getString("action_code"),
            resultSet.getString("actor_type"),
            resultSet.getString("actor_username"),
            resultSet.getString("actor_display_name"),
            resultSet.getString("operator"),
            resultSet.getString("account_set_id"),
            resultSet.getString("account_set_code"),
            resultSet.getString("account_set_name"),
            resultSet.getString("target_type"),
            resultSet.getString("target_id"),
            resultSet.getString("target_no"),
            resultSet.getBoolean("success"),
            resultSet.getString("status"),
            resultSet.getString("reason"),
            parseJson(resultSet.getString("before_state")),
            parseJson(resultSet.getString("after_state"))
        );
    }

    private JsonNode parseJson(String value) throws SQLException {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return objectMapper.readTree(value);
        } catch (JsonProcessingException exception) {
            throw new SQLException("Invalid operation-log state JSON", exception);
        }
    }

    private boolean hasText(String value) {
        return value != null && !value.isBlank();
    }

    private ResponseStatusException badRequest(String message) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
    }

    private static final class WhereClause {
        private final List<String> clauses = new ArrayList<>();
        private final List<Object> parameters = new ArrayList<>();

        void add(String clause, Object... values) {
            clauses.add(clause);
            parameters.addAll(List.of(values));
        }

        void add(String clause, List<?> values) {
            clauses.add(clause);
            parameters.addAll(values);
        }

        String sql() {
            return String.join(" AND ", clauses);
        }

        List<Object> parameters() {
            return parameters;
        }
    }
}
