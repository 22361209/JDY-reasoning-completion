package com.jdy.erp.reports.application;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public record ReportQueryPlan(
    NormalizedReportQuery query,
    String factPredicateSql,
    List<Object> factPredicateParameters,
    String resultPredicateSql,
    List<Object> resultPredicateParameters,
    String orderBySql,
    Map<String, String> dataScopeIds
) {
    public ReportQueryPlan {
        factPredicateParameters = List.copyOf(factPredicateParameters);
        resultPredicateParameters = List.copyOf(resultPredicateParameters);
        dataScopeIds = java.util.Collections.unmodifiableMap(new LinkedHashMap<>(dataScopeIds));
    }

    public ReportQueryPlan(
        NormalizedReportQuery query,
        String factPredicateSql,
        List<Object> factPredicateParameters,
        String resultPredicateSql,
        List<Object> resultPredicateParameters,
        String orderBySql
    ) {
        this(
            query,
            factPredicateSql,
            factPredicateParameters,
            resultPredicateSql,
            resultPredicateParameters,
            orderBySql,
            Map.of()
        );
    }

    public ReportQueryPlan withDataScopes(Map<String, String> resolvedDataScopes) {
        return new ReportQueryPlan(
            query,
            factPredicateSql,
            factPredicateParameters,
            resultPredicateSql,
            resultPredicateParameters,
            orderBySql,
            resolvedDataScopes
        );
    }

    public List<Object> parametersWithSource(ReportQuerySpec spec) {
        var parameters = new ArrayList<Object>(
            spec.sourceParameters().size()
                + factPredicateParameters.size()
                + spec.resultParameters().size()
                + resultPredicateParameters.size()
        );
        addBindings(parameters, spec.sourceParameters());
        parameters.addAll(factPredicateParameters);
        addBindings(parameters, spec.resultParameters());
        parameters.addAll(resultPredicateParameters);
        return parameters;
    }

    private void addBindings(
        List<Object> parameters,
        List<ReportQuerySpec.SourceParameterBinding> bindings
    ) {
        for (var binding : bindings) {
            parameters.add(switch (binding.kind()) {
                case FIXED -> binding.fixedValue();
                case DATE_FROM -> query.dateFrom();
                case DATE_TO -> query.dateTo();
                case FILTER -> query.filters().get(binding.filterParameter());
                case DATA_SCOPE -> requireDataScope(binding.dataScopeNamespace());
            });
        }
    }

    private String requireDataScope(String namespace) {
        var scopeId = dataScopeIds.get(namespace);
        if (scopeId == null || scopeId.isBlank()) {
            throw new IllegalStateException("report data scope was not resolved");
        }
        return scopeId;
    }
}
