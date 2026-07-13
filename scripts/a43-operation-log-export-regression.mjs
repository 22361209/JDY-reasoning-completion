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
const actorUsername = "admin";
const actorDisplayName = "本地管理员";
const operatorLabel = `${actorDisplayName}（${actorUsername}）`;
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
  return { ok: response.ok, status: response.status, text, headers: response.headers };
}

async function requireJson(pathname, options = {}) {
  const result = await api(pathname, options);
  if (!result.ok) {
    throw new Error(`${options.method ?? "POST"} ${pathname} failed ${result.status}: ${result.text}`);
  }
  return result.text ? JSON.parse(result.text) : {};
}

function generatedBillNo(row, label) {
  const billNo = String(row?.billNo ?? "");
  if (!billNo) {
    throw new Error(`${label} did not return billNo: ${JSON.stringify(row)}`);
  }
  return billNo;
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
  await page.getByTestId("list-toggle-filter").click();
  if (await moduleFilter.isVisible({ timeout: 500 }).catch(() => false)) {
    return;
  }
  await page.getByTestId("list-toggle-filter").click();
  await moduleFilter.waitFor({ state: "visible" });
}

function assertIncludes(label, text, expected) {
  assert(text.includes(expected), `${label} should include ${expected}`);
}

async function seedStock() {
  for (const productCode of ["CP-001", "PJ-014", "CP-T413874"]) {
    for (const warehouseCode of ["CK-001", "CK-002", "CK-003"]) {
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
  const orderNo = generatedBillNo(await requireJson("/api/sales-orders/draft", {
    body: {
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: actorDisplayName,
      lines
    }
  }), "A43销售订单");
  await requireJson(`/api/sales-orders/${encodeURIComponent(orderNo)}/audit`);
  const billNo = (await createSalesOutDraftViaDeliveryNotice((pathname, body) => requireJson(pathname, { body }), {
    sourceOrderNo: orderNo,
    customerCode: "KH-001",
    billDate,
    department: "销售部",
    ownerName: actorDisplayName,
    lines
  })).salesOutNo;
  await requireJson(`/api/sales-outs/${encodeURIComponent(billNo)}/audit`);
  const redBillNo = generatedBillNo(await requireJson(`/api/sales-outs/${encodeURIComponent(billNo)}/red-reverse`, {
    body: { billDate, ownerName: actorDisplayName }
  }), "A43销售出库红冲");
  await requireJson(`/api/sales-outs/${encodeURIComponent(redBillNo)}/audit`);
  return { orderNo, billNo, redBillNo };
}

function exportQuery(redBillNo) {
  return new URLSearchParams({
    keyword: redBillNo,
    scope: "current",
    actorType: "USER",
    columnFilters: JSON.stringify({ status: { operator: "等于", value: "成功" } }),
    module: "SALES",
    action: "RED_REVERSE",
    operator: actorUsername,
    targetType: "sales_out",
    dateFrom: logDate,
    dateTo: logDate,
    page: "1",
    pageSize: "1000"
  });
}

function parseCsv(text) {
  const source = text.replace(/^\uFEFF/, "");
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n") {
      record.push(field.replace(/\r$/, ""));
      if (record.some((value) => value !== "")) records.push(record);
      record = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || record.length) {
    record.push(field.replace(/\r$/, ""));
    records.push(record);
  }
  const [headers = [], ...rows] = records;
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function assertListCsvParity(listRows, csvRows, label) {
  const mapping = {
    id: "日志ID", operatedAt: "操作时间", module: "模块", action: "动作", actorType: "主体类型",
    actorUsername: "操作人账号", actorDisplayName: "操作时姓名", operator: "操作人",
    accountSetId: "账套ID", accountSetCode: "账套编码", accountSetName: "账套名称",
    targetType: "对象类型", targetId: "对象ID", targetNo: "业务单号", status: "状态", reason: "失败原因",
    beforeState: "操作前状态", afterState: "操作后状态"
  };
  assert(listRows.length === csvRows.length, `${label} row count mismatch: list=${listRows.length}, csv=${csvRows.length}`);
  listRows.forEach((row, index) => {
    const csvRow = csvRows[index];
    Object.entries(mapping).forEach(([fieldName, csvHeader]) => {
      const rawValue = row[fieldName];
      const listValue = rawValue && typeof rawValue === "object" ? JSON.stringify(rawValue) : String(rawValue ?? "");
      assert(listValue === String(csvRow[csvHeader] ?? ""), `${label} row ${index} ${fieldName} mismatch`);
    });
  });
}

await seedStock();
const sales = await createRedReverseSalesOut();
const query = exportQuery(sales.redBillNo);
const listResult = await requireJson(`/api/lists/operation-log-list?${query.toString()}`, { method: "GET" });
const csv = await requireText(`/api/lists/operation-log-list/export.csv?${query.toString()}`, { method: "GET" });
const csvRows = parseCsv(csv);
assertIncludes("csv header", csv, "日志ID,操作时间,模块,动作,主体类型,操作人账号,操作时姓名,操作人,账套ID,账套编码,账套名称,对象类型,对象ID,业务单号,状态,失败原因,操作前状态,操作后状态");
assertIncludes("csv red bill", csv, sales.redBillNo);
assertIncludes("csv module", csv, "SALES");
assertIncludes("csv action", csv, "RED_REVERSE");
assertIncludes("csv target type", csv, "sales_out");
assertIncludes("csv operator", csv, operatorLabel);
assertIncludes("csv status", csv, "成功");
assertListCsvParity(listResult.rows, csvRows, "API list/export");

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
  await page.getByTestId("operation-log-module").selectOption("SALES");
  await page.getByTestId("operation-log-action").selectOption("RED_REVERSE");
  await page.getByTestId("operation-log-scope").selectOption("current");
  await page.getByTestId("operation-log-actor-type").selectOption("USER");
  await page.getByTestId("operation-log-operator").fill(actorUsername);
  await page.getByTestId("operation-log-target-type").selectOption("sales_out");
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
  assert(new URL(listRequest.url()).searchParams.get("scope") === "current", "UI list request should preserve current scope");
  assert(new URL(listRequest.url()).searchParams.get("actorType") === "USER", "UI list request should preserve USER actor type");
  await page.getByTestId("vxe-list-table").getByText(sales.redBillNo).waitFor({ state: "visible" });
  await page.getByTestId("list-more-actions").hover();
  const [download, exportRequest] = await Promise.all([
    page.waitForEvent("download"),
    page.waitForRequest((request) => new URL(request.url()).pathname === "/api/lists/operation-log-list/export.csv"),
    page.getByTestId("list-export").click()
  ]);
  const exportColumnFilters = JSON.parse(new URL(exportRequest.url()).searchParams.get("columnFilters") || "{}");
  assert(exportColumnFilters.status?.operator === "等于" && exportColumnFilters.status?.value === "成功", `export should preserve exact status equality: ${JSON.stringify(exportColumnFilters.status)}`);
  assert(new URL(exportRequest.url()).searchParams.get("scope") === "current", "UI export request should preserve current scope");
  assert(new URL(exportRequest.url()).searchParams.get("actorType") === "USER", "UI export request should preserve USER actor type");
  downloadFileName = download.suggestedFilename();
  downloadedCsv = await readFile(await download.path(), "utf8");
  assertIncludes("download csv red bill", downloadedCsv, sales.redBillNo);
  assertIncludes("download csv target type", downloadedCsv, "sales_out");
  assertListCsvParity(listResult.rows, parseCsv(downloadedCsv), "downloaded list/export");
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
    csvHeaderOk: csv.includes("日志ID,操作时间,模块,动作,主体类型"),
    listCsvIdOrder: listResult.rows.map((row) => row.id),
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
