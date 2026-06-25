export function formatQty(value: number | string | undefined) {
  const qty = Number(value ?? 0);
  if (!Number.isFinite(qty)) {
    return "0";
  }
  return Number.isInteger(qty) ? String(qty) : qty.toFixed(2);
}

export function formatAmount(value: number | string | undefined) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? amount.toFixed(2) : "0.00";
}

export function backendStatusLabel(status: string | undefined) {
  const labels: Record<string, string> = {
    DRAFT: "草稿",
    AUDITED: "已审核",
    REVERSED: "已反审核",
    VOID: "已作废",
    VOIDED: "已作废",
    RED_REVERSED: "已红冲"
  };
  return labels[status ?? ""] ?? status ?? "-";
}
