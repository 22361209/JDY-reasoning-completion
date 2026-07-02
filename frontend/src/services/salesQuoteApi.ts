import { exactSourceFilter, fetchSourceSelectorRows, type SourceSelectorColumnFilters } from "./sourceSelectorListApi";

export interface SelectableSalesQuoteLine {
  billNo: string;
  customerCode: string;
  customer?: string;
  billDate: string;
  validUntil?: string;
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
  sourceQty?: number | string;
  unitPrice: number | string;
  taxRate?: number | string;
  taxAmount?: number | string;
	  priceTaxTotal?: number | string;
	  customerMaterialCode?: string;
	  customerOrderNo?: string;
	  lineRemark?: string;
  planDeliveryDate?: string;
}

export async function fetchSelectableSalesQuoteLines(
  customerCode: string,
  query: { keyword?: string; columnFilters?: SourceSelectorColumnFilters } = {}
): Promise<{ ok: boolean; message: string; data: SelectableSalesQuoteLine[] }> {
  const result = await fetchSourceSelectorRows({
    listKey: "sales-quote-source-selector",
    keyword: query.keyword,
    columnFilters: query.columnFilters,
    fixedFilters: exactSourceFilter("customerCode", customerCode)
  });
  return { ok: result.ok, message: result.message || "销售报价单选单列表加载失败。", data: result.rows as unknown as SelectableSalesQuoteLine[] };
}

export async function setSalesQuoteValid(billNo: string, valid: boolean): Promise<{ ok: boolean; message: string; data?: unknown }> {
  return callSalesQuote(`/api/sales-quotes/${encodeURIComponent(billNo)}/valid`, "POST", { valid });
}

async function callSalesQuote(url: string, method: string, body?: unknown): Promise<{ ok: boolean; message: string; data?: unknown }> {
  try {
    const response = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    if (!response.ok) {
      return { ok: false, message: await readErrorMessage(response) };
    }
    return { ok: true, message: "", data: await response.json() };
  } catch {
    return { ok: false, message: "网络异常，销售报价单操作失败。" };
  }
}

async function readErrorMessage(response: Response) {
  try {
    const text = await response.text();
    if (!text.trim()) {
      return `销售报价单操作失败（HTTP ${response.status}）。`;
    }
    try {
      const payload = JSON.parse(text) as { reason?: string; message?: string; detail?: string; error?: string };
      return payload.reason || payload.message || payload.detail || payload.error || text;
    } catch {
      return text;
    }
  } catch {
    return `销售报价单操作失败（HTTP ${response.status}）。`;
  }
}
