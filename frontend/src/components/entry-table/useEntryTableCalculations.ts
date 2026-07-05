import { taxAmounts } from "../../app/taxAmounts";
import type { EntryLine, MasterOption } from "./types";

export function entryLineAmount(line: EntryLine, preview = true) {
  return formatEntryPrice(entryLineAmountValue(line, preview));
}

export function entryLineTaxAmount(line: EntryLine, preview = true) {
  return formatEntryPrice(entryLineTaxAmountValue(line, preview));
}

export function entryLinePriceTaxTotal(line: EntryLine, preview = true) {
  return formatEntryPrice(entryLinePriceTaxTotalValue(line, preview));
}

export function entryLineTaxInclusiveUnitPrice(line: EntryLine, preview = true) {
  return formatEntryPrice(entryLineTaxInclusiveUnitPriceValue(line, preview));
}

export function entryLineAmountValue(line: EntryLine, preview = true) {
  const persisted = preview ? undefined : numericOrUndefined(line.amount);
  return persisted ?? taxForEntryLine(line).amount;
}

export function entryLineTaxAmountValue(line: EntryLine, preview = true) {
  const persisted = preview ? undefined : numericOrUndefined(line.taxAmount);
  return persisted ?? taxForEntryLine(line).taxAmount;
}

export function entryLinePriceTaxTotalValue(line: EntryLine, preview = true) {
  const persisted = preview ? undefined : numericOrUndefined(line.priceTaxTotal);
  return persisted ?? taxForEntryLine(line).priceTaxTotal;
}

export function entryLineTaxInclusiveUnitPriceValue(line: EntryLine, preview = true) {
  const persisted = preview ? undefined : numericOrUndefined(line.taxInclusiveUnitPrice);
  if (persisted !== undefined) {
    return persisted;
  }
  const qty = Number(line.qty || 0);
  const priceTaxTotal = entryLinePriceTaxTotalValue(line, preview);
  if (!qty || !Number.isFinite(qty)) {
    const unitPrice = Number(line.unitPrice || 0);
    const taxRate = Number(line.taxRate ?? 0);
    return unitPrice * (1 + taxRate / 100);
  }
  return priceTaxTotal / qty;
}

export function taxForEntryLine(line: EntryLine) {
  return taxAmounts(line.qty, line.unitPrice, line.taxRate);
}

function numericOrUndefined(value: number | string | undefined) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return undefined;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

export function entryLineExecutedQty(line: EntryLine) {
  return formatEntryQty(line.executedQty ?? 0);
}

export function entryLineRemainingQty(line: EntryLine) {
  return formatEntryQty(line.remainingQty ?? Math.max(0, Number(line.qty || 0) - Number(line.executedQty || 0)));
}

export function entrySourceLineNo(line: EntryLine) {
  return line.sourceLineNo ? `#${line.sourceLineNo}` : "-";
}

export function entryLineNo(line: EntryLine, index: number) {
  return line.lineNo ?? index + 1;
}

export function formatEntryQty(value: number | string | undefined) {
  const qty = Number(value ?? 0);
  if (!Number.isFinite(qty)) {
    return "0";
  }
  return Number.isInteger(qty) ? String(qty) : qty.toFixed(2);
}

export function formatEntryPrice(value: number | string | undefined) {
  const price = Number(value ?? 0);
  if (!Number.isFinite(price)) {
    return "0.00";
  }
  return price.toFixed(2);
}

export function formatOptionalWeight(value: number | string | undefined) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return "";
  }
  const weight = Number(value);
  if (!Number.isFinite(weight)) {
    return "";
  }
  return weight.toFixed(2);
}

export function entryProductInfo(line: EntryLine, selectorOptions: MasterOption[], knownProductOptions: MasterOption[]) {
  if (line.productName || line.spec || line.unit || line.netWeight || line.grossWeight) {
    return {
      name: line.productName ?? "",
      spec: line.spec ?? "",
      unit: line.unit ?? "",
      netWeight: line.netWeight,
      grossWeight: line.grossWeight
    };
  }
  const product = selectorOptions.find((option) => option.code === line.productCode)
    ?? knownProductOptions.find((option) => option.code === line.productCode);
  return product
    ? { name: product.name, spec: product.spec ?? "", unit: product.unit ?? "", netWeight: product.netWeight ?? "", grossWeight: product.grossWeight ?? "" }
    : { name: "", spec: "", unit: "", netWeight: "", grossWeight: "" };
}
