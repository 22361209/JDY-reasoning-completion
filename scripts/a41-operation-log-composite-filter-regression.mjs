import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { createSalesOutDraftViaDeliveryNotice } from "./helpers/sales-delivery-notice-flow.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a41-operation-log-composite-filter-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
await installApiSession(apiBase);
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-24";
const logDate = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
const lines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 2, unitPrice: 86 },
  { productCode: "CP-T413874", warehouseCode: "CK-003", qty: 2, unitPrice: 94 },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 3, unitPrice: 12 }
];

await mkdir(screenshotDir, { recursive: true });

async function api(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "POST",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  return { ok: response.ok, status: response.status, data };
}

async function requireApi(pathname, options = {}) {
  const result = await api(pathname, options);
  if (!result.ok) {
    throw new Error(`${options.method ?? "POST"} ${pathname} failed ${result.status}: ${JSON.stringify(result.data)}`);
  }
  return result.data;
}

function generatedBillNo(row, label) {
  const billNo = String(row?.billNo ?? "");
  if (!billNo) {
    throw new Error(`${label} did not return billNo: ${JSON.stringify(row)}`);
  }
  return billNo;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function ensureOperationLogFilters(page) {
  const moduleFilter = page.getByTestId("operation-log-module");
  if (await moduleFilter.isVisible({ timeout: 500 }).catch(() => false)) {
    return;
  }
  await page.getByTestId("list-toggle-filter").click();
  if (await moduleFilter.isVisible({ timeout: 500 }).catch(() => false)) {
    return;
  }
  await page.getByTestId("list-toggle-filter").click();
  await moduleFilter.waitFor({ state: "visible" });
}

async function seedStock() {
  for (const productCode of ["CP-001", "PJ-014", "CP-T413874"]) {
    for (const warehouseCode of ["CK-001", "CK-002", "CK-003"]) {
      await requireApi("/api/inventory/adjustments", {
        body: {
          productCode,
          warehouseCode,
          qtyDelta: 1000,
          txnType: "A41_OPERATION_LOG_FILTER_IN",
          sourceBillType: `A41_OPERATION_LOG:${batch}`
        }
      });
    }
  }
}

async function createRedReverseSalesOut() {
  const orderNo = generatedBillNo(await requireApi("/api/sales-orders/draft", {
    body: {
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      lines
    }
  }), "A41销售订单");
  await requireApi(`/api/sales-orders/${encodeURIComponent(orderNo)}/audit`);
  const billNo = (await createSalesOutDraftViaDeliveryNotice((pathname, body) => requireApi(pathname, { body }), {
    sourceOrderNo: orderNo,
    customerCode: "KH-001",
    billDate,
    department: "销售部",
    ownerName: "本地管理员",
    lines
  })).salesOutNo;
  await requireApi(`/api/sales-outs/${encodeURIComponent(billNo)}/audit`);
  const redBillNo = generatedBillNo(await requireApi(`/api/sales-outs/${encodeURIComponent(billNo)}/red-reverse`, {
    body: { billDate, ownerName: "本地管理员" }
  }), "A41销售出库红冲");
  await requireApi(`/api/sales-outs/${encodeURIComponent(redBillNo)}/audit`);
  return { orderNo, billNo, redBillNo };
}

await seedStock();
const sales = await createRedReverseSalesOut();
const query = new URLSearchParams({
  keyword: sales.redBillNo,
  status: "成功",
  module: "SALES",
  action: "RED_REVERSE",
  dateFrom: logDate,
  dateTo: logDate,
  page: "1",
  pageSize: "200"
});
const logResult = await requireApi(`/api/lists/operation-log-list?${query.toString()}`, { method: "GET" });
const redLog = logResult.rows.find((row) => row.targetNo === sales.redBillNo && row.action === "RED_REVERSE");
assert(redLog, `operation log should contain RED_REVERSE for ${sales.redBillNo}`);
assert(redLog.module === "SALES", `operation log module expected SALES, got ${redLog?.module}`);
assert(redLog.status === "成功", `operation log status expected 成功, got ${redLog?.status}`);

const mismatchQuery = new URLSearchParams(query);
mismatchQuery.set("module", "PURCHASE");
const mismatchResult = await requireApi(`/api/lists/operation-log-list?${mismatchQuery.toString()}`, { method: "GET" });
assert(!mismatchResult.rows.some((row) => row.targetNo === sales.redBillNo), "PURCHASE module filter should exclude SALES red reverse log");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const screenshots = [];
try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await page.getByTestId("module-系统设置").hover();
  await page.getByTestId("query-operation-log-list").click();
  await page.getByTestId("tab-operation-log-list").waitFor({ state: "visible" });
  await ensureOperationLogFilters(page);
  const resetResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET" && url.pathname === "/api/lists/operation-log-list";
  });
  await page.getByTestId("list-reset").click();
  await resetResponsePromise;
  await page.getByTestId("list-keyword").fill(sales.redBillNo);
  await page.getByTestId("operation-log-module").selectOption("SALES");
  await page.getByTestId("operation-log-action").selectOption("RED_REVERSE");
  await page.getByTestId("list-date-range").click();
  await page.getByTestId("list-date-from").fill(logDate);
  await page.getByTestId("list-date-to").fill(logDate);
  await page.getByTestId("list-date-range-apply").click();
  await page.getByTestId("column-filter-status").click();
  await page.getByTestId("column-filter-dialog").getByRole("button", { name: "等于", exact: true }).click();
  await page.getByTestId("column-filter-input").fill("成功");
  await page.getByTestId("column-filter-ok").click();
  const listRequestPromise = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return request.method() === "GET" && url.pathname === "/api/lists/operation-log-list";
  });
  await page.getByTestId("list-query").click();
  const listRequest = await listRequestPromise;
  const uiColumnFilters = JSON.parse(new URL(listRequest.url()).searchParams.get("columnFilters") || "{}");
  assert(uiColumnFilters.status?.operator === "等于" && uiColumnFilters.status?.value === "成功", `UI status filter should preserve exact equality: ${JSON.stringify(uiColumnFilters.status)}`);
  const table = page.getByTestId("vxe-list-table");
  const matchingRow = table.locator("tr")
    .filter({ hasText: sales.redBillNo })
    .filter({ hasText: "RED_REVERSE" })
    .filter({ hasText: "SALES" })
    .first();
  await matchingRow.waitFor({ state: "visible" });
  const screenshot = `a41-operation-log-composite-filter-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });
  screenshots.push(`verification/playwright/${screenshot}`);
} finally {
  await browser.close();
}

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  salesOutNo: sales.billNo,
  salesRedReverseBillNo: sales.redBillNo,
  apiChecks: {
    positiveTotal: logResult.total,
    positiveRows: logResult.rows.length,
    mismatchTotal: mismatchResult.total,
    mismatchRows: mismatchResult.rows.length,
    redLog
  },
  screenshots
};
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
