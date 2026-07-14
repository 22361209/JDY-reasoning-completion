package com.jdy.erp.reports.application;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.ArgumentPreparedStatementSetter;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.PreparedStatementCreator;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

@Component
public final class SqlReportQueryExecutor {
    public static final int EXPORT_ROW_LIMIT = 20_000;
    private static final int EXPORT_PROBE_LIMIT = EXPORT_ROW_LIMIT + 1;
    private static final int EXPORT_FETCH_SIZE = 500;

    private final JdbcTemplate jdbcTemplate;
    private final ReportCsvWriter csvWriter;
    private final ReportExportCleanupManager cleanupManager;

    public SqlReportQueryExecutor(
        JdbcTemplate jdbcTemplate,
        ReportCsvWriter csvWriter,
        ReportExportCleanupManager cleanupManager
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.csvWriter = csvWriter;
        this.cleanupManager = cleanupManager;
    }

    public QueryData query(ReportQuerySpec spec, ReportQueryPlan plan) {
        var total = count(spec, plan);
        if (total == 0L) {
            return new QueryData(0L, List.of(), List.of());
        }
        var totals = totals(spec, plan);
        var rows = rows(spec, plan);
        return new QueryData(total, rows, totals);
    }

    public ReportExportArtifact export(ReportQuerySpec spec, ReportQueryPlan plan) {
        var cappedTotal = cappedExportCount(spec, plan);
        if (cappedTotal > EXPORT_ROW_LIMIT) {
            throw new ResponseStatusException(
                HttpStatus.PAYLOAD_TOO_LARGE,
                "报表引出最多允许 " + EXPORT_ROW_LIMIT + " 行，请缩小筛选范围"
            );
        }

        final Path path;
        try {
            path = cleanupManager.createOwnedFile(spec.reportKey());
        } catch (IOException exception) {
            throw new ResponseStatusException(
                HttpStatus.INTERNAL_SERVER_ERROR,
                "报表引出临时文件创建失败",
                exception
            );
        }

        try (var output = Files.newOutputStream(path)) {
            var csv = csvWriter.open(spec, output);
            var actualRows = new AtomicLong();
            if (cappedTotal > 0L) {
                jdbcTemplate.query(
                    streamingStatement(exportSql(spec, plan), plan.parametersWithSource(spec)),
                    (RowCallbackHandler) resultSet -> writeExportRow(csv, resultSet, actualRows)
                );
            }
            if (actualRows.get() != cappedTotal) {
                throw new ResponseStatusException(
                    HttpStatus.INTERNAL_SERVER_ERROR,
                    "报表引出行数校验失败，请重试"
                );
            }
            var writtenBytes = csv.finish();
            output.flush();
            var contentLength = Files.size(path);
            if (contentLength != writtenBytes) {
                throw new ResponseStatusException(
                    HttpStatus.INTERNAL_SERVER_ERROR,
                    "报表引出文件长度校验失败，请重试"
                );
            }
            return cleanupManager.completeArtifact(
                spec.reportKey(),
                path,
                actualRows.get(),
                contentLength,
                plan.query().auditSummary()
            );
        } catch (IOException | UncheckedIOException exception) {
            abandonFailedArtifact(path, spec.reportKey());
            throw new ResponseStatusException(
                HttpStatus.INTERNAL_SERVER_ERROR,
                "报表引出临时文件写入失败",
                exception
            );
        } catch (RuntimeException | Error exception) {
            abandonFailedArtifact(path, spec.reportKey());
            throw exception;
        }
    }

    private long count(ReportQuerySpec spec, ReportQueryPlan plan) {
        var sql = """
            %s
            SELECT COUNT(*)
            FROM report_result report_row
            WHERE %s
            """.formatted(reportCtes(spec, plan), plan.resultPredicateSql());
        var result = jdbcTemplate.queryForObject(
            sql,
            Long.class,
            plan.parametersWithSource(spec).toArray()
        );
        return result == null ? 0L : result;
    }

    private long cappedExportCount(ReportQuerySpec spec, ReportQueryPlan plan) {
        var sql = """
            %s
            SELECT COUNT(*)
            FROM (
                SELECT 1
                FROM report_result report_row
                WHERE %s
                LIMIT ?
            ) report_export_cap
            """.formatted(reportCtes(spec, plan), plan.resultPredicateSql());
        var parameters = new ArrayList<>(plan.parametersWithSource(spec));
        parameters.add(EXPORT_PROBE_LIMIT);
        var result = jdbcTemplate.queryForObject(sql, Long.class, parameters.toArray());
        return result == null ? 0L : result;
    }

    private List<Map<String, Object>> rows(ReportQuerySpec spec, ReportQueryPlan plan) {
        var sql = """
            %s
            SELECT report_row.*
            FROM report_result report_row
            WHERE %s
            ORDER BY %s
            LIMIT ? OFFSET ?
            """.formatted(reportCtes(spec, plan), plan.resultPredicateSql(), plan.orderBySql());
        var parameters = new ArrayList<>(plan.parametersWithSource(spec));
        parameters.add(plan.query().pageSize());
        parameters.add(Math.multiplyExact((long) plan.query().page() - 1L, plan.query().pageSize()));
        return immutableRows(jdbcTemplate.queryForList(sql, parameters.toArray()));
    }

    private List<Map<String, Object>> totals(ReportQuerySpec spec, ReportQueryPlan plan) {
        if (spec.totalColumns().isEmpty()) {
            return List.of();
        }
        var selectColumns = new ArrayList<String>();
        for (var groupColumn : spec.totalGroupColumns()) {
            selectColumns.add(column(groupColumn) + " AS " + quote(groupColumn));
        }
        for (var totalColumn : spec.totalColumns()) {
            selectColumns.add(
                "SUM(" + column(totalColumn.sourceColumn()) + ") AS " + quote(totalColumn.outputField())
            );
        }
        var groupBy = spec.totalGroupColumns().isEmpty()
            ? ""
            : "\nGROUP BY " + spec.totalGroupColumns().stream().map(this::column).collect(java.util.stream.Collectors.joining(", "));
        var orderBy = spec.totalGroupColumns().isEmpty()
            ? ""
            : "\nORDER BY " + spec.totalGroupColumns().stream().map(this::column).collect(java.util.stream.Collectors.joining(", "));
        var sql = """
            %s
            SELECT %s
            FROM report_result report_row
            WHERE %s%s%s
            """.formatted(
                reportCtes(spec, plan),
                String.join(", ", selectColumns),
                plan.resultPredicateSql(),
                groupBy,
                orderBy
            );
        return immutableRows(jdbcTemplate.queryForList(sql, plan.parametersWithSource(spec).toArray()));
    }

    private String exportSql(ReportQuerySpec spec, ReportQueryPlan plan) {
        var columns = spec.csvColumns().stream()
            .map(ReportQuerySpec.CsvColumn::sourceColumn)
            .map(this::column)
            .collect(java.util.stream.Collectors.joining(", "));
        return """
            %s
            SELECT %s
            FROM report_result report_row
            WHERE %s
            ORDER BY %s
            LIMIT %d
            """.formatted(
                reportCtes(spec, plan),
                columns,
                plan.resultPredicateSql(),
                plan.orderBySql(),
                EXPORT_PROBE_LIMIT
            );
    }

    private String reportCtes(ReportQuerySpec spec, ReportQueryPlan plan) {
        var resultSql = spec.hasResultSql()
            ? spec.resultSql()
            : "SELECT report_fact.* FROM report_fact";
        return """
            WITH report_fact AS (
                SELECT report_fact_source.*
                FROM (
            %s
                ) report_fact_source
                WHERE %s
            ),
            report_result AS (
            %s
            )
            """.formatted(
                indent(spec.sourceSql(), 8),
                plan.factPredicateSql(),
                indent(resultSql, 4)
            ).stripTrailing();
    }

    private PreparedStatementCreator streamingStatement(String sql, List<Object> parameters) {
        return connection -> {
            var statement = connection.prepareStatement(
                sql,
                ResultSet.TYPE_FORWARD_ONLY,
                ResultSet.CONCUR_READ_ONLY
            );
            statement.setFetchSize(EXPORT_FETCH_SIZE);
            new ArgumentPreparedStatementSetter(parameters.toArray()).setValues(statement);
            return statement;
        };
    }

    private void writeExportRow(ReportCsvWriter.Buffer csv, ResultSet resultSet, AtomicLong actualRows)
        throws java.sql.SQLException {
        var rowNumber = actualRows.incrementAndGet();
        if (rowNumber > EXPORT_ROW_LIMIT) {
            throw new ResponseStatusException(
                HttpStatus.PAYLOAD_TOO_LARGE,
                "报表引出最多允许 " + EXPORT_ROW_LIMIT + " 行，请缩小筛选范围"
            );
        }
        csv.writeRow(resultSet);
    }

    private void abandonFailedArtifact(Path path, String reportKey) {
        try {
            cleanupManager.abandonGeneration(path, reportKey);
        } catch (IOException cleanupDeferred) {
            // The manager retains the file in its durable directory and pending set.
        }
    }

    private List<Map<String, Object>> immutableRows(List<Map<String, Object>> rows) {
        return rows.stream()
            .map(row -> java.util.Collections.unmodifiableMap(new LinkedHashMap<>(row)))
            .toList();
    }

    private String column(String identifier) {
        return "report_row." + quote(identifier);
    }

    private String quote(String identifier) {
        return "\"" + identifier + "\"";
    }

    private String indent(String sql) {
        return indent(sql, 4);
    }

    private String indent(String sql, int spaces) {
        var prefix = " ".repeat(spaces);
        return sql.lines().map(line -> prefix + line).collect(java.util.stream.Collectors.joining("\n"));
    }

    public record QueryData(
        long total,
        List<Map<String, Object>> rows,
        List<Map<String, Object>> totals
    ) {
    }
}
