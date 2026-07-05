export function taxAmounts(qty: number | string | undefined, unitPrice: number | string | undefined, taxRate: number | string | undefined) {
  const safeQty = numeric(qty);
  const safeUnitPrice = numeric(unitPrice);
  const safeTaxRate = taxRate === undefined || taxRate === null || String(taxRate).trim() === "" ? 13 : numeric(taxRate);
  const amount = roundMoney(safeQty * safeUnitPrice);
  const taxAmount = roundMoney(amount * safeTaxRate / 100);
  return {
    taxRate: safeTaxRate,
    amount,
    taxAmount,
    priceTaxTotal: roundMoney(amount + taxAmount)
  };
}

export function formatMoney(value: number | string | undefined) {
  const amount = numeric(value);
  return Number.isFinite(amount) ? amount.toFixed(2) : "0.00";
}

function numeric(value: number | string | undefined) {
  const parsed = Number(String(value ?? 0).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
