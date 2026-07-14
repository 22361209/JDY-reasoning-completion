package com.jdy.erp.reports.application;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

import com.jdy.erp.reports.application.ReportQuerySpec.FilterDefinition;
import com.jdy.erp.reports.application.ReportQuerySpec.SortDirection;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

@Component
public final class ReportQueryParser {
    private static final Set<Integer> PAGE_SIZES = Set.of(20, 50, 100, 200, 500);
    private static final Set<String> COMMON_PARAMETERS = Set.of(
        "page", "pageSize", "sortField", "sortOrder", "keyword"
    );
    private static final Set<String> FORBIDDEN_SCOPE_PARAMETERS = Set.of(
        "scope", "scopeId", "dataScope", "dataScopeId", "schema",
        "accountSetId", "accountSet", "tenantId", "tenant"
    );
    private static final Pattern CANONICAL_UUID = Pattern.compile(
        "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
    );
    private static final Pattern DECIMAL = Pattern.compile("[-+]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)");
    private static final int MAX_TEXT_LENGTH = 200;
    private static final int MAX_KEYWORD_TERMS = 10;
    private static final int MAX_PAGE = 10_000;
    private static final long MAX_OFFSET = 1_000_000L;

    public NormalizedReportQuery parse(ReportQuerySpec spec, Map<String, List<String>> rawParameters) {
        var parameters = rawParameters == null ? Map.<String, List<String>>of() : rawParameters;
        validateParameterNames(spec, parameters.keySet());
        var values = singleValues(parameters);

        var page = positiveInt(values.get("page"), 1, "page");
        var pageSize = positiveInt(values.get("pageSize"), 100, "pageSize");
        if (!PAGE_SIZES.contains(pageSize)) {
            throw badRequest("pageSize 只允许 20/50/100/200/500");
        }
        if (page > MAX_PAGE) {
            throw badRequest("page 最大允许 " + MAX_PAGE);
        }
        var requestedOffset = Math.multiplyExact((long) page - 1L, pageSize);
        if (requestedOffset > MAX_OFFSET) {
            throw badRequest("分页偏移过大，请缩小范围或使用更精确筛选");
        }

        LocalDate dateFrom = null;
        LocalDate dateTo = null;
        if (spec.requiresDateRange()) {
            dateFrom = date(values.get("dateFrom"), "dateFrom");
            dateTo = date(values.get("dateTo"), "dateTo");
            if (dateFrom.isAfter(dateTo)) {
                throw badRequest("dateFrom 不能晚于 dateTo");
            }
        }

        var keyword = normalizedKeyword(values.get("keyword"));
        if (!keyword.isEmpty() && spec.keywordColumns().isEmpty()) {
            throw badRequest("当前报表不支持 keyword");
        }
        var keywordTerms = keyword.isEmpty() ? List.<String>of() : List.of(keyword.split(" "));
        if (keywordTerms.size() > MAX_KEYWORD_TERMS) {
            throw badRequest("keyword 最多允许 " + MAX_KEYWORD_TERMS + " 个词");
        }

        var selectedSort = selectedSort(spec, values);
        var filters = new LinkedHashMap<String, Object>();
        spec.filters().forEach((parameter, definition) -> {
            if (values.containsKey(parameter)) {
                filters.put(parameter, parseFilterValue(definition, values.get(parameter)));
            } else if (definition.defaultValue() != null) {
                filters.put(parameter, parseFilterValue(definition, definition.defaultValue()));
            } else if (definition.required()) {
                throw badRequest("报表过滤参数必填：" + definition.parameter());
            }
        });

        var echo = new LinkedHashMap<String, Object>();
        if (dateFrom != null) {
            echo.put("dateFrom", dateFrom.toString());
            echo.put("dateTo", dateTo.toString());
        }
        if (!keyword.isEmpty()) {
            echo.put("keyword", keyword);
        }
        filters.forEach((key, value) -> echo.put(key, echoValue(value)));
        echo.put("page", page);
        echo.put("pageSize", pageSize);
        echo.put("sortField", selectedSort.field());
        echo.put("sortOrder", selectedSort.direction().name().toLowerCase(Locale.ROOT));

        return new NormalizedReportQuery(
            page,
            pageSize,
            dateFrom,
            dateTo,
            keyword,
            keywordTerms,
            selectedSort.field(),
            selectedSort.direction(),
            filters,
            echo
        );
    }

    private void validateParameterNames(ReportQuerySpec spec, Set<String> names) {
        var allowed = new LinkedHashSet<>(COMMON_PARAMETERS);
        if (spec.requiresDateRange()) {
            allowed.add("dateFrom");
            allowed.add("dateTo");
        }
        allowed.addAll(spec.filters().keySet());
        for (var name : names) {
            if (FORBIDDEN_SCOPE_PARAMETERS.contains(name) || spec.dataScopeNamespaces().contains(name)) {
                throw badRequest("报表只允许当前账套范围");
            }
            if (!allowed.contains(name)) {
                throw badRequest("未知报表参数：" + safeName(name));
            }
        }
    }

    private Map<String, String> singleValues(Map<String, List<String>> parameters) {
        var values = new LinkedHashMap<String, String>();
        parameters.forEach((name, rawValues) -> {
            if (rawValues == null || rawValues.size() != 1) {
                throw badRequest("报表参数不得重复：" + safeName(name));
            }
            var value = rawValues.getFirst();
            if (value == null) {
                throw badRequest("报表参数不能为空：" + safeName(name));
            }
            values.put(name, value);
        });
        return values;
    }

    private ReportQuerySpec.SortTerm selectedSort(ReportQuerySpec spec, Map<String, String> values) {
        var requestedField = normalizedOptional(values.get("sortField"));
        var requestedDirection = normalizedOptional(values.get("sortOrder"));
        if (requestedField == null && requestedDirection != null) {
            throw badRequest("sortOrder 必须与 sortField 同时提交");
        }
        if (requestedField == null) {
            return spec.defaultSort().getFirst();
        }
        if (!spec.sortColumns().containsKey(requestedField)) {
            throw badRequest("不支持的排序字段");
        }
        var direction = requestedDirection == null
            ? SortDirection.ASC
            : switch (requestedDirection.toLowerCase(Locale.ROOT)) {
                case "asc" -> SortDirection.ASC;
                case "desc" -> SortDirection.DESC;
                default -> throw badRequest("sortOrder 只允许 asc/desc");
            };
        return new ReportQuerySpec.SortTerm(requestedField, direction);
    }

    private Object parseFilterValue(FilterDefinition definition, String rawValue) {
        var value = rawValue == null ? "" : rawValue.trim();
        if (value.isEmpty()) {
            throw badRequest("报表过滤值不能为空：" + definition.parameter());
        }
        if (value.length() > MAX_TEXT_LENGTH) {
            throw badRequest("报表过滤值过长：" + definition.parameter());
        }
        try {
            return switch (definition.valueType()) {
                case TEXT -> value;
                case UUID -> canonicalUuid(value);
                case ENUM -> enumValue(definition, value);
                case BOOLEAN -> booleanValue(value);
                case INTEGER -> Integer.valueOf(value);
                case LONG -> Long.valueOf(value);
                case DECIMAL -> decimalValue(value);
                case DATE -> LocalDate.parse(value);
            };
        } catch (NumberFormatException | DateTimeParseException exception) {
            throw badRequest("报表过滤值格式非法：" + definition.parameter());
        }
    }

    private UUID canonicalUuid(String value) {
        if (!CANONICAL_UUID.matcher(value).matches()) {
            throw badRequest("UUID 过滤值格式非法");
        }
        return UUID.fromString(value);
    }

    private String enumValue(FilterDefinition definition, String value) {
        if (!definition.allowedValues().contains(value)) {
            throw badRequest("报表枚举过滤值非法：" + definition.parameter());
        }
        return value;
    }

    private Boolean booleanValue(String value) {
        return switch (value) {
            case "true" -> Boolean.TRUE;
            case "false" -> Boolean.FALSE;
            default -> throw badRequest("布尔过滤值只允许 true/false");
        };
    }

    private BigDecimal decimalValue(String value) {
        if (!DECIMAL.matcher(value).matches()) {
            throw badRequest("数值过滤值格式非法");
        }
        return new BigDecimal(value);
    }

    private LocalDate date(String value, String name) {
        if (value == null || value.isBlank()) {
            throw badRequest(name + " 必填");
        }
        try {
            return LocalDate.parse(value);
        } catch (DateTimeParseException exception) {
            throw badRequest(name + " 必须是 ISO 日期");
        }
    }

    private int positiveInt(String value, int defaultValue, String name) {
        if (value == null) {
            return defaultValue;
        }
        if (value.isBlank()) {
            throw badRequest(name + " 不能为空");
        }
        try {
            var parsed = Integer.parseInt(value);
            if (parsed < 1) {
                throw badRequest(name + " 必须大于 0");
            }
            return parsed;
        } catch (NumberFormatException exception) {
            throw badRequest(name + " 必须是整数");
        }
    }

    private String normalizedKeyword(String value) {
        if (value == null || value.isBlank()) {
            return "";
        }
        var normalized = String.join(" ", value.trim().split("\\s+"));
        if (normalized.length() > MAX_TEXT_LENGTH) {
            throw badRequest("keyword 最长 200 个字符");
        }
        return normalized;
    }

    private String normalizedOptional(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }

    private Object echoValue(Object value) {
        return value instanceof LocalDate || value instanceof UUID ? value.toString() : value;
    }

    private String safeName(String value) {
        if (value == null) {
            return "";
        }
        var safe = value.replaceAll("[^A-Za-z0-9_-]", "");
        return safe.substring(0, Math.min(64, safe.length()));
    }

    private ResponseStatusException badRequest(String reason) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, reason);
    }
}
