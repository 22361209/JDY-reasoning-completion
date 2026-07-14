import type {
  ReportApiResult,
  ReportErrorKind,
  ReportExportResult,
  ReportQueryParameters,
  ReportQueryResponse,
  ReportScalar
} from "../modules/reports/reportTypes";

export async function fetchReportRows(
  reportKey: string,
  query: ReportQueryParameters | Record<string, ReportScalar>,
  signal?: AbortSignal
): Promise<ReportApiResult<ReportQueryResponse>> {
  try {
    const response = await fetch(reportUrl(reportKey, query), { signal });
    if (!response.ok) {
      return failure<ReportQueryResponse>(response.status, await responseMessage(response));
    }
    return {
      ok: true,
      status: response.status,
      kind: "",
      message: "",
      data: await response.json() as ReportQueryResponse
    };
  } catch (error) {
    if (isAbort(error)) {
      throw error;
    }
    return failure<ReportQueryResponse>(0, "网络异常，报表数据加载失败。请检查连接后重试。");
  }
}

export async function exportReportRows(
  reportKey: string,
  query: ReportQueryParameters | Record<string, ReportScalar>,
  signal?: AbortSignal
): Promise<ReportExportResult> {
  try {
    const response = await fetch(reportUrl(reportKey, query, true), { signal });
    if (!response.ok) {
      const failed = failure<Blob>(response.status, await responseMessage(response));
      return { ...failed, blob: null, fileName: "" };
    }
    return {
      ok: true,
      status: response.status,
      kind: "",
      message: "",
      blob: await response.blob(),
      fileName: exportFileName(response.headers.get("content-disposition"), `${reportKey}-export.csv`)
    };
  } catch (error) {
    if (isAbort(error)) {
      throw error;
    }
    return {
      ok: false,
      status: 0,
      kind: "network",
      message: "网络异常，报表引出失败。请检查连接后重试。",
      blob: null,
      fileName: ""
    };
  }
}

function reportUrl(
  reportKey: string,
  query: ReportQueryParameters | Record<string, ReportScalar>,
  exporting = false
) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      search.set(key, String(value));
    }
  }
  const suffix = exporting ? "/export.csv" : "";
  return `/api/reports/${encodeURIComponent(reportKey)}${suffix}?${search.toString()}`;
}

async function responseMessage(response: Response) {
  const fallback = defaultMessage(response.status);
  try {
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("json")) {
      return fallback;
    }
    const payload = await response.json() as Record<string, unknown>;
    const detail = String(payload.detail ?? payload.message ?? "").trim();
    return detail || fallback;
  } catch {
    return fallback;
  }
}

function failure<T>(status: number, message: string): ReportApiResult<T> {
  return { ok: false, status, kind: errorKind(status), message, data: null };
}

function errorKind(status: number): ReportErrorKind {
  if (status === 400) return "bad-request";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 413) return "too-large";
  if (status === 0) return "network";
  return "server";
}

function defaultMessage(status: number) {
  if (status === 400) return "筛选条件不符合报表规则，请修正后重试。";
  if (status === 403) return "当前账号无权查看或引出该报表。";
  if (status === 404) return "该报表未登记或尚未开放。";
  if (status === 413) return "引出数据超过 20,000 行，请缩小筛选范围。";
  return "报表服务暂时不可用，请稍后重试。";
}

function exportFileName(header: string | null, fallback: string) {
  if (!header) return fallback;
  const encoded = header.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return fallback;
    }
  }
  return header.match(/filename="?([^";]+)"?/i)?.[1] || fallback;
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}
