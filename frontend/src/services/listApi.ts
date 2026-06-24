export interface ListQuery {
  keyword: string;
  status: string;
  page: number;
  pageSize: number;
  sortField?: string;
  sortOrder?: "asc" | "desc" | "";
  module?: string;
  action?: string;
  operator?: string;
  targetType?: string;
  dateFrom?: string;
  dateTo?: string;
  columnFilters?: Record<string, { operator: string; value: string }>;
}

export interface ListResponse {
  page: number;
  pageSize: number;
  total: number;
  sortField?: string;
  sortOrder?: string;
  rows: Record<string, unknown>[];
}

export interface ListFetchResult {
  ok: boolean;
  status: number;
  forbidden: boolean;
  message: string;
  data: ListResponse | null;
}

export interface ListExportResult {
  ok: boolean;
  status: number;
  message: string;
  blob: Blob | null;
  fileName: string;
}

export async function fetchListRows(listKey: string, query: ListQuery): Promise<ListFetchResult> {
  const search = buildListSearch(query);
  try {
    const response = await fetch(`/api/lists/${encodeURIComponent(listKey)}?${search.toString()}`);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        forbidden: response.status === 403,
        message: response.status === 403 ? "当前账号无权查看该列表。" : "列表数据加载失败，请稍后重试。",
        data: null
      };
    }
    return {
      ok: true,
      status: response.status,
      forbidden: false,
      message: "",
      data: await response.json() as ListResponse
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

export async function exportListRows(listKey: string, query: ListQuery): Promise<ListExportResult> {
  const search = buildListSearch({ ...query, page: 1, pageSize: Math.max(query.pageSize, 1000) });
  try {
    const response = await fetch(`/api/lists/${encodeURIComponent(listKey)}/export.csv?${search.toString()}`);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message: response.status === 403 ? "当前账号无权引出该列表。" : "列表引出失败，请稍后重试。",
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

function buildListSearch(query: ListQuery) {
  const search = new URLSearchParams({
    keyword: query.keyword,
    status: query.status,
    page: String(query.page),
    pageSize: String(query.pageSize)
  });
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
  if (query.dateFrom) {
    search.set("dateFrom", query.dateFrom);
  }
  if (query.dateTo) {
    search.set("dateTo", query.dateTo);
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
      return {
        ok: false,
        status: response.status,
        forbidden: response.status === 403,
        message: response.status === 409 ? "编码已存在，请更换编码。" : "新增资料失败，请检查必填项。",
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

export async function setMasterDataStatus(type: string, code: string, enabled: boolean): Promise<ListFetchResult> {
  return writeMasterData(`/api/master-data/${encodeURIComponent(type)}/${encodeURIComponent(code)}/status`, "PATCH", {
    status: enabled ? "启用" : "禁用"
  });
}

export async function deleteMasterData(type: string, code: string): Promise<ListFetchResult> {
  return writeMasterData(`/api/master-data/${encodeURIComponent(type)}/${encodeURIComponent(code)}`, "DELETE", {});
}

async function writeMasterData(url: string, method: string, payload: Record<string, string>): Promise<ListFetchResult> {
  try {
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "DELETE" ? undefined : JSON.stringify(payload)
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        forbidden: response.status === 403,
        message: response.status === 409 ? "编码已存在，请更换编码。" : "资料保存失败，请检查必填项和状态。",
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
