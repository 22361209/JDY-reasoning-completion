import type { EntryColumnDefinition, FieldDefinition, ListColumnDefinition } from "./types";

export const customerParty = {
  type: "customer" as const,
  codeLabel: "客户编码",
  nameLabel: "客户名称"
};

export const supplierParty = {
  type: "supplier" as const,
  codeLabel: "供应商编码",
  nameLabel: "供应商名称"
};

export const customerHeaderFields: FieldDefinition[] = [
  { key: "partyCode", label: "客户编码", renderer: "master", required: true },
  { key: "partyName", label: "客户名称", renderer: "text", readonly: true }
];

export const commonDocumentHeaderFields: FieldDefinition[] = [
  { key: "billDate", label: "业务日期", renderer: "date", required: true },
  { key: "billNo", label: "单据编号", renderer: "text", readonly: true },
  { key: "department", label: "部门", renderer: "text" },
  { key: "ownerName", label: "录入人", renderer: "text", readonly: true },
  { key: "isTaxInclusive", label: "价格口径", renderer: "enum" },
  { key: "remark", label: "单据备注", renderer: "textarea", span: 4 }
];

export const quoteHeaderFields: FieldDefinition[] = [
  ...customerHeaderFields,
  { key: "billDate", label: "业务日期", renderer: "date", required: true },
  { key: "validUntil", label: "报价有效期", renderer: "date", required: true },
  { key: "billNo", label: "单据编号", renderer: "text", readonly: true },
  { key: "department", label: "部门", renderer: "text" },
  { key: "ownerName", label: "录入人", renderer: "text", readonly: true },
  { key: "isTaxInclusive", label: "价格口径", renderer: "enum" },
  { key: "remark", label: "单据备注", renderer: "textarea", span: 4 }
];

export const identityListColumns: ListColumnDefinition[] = [
  { field: "billNo", title: "单据编号", width: 150, fixed: "left", visible: true },
  { field: "billDate", title: "单据日期", width: 130, visible: true }
];

export const customerListColumns: ListColumnDefinition[] = [
  { field: "customerCode", title: "客户编码", width: 120, visible: true },
  { field: "customer", title: "客户名称", width: 200, visible: true }
];

export const amountListColumns: ListColumnDefinition[] = [
  { field: "amount", title: "金额", width: 120, align: "right", visible: true }
];

export const priceTaxTotalListColumn: ListColumnDefinition = {
  field: "priceTaxTotal",
  title: "含税金额",
  width: 120,
  align: "right",
  visible: true
};

export const salesDetailBaseColumns: ListColumnDefinition[] = [
  { field: "billNo", title: "单据编号", width: 170, fixed: "left", visible: true },
  { field: "customerCode", title: "客户编码", width: 120, visible: true },
  { field: "partner", title: "客户名称", width: 180, visible: true },
  { field: "customerMaterialCode", title: "客户物料编码", width: 150, visible: true },
  { field: "customerOrderNo", title: "客户订单号", width: 150, visible: true },
  { field: "billDate", title: "单据日期", width: 120, visible: true },
  { field: "planDeliveryDate", title: "预计交期", width: 120, visible: true },
  { field: "status", title: "审核状态", width: 100, visible: true },
  { field: "lineNo", title: "行号", width: 80, align: "right", visible: true },
  { field: "productCode", title: "物料编码", width: 130, visible: true },
  { field: "productName", title: "物料名称", width: 180, visible: true },
  { field: "spec", title: "规格型号", width: 150, visible: true },
  { field: "warehouse", title: "仓库", width: 150, visible: true },
  { field: "qty", title: "数量", width: 110, align: "right", visible: true },
  { field: "unitPrice", title: "单价", width: 120, align: "right", visible: true },
  { field: "taxInclusiveUnitPrice", title: "含税单价", width: 120, align: "right", visible: true },
  { field: "amount", title: "金额", width: 120, align: "right", visible: true },
  priceTaxTotalListColumn,
  { field: "lineRemark", title: "行备注", width: 180, visible: true }
];

export const salesOrderDetailColumns: ListColumnDefinition[] = [
  ...salesDetailBaseColumns.slice(0, 14),
  { field: "shippedQty", title: "已出库数量", width: 120, align: "right", visible: true },
  { field: "remainingQty", title: "未出库数量", width: 120, align: "right", visible: true },
  ...salesDetailBaseColumns.slice(14)
];

export const salesQuoteDetailColumns: ListColumnDefinition[] = [
  ...salesDetailBaseColumns.filter((column) => column.field !== "planDeliveryDate")
];

export const sourceDetailColumns: ListColumnDefinition[] = [
  { field: "sourceBillNo", title: "源单号", width: 170, visible: true },
  { field: "sourceLineNo", title: "源行号", width: 90, align: "right", visible: true }
];

export const salesEntryColumns: EntryColumnDefinition[] = [
  { field: "rowNo", title: "序号", width: 42, fixed: "left", visible: true, editable: false },
  { field: "productCode", title: "物料编码", width: 132, visible: true, editable: true, renderer: "master" },
  { field: "productName", title: "物料名称", width: 156, visible: true, editable: true, renderer: "master" },
  { field: "spec", title: "规格型号", width: 132, visible: true, editable: false },
  { field: "warehouse", title: "仓库", width: 96, visible: true, editable: true, renderer: "master", bulkFill: true },
  { field: "customerMaterialCode", title: "客户物料编码", width: 136, visible: true, editable: true, renderer: "text" },
  { field: "customerOrderNo", title: "客户订单号", width: 136, visible: true, editable: true, renderer: "text" },
  { field: "qty", title: "数量", width: 96, align: "right", visible: true, editable: true, renderer: "qty", bulkFill: true },
  { field: "unitPrice", title: "单价", width: 116, align: "right", visible: true, editable: true, renderer: "price", bulkFill: true },
  { field: "taxInclusiveUnitPrice", title: "含税单价", width: 116, align: "right", visible: true, editable: false, renderer: "amount" },
  { field: "amount", title: "金额", width: 120, align: "right", visible: true, editable: false, renderer: "amount" },
  { field: "taxRate", title: "税率%", width: 92, align: "right", visible: true, editable: true, renderer: "number" },
  { field: "taxAmount", title: "税额", width: 110, align: "right", visible: true, editable: false, renderer: "amount" },
  { field: "priceTaxTotal", title: "含税金额", width: 124, align: "right", visible: true, editable: false, renderer: "amount" },
  { field: "planDeliveryDate", title: "预计交期", width: 128, visible: true, editable: true, renderer: "date", bulkFill: true },
  { field: "lineRemark", title: "行备注", width: 160, visible: true, editable: true, renderer: "text" }
];

export const salesQuoteEntryColumns: EntryColumnDefinition[] = [
  ...salesEntryColumns.filter((column) => column.field !== "planDeliveryDate")
];

export const sourceEntryColumns: EntryColumnDefinition[] = [
  { field: "sourceOrderNo", title: "源单号", width: 142, visible: true, editable: false },
  { field: "sourceLineNo", title: "源单行号", width: 86, align: "right", visible: true, editable: false }
];
