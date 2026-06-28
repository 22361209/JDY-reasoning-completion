interface DocumentDraftPayload {
  billNo: string;
  sourceOrderNo?: string;
  partyCode: string;
  billDate: string;
  department: string;
  ownerName: string;
  remark?: string;
  isTaxInclusive?: boolean;
  validUntil?: string;
  lines: Array<{
    productCode: string;
    warehouseCode: string;
    targetWarehouseCode?: string;
    sourceOrderNo?: string;
    sourceDeliveryNoticeNo?: string;
    sourceDeliveryLineNo?: number;
	    sourceLineNo?: number;
	    customerMaterialCode?: string;
	    supplierMaterialCode?: string;
	    customerOrderNo?: string;
	    qty: number;
    unitPrice: number;
    taxRate?: number;
    lineRemark?: string;
    planDeliveryDate?: string;
  }>;
}

const endpointByType = {
  salesOrder: "/api/sales-orders",
  salesQuote: "/api/sales-quotes",
  deliveryNotice: "/api/delivery-notices",
  purchaseOrder: "/api/purchase-orders",
  purchaseIn: "/api/purchase-ins",
  purchaseReturn: "/api/purchase-returns",
  salesOut: "/api/sales-outs",
  materialIssue: "/api/production/material-issues",
  productIn: "/api/production/product-ins",
  otherStockIn: "/api/other-stock-ins",
  otherStockOut: "/api/other-stock-outs",
  stockTransfer: "/api/stock-transfers",
  stockCount: "/api/stock-counts",
  stockCountGain: "/api/stock-count-gains",
  stockCountLoss: "/api/stock-count-losses"
} as const;

const detailEndpointByType = {
  salesOrder: "/api/sales-orders",
  salesQuote: "/api/sales-quotes",
  deliveryNotice: "/api/delivery-notices",
  purchaseOrder: "/api/purchase-orders",
  purchaseIn: "/api/purchase-ins",
  purchaseReturn: "/api/purchase-returns",
  salesOut: "/api/sales-outs",
  materialIssue: "/api/production/material-issues",
  productIn: "/api/production/product-ins",
  otherStockIn: "/api/other-stock-ins",
  otherStockOut: "/api/other-stock-outs",
  stockTransfer: "/api/stock-transfers",
  stockCount: "/api/stock-counts",
  stockCountGain: "/api/stock-count-gains",
  stockCountLoss: "/api/stock-count-losses"
} as const;

const outputTypeByDocumentType = {
  salesOrder: "sales-order",
  salesQuote: "sales-quote",
  deliveryNotice: "delivery-notice",
  purchaseOrder: "purchase-order",
  purchaseIn: "purchase-in",
  purchaseReturn: "purchase-return",
  salesOut: "sales-out",
  materialIssue: "material-issue",
  productIn: "product-in",
  otherStockIn: "other-stock-in",
  otherStockOut: "other-stock-out",
  stockTransfer: "stock-transfer",
  stockCount: "stock-count",
  stockCountGain: "stock-count-gain",
  stockCountLoss: "stock-count-loss"
} as const;

export type DocumentType = keyof typeof endpointByType;
export type OpenableDocumentType = keyof typeof detailEndpointByType;
export type OutputDocumentType = keyof typeof outputTypeByDocumentType;

export interface DocumentLockState {
  mode: "editable" | "readonly" | "overridden" | string;
  locked: boolean;
  readOnly: boolean;
  holderName?: string;
  holderUsername?: string;
  expiresAt?: string;
  canOverride: boolean;
  overridden?: boolean;
}

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
    customer?: string;
    supplier?: string;
    billDate: string;
    department?: string;
    ownerName?: string;
    createdByName?: string;
    remark?: string;
    status: string;
    closeStatus?: string;
    frozenStatus?: string;
    redReverseBillNo?: string;
    redSourceBillNo?: string;
    isTaxInclusive?: boolean;
    enabled?: boolean;
    validUntil?: string;
  };
  lines: Array<{
    lineNo?: number | string;
    sourceOrderNo?: string;
    sourceLineNo?: number | string;
    sourceDeliveryNoticeNo?: string;
	    sourceDeliveryLineNo?: number | string;
	    customerMaterialCode?: string;
	    supplierMaterialCode?: string;
	    customerOrderNo?: string;
	    productCode?: string;
    productName?: string;
    spec?: string;
    warehouseCode?: string;
    targetWarehouseCode?: string;
    qty?: number | string;
    receivedQty?: number | string;
    shippedQty?: number | string;
    remainingQty?: number | string;
    lineCloseStatus?: string;
    lineFrozenStatus?: string;
    unitPrice?: number | string;
    taxRate?: number | string;
    taxAmount?: number | string;
    priceTaxTotal?: number | string;
    systemQty?: number | string;
    diffQty?: number | string;
    lineRemark?: string;
    planDeliveryDate?: string;
    downstreamDocs?: DownstreamDocumentRef[];
    stockOnHand?: number | string;
    stockReserved?: number | string;
    stockAvailable?: number | string;
    stockInTransit?: number | string;
  }>;
}

export interface SalesUnitPriceQuote {
  customerCode: string;
  productCode: string;
  unitPrice: number | string;
  source: "salesOrder" | "salesOut" | "productDefault" | "zero" | string;
  sourceBillNo?: string;
}

export interface SalesUnitPriceSource {
  value: number | string | null;
  available: boolean;
  label: string;
  sourceBillNo?: string;
}

export interface SalesUnitPriceSourcesByProduct {
  productCode: string;
  defaultPrice?: SalesUnitPriceSource;
  quotePrice?: SalesUnitPriceSource;
  recentPrice?: SalesUnitPriceSource;
  historyMaxPrice?: SalesUnitPriceSource;
  historyMinPrice?: SalesUnitPriceSource;
  historyAvgPrice?: SalesUnitPriceSource;
  costPrice?: SalesUnitPriceSource;
}

export interface SalesUnitPriceSourcesResponse {
  customerCode: string;
  products: Record<string, SalesUnitPriceSourcesByProduct>;
}

export async function saveDocumentDraft(type: DocumentType, payload: DocumentDraftPayload) {
  const body = toBackendPayload(type, payload);
  return callDocument(`${endpointByType[type]}/draft`, "POST", body);
}

export async function fetchSalesUnitPriceQuote(customerCode: string, productCode: string): Promise<{ ok: boolean; message: string; data?: SalesUnitPriceQuote }> {
  const search = new URLSearchParams({ customerCode, productCode });
  const result = await callDocument(`/api/sales-prices/unit-price?${search.toString()}`, "GET");
  if (!result.ok || !result.data) {
    return { ok: false, message: result.message || "销售价格查询失败。" };
  }
  return { ok: true, message: "", data: result.data as SalesUnitPriceQuote };
}

export async function fetchSalesUnitPriceSources(customerCode: string, productCodes: string[]): Promise<{ ok: boolean; message: string; data?: SalesUnitPriceSourcesResponse }> {
  const uniqueCodes = Array.from(new Set(productCodes.map((code) => code.trim()).filter(Boolean)));
  if (!customerCode.trim() || uniqueCodes.length === 0) {
    return { ok: false, message: "请先选择客户和商品。" };
  }
  const search = new URLSearchParams({ customerCode, productCodes: uniqueCodes.join(",") });
  const result = await callDocument(`/api/sales-prices/unit-price-sources?${search.toString()}`, "GET");
  if (!result.ok || !result.data) {
    return { ok: false, message: result.message || "销售价格来源查询失败。" };
  }
  return { ok: true, message: "", data: result.data as SalesUnitPriceSourcesResponse };
}

export async function fetchNextBillNo(type: DocumentType) {
  const result = await callDocument(`/api/numbering/${encodeURIComponent(type)}/next`, "GET");
  const data = result.data as { billNo?: unknown } | undefined;
  if (!result.ok || typeof data?.billNo !== "string") {
    return { ok: false, message: result.message || "单据编号生成失败。" };
  }
  return { ok: true, message: "", billNo: data.billNo };
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

export async function acquireDocumentLock(type: OpenableDocumentType, billNo: string): Promise<{ ok: boolean; message: string; data?: DocumentLockState }> {
  return callDocumentLock(`/api/document-locks/${encodeURIComponent(type)}/${encodeURIComponent(billNo)}/acquire`, "POST");
}

export async function overrideDocumentLock(type: OpenableDocumentType, billNo: string): Promise<{ ok: boolean; message: string; data?: DocumentLockState }> {
  return callDocumentLock(`/api/document-locks/${encodeURIComponent(type)}/${encodeURIComponent(billNo)}/override`, "POST");
}

export async function releaseDocumentLock(type: OpenableDocumentType, billNo: string): Promise<{ ok: boolean; message: string; data?: DocumentLockState }> {
  return callDocumentLock(`/api/document-locks/${encodeURIComponent(type)}/${encodeURIComponent(billNo)}`, "DELETE");
}

export async function reverseDocument(type: DocumentType, billNo: string) {
  return callDocument(`${endpointByType[type]}/${encodeURIComponent(billNo)}/reverse`, "POST");
}

export async function deleteDocument(type: DocumentType, billNo: string) {
  return callDocument(`${endpointByType[type]}/${encodeURIComponent(billNo)}`, "DELETE");
}

export async function voidDocument(type: DocumentType, billNo: string) {
  return callDocument(`${endpointByType[type]}/${encodeURIComponent(billNo)}/void`, "POST");
}

export async function lifecycleDocument(type: DocumentType, billNo: string, action: "close" | "unclose" | "freeze" | "unfreeze", reason: string) {
  return callDocument(`/api/document-lifecycle/${encodeURIComponent(type)}/${encodeURIComponent(billNo)}/${action}`, "POST", { reason });
}

export async function lifecycleLine(type: DocumentType, billNo: string, lineNo: number, action: "close" | "unclose" | "freeze" | "unfreeze", reason: string) {
  return callDocument(`/api/document-lifecycle/${encodeURIComponent(type)}/${encodeURIComponent(billNo)}/lines/${encodeURIComponent(String(lineNo))}/${action}`, "POST", { reason });
}

export async function voidDocumentHardened(type: DocumentType, billNo: string, payload: { reason: string; username: string; password: string }) {
  return callDocument(`/api/document-lifecycle/${encodeURIComponent(type)}/${encodeURIComponent(billNo)}/void`, "POST", payload);
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
    remark: payload.remark,
    isTaxInclusive: payload.isTaxInclusive,
    validUntil: payload.validUntil,
    lines: payload.lines
  };
  if (type === "salesOut" || type === "salesOrder" || type === "salesQuote" || type === "deliveryNotice" || type === "otherStockOut") {
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
      return { ok: false, message: await readDocumentErrorMessage(response) };
    }
    return { ok: true, message: "", data: await response.json() };
  } catch {
    return { ok: false, message: "网络异常，单据操作失败。" };
  }
}

async function callDocumentLock(url: string, method: string): Promise<{ ok: boolean; message: string; data?: DocumentLockState }> {
  const result = await callDocument(url, method);
  if (!result.ok || !result.data) {
    return { ok: false, message: result.message || "单据锁操作失败。" };
  }
  return { ok: true, message: "", data: result.data as DocumentLockState };
}

async function readDocumentErrorMessage(response: Response) {
  const fallback = `单据操作失败（HTTP ${response.status}）。`;
  try {
    const text = await response.text();
    if (!text.trim()) {
      return fallback;
    }
    try {
      const payload = JSON.parse(text) as { reason?: string; message?: string; error?: string; detail?: string };
      return payload.reason || payload.message || payload.detail || payload.error || text;
    } catch {
      return text;
    }
  } catch {
    return fallback;
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
