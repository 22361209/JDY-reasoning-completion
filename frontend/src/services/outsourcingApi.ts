export interface OutsourcingWriteResult {
  ok: boolean;
  status: number;
  message: string;
  data?: Record<string, unknown>;
}

export interface OutsourcingWorkOrderPayload {
  billNo?: string;
  sourceBillNo?: string;
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
        message: errorMessage(data) || "委外单据提交失败。",
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
      message: "网络异常，委外单据提交失败。"
    };
  }
}

async function getJson(path: string): Promise<OutsourcingWriteResult> {
  try {
    const response = await fetch(path);
    const data = await parseJson(response);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message: errorMessage(data) || "委外单据读取失败。",
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
      message: "网络异常，委外单据读取失败。"
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

export function saveOutsourcingWorkOrder(payload: OutsourcingWorkOrderPayload) {
  return postJson("/api/outsourcing/work-orders/draft", payload as unknown as Record<string, unknown>);
}

export function auditOutsourcingWorkOrder(billNo: string) {
  return postJson(`/api/outsourcing/work-orders/${encodeURIComponent(billNo)}/audit`, {});
}

export function reverseOutsourcingWorkOrder(billNo: string) {
  return postJson(`/api/outsourcing/work-orders/${encodeURIComponent(billNo)}/reverse`, {});
}

export function fetchOutsourcingWorkOrder(billNo: string) {
  return getJson(`/api/outsourcing/work-orders/${encodeURIComponent(billNo)}`);
}

export function fetchOutsourcingWorkOrderSources(target: "issue" | "receipt") {
  return getJson(`/api/outsourcing/work-orders/sources?target=${encodeURIComponent(target)}`);
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

export function reverseOutsourcingIssue(billNo: string) {
  return postJson(`/api/outsourcing/issues/${encodeURIComponent(billNo)}/reverse`, {});
}

export function fetchOutsourcingIssue(billNo: string) {
  return getJson(`/api/outsourcing/issues/${encodeURIComponent(billNo)}`);
}

export function auditOutsourcingReceipt(billNo: string) {
  return postJson(`/api/outsourcing/receipts/${encodeURIComponent(billNo)}/audit`, {});
}

export function reverseOutsourcingReceipt(billNo: string) {
  return postJson(`/api/outsourcing/receipts/${encodeURIComponent(billNo)}/reverse`, {});
}

export function fetchOutsourcingReceipt(billNo: string) {
  return getJson(`/api/outsourcing/receipts/${encodeURIComponent(billNo)}`);
}

export function fetchOutsourcingReceiptSources(target: "return" | "scrap") {
  return getJson(`/api/outsourcing/receipts/sources?target=${encodeURIComponent(target)}`);
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

export function reverseOutsourcingReturn(billNo: string) {
  return postJson(`/api/outsourcing/returns/${encodeURIComponent(billNo)}/reverse`, {});
}

export function fetchOutsourcingReturn(billNo: string) {
  return getJson(`/api/outsourcing/returns/${encodeURIComponent(billNo)}`);
}

export function auditOutsourcingScrap(billNo: string) {
  return postJson(`/api/outsourcing/scraps/${encodeURIComponent(billNo)}/audit`, {});
}

export function reverseOutsourcingScrap(billNo: string) {
  return postJson(`/api/outsourcing/scraps/${encodeURIComponent(billNo)}/reverse`, {});
}

export function fetchOutsourcingScrap(billNo: string) {
  return getJson(`/api/outsourcing/scraps/${encodeURIComponent(billNo)}`);
}
