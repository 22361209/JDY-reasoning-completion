import type { EntryColumn, EntryColumnKey, EntryColumnOptions } from "./types";

export const numericColumns = new Set<EntryColumnKey>([
  "rowNo",
  "netWeight",
  "grossWeight",
  "qty",
  "executedQty",
  "remainingQty",
  "stockOnHand",
  "stockReserved",
  "stockAvailable",
  "stockInTransit",
  "unitPrice",
  "taxInclusiveUnitPrice",
  "taxRate",
  "amount",
  "taxAmount",
  "priceTaxTotal"
]);

export const bulkPriceSourceOptions = [
  { key: "defaultPrice", label: "默认价格" },
  { key: "quotePrice", label: "最新有效报价" },
  { key: "recentPrice", label: "最近成交价" },
  { key: "historyMaxPrice", label: "历史最高价" },
  { key: "historyMinPrice", label: "历史最低价" },
  { key: "historyAvgPrice", label: "平均价" },
  { key: "costPrice", label: "成本价" }
] as const;

export function buildDefaultEntryColumns(options: EntryColumnOptions): EntryColumn[] {
  return [
    { key: "rowNo", title: "序号", width: 48, visible: true, fixed: "left", locked: true, configurable: false, numeric: true },
    { key: "partyCode", title: options.partyCodeLabel || "客户编码", width: 118, visible: options.showPartyCodeColumn !== false },
    { key: "customerMaterialCode", title: "客户物料编码", width: 150, visible: Boolean(options.showCustomerMaterialCodeColumn) },
    { key: "supplierMaterialCode", title: "供应商物料编码", width: 150, visible: Boolean(options.showSupplierMaterialCodeColumn) },
    { key: "customerOrderNo", title: "客户订单号", width: 150, visible: Boolean(options.showCustomerOrderNoColumn) },
    { key: "productCode", title: "物料编码", width: 140, visible: true },
    { key: "productName", title: "物料名称", width: 170, visible: true },
    { key: "spec", title: "规格型号", width: 150, visible: true },
    { key: "unit", title: "单位", width: 76, visible: true },
    { key: "netWeight", title: "净重", width: 88, visible: true, numeric: true },
    { key: "grossWeight", title: "毛重", width: 88, visible: true, numeric: true },
    { key: "warehouse", title: "仓库", width: 130, visible: true, bulkFillable: true },
    { key: "targetWarehouse", title: "目标仓库", width: 130, visible: Boolean(options.showTargetWarehouseColumn) },
    { key: "sourceOrderNo", title: "源单号", width: 142, visible: options.showSourceLineColumn },
    { key: "sourceLineNo", title: "源单行号", width: 86, visible: options.showSourceLineColumn },
    { key: "qty", title: "数量", width: 104, visible: true, numeric: true, bulkFillable: true },
    { key: "executedQty", title: options.executionQtyLabel || "已执行", width: 104, visible: options.showExecutionColumns, numeric: true },
    { key: "remainingQty", title: options.remainingQtyLabel || "剩余", width: 104, visible: options.showExecutionColumns, numeric: true },
    { key: "stockOnHand", title: "即时库存", width: 104, visible: Boolean(options.showStockColumns), numeric: true },
    { key: "stockReserved", title: "锁定库存", width: 104, visible: Boolean(options.showStockColumns), numeric: true },
    { key: "stockAvailable", title: "可用库存", width: 104, visible: Boolean(options.showStockColumns), numeric: true },
    { key: "stockInTransit", title: "在途库存", width: 104, visible: Boolean(options.showStockColumns), numeric: true },
    { key: "unitPrice", title: "单价", width: 112, visible: true, numeric: true, bulkFillable: Boolean(options.enableSalesPriceBulk) },
    { key: "taxInclusiveUnitPrice", title: "含税单价", width: 112, visible: Boolean(options.showTaxColumns), numeric: true },
    { key: "taxRate", title: "税率%", width: 88, visible: Boolean(options.showTaxColumns), numeric: true },
    { key: "amount", title: "金额", width: 116, visible: true, numeric: true },
    { key: "taxAmount", title: "税额", width: 104, visible: Boolean(options.showTaxColumns), numeric: true },
    { key: "priceTaxTotal", title: "含税金额", width: 124, visible: Boolean(options.showTaxColumns), numeric: true },
    { key: "planDeliveryDate", title: "预计交期", width: 142, visible: Boolean(options.showPlanDeliveryDateColumn), bulkFillable: true },
    { key: "remark", title: "行备注", width: 210, visible: true }
  ];
}

export function isColumnAvailable(column: EntryColumn, options: EntryColumnOptions) {
  if (column.key === "partyCode") {
    return Boolean(options.showPartyCodeColumn !== false && options.partyCodeLabel);
  }
  if (column.key === "targetWarehouse") {
    return Boolean(options.showTargetWarehouseColumn);
  }
  if (column.key === "rowNo") {
    return true;
  }
  if (column.key === "customerMaterialCode") {
    return Boolean(options.showCustomerMaterialCodeColumn);
  }
  if (column.key === "supplierMaterialCode") {
    return Boolean(options.showSupplierMaterialCodeColumn);
  }
  if (column.key === "customerOrderNo") {
    return Boolean(options.showCustomerOrderNoColumn);
  }
  if (column.key === "planDeliveryDate") {
    return Boolean(options.showPlanDeliveryDateColumn);
  }
  if (column.key === "taxInclusiveUnitPrice" || column.key === "taxRate" || column.key === "taxAmount" || column.key === "priceTaxTotal") {
    return Boolean(options.showTaxColumns);
  }
  if (column.key === "sourceLineNo" || column.key === "sourceOrderNo") {
    return options.showSourceLineColumn;
  }
  if (column.key === "executedQty" || column.key === "remainingQty") {
    return options.showExecutionColumns;
  }
  if (["stockOnHand", "stockReserved", "stockAvailable", "stockInTransit"].includes(column.key)) {
    return Boolean(options.showStockColumns);
  }
  return true;
}

export function isFrozenEntryColumn(key: EntryColumnKey) {
  return key === "rowNo";
}

export function normalizeEntryColumns(nextColumns: EntryColumn[]) {
  const frozen = nextColumns
    .filter((column) => isFrozenEntryColumn(column.key))
    .map((column) => ({ ...column, fixed: "left" as const, visible: true, configurable: false }));
  const regular = nextColumns
    .filter((column) => !isFrozenEntryColumn(column.key))
    .map((column) => ({ ...column, fixed: "" as const }));
  return [...frozen, ...regular];
}

export function loadEntryColumnPreferences(key: string): EntryColumn[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "[]") as EntryColumn[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveEntryColumnPreferences(key: string, columns: EntryColumn[]) {
  localStorage.setItem(key, JSON.stringify(columns.map((column) => ({
    key: column.key,
    width: isFrozenEntryColumn(column.key) ? column.width : Math.max(64, Number(column.width) || 64),
    visible: isFrozenEntryColumn(column.key) ? true : column.visible,
    fixed: isFrozenEntryColumn(column.key) ? "left" : ""
  }))));
}

export function entryColumnClass(column: EntryColumn) {
  return {
    "entry-number-cell": numericColumns.has(column.key),
    "readonly-qty": ["sourceLineNo", "executedQty", "remainingQty", "stockOnHand", "stockReserved", "stockAvailable", "stockInTransit"].includes(column.key),
    "amount-cell": column.key === "amount" || column.key === "taxAmount" || column.key === "priceTaxTotal",
    "tax-cell": column.key === "taxRate" || column.key === "taxAmount" || column.key === "priceTaxTotal",
    "remark-cell": column.key === "remark",
    "entry-row-no-cell": column.key === "rowNo",
    "entry-frozen-cell": isFrozenEntryColumn(column.key)
  };
}
