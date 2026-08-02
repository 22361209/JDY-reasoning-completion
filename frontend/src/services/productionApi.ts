import { fetchListRows } from "./listApi";
import { exactSourceFilter, fetchSourceSelectorRows, type SourceSelectorColumnFilters } from "./sourceSelectorListApi";

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
  qty?: number;
  sourceType?: string;
  departmentCode?: string;
  planDeliveryDate?: string;
  lines?: ProductionPlanLinePayload[];
}

export interface ProductionPlanLinePayload {
  productId: string;
  productCode: string;
  bomCode?: string;
  warehouseCode?: string;
  qty: number;
  departmentCode?: string;
  planDeliveryDate?: string;
}

export interface ProductionTaskPayload {
  billNo?: string;
  planNo?: string;
  planLineNo?: number;
  bomCode?: string;
  warehouseCode?: string;
  qty: number;
}

export interface SelectableProductionTaskLine {
  billNo?: string;
  planNo?: string;
  billDate?: string;
  department?: string;
  productId?: string;
  productCode?: string;
  productName?: string;
  spec?: string;
  unit?: string;
  warehouseCode?: string;
  bomCode?: string;
  bomVersionNo?: number | string;
  taskQty?: number | string;
  completedQty?: number | string;
  remainingProductQty?: number | string;
  issuedSets?: number | string;
  completableQty?: number | string;
  requiredQty?: number | string;
  issuedQty?: number | string;
  remainingQty?: number | string;
}

export interface MaterialIssuePreviewLine {
  lineNo?: number | string;
  sourceLineNo?: number | string;
  productId?: string;
  productCode?: string;
  productName?: string;
  spec?: string;
  unit?: string;
  netWeight?: number | string;
  grossWeight?: number | string;
  warehouseCode?: string;
  remainingQty?: number | string;
  stockOnHand?: number | string;
  stockReserved?: number | string;
  stockAvailable?: number | string;
  stockInTransit?: number | string;
  qty?: number | string;
}

export interface MaterialIssuePreview {
  document?: {
    sourceOrderNo?: string;
    billDate?: string;
    department?: string;
    status?: string;
    closeStatus?: string;
    frozenStatus?: string;
  };
  productInfo?: {
    productCode?: string;
    productName?: string;
    spec?: string;
    unit?: string;
    warehouseCode?: string;
    taskQty?: number | string;
    remainingQty?: number | string;
    bomCode?: string;
    bomVersionNo?: number | string;
  };
  lines?: MaterialIssuePreviewLine[];
}

export interface MaterialScrapLine {
  id?: string;
  lineNo?: number | string;
  sourceIssueLineId: string;
  productId?: string;
  productCode: string;
  productName: string;
  spec: string;
  unit: string;
  sourceWarehouseId?: string;
  sourceWarehouseCode: string;
  issueQty: number | string;
  availableScrapQty: number | string;
  scrapQty: number | string;
  scrapReason: string;
  reissueQty: number | string;
  isStockIn: boolean;
  targetWarehouseId?: string;
  targetWarehouseCode: string;
  stockInStatus: "NOT_REQUIRED" | "PENDING" | "STOCKED_IN" | "REVERSED" | string;
}

export interface MaterialScrapDocument {
  id?: string;
  billNo: string;
  billDate: string;
  businessType: "PRODUCTION_SCRAP" | string;
  sourceIssueId?: string;
  sourceIssueNo: string;
  workshopId?: string;
  workshopCode: string;
  workshopName: string;
  status: "PREVIEW" | "DRAFT" | "AUDITED" | "VOID" | string;
  closeStatus?: string;
  frozenStatus?: string;
  stockInStatus: "NOT_REQUIRED" | "PENDING" | "STOCKED_IN" | "REVERSED" | string;
  version?: number | string;
}

export interface MaterialScrapDetail {
  action?: string;
  document?: Partial<MaterialScrapDocument>;
  lines?: MaterialScrapLine[];
}

export interface MaterialScrapDraftPayload {
  billNo?: string;
  sourceIssueNo: string;
  billDate: string;
  businessType: "PRODUCTION_SCRAP";
  lines: Array<{
    sourceIssueLineId: string;
    scrapQty: number | string;
    scrapReason?: string;
    reissueQty: number | string;
    isStockIn: boolean;
    targetWarehouseCode?: string;
  }>;
}

export interface SelectableMaterialScrapSourceLine {
  id?: string;
  billNo?: string;
  billDate?: string;
  workshopCode?: string;
  workshopName?: string;
  sourceIssueLineId?: string;
  lineNo?: number | string;
  productId?: string;
  productCode?: string;
  productName?: string;
  spec?: string;
  unit?: string;
  sourceWarehouseCode?: string;
  issueQty?: number | string;
  availableScrapQty?: number | string;
}

export interface ProductionSourceSelectorQuery {
  keyword: string;
  columnFilters?: SourceSelectorColumnFilters;
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

export function fetchProductionPlanDetail(billNo: string) {
  return requestJson(`/api/production/plans/${encodeURIComponent(billNo)}`, "GET");
}

export function auditProductionPlan(billNo: string) {
  return postJson(`/api/production/plans/${encodeURIComponent(billNo)}/audit`, {});
}

export function reverseProductionPlan(billNo: string) {
  return postJson(`/api/production/plans/${encodeURIComponent(billNo)}/reverse`, {});
}

export function pushDownProductionPlan(billNo: string) {
  return postJson(`/api/production/plans/${encodeURIComponent(billNo)}/push-down`, {});
}

export function pushDownMaterialIssueProductIn(billNo: string) {
  return postJson(`/api/production/material-issues/${encodeURIComponent(billNo)}/push-product-in`, {});
}

export function fetchMaterialScrapDetail(billNo: string) {
  return requestJson(`/api/production/material-scraps/${encodeURIComponent(billNo)}`, "GET");
}

export function fetchMaterialScrapPreview(issueBillNo: string) {
  return requestJson(`/api/production/material-issues/${encodeURIComponent(issueBillNo)}/material-scrap-preview`, "GET");
}

export function pushDownMaterialIssueScrap(issueBillNo: string) {
  return postJson(`/api/production/material-issues/${encodeURIComponent(issueBillNo)}/push-material-scrap`, {});
}

export function saveMaterialScrapDraft(payload: MaterialScrapDraftPayload) {
  return postJson(
    "/api/production/material-scraps/draft",
    compactPayload(payload as unknown as Record<string, unknown>)
  );
}

export function auditMaterialScrap(billNo: string) {
  return postJson(`/api/production/material-scraps/${encodeURIComponent(billNo)}/audit`, {});
}

export function reverseMaterialScrap(billNo: string) {
  return postJson(`/api/production/material-scraps/${encodeURIComponent(billNo)}/reverse`, {});
}

export function deleteMaterialScrap(billNo: string) {
  return requestJson(`/api/production/material-scraps/${encodeURIComponent(billNo)}`, "DELETE");
}

export function stockInMaterialScrap(billNo: string) {
  return postJson(`/api/production/material-scraps/${encodeURIComponent(billNo)}/stock-in`, {});
}

export function reverseStockInMaterialScrap(billNo: string) {
  return postJson(`/api/production/material-scraps/${encodeURIComponent(billNo)}/reverse-stock-in`, {});
}

export function fetchMaterialIssuePreviewFromTask(taskBillNo: string) {
  return requestJson(`/api/production/tasks/${encodeURIComponent(taskBillNo)}/material-issue-preview`, "GET");
}

export function pushDownProductionTaskMaterialIssue(taskBillNo: string, payload: { billNo?: string; materialWarehouseCode: string }) {
  return postJson(`/api/production/tasks/${encodeURIComponent(taskBillNo)}/issue`, compactPayload(payload));
}

export function fetchProductionTaskDetail(billNo: string) {
  return requestJson(`/api/production/tasks/${encodeURIComponent(billNo)}`, "GET");
}

export function auditProductionTask(billNo: string) {
  return postJson(`/api/production/tasks/${encodeURIComponent(billNo)}/audit`, {});
}

export function reverseProductionTask(billNo: string) {
  return postJson(`/api/production/tasks/${encodeURIComponent(billNo)}/reverse`, {});
}

export function lifecycleProductionTask(billNo: string, action: "close" | "unclose" | "freeze" | "unfreeze", reason: string) {
  return postJson(`/api/document-lifecycle/productionTask/${encodeURIComponent(billNo)}/${action}`, { reason });
}

export function voidProductionTask(billNo: string, payload: { reason: string; username: string; password: string }) {
  return postJson(`/api/document-lifecycle/productionTask/${encodeURIComponent(billNo)}/void`, payload);
}

export function createProductionTask(payload: ProductionTaskPayload) {
  const body = compactPayload(payload as unknown as Record<string, unknown>);
  const planNo = typeof payload.planNo === "string" ? payload.planNo.trim() : "";
  if (planNo) {
    return postJson(`/api/production/plans/${encodeURIComponent(planNo)}/tasks`, body);
  }
  return postJson("/api/production/tasks", body);
}

export async function fetchSelectableProductionTasks(query: ProductionSourceSelectorQuery) {
  const result = await fetchSourceSelectorRows({
    listKey: "production-task-source-selector",
    keyword: query.keyword,
    columnFilters: query.columnFilters,
    pageSize: 1000
  });
  return {
    ok: result.ok,
    message: result.message,
    data: result.rows as SelectableProductionTaskLine[]
  };
}

export async function fetchSelectableProductInTasks(query: ProductionSourceSelectorQuery) {
  const result = await fetchSourceSelectorRows({
    listKey: "product-in-task-source-selector",
    keyword: query.keyword,
    columnFilters: query.columnFilters,
    pageSize: 1000
  });
  return {
    ok: result.ok,
    message: result.message,
    data: result.rows as SelectableProductionTaskLine[]
  };
}

export async function fetchSelectableMaterialScrapSources(query: ProductionSourceSelectorQuery) {
  const result = await fetchSourceSelectorRows({
    listKey: "material-scrap-source-selector",
    keyword: query.keyword,
    columnFilters: query.columnFilters,
    pageSize: 1000
  });
  return {
    ok: result.ok,
    message: result.message,
    data: result.rows as SelectableMaterialScrapSourceLine[]
  };
}

export async function checkMaterialScrapPushEligibility(issueBillNo: string) {
  const billNo = issueBillNo.trim();
  if (!billNo) {
    return { ok: true, message: "", eligible: false };
  }
  const result = await fetchListRows("material-scrap-source-selector", {
    keyword: "",
    page: 1,
    pageSize: 1,
    view: "detail",
    columnFilters: exactSourceFilter("billNo", billNo)
  });
  const eligible = Boolean(
    result.ok
    && (result.data?.total ?? 0) > 0
    && result.data?.rows.some((row) => String(row.billNo ?? "") === billNo)
  );
  return {
    ok: result.ok,
    message: result.message,
    eligible
  };
}
