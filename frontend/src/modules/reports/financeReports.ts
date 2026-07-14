import type { ReportDefinition, ReportFilterDefinition } from "./reportTypes";

const currencyFilter: ReportFilterDefinition = {
  parameter: "currency",
  label: "币种",
  kind: "select",
  options: [
    { value: "CNY", label: "CNY" },
    { value: "USD", label: "USD" }
  ]
};

const receivableEventFilter: ReportFilterDefinition = {
  parameter: "eventType",
  label: "事件类型",
  kind: "select",
  options: [
    { value: "AR_FACT", label: "应收发生" },
    { value: "RECEIPT_ALLOCATION", label: "收款核销" },
    { value: "RETURN_ALLOCATION", label: "退货冲减" }
  ]
};

const payableEventFilter: ReportFilterDefinition = {
  parameter: "eventType",
  label: "事件类型",
  kind: "select",
  options: [
    { value: "AP_FACT", label: "应付发生" },
    { value: "PAYMENT_ALLOCATION", label: "付款核销" }
  ]
};

/**
 * F091 report definitions consumed by the shared A148 report registry.
 *
 * Amounts remain server-returned decimal strings. Totals are grouped by
 * currency so CNY and USD are always rendered as independent total rows.
 */
export const financeReportDefinitions = [
  {
    entryId: "receivable-detail",
    reportKey: "receivable-detail",
    title: "应收明细表",
    module: "应收应付",
    permission: "finance.report.view",
    description: "按事件日期查看应收发生、收款核销与退货冲减；CNY、USD 分币种独立合计。",
    defaultSortField: "businessDate",
    defaultSortOrder: "desc",
    filters: [
      { parameter: "partyId", label: "客户 ID", placeholder: "输入客户 UUID" },
      currencyFilter,
      receivableEventFilter
    ],
    totals: {
      groupKeys: ["currency"],
      valueKeys: ["occurrenceAmount", "settledAmount", "returnOffsetAmount", "pendingRefundAmount", "balanceDelta"]
    },
    columns: [
      { key: "businessDate", title: "事件日期", width: 116, minWidth: 104, fixed: "left", configurable: false, sortField: "businessDate", format: "date" },
      { key: "eventType", title: "事件类型", width: 150, minWidth: 128, sortField: "eventType" },
      { key: "billNo", title: "单号", width: 172, minWidth: 140, sortField: "billNo" },
      { key: "sourceBillNo", title: "来源单号", width: 172, minWidth: 140 },
      { key: "partyCode", title: "客户编码", width: 128, minWidth: 108, sortField: "partyCode" },
      { key: "partyName", title: "客户", width: 180, minWidth: 140 },
      { key: "currency", title: "币种", width: 76, minWidth: 68, align: "center" },
      { key: "occurrenceAmount", title: "应收发生", width: 126, minWidth: 108, align: "right" },
      { key: "settledAmount", title: "已收", width: 126, minWidth: 108, align: "right" },
      { key: "returnOffsetAmount", title: "退货冲减", width: 126, minWidth: 108, align: "right" },
      { key: "pendingRefundAmount", title: "待退款金额", width: 126, minWidth: 108, align: "right" },
      { key: "balanceDelta", title: "余额变动", width: 126, minWidth: 108, align: "right", sortField: "balanceDelta" }
    ]
  },
  {
    entryId: "receivable-summary",
    reportKey: "receivable-summary",
    title: "应收汇总表",
    module: "应收应付",
    permission: "finance.report.view",
    description: "按客户与币种重建期初、期间发生和期末余额；不同币种不折算、不跨币种合计。",
    defaultSortField: "partyCode",
    defaultSortOrder: "asc",
    filters: [
      { parameter: "partyId", label: "客户 ID", placeholder: "输入客户 UUID" },
      currencyFilter
    ],
    totals: {
      groupKeys: ["currency"],
      valueKeys: ["openingBalance", "occurrenceAmount", "settledAmount", "returnOffsetAmount", "pendingRefundAmount", "periodNetAmount", "closingBalance"]
    },
    columns: [
      { key: "partyCode", title: "客户编码", width: 128, minWidth: 108, fixed: "left", configurable: false, sortField: "partyCode" },
      { key: "partyName", title: "客户", width: 200, minWidth: 150, sortField: "partyName" },
      { key: "currency", title: "币种", width: 76, minWidth: 68, align: "center", sortField: "currency" },
      { key: "openingBalance", title: "期初余额", width: 132, minWidth: 112, align: "right" },
      { key: "occurrenceAmount", title: "本期应收发生", width: 142, minWidth: 120, align: "right" },
      { key: "settledAmount", title: "本期已收", width: 126, minWidth: 108, align: "right" },
      { key: "returnOffsetAmount", title: "本期退货冲减", width: 142, minWidth: 120, align: "right" },
      { key: "pendingRefundAmount", title: "待退款金额", width: 132, minWidth: 112, align: "right" },
      { key: "periodNetAmount", title: "期间净额", width: 132, minWidth: 112, align: "right" },
      { key: "closingBalance", title: "期末余额", width: 132, minWidth: 112, align: "right", sortField: "closingBalance" }
    ]
  },
  {
    entryId: "payable-detail",
    reportKey: "payable-detail",
    title: "应付明细表",
    module: "应收应付",
    permission: "finance.report.view",
    description: "按事件日期查看应付发生与付款核销；CNY、USD 分币种独立合计。",
    defaultSortField: "businessDate",
    defaultSortOrder: "desc",
    filters: [
      { parameter: "partyId", label: "供应商 ID", placeholder: "输入供应商 UUID" },
      currencyFilter,
      payableEventFilter
    ],
    totals: {
      groupKeys: ["currency"],
      valueKeys: ["occurrenceAmount", "settledAmount", "balanceDelta"]
    },
    columns: [
      { key: "businessDate", title: "事件日期", width: 116, minWidth: 104, fixed: "left", configurable: false, sortField: "businessDate", format: "date" },
      { key: "eventType", title: "事件类型", width: 150, minWidth: 128, sortField: "eventType" },
      { key: "billNo", title: "单号", width: 172, minWidth: 140, sortField: "billNo" },
      { key: "sourceBillNo", title: "来源单号", width: 172, minWidth: 140 },
      { key: "partyCode", title: "供应商编码", width: 128, minWidth: 108, sortField: "partyCode" },
      { key: "partyName", title: "供应商", width: 180, minWidth: 140 },
      { key: "currency", title: "币种", width: 76, minWidth: 68, align: "center" },
      { key: "occurrenceAmount", title: "应付发生", width: 126, minWidth: 108, align: "right" },
      { key: "settledAmount", title: "已付", width: 126, minWidth: 108, align: "right" },
      { key: "balanceDelta", title: "余额变动", width: 126, minWidth: 108, align: "right", sortField: "balanceDelta" }
    ]
  },
  {
    entryId: "payable-summary",
    reportKey: "payable-summary",
    title: "应付汇总表",
    module: "应收应付",
    permission: "finance.report.view",
    description: "按供应商与币种重建期初、期间发生和期末余额；不同币种不折算、不跨币种合计。",
    defaultSortField: "partyCode",
    defaultSortOrder: "asc",
    filters: [
      { parameter: "partyId", label: "供应商 ID", placeholder: "输入供应商 UUID" },
      currencyFilter
    ],
    totals: {
      groupKeys: ["currency"],
      valueKeys: ["openingBalance", "occurrenceAmount", "settledAmount", "periodNetAmount", "closingBalance"]
    },
    columns: [
      { key: "partyCode", title: "供应商编码", width: 128, minWidth: 108, fixed: "left", configurable: false, sortField: "partyCode" },
      { key: "partyName", title: "供应商", width: 200, minWidth: 150, sortField: "partyName" },
      { key: "currency", title: "币种", width: 76, minWidth: 68, align: "center", sortField: "currency" },
      { key: "openingBalance", title: "期初余额", width: 132, minWidth: 112, align: "right" },
      { key: "occurrenceAmount", title: "本期应付发生", width: 142, minWidth: 120, align: "right" },
      { key: "settledAmount", title: "本期已付", width: 126, minWidth: 108, align: "right" },
      { key: "periodNetAmount", title: "期间净额", width: 132, minWidth: 112, align: "right" },
      { key: "closingBalance", title: "期末余额", width: 132, minWidth: 112, align: "right", sortField: "closingBalance" }
    ]
  }
] as const satisfies readonly ReportDefinition[];

export type FinanceReportDefinition = (typeof financeReportDefinitions)[number];
export type FinanceReportKey = FinanceReportDefinition["reportKey"];
