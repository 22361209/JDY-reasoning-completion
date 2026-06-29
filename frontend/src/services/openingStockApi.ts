export interface OpeningStockRow {
  id?: string;
  productCode: string;
  productName?: string;
  spec?: string;
  unit?: string;
  warehouseCode: string;
  warehouseName?: string;
  qty: string | number;
  unitCost: string | number;
  amount?: string | number;
  remark?: string;
  updatedAt?: string;
}

export interface OpeningStockResult {
  ok: boolean;
  status: number;
  message: string;
  rows: OpeningStockRow[];
}

export async function fetchOpeningStockRows(): Promise<OpeningStockResult> {
  try {
    const response = await fetch("/api/inventory/opening-stock");
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, status: response.status, message: parseApiError(text, "库存期初数加载失败。"), rows: [] };
    }
    const payload = await response.json() as { rows?: OpeningStockRow[] };
    return { ok: true, status: response.status, message: "", rows: payload.rows ?? [] };
  } catch {
    return { ok: false, status: 0, message: "库存期初数加载失败。", rows: [] };
  }
}

export async function saveOpeningStockRows(rows: OpeningStockRow[]): Promise<OpeningStockResult> {
  try {
    const response = await fetch("/api/inventory/opening-stock", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lines: rows
          .filter((row) => row.productCode && row.warehouseCode)
          .map((row) => ({
            productCode: row.productCode,
            warehouseCode: row.warehouseCode,
            qty: Number(row.qty || 0),
            unitCost: row.unitCost === "" || row.unitCost == null ? null : Number(row.unitCost),
            remark: row.remark || ""
          }))
      })
    });
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, status: response.status, message: parseApiError(text, "库存期初数保存失败。"), rows };
    }
    const payload = await response.json() as { rows?: OpeningStockRow[] };
    return { ok: true, status: response.status, message: "库存期初数已保存，并已同步库存余额。", rows: payload.rows ?? [] };
  } catch {
    return { ok: false, status: 0, message: "库存期初数保存失败。", rows };
  }
}

function parseApiError(text: string, fallback: string) {
  if (!text) {
    return fallback;
  }
  try {
    const payload = JSON.parse(text) as { message?: string; error?: string };
    return payload.message || payload.error || fallback;
  } catch {
    return text;
  }
}
