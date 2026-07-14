package com.jdy.erp.reports.application;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;

import com.jdy.erp.reports.application.ReportQuerySpec.FilterOperator;
import com.jdy.erp.reports.application.ReportQuerySpec.PredicatePlacement;
import org.springframework.stereotype.Component;

@Component
public final class ReportQueryPlanner {
    private static final String FACT_ALIAS = "report_fact_source";
    private static final String RESULT_ALIAS = "report_row";

    public ReportQueryPlan plan(ReportQuerySpec spec, NormalizedReportQuery query) {
        var factPredicates = new ArrayList<String>();
        var factParameters = new ArrayList<Object>();
        var resultPredicates = new ArrayList<String>();
        var resultParameters = new ArrayList<Object>();

        if (spec.hasOuterDatePredicate()) {
            addPredicate(
                spec.datePredicatePlacement(),
                column(FACT_ALIAS, spec.dateColumn()) + " >= ?",
                column(RESULT_ALIAS, spec.dateColumn()) + " >= ?",
                List.of(query.dateFrom()),
                factPredicates,
                factParameters,
                resultPredicates,
                resultParameters
            );
            addPredicate(
                spec.datePredicatePlacement(),
                column(FACT_ALIAS, spec.dateColumn()) + " <= ?",
                column(RESULT_ALIAS, spec.dateColumn()) + " <= ?",
                List.of(query.dateTo()),
                factPredicates,
                factParameters,
                resultPredicates,
                resultParameters
            );
        }

        for (var term : query.keywordTerms()) {
            var factAlternatives = spec.keywordColumns().stream()
                .map(field -> column(FACT_ALIAS, field))
                .map(field -> field + " ILIKE ? ESCAPE '!'")
                .toList();
            var resultAlternatives = spec.keywordColumns().stream()
                .map(field -> column(RESULT_ALIAS, field))
                .map(field -> field + " ILIKE ? ESCAPE '!'")
                .toList();
            var escaped = "%" + escapeLike(term) + "%";
            var values = java.util.Collections.nCopies(factAlternatives.size(), (Object) escaped);
            addPredicate(
                spec.keywordPredicatePlacement(),
                "(" + String.join(" OR ", factAlternatives) + ")",
                "(" + String.join(" OR ", resultAlternatives) + ")",
                values,
                factPredicates,
                factParameters,
                resultPredicates,
                resultParameters
            );
        }

        query.filters().forEach((parameter, value) -> {
            var definition = spec.filters().get(parameter);
            if (definition.placement() == PredicatePlacement.BOUND_ONLY) {
                return;
            }
            var factField = column(FACT_ALIAS, definition.column());
            var resultField = column(RESULT_ALIAS, definition.column());
            final String factPredicate;
            final String resultPredicate;
            final Object predicateValue;
            if (definition.operator() == FilterOperator.CONTAINS) {
                factPredicate = factField + " ILIKE ? ESCAPE '!'";
                resultPredicate = resultField + " ILIKE ? ESCAPE '!'";
                predicateValue = "%" + escapeLike(String.valueOf(value)) + "%";
            } else {
                factPredicate = factField + " = ?";
                resultPredicate = resultField + " = ?";
                predicateValue = value;
            }
            addPredicate(
                definition.placement(),
                factPredicate,
                resultPredicate,
                List.of(predicateValue),
                factPredicates,
                factParameters,
                resultPredicates,
                resultParameters
            );
        });

        var orderTerms = new ArrayList<String>();
        var usedFields = new LinkedHashSet<String>();
        addSort(spec, query.sortField(), query.sortDirection(), usedFields, orderTerms);
        for (var term : spec.stableSort()) {
            addSort(spec, term.field(), term.direction(), usedFields, orderTerms);
        }

        return new ReportQueryPlan(
            query,
            factPredicates.isEmpty() ? "TRUE" : String.join(" AND ", factPredicates),
            factParameters,
            resultPredicates.isEmpty() ? "TRUE" : String.join(" AND ", resultPredicates),
            resultParameters,
            String.join(", ", orderTerms)
        );
    }

    private void addPredicate(
        PredicatePlacement placement,
        String factPredicate,
        String resultPredicate,
        List<Object> values,
        List<String> factPredicates,
        List<Object> factParameters,
        List<String> resultPredicates,
        List<Object> resultParameters
    ) {
        if (placement == PredicatePlacement.FACT || placement == PredicatePlacement.BOTH) {
            factPredicates.add(factPredicate);
            factParameters.addAll(values);
        }
        if (placement == PredicatePlacement.RESULT || placement == PredicatePlacement.BOTH) {
            resultPredicates.add(resultPredicate);
            resultParameters.addAll(values);
        }
    }

    private void addSort(
        ReportQuerySpec spec,
        String field,
        ReportQuerySpec.SortDirection direction,
        LinkedHashSet<String> usedFields,
        List<String> orderTerms
    ) {
        if (!usedFields.add(field)) {
            return;
        }
        orderTerms.add(column(RESULT_ALIAS, spec.sortColumns().get(field)) + " " + direction.name());
    }

    private String column(String alias, String column) {
        return alias + ".\"" + column + "\"";
    }

    private String escapeLike(String value) {
        return value
            .replace("!", "!!")
            .replace("%", "!%")
            .replace("_", "!_");
    }
}
