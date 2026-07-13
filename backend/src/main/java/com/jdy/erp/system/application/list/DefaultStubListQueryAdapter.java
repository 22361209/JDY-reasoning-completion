package com.jdy.erp.system.application.list;

import java.util.List;

import org.springframework.stereotype.Component;

@Component
public class DefaultStubListQueryAdapter implements ListQueryAdapter {
    @Override
    public String key() {
        return "default";
    }

    @Override
    public ListQueryResult query(ListQueryRequest request, ListQueryContract contract, ListQuerySupport support, ListSeedRowsProvider seedRowsProvider) {
        var tokens = support.keywordTokens(request.keyword());
        var filters = support.columnFilters(request);
        var rows = seedRowsProvider
            .seedRows(request.listKey(), request.normalizedView(), request.pageSize())
            .stream()
            .filter(row -> support.matchesKeywordTokens(row, contract.keywordFields(), tokens))
            .filter(row -> support.matchesDateRange(row, contract.dateField(), request.dateFrom(), request.dateTo()))
            .filter(row -> support.matchesColumnFilters(row, filters))
            .toList();
        if (support.hasText(request.sortField())) {
            rows = rows.stream()
                .sorted(support.comparator(request.sortField(), request.sortOrder()))
                .toList();
        }
        var total = rows.size();
        var pagedRows = request.exportMode()
            ? rows
            : rows.stream().skip((long) (request.page() - 1) * request.pageSize()).limit(request.pageSize()).toList();
        return new ListQueryResult(request.page(), request.pageSize(), request.normalizedView(), request.sortField(), request.sortOrder(), total, pagedRows);
    }
}
