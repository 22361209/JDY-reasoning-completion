import { exactSourceFilter, fetchSourceSelectorRows, type SourceSelectorColumnFilters } from "./sourceSelectorListApi";

export interface SelectablePurchaseInLine {
  billNo: string;
  supplierCode: string;
  supplier?: string;
  billDate: string;
  department?: string;
  ownerName?: string;
  isTaxInclusive?: boolean;
  lineNo: number | string;
  productId?: string;
  productCode: string;
  productName?: string;
  spec?: string;
  unit?: string;
  netWeight?: number | string;
  grossWeight?: number | string;
  warehouseCode: string;
  sourceQty: number | string;
  returnedQty?: number | string;
  remainingQty: number | string;
  unitPrice: number | string;
  taxRate?: number | string;
  taxAmount?: number | string;
  priceTaxTotal?: number | string;
  lineRemark?: string;
}

export async function fetchSelectablePurchaseInLines(
  supplierCode: string,
  query: { keyword?: string; columnFilters?: SourceSelectorColumnFilters } = {}
): Promise<{ ok: boolean; message: string; data: SelectablePurchaseInLine[] }> {
  const result = await fetchSourceSelectorRows({
    listKey: "purchase-in-source-selector",
    keyword: query.keyword,
    columnFilters: query.columnFilters,
    fixedFilters: exactSourceFilter("supplierCode", supplierCode)
  });
  return { ok: result.ok, message: result.message || "采购入库选单列表加载失败。", data: result.rows as unknown as SelectablePurchaseInLine[] };
}

async function callPurchaseIn(url: string, method: string): Promise<{ ok: boolean; message: string; data?: unknown }> {
  try {
    const response = await fetch(url, { method });
    if (!response.ok) {
      return { ok: false, message: await readErrorMessage(response) };
    }
    return { ok: true, message: "", data: await response.json() };
  } catch {
    return { ok: false, message: "网络异常，采购入库选单失败。" };
  }
}

async function readErrorMessage(response: Response) {
  try {
    const text = await response.text();
    if (!text.trim()) {
      return `采购入库选单失败（HTTP ${response.status}）。`;
    }
    try {
      const payload = JSON.parse(text) as { reason?: string; message?: string; detail?: string; error?: string };
      return payload.reason || payload.message || payload.detail || payload.error || text;
    } catch {
      return text;
    }
  } catch {
    return `采购入库选单失败（HTTP ${response.status}）。`;
  }
}
