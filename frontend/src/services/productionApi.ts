export interface ProductionWriteResult {
  ok: boolean;
  status: number;
  message: string;
  data?: Record<string, unknown>;
}

export interface BomPayload {
  code: string;
  productCode: string;
  qty: number;
  bomCategory?: string;
  remark?: string;
  lines: Array<{
    materialCode: string;
    qty?: number;
    productQty?: number;
    materialQty?: number;
    unitQty?: number;
    issueMethod?: string;
    issueWarehouseCode?: string;
    fixedLossQty?: number;
    lossRate?: number;
    childBomCode?: string;
  }>;
}

export interface BomAuditConfirmation {
  confirmNewVersion?: boolean;
  latestBomCode?: string;
  latestVersionNo?: string | number;
}

export interface ProductionPlanPayload {
  billNo?: string;
  productCode?: string;
  bomCode?: string;
  warehouseCode?: string;
  qty: number;
  sourceType?: string;
  departmentCode?: string;
  planDeliveryDate?: string;
}

export interface ProductionTaskPayload {
  billNo?: string;
  planNo?: string;
  bomCode?: string;
  warehouseCode?: string;
  qty: number;
}

async function requestJson(path: string, method: "GET" | "POST" | "DELETE", payload?: Record<string, unknown>): Promise<ProductionWriteResult> {
  try {
    const response = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: payload == null ? undefined : JSON.stringify(payload)
    });
    const data = await parseJson(response);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message: errorMessage(data) || "生产单据处理失败。",
        data
      };
    }
    return {
      ok: true,
      status: response.status,
      message: "",
      data
    };
  } catch {
    return {
      ok: false,
      status: 0,
      message: "网络异常，生产单据处理失败。"
    };
  }
}

async function postJson(path: string, payload: Record<string, unknown>): Promise<ProductionWriteResult> {
  return requestJson(path, "POST", payload);
}

async function parseJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function errorMessage(data: Record<string, unknown> | undefined) {
  const message = data?.message ?? data?.error;
  return typeof message === "string" ? message : "";
}

function compactPayload(payload: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== "" && value !== undefined && value !== null)
  );
}

export function saveBom(payload: BomPayload) {
  return postJson("/api/production/boms", compactPayload(payload as unknown as Record<string, unknown>));
}

export function fetchBomDetail(code: string) {
  return requestJson(`/api/production/boms/${encodeURIComponent(code)}`, "GET");
}

export function fetchBomAuditPreview(code: string) {
  return requestJson(`/api/production/boms/${encodeURIComponent(code)}/audit-preview`, "GET");
}

export function auditBom(code: string, confirmation: BomAuditConfirmation = {}) {
  return postJson(`/api/production/boms/${encodeURIComponent(code)}/audit`, compactPayload(confirmation as Record<string, unknown>));
}

export function reverseBom(code: string) {
  return postJson(`/api/production/boms/${encodeURIComponent(code)}/reverse`, {});
}

export function setBomEnabled(code: string, enabled: boolean) {
  return postJson(`/api/production/boms/${encodeURIComponent(code)}/${enabled ? "enable" : "disable"}`, {});
}

export function deleteBom(code: string) {
  return requestJson(`/api/production/boms/${encodeURIComponent(code)}`, "DELETE");
}

export function createProductionPlan(payload: ProductionPlanPayload) {
  return postJson("/api/production/plans", compactPayload(payload as unknown as Record<string, unknown>));
}

export function auditProductionPlan(billNo: string) {
  return postJson(`/api/production/plans/${encodeURIComponent(billNo)}/audit`, {});
}

export function reverseProductionPlan(billNo: string) {
  return postJson(`/api/production/plans/${encodeURIComponent(billNo)}/reverse`, {});
}

export function nextProductionPlanNumber() {
  return postJson("/api/production/plans/next-number", {});
}

export function pushDownProductionPlan(billNo: string) {
  return postJson(`/api/production/plans/${encodeURIComponent(billNo)}/push-down`, {});
}

export function pushDownMaterialIssueProductIn(billNo: string) {
  return postJson(`/api/production/material-issues/${encodeURIComponent(billNo)}/push-product-in`, {});
}

export function createProductionTask(payload: ProductionTaskPayload) {
  const body = compactPayload(payload as unknown as Record<string, unknown>);
  const planNo = typeof payload.planNo === "string" ? payload.planNo.trim() : "";
  if (planNo) {
    return postJson(`/api/production/plans/${encodeURIComponent(planNo)}/tasks`, body);
  }
  return postJson("/api/production/tasks", body);
}
