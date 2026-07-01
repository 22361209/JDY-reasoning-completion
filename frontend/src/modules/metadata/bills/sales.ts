import type { BillDefinition } from "../types";
import {
  amountListColumns,
  commonDocumentHeaderFields,
  customerListColumns,
  customerParty,
  identityListColumns,
  priceTaxTotalListColumn,
  quoteHeaderFields,
  salesDetailBaseColumns,
  salesEntryColumns,
  salesOrderDetailColumns,
  salesQuoteDetailColumns,
  salesQuoteEntryColumns,
  sourceDetailColumns,
  sourceEntryColumns
} from "../fragments";

const commonStatusRules = [
  {
    status: "DRAFT",
    editable: true,
    allowedActions: ["create", "save", "audit", "void", "delete", "export", "print"] as const
  },
  {
    status: "AUDITED",
    editable: false,
    allowedActions: ["create", "reverse", "void", "export", "print"] as const
  },
  {
    status: "VOIDED",
    editable: false,
    allowedActions: ["create", "export", "print"] as const
  }
];

export const salesQuoteBillDefinition: BillDefinition = {
  billType: "salesQuote",
  listKey: "sales-quote-form-list",
  title: "销售报价单",
  subtitle: "销售报价单保存客户报价，审核且有效期内可作为销售订单选源单依据。",
  module: "sales",
  keywordPlaceholder: "单据编号、客户、物料",
  statuses: ["草稿", "已审核", "已反审核", "已作废"],
  party: customerParty,
  sourcePolicy: "none",
  headerFields: quoteHeaderFields,
  entryColumns: salesQuoteEntryColumns,
  listViews: {
    header: [
      identityListColumns[0],
      ...customerListColumns,
      identityListColumns[1],
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "validUntil", title: "报价有效期", width: 130, visible: true },
      { field: "validStatus", title: "有效状态", width: 110, visible: true },
      { field: "amount", title: "报价金额", width: 120, align: "right", visible: true },
      priceTaxTotalListColumn,
      { field: "remark", title: "整单备注", width: 180, visible: true },
      { field: "owner", title: "经办人", width: 120, visible: true }
    ],
    detail: salesQuoteDetailColumns
  },
  toolbarActions: [
    { key: "create", label: "新增" },
    { key: "save", label: "保存" },
    { key: "audit", label: "审核", permission: "sales.order.audit" },
    { key: "reverse", label: "反审核", danger: true, permission: "sales.order.audit" },
    { key: "void", label: "作废", danger: true, permission: "sales.order.audit" },
    { key: "toggleValid", label: "设为有效/失效", permission: "sales.order.audit", testId: "sales-quote-toggle-valid" },
    { key: "delete", label: "删除", danger: true },
    { key: "export", label: "引出" },
    { key: "print", label: "打印" }
  ],
  statusRules: commonStatusRules.map((rule) => ({ ...rule, allowedActions: [...rule.allowedActions] })),
  layoutHints: { density: "compact", rowHeight: 32, headerColumns: 4, frozenLeftColumns: 1 }
};

export const salesOrderBillDefinition: BillDefinition = {
  billType: "salesOrder",
  listKey: "sales-order-form-list",
  title: "销售订单",
  subtitle: "销售订单列表承载查询、批量动作、列设置、页签锁定和分页。",
  module: "sales",
  keywordPlaceholder: "单据编号、客户、物料",
  statuses: ["草稿", "已审核", "已反审核", "已作废"],
  party: customerParty,
  sourcePolicy: "salesQuote",
  headerFields: [...customerListColumns.map((column) => ({
    key: column.field === "customer" ? "partyName" : "partyCode",
    label: column.title,
    renderer: column.field === "customer" ? "text" as const : "master" as const,
    readonly: column.field === "customer"
  })), ...commonDocumentHeaderFields],
  entryColumns: [...salesEntryColumns, ...sourceEntryColumns],
  listViews: {
    header: [
      identityListColumns[0],
      ...customerListColumns,
      identityListColumns[1],
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "outStatus", title: "出库状态", width: 110, visible: true },
      { field: "closeStatusLabel", title: "关闭状态", width: 110, visible: true },
      { field: "frozenStatusLabel", title: "冻结状态", width: 110, visible: true },
      { field: "qty", title: "数量", width: 110, align: "right", visible: true },
      { field: "shippedQty", title: "已出库数量", width: 120, align: "right", visible: true },
      { field: "remainingQty", title: "未出库数量", width: 120, align: "right", visible: true },
      ...amountListColumns,
      priceTaxTotalListColumn,
      { field: "remark", title: "整单备注", width: 180, visible: true },
      { field: "owner", title: "经办人", width: 120, visible: true }
    ],
    detail: [
      ...salesOrderDetailColumns.slice(0, 8),
      { field: "closeStatusLabel", title: "关闭状态", width: 110, visible: true },
      { field: "frozenStatusLabel", title: "冻结状态", width: 110, visible: true },
      ...salesOrderDetailColumns.slice(8),
      ...sourceDetailColumns
    ]
  },
  toolbarActions: [
    { key: "create", label: "新增" },
    { key: "save", label: "保存" },
    { key: "audit", label: "审核", permission: "sales.order.audit" },
    { key: "reverse", label: "反审核", danger: true, permission: "sales.order.audit" },
    { key: "void", label: "作废", danger: true, permission: "sales.order.audit" },
    { key: "close", label: "关闭", danger: true, permission: "sales.order.audit" },
    { key: "unclose", label: "反关闭", permission: "sales.order.audit" },
    { key: "freeze", label: "冻结", danger: true, permission: "sales.order.audit" },
    { key: "unfreeze", label: "解冻", permission: "sales.order.audit" },
    { key: "sourceSelect", label: "选源单", sourcePolicy: "salesQuote", permission: "sales.order.audit", testId: "sales-order-open-source-selector" },
    { key: "pushDown", label: "下推发货通知", sourcePolicy: "salesOrder", testId: "push-delivery-notice-from-order-detail" },
    { key: "delete", label: "删除", danger: true },
    { key: "export", label: "引出" },
    { key: "print", label: "打印" }
  ],
  statusRules: commonStatusRules.map((rule) => ({ ...rule, allowedActions: [...rule.allowedActions] })),
  layoutHints: { density: "compact", rowHeight: 32, headerColumns: 4, frozenLeftColumns: 1 }
};

export const salesBillDefinitions = [
  salesQuoteBillDefinition,
  salesOrderBillDefinition
];
