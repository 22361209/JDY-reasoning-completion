package com.jdy.erp.system.application.list;

public record ListQueryRequest(
    String listKey,
    String keyword,
    String legacyStatus,
    int page,
    int pageSize,
    String view,
    String sortField,
    String sortOrder,
    String columnFiltersJson,
    String module,
    String action,
    String operator,
    String targetType,
    String actorType,
    String scope,
    String dateFrom,
    String dateTo,
    boolean exportMode
) {
    public String normalizedView() {
        return "detail".equalsIgnoreCase(view) ? "detail" : "header";
    }
}
