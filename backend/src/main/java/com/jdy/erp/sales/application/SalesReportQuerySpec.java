package com.jdy.erp.sales.application;

import com.jdy.erp.reports.application.ReportQuerySpec;
import com.jdy.erp.reports.application.ReportQuerySpec.FilterDefinition;
import com.jdy.erp.reports.application.ReportQuerySpec.PredicatePlacement;
import com.jdy.erp.reports.application.ReportQuerySpec.SortDirection;
import com.jdy.erp.reports.application.ReportQuerySpec.ValueType;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * F029 sales report definitions.
 *
 * <p>Every relation is deliberately unqualified so the report foundation's
 * routed connection owns tenant isolation. The detail and summary definitions
 * share the same signed sales fact: effective sales-out rows keep their stored
 * sign, while audited sales-return rows are negated exactly once.</p>
 */
@Configuration(proxyBeanMethods = false)
public class SalesReportQuerySpec {
    private static final String PERMISSION = "sales.order.audit";

    private static final String SIGNED_SALES_FACT_SQL = """
        SELECT 'SALES_OUT:' || line.id::text AS "rowKey",
               bill.bill_date AS "billDate",
               bill.bill_no AS "billNo",
               line.line_no AS "lineNo",
               'SALES_OUT'::text AS "documentType",
               'salesOut'::text AS "sourceTarget",
               bill.bill_no AS "sourceBillNo",
               bill.customer_id AS "customerId",
               customer.code AS "customerCode",
               customer.name AS "customerName",
               line.product_id AS "productId",
               COALESCE(NULLIF(line.product_code_snapshot, ''), product.code) AS "productCode",
               COALESCE(NULLIF(line.product_name_snapshot, ''), product.name) AS "productName",
               COALESCE(line.product_spec_snapshot, product.spec, '') AS "specification",
               line.warehouse_id AS "warehouseId",
               warehouse.code AS "warehouseCode",
               warehouse.name AS "warehouseName",
               COALESCE(NULLIF(line.product_unit_snapshot, ''), product.unit) AS "unit",
               line.qty AS "qty",
               line.unit_price AS "unitPrice",
               line.amount AS "amount",
               line.tax_amount AS "taxAmount",
               line.price_tax_total AS "priceTaxTotal",
               bill.currency AS "currency"
        FROM sales_out_line line
        JOIN sales_out bill ON bill.id = line.bill_id
        JOIN md_customer customer ON customer.id = bill.customer_id
        JOIN md_product product ON product.id = line.product_id
        JOIN md_warehouse warehouse ON warehouse.id = line.warehouse_id
        WHERE bill.status IN ('AUDITED', 'RED_REVERSED')
        UNION ALL
        SELECT 'SALES_RETURN:' || line.id::text AS "rowKey",
               bill.bill_date AS "billDate",
               bill.bill_no AS "billNo",
               line.line_no AS "lineNo",
               'SALES_RETURN'::text AS "documentType",
               'salesReturn'::text AS "sourceTarget",
               bill.bill_no AS "sourceBillNo",
               bill.customer_id AS "customerId",
               customer.code AS "customerCode",
               customer.name AS "customerName",
               line.product_id AS "productId",
               COALESCE(NULLIF(line.product_code_snapshot, ''), product.code) AS "productCode",
               COALESCE(NULLIF(line.product_name_snapshot, ''), product.name) AS "productName",
               COALESCE(line.product_spec_snapshot, product.spec, '') AS "specification",
               line.warehouse_id AS "warehouseId",
               warehouse.code AS "warehouseCode",
               warehouse.name AS "warehouseName",
               COALESCE(NULLIF(line.product_unit_snapshot, ''), product.unit) AS "unit",
               -line.qty AS "qty",
               line.unit_price AS "unitPrice",
               -line.amount AS "amount",
               -line.tax_amount AS "taxAmount",
               -line.price_tax_total AS "priceTaxTotal",
               bill.currency AS "currency"
        FROM sales_return_line line
        JOIN sales_return bill ON bill.id = line.bill_id
        JOIN md_customer customer ON customer.id = bill.customer_id
        JOIN md_product product ON product.id = line.product_id
        JOIN md_warehouse warehouse ON warehouse.id = line.warehouse_id
        WHERE bill.status = 'AUDITED'
        """;

    private static final String SALES_SUMMARY_SQL = """
        SELECT jsonb_build_array('CUSTOMER', "customerId", "currency")::text AS "rowKey",
               'CUSTOMER'::text AS "dimension",
               "customerId",
               MAX("customerCode") AS "customerCode",
               MAX("customerName") AS "customerName",
               NULL::uuid AS "productId",
               NULL::text AS "productCode",
               NULL::text AS "productName",
               NULL::text AS "specification",
               NULL::text AS "unit",
               "currency",
               NULL::numeric AS "qty",
               SUM("amount") AS "amount",
               SUM("taxAmount") AS "taxAmount",
               SUM("priceTaxTotal") AS "priceTaxTotal"
        FROM report_fact
        WHERE ? = 'CUSTOMER'
        GROUP BY "customerId", "currency"
        UNION ALL
        SELECT jsonb_build_array('PRODUCT_UNIT', "productId", "unit", "currency")::text AS "rowKey",
               'PRODUCT_UNIT'::text AS "dimension",
               NULL::uuid AS "customerId",
               NULL::text AS "customerCode",
               NULL::text AS "customerName",
               "productId",
               MAX("productCode") AS "productCode",
               MAX("productName") AS "productName",
               MAX("specification") AS "specification",
               "unit",
               "currency",
               SUM("qty") AS "qty",
               SUM("amount") AS "amount",
               SUM("taxAmount") AS "taxAmount",
               SUM("priceTaxTotal") AS "priceTaxTotal"
        FROM report_fact
        WHERE ? = 'PRODUCT_UNIT'
        GROUP BY "productId", "unit", "currency"
        """;

    private static final String SALES_ORDER_TRACKING_SQL = """
        WITH notice_qty AS (
            SELECT line.source_order_no,
                   line.source_line_no,
                   SUM(line.qty) AS qty
            FROM delivery_notice_line line
            JOIN delivery_notice bill ON bill.id = line.bill_id
            WHERE bill.status = 'AUDITED'
              AND line.source_order_no IS NOT NULL
              AND line.source_line_no IS NOT NULL
            GROUP BY line.source_order_no, line.source_line_no
        ),
        out_qty AS (
            SELECT line.source_order_no,
                   line.source_line_no,
                   SUM(line.qty) AS qty,
                   SUM(
                       CASE WHEN EXISTS (
                           SELECT 1
                           FROM delivery_notice_line notice_line
                           JOIN delivery_notice notice_bill ON notice_bill.id = notice_line.bill_id
                           WHERE notice_bill.status = 'AUDITED'
                             AND notice_bill.bill_no = line.source_delivery_notice_no
                             AND notice_line.line_no = line.source_delivery_line_no
                             AND notice_line.source_order_no = line.source_order_no
                             AND notice_line.source_line_no = line.source_line_no
                       ) THEN 0 ELSE line.qty END
                   ) AS direct_qty
            FROM sales_out_line line
            JOIN sales_out bill ON bill.id = line.bill_id
            WHERE bill.status IN ('AUDITED', 'RED_REVERSED')
              AND line.source_order_no IS NOT NULL
              AND line.source_line_no IS NOT NULL
            GROUP BY line.source_order_no, line.source_line_no
        ),
        return_qty AS (
            SELECT source_line.source_order_no,
                   source_line.source_line_no,
                   SUM(return_line.qty) AS qty
            FROM sales_return_line return_line
            JOIN sales_return return_bill ON return_bill.id = return_line.bill_id
            JOIN sales_out_line source_line ON source_line.id = return_line.source_out_line_id
            WHERE return_bill.status = 'AUDITED'
              AND source_line.source_order_no IS NOT NULL
              AND source_line.source_line_no IS NOT NULL
            GROUP BY source_line.source_order_no, source_line.source_line_no
        ),
        tracking_raw AS (
            SELECT 'SALES_ORDER:' || line.id::text AS "rowKey",
                   bill.bill_date AS "billDate",
                   bill.bill_no AS "billNo",
                   line.line_no AS "lineNo",
                   'salesOrder'::text AS "sourceTarget",
                   bill.bill_no AS "sourceBillNo",
                   bill.customer_id AS "customerId",
                   customer.code AS "customerCode",
                   customer.name AS "customerName",
                   line.product_id AS "productId",
                   COALESCE(NULLIF(line.product_code_snapshot, ''), product.code) AS "productCode",
                   COALESCE(NULLIF(line.product_name_snapshot, ''), product.name) AS "productName",
                   COALESCE(line.product_spec_snapshot, product.spec, '') AS "specification",
                   COALESCE(NULLIF(line.product_unit_snapshot, ''), product.unit) AS "unit",
                   line.warehouse_id AS "warehouseId",
                   COALESCE(warehouse.code, '') AS "warehouseCode",
                   COALESCE(warehouse.name, '') AS "warehouseName",
                   bill.currency AS "currency",
                   line.plan_delivery_date AS "planDeliveryDate",
                   line.qty AS "orderQty",
                   COALESCE(notice.qty, 0::numeric) AS "noticeQty",
                   COALESCE(outbound.qty, 0::numeric) AS "shippedQty",
                   COALESCE(outbound.direct_qty, 0::numeric) AS "directOutQty",
                   COALESCE(returned.qty, 0::numeric) AS "returnedQty",
                   line.shipped_qty AS "legacyShippedCounter"
            FROM sales_order_line line
            JOIN sales_order bill ON bill.id = line.order_id
            JOIN md_customer customer ON customer.id = bill.customer_id
            JOIN md_product product ON product.id = line.product_id
            LEFT JOIN md_warehouse warehouse ON warehouse.id = line.warehouse_id
            LEFT JOIN notice_qty notice
              ON notice.source_order_no = bill.bill_no
             AND notice.source_line_no = line.line_no
            LEFT JOIN out_qty outbound
              ON outbound.source_order_no = bill.bill_no
             AND outbound.source_line_no = line.line_no
            LEFT JOIN return_qty returned
              ON returned.source_order_no = bill.bill_no
             AND returned.source_line_no = line.line_no
            WHERE bill.status = 'AUDITED'
        ),
        tracking_metrics AS (
            SELECT tracking_raw.*,
                   "noticeQty" + "directOutQty" AS "executedQty",
                   "shippedQty" - "returnedQty" AS "netDeliveredQty",
                   GREATEST("orderQty" - ("noticeQty" + "directOutQty"), 0::numeric) AS "unexecutedQty",
                   GREATEST(("noticeQty" + "directOutQty") - "shippedQty", 0::numeric) AS "executedUnshippedQty"
            FROM tracking_raw
        ),
        tracking_status AS (
            SELECT tracking_metrics.*,
                   CASE WHEN "orderQty" < 0
                          OR "noticeQty" < 0
                          OR "shippedQty" < 0
                          OR "directOutQty" < 0
                          OR "returnedQty" < 0
                          OR "executedQty" < 0
                          OR "executedQty" > "orderQty"
                          OR "shippedQty" > "executedQty"
                          OR "returnedQty" > "shippedQty"
                          OR "netDeliveredQty" < 0
                        THEN 'INCONSISTENT' ELSE 'CONSISTENT' END AS "consistencyStatus"
            FROM tracking_metrics
        )
        SELECT tracking_status.*,
               CASE WHEN "consistencyStatus" = 'INCONSISTENT' THEN 'INCONSISTENT'
                    WHEN "executedQty" = 0 THEN 'NOT_EXECUTED'
                    WHEN "executedQty" >= "orderQty" THEN 'EXECUTED'
                    ELSE 'PARTIALLY_EXECUTED' END AS "executionStatus",
               CASE WHEN "consistencyStatus" = 'INCONSISTENT' THEN 'INCONSISTENT'
                    WHEN "shippedQty" = 0 THEN 'NOT_SHIPPED'
                    WHEN "shippedQty" >= "orderQty" THEN 'FULLY_SHIPPED'
                    ELSE 'PARTIALLY_SHIPPED' END AS "shipmentStatus",
               CASE WHEN "legacyShippedCounter" = "shippedQty"
                    THEN 'MATCHED' ELSE 'COUNTER_MISMATCH' END AS "counterReconciliation",
               CASE WHEN "planDeliveryDate" IS NULL THEN NULL
                    ELSE "planDeliveryDate" - (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date
               END AS "remainingDeliveryDays"
        FROM tracking_status
        """;

    @Bean
    public ReportQuerySpec salesDetailReportQuerySpec() {
        return salesFactBuilder("sales-detail", SIGNED_SALES_FACT_SQL)
            .sortField("billDate", "billDate")
            .sortField("billNo", "billNo")
            .sortField("lineNo", "lineNo")
            .sortField("customerName", "customerName")
            .sortField("productName", "productName")
            .sortField("warehouseName", "warehouseName")
            .sortField("qty", "qty")
            .sortField("amount", "amount")
            .sortField("priceTaxTotal", "priceTaxTotal")
            .sortField("currency", "currency")
            .sortField("rowKey", "rowKey")
            .defaultSort("billDate", SortDirection.DESC)
            .stableSort("billDate", SortDirection.DESC)
            .stableSort("billNo", SortDirection.ASC)
            .stableSort("lineNo", SortDirection.ASC)
            .uniqueNonNullStableSort("rowKey", SortDirection.ASC)
            .totalGroupColumns("currency")
            .totalSum("amount", "amount")
            .totalSum("taxAmount", "taxAmount")
            .totalSum("priceTaxTotal", "priceTaxTotal")
            .csvColumn("日期", "billDate", false)
            .csvColumn("单号", "billNo", true)
            .csvColumn("类型", "documentType", true)
            .csvColumn("客户编码", "customerCode", true)
            .csvColumn("客户", "customerName", true)
            .csvColumn("商品编码", "productCode", true)
            .csvColumn("商品", "productName", true)
            .csvColumn("规格", "specification", true)
            .csvColumn("仓库编码", "warehouseCode", true)
            .csvColumn("仓库", "warehouseName", true)
            .csvColumn("单位", "unit", true)
            .csvColumn("数量", "qty", false)
            .csvColumn("单价", "unitPrice", false)
            .csvColumn("金额", "amount", false)
            .csvColumn("税额", "taxAmount", false)
            .csvColumn("含税金额", "priceTaxTotal", false)
            .csvColumn("币种", "currency", true)
            .build();
    }

    @Bean
    public ReportQuerySpec salesSummaryReportQuerySpec() {
        return salesFactBuilder("sales-summary", SIGNED_SALES_FACT_SQL)
            .filter(FilterDefinition.enumEqualsDefault(
                "dimension",
                "dimension",
                PredicatePlacement.BOUND_ONLY,
                "CUSTOMER",
                "CUSTOMER",
                "PRODUCT_UNIT"
            ))
            .resultSql(SALES_SUMMARY_SQL)
            .bindResultFilter("dimension")
            .bindResultFilter("dimension")
            .sortField("customerName", "customerName")
            .sortField("productName", "productName")
            .sortField("unit", "unit")
            .sortField("currency", "currency")
            .sortField("qty", "qty")
            .sortField("amount", "amount")
            .sortField("priceTaxTotal", "priceTaxTotal")
            .sortField("rowKey", "rowKey")
            .defaultSort("rowKey", SortDirection.ASC)
            .stableSort("dimension", SortDirection.ASC)
            .stableSort("currency", SortDirection.ASC)
            .uniqueNonNullStableSort("rowKey", SortDirection.ASC)
            .sortField("dimension", "dimension")
            .totalGroupColumns("dimension", "currency")
            .totalSum("amount", "amount")
            .totalSum("taxAmount", "taxAmount")
            .totalSum("priceTaxTotal", "priceTaxTotal")
            .csvColumn("汇总维度", "dimension", true)
            .csvColumn("客户编码", "customerCode", true)
            .csvColumn("客户", "customerName", true)
            .csvColumn("商品编码", "productCode", true)
            .csvColumn("商品", "productName", true)
            .csvColumn("规格", "specification", true)
            .csvColumn("单位", "unit", true)
            .csvColumn("数量", "qty", false)
            .csvColumn("金额", "amount", false)
            .csvColumn("税额", "taxAmount", false)
            .csvColumn("含税金额", "priceTaxTotal", false)
            .csvColumn("币种", "currency", true)
            .build();
    }

    @Bean
    public ReportQuerySpec salesOrderTrackingReportQuerySpec() {
        return ReportQuerySpec.builder("sales-order-tracking", PERMISSION, SALES_ORDER_TRACKING_SQL)
            .requiredDateRange("billDate", PredicatePlacement.FACT)
            .keywordColumns(
                PredicatePlacement.FACT,
                "billNo",
                "customerCode",
                "customerName",
                "productCode",
                "productName"
            )
            .filter(FilterDefinition.equals("customerId", "customerId", ValueType.UUID, PredicatePlacement.FACT))
            .filter(FilterDefinition.equals("productId", "productId", ValueType.UUID, PredicatePlacement.FACT))
            .filter(FilterDefinition.enumEquals(
                "currency",
                "currency",
                PredicatePlacement.FACT,
                "CNY",
                "USD"
            ))
            .filter(FilterDefinition.enumEquals(
                "executionStatus",
                "executionStatus",
                PredicatePlacement.FACT,
                "NOT_EXECUTED",
                "PARTIALLY_EXECUTED",
                "EXECUTED",
                "INCONSISTENT"
            ))
            .filter(FilterDefinition.enumEquals(
                "shipmentStatus",
                "shipmentStatus",
                PredicatePlacement.FACT,
                "NOT_SHIPPED",
                "PARTIALLY_SHIPPED",
                "FULLY_SHIPPED",
                "INCONSISTENT"
            ))
            .filter(FilterDefinition.enumEquals(
                "consistencyStatus",
                "consistencyStatus",
                PredicatePlacement.FACT,
                "CONSISTENT",
                "INCONSISTENT"
            ))
            .sortField("billDate", "billDate")
            .sortField("billNo", "billNo")
            .sortField("lineNo", "lineNo")
            .sortField("customerName", "customerName")
            .sortField("productName", "productName")
            .sortField("planDeliveryDate", "planDeliveryDate")
            .sortField("orderQty", "orderQty")
            .sortField("executedQty", "executedQty")
            .sortField("shippedQty", "shippedQty")
            .sortField("returnedQty", "returnedQty")
            .sortField("remainingDeliveryDays", "remainingDeliveryDays")
            .sortField("rowKey", "rowKey")
            .defaultSort("billDate", SortDirection.DESC)
            .stableSort("billDate", SortDirection.DESC)
            .stableSort("billNo", SortDirection.ASC)
            .stableSort("lineNo", SortDirection.ASC)
            .uniqueNonNullStableSort("rowKey", SortDirection.ASC)
            .csvColumn("订单日期", "billDate", false)
            .csvColumn("订单号", "billNo", true)
            .csvColumn("行号", "lineNo", false)
            .csvColumn("客户编码", "customerCode", true)
            .csvColumn("客户", "customerName", true)
            .csvColumn("商品编码", "productCode", true)
            .csvColumn("商品", "productName", true)
            .csvColumn("规格", "specification", true)
            .csvColumn("单位", "unit", true)
            .csvColumn("币种", "currency", true)
            .csvColumn("订单数量", "orderQty", false)
            .csvColumn("发货通知数量(N)", "noticeQty", false)
            .csvColumn("直接出库数量(D)", "directOutQty", false)
            .csvColumn("已执行数量(N+D)", "executedQty", false)
            .csvColumn("已出库数量(O)", "shippedQty", false)
            .csvColumn("已退货数量(R)", "returnedQty", false)
            .csvColumn("净交付数量(O-R)", "netDeliveredQty", false)
            .csvColumn("未执行数量", "unexecutedQty", false)
            .csvColumn("已执行未出库数量", "executedUnshippedQty", false)
            .csvColumn("预计交期", "planDeliveryDate", false)
            .csvColumn("剩余发货天数", "remainingDeliveryDays", false)
            .csvColumn("执行状态", "executionStatus", true)
            .csvColumn("出库状态", "shipmentStatus", true)
            .csvColumn("一致性状态", "consistencyStatus", true)
            .csvColumn("冗余计数对账", "counterReconciliation", true)
            .build();
    }

    private ReportQuerySpec.Builder salesFactBuilder(String reportKey, String sourceSql) {
        return ReportQuerySpec.builder(reportKey, PERMISSION, sourceSql)
            .requiredDateRange("billDate", PredicatePlacement.FACT)
            .keywordColumns(
                PredicatePlacement.FACT,
                "billNo",
                "customerCode",
                "customerName",
                "productCode",
                "productName",
                "warehouseCode",
                "warehouseName"
            )
            .filter(FilterDefinition.contains("billNo", "billNo", PredicatePlacement.FACT))
            .filter(FilterDefinition.equals("customerId", "customerId", ValueType.UUID, PredicatePlacement.FACT))
            .filter(FilterDefinition.equals("productId", "productId", ValueType.UUID, PredicatePlacement.FACT))
            .filter(FilterDefinition.equals("warehouseId", "warehouseId", ValueType.UUID, PredicatePlacement.FACT))
            .filter(FilterDefinition.enumEquals(
                "documentType",
                "documentType",
                PredicatePlacement.FACT,
                "SALES_OUT",
                "SALES_RETURN"
            ))
            .filter(FilterDefinition.enumEquals(
                "currency",
                "currency",
                PredicatePlacement.FACT,
                "CNY",
                "USD"
            ));
    }
}
