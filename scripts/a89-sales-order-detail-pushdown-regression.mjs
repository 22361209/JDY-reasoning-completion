import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { saveDocument, auditDocument } from "./helpers/document-actions.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a89-sales-order-detail-pushdown-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-26";
let salesOrderNo = "";
let reverseOrderNo = "";
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

function generatedSalesOrderNo(row, label) {
  const value = String(row?.billNo ?? "");
  assert(/^XSDD\d{6}$/.test(value), `${label} should return a system sales order number, got ${JSON.stringify(row)}`);
  return value;
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

const session = await requireApi("/api/system/session", { method: "GET" });
const accountSetId = String(session?.tenant?.id ?? "");
assert(/^[0-9a-f-]{36}$/i.test(accountSetId), `current session should expose account set id, got ${JSON.stringify(accountSetId)}`);
assert(session?.tenant?.schemaName === "public", `A89 direct SQL expects the BLD-TEST public schema, got ${JSON.stringify(session?.tenant?.schemaName)}`);

function dbNumber(sql) {
  return Number(execFileSync("docker", ["exec", "jdy-erp-postgres", "psql", "-U", "jdy", "-d", "jdy_erp", "-tA", "-c", sql], { encoding: "utf8" }).trim() || "0");
}

function stockQty() {
  return dbNumber(`SELECT COALESCE(b.qty_on_hand, 0) FROM md_product p JOIN md_warehouse w ON w.code = '${warehouseCode}' LEFT JOIN inv_stock_balance b ON b.product_id = p.id AND b.warehouse_id = w.id AND b.account_set_id = '${accountSetId}'::uuid WHERE p.code = '${productCode}'`);
}

function salesOutCount() {
  return dbNumber(`SELECT count(DISTINCT so.id) FROM sales_out so JOIN sales_out_line l ON l.bill_id = so.id WHERE l.source_order_no = '${salesOrderNo}'`);
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
  const generatedOrders = [];
  for (const label of ["source", "reverse"]) {
    const saved = await requireApi("/api/sales-orders/draft", {
      body: {
        billNo: null,
        customerCode: "KH-001",
        billDate,
        department: "销售部",
        ownerName: "本地管理员",
        remark: `A89 ${label} ${batch}`,
        lines: [{ productCode, warehouseCode, qty, unitPrice, lineRemark: "A89详情下推回归" }]
      }
    });
    const actualBillNo = generatedSalesOrderNo(saved, `A89 ${label} sales order`);
    await requireApi(`/api/sales-orders/${encodeURIComponent(actualBillNo)}/audit`);
    generatedOrders.push(actualBillNo);
  }
  [salesOrderNo, reverseOrderNo] = generatedOrders;
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
  let generatedDeliveryNoticeNo = "";
  let generatedSalesOutNo = "";
  try {
    await page.goto(frontendUrl, { waitUntil: "networkidle" });
    await loginAsAdmin(page);
    await openSalesOrderDetail(page, salesOrderNo);
    await page.getByTestId("push-delivery-notice-from-order-detail").waitFor({ state: "visible" });
    const detailShot = `a89-sales-order-detail-push-visible-${batch}.png`;
    await page.screenshot({ path: path.join(screenshotDir, detailShot), fullPage: true });
    screenshots.push(`verification/playwright/${detailShot}`);

    await page.getByTestId("push-delivery-notice-from-order-detail").click();
    await page.getByTestId("delivery-notice-party-code").waitFor({ state: "visible" });
    assert(await page.getByTestId("delivery-notice-bill-no").inputValue() === "", "new delivery notice bill no should stay empty before first save");
    await saveDocument(page);
    await page.waitForFunction(() => /^FHTZD\d{6}$/.test(document.querySelector('[data-testid="delivery-notice-bill-no"]')?.value ?? ""));
    generatedDeliveryNoticeNo = await page.getByTestId("delivery-notice-bill-no").inputValue();
    assert(/^FHTZD\d{6}$/.test(generatedDeliveryNoticeNo), `expected generated delivery notice bill no after save, got ${generatedDeliveryNoticeNo}`);
    await auditDocument(page);
    const noticeShot = `a89-delivery-notice-from-detail-audited-${batch}.png`;
    await page.screenshot({ path: path.join(screenshotDir, noticeShot), fullPage: true });
    screenshots.push(`verification/playwright/${noticeShot}`);

    await page.getByTestId("push-sales-out-from-delivery-notice").click();
    await page.getByTestId("sales-out-party-code").waitFor({ state: "visible" });
    assert(await page.getByTestId("sales-out-bill-no").inputValue() === "", "new sales out bill no should stay empty before first save");
    await saveDocument(page);
    await page.waitForFunction(() => /^XSCKD\d{6}$/.test(document.querySelector('[data-testid="sales-out-bill-no"]')?.value ?? ""));
    generatedSalesOutNo = await page.getByTestId("sales-out-bill-no").inputValue();
    assert(/^XSCKD\d{6}$/.test(generatedSalesOutNo), `expected generated sales out bill no after save, got ${generatedSalesOutNo}`);
    await auditDocument(page);
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
    await page.getByTestId("push-delivery-notice-from-order-detail").waitFor({ state: "hidden" });
    const hiddenShot = `a89-sales-order-detail-push-hidden-${batch}.png`;
    await page.screenshot({ path: path.join(screenshotDir, hiddenShot), fullPage: true });
    screenshots.push(`verification/playwright/${hiddenShot}`);
  } finally {
    await browser.close();
  }
  return { beforeQty, afterQty: stockQty(), generatedDeliveryNoticeNo, generatedSalesOutNo, screenshots };
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
assert(!salesOutDetail.document.sourceOrderNo, "sales out header should not keep a single source order no");
assert(salesOutDetail.lines[0]?.sourceOrderNo === salesOrderNo, "sales out line should keep sales order source no");
assert(salesOutDetail.lines[0]?.sourceDeliveryNoticeNo === flow.generatedDeliveryNoticeNo, "sales out line should keep delivery notice source no");
assert(salesOutCount() === 1, "one sales out should be generated from source order");
assert(sourceDetail.order.status === "AUDITED", `source order should stay AUDITED, got ${sourceDetail.order.status}`);
assert(sourceDetail.lines.every((line) => Number(line.remainingQty ?? 0) === 0), "source order should have no remaining outbound qty");
assert(reverseOk.status === "DRAFT", `reverse response should be DRAFT, got ${reverseOk.status}`);
assert(reverseDetail.order.status === "DRAFT", `reverse order should be DRAFT, got ${reverseDetail.order.status}`);
assert(reverseBlocked.status === 409, `source order reverse with audited downstream should be blocked with 409, got ${reverseBlocked.status}`);
assert(JSON.stringify(reverseBlocked.body).includes("销售订单已有已审核发货通知单，不能反审核"), `reverse guard should report audited delivery notice dependency: ${JSON.stringify(reverseBlocked.body)}`);

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  salesOrderNo,
  generatedDeliveryNoticeNo: flow.generatedDeliveryNoticeNo,
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
