package com.jdy.erp.system.application.list;

import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.stream.Stream;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

@Component
public class ListQuerySupport {
    private final ObjectMapper objectMapper;

    public ListQuerySupport(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    public List<String> keywordTokens(String keyword) {
        if (keyword == null || keyword.isBlank()) {
            return List.of();
        }
        return Stream.of(keyword.trim().split("[\\s\\u3000]+"))
            .map(String::trim)
            .filter(token -> !token.isBlank())
            .toList();
    }

    public Map<String, Map<String, String>> columnFilters(ListQueryRequest request) {
        var filters = new LinkedHashMap<>(parseColumnFilters(request.columnFiltersJson()));
        if (request.legacyStatus() != null && !request.legacyStatus().isBlank() && !filters.containsKey("status")) {
            filters.put("status", Map.of("operator", "等于", "value", request.legacyStatus()));
        }
        return filters;
    }

    public boolean matchesKeywordTokens(Map<String, ?> row, List<String> searchFields, List<String> tokens) {
        if (tokens.isEmpty()) {
            return true;
        }
        var fields = searchFields.isEmpty() ? row.keySet().stream().toList() : searchFields;
        return tokens.stream().allMatch(token -> fields.stream().anyMatch(field -> {
            var value = row.get(field);
            return value != null && String.valueOf(value).contains(token);
        }));
    }

    public boolean matchesDateRange(Map<String, ?> row, String dateField, String dateFrom, String dateTo) {
        if (dateField == null || dateField.isBlank() || ((dateFrom == null || dateFrom.isBlank()) && (dateTo == null || dateTo.isBlank()))) {
            return true;
        }
        var rawValue = row.get(dateField);
        var value = String.valueOf(rawValue == null ? "" : rawValue);
        var date = value.length() >= 10 ? value.substring(0, 10) : value;
        return (dateFrom == null || dateFrom.isBlank() || date.compareTo(dateFrom) >= 0)
            && (dateTo == null || dateTo.isBlank() || date.compareTo(dateTo) <= 0);
    }

    public boolean matchesOperationLogFilters(
        String listKey,
        Map<String, ?> row,
        String module,
        String action,
        String operator,
        String targetType,
        String dateFrom,
        String dateTo
    ) {
        if (!"operation-log-list".equals(listKey)) {
            return true;
        }
        var rowModule = String.valueOf(row.get("module") == null ? "" : row.get("module"));
        var rowAction = String.valueOf(row.get("action") == null ? "" : row.get("action"));
        var rowOperator = String.valueOf(row.get("operator") == null ? "" : row.get("operator"));
        var rowTargetType = String.valueOf(row.get("targetType") == null ? "" : row.get("targetType"));
        var operatedAt = String.valueOf(row.get("operatedAt") == null ? "" : row.get("operatedAt"));
        var operatedDate = operatedAt.length() >= 10 ? operatedAt.substring(0, 10) : "";
        return (module == null || module.isBlank() || module.equals(rowModule))
            && (action == null || action.isBlank() || action.equals(rowAction))
            && (operator == null || operator.isBlank() || rowOperator.contains(operator))
            && (targetType == null || targetType.isBlank() || targetType.equals(rowTargetType))
            && (dateFrom == null || dateFrom.isBlank() || operatedDate.compareTo(dateFrom) >= 0)
            && (dateTo == null || dateTo.isBlank() || operatedDate.compareTo(dateTo) <= 0);
    }

    public boolean matchesColumnFilters(Map<String, ?> row, Map<String, Map<String, String>> filters) {
        return filters.entrySet().stream().allMatch(entry -> {
            var filter = entry.getValue();
            var operator = filter.getOrDefault("operator", "包含");
            var value = filter.getOrDefault("value", "");
            var rawValue = row.get(entry.getKey());
            var cellValue = String.valueOf(rawValue == null ? "" : rawValue);
            return switch (operator) {
                case "不包含" -> !cellValue.contains(value);
                case "等于" -> cellValue.equals(value);
                case "不等于" -> !cellValue.equals(value);
                case "以……开始" -> cellValue.startsWith(value);
                case "以……结束" -> cellValue.endsWith(value);
                case "为空" -> cellValue.isBlank();
                case "不为空" -> !cellValue.isBlank();
                default -> cellValue.contains(value);
            };
        });
    }

    public Comparator<Map<String, ?>> comparator(String sortField, String sortOrder) {
        var comparator = Comparator.comparing((Map<String, ?> row) -> {
            var rawValue = row.get(sortField);
            return String.valueOf(rawValue == null ? "" : rawValue);
        });
        return "desc".equalsIgnoreCase(sortOrder) ? comparator.reversed() : comparator;
    }

    public String normalizedSortOrder(String sortOrder) {
        return "desc".equalsIgnoreCase(sortOrder) ? "desc" : "asc";
    }

    public boolean hasText(String value) {
        return value != null && !value.isBlank();
    }

    public String likeToken(String token) {
        return "%" + token.toLowerCase(Locale.ROOT) + "%";
    }

    private Map<String, Map<String, String>> parseColumnFilters(String columnFilters) {
        if (columnFilters == null || columnFilters.isBlank()) {
            return Map.of();
        }
        try {
            return objectMapper.readValue(columnFilters, new TypeReference<>() {});
        } catch (Exception ignored) {
            return Map.of();
        }
    }
}
