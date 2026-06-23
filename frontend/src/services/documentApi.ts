interface DocumentDraftPayload {
  billNo: string;
  sourceOrderNo?: string;
  partyCode: string;
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

const endpointByType = {
  purchaseOrder: "/api/purchase-orders",
  purchaseIn: "/api/purchase-ins",
  salesOut: "/api/sales-outs"
} as const;

export type DocumentType = keyof typeof endpointByType;

export async function saveDocumentDraft(type: DocumentType, payload: DocumentDraftPayload) {
  const body = toBackendPayload(type, payload);
  return callDocument(`${endpointByType[type]}/draft`, "POST", body);
}

export async function auditDocument(type: DocumentType, billNo: string) {
  return callDocument(`${endpointByType[type]}/${encodeURIComponent(billNo)}/audit`, "POST");
}

function toBackendPayload(type: DocumentType, payload: DocumentDraftPayload) {
  const base = {
    billNo: payload.billNo,
    sourceOrderNo: payload.sourceOrderNo,
    billDate: payload.billDate,
    department: payload.department,
    ownerName: payload.ownerName,
    lines: payload.lines
  };
  if (type === "salesOut") {
    return { ...base, customerCode: payload.partyCode };
  }
  return { ...base, supplierCode: payload.partyCode };
}

async function callDocument(url: string, method: string, body?: unknown): Promise<{ ok: boolean; message: string; data?: unknown }> {
  try {
    const response = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    if (!response.ok) {
      return { ok: false, message: "单据操作失败，请检查主数据、库存和单据状态。" };
    }
    return { ok: true, message: "", data: await response.json() };
  } catch {
    return { ok: false, message: "网络异常，单据操作失败。" };
  }
}
