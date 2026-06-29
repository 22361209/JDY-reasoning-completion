export interface OutsourcingWriteResult {
  ok: boolean;
  status: number;
  message: string;
  data?: Record<string, unknown>;
}

export interface OutsourcingSurfacePayload {
  billNo?: string;
  sourceBillNo?: string;
  productCode?: string;
  qty?: number;
  processorSupplierCode?: string;
  surfaceTreatment?: string;
  remark?: string;
}

export interface OutsourcingWorkOrderPayload {
  billNo?: string;
  supplierCode?: string;
  productCode?: string;
  qty?: number;
  planDeliveryDate?: string;
  remark?: string;
}

async function postJson(path: string, payload: Record<string, unknown>): Promise<OutsourcingWriteResult> {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(compactPayload(payload))
    });
    const data = await parseJson(response);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message: errorMessage(data) || "委外表面处理单提交失败。",
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
      message: "网络异常，委外表面处理单提交失败。"
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

export function saveOutsourcingSurface(payload: OutsourcingSurfacePayload) {
  return postJson("/api/outsourcing/surface-processes/draft", payload as unknown as Record<string, unknown>);
}

export function auditOutsourcingSurface(billNo: string) {
  return postJson(`/api/outsourcing/surface-processes/${encodeURIComponent(billNo)}/audit`, {});
}

export function completeOutsourcingSurface(billNo: string) {
  return postJson(`/api/outsourcing/surface-processes/${encodeURIComponent(billNo)}/complete`, {});
}

export function saveOutsourcingWorkOrder(payload: OutsourcingWorkOrderPayload) {
  return postJson("/api/outsourcing/work-orders/draft", payload as unknown as Record<string, unknown>);
}

export function auditOutsourcingWorkOrder(billNo: string) {
  return postJson(`/api/outsourcing/work-orders/${encodeURIComponent(billNo)}/audit`, {});
}

export function pushOutsourcingIssue(billNo: string) {
  return postJson(`/api/outsourcing/work-orders/${encodeURIComponent(billNo)}/push-issue`, {});
}

export function pushOutsourcingReceipt(billNo: string, qty?: number) {
  return postJson(`/api/outsourcing/work-orders/${encodeURIComponent(billNo)}/push-receipt`, qty == null ? {} : { qty });
}

export function auditOutsourcingIssue(billNo: string) {
  return postJson(`/api/outsourcing/issues/${encodeURIComponent(billNo)}/audit`, {});
}

export function auditOutsourcingReceipt(billNo: string) {
  return postJson(`/api/outsourcing/receipts/${encodeURIComponent(billNo)}/audit`, {});
}

export function pushOutsourcingReturn(billNo: string, qty?: number) {
  return postJson(`/api/outsourcing/receipts/${encodeURIComponent(billNo)}/push-return`, qty == null ? {} : { qty });
}

export function pushOutsourcingScrap(billNo: string, qty?: number) {
  return postJson(`/api/outsourcing/receipts/${encodeURIComponent(billNo)}/push-scrap`, qty == null ? {} : { qty });
}

export function auditOutsourcingReturn(billNo: string) {
  return postJson(`/api/outsourcing/returns/${encodeURIComponent(billNo)}/audit`, {});
}

export function auditOutsourcingScrap(billNo: string) {
  return postJson(`/api/outsourcing/scraps/${encodeURIComponent(billNo)}/audit`, {});
}
