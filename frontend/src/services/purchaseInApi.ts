export interface SelectablePurchaseInLine {
  billNo: string;
  supplierCode: string;
  supplier?: string;
  billDate: string;
  department?: string;
  ownerName?: string;
  isTaxInclusive?: boolean;
  lineNo: number | string;
  productCode: string;
  productName?: string;
  spec?: string;
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

export async function fetchSelectablePurchaseInLines(supplierCode: string): Promise<{ ok: boolean; message: string; data: SelectablePurchaseInLine[] }> {
  const result = await callPurchaseIn(`/api/purchase-returns/selectable-lines?supplierCode=${encodeURIComponent(supplierCode)}`, "GET");
  if (!result.ok || !result.data || !Array.isArray((result.data as { lines?: unknown }).lines)) {
    return { ok: false, message: result.message || "采购入库选单列表加载失败。", data: [] };
  }
  return { ok: true, message: "", data: (result.data as { lines: SelectablePurchaseInLine[] }).lines };
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
