package com.jdy.erp.reports.application;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

/** Exact registry only; there is deliberately no default report definition. */
@Component
public final class ReportQuerySpecRegistry {
    private final Map<String, ReportQuerySpec> specs;

    public ReportQuerySpecRegistry(List<ReportQuerySpec> definitions) {
        var registered = new LinkedHashMap<String, ReportQuerySpec>();
        for (var definition : definitions) {
            if (definition == null) {
                throw new IllegalStateException("report definition must not be null");
            }
            var previous = registered.putIfAbsent(definition.reportKey(), definition);
            if (previous != null) {
                throw new IllegalStateException("duplicate report key: " + definition.reportKey());
            }
        }
        this.specs = Map.copyOf(registered);
    }

    public ReportQuerySpec require(String reportKey) {
        var definition = reportKey == null ? null : specs.get(reportKey);
        if (definition == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "报表不存在");
        }
        return definition;
    }

    public int size() {
        return specs.size();
    }
}
