package com.jdy.erp.reports.application;

import java.lang.reflect.Array;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.annotation.JsonFormat;

public record ReportQueryResponse(
    String reportKey,
    int page,
    int pageSize,
    long total,
    List<Map<String, Object>> rows,
    List<Map<String, Object>> totals,
    Map<String, Object> query,
    @JsonFormat(shape = JsonFormat.Shape.STRING) Instant generatedAt
) {
    public ReportQueryResponse {
        rows = immutableRows(rows);
        totals = immutableRows(totals);
        query = immutableNormalizedMap(query);
    }

    private static List<Map<String, Object>> immutableRows(List<Map<String, Object>> rows) {
        return rows.stream()
            .map(ReportQueryResponse::immutableNormalizedMap)
            .toList();
    }

    private static Map<String, Object> immutableNormalizedMap(Map<String, Object> values) {
        var normalized = new LinkedHashMap<String, Object>();
        values.forEach((key, value) -> normalized.put(key, normalizeValue(value)));
        return java.util.Collections.unmodifiableMap(normalized);
    }

    private static Object normalizeValue(Object value) {
        if (value instanceof BigDecimal decimal) {
            return decimal.stripTrailingZeros().toPlainString();
        }
        if (value instanceof Map<?, ?> map) {
            var normalized = new LinkedHashMap<Object, Object>();
            map.forEach((key, nestedValue) -> normalized.put(key, normalizeValue(nestedValue)));
            return java.util.Collections.unmodifiableMap(normalized);
        }
        if (value instanceof Iterable<?> iterable) {
            var normalized = new ArrayList<Object>();
            iterable.forEach(nestedValue -> normalized.add(normalizeValue(nestedValue)));
            return java.util.Collections.unmodifiableList(normalized);
        }
        if (value != null && value.getClass().isArray()) {
            var normalized = new ArrayList<Object>();
            for (var index = 0; index < Array.getLength(value); index++) {
                normalized.add(normalizeValue(Array.get(value, index)));
            }
            return java.util.Collections.unmodifiableList(normalized);
        }
        return value;
    }
}
