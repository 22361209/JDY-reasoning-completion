import {
  isMasterDataImportType,
  masterDataImportDefinitions,
  type MasterDataImportType
} from "../modules/master-data/import/importRegistry";

export type MasterDataImportJobStatus = "VALIDATED" | "INVALID" | "COMMITTED" | "STALE" | "FAILED" | "EXPIRED";

export interface MasterDataImportTemplate {
  type: MasterDataImportType;
  label: string;
  templateVersion: number;
  fileName: string;
  description: string;
}

export interface MasterDataImportError {
  rowNo: number;
  field: string;
  code: string;
  message: string;
  value: string;
}

export interface MasterDataImportRow {
  rowNo: number;
  businessCode: string;
  valid: boolean;
  payload: Record<string, unknown>;
  errors: MasterDataImportError[];
}

export interface MasterDataImportJob {
  id: string;
  type: MasterDataImportType;
  templateVersion: number;
  fileName: string;
  fileSha256: string;
  fileSizeBytes: number;
  status: MasterDataImportJobStatus;
  totalRows: number;
  validRows: number;
  errorRows: number;
  committedRows: number;
  canConfirm: boolean;
  createdAt: string;
  expiresAt: string;
  committedAt: string;
  version: number;
  rows: MasterDataImportRow[];
  rowPage: number;
  rowPageSize: number;
  rowTotal: number;
}

export interface MasterDataImportJobPage {
  page: number;
  pageSize: number;
  total: number;
  jobs: MasterDataImportJob[];
}

export interface MasterDataImportApiResult<T> {
  ok: boolean;
  status: number;
  message: string;
  data: T | null;
  aborted: boolean;
}

export interface MasterDataImportDownloadResult {
  ok: boolean;
  status: number;
  message: string;
  blob: Blob | null;
  fileName: string;
  aborted: boolean;
}

class MasterDataImportContractError extends Error {
}

export async function fetchMasterDataImportTemplates(signal?: AbortSignal): Promise<MasterDataImportApiResult<MasterDataImportTemplate[]>> {
  return requestJson(
    "/api/master-data/import/templates",
    { signal },
    normalizeTemplates,
    "导入模板列表加载失败。"
  );
}

export async function downloadMasterDataImportTemplate(
  type: MasterDataImportType,
  signal?: AbortSignal
): Promise<MasterDataImportDownloadResult> {
  return requestDownload(
    `/api/master-data/import/templates/${encodeURIComponent(type)}`,
    { signal },
    `${type}-master-data-import.xlsx`,
    "导入模板下载失败。"
  );
}

export async function previewMasterDataImport(
  type: MasterDataImportType,
  file: File,
  signal?: AbortSignal
): Promise<MasterDataImportApiResult<MasterDataImportJob>> {
  const body = new FormData();
  body.append("file", file, file.name);
  return requestJson(
    `/api/master-data/import/jobs/${encodeURIComponent(type)}/preview`,
    { method: "POST", body, signal },
    normalizeJobEnvelope,
    "工作簿预检失败。"
  );
}

export async function fetchMasterDataImportJobs(
  page = 1,
  pageSize = 20,
  signal?: AbortSignal
): Promise<MasterDataImportApiResult<MasterDataImportJobPage>> {
  const search = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  return requestJson(
    `/api/master-data/import/jobs?${search.toString()}`,
    { signal },
    normalizeJobPage,
    "最近导入任务加载失败。"
  );
}

export async function fetchMasterDataImportJob(
  jobId: string,
  page = 1,
  pageSize = 100,
  signal?: AbortSignal
): Promise<MasterDataImportApiResult<MasterDataImportJob>> {
  const search = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  return requestJson(
    `/api/master-data/import/jobs/${encodeURIComponent(jobId)}?${search.toString()}`,
    { signal },
    normalizeJobEnvelope,
    "导入任务详情加载失败。"
  );
}

export async function confirmMasterDataImport(
  jobId: string,
  signal?: AbortSignal
): Promise<MasterDataImportApiResult<MasterDataImportJob>> {
  return requestJson(
    `/api/master-data/import/jobs/${encodeURIComponent(jobId)}/confirm`,
    { method: "POST", signal },
    normalizeJobEnvelope,
    "确认导入失败。"
  );
}

export async function downloadMasterDataImportErrorReceipt(
  jobId: string,
  signal?: AbortSignal
): Promise<MasterDataImportDownloadResult> {
  return requestDownload(
    `/api/master-data/import/jobs/${encodeURIComponent(jobId)}/error-receipt`,
    { signal },
    `master-data-import-${jobId}-errors.xlsx`,
    "错误回执下载失败。"
  );
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
  normalize: (value: unknown) => T,
  fallbackMessage: string
): Promise<MasterDataImportApiResult<T>> {
  try {
    const response = await fetch(url, init);
    const raw = await readJsonBody(response);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message: responseErrorMessage(response.status, raw, fallbackMessage),
        data: null,
        aborted: false
      };
    }
    return {
      ok: true,
      status: response.status,
      message: "",
      data: normalize(raw),
      aborted: false
    };
  } catch (error) {
    if (isAbortError(error)) {
      return { ok: false, status: 0, message: "", data: null, aborted: true };
    }
    if (error instanceof MasterDataImportContractError) {
      return {
        ok: false,
        status: 502,
        message: "服务端响应不符合基础资料导入合同，请刷新后重试。",
        data: null,
        aborted: false
      };
    }
    return { ok: false, status: 0, message: `网络异常，${fallbackMessage}`, data: null, aborted: false };
  }
}

async function requestDownload(
  url: string,
  init: RequestInit,
  fallbackFileName: string,
  fallbackMessage: string
): Promise<MasterDataImportDownloadResult> {
  try {
    const response = await fetch(url, init);
    if (!response.ok) {
      const raw = await readJsonBody(response);
      return {
        ok: false,
        status: response.status,
        message: responseErrorMessage(response.status, raw, fallbackMessage),
        blob: null,
        fileName: "",
        aborted: false
      };
    }
    return {
      ok: true,
      status: response.status,
      message: "",
      blob: await response.blob(),
      fileName: responseFileName(response.headers.get("content-disposition"), fallbackFileName),
      aborted: false
    };
  } catch (error) {
    if (isAbortError(error)) {
      return { ok: false, status: 0, message: "", blob: null, fileName: "", aborted: true };
    }
    return { ok: false, status: 0, message: `网络异常，${fallbackMessage}`, blob: null, fileName: "", aborted: false };
  }
}

async function readJsonBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) {
    return null;
  }
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function responseErrorMessage(status: number, raw: unknown, fallback: string) {
  const serverMessage = firstString(asRecord(raw), ["message", "detail", "reason", "error"]);
  if (status === 401) return "登录状态已失效，请重新登录。";
  if (status === 403) return "当前账号无权执行基础资料导入。";
  if (status === 404) return serverMessage || "导入类型不受支持，或任务不存在。";
  if (status === 409) return serverMessage || "导入任务状态或实时资料已变化，请重新预检。";
  if (status === 410) return serverMessage || "预检任务已过期，请重新上传并预检。";
  if (status === 413) return serverMessage || "文件或解压后内容超出导入上限。";
  if (status === 400) return serverMessage || "工作簿结构、模板或内容不符合导入合同。";
  return serverMessage || fallback;
}

function normalizeTemplates(raw: unknown): MasterDataImportTemplate[] {
  const record = asRecord(raw);
  const templateValue = record.data ?? raw;
  const source = asRecord(templateValue);
  const candidates = Array.isArray(templateValue)
    ? templateValue
    : firstArray(source, ["templates", "items", "rows"]);
  const normalized = candidates.flatMap((candidate) => {
    const item = asRecord(candidate);
    const type = firstString(item, ["type", "importType"]);
    if (!isMasterDataImportType(type)) return [];
    return [{
      type,
      label: firstString(item, ["label", "title", "name"]) || type,
      templateVersion: firstNumber(item, ["templateVersion", "version"], 1),
      fileName: firstString(item, ["fileName", "filename"]) || `${type}-master-data-import.xlsx`,
      description: firstString(item, ["description", "note"])
    }];
  });
  const expectedTypes = new Set(masterDataImportDefinitions.map((definition) => definition.type));
  const actualTypes = new Set(normalized.map((template) => template.type));
  if (normalized.length !== expectedTypes.size || actualTypes.size !== expectedTypes.size) {
    throw new MasterDataImportContractError("template metadata set mismatch");
  }
  for (const type of expectedTypes) {
    if (!actualTypes.has(type)) {
      throw new MasterDataImportContractError(`missing template metadata: ${type}`);
    }
  }
  return normalized;
}

function normalizeJobEnvelope(raw: unknown): MasterDataImportJob {
  const root = asRecord(raw);
  const value = root.job ?? root.batch ?? root.result ?? root.data ?? raw;
  const envelope = asRecord(value);
  return normalizeJob(envelope.job ?? envelope.batch ?? envelope.result ?? value);
}

function normalizeJobPage(raw: unknown): MasterDataImportJobPage {
  const root = asRecord(raw);
  const pageValue = root.data ?? raw;
  const page = asRecord(pageValue);
  const candidates = Array.isArray(pageValue)
    ? pageValue
    : firstArray(page, ["jobs", "items", "rows", "content"]);
  return {
    page: firstNumber(page, ["page", "pageNumber"], 1),
    pageSize: firstNumber(page, ["pageSize", "size"], Math.max(candidates.length, 20)),
    total: firstNumber(page, ["total", "totalElements", "totalCount"], candidates.length),
    jobs: candidates.map(normalizeJob)
  };
}

function normalizeJob(raw: unknown): MasterDataImportJob {
  const item = asRecord(raw);
  const id = firstString(item, ["id", "jobId", "batchId"]);
  const typeCandidate = firstString(item, ["type", "importType"]);
  if (!id || !isMasterDataImportType(typeCandidate)) {
    throw new MasterDataImportContractError("job identity or type mismatch");
  }
  const type = typeCandidate;
  const status = normalizeStatus(firstString(item, ["status"]));
  const rowValue = item.rows ?? item.rowPage ?? item.rowResults ?? item.linesPage ?? item.previewRows;
  const rowContainer = asRecord(rowValue);
  const rawRows = Array.isArray(rowValue)
    ? rowValue
    : firstArray(rowContainer, ["rows", "items", "content"]);
  const totalRows = firstNumber(item, ["totalRows", "rowCount", "totalCount"], rawRows.length);
  const validRows = firstNumber(item, ["validRows", "validRowCount", "validCount"], 0);
  const errorRows = firstNumber(item, ["errorRows", "errorRowCount", "errorCount"], 0);
  return {
    id,
    type,
    templateVersion: firstNumber(item, ["templateVersion"], 1),
    fileName: firstString(item, ["fileName", "originalFileName"]),
    fileSha256: firstString(item, ["fileSha256", "sha256"]),
    fileSizeBytes: firstNumber(item, ["fileSizeBytes", "fileSize", "sizeBytes"], 0),
    status,
    totalRows,
    validRows,
    errorRows,
    committedRows: firstNumber(item, ["committedRows", "committedCount", "createdCount", "insertedCount"], 0),
    canConfirm: firstBoolean(item, ["canConfirm"], false),
    createdAt: firstString(item, ["createdAt"]),
    expiresAt: firstString(item, ["expiresAt"]),
    committedAt: firstString(item, ["committedAt", "completedAt"]),
    version: firstNumber(item, ["version"], 0),
    rows: rawRows.map(normalizeRow),
    rowPage: firstNumber(rowContainer, ["page", "pageNumber"], firstNumber(item, ["rowPage", "page"], 1)),
    rowPageSize: firstNumber(rowContainer, ["pageSize", "size"], firstNumber(item, ["rowPageSize", "pageSize"], 100)),
    rowTotal: firstNumber(rowContainer, ["total", "totalElements", "totalCount"], firstNumber(item, ["rowTotal", "total"], rawRows.length))
  };
}

function normalizeRow(raw: unknown): MasterDataImportRow {
  const item = asRecord(raw);
  const payload = asRecord(item.payload ?? item.normalizedPayload ?? item.values);
  const rowNo = firstNumber(item, ["rowNo", "excelRowNo", "lineNo"], 0);
  let errors = firstArray(item, ["errors", "validationErrors"]).map((error) => normalizeError(error, rowNo));
  if (errors.length === 0 && firstString(item, ["errorCode", "message", "errorMessage"])) {
    errors = [normalizeError(item, rowNo)];
  }
  return {
    rowNo,
    businessCode: firstString(item, ["businessCode", "recordCode", "code"]) || firstString(payload, ["code"]),
    valid: firstBoolean(item, ["valid"], errors.length === 0),
    payload,
    errors
  };
}

function normalizeError(raw: unknown, fallbackRowNo: number): MasterDataImportError {
  const item = asRecord(raw);
  return {
    rowNo: firstNumber(item, ["rowNo", "excelRowNo", "lineNo"], fallbackRowNo),
    field: firstString(item, ["field", "fieldName", "column"]),
    code: firstString(item, ["code", "errorCode"]),
    message: firstString(item, ["message", "errorMessage", "reason"]),
    value: stringifyCellValue(item.value ?? item.rawValue ?? item.cellValue)
  };
}

function normalizeStatus(value: string): MasterDataImportJobStatus {
  const allowed = new Set<MasterDataImportJobStatus>(["VALIDATED", "INVALID", "COMMITTED", "STALE", "FAILED", "EXPIRED"]);
  if (!allowed.has(value as MasterDataImportJobStatus)) {
    throw new MasterDataImportContractError("job status mismatch");
  }
  return value as MasterDataImportJobStatus;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstArray(record: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

function firstString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return "";
}

function firstNumber(record: Record<string, unknown>, keys: string[], fallback: number) {
  for (const key of keys) {
    const value = Number(record[key]);
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

function firstBoolean(record: Record<string, unknown>, keys: string[], fallback: boolean) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
    if (value === "true" || value === 1 || value === "1") return true;
    if (value === "false" || value === 0 || value === "0") return false;
  }
  return fallback;
}

function stringifyCellValue(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function responseFileName(contentDisposition: string | null, fallback: string) {
  if (!contentDisposition) return fallback;
  const encoded = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.replace(/^"|"$/g, ""));
    } catch {
      return encoded.replace(/^"|"$/g, "");
    }
  }
  return contentDisposition.match(/filename="?([^";]+)"?/i)?.[1] ?? fallback;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}
