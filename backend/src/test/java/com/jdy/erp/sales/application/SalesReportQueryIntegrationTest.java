package com.jdy.erp.sales.application;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.jdy.erp.reports.application.ReportQueryParser;
import com.jdy.erp.reports.application.ReportQueryPlanner;
import com.jdy.erp.reports.application.ReportQueryResponse;
import com.jdy.erp.reports.application.ReportQuerySpec;
import com.jdy.erp.reports.application.ReportQuerySpecRegistry;
import com.jdy.erp.reports.application.SqlReportQueryExecutor;
import com.jdy.erp.system.tenant.TenantContext;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;

@SpringBootTest
@Transactional
class SalesReportQueryIntegrationTest {
    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    @Qualifier("platformJdbcTemplate")
    private JdbcTemplate platformJdbcTemplate;

    @Autowired
    private ReportQueryParser parser;

    @Autowired
    private ReportQueryPlanner planner;

    @Autowired
    private SqlReportQueryExecutor executor;

    @Autowired
    private ReportQuerySpecRegistry registry;

    @Autowired
    @Qualifier("salesDetailReportQuerySpec")
    private ReportQuerySpec detailSpec;

    @Autowired
    @Qualifier("salesSummaryReportQuerySpec")
    private ReportQuerySpec summarySpec;

    @Autowired
    @Qualifier("salesOrderTrackingReportQuerySpec")
    private ReportQuerySpec trackingSpec;

    private String customerId;
    private String productId;
    private String productUnit;
    private String warehouseId;
    private String fixturePrefix;

    @BeforeEach
    void bindPublicTestAccountSetAndMasterData() {
        var accountSet = platformJdbcTemplate.queryForMap("""
            SELECT id::text AS id,
                   code,
                   name,
                   database_name AS "databaseName",
                   schema_name AS "schemaName",
                   COALESCE(redis_key_prefix, '') AS "redisKeyPrefix",
                   COALESCE(attachment_prefix, '') AS "attachmentPrefix"
            FROM sys_account_set
            WHERE code = 'BLD-TEST'
            """);
        TenantContext.setTenant(accountSet);

        customerId = jdbcTemplate.queryForObject(
            "SELECT id::text FROM md_customer ORDER BY code LIMIT 1",
            String.class
        );
        var product = jdbcTemplate.queryForMap(
            "SELECT id::text AS id, unit FROM md_product ORDER BY code LIMIT 1"
        );
        productId = String.valueOf(product.get("id"));
        productUnit = String.valueOf(product.get("unit"));
        warehouseId = jdbcTemplate.queryForObject(
            "SELECT id::text FROM md_warehouse ORDER BY code LIMIT 1",
            String.class
        );
        assertThat(customerId).isNotBlank();
        assertThat(productId).isNotBlank();
        assertThat(warehouseId).isNotBlank();
        fixturePrefix = "A149-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();
    }

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    @Test
    void signedDetailAndBothSummaryDimensionsKeepCurrencyUnitAndDecimalContractsExact() throws Exception {
        assertThat(registry.require("sales-detail")).isSameAs(detailSpec);
        assertThat(registry.require("sales-summary")).isSameAs(summarySpec);
        assertThat(registry.require("sales-order-tracking")).isSameAs(trackingSpec);
        assertThat(List.of(detailSpec, summarySpec, trackingSpec))
            .allSatisfy(spec -> assertThat(spec.requiredPermission()).isEqualTo("sales.order.audit"));

        var factPrefix = fixturePrefix + "-FACT";
        var firstOutLine = insertSalesOut(
            factPrefix + "-OUT-CNY",
            "AUDITED",
            "CNY",
            "10.0000",
            "100.00",
            "13.00",
            "113.00",
            productUnit,
            null,
            null,
            null,
            null
        );
        var alternateUnit = productUnit + "-A149-ALT";
        var alternateUnitOutLine = insertSalesOut(
            factPrefix + "-OUT-BOX",
            "AUDITED",
            "CNY",
            "5.0000",
            "50.00",
            "6.50",
            "56.50",
            alternateUnit,
            null,
            null,
            null,
            null
        );
        jdbcTemplate.update(
            "UPDATE sales_out_line SET product_unit_snapshot = ? WHERE id = ?::uuid",
            alternateUnit,
            alternateUnitOutLine
        );
        insertSalesOut(
            factPrefix + "-LEGACY-RED",
            "RED_REVERSED",
            "USD",
            "-2.0000",
            "-40.00",
            "-5.20",
            "-45.20",
            productUnit,
            null,
            null,
            null,
            null
        );
        insertSalesOut(
            factPrefix + "-DRAFT",
            "DRAFT",
            "CNY",
            "99.0000",
            "990.00",
            "128.70",
            "1118.70",
            productUnit,
            null,
            null,
            null,
            null
        );
        insertSalesReturn(
            factPrefix + "-RETURN-CNY",
            "AUDITED",
            "CNY",
            firstOutLine,
            factPrefix + "-OUT-CNY",
            "3.0000",
            "30.00",
            "3.90",
            "33.90",
            productUnit
        );
        insertSalesReturn(
            factPrefix + "-RETURN-DRAFT",
            "DRAFT",
            "CNY",
            firstOutLine,
            factPrefix + "-OUT-CNY",
            "1.0000",
            "10.00",
            "1.30",
            "11.30",
            productUnit
        );

        var detail = query(detailSpec, Map.of(
            "dateFrom", List.of("2026-07-01"),
            "dateTo", List.of("2026-07-31"),
            "keyword", List.of(factPrefix),
            "pageSize", List.of("20")
        ));
        assertThat(detail.reportKey()).isEqualTo("sales-detail");
        assertThat(detail.total()).isEqualTo(4L);
        assertThat(detail.rows()).extracting(row -> row.get("documentType"))
            .containsExactlyInAnyOrder("SALES_OUT", "SALES_OUT", "SALES_OUT", "SALES_RETURN");
        assertThat(row(detail.rows(), factPrefix + "-OUT-CNY"))
            .containsEntry("sourceTarget", "salesOut")
            .containsEntry("sourceBillNo", factPrefix + "-OUT-CNY");
        assertThat(row(detail.rows(), factPrefix + "-RETURN-CNY"))
            .containsEntry("sourceTarget", "salesReturn")
            .containsEntry("sourceBillNo", factPrefix + "-RETURN-CNY")
            .containsEntry("qty", "-3")
            .containsEntry("amount", "-30")
            .containsEntry("taxAmount", "-3.9")
            .containsEntry("priceTaxTotal", "-33.9");
        assertThat(row(detail.rows(), factPrefix + "-LEGACY-RED"))
            .containsEntry("qty", "-2")
            .containsEntry("amount", "-40")
            .containsEntry("priceTaxTotal", "-45.2");
        assertThat(detail.totals()).anySatisfy(total -> assertThat(total)
            .containsEntry("currency", "CNY")
            .containsEntry("amount", "120")
            .containsEntry("taxAmount", "15.6")
            .containsEntry("priceTaxTotal", "135.6"));
        assertThat(detail.totals()).anySatisfy(total -> assertThat(total)
            .containsEntry("currency", "USD")
            .containsEntry("amount", "-40")
            .containsEntry("taxAmount", "-5.2")
            .containsEntry("priceTaxTotal", "-45.2"));
        var detailSecondPage = query(detailSpec, Map.of(
            "dateFrom", List.of("2026-07-01"),
            "dateTo", List.of("2026-07-31"),
            "keyword", List.of(factPrefix),
            "page", List.of("2"),
            "pageSize", List.of("20")
        ));
        assertThat(detailSecondPage.total()).isEqualTo(detail.total());
        assertThat(detailSecondPage.rows()).isEmpty();
        assertThat(detailSecondPage.totals()).isEqualTo(detail.totals());
        assertThat(query(detailSpec, Map.of(
            "dateFrom", List.of("2026-07-01"),
            "dateTo", List.of("2026-07-31"),
            "keyword", List.of(factPrefix + "-MISSING"),
            "pageSize", List.of("20")
        )).rows()).isEmpty();

        var customerSummary = query(summarySpec, Map.of(
            "dateFrom", List.of("2026-07-01"),
            "dateTo", List.of("2026-07-31"),
            "keyword", List.of(factPrefix),
            "pageSize", List.of("20")
        ));
        assertThat(customerSummary.query()).containsEntry("dimension", "CUSTOMER");
        assertThat(customerSummary.rows()).hasSize(2).allSatisfy(row -> {
            assertThat(row).containsEntry("dimension", "CUSTOMER");
            assertThat(row.get("qty")).isNull();
        });
        assertThat(customerSummary.rows()).anySatisfy(row -> assertThat(row)
            .containsEntry("currency", "CNY")
            .containsEntry("amount", "120")
            .containsEntry("priceTaxTotal", "135.6"));
        assertThat(customerSummary.rows()).anySatisfy(row -> assertThat(row)
            .containsEntry("currency", "USD")
            .containsEntry("amount", "-40"));

        var productSummary = query(summarySpec, Map.of(
            "dateFrom", List.of("2026-07-01"),
            "dateTo", List.of("2026-07-31"),
            "keyword", List.of(factPrefix),
            "dimension", List.of("PRODUCT_UNIT"),
            "pageSize", List.of("20")
        ));
        assertThat(productSummary.query()).containsEntry("dimension", "PRODUCT_UNIT");
        assertThat(productSummary.rows()).hasSize(3);
        assertThat(productSummary.rows()).anySatisfy(row -> assertThat(row)
            .containsEntry("productId", UUID.fromString(productId))
            .containsEntry("unit", productUnit)
            .containsEntry("currency", "CNY")
            .containsEntry("qty", "7")
            .containsEntry("amount", "70"));
        assertThat(productSummary.rows()).anySatisfy(row -> assertThat(row)
            .containsEntry("productId", UUID.fromString(productId))
            .containsEntry("unit", alternateUnit)
            .containsEntry("currency", "CNY")
            .containsEntry("qty", "5")
            .containsEntry("amount", "50"));
        assertThat(productSummary.rows()).anySatisfy(row -> assertThat(row)
            .containsEntry("productId", UUID.fromString(productId))
            .containsEntry("unit", productUnit)
            .containsEntry("currency", "USD")
            .containsEntry("qty", "-2")
            .containsEntry("amount", "-40"));
        assertThat(productSummary.totals()).anySatisfy(total -> {
            assertThat(total)
                .containsEntry("dimension", "PRODUCT_UNIT")
                .containsEntry("currency", "CNY")
                .containsEntry("amount", "120")
                .containsEntry("priceTaxTotal", "135.6");
            assertThat(total).doesNotContainKey("qty");
        });
        var summarySecondPage = query(summarySpec, Map.of(
            "dateFrom", List.of("2026-07-01"),
            "dateTo", List.of("2026-07-31"),
            "keyword", List.of(factPrefix),
            "page", List.of("2"),
            "pageSize", List.of("20")
        ));
        assertThat(summarySecondPage.total()).isEqualTo(customerSummary.total());
        assertThat(summarySecondPage.rows()).isEmpty();
        assertThat(summarySecondPage.totals()).isEqualTo(customerSummary.totals());

        var detailParameters = Map.of(
            "dateFrom", List.of("2026-07-01"),
            "dateTo", List.of("2026-07-31"),
            "keyword", List.of(factPrefix),
            "pageSize", List.of("20")
        );
        var detailCsv = exportCsv(detailSpec, detailParameters, detail.total());
        assertThat(detailCsv).startsWith("\ufeff日期,单号,类型");
        assertThat(detailCsv).contains(factPrefix + "-RETURN-CNY").contains("-30.00").contains("USD");

        var productSummaryParameters = Map.of(
            "dateFrom", List.of("2026-07-01"),
            "dateTo", List.of("2026-07-31"),
            "keyword", List.of(factPrefix),
            "dimension", List.of("PRODUCT_UNIT"),
            "pageSize", List.of("20")
        );
        var productSummaryCsv = exportCsv(summarySpec, productSummaryParameters, productSummary.total());
        assertThat(productSummaryCsv)
            .startsWith("\ufeff汇总维度,客户编码,客户")
            .contains("PRODUCT_UNIT", alternateUnit, "-40.00");
    }

    @Test
    void orderTrackingUsesNODRFormulasCurrentDownstreamFactsAndNeverShippedCounterGuessing() throws Exception {
        var orderNo = fixturePrefix + "-TRACK-OK";
        var orderLineId = insertSalesOrder(orderNo, "10.0000", "999.0000");
        var noticeNo = fixturePrefix + "-NOTICE";
        insertDeliveryNotice(noticeNo, orderNo, 1, "4.0000", "2025-01-01");
        var linkedOut = insertSalesOut(
            fixturePrefix + "-TRACK-LINKED-OUT",
            "AUDITED",
            "CNY",
            "4.0000",
            "40.00",
            "5.20",
            "45.20",
            "PCS",
            orderNo,
            1,
            noticeNo,
            1
        );
        insertSalesOut(
            fixturePrefix + "-TRACK-DIRECT-OUT",
            "AUDITED",
            "CNY",
            "2.0000",
            "20.00",
            "2.60",
            "22.60",
            "PCS",
            orderNo,
            1,
            null,
            null
        );
        insertSalesReturn(
            fixturePrefix + "-TRACK-RETURN",
            "AUDITED",
            "CNY",
            linkedOut,
            fixturePrefix + "-TRACK-LINKED-OUT",
            "1.0000",
            "10.00",
            "1.30",
            "11.30",
            "PCS"
        );

        var response = query(trackingSpec, Map.of(
            "dateFrom", List.of("2026-07-01"),
            "dateTo", List.of("2026-07-31"),
            "keyword", List.of(orderNo),
            "pageSize", List.of("20")
        ));
        assertThat(response.rows()).singleElement().satisfies(row -> assertThat(row)
            .containsEntry("rowKey", "SALES_ORDER:" + orderLineId)
            .containsEntry("sourceTarget", "salesOrder")
            .containsEntry("sourceBillNo", orderNo)
            .containsEntry("noticeQty", "4")
            .containsEntry("directOutQty", "2")
            .containsEntry("executedQty", "6")
            .containsEntry("shippedQty", "6")
            .containsEntry("returnedQty", "1")
            .containsEntry("netDeliveredQty", "5")
            .containsEntry("unexecutedQty", "4")
            .containsEntry("executedUnshippedQty", "0")
            .containsEntry("legacyShippedCounter", "999")
            .containsEntry("counterReconciliation", "COUNTER_MISMATCH")
            .containsEntry("consistencyStatus", "CONSISTENT")
            .containsEntry("executionStatus", "PARTIALLY_EXECUTED")
            .containsEntry("shipmentStatus", "PARTIALLY_SHIPPED"));
        var trackingParameters = Map.of(
            "dateFrom", List.of("2026-07-01"),
            "dateTo", List.of("2026-07-31"),
            "keyword", List.of(orderNo),
            "pageSize", List.of("20")
        );
        var trackingCsv = exportCsv(trackingSpec, trackingParameters, response.total());
        assertThat(trackingCsv).startsWith("\ufeff订单日期,订单号,行号").contains(orderNo, "COUNTER_MISMATCH");
        var trackingSecondPage = query(trackingSpec, Map.of(
            "dateFrom", List.of("2026-07-01"),
            "dateTo", List.of("2026-07-31"),
            "keyword", List.of(orderNo),
            "page", List.of("2"),
            "pageSize", List.of("20")
        ));
        assertThat(trackingSecondPage.total()).isEqualTo(response.total());
        assertThat(trackingSecondPage.rows()).isEmpty();
        assertThat(query(trackingSpec, Map.of(
            "dateFrom", List.of("2026-07-01"),
            "dateTo", List.of("2026-07-31"),
            "keyword", List.of(orderNo + "-MISSING"),
            "pageSize", List.of("20")
        )).rows()).isEmpty();

        var fullyShippedOrderNo = fixturePrefix + "-TRACK-FULL-WITH-RETURN";
        insertSalesOrder(fullyShippedOrderNo, "10.0000", "0.0000");
        var fullyShippedOut = insertSalesOut(
            fixturePrefix + "-TRACK-FULL-OUT",
            "AUDITED",
            "CNY",
            "10.0000",
            "100.00",
            "13.00",
            "113.00",
            "PCS",
            fullyShippedOrderNo,
            1,
            null,
            null
        );
        insertSalesReturn(
            fixturePrefix + "-TRACK-FULL-RETURN",
            "AUDITED",
            "CNY",
            fullyShippedOut,
            fixturePrefix + "-TRACK-FULL-OUT",
            "1.0000",
            "10.00",
            "1.30",
            "11.30",
            "PCS"
        );
        var fullyShippedWithReturn = query(trackingSpec, Map.of(
            "dateFrom", List.of("2026-07-01"),
            "dateTo", List.of("2026-07-31"),
            "keyword", List.of(fullyShippedOrderNo),
            "pageSize", List.of("20")
        ));
        assertThat(fullyShippedWithReturn.rows()).singleElement().satisfies(row -> assertThat(row)
            .containsEntry("executedQty", "10")
            .containsEntry("shippedQty", "10")
            .containsEntry("returnedQty", "1")
            .containsEntry("netDeliveredQty", "9")
            .containsEntry("executionStatus", "EXECUTED")
            .containsEntry("shipmentStatus", "FULLY_SHIPPED"));

        var inconsistentOrderNo = fixturePrefix + "-TRACK-BAD";
        insertSalesOrder(inconsistentOrderNo, "2.0000", "0.0000");
        insertSalesOut(
            fixturePrefix + "-TRACK-BAD-OUT",
            "AUDITED",
            "CNY",
            "3.0000",
            "30.00",
            "3.90",
            "33.90",
            "PCS",
            inconsistentOrderNo,
            1,
            noticeNo,
            1
        );
        var inconsistent = query(trackingSpec, Map.of(
            "dateFrom", List.of("2026-07-01"),
            "dateTo", List.of("2026-07-31"),
            "keyword", List.of(inconsistentOrderNo),
            "consistencyStatus", List.of("INCONSISTENT"),
            "pageSize", List.of("20")
        ));
        assertThat(inconsistent.rows()).singleElement().satisfies(row -> assertThat(row)
            .containsEntry("directOutQty", "3")
            .containsEntry("executedQty", "3")
            .containsEntry("shippedQty", "3")
            .containsEntry("unexecutedQty", "0")
            .containsEntry("consistencyStatus", "INCONSISTENT")
            .containsEntry("executionStatus", "INCONSISTENT")
            .containsEntry("shipmentStatus", "INCONSISTENT"));
    }

    @Test
    void unqualifiedDefinitionReadsOnlySelectedSchemaAndDoesNotLeakSameNumberDecoy() {
        var schemaA = "a149_a_" + UUID.randomUUID().toString().replace("-", "").substring(0, 8);
        var schemaB = "a149_b_" + UUID.randomUUID().toString().replace("-", "").substring(0, 8);
        createDetailSchema(schemaA, "TENANT-A", "10.00");
        createDetailSchema(schemaB, "TENANT-B-DECOY", "999.00");
        assertThat(detailSpec.sourceSql()).doesNotContain("public.", schemaA + ".", schemaB + ".");

        jdbcTemplate.execute("SET LOCAL search_path TO " + schemaA);
        var tenantA = query(detailSpec, Map.of(
            "dateFrom", List.of("2026-07-01"),
            "dateTo", List.of("2026-07-31"),
            "keyword", List.of("A149-SAME"),
            "pageSize", List.of("20")
        ));
        assertThat(tenantA.rows()).singleElement().satisfies(row -> assertThat(row)
            .containsEntry("customerName", "TENANT-A")
            .containsEntry("amount", "10"));
        assertThat(tenantA.rows()).noneSatisfy(row -> assertThat(row.get("customerName"))
            .isEqualTo("TENANT-B-DECOY"));
        var tenantASummary = query(summarySpec, Map.of(
            "dateFrom", List.of("2026-07-01"),
            "dateTo", List.of("2026-07-31"),
            "keyword", List.of("A149-SAME"),
            "pageSize", List.of("20")
        ));
        assertThat(tenantASummary.rows()).singleElement().satisfies(row -> assertThat(row)
            .containsEntry("customerName", "TENANT-A")
            .containsEntry("amount", "10"));

        jdbcTemplate.execute("SET LOCAL search_path TO " + schemaB);
        var tenantB = query(detailSpec, Map.of(
            "dateFrom", List.of("2026-07-01"),
            "dateTo", List.of("2026-07-31"),
            "keyword", List.of("A149-SAME"),
            "pageSize", List.of("20")
        ));
        assertThat(tenantB.rows()).singleElement().satisfies(row -> assertThat(row)
            .containsEntry("customerName", "TENANT-B-DECOY")
            .containsEntry("amount", "999"));
        var tenantBSummary = query(summarySpec, Map.of(
            "dateFrom", List.of("2026-07-01"),
            "dateTo", List.of("2026-07-31"),
            "keyword", List.of("A149-SAME"),
            "pageSize", List.of("20")
        ));
        assertThat(tenantBSummary.rows()).singleElement().satisfies(row -> assertThat(row)
            .containsEntry("customerName", "TENANT-B-DECOY")
            .containsEntry("amount", "999"));
        jdbcTemplate.execute("SET LOCAL search_path TO public");
    }

    private ReportQueryResponse query(ReportQuerySpec spec, Map<String, List<String>> parameters) {
        var data = executor.query(spec, plan(spec, parameters));
        var normalized = parser.parse(spec, parameters);
        return new ReportQueryResponse(
            spec.reportKey(),
            normalized.page(),
            normalized.pageSize(),
            data.total(),
            data.rows(),
            data.totals(),
            normalized.echo(),
            Instant.parse("2026-07-14T00:00:00Z")
        );
    }

    private com.jdy.erp.reports.application.ReportQueryPlan plan(
        ReportQuerySpec spec,
        Map<String, List<String>> parameters
    ) {
        return planner.plan(spec, parser.parse(spec, parameters));
    }

    private String exportCsv(
        ReportQuerySpec spec,
        Map<String, List<String>> parameters,
        long expectedRows
    ) throws Exception {
        var artifact = executor.export(spec, plan(spec, parameters));
        try {
            assertThat(artifact.rowCount()).isEqualTo(expectedRows);
            return Files.readString(artifact.path(), StandardCharsets.UTF_8);
        } finally {
            artifact.release("a149-test");
        }
    }

    private Map<String, Object> row(List<Map<String, Object>> rows, String billNo) {
        return rows.stream()
            .filter(row -> billNo.equals(row.get("billNo")))
            .findFirst()
            .orElseThrow();
    }

    private String insertSalesOut(
        String billNo,
        String status,
        String currency,
        String qty,
        String amount,
        String taxAmount,
        String priceTaxTotal,
        String unit,
        String sourceOrderNo,
        Integer sourceLineNo,
        String sourceDeliveryNoticeNo,
        Integer sourceDeliveryLineNo
    ) {
        var billId = UUID.randomUUID().toString();
        var lineId = UUID.randomUUID().toString();
        jdbcTemplate.update("""
            INSERT INTO sales_out (
                id, bill_no, customer_id, bill_date, status, total_amount, currency
            ) VALUES (?::uuid, ?, ?::uuid, DATE '2026-07-10', ?, ?::numeric, ?)
            """, billId, billNo, customerId, status, priceTaxTotal, currency);
        jdbcTemplate.update("""
            INSERT INTO sales_out_line (
                id, bill_id, line_no, product_id, warehouse_id,
                qty, unit_price, amount, tax_rate, tax_amount, price_tax_total,
                product_code_snapshot, product_name_snapshot, product_spec_snapshot,
                product_unit_snapshot, source_order_no, source_line_no,
                source_delivery_notice_no, source_delivery_line_no
            ) VALUES (
                ?::uuid, ?::uuid, 1, ?::uuid, ?::uuid,
                ?::numeric, 10.00, ?::numeric, 13.0000, ?::numeric, ?::numeric,
                'A149-PRODUCT', 'A149 Product', 'A149 Spec',
                ?, ?, ?, ?, ?
            )
            """,
            lineId,
            billId,
            productId,
            warehouseId,
            qty,
            amount,
            taxAmount,
            priceTaxTotal,
            unit,
            sourceOrderNo,
            sourceLineNo,
            sourceDeliveryNoticeNo,
            sourceDeliveryLineNo
        );
        return lineId;
    }

    private void insertSalesReturn(
        String billNo,
        String status,
        String currency,
        String sourceOutLineId,
        String sourceOutNo,
        String qty,
        String amount,
        String taxAmount,
        String priceTaxTotal,
        String unit
    ) {
        var billId = UUID.randomUUID().toString();
        jdbcTemplate.update("""
            INSERT INTO sales_return (
                id, bill_no, customer_id, bill_date, status, total_amount, currency
            ) VALUES (?::uuid, ?, ?::uuid, DATE '2026-07-20', ?, ?::numeric, ?)
            """, billId, billNo, customerId, status, priceTaxTotal, currency);
        jdbcTemplate.update("""
            INSERT INTO sales_return_line (
                id, bill_id, line_no, source_out_line_id, source_out_no, source_line_no,
                product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot,
                product_unit_snapshot, warehouse_id, qty, unit_price, amount,
                tax_rate, tax_amount, price_tax_total
            ) VALUES (
                gen_random_uuid(), ?::uuid, 1, ?::uuid, ?, 1,
                ?::uuid, 'A149-PRODUCT', 'A149 Product', 'A149 Spec',
                ?, ?::uuid, ?::numeric, 10.00, ?::numeric,
                13.0000, ?::numeric, ?::numeric
            )
            """,
            billId,
            sourceOutLineId,
            sourceOutNo,
            productId,
            unit,
            warehouseId,
            qty,
            amount,
            taxAmount,
            priceTaxTotal
        );
    }

    private String insertSalesOrder(String billNo, String qty, String shippedCounter) {
        var billId = UUID.randomUUID().toString();
        var lineId = UUID.randomUUID().toString();
        jdbcTemplate.update("""
            INSERT INTO sales_order (
                id, bill_no, customer_id, bill_date, status, total_amount, currency
            ) VALUES (?::uuid, ?, ?::uuid, DATE '2026-07-10', 'AUDITED', 100.00, 'CNY')
            """, billId, billNo, customerId);
        jdbcTemplate.update("""
            INSERT INTO sales_order_line (
                id, order_id, line_no, product_id, warehouse_id,
                qty, unit_price, amount, tax_rate, tax_amount, price_tax_total,
                shipped_qty, plan_delivery_date, product_code_snapshot,
                product_name_snapshot, product_spec_snapshot, product_unit_snapshot
            ) VALUES (
                ?::uuid, ?::uuid, 1, ?::uuid, ?::uuid,
                ?::numeric, 10.00, 100.00, 13.0000, 13.00, 113.00,
                ?::numeric, DATE '2026-07-30', 'A149-PRODUCT',
                'A149 Product', 'A149 Spec', 'PCS'
            )
            """, lineId, billId, productId, warehouseId, qty, shippedCounter);
        return lineId;
    }

    private void insertDeliveryNotice(
        String billNo,
        String sourceOrderNo,
        int sourceLineNo,
        String qty,
        String billDate
    ) {
        var billId = UUID.randomUUID().toString();
        jdbcTemplate.update("""
            INSERT INTO delivery_notice (
                id, bill_no, customer_id, bill_date, status, total_amount, currency
            ) VALUES (?::uuid, ?, ?::uuid, ?::date, 'AUDITED', 40.00, 'CNY')
            """, billId, billNo, customerId, billDate);
        jdbcTemplate.update("""
            INSERT INTO delivery_notice_line (
                bill_id, line_no, source_order_no, source_line_no,
                product_id, warehouse_id, qty, unit_price, amount,
                tax_rate, tax_amount, price_tax_total
            ) VALUES (
                ?::uuid, 1, ?, ?, ?::uuid, ?::uuid, ?::numeric,
                10.00, 40.00, 13.0000, 5.20, 45.20
            )
            """, billId, sourceOrderNo, sourceLineNo, productId, warehouseId, qty);
    }

    private void createDetailSchema(String schema, String customerName, String amount) {
        jdbcTemplate.execute("CREATE SCHEMA " + schema);
        jdbcTemplate.execute("CREATE TABLE " + schema + ".md_customer (id uuid, code text, name text)");
        jdbcTemplate.execute("CREATE TABLE " + schema + ".md_product (id uuid, code text, name text, spec text, unit text)");
        jdbcTemplate.execute("CREATE TABLE " + schema + ".md_warehouse (id uuid, code text, name text)");
        jdbcTemplate.execute("""
            CREATE TABLE %s.sales_out (
                id uuid, bill_date date, bill_no text, status text, customer_id uuid, currency text
            )
            """.formatted(schema));
        jdbcTemplate.execute("""
            CREATE TABLE %s.sales_out_line (
                id uuid, bill_id uuid, line_no integer, product_id uuid, warehouse_id uuid,
                product_code_snapshot text, product_name_snapshot text, product_spec_snapshot text,
                product_unit_snapshot text, qty numeric, unit_price numeric, amount numeric,
                tax_amount numeric, price_tax_total numeric
            )
            """.formatted(schema));
        jdbcTemplate.execute("""
            CREATE TABLE %s.sales_return (
                id uuid, bill_date date, bill_no text, status text, customer_id uuid, currency text
            )
            """.formatted(schema));
        jdbcTemplate.execute("""
            CREATE TABLE %s.sales_return_line (
                id uuid, bill_id uuid, line_no integer, product_id uuid, warehouse_id uuid,
                product_code_snapshot text, product_name_snapshot text, product_spec_snapshot text,
                product_unit_snapshot text, qty numeric, unit_price numeric, amount numeric,
                tax_amount numeric, price_tax_total numeric
            )
            """.formatted(schema));

        var customer = UUID.randomUUID();
        var product = UUID.randomUUID();
        var warehouse = UUID.randomUUID();
        var bill = UUID.randomUUID();
        jdbcTemplate.update(
            "INSERT INTO " + schema + ".md_customer VALUES (?::uuid, 'SAME-CUSTOMER', ?)",
            customer.toString(),
            customerName
        );
        jdbcTemplate.update(
            "INSERT INTO " + schema + ".md_product VALUES (?::uuid, 'SAME-PRODUCT', 'Same Product', 'Spec', 'PCS')",
            product.toString()
        );
        jdbcTemplate.update(
            "INSERT INTO " + schema + ".md_warehouse VALUES (?::uuid, 'SAME-WH', 'Same Warehouse')",
            warehouse.toString()
        );
        jdbcTemplate.update(
            "INSERT INTO " + schema + ".sales_out VALUES (?::uuid, DATE '2026-07-10', 'A149-SAME', 'AUDITED', ?::uuid, 'CNY')",
            bill.toString(),
            customer.toString()
        );
        jdbcTemplate.update("""
            INSERT INTO %s.sales_out_line VALUES (
                gen_random_uuid(), ?::uuid, 1, ?::uuid, ?::uuid,
                'SAME-PRODUCT', 'Same Product', 'Spec', 'PCS',
                1.0000, %s::numeric, %s::numeric, 0.00, %s::numeric
            )
            """.formatted(schema, amount, amount, amount), bill.toString(), product.toString(), warehouse.toString());
    }
}
