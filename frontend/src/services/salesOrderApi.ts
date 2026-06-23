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
