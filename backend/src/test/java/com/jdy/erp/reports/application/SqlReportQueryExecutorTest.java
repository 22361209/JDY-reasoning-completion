package com.jdy.erp.reports.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.time.Clock;
import java.time.Duration;
import java.time.LocalDate;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.ArgumentCaptor;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.PreparedStatementCreator;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.web.server.ResponseStatusException;

class SqlReportQueryExecutorTest {
    private final JdbcTemplate jdbcTemplate = mock(JdbcTemplate.class);
    private SqlReportQueryExecutor executor;
    private ReportExportCleanupManager cleanupManager;
    private final ReportQuerySpec spec = ReportQuerySpecRegistryTest.fixtureSpec();
    private final ReportQueryPlan plan = plan();

    @TempDir
    Path tempDirectory;

    @BeforeEach
    void setUpCleanupManager() {
        cleanupManager = new ReportExportCleanupManager(
            tempDirectory,
            Clock.systemUTC(),
            Duration.ofHours(1),
            () -> "operator",
            Files::deleteIfExists
        );
        cleanupManager.afterPropertiesSet();
        executor = new SqlReportQueryExecutor(jdbcTemplate, new ReportCsvWriter(), cleanupManager);
    }

    @Test
    void countTotalsAndRowsUseTheSamePredicateAndDatabasePagingInThatOrder() {
        when(jdbcTemplate.queryForObject(anyString(), eq(Long.class), any(Object[].class))).thenReturn(3L);
        when(jdbcTemplate.queryForList(anyString(), any(Object[].class)))
            .thenReturn(List.of(Map.of("currency", "USD", "amount", new BigDecimal("30.00"))))
            .thenReturn(List.of(row("SO-003", "30.00")));

        var result = executor.query(spec, plan);

        assertThat(result.total()).isEqualTo(3L);
        assertThat(result.totals()).singleElement().satisfies(total -> assertThat(total)
            .containsEntry("currency", "USD")
            .containsEntry("amount", new BigDecimal("30.00")));
        assertThat(result.rows()).singleElement().satisfies(row -> assertThat(row)
            .containsEntry("billNo", "SO-003"));

        var order = inOrder(jdbcTemplate);
        order.verify(jdbcTemplate).queryForObject(anyString(), eq(Long.class), any(Object[].class));
        order.verify(jdbcTemplate).queryForList(
            argThat(statement -> statement.contains("SUM(report_row.\"amount\")")),
            any(Object[].class)
        );
        order.verify(jdbcTemplate).queryForList(
            argThat(statement -> statement.contains("LIMIT ? OFFSET ?")),
            any(Object[].class)
        );

        var sql = ArgumentCaptor.forClass(String.class);
        verify(jdbcTemplate).queryForObject(sql.capture(), eq(Long.class), any(Object[].class));
        verify(jdbcTemplate, org.mockito.Mockito.times(2)).queryForList(sql.capture(), any(Object[].class));
        assertThat(sql.getAllValues()).allSatisfy(statement -> assertThat(statement)
            .contains("FROM report_fixture", "report_row.\"businessDate\" >= ?", "report_row.\"businessDate\" <= ?"));
        assertThat(sql.getAllValues().get(0)).contains("SELECT COUNT(*)").doesNotContain("LIMIT ? OFFSET ?");
        assertThat(sql.getAllValues().get(1))
            .contains("SUM(report_row.\"amount\") AS \"amount\"")
            .contains("GROUP BY report_row.\"currency\"")
            .doesNotContain("LIMIT ? OFFSET ?");
        assertThat(sql.getAllValues().get(2))
            .contains("ORDER BY report_row.\"businessDate\" DESC")
            .contains("LIMIT ? OFFSET ?")
            .doesNotContain("DefaultStub", "seedRows");

        var arguments = ArgumentCaptor.forClass(Object[].class);
        verify(jdbcTemplate, org.mockito.Mockito.times(2)).queryForList(anyString(), arguments.capture());
        assertThat(arguments.getAllValues().get(0)).containsExactly(
            LocalDate.of(2026, 7, 1), LocalDate.of(2026, 7, 14)
        );
        assertThat(arguments.getAllValues().get(1)).containsExactly(
            LocalDate.of(2026, 7, 1), LocalDate.of(2026, 7, 14), 20, 20L
        );
    }

    @Test
    void emptyQueryReturnsExactEmptyShapeWithoutRunningAggregateOrPageSql() {
        when(jdbcTemplate.queryForObject(anyString(), eq(Long.class), any(Object[].class))).thenReturn(0L);

        var result = executor.query(spec, plan);

        assertThat(result.total()).isZero();
        assertThat(result.rows()).isEmpty();
        assertThat(result.totals()).isEmpty();
        verify(jdbcTemplate, never()).queryForList(anyString(), any(Object[].class));
    }

    @Test
    void exportRejectsTheCappedTwentyThousandAndOneProbeBeforeOpeningAResultStream() {
        var existingArtifacts = exportArtifacts();
        when(jdbcTemplate.queryForObject(anyString(), eq(Long.class), any(Object[].class))).thenReturn(20_001L);

        assertThatThrownBy(() -> executor.export(spec, plan))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.PAYLOAD_TOO_LARGE));

        verify(jdbcTemplate, never()).query(
            any(PreparedStatementCreator.class),
            any(RowCallbackHandler.class)
        );
        var sql = ArgumentCaptor.forClass(String.class);
        var arguments = ArgumentCaptor.forClass(Object[].class);
        verify(jdbcTemplate).queryForObject(sql.capture(), eq(Long.class), arguments.capture());
        assertThat(sql.getValue()).contains("LIMIT ?", "report_export_cap");
        assertThat(arguments.getValue()).endsWith(20_001);
        assertThat(exportArtifacts()).isEqualTo(existingArtifacts);
    }

    @Test
    void temporaryFileWriterFailureReturnsSafeErrorAndDeletesExactArtifact() {
        var existingArtifacts = exportArtifacts();
        var failingWriter = mock(ReportCsvWriter.class);
        when(jdbcTemplate.queryForObject(anyString(), eq(Long.class), any(Object[].class))).thenReturn(0L);
        when(failingWriter.open(any(), any()))
            .thenThrow(new UncheckedIOException(new IOException("simulated disk failure")));
        var failingExecutor = new SqlReportQueryExecutor(jdbcTemplate, failingWriter, cleanupManager);

        assertThatThrownBy(() -> failingExecutor.export(spec, plan))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.INTERNAL_SERVER_ERROR))
            .hasMessageContaining("临时文件写入失败");

        assertThat(exportArtifacts()).isEqualTo(existingArtifacts);
    }

    @Test
    void actualTwentyThousandAndFirstStreamedRowFailsAndDeletesTemporaryFile() throws Exception {
        var existingArtifacts = exportArtifacts();
        when(jdbcTemplate.queryForObject(anyString(), eq(Long.class), any(Object[].class))).thenReturn(20_000L);
        var resultSet = mock(ResultSet.class);
        when(resultSet.getObject("billNo")).thenReturn("SO-1");
        when(resultSet.getObject("customerName")).thenReturn("客户");
        when(resultSet.getObject("amount")).thenReturn(BigDecimal.ONE);
        when(resultSet.getObject("currency")).thenReturn("CNY");
        doAnswer(invocation -> {
            var callback = invocation.getArgument(1, RowCallbackHandler.class);
            for (int index = 0; index < 20_001; index++) {
                callback.processRow(resultSet);
            }
            return null;
        }).when(jdbcTemplate).query(any(PreparedStatementCreator.class), any(RowCallbackHandler.class));

        assertThatThrownBy(() -> executor.export(spec, plan))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.PAYLOAD_TOO_LARGE));

        assertThat(exportArtifacts()).isEqualTo(existingArtifacts);
    }

    @Test
    void csvBeyondSixtyFourMiBFailsWith413AndDeletesTemporaryFile() throws Exception {
        var existingArtifacts = exportArtifacts();
        when(jdbcTemplate.queryForObject(anyString(), eq(Long.class), any(Object[].class))).thenReturn(20_000L);
        var resultSet = mock(ResultSet.class);
        var maximumCell = "X".repeat(ReportCsvWriter.MAX_CELL_CHARACTERS);
        when(resultSet.getObject("billNo")).thenReturn(maximumCell);
        when(resultSet.getObject("customerName")).thenReturn(maximumCell);
        when(resultSet.getObject("amount")).thenReturn(maximumCell);
        when(resultSet.getObject("currency")).thenReturn(maximumCell);
        doAnswer(invocation -> {
            var callback = invocation.getArgument(1, RowCallbackHandler.class);
            for (int index = 0; index < 20_000; index++) {
                callback.processRow(resultSet);
            }
            return null;
        }).when(jdbcTemplate).query(any(PreparedStatementCreator.class), any(RowCallbackHandler.class));

        assertThatThrownBy(() -> executor.export(spec, plan))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> {
                var failure = (ResponseStatusException) error;
                assertThat(failure.getStatusCode()).isEqualTo(HttpStatus.PAYLOAD_TOO_LARGE);
                assertThat(failure.getReason()).contains("64 MiB");
            });

        assertThat(exportArtifacts()).isEqualTo(existingArtifacts);
    }

    @Test
    void emptyExportStillContainsUtf8BomAndFixedHeaders() throws Exception {
        when(jdbcTemplate.queryForObject(anyString(), eq(Long.class), any(Object[].class))).thenReturn(0L);

        var artifact = executor.export(spec, plan);
        try {
            var csv = Files.readString(artifact.path(), StandardCharsets.UTF_8);

            assertThat(artifact.rowCount()).isZero();
            assertThat(artifact.contentLength()).isEqualTo(Files.size(artifact.path()));
            assertThat(csv).isEqualTo("\ufeff单号,客户,金额,币种\r\n");
            verify(jdbcTemplate, never()).query(
                any(PreparedStatementCreator.class),
                any(RowCallbackHandler.class)
            );
        } finally {
            artifact.release("executor-test");
        }
        assertThat(artifact.path()).doesNotExist();
    }

    @Test
    void exportStreamsFixedColumnsWithFetchSizeStableOrderRfcEscapingAndForcedText() throws Exception {
        when(jdbcTemplate.queryForObject(anyString(), eq(Long.class), any(Object[].class))).thenReturn(1L);
        var resultSet = mock(ResultSet.class);
        when(resultSet.getObject("billNo")).thenReturn("00123456789012345678");
        when(resultSet.getObject("customerName")).thenReturn("=unsafe, customer");
        when(resultSet.getObject("amount")).thenReturn(new BigDecimal("-12.30"));
        when(resultSet.getObject("currency")).thenReturn("USD");
        doAnswer(invocation -> {
            invocation.getArgument(1, RowCallbackHandler.class).processRow(resultSet);
            return null;
        }).when(jdbcTemplate).query(
            any(PreparedStatementCreator.class),
            any(RowCallbackHandler.class)
        );

        var artifact = executor.export(spec, plan);
        String csv;
        try {
            csv = Files.readString(artifact.path(), StandardCharsets.UTF_8);
        } finally {
            artifact.release("executor-test");
        }

        assertThat(artifact.rowCount()).isEqualTo(1L);
        assertThat(csv)
            .startsWith("\ufeff单号,客户,金额,币种\r\n")
            .contains("\"\t00123456789012345678\"")
            .contains("\"'=unsafe, customer\"")
            .contains(",-12.30,")
            .contains("\"\tUSD\"");

        var creator = ArgumentCaptor.forClass(PreparedStatementCreator.class);
        verify(jdbcTemplate).query(creator.capture(), any(RowCallbackHandler.class));
        var connection = mock(Connection.class);
        var statement = mock(PreparedStatement.class);
        when(connection.prepareStatement(anyString(), eq(ResultSet.TYPE_FORWARD_ONLY), eq(ResultSet.CONCUR_READ_ONLY)))
            .thenReturn(statement);
        creator.getValue().createPreparedStatement(connection);
        var sql = ArgumentCaptor.forClass(String.class);
        verify(connection).prepareStatement(sql.capture(), eq(ResultSet.TYPE_FORWARD_ONLY), eq(ResultSet.CONCUR_READ_ONLY));
        verify(statement).setFetchSize(500);
        assertThat(sql.getValue())
            .contains("SELECT report_row.\"billNo\", report_row.\"customerName\", report_row.\"amount\", report_row.\"currency\"")
            .contains("ORDER BY report_row.\"businessDate\" DESC")
            .contains("LIMIT 20001")
            .doesNotContain("SELECT report_row.*");
    }

    @Test
    void csvNeutralizesEveryFormulaPrefixBeforeForceTextTabWhileLeavingRealNumbersNumeric() throws Exception {
        var attacks = List.of(
            "=1+1",
            "+cmd",
            "-1+HYPERLINK(A1)",
            "@SUM(A1)",
            "\tcmd",
            "\rcmd"
        );
        var resultSet = mock(ResultSet.class);
        when(resultSet.getObject("amount")).thenReturn(new BigDecimal("-12.30"));
        when(resultSet.getObject("currency")).thenReturn("USD");
        var destination = new ByteArrayOutputStream();
        var csv = new ReportCsvWriter().open(spec, destination);

        for (var attack : attacks) {
            when(resultSet.getObject("billNo")).thenReturn(attack);
            when(resultSet.getObject("customerName")).thenReturn(attack);
            csv.writeRow(resultSet);
        }
        csv.finish();

        var output = destination.toString(StandardCharsets.UTF_8);
        for (var attack : attacks) {
            // billNo is forceText: apostrophe must be the first actual character,
            // before the tab used to preserve spreadsheet text semantics.
            assertThat(output).contains("\"'\t" + attack + "\"");
            var neutralizedPlainText = "'" + attack;
            var serializedPlainText = attack.chars().anyMatch(Character::isISOControl)
                ? "\"" + neutralizedPlainText + "\""
                : neutralizedPlainText;
            assertThat(output).contains("," + serializedPlainText + ",-12.30,");
        }
        assertThat(output)
            .contains("'-1+HYPERLINK(A1)")
            .contains("'\tcmd")
            .contains("'\rcmd")
            .contains(",-12.30,")
            .doesNotContain(",'-12.30,", ",'\t-12.30,");
        assertThat(output.split(java.util.regex.Pattern.quote(",-12.30,"), -1).length - 1)
            .isEqualTo(attacks.size());
    }

    @Test
    void ordinaryTabsAndControlCharactersAreQuotedAndRoundTripAsOneCsvCell() throws Exception {
        var resultSet = mock(ResultSet.class);
        var ordinaryText = "north\tzone\u0001\"quoted\"";
        when(resultSet.getObject("billNo")).thenReturn("SO-1");
        when(resultSet.getObject("customerName")).thenReturn(ordinaryText);
        when(resultSet.getObject("amount")).thenReturn(new BigDecimal("1.00"));
        when(resultSet.getObject("currency")).thenReturn("USD");
        var destination = new ByteArrayOutputStream();
        var csv = new ReportCsvWriter().open(spec, destination);

        csv.writeRow(resultSet);
        csv.finish();

        var output = destination.toString(StandardCharsets.UTF_8);
        assertThat(output)
            .contains("\"north\tzone\u0001\"\"quoted\"\"\"")
            .doesNotContain(",north\tzone\u0001");
        assertThat(parseCsv(output)).containsExactly(
            List.of("单号", "客户", "金额", "币种"),
            List.of("\tSO-1", ordinaryText, "1.00", "\tUSD")
        );
    }

    @Test
    void summarySourceDatesAndOuterPredicateAreBoundIdenticallyForCountTotalsRowsAndExport() throws Exception {
        var summarySpec = summarySpec();
        var summaryPlan = summaryPlan(summarySpec);
        when(jdbcTemplate.queryForObject(anyString(), eq(Long.class), any(Object[].class)))
            .thenReturn(1L)
            .thenReturn(1L);
        when(jdbcTemplate.queryForList(anyString(), any(Object[].class)))
            .thenReturn(List.of(Map.of(
                "currency", "USD",
                "openingAmount", new BigDecimal("10.00"),
                "periodAmount", new BigDecimal("2.00"),
                "endingAmount", new BigDecimal("12.00")
            )))
            .thenReturn(List.of(Map.of("rowKey", "P-1:USD")));

        executor.query(summarySpec, summaryPlan);

        var resultSet = mock(ResultSet.class);
        when(resultSet.getObject("partyId")).thenReturn("P-1");
        when(resultSet.getObject("currency")).thenReturn("USD");
        when(resultSet.getObject("openingAmount")).thenReturn(new BigDecimal("10.00"));
        when(resultSet.getObject("periodAmount")).thenReturn(new BigDecimal("2.00"));
        when(resultSet.getObject("endingAmount")).thenReturn(new BigDecimal("12.00"));
        doAnswer(invocation -> {
            invocation.getArgument(1, RowCallbackHandler.class).processRow(resultSet);
            return null;
        }).when(jdbcTemplate).query(
            any(PreparedStatementCreator.class),
            any(RowCallbackHandler.class)
        );

        var artifact = executor.export(summarySpec, summaryPlan);
        try {
            assertThat(Files.readString(artifact.path(), StandardCharsets.UTF_8))
                .contains("\ufeff往来单位,币种,期初,本期,期末\r\n")
                .contains("\"\tP-1\",\"\tUSD\",10.00,2.00,12.00");
        } finally {
            artifact.release("executor-test");
        }

        var dateFrom = LocalDate.of(2026, 7, 1);
        var dateTo = LocalDate.of(2026, 7, 14);
        var countSql = ArgumentCaptor.forClass(String.class);
        var countArguments = ArgumentCaptor.forClass(Object[].class);
        verify(jdbcTemplate, org.mockito.Mockito.times(2))
            .queryForObject(countSql.capture(), eq(Long.class), countArguments.capture());
        assertThat(countArguments.getAllValues().get(0))
            .containsExactly(dateFrom, dateFrom, dateTo, dateTo, "USD");
        assertThat(countArguments.getAllValues().get(1))
            .containsExactly(dateFrom, dateFrom, dateTo, dateTo, "USD", 20_001);

        var listSql = ArgumentCaptor.forClass(String.class);
        var listArguments = ArgumentCaptor.forClass(Object[].class);
        verify(jdbcTemplate, org.mockito.Mockito.times(2))
            .queryForList(listSql.capture(), listArguments.capture());
        assertThat(listArguments.getAllValues().get(0))
            .containsExactly(dateFrom, dateFrom, dateTo, dateTo, "USD");
        assertThat(listArguments.getAllValues().get(1))
            .containsExactly(dateFrom, dateFrom, dateTo, dateTo, "USD", 100, 0L);

        var creator = ArgumentCaptor.forClass(PreparedStatementCreator.class);
        verify(jdbcTemplate).query(creator.capture(), any(RowCallbackHandler.class));
        var connection = mock(Connection.class);
        var statement = mock(PreparedStatement.class);
        when(connection.prepareStatement(anyString(), eq(ResultSet.TYPE_FORWARD_ONLY), eq(ResultSet.CONCUR_READ_ONLY)))
            .thenReturn(statement);
        creator.getValue().createPreparedStatement(connection);
        var exportSql = ArgumentCaptor.forClass(String.class);
        verify(connection).prepareStatement(
            exportSql.capture(), eq(ResultSet.TYPE_FORWARD_ONLY), eq(ResultSet.CONCUR_READ_ONLY)
        );
        var boundValues = org.mockito.Mockito.mockingDetails(statement).getInvocations().stream()
            .filter(invocation -> invocation.getMethod().getName().startsWith("set"))
            .filter(invocation -> invocation.getArguments().length >= 2)
            .map(invocation -> String.valueOf((Object) invocation.getArgument(1)))
            .toList();
        assertThat(boundValues).containsExactly(
            "2026-07-01", "2026-07-01", "2026-07-14", "2026-07-14", "USD"
        );
        assertSummarySourceAndPredicate(countSql.getAllValues().get(0));
        assertThat(countSql.getAllValues().get(0)).contains("SELECT COUNT(*)").doesNotContain("LIMIT ?");
        assertSummarySourceAndPredicate(countSql.getAllValues().get(1));
        assertThat(countSql.getAllValues().get(1)).contains("report_export_cap", "LIMIT ?");
        assertSummarySourceAndPredicate(listSql.getAllValues().get(0));
        assertThat(listSql.getAllValues().get(0)).contains("SUM(report_row.\"openingAmount\")");
        assertSummarySourceAndPredicate(listSql.getAllValues().get(1));
        assertThat(listSql.getAllValues().get(1)).contains("LIMIT ? OFFSET ?");
        assertSummarySourceAndPredicate(exportSql.getValue());
        assertThat(exportSql.getValue())
            .contains("ORDER BY report_row.\"partyId\" ASC, report_row.\"rowKey\" ASC", "LIMIT 20001");
    }

    @Test
    void twoStageFactPredicatesPrecedeAggregationForCountTotalsRowsAndExportWithoutResultDuplication()
        throws Exception {
        var summarySpec = ReportQueryParserPlannerTest.twoStageSummarySpec();
        var customerId = "00000000-0000-0000-0000-000000000145";
        var summaryPlan = new ReportQueryPlanner().plan(
            summarySpec,
            new ReportQueryParser().parse(summarySpec, Map.of(
                "dateFrom", List.of("2026-07-01"),
                "dateTo", List.of("2026-07-14"),
                "keyword", List.of("Acme P-1"),
                "customerId", List.of(customerId),
                "currency", List.of("USD")
            ))
        );
        when(jdbcTemplate.queryForObject(anyString(), eq(Long.class), any(Object[].class)))
            .thenReturn(1L)
            .thenReturn(1L);
        when(jdbcTemplate.queryForList(anyString(), any(Object[].class)))
            .thenReturn(List.of(Map.of("currency", "USD", "amount", new BigDecimal("12.00"))))
            .thenReturn(List.of(Map.of(
                "dimensionId", customerId,
                "currency", "USD",
                "amount", new BigDecimal("12.00"),
                "rowKey", customerId + ":USD"
            )));

        executor.query(summarySpec, summaryPlan);

        var resultSet = mock(ResultSet.class);
        when(resultSet.getObject("dimensionId")).thenReturn(customerId);
        when(resultSet.getObject("currency")).thenReturn("USD");
        when(resultSet.getObject("amount")).thenReturn(new BigDecimal("12.00"));
        doAnswer(invocation -> {
            invocation.getArgument(1, RowCallbackHandler.class).processRow(resultSet);
            return null;
        }).when(jdbcTemplate).query(
            any(PreparedStatementCreator.class),
            any(RowCallbackHandler.class)
        );

        var artifact = executor.export(summarySpec, summaryPlan);
        try {
            assertThat(Files.readString(artifact.path(), StandardCharsets.UTF_8))
                .contains("\ufeff维度,币种,金额\r\n")
                .contains("\"\t" + customerId + "\",\"\tUSD\",12.00");
        } finally {
            artifact.release("executor-test");
        }

        var countSql = ArgumentCaptor.forClass(String.class);
        var countArguments = ArgumentCaptor.forClass(Object[].class);
        verify(jdbcTemplate, org.mockito.Mockito.times(2))
            .queryForObject(countSql.capture(), eq(Long.class), countArguments.capture());
        var listSql = ArgumentCaptor.forClass(String.class);
        var listArguments = ArgumentCaptor.forClass(Object[].class);
        verify(jdbcTemplate, org.mockito.Mockito.times(2))
            .queryForList(listSql.capture(), listArguments.capture());
        var expectedBaseParameters = summaryPlan.parametersWithSource(summarySpec);
        assertThat(countArguments.getAllValues().get(0)).containsExactlyElementsOf(expectedBaseParameters);
        assertThat(countArguments.getAllValues().get(1))
            .containsExactlyElementsOf(concat(expectedBaseParameters, 20_001));
        assertThat(listArguments.getAllValues().get(0)).containsExactlyElementsOf(expectedBaseParameters);
        assertThat(listArguments.getAllValues().get(1))
            .containsExactlyElementsOf(concat(expectedBaseParameters, 100, 0L));

        var creator = ArgumentCaptor.forClass(PreparedStatementCreator.class);
        verify(jdbcTemplate).query(creator.capture(), any(RowCallbackHandler.class));
        var connection = mock(Connection.class);
        var statement = mock(PreparedStatement.class);
        when(connection.prepareStatement(anyString(), eq(ResultSet.TYPE_FORWARD_ONLY), eq(ResultSet.CONCUR_READ_ONLY)))
            .thenReturn(statement);
        creator.getValue().createPreparedStatement(connection);
        var exportSql = ArgumentCaptor.forClass(String.class);
        verify(connection).prepareStatement(
            exportSql.capture(), eq(ResultSet.TYPE_FORWARD_ONLY), eq(ResultSet.CONCUR_READ_ONLY)
        );

        var allSql = new java.util.ArrayList<String>();
        allSql.addAll(countSql.getAllValues());
        allSql.addAll(listSql.getAllValues());
        allSql.add(exportSql.getValue());
        assertThat(allSql).allSatisfy(sql -> {
            assertThat(sql)
                .contains(
                    "WITH report_fact AS",
                    "report_fact_source.\"businessDate\" >= ?",
                    "report_fact_source.\"customerName\" ILIKE ?",
                    "report_fact_source.\"customerId\" = ?",
                    "report_fact_source.\"currency\" = ?",
                    "report_result AS",
                    "SUM(amount)",
                    "FROM report_result report_row",
                    "WHERE TRUE"
                )
                .doesNotContain(
                    "report_row.\"businessDate\"",
                    "report_row.\"customerId\"",
                    "report_row.\"currency\" = ?"
                );
            assertThat(sql.indexOf("report_fact_source.\"businessDate\" >= ?"))
                .isLessThan(sql.indexOf("report_result AS"));
            assertThat(sql.indexOf("report_result AS")).isLessThan(sql.indexOf("SUM(amount)"));
        });
    }

    @Test
    void oneResolvedDataScopeSnapshotFeedsCountTotalsRowsAndExportWithoutLiteralOrReResolution()
        throws Exception {
        var scoped = ReportQueryParserPlannerTest.dataScopeSpec();
        var scopeId = "00000000-0000-0000-0000-000000000245";
        var scopedPlan = new ReportQueryPlanner()
            .plan(scoped, new ReportQueryParser().parse(scoped, Map.of()))
            .withDataScopes(Map.of("reporting", scopeId));
        when(jdbcTemplate.queryForObject(anyString(), eq(Long.class), any(Object[].class)))
            .thenReturn(1L)
            .thenReturn(1L);
        when(jdbcTemplate.queryForList(anyString(), any(Object[].class)))
            .thenReturn(List.of(Map.of("amount", new BigDecimal("12.30"))))
            .thenReturn(List.of(Map.of("id", "ROW-1", "amount", new BigDecimal("12.30"))));

        var queryData = executor.query(scoped, scopedPlan);
        assertThat(queryData.rows()).singleElement().satisfies(row -> assertThat(row)
            .containsEntry("amount", new BigDecimal("12.30")));
        assertThat(queryData.totals()).singleElement().satisfies(total -> assertThat(total)
            .containsEntry("amount", new BigDecimal("12.30")));

        var resultSet = mock(ResultSet.class);
        when(resultSet.getObject("id")).thenReturn("ROW-1");
        when(resultSet.getObject("amount")).thenReturn(new BigDecimal("12.30"));
        doAnswer(invocation -> {
            invocation.getArgument(1, RowCallbackHandler.class).processRow(resultSet);
            return null;
        }).when(jdbcTemplate).query(
            any(PreparedStatementCreator.class),
            any(RowCallbackHandler.class)
        );
        var artifact = executor.export(scoped, scopedPlan);
        try {
            assertThat(Files.readString(artifact.path(), StandardCharsets.UTF_8)).contains("12.30");
        } finally {
            artifact.release("executor-test");
        }

        var expectedSnapshot = List.<Object>of(scopeId, scopeId, scopeId);
        var countSql = ArgumentCaptor.forClass(String.class);
        var countArguments = ArgumentCaptor.forClass(Object[].class);
        verify(jdbcTemplate, org.mockito.Mockito.times(2))
            .queryForObject(countSql.capture(), eq(Long.class), countArguments.capture());
        assertThat(countArguments.getAllValues().get(0)).containsExactlyElementsOf(expectedSnapshot);
        assertThat(countArguments.getAllValues().get(1))
            .containsExactlyElementsOf(concat(expectedSnapshot, 20_001));

        var listSql = ArgumentCaptor.forClass(String.class);
        var listArguments = ArgumentCaptor.forClass(Object[].class);
        verify(jdbcTemplate, org.mockito.Mockito.times(2))
            .queryForList(listSql.capture(), listArguments.capture());
        assertThat(listArguments.getAllValues().get(0)).containsExactlyElementsOf(expectedSnapshot);
        assertThat(listArguments.getAllValues().get(1))
            .containsExactlyElementsOf(concat(expectedSnapshot, 100, 0L));

        var creator = ArgumentCaptor.forClass(PreparedStatementCreator.class);
        verify(jdbcTemplate).query(creator.capture(), any(RowCallbackHandler.class));
        var connection = mock(Connection.class);
        var statement = mock(PreparedStatement.class);
        when(connection.prepareStatement(anyString(), eq(ResultSet.TYPE_FORWARD_ONLY), eq(ResultSet.CONCUR_READ_ONLY)))
            .thenReturn(statement);
        creator.getValue().createPreparedStatement(connection);
        var exportSql = ArgumentCaptor.forClass(String.class);
        verify(connection).prepareStatement(
            exportSql.capture(), eq(ResultSet.TYPE_FORWARD_ONLY), eq(ResultSet.CONCUR_READ_ONLY)
        );
        var boundValues = org.mockito.Mockito.mockingDetails(statement).getInvocations().stream()
            .filter(invocation -> invocation.getMethod().getName().startsWith("set"))
            .filter(invocation -> invocation.getArguments().length >= 2)
            .map(invocation -> invocation.getArgument(1, Object.class))
            .toList();
        assertThat(boundValues).containsExactlyElementsOf(expectedSnapshot);

        var allSql = new java.util.ArrayList<String>();
        allSql.addAll(countSql.getAllValues());
        allSql.addAll(listSql.getAllValues());
        allSql.add(exportSql.getValue());
        assertThat(allSql).allSatisfy(sql -> assertThat(sql)
            .contains("report_scope_id = ?::uuid", "?::uuid = ?::uuid")
            .doesNotContain(scopeId));
    }

    @Test
    void exactlyTwentyThousandRowsRemainAllowedAndBounded() throws Exception {
        when(jdbcTemplate.queryForObject(anyString(), eq(Long.class), any(Object[].class))).thenReturn(20_000L);
        var resultSet = mock(ResultSet.class);
        when(resultSet.getObject("billNo")).thenReturn("SO-1");
        when(resultSet.getObject("customerName")).thenReturn("客户");
        when(resultSet.getObject("amount")).thenReturn(BigDecimal.ONE);
        when(resultSet.getObject("currency")).thenReturn("CNY");
        doAnswer(invocation -> {
            var callback = invocation.getArgument(1, RowCallbackHandler.class);
            for (int index = 0; index < 20_000; index++) {
                callback.processRow(resultSet);
            }
            return null;
        }).when(jdbcTemplate).query(
            any(PreparedStatementCreator.class),
            any(RowCallbackHandler.class)
        );

        var artifact = executor.export(spec, plan);

        try {
            assertThat(artifact.rowCount()).isEqualTo(20_000L);
            assertThat(Files.size(artifact.path())).isLessThan(ReportCsvWriter.MAX_OUTPUT_BYTES);
            assertThat(artifact.contentLength()).isEqualTo(Files.size(artifact.path()));
        } finally {
            artifact.release("executor-test");
        }
    }

    private java.util.Set<Path> exportArtifacts() {
        var artifacts = new HashSet<Path>();
        try (var paths = Files.newDirectoryStream(cleanupManager.directory(), "export-*.csv")) {
            paths.forEach(path -> artifacts.add(path.toAbsolutePath().normalize()));
        } catch (java.io.IOException exception) {
            throw new AssertionError("cannot inspect report export temp files", exception);
        }
        return artifacts;
    }

    private List<Object> concat(List<Object> values, Object... suffix) {
        var combined = new java.util.ArrayList<Object>(values);
        combined.addAll(List.of(suffix));
        return combined;
    }

    private ReportQuerySpec summarySpec() {
        return ReportQuerySpec.builder(
            "fixture-summary",
            "report.fixture.view",
            """
                SELECT party_id AS "partyId", currency AS "currency",
                       party_id::text || ':' || currency AS "rowKey",
                       SUM(CASE WHEN business_date < ? THEN amount_delta ELSE 0 END) AS "openingAmount",
                       SUM(CASE WHEN business_date BETWEEN ? AND ? THEN occurrence_delta ELSE 0 END) AS "periodAmount",
                       SUM(CASE WHEN business_date <= ? THEN amount_delta ELSE 0 END) AS "endingAmount"
                FROM ar_fact
                GROUP BY party_id, currency
                """
        )
            .requiredDateRange()
            .bindSourceDateFrom()
            .bindSourceDateFrom()
            .bindSourceDateTo()
            .bindSourceDateTo()
            .filter(ReportQuerySpec.FilterDefinition.enumEquals("currency", "currency", "CNY", "USD"))
            .sortField("partyId", "partyId")
            .sortField("rowKey", "rowKey")
            .defaultSort("partyId", ReportQuerySpec.SortDirection.ASC)
            .uniqueNonNullStableSort("rowKey", ReportQuerySpec.SortDirection.ASC)
            .totalGroupColumns("currency")
            .totalSum("openingAmount", "openingAmount")
            .totalSum("periodAmount", "periodAmount")
            .totalSum("endingAmount", "endingAmount")
            .csvColumn("往来单位", "partyId", true)
            .csvColumn("币种", "currency", true)
            .csvColumn("期初", "openingAmount", false)
            .csvColumn("本期", "periodAmount", false)
            .csvColumn("期末", "endingAmount", false)
            .build();
    }

    private void assertSummarySourceAndPredicate(String sql) {
        assertThat(sql)
            .contains(
                "business_date < ?",
                "business_date BETWEEN ? AND ?",
                "business_date <= ?",
                "report_row.\"currency\" = ?"
            )
            .doesNotContain(
                "report_row.\"businessDate\" >= ?",
                "report_row.\"businessDate\" <= ?",
                "2026-07-01",
                "2026-07-14",
                "USD"
            );
    }

    private ReportQueryPlan summaryPlan(ReportQuerySpec summarySpec) {
        return new ReportQueryPlanner().plan(summarySpec, new ReportQueryParser().parse(summarySpec, Map.of(
            "dateFrom", List.of("2026-07-01"),
            "dateTo", List.of("2026-07-14"),
            "currency", List.of("USD")
        )));
    }

    private ReportQueryPlan plan() {
        var parser = new ReportQueryParser();
        var planner = new ReportQueryPlanner();
        return planner.plan(spec(), parser.parse(spec(), Map.of(
            "dateFrom", List.of("2026-07-01"),
            "dateTo", List.of("2026-07-14"),
            "page", List.of("2"),
            "pageSize", List.of("20")
        )));
    }

    private ReportQuerySpec spec() {
        return ReportQuerySpecRegistryTest.fixtureSpec();
    }

    private Map<String, Object> row(String billNo, String amount) {
        var row = new LinkedHashMap<String, Object>();
        row.put("billNo", billNo);
        row.put("amount", new BigDecimal(amount));
        return row;
    }

    private List<List<String>> parseCsv(String csv) {
        var records = new java.util.ArrayList<List<String>>();
        var record = new java.util.ArrayList<String>();
        var field = new StringBuilder();
        var quoted = false;
        var offset = csv.startsWith("\ufeff") ? 1 : 0;
        while (offset < csv.length()) {
            var character = csv.charAt(offset++);
            if (quoted) {
                if (character == '"') {
                    if (offset < csv.length() && csv.charAt(offset) == '"') {
                        field.append('"');
                        offset++;
                    } else {
                        quoted = false;
                    }
                } else {
                    field.append(character);
                }
                continue;
            }
            if (character == '"' && field.isEmpty()) {
                quoted = true;
            } else if (character == ',') {
                record.add(field.toString());
                field.setLength(0);
            } else if (character == '\r' && offset < csv.length() && csv.charAt(offset) == '\n') {
                offset++;
                record.add(field.toString());
                records.add(List.copyOf(record));
                field.setLength(0);
                record.clear();
            } else {
                field.append(character);
            }
        }
        assertThat(quoted).isFalse();
        assertThat(record).isEmpty();
        assertThat(field).isEmpty();
        return List.copyOf(records);
    }
}
