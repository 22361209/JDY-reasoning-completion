import type { ReportDefinition, ReportSourceDrillDefinition } from "./reportTypes";

const currencies = [
  { value: "CNY", label: "CNY" },
  { value: "USD", label: "USD" }
];

const commonFilters: ReportDefinition["filters"] = [
  { parameter: "billNo", label: "单号", placeholder: "输入完整或部分单号" },
  { parameter: "customerId", label: "客户", placeholder: "客户 ID" },
  { parameter: "productId", label: "商品", placeholder: "商品 ID" },
  { parameter: "warehouseId", label: "仓库", placeholder: "仓库 ID" },
  { parameter: "currency", label: "币种", kind: "select", options: currencies }
];

const salesDetailDrill: ReportSourceDrillDefinition = {
  targetField: "sourceTarget",
  billNoField: "sourceBillNo",
  lineNoField: "lineNo",
  targets: ["salesOut", "salesReturn"],
  unsupportedTargetMessage: "来源暂不支持钻取"
};

const salesOrderDrill: ReportSourceDrillDefinition = {
  targetField: "sourceTarget",
  billNoField: "sourceBillNo",
  lineNoField: "lineNo",
  targets: ["salesOrder"],
  unsupportedTargetMessage: "来源暂不支持钻取"
};

/**
 * F029 uses the shared report definition and source-drill contracts. Decimal
 * strings and currency-separated totals come from the server; the browser
 * never aggregates values or converts between CNY and USD.
 */
export const salesReportDefinitions: readonly ReportDefinition[] = [
  {
    entryId: "sales-detail",
    reportKey: "sales-detail",
    title: "销售明细",
    module: "销售管理",
    permission: "sales.order.audit",
    description: "按日期查询已审核销售出库与退货；退货只负向一次，金额合计按币种分别展示。",
    defaultSortField: "billDate",
    defaultSortOrder: "desc",
    sourceDrill: salesDetailDrill,
    filters: [
      ...commonFilters,
      {
        parameter: "documentType",
        label: "单据类型",
        kind: "select",
        options: [
          { value: "SALES_OUT", label: "销售出库" },
          { value: "SALES_RETURN", label: "销售退货" }
        ]
      }
    ],
    totals: {
      groupKeys: ["currency"],
      valueKeys: ["amount", "taxAmount", "priceTaxTotal"]
    },
    columns: [
      { key: "billDate", title: "日期", width: 120, minWidth: 104, fixed: "left", configurable: false, sortField: "billDate", format: "date" },
      { key: "sourceBillNo", title: "单号", width: 168, minWidth: 132, fixed: "left", sortField: "billNo", format: "source-link" },
      { key: "documentType", title: "类型", width: 112, minWidth: 96 },
      { key: "customerName", title: "客户", width: 170, minWidth: 130, sortField: "customerName" },
      { key: "productCode", title: "商品编码", width: 132, minWidth: 108 },
      { key: "productName", title: "商品", width: 170, minWidth: 130, sortField: "productName" },
      { key: "specification", title: "规格", width: 140, minWidth: 108 },
      { key: "warehouseName", title: "仓库", width: 150, minWidth: 112, sortField: "warehouseName" },
      { key: "unit", title: "单位", width: 76, minWidth: 64, align: "center" },
      { key: "qty", title: "数量", width: 110, minWidth: 92, align: "right", sortField: "qty", format: "quantity" },
      { key: "unitPrice", title: "单价", width: 116, minWidth: 96, align: "right", format: "decimal" },
      { key: "amount", title: "金额", width: 122, minWidth: 100, align: "right", sortField: "amount", format: "decimal" },
      { key: "taxAmount", title: "税额", width: 112, minWidth: 92, align: "right", format: "decimal" },
      { key: "priceTaxTotal", title: "含税金额", width: 126, minWidth: 104, align: "right", sortField: "priceTaxTotal", format: "decimal" },
      { key: "currency", title: "币种", width: 82, minWidth: 70, align: "center", sortField: "currency" }
    ]
  },
  {
    entryId: "sales-summary",
    reportKey: "sales-summary",
    title: "销售汇总",
    module: "销售管理",
    permission: "sales.order.audit",
    description: "按客户或商品与单位汇总销售事实；数量不跨单位，金额不跨币种。",
    defaultSortField: "rowKey",
    defaultSortOrder: "asc",
    filters: [
      ...commonFilters,
      {
        parameter: "documentType",
        label: "单据类型",
        kind: "select",
        options: [
          { value: "SALES_OUT", label: "销售出库" },
          { value: "SALES_RETURN", label: "销售退货" }
        ]
      },
      {
        parameter: "dimension",
        label: "汇总维度",
        kind: "select",
        defaultValue: "CUSTOMER",
        options: [
          { value: "CUSTOMER", label: "客户" },
          { value: "PRODUCT_UNIT", label: "商品 + 单位" }
        ]
      }
    ],
    totals: {
      groupKeys: ["dimension", "currency"],
      valueKeys: ["amount", "taxAmount", "priceTaxTotal"]
    },
    columns: [
      { key: "dimension", title: "汇总维度", width: 112, minWidth: 96, fixed: "left", configurable: false, sortField: "dimension" },
      { key: "customerName", title: "客户", width: 180, minWidth: 132, sortField: "customerName" },
      { key: "productCode", title: "商品编码", width: 132, minWidth: 108 },
      { key: "productName", title: "商品", width: 180, minWidth: 132, sortField: "productName" },
      { key: "specification", title: "规格", width: 150, minWidth: 112 },
      { key: "unit", title: "单位", width: 82, minWidth: 68, align: "center", sortField: "unit" },
      { key: "qty", title: "数量", width: 112, minWidth: 94, align: "right", sortField: "qty", format: "quantity" },
      { key: "amount", title: "金额", width: 124, minWidth: 100, align: "right", sortField: "amount", format: "decimal" },
      { key: "taxAmount", title: "税额", width: 112, minWidth: 92, align: "right", format: "decimal" },
      { key: "priceTaxTotal", title: "含税金额", width: 128, minWidth: 104, align: "right", sortField: "priceTaxTotal", format: "decimal" },
      { key: "currency", title: "币种", width: 82, minWidth: 70, align: "center", sortField: "currency" }
    ]
  },
  {
    entryId: "sales-order-tracking",
    reportKey: "sales-order-tracking",
    title: "销售订单跟踪",
    module: "销售管理",
    permission: "sales.order.audit",
    description: "按订单行核对通知、直接出库、出库与退货；异常计数不会参与业务公式。",
    defaultSortField: "billDate",
    defaultSortOrder: "desc",
    sourceDrill: salesOrderDrill,
    filters: [
      { parameter: "customerId", label: "客户", placeholder: "客户 ID" },
      { parameter: "productId", label: "商品", placeholder: "商品 ID" },
      { parameter: "currency", label: "币种", kind: "select", options: currencies },
      {
        parameter: "executionStatus",
        label: "执行状态",
        kind: "select",
        options: [
          { value: "NOT_EXECUTED", label: "未执行" },
          { value: "PARTIALLY_EXECUTED", label: "部分执行" },
          { value: "EXECUTED", label: "已执行" },
          { value: "INCONSISTENT", label: "数据不一致" }
        ]
      },
      {
        parameter: "shipmentStatus",
        label: "出库状态",
        kind: "select",
        options: [
          { value: "NOT_SHIPPED", label: "未出库" },
          { value: "PARTIALLY_SHIPPED", label: "部分出库" },
          { value: "FULLY_SHIPPED", label: "已出库" },
          { value: "INCONSISTENT", label: "数据不一致" }
        ]
      },
      {
        parameter: "consistencyStatus",
        label: "一致性",
        kind: "select",
        options: [
          { value: "CONSISTENT", label: "一致" },
          { value: "INCONSISTENT", label: "数据不一致" }
        ]
      }
    ],
    totals: { groupKeys: [], valueKeys: [] },
    columns: [
      { key: "billDate", title: "订单日期", width: 120, minWidth: 104, fixed: "left", configurable: false, sortField: "billDate", format: "date" },
      { key: "sourceBillNo", title: "订单号", width: 168, minWidth: 132, fixed: "left", sortField: "billNo", format: "source-link" },
      { key: "lineNo", title: "行号", width: 72, minWidth: 64, align: "right", sortField: "lineNo", format: "integer" },
      { key: "customerName", title: "客户", width: 170, minWidth: 130, sortField: "customerName" },
      { key: "productCode", title: "商品编码", width: 132, minWidth: 108 },
      { key: "productName", title: "商品", width: 170, minWidth: 130, sortField: "productName" },
      { key: "specification", title: "规格", width: 140, minWidth: 108 },
      { key: "unit", title: "单位", width: 76, minWidth: 64, align: "center" },
      { key: "orderQty", title: "订单数量", width: 112, minWidth: 94, align: "right", sortField: "orderQty", format: "quantity" },
      { key: "noticeQty", title: "通知数量(N)", width: 124, minWidth: 104, align: "right", format: "quantity" },
      { key: "directOutQty", title: "直接出库(D)", width: 120, minWidth: 102, align: "right", format: "quantity" },
      { key: "executedQty", title: "已执行(N+D)", width: 126, minWidth: 106, align: "right", sortField: "executedQty", format: "quantity" },
      { key: "shippedQty", title: "已出库(O)", width: 112, minWidth: 94, align: "right", sortField: "shippedQty", format: "quantity" },
      { key: "returnedQty", title: "已退货(R)", width: 112, minWidth: 94, align: "right", sortField: "returnedQty", format: "quantity" },
      { key: "netDeliveredQty", title: "净交付(O-R)", width: 122, minWidth: 102, align: "right", format: "quantity" },
      { key: "unexecutedQty", title: "未执行", width: 108, minWidth: 90, align: "right", format: "quantity" },
      { key: "executedUnshippedQty", title: "已执行未出库", width: 138, minWidth: 112, align: "right", format: "quantity" },
      { key: "planDeliveryDate", title: "预计交期", width: 120, minWidth: 104, sortField: "planDeliveryDate", format: "date" },
      { key: "remainingDeliveryDays", title: "剩余发货天数", width: 132, minWidth: 108, align: "right", sortField: "remainingDeliveryDays", format: "integer" },
      { key: "executionStatus", title: "执行状态", width: 112, minWidth: 94 },
      { key: "shipmentStatus", title: "出库状态", width: 112, minWidth: 94 },
      { key: "consistencyStatus", title: "一致性状态", width: 118, minWidth: 98 },
      { key: "counterReconciliation", title: "冗余计数对账", width: 132, minWidth: 108 },
      { key: "currency", title: "币种", width: 82, minWidth: 70, align: "center" }
    ]
  }
];
