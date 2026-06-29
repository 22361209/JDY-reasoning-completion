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
  lines: Array<{
    materialCode: string;
    qty: number;
  }>;
}

export interface ProductionPlanPayload {
  billNo?: string;
  bomCode: string;
  warehouseCode: string;
  qty: number;
  sourceType?: string;
  departmentCode?: string;
}

export interface ProductionTaskPayload {
  billNo?: string;
  planNo?: string;
  bomCode?: string;
  warehouseCode?: string;
  qty: number;
}

async function postJson(path: string, payload: Record<string, unknown>): Promise<ProductionWriteResult> {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await parseJson(response);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message: errorMessage(data) || "生产单据保存失败。",
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
      message: "网络异常，生产单据保存失败。"
    };
  }
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

export function createProductionPlan(payload: ProductionPlanPayload) {
  return postJson("/api/production/plans", compactPayload(payload as unknown as Record<string, unknown>));
}

export function createProductionTask(payload: ProductionTaskPayload) {
  const body = compactPayload(payload as unknown as Record<string, unknown>);
  const planNo = typeof payload.planNo === "string" ? payload.planNo.trim() : "";
  if (planNo) {
    return postJson(`/api/production/plans/${encodeURIComponent(planNo)}/tasks`, body);
  }
  return postJson("/api/production/tasks", body);
}
