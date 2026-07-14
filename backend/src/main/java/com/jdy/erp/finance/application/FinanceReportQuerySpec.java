package com.jdy.erp.finance.application;

import com.jdy.erp.reports.application.ReportQuerySpec;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Exact F091 report definitions.
 *
 * <p>The shared report foundation owns parsing, permission checks, routing,
 * paging, totals and export. This finance-owned definition only exposes the
 * immutable ledger event formulas: signed AR/AP facts, audited settlement
 * allocations and audited sales-return finance allocations.</p>
 */
@Configuration(proxyBeanMethods = false)
public class FinanceReportQuerySpec {
    private static final String PERMISSION = "finance.report.view";

    private static final String RECEIVABLE_EVENT_SQL = """
        WITH receivable_events AS (
            SELECT 'AR_FACT:' || receivable.id::text AS "eventKey",
                   receivable.bill_date AS "businessDate",
                   'AR_FACT'::text AS "eventType",
                   receivable.bill_no AS "billNo",
                   COALESCE(receivable.source_bill_no, '') AS "sourceBillNo",
                   receivable.customer_id AS "partyId",
                   customer.code AS "partyCode",
                   customer.name AS "partyName",
                   receivable.currency AS "currency",
                   receivable.status AS "sourceStatus",
                   receivable.amount AS "occurrenceAmount",
                   CAST(0 AS NUMERIC(18, 2)) AS "settledAmount",
                   CAST(0 AS NUMERIC(18, 2)) AS "returnOffsetAmount",
                   CAST(0 AS NUMERIC(18, 2)) AS "pendingRefundAmount",
                   receivable.amount AS "balanceDelta"
            FROM ar_receivable receivable
            JOIN md_customer customer ON customer.id = receivable.customer_id
            WHERE receivable.status IN ('OPEN', 'PART_SETTLED', 'SETTLED')

            UNION ALL

            SELECT 'RECEIPT_ALLOCATION:' || allocation.id::text AS "eventKey",
                   receipt.bill_date AS "businessDate",
                   'RECEIPT_ALLOCATION'::text AS "eventType",
                   receipt.bill_no AS "billNo",
                   receivable.bill_no AS "sourceBillNo",
                   receivable.customer_id AS "partyId",
                   customer.code AS "partyCode",
                   customer.name AS "partyName",
                   receivable.currency AS "currency",
                   receipt.status AS "sourceStatus",
                   CAST(0 AS NUMERIC(18, 2)) AS "occurrenceAmount",
                   allocation.settlement_amount AS "settledAmount",
                   CAST(0 AS NUMERIC(18, 2)) AS "returnOffsetAmount",
                   CAST(0 AS NUMERIC(18, 2)) AS "pendingRefundAmount",
                   -allocation.settlement_amount AS "balanceDelta"
            FROM ar_receipt_allocation allocation
            JOIN ar_receipt receipt ON receipt.id = allocation.receipt_id
            JOIN ar_receivable receivable ON receivable.id = allocation.receivable_id
            JOIN md_customer customer ON customer.id = receivable.customer_id
            WHERE receipt.status = 'AUDITED'
              AND receipt.currency = receivable.currency

            UNION ALL

            SELECT 'RETURN_ALLOCATION:' || allocation.id::text AS "eventKey",
                   sales_return.bill_date AS "businessDate",
                   'RETURN_ALLOCATION'::text AS "eventType",
                   sales_return.bill_no AS "billNo",
                   receivable.bill_no AS "sourceBillNo",
                   receivable.customer_id AS "partyId",
                   customer.code AS "partyCode",
                   customer.name AS "partyName",
                   allocation.currency AS "currency",
                   sales_return.status AS "sourceStatus",
                   CAST(0 AS NUMERIC(18, 2)) AS "occurrenceAmount",
                   CAST(0 AS NUMERIC(18, 2)) AS "settledAmount",
                   allocation.offset_amount AS "returnOffsetAmount",
                   allocation.pending_refund_amount AS "pendingRefundAmount",
                   -allocation.offset_amount AS "balanceDelta"
            FROM sales_return_finance_allocation allocation
            JOIN sales_return ON sales_return.id = allocation.sales_return_id
            JOIN ar_receivable receivable ON receivable.id = allocation.receivable_id
            JOIN md_customer customer ON customer.id = receivable.customer_id
            WHERE sales_return.status = 'AUDITED'
              AND allocation.currency = receivable.currency
        )
        SELECT receivable_events.*
        FROM receivable_events
        """;

    private static final String PAYABLE_EVENT_SQL = """
        WITH payable_events AS (
            SELECT 'AP_FACT:' || payable.id::text AS "eventKey",
                   payable.bill_date AS "businessDate",
                   'AP_FACT'::text AS "eventType",
                   payable.bill_no AS "billNo",
                   COALESCE(payable.source_bill_no, '') AS "sourceBillNo",
                   payable.supplier_id AS "partyId",
                   supplier.code AS "partyCode",
                   supplier.name AS "partyName",
                   payable.currency AS "currency",
                   payable.status AS "sourceStatus",
                   payable.amount AS "occurrenceAmount",
                   CAST(0 AS NUMERIC(18, 2)) AS "settledAmount",
                   payable.amount AS "balanceDelta"
            FROM ap_payable payable
            JOIN md_supplier supplier ON supplier.id = payable.supplier_id
            WHERE payable.status IN ('OPEN', 'PART_SETTLED', 'SETTLED')

            UNION ALL

            SELECT 'PAYMENT_ALLOCATION:' || allocation.id::text AS "eventKey",
                   payment.bill_date AS "businessDate",
                   'PAYMENT_ALLOCATION'::text AS "eventType",
                   payment.bill_no AS "billNo",
                   payable.bill_no AS "sourceBillNo",
                   payable.supplier_id AS "partyId",
                   supplier.code AS "partyCode",
                   supplier.name AS "partyName",
                   payable.currency AS "currency",
                   payment.status AS "sourceStatus",
                   CAST(0 AS NUMERIC(18, 2)) AS "occurrenceAmount",
                   allocation.settlement_amount AS "settledAmount",
                   -allocation.settlement_amount AS "balanceDelta"
            FROM ap_payment_allocation allocation
            JOIN ap_payment payment ON payment.id = allocation.payment_id
            JOIN ap_payable payable ON payable.id = allocation.payable_id
            JOIN md_supplier supplier ON supplier.id = payable.supplier_id
            WHERE payment.status = 'AUDITED'
              AND payment.currency = payable.currency
        )
        SELECT payable_events.*
        FROM payable_events
        """;

    @Bean
    public ReportQuerySpec receivableDetailReportQuerySpec() {
        return detailBase("receivable-detail", RECEIVABLE_EVENT_SQL)
            .filter(ReportQuerySpec.FilterDefinition.enumEquals(
                "eventType",
                "eventType",
                ReportQuerySpec.PredicatePlacement.FACT,
                "AR_FACT",
                "RECEIPT_ALLOCATION",
                "RETURN_ALLOCATION"
            ))
            .totalSum("returnOffsetAmount", "returnOffsetAmount")
            .totalSum("pendingRefundAmount", "pendingRefundAmount")
            .csvColumn("退货冲减", "returnOffsetAmount", false)
            .csvColumn("待退款金额", "pendingRefundAmount", false)
            .csvColumn("余额变动", "balanceDelta", false)
            .build();
    }

    @Bean
    public ReportQuerySpec payableDetailReportQuerySpec() {
        return detailBase("payable-detail", PAYABLE_EVENT_SQL)
            .filter(ReportQuerySpec.FilterDefinition.enumEquals(
                "eventType",
                "eventType",
                ReportQuerySpec.PredicatePlacement.FACT,
                "AP_FACT",
                "PAYMENT_ALLOCATION"
            ))
            .csvColumn("余额变动", "balanceDelta", false)
            .build();
    }

    @Bean
    public ReportQuerySpec receivableSummaryReportQuerySpec() {
        var builder = summaryBase(
            "receivable-summary",
            RECEIVABLE_EVENT_SQL,
            """
                SELECT "partyId" AS "partyId",
                       MIN("partyCode") AS "partyCode",
                       MIN("partyName") AS "partyName",
                       "currency" AS "currency",
                       SUM(CASE WHEN "businessDate" < ? THEN "balanceDelta" ELSE CAST(0 AS NUMERIC(18, 2)) END) AS "openingBalance",
                       SUM(CASE WHEN "businessDate" BETWEEN ? AND ? THEN "occurrenceAmount" ELSE CAST(0 AS NUMERIC(18, 2)) END) AS "occurrenceAmount",
                       SUM(CASE WHEN "businessDate" BETWEEN ? AND ? THEN "settledAmount" ELSE CAST(0 AS NUMERIC(18, 2)) END) AS "settledAmount",
                       SUM(CASE WHEN "businessDate" BETWEEN ? AND ? THEN "returnOffsetAmount" ELSE CAST(0 AS NUMERIC(18, 2)) END) AS "returnOffsetAmount",
                       SUM(CASE WHEN "businessDate" BETWEEN ? AND ? THEN "pendingRefundAmount" ELSE CAST(0 AS NUMERIC(18, 2)) END) AS "pendingRefundAmount",
                       SUM(CASE WHEN "businessDate" BETWEEN ? AND ? THEN "balanceDelta" ELSE CAST(0 AS NUMERIC(18, 2)) END) AS "periodNetAmount",
                       SUM(CASE WHEN "businessDate" <= ? THEN "balanceDelta" ELSE CAST(0 AS NUMERIC(18, 2)) END) AS "closingBalance",
                       "partyId"::text || ':' || "currency" AS "rowKey"
                FROM report_fact
                WHERE "businessDate" <= ?
                GROUP BY "partyId", "currency"
                """
        );
        bindReceivableSummaryDates(builder);
        return builder
            .totalSum("returnOffsetAmount", "returnOffsetAmount")
            .totalSum("pendingRefundAmount", "pendingRefundAmount")
            .csvColumn("退货冲减", "returnOffsetAmount", false)
            .csvColumn("待退款金额", "pendingRefundAmount", false)
            .csvColumn("期间净额", "periodNetAmount", false)
            .csvColumn("期末余额", "closingBalance", false)
            .build();
    }

    @Bean
    public ReportQuerySpec payableSummaryReportQuerySpec() {
        var builder = summaryBase(
            "payable-summary",
            PAYABLE_EVENT_SQL,
            """
                SELECT "partyId" AS "partyId",
                       MIN("partyCode") AS "partyCode",
                       MIN("partyName") AS "partyName",
                       "currency" AS "currency",
                       SUM(CASE WHEN "businessDate" < ? THEN "balanceDelta" ELSE CAST(0 AS NUMERIC(18, 2)) END) AS "openingBalance",
                       SUM(CASE WHEN "businessDate" BETWEEN ? AND ? THEN "occurrenceAmount" ELSE CAST(0 AS NUMERIC(18, 2)) END) AS "occurrenceAmount",
                       SUM(CASE WHEN "businessDate" BETWEEN ? AND ? THEN "settledAmount" ELSE CAST(0 AS NUMERIC(18, 2)) END) AS "settledAmount",
                       SUM(CASE WHEN "businessDate" BETWEEN ? AND ? THEN "balanceDelta" ELSE CAST(0 AS NUMERIC(18, 2)) END) AS "periodNetAmount",
                       SUM(CASE WHEN "businessDate" <= ? THEN "balanceDelta" ELSE CAST(0 AS NUMERIC(18, 2)) END) AS "closingBalance",
                       "partyId"::text || ':' || "currency" AS "rowKey"
                FROM report_fact
                WHERE "businessDate" <= ?
                GROUP BY "partyId", "currency"
                """
        );
        bindPayableSummaryDates(builder);
        return builder
            .csvColumn("期间净额", "periodNetAmount", false)
            .csvColumn("期末余额", "closingBalance", false)
            .build();
    }

    private ReportQuerySpec.Builder detailBase(String reportKey, String sourceSql) {
        return ReportQuerySpec.builder(reportKey, PERMISSION, sourceSql)
            .requiredDateRange("businessDate", ReportQuerySpec.PredicatePlacement.FACT)
            .keywordColumns(
                ReportQuerySpec.PredicatePlacement.FACT,
                "billNo",
                "sourceBillNo",
                "partyCode",
                "partyName"
            )
            .filter(ReportQuerySpec.FilterDefinition.equals(
                "partyId",
                "partyId",
                ReportQuerySpec.ValueType.UUID,
                ReportQuerySpec.PredicatePlacement.FACT
            ))
            .filter(ReportQuerySpec.FilterDefinition.enumEquals(
                "currency",
                "currency",
                ReportQuerySpec.PredicatePlacement.FACT,
                "CNY",
                "USD"
            ))
            .sortField("businessDate", "businessDate")
            .sortField("billNo", "billNo")
            .sortField("partyCode", "partyCode")
            .sortField("eventType", "eventType")
            .sortField("balanceDelta", "balanceDelta")
            .sortField("eventKey", "eventKey")
            .defaultSort("businessDate", ReportQuerySpec.SortDirection.DESC)
            .stableSort("billNo", ReportQuerySpec.SortDirection.ASC)
            .uniqueNonNullStableSort("eventKey", ReportQuerySpec.SortDirection.ASC)
            .totalGroupColumns("currency")
            .totalSum("occurrenceAmount", "occurrenceAmount")
            .totalSum("settledAmount", "settledAmount")
            .totalSum("balanceDelta", "balanceDelta")
            .csvColumn("事件日期", "businessDate", true)
            .csvColumn("事件类型", "eventType", true)
            .csvColumn("单号", "billNo", true)
            .csvColumn("来源单号", "sourceBillNo", true)
            .csvColumn("往来单位编码", "partyCode", true)
            .csvColumn("往来单位", "partyName", true)
            .csvColumn("币种", "currency", true)
            .csvColumn("来源状态", "sourceStatus", true)
            .csvColumn("发生金额", "occurrenceAmount", false)
            .csvColumn("核销金额", "settledAmount", false);
    }

    private ReportQuerySpec.Builder summaryBase(String reportKey, String sourceSql, String resultSql) {
        return ReportQuerySpec.builder(reportKey, PERMISSION, sourceSql)
            .resultSql(resultSql)
            .requiredDateRange()
            .keywordColumns(
                ReportQuerySpec.PredicatePlacement.FACT,
                "partyCode",
                "partyName"
            )
            .filter(ReportQuerySpec.FilterDefinition.equals(
                "partyId",
                "partyId",
                ReportQuerySpec.ValueType.UUID,
                ReportQuerySpec.PredicatePlacement.FACT
            ))
            .filter(ReportQuerySpec.FilterDefinition.enumEquals(
                "currency",
                "currency",
                ReportQuerySpec.PredicatePlacement.FACT,
                "CNY",
                "USD"
            ))
            .sortField("partyCode", "partyCode")
            .sortField("partyName", "partyName")
            .sortField("currency", "currency")
            .sortField("closingBalance", "closingBalance")
            .sortField("rowKey", "rowKey")
            .defaultSort("partyCode", ReportQuerySpec.SortDirection.ASC)
            .stableSort("currency", ReportQuerySpec.SortDirection.ASC)
            .uniqueNonNullStableSort("rowKey", ReportQuerySpec.SortDirection.ASC)
            .totalGroupColumns("currency")
            .totalSum("openingBalance", "openingBalance")
            .totalSum("occurrenceAmount", "occurrenceAmount")
            .totalSum("settledAmount", "settledAmount")
            .totalSum("periodNetAmount", "periodNetAmount")
            .totalSum("closingBalance", "closingBalance")
            .csvColumn("往来单位编码", "partyCode", true)
            .csvColumn("往来单位", "partyName", true)
            .csvColumn("币种", "currency", true)
            .csvColumn("期初余额", "openingBalance", false)
            .csvColumn("本期发生", "occurrenceAmount", false)
            .csvColumn("本期核销", "settledAmount", false);
    }

    private void bindReceivableSummaryDates(ReportQuerySpec.Builder builder) {
        builder.bindResultDateFrom();
        bindResultRange(builder);
        bindResultRange(builder);
        bindResultRange(builder);
        bindResultRange(builder);
        bindResultRange(builder);
        builder.bindResultDateTo();
        builder.bindResultDateTo();
    }

    private void bindPayableSummaryDates(ReportQuerySpec.Builder builder) {
        builder.bindResultDateFrom();
        bindResultRange(builder);
        bindResultRange(builder);
        bindResultRange(builder);
        builder.bindResultDateTo();
        builder.bindResultDateTo();
    }

    private void bindResultRange(ReportQuerySpec.Builder builder) {
        builder.bindResultDateFrom();
        builder.bindResultDateTo();
    }
}
