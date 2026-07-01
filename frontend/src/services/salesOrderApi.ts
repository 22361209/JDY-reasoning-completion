export interface SalesOrderDraftPayload {
  billNo: string;
  customerCode: string;
  billDate: string;
  department: string;
  ownerName: string;
  lines: Array<{
    lineNo?: number | string;
    productId?: string;
    productCode: string;
    unit?: string;
    netWeight?: number | string;
    grossWeight?: number | string;
    warehouseCode: string;
    qty: number;
    unitPrice: number;
	    taxRate?: number;
	    customerMaterialCode?: string;
	    customerOrderNo?: string;
	    lineRemark?: string;
    planDeliveryDate?: string;
  }>;
}

export interface SalesOrderDetail {
  order: {
    billNo: string;
    customerCode: string;
    customer?: string;
    billDate: string;
    department: string;
    ownerName: string;
    createdByName?: string;
    remark?: string;
    status: string;
    closeStatus?: string;
    closeMode?: string | null;
    frozenStatus?: string;
    isTaxInclusive?: boolean;
  };
  lines: Array<{
    lineNo?: number | string;
    productId?: string;
    productCode: string;
    productName?: string;
    spec?: string;
    unit?: string;
    netWeight?: number | string;
    grossWeight?: number | string;
    warehouseCode: string;
    qty: number | string;
    shippedQty?: number | string;
    remainingQty?: number | string;
    availableNoticeQty?: number | string;
    lineCloseStatus?: string;
    lineFrozenStatus?: string;
    unitPrice: number | string;
    taxRate?: number | string;
    taxAmount?: number | string;
	    priceTaxTotal?: number | string;
	    customerMaterialCode?: string;
	    customerOrderNo?: string;
	    lineRemark?: string;
    planDeliveryDate?: string;
  }>;
}

export interface SelectableSalesOrderLine {
  billNo: string;
  customerCode: string;
  customer?: string;
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
  shippedQty?: number | string;
  remainingQty: number | string;
  availableNoticeQty?: number | string;
  unitPrice: number | string;
  taxRate?: number | string;
  taxAmount?: number | string;
	  priceTaxTotal?: number | string;
	  customerMaterialCode?: string;
	  customerOrderNo?: string;
	  lineRemark?: string;
  planDeliveryDate?: string;
}

export interface SelectableDeliveryNoticeLine extends SelectableSalesOrderLine {
  sourceOrderNo?: string;
  sourceLineNo?: number | string;
  stockOnHand?: number | string;
  stockReserved?: number | string;
  stockAvailable?: number | string;
  stockInTransit?: number | string;
}

export async function saveSalesOrderDraft(payload: SalesOrderDraftPayload): Promise<{ ok: boolean; message: string }> {
  try {
    const response = await fetch("/api/sales-orders/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      return { ok: false, message: "销售订单保存失败，请检查客户、商品和仓库是否启用。" };
    }
    return { ok: true, message: "" };
  } catch {
    return { ok: false, message: "网络异常，销售订单保存失败。" };
  }
}

export async function auditSalesOrder(billNo: string) {
  return callSalesOrder(`/api/sales-orders/${encodeURIComponent(billNo)}/audit`, "POST");
}

export async function fetchSalesOrderDetail(billNo: string): Promise<{ ok: boolean; message: string; data?: SalesOrderDetail }> {
  const result = await callSalesOrder(`/api/sales-orders/${encodeURIComponent(billNo)}`, "GET");
  return {
    ok: result.ok,
    message: result.message,
    data: result.data as SalesOrderDetail | undefined
  };
}

export async function fetchSelectableSalesOrderLines(customerCode: string): Promise<{ ok: boolean; message: string; data: SelectableSalesOrderLine[] }> {
  const result = await callSalesOrder(`/api/sales-orders/selectable-lines?customerCode=${encodeURIComponent(customerCode)}`, "GET");
  if (!result.ok || !result.data || !Array.isArray((result.data as { lines?: unknown }).lines)) {
    return { ok: false, message: result.message || "销售订单选单列表加载失败。", data: [] };
  }
  return { ok: true, message: "", data: (result.data as { lines: SelectableSalesOrderLine[] }).lines };
}

export async function fetchSelectableDeliveryNoticeLines(customerCode: string): Promise<{ ok: boolean; message: string; data: SelectableDeliveryNoticeLine[] }> {
  const result = await callSalesOrder(`/api/delivery-notices/selectable-lines?customerCode=${encodeURIComponent(customerCode)}`, "GET");
  if (!result.ok || !result.data || !Array.isArray((result.data as { lines?: unknown }).lines)) {
    return { ok: false, message: result.message || "发货通知单选单列表加载失败。", data: [] };
  }
  return { ok: true, message: "", data: (result.data as { lines: SelectableDeliveryNoticeLine[] }).lines };
}

export async function deleteSalesOrder(billNo: string) {
  return callSalesOrder(`/api/sales-orders/${encodeURIComponent(billNo)}`, "DELETE");
}

export async function exportSalesOrder(billNo: string) {
  return callSalesOrder(`/api/sales-orders/${encodeURIComponent(billNo)}/export`, "GET");
}

export async function printSalesOrder(billNo: string) {
  return callSalesOrder(`/api/sales-orders/${encodeURIComponent(billNo)}/print`, "GET");
}

async function callSalesOrder(url: string, method: string): Promise<{ ok: boolean; message: string; data?: unknown }> {
  try {
    const response = await fetch(url, { method });
    if (!response.ok) {
      return { ok: false, message: "销售订单操作失败，请确认单据已保存。" };
    }
    return { ok: true, message: "", data: await response.json() };
  } catch {
    return { ok: false, message: "网络异常，销售订单操作失败。" };
  }
}
