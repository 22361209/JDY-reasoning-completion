import { fetchListRows, fetchSnapshotListRows, type ListResponse } from "./listApi";

export type SettlementKind = "receipt" | "payment";
export type SettlementCurrency = "CNY" | "USD";
export type SettlementStatus = "DRAFT" | "AUDITED";
export type SettlementPaymentMethod = "CASH" | "BANK_TRANSFER" | "OTHER";
export type SettlementMoney = string;
export type SettlementVersion = string;

export interface SettlementFundLine {
  lineNo: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: "CASH" | "BANK" | "DEPOSIT" | string;
  accountCurrency: SettlementCurrency;
  paymentMethod: SettlementPaymentMethod;
  amount: SettlementMoney;
  fee: SettlementMoney;
  transactionNo: string;
  remark: string;
}

export interface SettlementAllocationLine {
  lineNo: number;
  sourceId: string;
  sourceBillNo: string;
  sourceDate: string;
  sourceAmount: SettlementMoney;
  settledBefore: SettlementMoney;
  unsettledBefore: SettlementMoney;
  currentSettledAmount: SettlementMoney;
  currentUnsettledAmount: SettlementMoney;
  settlementAmount: SettlementMoney;
  remark: string;
}

export interface SettlementDocument {
  billNo: string;
  partyId: string;
  partyCode: string;
  partyName: string;
  billDate: string;
  currency: SettlementCurrency;
  amount: SettlementMoney;
  status: SettlementStatus;
  version: SettlementVersion;
  remark: string;
  legacy: boolean;
  fundLines: SettlementFundLine[];
  allocations: SettlementAllocationLine[];
}

export interface SettlementDraftPayload {
  partyId: string;
  billDate: string;
  currency: SettlementCurrency;
  amount: SettlementMoney;
  remark: string;
  fundLines: Array<{
    lineNo: number;
    accountId: string;
    paymentMethod: SettlementPaymentMethod;
    amount: SettlementMoney;
    fee: SettlementMoney;
    transactionNo: string;
    remark: string;
  }>;
  allocations: Array<{
    lineNo: number;
    sourceId: string;
    settlementAmount: SettlementMoney;
    remark: string;
  }>;
}

export interface SettlementSourceOption {
  id: string;
  sourceId: string;
  billNo: string;
  sourceBillNo: string;
  partyId: string;
  partyCode: string;
  partyName: string;
  billDate: string;
  currency: SettlementCurrency;
  amount: SettlementMoney;
  settledAmount: SettlementMoney;
  unsettledAmount: SettlementMoney;
  status: string;
}

export interface SettlementAccountOption {
  id: string;
  code: string;
  name: string;
  accountType: "CASH" | "BANK" | "DEPOSIT" | string;
  currency: SettlementCurrency;
  status: string;
  auditStatus: string;
}

export interface FinanceApiResult<T = SettlementDocument> {
  ok: boolean;
  status: number;
  conflict: boolean;
  message: string;
  data?: T;
}

const collectionByKind: Record<SettlementKind, string> = {
  receipt: "/api/finance/receipts",
  payment: "/api/finance/payments"
};

export const settlementListKeyByKind: Record<SettlementKind, string> = {
  receipt: "ar-receipt-form-list",
  payment: "ap-payment-form-list"
};

export const settlementSourceSelectorKeyByKind: Record<SettlementKind, string> = {
  receipt: "ar-receivable-settlement-source-selector",
  payment: "ap-payable-settlement-source-selector"
};

export async function createSettlementDraft(kind: SettlementKind, payload: SettlementDraftPayload) {
  return callSettlement(`${collectionByKind[kind]}/draft`, "POST", payload);
}

export async function updateSettlementDraft(kind: SettlementKind, billNo: string, version: SettlementVersion, payload: SettlementDraftPayload) {
  if (!isValidSettlementVersion(version)) {
    return invalidVersionResult();
  }
  return callSettlement(`${collectionByKind[kind]}/${encodeURIComponent(billNo)}/draft`, "PUT", { ...payload, version });
}

export async function fetchSettlementDetail(kind: SettlementKind, billNo: string) {
  return callSettlement(`${collectionByKind[kind]}/${encodeURIComponent(billNo)}`, "GET");
}

export async function auditSettlement(kind: SettlementKind, billNo: string) {
  return callSettlement(`${collectionByKind[kind]}/${encodeURIComponent(billNo)}/audit`, "POST");
}

export async function reverseSettlement(kind: SettlementKind, billNo: string) {
  return callSettlement(`${collectionByKind[kind]}/${encodeURIComponent(billNo)}/reverse`, "POST");
}

export async function deleteSettlementDraft(kind: SettlementKind, billNo: string) {
  return callSettlement(`${collectionByKind[kind]}/${encodeURIComponent(billNo)}`, "DELETE");
}

export async function fetchSettlementSources(
  kind: SettlementKind,
  query: { keyword: string; currency: SettlementCurrency; partyId?: string }
): Promise<FinanceApiResult<SettlementSourceOption[]>> {
  const filters: Record<string, { operator: string; value: string }> = {
    currency: { operator: "等于", value: query.currency }
  };
  if (query.partyId) {
    filters.partyId = { operator: "等于", value: query.partyId };
  }
  const result = await fetchListRows(
    settlementSourceSelectorKeyByKind[kind],
    {
      keyword: query.keyword,
      page: 1,
      pageSize: 1000,
      columnFilters: filters
    },
    { parseResponse: parseSettlementListResponse }
  );
  if (!result.ok || !result.data) {
    return { ok: false, status: result.status, conflict: false, message: result.message || "可核销来源加载失败。" };
  }
  return {
    ok: true,
    status: result.status,
    conflict: false,
    message: "",
    data: result.data.rows.map(normalizeSourceOption).filter((row) => row.id && isPositiveMoney(row.unsettledAmount))
  };
}

export async function fetchSettlementAccounts(
  query: { keyword: string; currency: SettlementCurrency }
): Promise<FinanceApiResult<SettlementAccountOption[]>> {
  const result = await fetchSnapshotListRows("financial-account-settlement-selector", {
    keyword: query.keyword,
    pageSize: 200,
    columnFilters: {
      currency: { operator: "等于", value: query.currency }
    }
  });
  if (!result.ok || !result.data) {
    return {
      ok: false,
      status: result.status,
      conflict: result.status === 409,
      message: result.status === 409 ? "财务账户数据已变化，请重试。" : result.message || "财务账户加载失败。"
    };
  }
  return {
    ok: true,
    status: result.status,
    conflict: false,
    message: "",
    data: result.data.rows.map(normalizeAccountOption).filter((row) => row.id && row.currency === query.currency)
  };
}

async function callSettlement(url: string, method: string, body?: unknown): Promise<FinanceApiResult> {
  try {
    const response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : stringifySettlementBody(body)
    });
    const raw = await readResponsePayload(response);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        conflict: response.status === 409,
        message: errorMessage(raw, `收付款单操作失败（HTTP ${response.status}）。`)
      };
    }
    return {
      ok: true,
      status: response.status,
      conflict: false,
      message: "",
      data: normalizeSettlementDocument(raw)
    };
  } catch {
    return { ok: false, status: 0, conflict: false, message: "网络异常，收付款单操作失败。" };
  }
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }
  try {
    return parseJsonPreservingNumbers(text);
  } catch {
    return text;
  }
}

function errorMessage(raw: unknown, fallback: string) {
  if (typeof raw === "string" && raw.trim()) {
    return raw;
  }
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    for (const key of ["reason", "message", "detail", "error"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
  }
  return fallback;
}

function normalizeSettlementDocument(raw: unknown): SettlementDocument {
  const root = asRecord(raw);
  const document = asRecord(root.document ?? root.header ?? root.data ?? root);
  const fundLines = arrayValue(root.fundLines ?? document.fundLines).map((line, index) => normalizeFundLine(line, index));
  const allocations = arrayValue(root.allocations ?? root.allocationLines ?? document.allocations).map((line, index) => normalizeAllocationLine(line, index));
  return {
    billNo: stringValue(document.billNo),
    partyId: stringValue(document.partyId),
    partyCode: stringValue(document.partyCode ?? document.customerCode ?? document.supplierCode),
    partyName: stringValue(document.partyName ?? document.customerName ?? document.supplierName ?? document.customer ?? document.supplier),
    billDate: stringValue(document.billDate),
    currency: currencyValue(document.currency),
    amount: moneyValue(document.amount),
    status: stringValue(document.status).toUpperCase() === "AUDITED" ? "AUDITED" : "DRAFT",
    version: settlementVersionValue(document.version),
    remark: stringValue(document.remark),
    legacy: Boolean(document.legacy ?? document.isLegacy ?? document.sourceKind === "LEGACY"),
    fundLines,
    allocations
  };
}

function normalizeFundLine(raw: unknown, index: number): SettlementFundLine {
  const row = asRecord(raw);
  return {
    lineNo: positiveInteger(row.lineNo, index + 1),
    accountId: stringValue(row.accountId),
    accountCode: stringValue(row.accountCode),
    accountName: stringValue(row.accountName),
    accountType: stringValue(row.accountType),
    accountCurrency: currencyValue(row.accountCurrency ?? row.currency),
    paymentMethod: paymentMethodValue(row.paymentMethod),
    amount: moneyValue(row.amount),
    fee: moneyValue(row.fee),
    transactionNo: stringValue(row.transactionNo),
    remark: stringValue(row.remark)
  };
}

function normalizeAllocationLine(raw: unknown, index: number): SettlementAllocationLine {
  const row = asRecord(raw);
  const settledBefore = moneyValue(row.settledBefore ?? row.settledAmount ?? row.receivedAmount ?? row.paidAmount);
  const unsettledBefore = moneyValue(row.unsettledBefore ?? row.unsettledAmount);
  return {
    lineNo: positiveInteger(row.lineNo, index + 1),
    sourceId: stringValue(row.sourceId ?? row.receivableId ?? row.payableId),
    sourceBillNo: stringValue(row.sourceBillNo ?? row.billNo),
    sourceDate: stringValue(row.sourceDate ?? row.billDate),
    sourceAmount: moneyValue(row.sourceAmount ?? row.amount),
    settledBefore,
    unsettledBefore,
    currentSettledAmount: moneyValue(row.currentSettledAmount ?? settledBefore),
    currentUnsettledAmount: moneyValue(row.currentUnsettledAmount ?? unsettledBefore),
    settlementAmount: moneyValue(row.settlementAmount),
    remark: stringValue(row.remark)
  };
}

function normalizeSourceOption(raw: Record<string, unknown>): SettlementSourceOption {
  const settledAmount = moneyValue(raw.settledAmount ?? raw.receivedAmount ?? raw.paidAmount);
  const amount = moneyValue(raw.amount ?? raw.sourceAmount);
  const unsettledAmount = raw.unsettledAmount != null || raw.remainingAmount != null
    ? moneyValue(raw.unsettledAmount ?? raw.remainingAmount)
    : subtractMoney(amount, settledAmount);
  return {
    id: stringValue(raw.id ?? raw.sourceId),
    sourceId: stringValue(raw.sourceId ?? raw.id),
    billNo: stringValue(raw.billNo),
    sourceBillNo: stringValue(raw.sourceBillNo),
    partyId: stringValue(raw.partyId ?? raw.customerId ?? raw.supplierId),
    partyCode: stringValue(raw.partyCode ?? raw.customerCode ?? raw.supplierCode),
    partyName: stringValue(raw.partyName ?? raw.customerName ?? raw.supplierName ?? raw.customer ?? raw.supplier),
    billDate: stringValue(raw.billDate),
    currency: currencyValue(raw.currency),
    amount,
    settledAmount,
    unsettledAmount,
    status: stringValue(raw.status)
  };
}

function normalizeAccountOption(raw: Record<string, unknown>): SettlementAccountOption {
  return {
    id: stringValue(raw.id),
    code: stringValue(raw.code),
    name: stringValue(raw.name),
    accountType: stringValue(raw.accountType),
    currency: currencyValue(raw.currency),
    status: stringValue(raw.status),
    auditStatus: stringValue(raw.auditStatus)
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown) {
  return value == null ? "" : String(value);
}

function moneyValue(value: unknown): SettlementMoney {
  return moneyFromCents(decimalToCents(value) ?? 0n);
}

function subtractMoney(left: SettlementMoney, right: SettlementMoney): SettlementMoney {
  return moneyFromCents((decimalToCents(left) ?? 0n) - (decimalToCents(right) ?? 0n));
}

function isPositiveMoney(value: SettlementMoney) {
  return (decimalToCents(value) ?? 0n) > 0n;
}

function decimalToCents(value: unknown): bigint | null {
  const text = String(value ?? "").trim();
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
  if (!match) {
    return null;
  }
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) {
    return null;
  }
  const fraction = match[3] ?? "";
  const digitText = `${match[2]}${fraction}`.replace(/^0+(?=\d)/, "");
  if (digitText.length > 100) {
    return null;
  }
  let digits = BigInt(digitText || "0");
  const scale = fraction.length - exponent;
  if (scale < 2) {
    digits *= 10n ** BigInt(2 - scale);
  } else if (scale > 2) {
    const divisor = 10n ** BigInt(scale - 2);
    if (digits % divisor !== 0n) {
      return null;
    }
    digits /= divisor;
  }
  return match[1] === "-" ? -digits : digits;
}

function moneyFromCents(cents: bigint): SettlementMoney {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const integer = absolute / 100n;
  const fraction = String(absolute % 100n).padStart(2, "0");
  return `${negative && absolute !== 0n ? "-" : ""}${integer}.${fraction}`;
}

function settlementVersionValue(value: unknown): SettlementVersion {
  const text = typeof value === "number"
    ? Number.isSafeInteger(value) && value >= 0 ? String(value) : ""
    : String(value ?? "").trim();
  return isValidSettlementVersion(text) ? text : "0";
}

function isValidSettlementVersion(value: unknown): value is SettlementVersion {
  const text = String(value ?? "");
  return /^(0|[1-9]\d*)$/.test(text) && text.length <= 19 && BigInt(text) <= 9223372036854775807n;
}

function invalidVersionResult(): FinanceApiResult {
  return {
    ok: false,
    status: 0,
    conflict: false,
    message: "单据版本无效，请重新加载详情后再保存。"
  };
}

function stringifySettlementBody(body: unknown) {
  const record = asRecord(body);
  if ("version" in record && !isValidSettlementVersion(record.version)) {
    throw new Error("invalid settlement version");
  }
  return JSON.stringify(body);
}

function parseSettlementListResponse(text: string): ListResponse {
  const raw = asRecord(parseJsonPreservingNumbers(text));
  const view = raw.view === "detail" ? "detail" : raw.view === "header" ? "header" : undefined;
  return {
    page: safeListInteger(raw.page, 1),
    pageSize: safeListInteger(raw.pageSize, 1000),
    total: safeListInteger(raw.total, 0),
    ...(view ? { view } : {}),
    ...(raw.sortField == null ? {} : { sortField: String(raw.sortField) }),
    ...(raw.sortOrder == null ? {} : { sortOrder: String(raw.sortOrder) }),
    ...(raw.scope === "current" || raw.scope === "platform" || raw.scope === "historical" ? { scope: raw.scope } : {}),
    rows: arrayValue(raw.rows).map(asRecord)
  };
}

function safeListInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseJsonPreservingNumbers(text: string): unknown {
  return JSON.parse(quoteJsonNumbers(text)) as unknown;
}

function quoteJsonNumbers(source: string) {
  let result = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '"') {
      const start = index;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === '"') {
          index += 1;
          break;
        }
        index += 1;
      }
      result += source.slice(start, index);
      continue;
    }
    if (char === "-" || (char >= "0" && char <= "9")) {
      const match = source.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (match) {
        result += JSON.stringify(match[0]);
        index += match[0].length;
        continue;
      }
    }
    result += char;
    index += 1;
  }
  return result;
}

function positiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function currencyValue(value: unknown): SettlementCurrency {
  return String(value ?? "CNY").toUpperCase() === "USD" ? "USD" : "CNY";
}

function paymentMethodValue(value: unknown): SettlementPaymentMethod {
  const normalized = String(value ?? "OTHER").toUpperCase();
  return normalized === "CASH" || normalized === "BANK_TRANSFER" ? normalized : "OTHER";
}
