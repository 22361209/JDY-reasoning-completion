export interface PurchasePlanningResult<T> {
  ok: boolean;
  status: number;
  message: string;
  data?: T;
}

export interface PurchaseRequisitionDocument {
  id?: string;
  billNo: string;
  sourcePlanId?: string;
  sourcePlanNo: string;
  billDate: string;
  department: string;
  status: string;
  totalAmount?: number | string;
  ownerName?: string;
  version?: number | string;
}

export interface PurchaseRequisitionLine {
  id: string;
  lineNo: number | string;
  sourcePlanId?: string;
  sourcePlanLineId?: string;
  sourcePlanNo?: string;
  sourceTaskId?: string;
  sourceLevel: number | string;
  sourceBomLineId?: string;
  sourceBomCode: string;
  sourceBomVersionNo?: number | string;
  sourceBomLineNo: number | string;
  sourceBomPath?: string;
  productId?: string;
  productCode: string;
  productName: string;
  spec: string;
  unit: string;
  netWeight?: number | string;
  grossWeight?: number | string;
  warehouseId?: string;
  warehouseCode: string;
  supplierId?: string;
  supplierCode: string;
  supplierName: string;
  qty: number | string;
  orderedQty: number | string;
  plannedQty: number | string;
  remainingQty: number | string;
  planDeliveryDate: string;
}

export interface PurchaseRequisitionDetail {
  action?: string;
  document: PurchaseRequisitionDocument;
  lines: PurchaseRequisitionLine[];
}

export interface PurchaseRequisitionDraftPayload {
  billNo: string;
  version?: number;
  lines: Array<{
    id: string;
    qty: number;
    supplierCode: string;
  }>;
}

export interface PurchasePlanSummary {
  id?: string;
  billNo: string;
  sourceRequisitionNo?: string;
  supplierId?: string;
  supplierCode?: string;
  supplierName?: string;
  status?: string;
  lineCount?: number | string;
  totalQty?: number | string;
}

export interface PurchaseRequisitionPushDownResult {
  requisitionNo?: string;
  purchasePlans: PurchasePlanSummary[];
}

export interface PurchasePlanDocument {
  id?: string;
  billNo: string;
  sourceRequisitionId?: string;
  sourceRequisitionNo: string;
  supplierId?: string;
  supplierCode: string;
  supplierName: string;
  billDate: string;
  department: string;
  status: string;
  ownerName?: string;
  createdAt?: string;
  updatedAt?: string;
  version?: number | string;
  totalQty?: number | string;
  lineCount?: number | string;
}

export interface PurchasePlanLine {
  id: string;
  lineNo: number | string;
  sourceRequisitionLineId?: string;
  sourceRequisitionNo?: string;
  sourceRequisitionLineNo: number | string;
  productId?: string;
  productCode: string;
  productName: string;
  spec: string;
  unit: string;
  netWeight?: number | string;
  grossWeight?: number | string;
  warehouseId?: string;
  warehouseCode: string;
  qty: number | string;
  planDeliveryDate: string;
}

export interface PurchasePlanDetail {
  action?: string;
  document: PurchasePlanDocument;
  lines: PurchasePlanLine[];
}

export function fetchPurchaseRequisitionDetail(billNo: string) {
  return requestJson<PurchaseRequisitionDetail>(
    `/api/purchase-requisitions/${encodeURIComponent(billNo)}`,
    "GET"
  );
}

export function savePurchaseRequisitionDraft(payload: PurchaseRequisitionDraftPayload) {
  return requestJson<PurchaseRequisitionDetail>("/api/purchase-requisitions/draft", "POST", payload);
}

export function auditPurchaseRequisition(billNo: string) {
  return requestJson<PurchaseRequisitionDetail>(
    `/api/purchase-requisitions/${encodeURIComponent(billNo)}/audit`,
    "POST",
    {}
  );
}

export function reversePurchaseRequisition(billNo: string) {
  return requestJson<PurchaseRequisitionDetail>(
    `/api/purchase-requisitions/${encodeURIComponent(billNo)}/reverse`,
    "POST",
    {}
  );
}

export function pushDownPurchaseRequisition(billNo: string) {
  return requestJson<PurchaseRequisitionPushDownResult>(
    `/api/purchase-requisitions/${encodeURIComponent(billNo)}/push-down`,
    "POST",
    {}
  );
}

export function fetchPurchasePlanDetail(billNo: string) {
  return requestJson<PurchasePlanDetail>(
    `/api/purchase-plans/${encodeURIComponent(billNo)}`,
    "GET"
  );
}

export function auditPurchasePlan(billNo: string) {
  return requestJson<PurchasePlanDetail>(
    `/api/purchase-plans/${encodeURIComponent(billNo)}/audit`,
    "POST",
    {}
  );
}

export function reversePurchasePlan(billNo: string) {
  return requestJson<PurchasePlanDetail>(
    `/api/purchase-plans/${encodeURIComponent(billNo)}/reverse`,
    "POST",
    {}
  );
}

export function deletePurchasePlanDraft(billNo: string) {
  return requestJson<{ billNo: string; status: string }>(
    `/api/purchase-plans/${encodeURIComponent(billNo)}`,
    "DELETE"
  );
}

async function requestJson<T>(path: string, method: "GET" | "POST" | "DELETE", payload?: object): Promise<PurchasePlanningResult<T>> {
  try {
    const response = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: payload == null ? undefined : JSON.stringify(payload)
    });
    const raw = await response.text();
    const data = parseResponse<T>(raw);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message: readErrorMessage(data, raw, response.status)
      };
    }
    return {
      ok: true,
      status: response.status,
      message: "",
      data: data as T
    };
  } catch {
    return {
      ok: false,
      status: 0,
      message: "网络异常，采购规划单据处理失败。"
    };
  }
}

function parseResponse<T>(raw: string): T | Record<string, unknown> | undefined {
  if (!raw.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function readErrorMessage(data: unknown, raw: string, status: number) {
  if (data && typeof data === "object") {
    const payload = data as Record<string, unknown>;
    for (const key of ["reason", "message", "detail", "error"]) {
      const value = payload[key];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
  }
  return raw.trim() || `采购规划单据处理失败（HTTP ${status}）。`;
}
