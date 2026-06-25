import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a89-sales-order-detail-pushdown-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-26";
const salesOrderNo = `XSDD-A89-${batch}`;
const reverseOrderNo = `XSDD-A89-R-${batch}`;
const productCode = "CP-001";
const warehouseCode = "CK-001";
const qty = 3;
const unitPrice = 86;

await installApiSession(apiBase);
await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function api(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "POST",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  if (!response.ok && !options.expectFailure) {
    throw new Error(`${options.method ?? "POST"} ${pathname} failed ${response.status}: ${text}`);
  }
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function requireApi(pathname, options = {}) {
  const result = await api(pathname, options);
  assert(result.status >= 200 && result.status < 300, `${options.method ?? "POST"} ${pathname} failed ${result.status}`);
  return result.body;
}

function dbNumber(sql) {
  return Number(execFileSync("docker", ["exec", "jdy-erp-postgres", "psql", "-U", "jdy", "-d", "jdy_erp", "-tA", "-c", sql], { encoding: "utf8" }).trim() || "0");
}

function stockQty() {
  return dbNumber(`SELECT COALESCE(b.qty_on_hand, 0) FROM md_product p JOIN md_warehouse w ON w.code = '${warehouseCode}' LEFT JOIN inv_stock_balance b ON b.product_id = p.id AND b.warehouse_id = w.id WHERE p.code = '${productCode}'`);
}

function salesOutCount() {
  return dbNumber(`SELECT count(*) FROM sales_out WHERE source_order_id = (SELECT id FROM sales_order WHERE bill_no = '${salesOrderNo}')`);
}

async function seed() {
  await requireApi("/api/inventory/adjustments", {
    body: {
      productCode,
      warehouseCode,
      qtyDelta: 2000,
      txnType: "A89_DETAIL_PUSH_SEED",
      sourceBillType: `A89_DETAIL_PUSH:${batch}`
    }
  });
  for (const billNo of [salesOrderNo, reverseOrderNo]) {
    await requireApi("/api/sales-orders/draft", {
      body: {
        billNo,
        customerCode: "KH-001",
        billDate,
        department: "销售部",
        ownerName: "本地管理员",
        lines: [{ productCode, warehouseCode, qty, unitPrice, lineRemark: "A89详情下推回归" }]
      }
    });
    await requireApi(`/api/sales-orders/${encodeURIComponent(billNo)}/audit`);
  }
}

async function openSalesOrderDetail(page, billNo) {
  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("query-sales-order-form").click();
  await page.getByTestId("tab-sales-order-form-list").waitFor({ state: "visible" });
  await page.getByTestId("list-keyword").fill(billNo);
  await page.getByTestId("list-keyword").press("Enter");
  await page.getByTestId(`open-document-${billNo}`).click();
  await page.getByTestId("document-status").waitFor({ state: "visible" });
  await page.getByText(billNo).first().waitFor({ state: "visible" });
}

async function runFrontendFlow() {
  const beforeQty = stockQty();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const screenshots = [];
  let generatedSalesOutNo = "";
  try {
    await page.goto(frontendUrl, { waitUntil: "networkidle" });
    await loginAsAdmin(page);
    await openSalesOrderDetail(page, salesOrderNo);
    await page.getByTestId("push-sales-out-from-order-detail").waitFor({ state: "visible" });
    const detailShot = `a89-sales-order-detail-push-visible-${batch}.png`;
    await page.screenshot({ path: path.join(screenshotDir, detailShot), fullPage: true });
    screenshots.push(`verification/playwright/${detailShot}`);

    await page.getByTestId("push-sales-out-from-order-detail").click();
    await page.getByTestId("push-confirm-dialog").waitFor({ state: "visible" });
    await page.getByTestId("push-confirm-ok").click();
    await page.getByTestId("sales-out-source-order-no").waitFor({ state: "visible" });
    generatedSalesOutNo = await page.getByTestId("sales-out-bill-no").inputValue();
    assert(generatedSalesOutNo.startsWith("XSCK-"), `expected generated sales out bill no, got ${generatedSalesOutNo}`);
    await page.getByTestId("save-sales-order").click();
    await page.getByText("草稿已保存").waitFor({ state: "visible", timeout: 10000 });
    await page.getByTestId("audit-sales-order").click();
    await page.getByText("审核成功").waitFor({ state: "visible", timeout: 10000 });
    const outShot = `a89-sales-out-from-detail-audited-${batch}.png`;
    await page.screenshot({ path: path.join(screenshotDir, outShot), fullPage: true });
    screenshots.push(`verification/playwright/${outShot}`);

    await page.getByTestId("module-销售管理").hover();
    await page.getByTestId("query-sales-out-form").click();
    await page.getByTestId("tab-sales-out-form-list").waitFor({ state: "visible" });
    await page.getByTestId("list-keyword").fill(generatedSalesOutNo);
    await page.getByTestId("list-keyword").press("Enter");
    await page.getByTestId(`open-document-${generatedSalesOutNo}`).waitFor({ state: "visible" });

    await page.goto(frontendUrl, { waitUntil: "networkidle" });
    await loginAsAdmin(page);
    await openSalesOrderDetail(page, salesOrderNo);
    await page.getByTestId("push-sales-out-from-order-detail").waitFor({ state: "hidden" });
    const hiddenShot = `a89-sales-order-detail-push-hidden-${batch}.png`;
    await page.screenshot({ path: path.join(screenshotDir, hiddenShot), fullPage: true });
    screenshots.push(`verification/playwright/${hiddenShot}`);
  } finally {
    await browser.close();
  }
  return { beforeQty, afterQty: stockQty(), generatedSalesOutNo, screenshots };
}

await seed();
const flow = await runFrontendFlow();
const salesOutDetail = await requireApi(`/api/sales-outs/${encodeURIComponent(flow.generatedSalesOutNo)}`, { method: "GET" });
const sourceDetail = await requireApi(`/api/sales-orders/${encodeURIComponent(salesOrderNo)}`, { method: "GET" });
const reverseOk = await requireApi(`/api/sales-orders/${encodeURIComponent(reverseOrderNo)}/reverse`);
const reverseDetail = await requireApi(`/api/sales-orders/${encodeURIComponent(reverseOrderNo)}`, { method: "GET" });
const reverseBlocked = await api(`/api/sales-orders/${encodeURIComponent(salesOrderNo)}/reverse`, { expectFailure: true });

assert(flow.afterQty === flow.beforeQty - qty, `stock should decrease by ${qty}: ${flow.beforeQty} -> ${flow.afterQty}`);
assert(salesOutDetail.document.status === "AUDITED", `sales out should be AUDITED, got ${salesOutDetail.document.status}`);
assert(salesOutDetail.document.sourceOrderNo === salesOrderNo, "sales out should keep source order no");
assert(salesOutCount() === 1, "one sales out should be generated from source order");
assert(sourceDetail.order.status === "AUDITED", `source order should stay AUDITED, got ${sourceDetail.order.status}`);
assert(sourceDetail.lines.every((line) => Number(line.remainingQty ?? 0) === 0), "source order should have no remaining outbound qty");
assert(reverseOk.status === "REVERSED", `reverse response should be REVERSED, got ${reverseOk.status}`);
assert(reverseDetail.order.status === "REVERSED", `reverse order should be REVERSED, got ${reverseDetail.order.status}`);
assert(reverseBlocked.status === 409, `source order reverse with audited downstream should be blocked with 409, got ${reverseBlocked.status}`);

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  salesOrderNo,
  generatedSalesOutNo: flow.generatedSalesOutNo,
  reverseOrderNo,
  beforeQty: flow.beforeQty,
  afterQty: flow.afterQty,
  salesOutStatus: salesOutDetail.document.status,
  sourceRemaining: sourceDetail.lines.map((line) => Number(line.remainingQty ?? 0)),
  reverseStatus: reverseDetail.order.status,
  reverseBlockedStatus: reverseBlocked.status,
  salesOutListNavigation: "tab-sales-out-form-list visible",
  screenshots: flow.screenshots
};
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
