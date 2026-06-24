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

const outputTypeByDocumentType = {
  salesOrder: "sales-order",
  purchaseOrder: "purchase-order",
  purchaseIn: "purchase-in",
  salesOut: "sales-out"
} as const;

export type DocumentType = keyof typeof endpointByType;
export type OutputDocumentType = keyof typeof outputTypeByDocumentType;

export async function saveDocumentDraft(type: DocumentType, payload: DocumentDraftPayload) {
  const body = toBackendPayload(type, payload);
  return callDocument(`${endpointByType[type]}/draft`, "POST", body);
}

export async function auditDocument(type: DocumentType, billNo: string) {
  return callDocument(`${endpointByType[type]}/${encodeURIComponent(billNo)}/audit`, "POST");
}

export async function reverseDocument(type: DocumentType, billNo: string) {
  return callDocument(`${endpointByType[type]}/${encodeURIComponent(billNo)}/reverse`, "POST");
}

export async function voidDocument(type: DocumentType, billNo: string) {
  return callDocument(`${endpointByType[type]}/${encodeURIComponent(billNo)}/void`, "POST");
}

export async function redReverseDocument(type: DocumentType, billNo: string, payload: { redBillNo: string; billDate: string; ownerName: string }) {
  return callDocument(`${endpointByType[type]}/${encodeURIComponent(billNo)}/red-reverse`, "POST", payload);
}

export async function exportDocument(type: OutputDocumentType, billNo: string) {
  return callTextDocument(`/api/documents/${outputTypeByDocumentType[type]}/${encodeURIComponent(billNo)}/export.csv`);
}

export async function printDocument(type: OutputDocumentType, billNo: string) {
  return callTextDocument(`/api/documents/${outputTypeByDocumentType[type]}/${encodeURIComponent(billNo)}/print.html`);
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

async function callTextDocument(url: string): Promise<{ ok: boolean; message: string; data?: string }> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return { ok: false, message: "单据输出失败，请确认单据已保存。" };
    }
    return { ok: true, message: "", data: await response.text() };
  } catch {
    return { ok: false, message: "网络异常，单据输出失败。" };
  }
}
