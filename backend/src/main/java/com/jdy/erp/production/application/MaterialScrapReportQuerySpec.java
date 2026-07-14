package com.jdy.erp.production.application;

import com.jdy.erp.reports.application.ReportQuerySpec;
import com.jdy.erp.reports.application.ReportQuerySpec.FilterDefinition;
import com.jdy.erp.reports.application.ReportQuerySpec.PredicatePlacement;
import com.jdy.erp.reports.application.ReportQuerySpec.SortDirection;
import com.jdy.erp.reports.application.ReportQuerySpec.ValueType;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** F061 已审核材料报废数量汇总。 */
@Configuration(proxyBeanMethods = false)
public class MaterialScrapReportQuerySpec {
    static final String REPORT_KEY = "material-scrap-summary";
    static final String PERMISSION = "production.document.audit";

    @Bean
    public ReportQuerySpec materialScrapSummaryReportQuerySpec() {
        return ReportQuerySpec.builder(
            REPORT_KEY,
            PERMISSION,
            """
                SELECT scrap.bill_date AS "businessDate",
                       scrap.business_type AS "businessType",
                       scrap.bill_no AS "billNo",
                       scrap.workshop_id AS "workshopId",
                       scrap.workshop_code_snapshot AS "workshopCode",
                       scrap.workshop_name_snapshot AS "workshopName",
                       line.product_id AS "productId",
                       line.product_code_snapshot AS "productCode",
                       line.product_name_snapshot AS "productName",
                       line.product_spec_snapshot AS "productSpec",
                       line.product_unit_snapshot AS "unit",
                       COALESCE(line.scrap_reason, '') AS "scrapReason",
                       line.scrap_qty AS "scrapQty"
                FROM production_material_scrap scrap
                JOIN production_material_scrap_line line ON line.scrap_id = scrap.id
                WHERE scrap.status = 'AUDITED'
                """
        )
            .resultSql("""
                SELECT jsonb_build_array("workshopId", "productId", "unit")::text AS "rowKey",
                       MIN("businessType") AS "businessType",
                       "workshopId",
                       MIN("workshopCode") AS "workshopCode",
                       MIN("workshopName") AS "workshopName",
                       "productId",
                       MIN("productCode") AS "productCode",
                       MIN("productName") AS "productName",
                       MIN("productSpec") AS "productSpec",
                       "unit",
                       SUM("scrapQty") AS "scrapQty"
                FROM report_fact
                GROUP BY "workshopId", "productId", "unit"
                """
            )
            .requiredDateRange("businessDate", PredicatePlacement.FACT)
            .keywordColumns(
                PredicatePlacement.FACT,
                "billNo",
                "workshopCode",
                "workshopName",
                "productCode",
                "productName",
                "productSpec",
                "scrapReason"
            )
            .filter(FilterDefinition.enumEquals(
                "businessType",
                "businessType",
                PredicatePlacement.FACT,
                "PRODUCTION_SCRAP"
            ))
            .filter(FilterDefinition.equals(
                "workshopId",
                "workshopId",
                ValueType.UUID,
                PredicatePlacement.FACT
            ))
            .filter(FilterDefinition.equals(
                "productId",
                "productId",
                ValueType.UUID,
                PredicatePlacement.FACT
            ))
            .filter(FilterDefinition.contains(
                "scrapReason",
                "scrapReason",
                PredicatePlacement.FACT
            ))
            .sortField("rowKey", "rowKey")
                .sortField("workshopCode", "workshopCode")
                .sortField("workshopName", "workshopName")
                .sortField("workshopId", "workshopId")
                .sortField("productCode", "productCode")
                .sortField("productName", "productName")
                .sortField("productId", "productId")
                .sortField("unit", "unit")
            .sortField("scrapQty", "scrapQty")
            .defaultSort("workshopCode", SortDirection.ASC)
            .stableSort("workshopId", SortDirection.ASC)
            .stableSort("productId", SortDirection.ASC)
            .stableSort("unit", SortDirection.ASC)
            .uniqueNonNullStableSort("rowKey", SortDirection.ASC)
            .totalGroupColumns("unit")
            .totalSum("scrapQty", "scrapQty")
            .csvColumn("业务类型", "businessType", true)
            .csvColumn("生产车间编码", "workshopCode", true)
            .csvColumn("生产车间", "workshopName", false)
            .csvColumn("商品编码", "productCode", true)
            .csvColumn("商品名称", "productName", false)
            .csvColumn("规格型号", "productSpec", false)
            .csvColumn("单位", "unit", true)
            .csvColumn("报废数量", "scrapQty", false)
            .build();
    }
}
