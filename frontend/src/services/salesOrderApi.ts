export interface SalesOrderDraftPayload {
  billNo: string;
  customerCode: string;
  billDate: string;
  department: string;
  ownerName: string;
  lines: Array<{
    productCode: string;
    warehouseCode: string;
    qty: number;
    unitPrice: number;
  }>;
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
