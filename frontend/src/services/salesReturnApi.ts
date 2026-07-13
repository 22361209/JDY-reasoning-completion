import type { SourceSelectorQueryChange } from "../components/SourceSelectorDialog.vue";
import type { OrderForm, OrderLineForm } from "../app/documentModel";
import { fetchSourceSelectorRows } from "./sourceSelectorListApi";

export interface SelectableSalesOutLine {
  billNo: string;
  lineNo: number | string;
  customerCode: string;
  customer: string;
  billDate: string;
  currency: "CNY" | "USD" | string;
  department?: string;
  ownerName?: string;
  productId?: string;
  productCode: string;
  productName?: string;
  spec?: string;
  unit?: string;
  netWeight?: number | string;
  grossWeight?: number | string;
  warehouseCode: string;
  sourceQty: number | string;
  returnedQty: number | string;
  remainingQty: number | string;
  unitPrice: number | string;
  taxInclusiveUnitPrice?: number | string;
  amount?: number | string;
  taxRate?: number | string;
  taxAmount?: number | string;
  priceTaxTotal?: number | string;
  lineRemark?: string;
}

export async function fetchSelectableSalesOutLines(query: SourceSelectorQueryChange) {
  const result = await fetchSourceSelectorRows({
    listKey: "sales-out-return-source-selector",
    keyword: query.keyword,
    columnFilters: query.columnFilters
  });
  if (!result.ok) {
    return { ok: false, message: result.message || "销售出库选单列表加载失败。", data: [] as SelectableSalesOutLine[] };
  }
  return {
    ok: true,
    message: "",
    data: result.rows as unknown as SelectableSalesOutLine[]
  };
}

export async function saveSalesReturnDraft(form: OrderForm, lines: OrderLineForm[]) {
  const billNo = form.billNo.trim();
  const version = normalizeVersion(form.version);
  if (billNo && !version) {
    return { ok: false, message: "当前草稿缺少有效版本，请从列表重新打开后再保存。" };
  }
  const requestLines: Array<{ sourceOutNo: string; sourceLineNo: number; qty: number; lineRemark: string }> = [];
  for (const [index, line] of lines.entries()) {
    const sourceOutNo = String(line.sourceOrderNo ?? "").trim();
    const sourceLineNo = Number(line.sourceLineNo);
    const qty = Number(line.qty);
    if (!sourceOutNo || !Number.isInteger(sourceLineNo) || sourceLineNo <= 0) {
      return { ok: false, message: `第 ${index + 1} 行缺少销售出库来源。` };
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      return { ok: false, message: `第 ${index + 1} 行退货数量必须大于 0。` };
    }
    requestLines.push({
      sourceOutNo,
      sourceLineNo,
      qty,
      lineRemark: String(line.lineRemark ?? "").trim()
    });
  }
  const body = {
    ...(billNo ? { billNo, version } : {}),
    billDate: form.billDate,
    remark: String(form.remark ?? "").trim(),
    lines: requestLines
  };
  try {
    const response = await fetch("/api/sales-returns/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    const data = parseJson(text);
    if (!response.ok) {
      return { ok: false, message: responseMessage(data, text, response.status) };
    }
    const savedBillNo = responseBillNo(data);
    if (!savedBillNo) {
      return { ok: false, message: "销售退货草稿已响应成功，但返回结果缺少单据编号。" };
    }
    return { ok: true, message: "", data: { billNo: savedBillNo } };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error && error.message ? error.message : "网络异常，销售退货草稿保存失败。"
    };
  }
}

function responseBillNo(data: unknown) {
  if (!data || typeof data !== "object") {
    return "";
  }
  const payload = data as Record<string, unknown>;
  if (typeof payload.billNo === "string") {
    return payload.billNo.trim();
  }
  if (!payload.document || typeof payload.document !== "object") {
    return "";
  }
  const billNo = (payload.document as Record<string, unknown>).billNo;
  return typeof billNo === "string" ? billNo.trim() : "";
}

function normalizeVersion(value: unknown) {
  const normalized = String(value ?? "").trim();
  if (!/^(0|[1-9]\d*)$/.test(normalized)) {
    return "";
  }
  const max = "9223372036854775807";
  return normalized.length < max.length || (normalized.length === max.length && normalized <= max) ? normalized : "";
}

function parseJson(text: string): unknown {
  if (!text.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function responseMessage(data: unknown, text: string, status: number) {
  if (data && typeof data === "object") {
    const payload = data as Record<string, unknown>;
    for (const key of ["reason", "message", "detail", "error"]) {
      const value = String(payload[key] ?? "").trim();
      if (value) {
        return value;
      }
    }
  }
  return text.trim() || `销售退货草稿保存失败（HTTP ${status}）。`;
}
