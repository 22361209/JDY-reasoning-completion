import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { createSalesOutDraftViaDeliveryNotice } from "./helpers/sales-delivery-notice-flow.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a42-operation-log-operator-target-filter-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
await installApiSession(apiBase);
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-24";
const logDate = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
const operator = "本地管理员";
const lines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 2, unitPrice: 86 },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 2, unitPrice: 94 },
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
  await ensureOperationLogFilters(page);
  if (await moduleFilter.isVisible({ timeout: 500 }).catch(() => false)) {
    return;
  }
  await ensureOperationLogFilters(page);
  await moduleFilter.waitFor({ state: "visible" });
}

async function seedStock() {
  for (const productCode of ["CP-001", "PJ-014", "CP-T413874"]) {
    for (const warehouseCode of ["CK-001", "CK-002", "CK-T413874"]) {
      await requireApi("/api/inventory/adjustments", {
        body: {
          productCode,
          warehouseCode,
          qtyDelta: 1000,
          txnType: "A42_OPERATION_LOG_FILTER_IN",
          sourceBillType: `A42_OPERATION_LOG:${batch}`
        }
      });
    }
  }
}

async function createRedReverseSalesOut() {
  const orderNo = `XSDD-A42-${batch}`;
  const billNo = `XSCK-A42-${batch}`;
  const redBillNo = `RED-A42-XSCK-${batch}`;
  await requireApi("/api/sales-orders/draft", {
    body: {
      billNo: orderNo,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: operator,
      lines
    }
  });
  await requireApi(`/api/sales-orders/${encodeURIComponent(orderNo)}/audit`);
  await createSalesOutDraftViaDeliveryNotice((pathname, body) => requireApi(pathname, { body }), {
    billNo,
    sourceOrderNo: orderNo,
    customerCode: "KH-001",
    billDate,
    department: "销售部",
    ownerName: operator,
    lines
  }, `FHTZ-A42-${batch}`);
  await requireApi(`/api/sales-outs/${encodeURIComponent(billNo)}/audit`);
  await requireApi(`/api/sales-outs/${encodeURIComponent(billNo)}/red-reverse`, {
    body: { redBillNo, billDate, ownerName: operator }
  });
  return { orderNo, billNo, redBillNo };
}

await seedStock();
const sales = await createRedReverseSalesOut();
const query = new URLSearchParams({
  keyword: sales.redBillNo,
  status: "成功",
  module: "SALES",
  action: "RED_REVERSE",
  operator,
  targetType: "sales_out",
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
assert(redLog.operator === operator, `operation log operator expected ${operator}, got ${redLog?.operator}`);
assert(redLog.targetType === "sales_out", `operation log targetType expected sales_out, got ${redLog?.targetType}`);

const mismatchOperatorQuery = new URLSearchParams(query);
mismatchOperatorQuery.set("operator", "不存在的操作人");
const mismatchOperatorResult = await requireApi(`/api/lists/operation-log-list?${mismatchOperatorQuery.toString()}`, { method: "GET" });
assert(!mismatchOperatorResult.rows.some((row) => row.targetNo === sales.redBillNo), "mismatched operator should exclude red reverse log");

const mismatchTargetQuery = new URLSearchParams(query);
mismatchTargetQuery.set("targetType", "purchase_in");
const mismatchTargetResult = await requireApi(`/api/lists/operation-log-list?${mismatchTargetQuery.toString()}`, { method: "GET" });
assert(!mismatchTargetResult.rows.some((row) => row.targetNo === sales.redBillNo), "mismatched targetType should exclude sales_out red reverse log");

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
  await page.getByTestId("list-keyword").fill(sales.redBillNo);
  await page.getByTestId("list-status").selectOption("成功");
  await page.getByTestId("operation-log-module").selectOption("SALES");
  await page.getByTestId("operation-log-action").selectOption("RED_REVERSE");
  await page.getByTestId("operation-log-operator").fill(operator);
  await page.getByTestId("operation-log-target-type").selectOption("sales_out");
  await page.getByTestId("operation-log-date-from").fill(logDate);
  await page.getByTestId("operation-log-date-to").fill(logDate);
  await page.getByTestId("list-query").click();
  const table = page.getByTestId("vxe-list-table");
  await table.getByText(sales.redBillNo).waitFor({ state: "visible" });
  await table.getByText("sales_out").first().waitFor({ state: "visible" });
  await table.getByText(operator).first().waitFor({ state: "visible" });
  await table.getByText("RED_REVERSE").first().waitFor({ state: "visible" });
  await table.getByText("SALES").first().waitFor({ state: "visible" });
  const screenshot = `a42-operation-log-operator-target-filter-${batch}.png`;
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
    mismatchOperatorTotal: mismatchOperatorResult.total,
    mismatchOperatorRows: mismatchOperatorResult.rows.length,
    mismatchTargetTypeTotal: mismatchTargetResult.total,
    mismatchTargetTypeRows: mismatchTargetResult.rows.length,
    redLog
  },
  screenshots
};
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
