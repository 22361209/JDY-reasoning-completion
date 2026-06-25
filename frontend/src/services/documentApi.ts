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
    sourceLineNo?: number;
    qty: number;
    unitPrice: number;
    lineRemark?: string;
  }>;
}

const endpointByType = {
  salesOrder: "/api/sales-orders",
  purchaseOrder: "/api/purchase-orders",
  purchaseIn: "/api/purchase-ins",
  salesOut: "/api/sales-outs",
  materialIssue: "/api/production/material-issues",
  productIn: "/api/production/product-ins"
} as const;

const detailEndpointByType = {
  salesOrder: "/api/sales-orders",
  purchaseOrder: "/api/purchase-orders",
  purchaseIn: "/api/purchase-ins",
  salesOut: "/api/sales-outs",
  materialIssue: "/api/production/material-issues",
  productIn: "/api/production/product-ins"
} as const;

const outputTypeByDocumentType = {
  salesOrder: "sales-order",
  purchaseOrder: "purchase-order",
  purchaseIn: "purchase-in",
  salesOut: "sales-out",
  materialIssue: "material-issue",
  productIn: "product-in"
} as const;

export type DocumentType = keyof typeof endpointByType;
export type OpenableDocumentType = keyof typeof detailEndpointByType;
export type OutputDocumentType = keyof typeof outputTypeByDocumentType;

export interface PrintTemplateConfig {
  documentType: string;
  documentTitle: string;
  templateCode: string;
  templateName: string;
  roleCode?: string;
  companyName: string;
  headerNote: string;
  footerNote: string;
  showSignature: boolean;
  showSeal: boolean;
  isDefault: boolean;
  paperSize: string;
  pageOrientation: string;
  marginTopMm: string;
  marginRightMm: string;
  marginBottomMm: string;
  marginLeftMm: string;
  copyCount: number;
  enabled: boolean;
}

export interface DownstreamDocumentRef {
  billNo: string;
  type: OpenableDocumentType;
  typeLabel?: string;
  status?: string;
  billDate?: string;
  sourceLineNo?: number | string;
  downstreamLineNo?: number | string;
  qty?: number | string;
  amount?: number | string;
  riskLevel?: string;
  reverseImpact?: string;
  redReverseImpact?: string;
}

export interface DocumentDetail {
  action?: string;
  document: {
    billNo: string;
    sourceOrderNo?: string;
    customerCode?: string;
    supplierCode?: string;
    billDate: string;
    department?: string;
    ownerName?: string;
    status: string;
    redReverseBillNo?: string;
    redSourceBillNo?: string;
  };
  lines: Array<{
    lineNo?: number | string;
    sourceLineNo?: number | string;
    productCode?: string;
    productName?: string;
    spec?: string;
    warehouseCode?: string;
    qty?: number | string;
    receivedQty?: number | string;
    shippedQty?: number | string;
    remainingQty?: number | string;
    unitPrice?: number | string;
    lineRemark?: string;
    downstreamDocs?: DownstreamDocumentRef[];
  }>;
}

export async function saveDocumentDraft(type: DocumentType, payload: DocumentDraftPayload) {
  const body = toBackendPayload(type, payload);
  return callDocument(`${endpointByType[type]}/draft`, "POST", body);
}

export async function auditDocument(type: DocumentType, billNo: string) {
  return callDocument(`${endpointByType[type]}/${encodeURIComponent(billNo)}/audit`, "POST");
}

export async function fetchDocumentDetail(type: OpenableDocumentType, billNo: string): Promise<{ ok: boolean; message: string; data?: DocumentDetail }> {
  const result = await callDocument(`${detailEndpointByType[type]}/${encodeURIComponent(billNo)}`, "GET");
  if (!result.ok || !result.data) {
    return { ok: false, message: result.message };
  }
  return normalizeDocumentDetail(result.data);
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
  return callBlobDocument(`/api/documents/${outputTypeByDocumentType[type]}/${encodeURIComponent(billNo)}/print.pdf`);
}

export async function fetchPrintTemplates(): Promise<{ ok: boolean; message: string; data: PrintTemplateConfig[] }> {
  const result = await callDocument("/api/documents/print-templates", "GET");
  if (!result.ok || !Array.isArray(result.data)) {
    return { ok: false, message: result.message || "打印模板加载失败。", data: [] };
  }
  return { ok: true, message: "", data: result.data as PrintTemplateConfig[] };
}

export async function savePrintTemplate(documentType: string, payload: Omit<PrintTemplateConfig, "documentType" | "documentTitle" | "enabled">): Promise<{ ok: boolean; message: string; data?: PrintTemplateConfig }> {
  const result = await callDocument(`/api/documents/${encodeURIComponent(documentType)}/print-template`, "PUT", payload);
  if (!result.ok || !result.data) {
    return { ok: false, message: result.message || "打印模板保存失败。" };
  }
  return { ok: true, message: "", data: result.data as PrintTemplateConfig };
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
  if (type === "salesOut" || type === "salesOrder") {
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

function normalizeDocumentDetail(raw: unknown): { ok: boolean; message: string; data?: DocumentDetail } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, message: "单据详情格式异常。" };
  }
  const payload = raw as { action?: string; document?: unknown; order?: unknown; lines?: unknown };
  const document = payload.document ?? payload.order;
  if (!document || typeof document !== "object") {
    return { ok: false, message: "单据详情缺少单头信息。" };
  }
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  return {
    ok: true,
    message: "",
    data: {
      action: payload.action,
      document: document as DocumentDetail["document"],
      lines: lines as DocumentDetail["lines"]
    }
  };
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

async function callBlobDocument(url: string): Promise<{ ok: boolean; message: string; data?: string }> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return { ok: false, message: "单据输出失败，请确认单据已保存。" };
    }
    const blob = await response.blob();
    return { ok: true, message: "", data: URL.createObjectURL(blob) };
  } catch {
    return { ok: false, message: "网络异常，单据输出失败。" };
  }
}
