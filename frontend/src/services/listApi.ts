export interface ListQuery {
  keyword: string;
  status?: string;
  page: number;
  pageSize: number;
  view?: "header" | "detail";
  sortField?: string;
  sortOrder?: "asc" | "desc" | "";
  module?: string;
  action?: string;
  operator?: string;
  targetType?: string;
  actorType?: string;
  scope?: "current" | "platform" | "historical";
  dateFrom?: string;
  dateTo?: string;
  snapshotToken?: string;
  columnFilters?: Record<string, { operator: string; value: string }>;
}

export interface ListResponse {
  page: number;
  pageSize: number;
  view?: "header" | "detail";
  total: number;
  sortField?: string;
  sortOrder?: string;
  scope?: "current" | "platform" | "historical";
  snapshotToken?: string;
  rows: Record<string, unknown>[];
}

export interface OperationLogDetail {
  id: string;
  operatedAt: string;
  module: string;
  action: string;
  actorType: string;
  actorUsername: string;
  actorDisplayName: string;
  operator: string;
  accountSetId: string;
  accountSetCode: string;
  accountSetName: string;
  targetType: string;
  targetId: string;
  targetNo: string;
  success: boolean;
  status: string;
  reason: string;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
}

export interface ListFetchResult {
  ok: boolean;
  status: number;
  forbidden: boolean;
  message: string;
  data: ListResponse | null;
}

export interface ListFetchOptions {
  parseResponse?: (text: string) => ListResponse;
}

export type MasterDataPatchValue = string | number | boolean | null;

export interface MasterDataPatchRequest {
  version: number;
  changes: Record<string, MasterDataPatchValue>;
}

export interface ListExportResult {
  ok: boolean;
  status: number;
  message: string;
  blob: Blob | null;
  fileName: string;
}

export interface ListFilterPreset {
  id: string;
  listKey?: string;
  name: string;
  roleCode?: string;
  userName?: string;
  query: Record<string, string>;
  columnFilters: Record<string, { operator: string; value: string }>;
  shared?: boolean;
  isDefault?: boolean;
  readOnly?: boolean;
  updatedAt?: string;
}

export interface StockAlertSetting {
  id: string;
  productCode: string;
  productName: string;
  spec: string;
  unit: string;
  warehouseCode: string;
  warehouseName: string;
  safetyQty: string;
  maxQty: string;
  updatedAt: string;
}

export interface StockAlertSettingPayload {
  productCode: string;
  warehouseCode: string;
  safetyQty: number;
  maxQty: number | null;
}

export interface ListPresetResult {
  ok: boolean;
  status: number;
  message: string;
  data: ListFilterPreset[];
}

export interface ListPresetWriteResult {
  ok: boolean;
  status: number;
  message: string;
  data: ListFilterPreset | null;
}

export async function fetchListRows(listKey: string, query: ListQuery, options: ListFetchOptions = {}): Promise<ListFetchResult> {
  const search = buildListSearch(query);
  try {
    const response = await fetch(`/api/lists/${encodeURIComponent(listKey)}?${search.toString()}`);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        forbidden: response.status === 403,
        message: response.status === 403
          ? "当前账号无权查看该列表。"
          : response.status === 404
            ? "该列表未定义或尚未开放。"
            : response.status === 409
              ? "列表数据已变化，请重新加载。"
            : "列表数据加载失败，请稍后重试。",
        data: null
      };
    }
    const data = options.parseResponse
      ? options.parseResponse(await response.text())
      : await response.json() as ListResponse;
    return {
      ok: true,
      status: response.status,
      forbidden: false,
      message: "",
      data
    };
  } catch {
    return {
      ok: false,
      status: 0,
      forbidden: false,
      message: "网络异常，列表数据加载失败。",
      data: null
    };
  }
}

export async function fetchSnapshotListRows(
  listKey: string,
  query: Omit<ListQuery, "page" | "snapshotToken">,
  options: ListFetchOptions = {}
): Promise<ListFetchResult> {
  const rows: Record<string, unknown>[] = [];
  const rowIds = new Set<string>();
  let page = 1;
  let expectedTotal: number | null = null;
  let snapshotToken = "";

  while (true) {
    const result = await fetchListRows(listKey, {
      ...query,
      page,
      snapshotToken: page === 1 ? undefined : snapshotToken
    }, options);
    if (!result.ok || !result.data) {
      return result;
    }

    const pageRows = result.data.rows;
    const total = Number(result.data.total);
    const responseToken = String(result.data.snapshotToken ?? "").trim();
    if (
      !Array.isArray(pageRows)
      || !Number.isSafeInteger(total)
      || total < 0
      || result.data.page !== page
      || result.data.pageSize !== query.pageSize
      || !responseToken
      || (snapshotToken && responseToken !== snapshotToken)
      || (expectedTotal !== null && total !== expectedTotal)
      || rows.length + pageRows.length > total
      || (pageRows.length === 0 && rows.length < total)
    ) {
      return snapshotListFailure();
    }

    expectedTotal = total;
    snapshotToken = responseToken;
    for (const row of pageRows) {
      const id = String(row.id ?? "");
      if (!id || rowIds.has(id)) {
        return snapshotListFailure();
      }
      rowIds.add(id);
      rows.push(row);
    }

    if (rows.length === total) {
      return {
        ok: true,
        status: result.status,
        forbidden: false,
        message: "",
        data: {
          ...result.data,
          page: 1,
          total,
          snapshotToken,
          rows
        }
      };
    }
    page += 1;
  }
}

function snapshotListFailure(): ListFetchResult {
  return {
    ok: false,
    status: 409,
    forbidden: false,
    message: "列表数据已变化，请重新加载。",
    data: null
  };
}

export async function exportListRows(listKey: string, query: ListQuery): Promise<ListExportResult> {
  const search = buildListSearch({ ...query, page: 1, pageSize: Math.max(query.pageSize, 1000) });
  try {
    const response = await fetch(`/api/lists/${encodeURIComponent(listKey)}/export.csv?${search.toString()}`);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message: response.status === 403
          ? "当前账号无权引出该列表。"
          : response.status === 404
            ? "该列表未定义或尚未开放，无法引出。"
            : "列表引出失败，请稍后重试。",
        blob: null,
        fileName: ""
      };
    }
    return {
      ok: true,
      status: response.status,
      message: "",
      blob: await response.blob(),
      fileName: exportFileName(response.headers.get("content-disposition"), listKey)
    };
  } catch {
    return {
      ok: false,
      status: 0,
      message: "网络异常，列表引出失败。",
      blob: null,
      fileName: ""
    };
  }
}

export async function fetchOperationLogDetail(
  id: string,
  scope: "current" | "platform" | "historical"
): Promise<{ ok: boolean; status: number; message: string; data: OperationLogDetail | null }> {
  try {
    const search = new URLSearchParams({ scope });
    const response = await fetch(`/api/lists/operation-log-list/rows/${encodeURIComponent(id)}?${search.toString()}`);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message: response.status === 404 ? "该日志不属于当前查看范围或已不存在。" : "操作日志详情加载失败。",
        data: null
      };
    }
    return { ok: true, status: response.status, message: "", data: await response.json() as OperationLogDetail };
  } catch {
    return { ok: false, status: 0, message: "网络异常，操作日志详情加载失败。", data: null };
  }
}

export async function fetchListPresets(listKey: string): Promise<ListPresetResult> {
  try {
    const response = await fetch(`/api/list-presets/${encodeURIComponent(listKey)}`);
    if (!response.ok) {
      return { ok: false, status: response.status, message: "筛选预设加载失败。", data: [] };
    }
    return { ok: true, status: response.status, message: "", data: await response.json() as ListFilterPreset[] };
  } catch {
    return { ok: false, status: 0, message: "网络异常，筛选预设加载失败。", data: [] };
  }
}

export async function saveListPreset(listKey: string, preset: Omit<ListFilterPreset, "id">): Promise<ListPresetWriteResult> {
  try {
    const response = await fetch(`/api/list-presets/${encodeURIComponent(listKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(preset)
    });
    if (!response.ok) {
      return { ok: false, status: response.status, message: "筛选预设保存失败。", data: null };
    }
    return { ok: true, status: response.status, message: "", data: await response.json() as ListFilterPreset };
  } catch {
    return { ok: false, status: 0, message: "网络异常，筛选预设保存失败。", data: null };
  }
}

export async function deleteListPreset(listKey: string, presetId: string): Promise<{ ok: boolean; status: number; message: string }> {
  try {
    const response = await fetch(`/api/list-presets/${encodeURIComponent(listKey)}/${encodeURIComponent(presetId)}`, {
      method: "DELETE"
    });
    if (!response.ok) {
      return { ok: false, status: response.status, message: "筛选预设删除失败。" };
    }
    return { ok: true, status: response.status, message: "" };
  } catch {
    return { ok: false, status: 0, message: "网络异常，筛选预设删除失败。" };
  }
}

export async function fetchStockAlertSettings(): Promise<{ ok: boolean; status: number; message: string; data: StockAlertSetting[] }> {
  try {
    const response = await fetch("/api/inventory/stock-alert-settings");
    if (!response.ok) {
      return { ok: false, status: response.status, message: "安全库存设置加载失败。", data: [] };
    }
    return { ok: true, status: response.status, message: "", data: await response.json() as StockAlertSetting[] };
  } catch {
    return { ok: false, status: 0, message: "网络异常，安全库存设置加载失败。", data: [] };
  }
}

export async function saveStockAlertSetting(payload: StockAlertSettingPayload): Promise<{ ok: boolean; status: number; message: string }> {
  try {
    const response = await fetch("/api/inventory/stock-alert-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, status: response.status, message: text || "安全库存设置保存失败。" };
    }
    return { ok: true, status: response.status, message: "" };
  } catch {
    return { ok: false, status: 0, message: "网络异常，安全库存设置保存失败。" };
  }
}

export async function deleteStockAlertSetting(id: string): Promise<{ ok: boolean; status: number; message: string }> {
  try {
    const response = await fetch(`/api/inventory/stock-alert-settings/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) {
      return { ok: false, status: response.status, message: "安全库存设置删除失败。" };
    }
    return { ok: true, status: response.status, message: "" };
  } catch {
    return { ok: false, status: 0, message: "网络异常，安全库存设置删除失败。" };
  }
}

function buildListSearch(query: ListQuery) {
  const search = new URLSearchParams({
    keyword: query.keyword,
    page: String(query.page),
    pageSize: String(query.pageSize)
  });
  if (query.status) {
    search.set("status", query.status);
  }
  if (query.view) {
    search.set("view", query.view);
  }
  if (query.sortField) {
    search.set("sortField", query.sortField);
    search.set("sortOrder", query.sortOrder || "asc");
  }
  if (query.module) {
    search.set("module", query.module);
  }
  if (query.action) {
    search.set("action", query.action);
  }
  if (query.operator) {
    search.set("operator", query.operator);
  }
  if (query.targetType) {
    search.set("targetType", query.targetType);
  }
  if (query.actorType) {
    search.set("actorType", query.actorType);
  }
  if (query.scope) {
    search.set("scope", query.scope);
  }
  if (query.dateFrom) {
    search.set("dateFrom", query.dateFrom);
  }
  if (query.dateTo) {
    search.set("dateTo", query.dateTo);
  }
  if (query.snapshotToken) {
    search.set("snapshotToken", query.snapshotToken);
  }
  if (query.columnFilters && Object.keys(query.columnFilters).length) {
    search.set("columnFilters", JSON.stringify(query.columnFilters));
  }
  return search;
}

function exportFileName(contentDisposition: string | null, listKey: string) {
  if (!contentDisposition) {
    return `${listKey}-export.csv`;
  }
  const match = contentDisposition.match(/filename="?([^"]+)"?/i);
  return match?.[1] ?? `${listKey}-export.csv`;
}

export async function createMasterData(type: string, payload: Record<string, string>): Promise<ListFetchResult> {
  try {
    const response = await fetch(`/api/master-data/${encodeURIComponent(type)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const message = await masterDataErrorMessage(response, "新增资料失败，请检查必填项。");
      return {
        ok: false,
        status: response.status,
        forbidden: response.status === 403,
        message,
        data: null
      };
    }
    return {
      ok: true,
      status: response.status,
      forbidden: false,
      message: "",
      data: { page: 1, pageSize: 1, total: 1, rows: [await response.json() as Record<string, unknown>] }
    };
  } catch {
    return {
      ok: false,
      status: 0,
      forbidden: false,
      message: "网络异常，新增资料失败。",
      data: null
    };
  }
}

export async function updateMasterData(type: string, code: string, payload: Record<string, string>): Promise<ListFetchResult> {
  return writeMasterData(`/api/master-data/${encodeURIComponent(type)}/${encodeURIComponent(code)}`, "PUT", payload);
}

export async function patchMasterData(type: string, code: string, payload: MasterDataPatchRequest): Promise<ListFetchResult> {
  return writeMasterData(`/api/master-data/${encodeURIComponent(type)}/${encodeURIComponent(code)}`, "PATCH", payload);
}

export async function setMasterDataStatus(type: string, code: string, enabled: boolean): Promise<ListFetchResult> {
  return writeMasterData(`/api/master-data/${encodeURIComponent(type)}/${encodeURIComponent(code)}/status`, "PATCH", {
    status: enabled ? "启用" : "禁用"
  });
}

export async function auditMasterData(type: string, code: string): Promise<ListFetchResult> {
  return writeMasterData(`/api/master-data/${encodeURIComponent(type)}/${encodeURIComponent(code)}/audit`, "POST", {});
}

export async function reverseAuditMasterData(type: string, code: string): Promise<ListFetchResult> {
  return writeMasterData(`/api/master-data/${encodeURIComponent(type)}/${encodeURIComponent(code)}/reverse`, "POST", {});
}

export async function deleteMasterData(type: string, code: string): Promise<ListFetchResult> {
  return writeMasterData(`/api/master-data/${encodeURIComponent(type)}/${encodeURIComponent(code)}`, "DELETE", {});
}

async function writeMasterData(url: string, method: string, payload: object): Promise<ListFetchResult> {
  try {
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "DELETE" ? undefined : JSON.stringify(payload)
    });
    if (!response.ok) {
      const message = await masterDataErrorMessage(response, "资料保存失败，请检查必填项和状态。");
      return {
        ok: false,
        status: response.status,
        forbidden: response.status === 403,
        message,
        data: null
      };
    }
    return {
      ok: true,
      status: response.status,
      forbidden: false,
      message: "",
      data: { page: 1, pageSize: 1, total: 1, rows: [await response.json() as Record<string, unknown>] }
    };
  } catch {
    return {
      ok: false,
      status: 0,
      forbidden: false,
      message: "网络异常，资料保存失败。",
      data: null
    };
  }
}

async function masterDataErrorMessage(response: Response, fallback: string) {
  const text = await response.text();
  const serverMessage = extractServerMessage(text);
  if (serverMessage === "code already exists") {
    return "编码已存在，请更换编码。";
  }
  if (serverMessage) {
    return serverMessage;
  }
  return ({
    400: "提交的资料字段或格式不正确。",
    403: "当前账号无权维护该资料。",
    404: "该资料已不存在，请返回列表刷新。",
    405: "当前资料更新方式已停用，请刷新页面后重试。",
    409: "该资料已被其他操作修改，或当前状态不允许编辑；请保留当前输入并刷新确认。"
  } as Record<number, string>)[response.status] ?? fallback;
}

function extractServerMessage(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const body = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ["message", "detail", "reason"]) {
      const value = body[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  } catch {
    return trimmed;
  }
  return "";
}
