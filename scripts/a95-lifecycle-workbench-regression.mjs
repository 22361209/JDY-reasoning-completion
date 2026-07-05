import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { createSalesOutDraftViaDeliveryNotice } from "./helpers/sales-delivery-notice-flow.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a95-lifecycle-workbench-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-26";
const productCode = "CP-001";
const warehouseCode = "CK-001";
const qty = 2;

await installApiSession(apiBase);
await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function generatedBillNo(row, label) {
  const billNo = String(row?.billNo ?? "");
  if (!billNo) {
    throw new Error(`${label} did not return billNo: ${JSON.stringify(row)}`);
  }
  return billNo;
}

async function api(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "POST",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${options.method ?? "POST"} ${pathname} failed ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

function dbNumber(sql) {
  const output = execFileSync("docker", [
    "exec",
    "jdy-erp-postgres",
    "psql",
    "-U",
    "jdy",
    "-d",
    "jdy_erp",
    "-tA",
    "-c",
    sql
  ], { encoding: "utf8" });
  return Number(output.trim() || "0");
}

function txnCount(txnType, billNo) {
  return dbNumber(`
    SELECT count(*)
    FROM inv_stock_txn t
    JOIN md_product p ON p.id = t.product_id
    JOIN md_warehouse w ON w.id = t.warehouse_id
    WHERE p.code = '${productCode}'
      AND w.code = '${warehouseCode}'
      AND t.txn_type = '${txnType}'
      AND t.source_bill_type = '${txnType}:${billNo}'
  `);
}

async function seedStock() {
  await api("/api/inventory/adjustments", {
    body: {
      productCode,
      warehouseCode,
      qtyDelta: 500,
      txnType: "A95_SEED_IN",
      sourceBillType: `A95:${batch}`
    }
  });
}

function salesOrderPayload(billNo, remark) {
  return {
    ...(billNo ? { billNo } : {}),
    customerCode: "KH-001",
    billDate,
    department: "销售部",
    ownerName: "本地管理员",
    remark,
    lines: [{ productCode, warehouseCode, qty, unitPrice: 86, lineRemark: remark }]
  };
}

function salesOutPayload(billNo, remark) {
  return {
    ...(billNo ? { billNo } : {}),
    customerCode: "KH-001",
    billDate,
    department: "销售部",
    ownerName: "本地管理员",
    remark,
    lines: [{ productCode, warehouseCode, qty, unitPrice: 86, lineRemark: remark }]
  };
}

async function verifyReverseBackToEditableDraft() {
  const salesOrderNo = generatedBillNo(await api("/api/sales-orders/draft", { body: salesOrderPayload(null, "A95反审核前") }), "A95销售订单反审核样本");
  await api(`/api/sales-orders/${encodeURIComponent(salesOrderNo)}/audit`);
  const reversed = await api(`/api/sales-orders/${encodeURIComponent(salesOrderNo)}/reverse`);
  const afterReverse = await api(`/api/sales-orders/${encodeURIComponent(salesOrderNo)}`, { method: "GET" });
  assert(reversed.status === "DRAFT", `sales order reverse response should be DRAFT, got ${reversed.status}`);
  assert(afterReverse.order.status === "DRAFT", `sales order after reverse should be DRAFT, got ${afterReverse.order.status}`);

  await api("/api/sales-orders/draft", { body: salesOrderPayload(salesOrderNo, "A95反审核后可编辑") });
  const afterEdit = await api(`/api/sales-orders/${encodeURIComponent(salesOrderNo)}`, { method: "GET" });
  assert(afterEdit.order.status === "DRAFT", `edited sales order should stay DRAFT, got ${afterEdit.order.status}`);
  assert(afterEdit.order.remark === "A95反审核后可编辑", `edited remark should persist, got ${afterEdit.order.remark}`);
  const reaudited = await api(`/api/sales-orders/${encodeURIComponent(salesOrderNo)}/audit`);
  assert(reaudited.status === "AUDITED", `sales order should re-audit to AUDITED, got ${reaudited.status}`);

  const salesFlow = await createSalesOutDraftViaDeliveryNotice((pathname, body) => api(pathname, { body }), salesOutPayload(null, "A95出库反审核"));
  const salesOutNo = salesFlow.salesOutNo;
  await api(`/api/sales-outs/${encodeURIComponent(salesOutNo)}/audit`);
  const outReversed = await api(`/api/sales-outs/${encodeURIComponent(salesOutNo)}/reverse`);
  const outAfterReverse = await api(`/api/sales-outs/${encodeURIComponent(salesOutNo)}`, { method: "GET" });
  assert(outReversed.status === "DRAFT", `sales out reverse response should be DRAFT, got ${outReversed.status}`);
  assert(outAfterReverse.document.status === "DRAFT", `sales out after reverse should be DRAFT, got ${outAfterReverse.document.status}`);
  assert(txnCount("SALES_OUT_REVERSE", salesOutNo) === 1, "sales out reverse should keep inventory reversal txn");

  await api("/api/sales-outs/draft", { body: { ...salesFlow.outPayload, billNo: salesOutNo, remark: "A95出库反审核后可编辑" } });
  const outAfterEdit = await api(`/api/sales-outs/${encodeURIComponent(salesOutNo)}`, { method: "GET" });
  assert(outAfterEdit.document.status === "DRAFT", `edited sales out should stay DRAFT, got ${outAfterEdit.document.status}`);
  assert(outAfterEdit.document.remark === "A95出库反审核后可编辑", `edited sales out remark should persist, got ${outAfterEdit.document.remark}`);
  const outReaudited = await api(`/api/sales-outs/${encodeURIComponent(salesOutNo)}/audit`);
  assert(outReaudited.status === "AUDITED", `sales out should re-audit to AUDITED, got ${outReaudited.status}`);

  return {
    salesOrderNo,
    salesOutNo,
    salesOrderStatuses: ["AUDITED", reversed.status, afterEdit.order.status, reaudited.status],
    salesOutStatuses: ["AUDITED", outReversed.status, outAfterEdit.document.status, outReaudited.status],
    salesOutReverseTxnCount: txnCount("SALES_OUT_REVERSE", salesOutNo)
  };
}

async function verifyWorkbenchBlankNumbering() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const screenshots = [];
  try {
    await page.goto(frontendUrl, { waitUntil: "networkidle" });
    await loginAsAdmin(page);

    await page.locator(".quick-entry", { hasText: "销售订单" }).first().click();
    await page.getByTestId("tab-sales-order-form").waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const input = document.querySelector('[data-testid="sales-bill-no"]');
      return input instanceof HTMLInputElement && input.value === "";
    });
    const salesOrderBillNo = await page.getByTestId("sales-bill-no").inputValue();
    const salesOrderShot = `a95-workbench-sales-order-numbering-${batch}.png`;
    await page.screenshot({ path: path.join(screenshotDir, salesOrderShot), fullPage: true });
    screenshots.push(`verification/playwright/${salesOrderShot}`);

    await page.getByTestId("tab-home").click();
    await page.locator(".quick-entry", { hasText: "销售出库单" }).first().click();
    await page.getByTestId("tab-sales-out-form").waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const input = document.querySelector('[data-testid="sales-out-bill-no"]');
      return input instanceof HTMLInputElement && input.value === "";
    });
    const salesOutBillNo = await page.getByTestId("sales-out-bill-no").inputValue();
    const salesOutShot = `a95-workbench-sales-out-numbering-${batch}.png`;
    await page.screenshot({ path: path.join(screenshotDir, salesOutShot), fullPage: true });
    screenshots.push(`verification/playwright/${salesOutShot}`);

    return { salesOrderBillNo, salesOutBillNo, screenshots };
  } finally {
    await browser.close();
  }
}

await seedStock();
const lifecycle = await verifyReverseBackToEditableDraft();
const workbench = await verifyWorkbenchBlankNumbering();

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  lifecycle,
  workbench
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
