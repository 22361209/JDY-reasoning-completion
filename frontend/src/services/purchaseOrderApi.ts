export interface SelectablePurchaseOrderLine {
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
  supplierMaterialCode?: string;
  spec?: string;
  unit?: string;
  netWeight?: number | string;
  grossWeight?: number | string;
  warehouseCode: string;
  planDeliveryDate?: string;
  sourceQty: number | string;
  receivedQty?: number | string;
  remainingQty: number | string;
  unitPrice: number | string;
  priceTaxTotal?: number | string;
  taxRate?: number | string;
  taxAmount?: number | string;
  lineRemark?: string;
}

export async function fetchSelectablePurchaseOrderLines(supplierCode: string): Promise<{ ok: boolean; message: string; data: SelectablePurchaseOrderLine[] }> {
  const result = await callPurchaseOrder(`/api/purchase-orders/selectable-lines?supplierCode=${encodeURIComponent(supplierCode)}`, "GET");
  if (!result.ok || !result.data || !Array.isArray((result.data as { lines?: unknown }).lines)) {
    return { ok: false, message: result.message || "采购订单选单列表加载失败。", data: [] };
  }
  return { ok: true, message: "", data: (result.data as { lines: SelectablePurchaseOrderLine[] }).lines };
}

export async function fetchSelectablePurchaseRequisitionLines(supplierCode: string): Promise<{ ok: boolean; message: string; data: SelectablePurchaseOrderLine[] }> {
  const result = await callPurchaseOrder(`/api/purchase-orders/selectable-requisition-lines?supplierCode=${encodeURIComponent(supplierCode)}`, "GET");
  if (!result.ok || !result.data || !Array.isArray((result.data as { lines?: unknown }).lines)) {
    return { ok: false, message: result.message || "采购申请选单列表加载失败。", data: [] };
  }
  return { ok: true, message: "", data: (result.data as { lines: SelectablePurchaseOrderLine[] }).lines };
}

async function callPurchaseOrder(url: string, method: string): Promise<{ ok: boolean; message: string; data?: unknown }> {
  try {
    const response = await fetch(url, { method });
    if (!response.ok) {
      return { ok: false, message: await readErrorMessage(response) };
    }
    return { ok: true, message: "", data: await response.json() };
  } catch {
    return { ok: false, message: "网络异常，采购订单操作失败。" };
  }
}

async function readErrorMessage(response: Response) {
  try {
    const text = await response.text();
    if (!text.trim()) {
      return `采购订单操作失败（HTTP ${response.status}）。`;
    }
    try {
      const payload = JSON.parse(text) as { reason?: string; message?: string; detail?: string; error?: string };
      return payload.reason || payload.message || payload.detail || payload.error || text;
    } catch {
      return text;
    }
  } catch {
    return `采购订单操作失败（HTTP ${response.status}）。`;
  }
}
