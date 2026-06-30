import { computed, type Ref } from "vue";
import type { ListColumn } from "./useDataListDefinition";

const listSummaryFields = new Map<string, number>([
  ["qty", 4],
  ["shippedQty", 4],
  ["receivedQty", 4],
  ["orderQty", 4],
  ["inQty", 4],
  ["returnQty", 4],
  ["remainingQty", 4],
  ["amount", 2],
  ["priceTaxTotal", 2],
  ["orderAmount", 2],
  ["inAmount", 2],
  ["returnAmount", 2],
  ["netPurchaseAmount", 2]
]);

export function useDataListSummary(
  visibleColumns: Ref<ListColumn[]>,
  displayedRows: Ref<Record<string, unknown>[]>,
  isSalesOrderList: Ref<boolean>
) {
  const hasListSummary = computed(() => visibleColumns.value.some((column) => listSummaryFields.has(column.field)));

  const listSummaryTotals = computed(() => Object.fromEntries(
    [...listSummaryFields.entries()].map(([field, maxDecimals]) => [field, sumDisplayedRows(displayedRows.value, field, maxDecimals)])
  ) as Record<string, string>);

  const listSummaryRowTestId = computed(() => isSalesOrderList.value ? "sales-order-list-summary-row" : "list-summary-row");

  const summaryLabelField = computed(() => (
    visibleColumns.value.find((column) => !listSummaryFields.has(column.field))?.field ??
    visibleColumns.value[0]?.field ??
    ""
  ));

  function listSummaryFooterValue(columnKey: string) {
    if (columnKey === "__selection") {
      return "";
    }
    if (columnKey === summaryLabelField.value) {
      return "合计";
    }
    if (listSummaryFields.has(columnKey)) {
      return listSummaryTotals.value[columnKey] ?? "";
    }
    return "";
  }

  function listSummaryCellTestId(columnKey: string) {
    return columnKey === "__selection" ? undefined : `list-summary-${columnKey}`;
  }

  return {
    hasListSummary,
    listSummaryTotals,
    listSummaryRowTestId,
    listSummaryFooterValue,
    listSummaryCellTestId,
    cellValue
  };
}

export function cellValue(row: Record<string, unknown>, column: ListColumn) {
  if (column.field === "billNo" && (row.billNo == null || row.billNo === "")) {
    return row.bill_no ?? "";
  }
  if (column.field === "taxInclusiveUnitPrice") {
    const existing = row.taxInclusiveUnitPrice;
    if (existing != null && existing !== "") {
      return existing;
    }
    const unitPrice = Number(row.unitPrice ?? 0);
    const taxRate = Number(row.taxRate ?? 0);
    if (!Number.isFinite(unitPrice) || !Number.isFinite(taxRate)) {
      return "";
    }
    return (unitPrice * (1 + taxRate / 100)).toFixed(2);
  }
  return row[column.field] ?? "";
}

function sumDisplayedRows(rows: Record<string, unknown>[], field: string, maxDecimals: number) {
  return formatListSummaryNumber(rows.reduce((sum, row) => {
    if (field === "priceTaxTotal") {
      return sum + numericCell(cellValue(row, { field, title: "", width: 0, visible: true }));
    }
    return sum + numericCell(row[field]);
  }, 0), maxDecimals);
}

function numericCell(value: unknown) {
  if (value == null || value === "") {
    return 0;
  }
  const numeric = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(numeric) ? numeric : 0;
}

function formatListSummaryNumber(value: number, maxDecimals: number) {
  if (!Number.isFinite(value)) {
    return maxDecimals === 2 ? "0.00" : "0";
  }
  if (maxDecimals === 2) {
    return value.toFixed(2);
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(maxDecimals).replace(/0+$/, "").replace(/\.$/, "");
}
