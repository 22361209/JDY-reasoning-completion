export type ReportScalar = string | number | boolean | null;
export type ReportRow = Record<string, ReportScalar>;

export type ReportColumnFormat =
  | "text"
  | "quantity"
  | "date"
  | "date-basis"
  | "posting-action"
  | "trace-quality"
  | "source-link";

export interface ReportColumnDefinition {
  key: string;
  title: string;
  width: number;
  minWidth?: number;
  align?: "left" | "center" | "right";
  fixed?: "" | "left" | "right";
  visible?: boolean;
  configurable?: boolean;
  sortField?: string;
  format?: ReportColumnFormat;
}

export interface ReportFilterDefinition {
  parameter: string;
  label: string;
  placeholder?: string;
  kind?: "text" | "select";
  options?: Array<{ value: string; label: string }>;
  defaultValue?: string;
}

export interface ReportTotalDefinition {
  groupKeys: string[];
  valueKeys: string[];
}

export interface ReportDefinition {
  entryId: string;
  reportKey: string;
  title: string;
  module: string;
  permission: string;
  description: string;
  columns: ReportColumnDefinition[];
  filters: ReportFilterDefinition[];
  totals: ReportTotalDefinition;
  defaultSortField: string;
  defaultSortOrder: "asc" | "desc";
}

export interface ReportQueryParameters {
  dateFrom: string;
  dateTo: string;
  keyword?: string;
  page: number;
  pageSize: number;
  sortField: string;
  sortOrder: "asc" | "desc";
  [parameter: string]: string | number | undefined;
}

export interface ReportQueryResponse {
  reportKey: string;
  page: number;
  pageSize: number;
  total: number;
  rows: ReportRow[];
  totals: ReportRow[];
  query: Record<string, ReportScalar>;
  generatedAt: string;
}

export type ReportErrorKind = "bad-request" | "forbidden" | "too-large" | "not-found" | "network" | "server";

export interface ReportApiResult<T> {
  ok: boolean;
  status: number;
  kind: ReportErrorKind | "";
  message: string;
  data: T | null;
}

export interface ReportExportResult {
  ok: boolean;
  status: number;
  kind: ReportErrorKind | "";
  message: string;
  blob: Blob | null;
  fileName: string;
}

export type ReportSourceTarget =
  | "salesQuote"
  | "salesOrder"
  | "deliveryNotice"
  | "salesOut"
  | "salesReturn"
  | "purchaseOrder"
  | "purchaseIn"
  | "purchaseReturn"
  | "materialIssue"
  | "productIn"
  | "otherStockIn"
  | "otherStockOut"
  | "stockTransfer"
  | "stockCount"
  | "stockCountGain"
  | "stockCountLoss";

export interface ReportSourceOpenRequest {
  type: ReportSourceTarget;
  billNo: string;
  sourceLineNo?: number | null;
}
