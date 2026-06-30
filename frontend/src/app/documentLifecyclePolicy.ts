import type { DocumentType } from "../services/documentApi";

export interface DocumentLifecyclePolicy {
  type: DocumentType;
  closeFreezeAllowed: boolean;
  lineCloseFreezeAllowed: boolean;
  redReverseAllowed: boolean;
  voidAllowed: boolean;
}

const DEFAULT_FACT_POLICY: Omit<DocumentLifecyclePolicy, "type"> = {
  closeFreezeAllowed: false,
  lineCloseFreezeAllowed: false,
  redReverseAllowed: false,
  voidAllowed: true
};

const lifecyclePolicyByType: Record<DocumentType, Omit<DocumentLifecyclePolicy, "type">> = {
  salesQuote: DEFAULT_FACT_POLICY,
  salesOrder: { closeFreezeAllowed: true, lineCloseFreezeAllowed: true, redReverseAllowed: false, voidAllowed: true },
  deliveryNotice: { closeFreezeAllowed: true, lineCloseFreezeAllowed: true, redReverseAllowed: false, voidAllowed: true },
  salesOut: { closeFreezeAllowed: false, lineCloseFreezeAllowed: false, redReverseAllowed: true, voidAllowed: true },
  purchaseOrder: { closeFreezeAllowed: true, lineCloseFreezeAllowed: true, redReverseAllowed: false, voidAllowed: true },
  purchaseIn: { closeFreezeAllowed: false, lineCloseFreezeAllowed: false, redReverseAllowed: true, voidAllowed: true },
  purchaseReturn: DEFAULT_FACT_POLICY,
  materialIssue: { closeFreezeAllowed: false, lineCloseFreezeAllowed: false, redReverseAllowed: true, voidAllowed: true },
  productIn: { closeFreezeAllowed: false, lineCloseFreezeAllowed: false, redReverseAllowed: true, voidAllowed: true },
  otherStockIn: DEFAULT_FACT_POLICY,
  otherStockOut: DEFAULT_FACT_POLICY,
  stockTransfer: DEFAULT_FACT_POLICY,
  stockCount: DEFAULT_FACT_POLICY,
  stockCountGain: DEFAULT_FACT_POLICY,
  stockCountLoss: DEFAULT_FACT_POLICY
};

const normalizedStatusByText: Record<string, string> = {
  DRAFT: "DRAFT",
  AUDITED: "AUDITED",
  REVERSED: "REVERSED",
  VOID: "VOID",
  VOIDED: "VOID",
  RED_REVERSED: "RED_REVERSED",
  草稿: "DRAFT",
  已审核: "AUDITED",
  已反审核: "REVERSED",
  已作废: "VOID",
  已红冲: "RED_REVERSED"
};

export function lifecyclePolicyFor(type?: DocumentType | null): DocumentLifecyclePolicy | null {
  if (!type) {
    return null;
  }
  return {
    type,
    ...lifecyclePolicyByType[type]
  };
}

export function normalizeBillStatus(value: unknown): string {
  const key = String(value ?? "").trim();
  return normalizedStatusByText[key] ?? key;
}

export function rowBillStatus(row: Record<string, unknown>): string {
  return normalizeBillStatus(row.statusCode ?? row.backendStatus ?? row.rawStatus ?? row.status);
}

export function isDraftBillStatus(row: Record<string, unknown>): boolean {
  return rowBillStatus(row) === "DRAFT";
}

export function isAuditedBillStatus(row: Record<string, unknown>): boolean {
  return rowBillStatus(row) === "AUDITED";
}

export function documentLifecycleStatusLabel(status: unknown, closeStatus?: unknown, frozenStatus?: unknown): string {
  const mainLabels: Record<string, string> = {
    DRAFT: "草稿",
    AUDITED: "已审核",
    REVERSED: "已反审核",
    VOID: "已作废",
    RED_REVERSED: "已红冲"
  };
  const labels = [mainLabels[normalizeBillStatus(status)] ?? String(status ?? "")];
  if (closeStatus === "CLOSED") {
    labels.push("已关闭");
  }
  if (frozenStatus === "FROZEN") {
    labels.push("已冻结");
  }
  return labels.filter(Boolean).join(" / ");
}
