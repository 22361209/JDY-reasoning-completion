import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { createSalesOutDraftViaDeliveryNotice } from "./helpers/sales-delivery-notice-flow.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a43-operation-log-export-regression.json");
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
  return { ok: response.ok, status: response.status, text, headers: response.headers };
}

async function requireJson(pathname, options = {}) {
  const result = await api(pathname, options);
  if (!result.ok) {
    throw new Error(`${options.method ?? "POST"} ${pathname} failed ${result.status}: ${result.text}`);
  }
  return result.text ? JSON.parse(result.text) : {};
}

async function requireText(pathname, options = {}) {
  const result = await api(pathname, options);
  if (!result.ok) {
    throw new Error(`${options.method ?? "GET"} ${pathname} failed ${result.status}: ${result.text}`);
  }
  return result.text;
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

function assertIncludes(label, text, expected) {
  assert(text.includes(expected), `${label} should include ${expected}`);
}

async function seedStock() {
  for (const productCode of ["CP-001", "PJ-014", "CP-T413874"]) {
    for (const warehouseCode of ["CK-001", "CK-002", "CK-T413874"]) {
      await requireJson("/api/inventory/adjustments", {
        body: {
          productCode,
          warehouseCode,
          qtyDelta: 1000,
          txnType: "A43_OPERATION_LOG_EXPORT_IN",
          sourceBillType: `A43_OPERATION_LOG:${batch}`
        }
      });
    }
  }
}

async function createRedReverseSalesOut() {
  const orderNo = `XSDD-A43-${batch}`;
  const billNo = `XSCK-A43-${batch}`;
  const redBillNo = `RED-A43-XSCK-${batch}`;
  await requireJson("/api/sales-orders/draft", {
    body: {
      billNo: orderNo,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: operator,
      lines
    }
  });
  await requireJson(`/api/sales-orders/${encodeURIComponent(orderNo)}/audit`);
  await createSalesOutDraftViaDeliveryNotice((pathname, body) => requireJson(pathname, { body }), {
    billNo,
    sourceOrderNo: orderNo,
    customerCode: "KH-001",
    billDate,
    department: "销售部",
    ownerName: operator,
    lines
  }, `FHTZ-A43-${batch}`);
  await requireJson(`/api/sales-outs/${encodeURIComponent(billNo)}/audit`);
  await requireJson(`/api/sales-outs/${encodeURIComponent(billNo)}/red-reverse`, {
    body: { redBillNo, billDate, ownerName: operator }
  });
  return { orderNo, billNo, redBillNo };
}

function exportQuery(redBillNo) {
  return new URLSearchParams({
    keyword: redBillNo,
    status: "成功",
    module: "SALES",
    action: "RED_REVERSE",
    operator,
    targetType: "sales_out",
    dateFrom: logDate,
    dateTo: logDate,
    page: "1",
    pageSize: "1000"
  });
}

await seedStock();
const sales = await createRedReverseSalesOut();
const query = exportQuery(sales.redBillNo);
const csv = await requireText(`/api/lists/operation-log-list/export.csv?${query.toString()}`, { method: "GET" });
assertIncludes("csv header", csv, "操作时间,模块,动作,对象类型,业务单号,操作人,状态,失败原因");
assertIncludes("csv red bill", csv, sales.redBillNo);
assertIncludes("csv module", csv, "SALES");
assertIncludes("csv action", csv, "RED_REVERSE");
assertIncludes("csv target type", csv, "sales_out");
assertIncludes("csv operator", csv, operator);
assertIncludes("csv status", csv, "成功");

const mismatchQuery = exportQuery(sales.redBillNo);
mismatchQuery.set("targetType", "purchase_in");
const mismatchCsv = await requireText(`/api/lists/operation-log-list/export.csv?${mismatchQuery.toString()}`, { method: "GET" });
assert(!mismatchCsv.includes(sales.redBillNo), "mismatched targetType export should not contain red bill");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, acceptDownloads: true });
const screenshots = [];
let downloadedCsv = "";
let downloadFileName = "";
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
  await page.getByTestId("vxe-list-table").getByText(sales.redBillNo).waitFor({ state: "visible" });
  await page.getByTestId("list-more-actions").hover();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("list-export").click()
  ]);
  downloadFileName = download.suggestedFilename();
  downloadedCsv = await readFile(await download.path(), "utf8");
  assertIncludes("download csv red bill", downloadedCsv, sales.redBillNo);
  assertIncludes("download csv target type", downloadedCsv, "sales_out");
  await page.getByTestId("list-export-message").getByText("引出文件已生成").waitFor({ state: "visible" });
  const screenshot = `a43-operation-log-export-${batch}.png`;
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
    csvHeaderOk: csv.includes("操作时间,模块,动作,对象类型,业务单号,操作人,状态,失败原因"),
    csvContainsRedBill: csv.includes(sales.redBillNo),
    mismatchTargetTypeContainsRedBill: mismatchCsv.includes(sales.redBillNo)
  },
  frontendChecks: {
    downloadFileName,
    downloadedCsvContainsRedBill: downloadedCsv.includes(sales.redBillNo),
    downloadedCsvContainsTargetType: downloadedCsv.includes("sales_out")
  },
  screenshots
};
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
