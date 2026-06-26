export function taxAmounts(qty: number | string | undefined, unitPrice: number | string | undefined, taxRate: number | string | undefined, isTaxInclusive: boolean) {
  const safeQty = numeric(qty);
  const safeUnitPrice = numeric(unitPrice);
  const safeTaxRate = taxRate === undefined || taxRate === null || String(taxRate).trim() === "" ? 13 : numeric(taxRate);
  const gross = safeQty * safeUnitPrice;
  if (isTaxInclusive) {
    const priceTaxTotal = roundMoney(gross);
    const amount = roundMoney(gross / (1 + safeTaxRate / 100));
    return {
      taxRate: safeTaxRate,
      amount,
      taxAmount: roundMoney(priceTaxTotal - amount),
      priceTaxTotal
    };
  }
  const amount = roundMoney(gross);
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
