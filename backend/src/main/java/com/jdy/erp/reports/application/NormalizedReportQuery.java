package com.jdy.erp.reports.application;

import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.jdy.erp.reports.application.ReportQuerySpec.SortDirection;

public record NormalizedReportQuery(
    int page,
    int pageSize,
    LocalDate dateFrom,
    LocalDate dateTo,
    String keyword,
    List<String> keywordTerms,
    String sortField,
    SortDirection sortDirection,
    Map<String, Object> filters,
    Map<String, Object> echo
) {
    public NormalizedReportQuery {
        keyword = keyword == null ? "" : keyword;
        keywordTerms = List.copyOf(keywordTerms);
        filters = java.util.Collections.unmodifiableMap(new LinkedHashMap<>(filters));
        echo = java.util.Collections.unmodifiableMap(new LinkedHashMap<>(echo));
    }

    public String auditSummary() {
        var summary = new StringBuilder();
        if (dateFrom != null) {
            summary.append("dateFrom=").append(dateFrom).append(",dateTo=").append(dateTo).append(';');
        }
        summary.append("keyword=").append(!keywordTerms.isEmpty()).append(';');
        summary.append("filters=").append(String.join("|", filters.keySet())).append(';');
        summary.append("sort=").append(sortField).append(':').append(sortDirection.name().toLowerCase(java.util.Locale.ROOT));
        var value = summary.toString();
        return value.substring(0, Math.min(900, value.length()));
    }
}
