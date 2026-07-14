package com.jdy.erp.inventory.application;

import com.jdy.erp.reports.application.ReportQuerySpec;
import com.jdy.erp.reports.application.ReportQuerySpec.FilterDefinition;
import com.jdy.erp.reports.application.ReportQuerySpec.PredicatePlacement;
import com.jdy.erp.reports.application.ReportQuerySpec.SortDirection;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * F042 商品收发明细的库存域查询定义。
 *
 * <p>正式事实只来自 {@code inv_stock_txn}。TEST 与零数量变动在任何
 * 业务日期降级计算之前剔除；账套数据范围由 report foundation 以
 * {@code inventory} 命名空间绑定，客户端不能覆盖。</p>
 */
@Configuration(proxyBeanMethods = false)
public class InventoryMovementReportQuerySpec {
    static final String REPORT_KEY = "inventory-movement-detail";

    @Bean
    public ReportQuerySpec inventoryMovementDetailReportQuerySpec() {
        return ReportQuerySpec.builder(
            REPORT_KEY,
            "inventory.stock.view",
            """
                SELECT txn.id AS "id",
                       CASE
                           WHEN txn.trace_quality = 'LEGACY' AND txn.source_bill_date IS NULL
                               THEN (txn.occurred_at AT TIME ZONE 'Asia/Shanghai')::date
                           ELSE txn.source_bill_date
                       END AS "businessDate",
                       CASE
                           WHEN txn.trace_quality = 'LEGACY' AND txn.source_bill_date IS NULL
                               THEN 'POSTING_FALLBACK'
                           ELSE 'BUSINESS_DATE'
                       END AS "dateBasis",
                       CASE
                           WHEN txn.trace_quality = 'LEGACY' AND txn.source_bill_date IS NULL
                               THEN '历史记账日期（业务日期缺失）'
                           ELSE '源单业务日期'
                       END AS "dateBasisLabel",
                       txn.occurred_at AS "occurredAt",
                       product.id AS "productId",
                       product.code AS "productCode",
                       product.name AS "productName",
                       COALESCE(product.spec, '') AS "productSpec",
                       product.unit AS "unit",
                       concat_ws(' ', product.code, product.name, product.spec) AS "productSearch",
                       warehouse.id AS "warehouseId",
                       warehouse.code AS "warehouseCode",
                       warehouse.name AS "warehouseName",
                       concat_ws(' ', warehouse.code, warehouse.name) AS "warehouseSearch",
                       txn.txn_type AS "txnType",
                       txn.normalized_source_type AS "sourceBillType",
                       CASE txn.normalized_source_type
                           WHEN 'SALES_OUT' THEN '销售出库单'
                           WHEN 'SALES_RETURN' THEN '销售退货单'
                           WHEN 'PURCHASE_IN' THEN '采购入库单'
                           WHEN 'PURCHASE_RETURN' THEN '采购退货单'
                           WHEN 'PRODUCTION_MATERIAL_ISSUE' THEN '生产领料单'
                           WHEN 'PRODUCTION_ISSUE' THEN '生产领料单（历史）'
                           WHEN 'PRODUCTION_COMPLETE' THEN '产品入库单'
                           WHEN 'PRODUCTION_COMPLETION' THEN '产品入库单'
                           WHEN 'OTHER_STOCK_IN' THEN '其他入库单'
                           WHEN 'OTHER_STOCK_OUT' THEN '其他出库单'
                           WHEN 'STOCK_TRANSFER' THEN '调拨单'
                           WHEN 'STOCK_COUNT_GAIN' THEN '盘盈单'
                           WHEN 'STOCK_COUNT_LOSS' THEN '盘亏单'
                           WHEN 'OPENING_STOCK' THEN '库存期初'
                           WHEN 'OUTSOURCING_MATERIAL_ISSUE' THEN '委外领料单'
                           WHEN 'OUTSOURCING_ISSUE' THEN '委外领料单（历史）'
                           WHEN 'OUTSOURCING_RECEIPT' THEN '委外入库单'
                           WHEN 'OUTSOURCING_RETURN' THEN '委外退料单'
                           WHEN 'OUTSOURCING_SCRAP' THEN '委外报废单'
                           ELSE txn.normalized_source_type
                       END AS "sourceTypeLabel",
                       COALESCE(txn.source_bill_no, '') AS "sourceBillNo",
                       txn.posting_action AS "postingAction",
                       txn.trace_quality AS "traceQuality",
                       CASE txn.trace_quality
                           WHEN 'EXACT' THEN '精确到源单行'
                           WHEN 'CONTROLLED' THEN '受控来源（非业务单据）'
                           WHEN 'HEADER_ONLY' THEN '仅源单头（不可精确定位到行）'
                           WHEN 'LEGACY' THEN '历史流水（源单不可定位）'
                           ELSE txn.trace_quality
                       END AS "traceQualityLabel",
                       CASE WHEN txn.qty_delta > 0 THEN txn.qty_delta ELSE 0::numeric END AS "inboundQty",
                       CASE WHEN txn.qty_delta < 0 THEN abs(txn.qty_delta) ELSE 0::numeric END AS "outboundQty",
                       txn.qty_on_hand_after AS "qtyOnHandAfter",
                       CASE
                           WHEN txn.qty_on_hand_after IS NULL
                               THEN '历史结存不可精确还原'
                           ELSE '事实过账后结存'
                       END AS "balanceBasisLabel",
                       CASE
                           WHEN txn.trace_quality = 'EXACT'
                               THEN CASE txn.normalized_source_type
                                   WHEN 'SALES_OUT' THEN CASE WHEN sales_out_header.id IS NOT NULL AND sales_out_line.id IS NOT NULL THEN 'salesOut' END
                                   WHEN 'SALES_RETURN' THEN CASE WHEN sales_return_header.id IS NOT NULL AND sales_return_line.id IS NOT NULL THEN 'salesReturn' END
                                   WHEN 'PURCHASE_IN' THEN CASE WHEN purchase_in_header.id IS NOT NULL AND purchase_in_line.id IS NOT NULL THEN 'purchaseIn' END
                                   WHEN 'PURCHASE_RETURN' THEN CASE WHEN purchase_return_header.id IS NOT NULL AND purchase_return_line.id IS NOT NULL THEN 'purchaseReturn' END
                                   WHEN 'PRODUCTION_MATERIAL_ISSUE' THEN CASE WHEN material_issue_header.id IS NOT NULL AND material_issue_line.id IS NOT NULL THEN 'materialIssue' END
                                   WHEN 'PRODUCTION_COMPLETION' THEN CASE WHEN completion_header.id IS NOT NULL AND completion_line.id IS NOT NULL THEN 'productIn' END
                                   WHEN 'OTHER_STOCK_IN' THEN CASE WHEN other_in_header.id IS NOT NULL AND other_in_line.id IS NOT NULL THEN 'otherStockIn' END
                                   WHEN 'OTHER_STOCK_OUT' THEN CASE WHEN other_out_header.id IS NOT NULL AND other_out_line.id IS NOT NULL THEN 'otherStockOut' END
                                   WHEN 'STOCK_TRANSFER' THEN CASE WHEN transfer_header.id IS NOT NULL AND transfer_line.id IS NOT NULL THEN 'stockTransfer' END
                                   WHEN 'STOCK_COUNT_GAIN' THEN CASE WHEN count_gain_header.id IS NOT NULL AND count_gain_line.id IS NOT NULL THEN 'stockCountGain' END
                                   WHEN 'STOCK_COUNT_LOSS' THEN CASE WHEN count_loss_header.id IS NOT NULL AND count_loss_line.id IS NOT NULL THEN 'stockCountLoss' END
                                   ELSE NULL
                               END
                           ELSE NULL
                       END AS "sourceTarget",
                       CASE
                           WHEN txn.trace_quality = 'EXACT'
                               THEN CASE txn.normalized_source_type
                                   WHEN 'SALES_OUT' THEN sales_out_line.line_no
                                   WHEN 'SALES_RETURN' THEN sales_return_line.line_no
                                   WHEN 'PURCHASE_IN' THEN purchase_in_line.line_no
                                   WHEN 'PURCHASE_RETURN' THEN purchase_return_line.line_no
                                   WHEN 'PRODUCTION_MATERIAL_ISSUE' THEN material_issue_line.line_no
                                   WHEN 'PRODUCTION_COMPLETION' THEN completion_line.line_no
                                   WHEN 'OTHER_STOCK_IN' THEN other_in_line.line_no
                                   WHEN 'OTHER_STOCK_OUT' THEN other_out_line.line_no
                                   WHEN 'STOCK_TRANSFER' THEN transfer_line.line_no
                                   WHEN 'STOCK_COUNT_GAIN' THEN count_gain_line.line_no
                                   WHEN 'STOCK_COUNT_LOSS' THEN count_loss_line.line_no
                                   ELSE NULL
                               END
                           ELSE NULL
                       END AS "sourceLineNo"
                FROM (
                    SELECT formal_txn.*,
                           split_part(formal_txn.source_bill_type, ':', 1) AS normalized_source_type
                    FROM inv_stock_txn formal_txn
                    WHERE formal_txn.account_set_id = ?::uuid
                      AND formal_txn.trace_quality IN ('EXACT', 'CONTROLLED', 'HEADER_ONLY', 'LEGACY')
                      AND formal_txn.qty_delta <> 0
                      AND (formal_txn.source_bill_date IS NOT NULL OR formal_txn.trace_quality = 'LEGACY')
                ) txn
                JOIN md_product product ON product.id = txn.product_id
                JOIN md_warehouse warehouse ON warehouse.id = txn.warehouse_id
                LEFT JOIN sales_out sales_out_header
                  ON txn.normalized_source_type = 'SALES_OUT'
                 AND sales_out_header.id = txn.source_bill_id
                 AND sales_out_header.bill_no = txn.source_bill_no
                LEFT JOIN sales_out_line sales_out_line
                  ON sales_out_line.id = txn.source_bill_line_id
                 AND sales_out_line.bill_id = sales_out_header.id
                LEFT JOIN sales_return sales_return_header
                  ON txn.normalized_source_type = 'SALES_RETURN'
                 AND sales_return_header.id = txn.source_bill_id
                 AND sales_return_header.bill_no = txn.source_bill_no
                LEFT JOIN sales_return_line sales_return_line
                  ON sales_return_line.id = txn.source_bill_line_id
                 AND sales_return_line.bill_id = sales_return_header.id
                LEFT JOIN purchase_in purchase_in_header
                  ON txn.normalized_source_type = 'PURCHASE_IN'
                 AND purchase_in_header.id = txn.source_bill_id
                 AND purchase_in_header.bill_no = txn.source_bill_no
                LEFT JOIN purchase_in_line purchase_in_line
                  ON purchase_in_line.id = txn.source_bill_line_id
                 AND purchase_in_line.bill_id = purchase_in_header.id
                LEFT JOIN purchase_return purchase_return_header
                  ON txn.normalized_source_type = 'PURCHASE_RETURN'
                 AND purchase_return_header.id = txn.source_bill_id
                 AND purchase_return_header.bill_no = txn.source_bill_no
                LEFT JOIN purchase_return_line purchase_return_line
                  ON purchase_return_line.id = txn.source_bill_line_id
                 AND purchase_return_line.bill_id = purchase_return_header.id
                LEFT JOIN production_material_issue material_issue_header
                  ON txn.normalized_source_type = 'PRODUCTION_MATERIAL_ISSUE'
                 AND material_issue_header.id = txn.source_bill_id
                 AND material_issue_header.bill_no = txn.source_bill_no
                LEFT JOIN production_material_issue_line material_issue_line
                  ON material_issue_line.id = txn.source_bill_line_id
                 AND material_issue_line.issue_id = material_issue_header.id
                LEFT JOIN production_completion completion_header
                  ON txn.normalized_source_type = 'PRODUCTION_COMPLETION'
                 AND completion_header.id = txn.source_bill_id
                 AND completion_header.bill_no = txn.source_bill_no
                LEFT JOIN production_completion_line completion_line
                  ON completion_line.id = txn.source_bill_line_id
                 AND completion_line.completion_id = completion_header.id
                LEFT JOIN other_stock_in other_in_header
                  ON txn.normalized_source_type = 'OTHER_STOCK_IN'
                 AND other_in_header.id = txn.source_bill_id
                 AND other_in_header.bill_no = txn.source_bill_no
                LEFT JOIN other_stock_in_line other_in_line
                  ON other_in_line.id = txn.source_bill_line_id
                 AND other_in_line.bill_id = other_in_header.id
                LEFT JOIN other_stock_out other_out_header
                  ON txn.normalized_source_type = 'OTHER_STOCK_OUT'
                 AND other_out_header.id = txn.source_bill_id
                 AND other_out_header.bill_no = txn.source_bill_no
                LEFT JOIN other_stock_out_line other_out_line
                  ON other_out_line.id = txn.source_bill_line_id
                 AND other_out_line.bill_id = other_out_header.id
                LEFT JOIN stock_transfer transfer_header
                  ON txn.normalized_source_type = 'STOCK_TRANSFER'
                 AND transfer_header.id = txn.source_bill_id
                 AND transfer_header.bill_no = txn.source_bill_no
                LEFT JOIN stock_transfer_line transfer_line
                  ON transfer_line.id = txn.source_bill_line_id
                 AND transfer_line.bill_id = transfer_header.id
                LEFT JOIN stock_count_gain count_gain_header
                  ON txn.normalized_source_type = 'STOCK_COUNT_GAIN'
                 AND count_gain_header.id = txn.source_bill_id
                 AND count_gain_header.bill_no = txn.source_bill_no
                LEFT JOIN stock_count_gain_line count_gain_line
                  ON count_gain_line.id = txn.source_bill_line_id
                 AND count_gain_line.bill_id = count_gain_header.id
                LEFT JOIN stock_count_loss count_loss_header
                  ON txn.normalized_source_type = 'STOCK_COUNT_LOSS'
                 AND count_loss_header.id = txn.source_bill_id
                 AND count_loss_header.bill_no = txn.source_bill_no
                LEFT JOIN stock_count_loss_line count_loss_line
                  ON count_loss_line.id = txn.source_bill_line_id
                 AND count_loss_line.bill_id = count_loss_header.id
                """
        )
            .bindSourceDataScope("inventory")
            .resultSql("""
                SELECT "id", "businessDate", "dateBasis", "dateBasisLabel", "occurredAt",
                       "productId", "productCode", "productName", "productSpec", "unit",
                       "warehouseId", "warehouseCode", "warehouseName", "txnType",
                       "sourceBillType", "sourceTypeLabel", "sourceBillNo", "postingAction",
                       "traceQuality", "traceQualityLabel", "inboundQty", "outboundQty", "qtyOnHandAfter", "balanceBasisLabel",
                       "sourceTarget", "sourceLineNo"
                FROM report_fact
                """)
            .requiredDateRange("businessDate", PredicatePlacement.FACT)
            .keywordColumns(
                PredicatePlacement.FACT,
                "sourceBillType",
                "sourceTypeLabel",
                "sourceBillNo",
                "productCode",
                "productName",
                "productSpec",
                "warehouseCode",
                "warehouseName"
            )
            .filter(FilterDefinition.contains(
                "sourceType",
                "sourceBillType",
                PredicatePlacement.FACT
            ))
            .filter(FilterDefinition.contains(
                "sourceBillNo",
                "sourceBillNo",
                PredicatePlacement.FACT
            ))
            .filter(FilterDefinition.contains(
                "product",
                "productSearch",
                PredicatePlacement.FACT
            ))
            .filter(FilterDefinition.contains(
                "warehouse",
                "warehouseSearch",
                PredicatePlacement.FACT
            ))
            .sortField("businessDate", "businessDate")
            .sortField("sourceBillNo", "sourceBillNo")
            .sortField("productCode", "productCode")
            .sortField("warehouseCode", "warehouseCode")
            .sortField("occurredAt", "occurredAt")
            .sortField("id", "id")
            .defaultSort("businessDate", SortDirection.DESC)
            .stableSort("businessDate", SortDirection.DESC)
            .stableSort("sourceBillNo", SortDirection.ASC)
            .stableSort("occurredAt", SortDirection.DESC)
            .uniqueNonNullStableSort("id", SortDirection.DESC)
            .totalGroupColumns("productId", "productCode", "productName", "unit")
            .totalSum("inboundQty", "inboundQty")
            .totalSum("outboundQty", "outboundQty")
            .csvColumn("业务日期", "businessDate", true)
            .csvColumn("日期依据", "dateBasis", true)
            .csvColumn("日期说明", "dateBasisLabel", false)
            .csvColumn("商品编码", "productCode", true)
            .csvColumn("商品名称", "productName", false)
            .csvColumn("规格型号", "productSpec", false)
            .csvColumn("单位", "unit", true)
            .csvColumn("仓库编码", "warehouseCode", true)
            .csvColumn("仓库名称", "warehouseName", false)
            .csvColumn("入库数量", "inboundQty", false)
            .csvColumn("出库数量", "outboundQty", false)
            .csvColumn("结存数量", "qtyOnHandAfter", false)
            .csvColumn("结存说明", "balanceBasisLabel", false)
            .csvColumn("来源类型", "sourceTypeLabel", false)
            .csvColumn("来源单号", "sourceBillNo", true)
            .csvColumn("过账动作", "postingAction", true)
            .csvColumn("追溯状态", "traceQuality", true)
            .csvColumn("来源定位说明", "traceQualityLabel", false)
            .build();
    }
}
