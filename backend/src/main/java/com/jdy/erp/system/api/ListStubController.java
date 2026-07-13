package com.jdy.erp.system.api;

import java.util.List;
import java.util.Map;

import com.jdy.erp.system.application.list.ListQueryRequest;
import com.jdy.erp.system.application.list.ListQueryService;
import com.jdy.erp.system.application.list.ListSeedRowsProvider;
import com.jdy.erp.system.application.list.ListExportColumnProvider;
import com.jdy.erp.system.application.list.ListStubStateGuard;
import com.jdy.erp.system.application.list.OperationLogListQueryAdapter;
import com.jdy.erp.system.application.list.OperationLogRow;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/lists")
public class ListStubController {
    private final ListQueryService listQueryService;
    private final ListSeedRowsProvider seedRowsProvider;
    private final ListExportColumnProvider exportColumnProvider;
    private final ListStubStateGuard stateGuard;
    private final OperationLogListQueryAdapter operationLogListQueryAdapter;

    public ListStubController(
        ListQueryService listQueryService,
        ListSeedRowsProvider seedRowsProvider,
        ListExportColumnProvider exportColumnProvider,
        ListStubStateGuard stateGuard,
        OperationLogListQueryAdapter operationLogListQueryAdapter
    ) {
        this.listQueryService = listQueryService;
        this.seedRowsProvider = seedRowsProvider;
        this.exportColumnProvider = exportColumnProvider;
        this.stateGuard = stateGuard;
        this.operationLogListQueryAdapter = operationLogListQueryAdapter;
    }

    @GetMapping("/{listKey}")
    public Map<String, Object> rows(
        @PathVariable String listKey,
        @RequestParam(defaultValue = "") String keyword,
        @RequestParam(defaultValue = "") String status,
        @RequestParam(defaultValue = "1") int page,
        @RequestParam(defaultValue = "200") int pageSize,
        @RequestParam(defaultValue = "header") String view,
        @RequestParam(defaultValue = "") String sortField,
        @RequestParam(defaultValue = "asc") String sortOrder,
        @RequestParam(defaultValue = "") String columnFilters,
        @RequestParam(defaultValue = "") String module,
        @RequestParam(defaultValue = "") String action,
        @RequestParam(defaultValue = "") String operator,
        @RequestParam(defaultValue = "") String targetType,
        @RequestParam(defaultValue = "") String actorType,
        @RequestParam(defaultValue = "current") String scope,
        @RequestParam(defaultValue = "") String dateFrom,
        @RequestParam(defaultValue = "") String dateTo
    ) {
        stateGuard.assertReadable(listKey, scope);

        var request = listQueryRequest(listKey, keyword, status, page, pageSize, view, sortField, sortOrder, columnFilters, module, action, operator, targetType, actorType, scope, dateFrom, dateTo, false);
        var result = listQueryService.query(request, seedRowsProvider);
        var response = new java.util.LinkedHashMap<String, Object>();
        response.put("page", result.page());
        response.put("pageSize", result.pageSize());
        response.put("view", result.view());
        response.put("sortField", result.sortField());
        response.put("sortOrder", result.sortOrder());
        response.put("scope", scope == null || scope.isBlank() ? "current" : scope.trim().toLowerCase(java.util.Locale.ROOT));
        response.put("total", result.total());
        response.put("rows", result.rows());
        return response;
    }

    public Map<String, Object> rows(
        String listKey,
        String keyword,
        String status,
        int page,
        int pageSize,
        String view,
        String sortField,
        String sortOrder,
        String columnFilters,
        String module,
        String action,
        String operator,
        String targetType,
        String dateFrom,
        String dateTo
    ) {
        return rows(
            listKey, keyword, status, page, pageSize, view, sortField, sortOrder, columnFilters,
            module, action, operator, targetType, "", "current", dateFrom, dateTo
        );
    }

    @GetMapping("/{listKey}/export.csv")
    public ResponseEntity<String> exportCsv(
        @PathVariable String listKey,
        @RequestParam(defaultValue = "") String keyword,
        @RequestParam(defaultValue = "") String status,
        @RequestParam(defaultValue = "1000") int pageSize,
        @RequestParam(defaultValue = "header") String view,
        @RequestParam(defaultValue = "") String sortField,
        @RequestParam(defaultValue = "asc") String sortOrder,
        @RequestParam(defaultValue = "") String columnFilters,
        @RequestParam(defaultValue = "") String module,
        @RequestParam(defaultValue = "") String action,
        @RequestParam(defaultValue = "") String operator,
        @RequestParam(defaultValue = "") String targetType,
        @RequestParam(defaultValue = "") String actorType,
        @RequestParam(defaultValue = "current") String scope,
        @RequestParam(defaultValue = "") String dateFrom,
        @RequestParam(defaultValue = "") String dateTo
    ) {
        stateGuard.assertReadable(listKey, scope);

        var request = listQueryRequest(listKey, keyword, status, 1, pageSize, view, sortField, sortOrder, columnFilters, module, action, operator, targetType, actorType, scope, dateFrom, dateTo, true);
        var rows = listQueryService.query(request, seedRowsProvider).rows();
        var columns = exportColumnProvider.columnsFor(listKey, rows);
        var csv = new StringBuilder();
        csv.append('\ufeff');
        csv.append(columns.stream().map(column -> escapeCsv(column.title())).collect(java.util.stream.Collectors.joining(","))).append('\n');
        for (var row : rows) {
            csv.append(columns.stream()
                .map(column -> escapeCsv(String.valueOf(row.get(column.field()) == null ? "" : row.get(column.field()))))
                .collect(java.util.stream.Collectors.joining(",")))
                .append('\n');
        }
        var fileName = listKey + "-export.csv";
        return ResponseEntity.ok()
            .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + fileName + "\"")
            .contentType(new MediaType("text", "csv", java.nio.charset.StandardCharsets.UTF_8))
            .body(csv.toString());
    }

    public ResponseEntity<String> exportCsv(
        String listKey,
        String keyword,
        String status,
        int pageSize,
        String view,
        String sortField,
        String sortOrder,
        String columnFilters,
        String module,
        String action,
        String operator,
        String targetType,
        String dateFrom,
        String dateTo
    ) {
        return exportCsv(
            listKey, keyword, status, pageSize, view, sortField, sortOrder, columnFilters,
            module, action, operator, targetType, "", "current", dateFrom, dateTo
        );
    }

    @GetMapping("/operation-log-list/rows/{id}")
    public OperationLogRow operationLogDetail(
        @PathVariable String id,
        @RequestParam(defaultValue = "current") String scope
    ) {
        stateGuard.assertReadable("operation-log-list", scope);
        return operationLogListQueryAdapter.detail(id, scope);
    }

    private ListQueryRequest listQueryRequest(
        String listKey,
        String keyword,
        String status,
        int page,
        int pageSize,
        String view,
        String sortField,
        String sortOrder,
        String columnFilters,
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
        return new ListQueryRequest(
            listKey,
            keyword == null ? "" : keyword,
            status == null ? "" : status,
            Math.max(1, page),
            pageSize,
            normalizedView(view),
            sortField == null ? "" : sortField,
            sortOrder == null ? "asc" : sortOrder,
            columnFilters == null ? "" : columnFilters,
            module == null ? "" : module,
            action == null ? "" : action,
            operator == null ? "" : operator,
            targetType == null ? "" : targetType,
            actorType == null ? "" : actorType,
            scope == null || scope.isBlank() ? "current" : scope,
            dateFrom == null ? "" : dateFrom,
            dateTo == null ? "" : dateTo,
            exportMode
        );
    }

    private String normalizedView(String view) {
        return "detail".equalsIgnoreCase(view) ? "detail" : "header";
    }

    private String escapeCsv(String value) {
        if (value == null) {
            return "";
        }
        if (value.contains(",") || value.contains("\"") || value.contains("\n") || value.contains("\r")) {
            return "\"" + value.replace("\"", "\"\"") + "\"";
        }
        return value;
    }

}
