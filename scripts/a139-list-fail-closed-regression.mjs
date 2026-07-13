#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

import { loginApi, loginAs, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const apiBase = "http://127.0.0.1:8080";
const frontendUrl = "http://127.0.0.1:5173/";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a139-list-fail-closed-regression.json");
const countBillNo = `A139PD${batch}`;
const gainBillNo = `A139PY${batch}`;
const lossBillNo = `A139PK${batch}`;

const unknownListKeys = [
  `a139-unknown-${batch}`,
  `a139-${batch}-master-list`,
  `a139-${batch}-source-selector`,
  "standard-list",
  "error-list",
  "permission-denied-list"
];
const hiddenEntryIds = [
  "sales-detail-report",
  "sales-profit-report",
  "stock-flow-report",
  "scrap-report",
  "ar-summary-report",
  "coding-rule-list"
];
const hiddenEntryLabels = ["销售明细表", "销售利润表", "商品收发明细表", "材料报废统计表", "应收汇总表", "编码规则"];
const reportKeys = ["purchase-summary-report", "task-track-report"];
const stockContracts = [
  {
    listKey: "stock-count-form-list",
    entryId: "stock-count-form",
    billNo: countBillNo,
    permission: "inventory.stock_count.audit",
    expectedFields: ["billDate", "billNo", "businessType", "status", "department", "productCode", "productName", "warehouse", "unit", "netWeight", "grossWeight", "systemQty", "countedQty", "diffQty"],
    visibleLabels: ["系统库存", "实盘数量", "差异"]
  },
  {
    listKey: "stock-count-gain-form-list",
    entryId: "stock-count-gain-form",
    billNo: gainBillNo,
    permission: "inventory.stock_count_gain.audit",
    expectedFields: ["billDate", "billNo", "sourceBillNo", "status", "productCode", "productName", "warehouse", "unit", "netWeight", "grossWeight", "qty", "amount"],
    visibleLabels: ["源盘点单", "盘盈数量", "金额"]
  },
  {
    listKey: "stock-count-loss-form-list",
    entryId: "stock-count-loss-form",
    billNo: lossBillNo,
    permission: "inventory.stock_count_loss.audit",
    expectedFields: ["billDate", "billNo", "sourceBillNo", "status", "productCode", "productName", "warehouse", "unit", "netWeight", "grossWeight", "qty", "amount"],
    visibleLabels: ["源盘点单", "盘亏数量", "金额"]
  }
];

await mkdir(verificationDir, { recursive: true });
await mkdir(screenshotDir, { recursive: true });

const evidence = {
  batch,
  generatedAt: new Date().toISOString(),
  ok: false,
  fixtures: { countBillNo, gainBillNo, lossBillNo },
  requests: [],
  assertions: [],
  screenshots: [],
  cleanup: { attempted: false, remainingRows: null }
};

function assert(condition, message, details = undefined) {
  if (!condition) {
    const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
    throw new Error(`${message}${suffix}`);
  }
  evidence.assertions.push({ message, details });
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function dbScalar(sql) {
  return execFileSync(
    "docker",
    ["exec", "jdy-erp-postgres", "psql", "-X", "-U", "jdy", "-d", "jdy_erp", "-v", "ON_ERROR_STOP=1", "-tAq", "-c", sql],
    { encoding: "utf8" }
  ).trim();
}

function createStockFixtures() {
  const result = dbScalar(`
    WITH reference AS (
      SELECT product.id AS product_id,
             product.code AS product_code,
             product.name AS product_name,
             COALESCE(product.spec, '') AS product_spec,
             COALESCE(product.unit, '') AS product_unit,
             product.net_weight,
             product.gross_weight,
             warehouse.id AS warehouse_id
      FROM public.md_product product
      CROSS JOIN public.md_warehouse warehouse
      WHERE product.code = 'CP-001'
        AND warehouse.code = 'CK-001'
        AND product.enabled = TRUE
        AND warehouse.enabled = TRUE
      LIMIT 1
    ), count_header AS (
      INSERT INTO public.stock_count (bill_no, bill_date, department, business_type, status, owner_name)
      SELECT ${sqlLiteral(countBillNo)}, CURRENT_DATE, 'A139验收部', '盘点单', 'AUDITED', 'A139自动化'
      FROM reference
      RETURNING id
    ), count_line AS (
      INSERT INTO public.stock_count_line (
        bill_id, line_no, product_id, warehouse_id, system_qty, counted_qty, diff_qty, unit_price, line_remark,
        product_code_snapshot, product_name_snapshot, product_spec_snapshot, product_unit_snapshot, net_weight_snapshot, gross_weight_snapshot
      )
      SELECT count_header.id, 1, reference.product_id, reference.warehouse_id, 10, 12, 2, 6.17, 'A139_COUNT',
             reference.product_code, reference.product_name, reference.product_spec, reference.product_unit, reference.net_weight, reference.gross_weight
      FROM count_header CROSS JOIN reference
      RETURNING bill_id
    ), gain_header AS (
      INSERT INTO public.stock_count_gain (bill_no, bill_date, department, status, total_amount, owner_name, source_bill_id)
      SELECT ${sqlLiteral(gainBillNo)}, CURRENT_DATE, 'A139验收部', 'DRAFT', 12.34, 'A139自动化', count_header.id
      FROM count_header
      RETURNING id, source_bill_id
    ), gain_line AS (
      INSERT INTO public.stock_count_gain_line (
        bill_id, line_no, product_id, warehouse_id, source_bill_id, source_line_no, qty, unit_price, amount, line_remark,
        product_code_snapshot, product_name_snapshot, product_spec_snapshot, product_unit_snapshot, net_weight_snapshot, gross_weight_snapshot
      )
      SELECT gain_header.id, 1, reference.product_id, reference.warehouse_id, gain_header.source_bill_id, 1, 2, 6.17, 12.34, 'A139_GAIN',
             reference.product_code, reference.product_name, reference.product_spec, reference.product_unit, reference.net_weight, reference.gross_weight
      FROM gain_header CROSS JOIN reference
      RETURNING bill_id
    ), loss_header AS (
      INSERT INTO public.stock_count_loss (bill_no, bill_date, department, status, total_amount, owner_name, source_bill_id)
      SELECT ${sqlLiteral(lossBillNo)}, CURRENT_DATE, 'A139验收部', 'DRAFT', 5.67, 'A139自动化', count_header.id
      FROM count_header
      RETURNING id, source_bill_id
    ), loss_line AS (
      INSERT INTO public.stock_count_loss_line (
        bill_id, line_no, product_id, warehouse_id, source_bill_id, source_line_no, qty, unit_price, amount, line_remark,
        product_code_snapshot, product_name_snapshot, product_spec_snapshot, product_unit_snapshot, net_weight_snapshot, gross_weight_snapshot
      )
      SELECT loss_header.id, 1, reference.product_id, reference.warehouse_id, loss_header.source_bill_id, 1, 1, 5.67, 5.67, 'A139_LOSS',
             reference.product_code, reference.product_name, reference.product_spec, reference.product_unit, reference.net_weight, reference.gross_weight
      FROM loss_header CROSS JOIN reference
      RETURNING bill_id
    )
    SELECT (SELECT count(*) FROM count_line)
         + (SELECT count(*) FROM gain_line)
         + (SELECT count(*) FROM loss_line)
  `);
  assert(result === "3", "A139 必须创建三类盘点 header 唯一夹具", { createdLineCount: result });
}

function cleanupStockFixtures() {
  evidence.cleanup.attempted = true;
  dbScalar(`
    DELETE FROM public.stock_count_gain WHERE bill_no = ${sqlLiteral(gainBillNo)};
    DELETE FROM public.stock_count_loss WHERE bill_no = ${sqlLiteral(lossBillNo)};
    DELETE FROM public.stock_count WHERE bill_no = ${sqlLiteral(countBillNo)};
  `);
  evidence.cleanup.remainingRows = Number(dbScalar(`
    SELECT (SELECT count(*) FROM public.stock_count WHERE bill_no = ${sqlLiteral(countBillNo)})
         + (SELECT count(*) FROM public.stock_count_gain WHERE bill_no = ${sqlLiteral(gainBillNo)})
         + (SELECT count(*) FROM public.stock_count_loss WHERE bill_no = ${sqlLiteral(lossBillNo)})
  `));
}

async function request(cookie, pathname) {
  const response = await fetch(`${apiBase}${pathname}`, { headers: { Cookie: cookie } });
  const text = await response.text();
  let data = null;
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { status: response.status, ok: response.ok, text, data };
}

function expectStatus(label, response, expectedStatus) {
  evidence.requests.push({ label, expectedStatus, actualStatus: response.status });
  assert(response.status === expectedStatus, `${label} 应返回 ${expectedStatus}`, { status: response.status, body: response.text.slice(0, 400) });
}

function assertNoSalesFallback(label, response) {
  assert(!/XSDD\d{6}|priceTaxTotal|customerCode|"客户"/.test(response.text), `${label} 不得泄露销售订单行或销售列`, { body: response.text.slice(0, 400) });
}

async function verifyUnknownKeys(cookiesByRole) {
  for (const [role, cookie] of Object.entries(cookiesByRole)) {
    for (const listKey of unknownListKeys) {
      for (const suffix of ["", "/export.csv"]) {
        const response = await request(cookie, `/api/lists/${encodeURIComponent(listKey)}${suffix}?pageSize=10`);
        const label = `${role} unknown ${listKey}${suffix || "/query"}`;
        expectStatus(label, response, 404);
        assertNoSalesFallback(label, response);
      }
    }
  }
}

async function verifyHiddenEntryApis(adminCookie) {
  for (const listKey of hiddenEntryIds) {
    for (const suffix of ["", "/export.csv"]) {
      const response = await request(adminCookie, `/api/lists/${encodeURIComponent(listKey)}${suffix}?pageSize=10`);
      const label = `ADMIN hidden entry ${listKey}${suffix || "/query"}`;
      expectStatus(label, response, 404);
      assertNoSalesFallback(label, response);
    }
  }
}

async function verifyPermissionsAndHeaders({ adminCookie, warehouseCookie, financeCookie }) {
  for (const reportKey of reportKeys) {
    for (const suffix of ["", "/export.csv"]) {
      expectStatus(`ADMIN ${reportKey}${suffix || "/query"}`, await request(adminCookie, `/api/lists/${reportKey}${suffix}?pageSize=10`), 200);
      expectStatus(`WAREHOUSE ${reportKey}${suffix || "/query"}`, await request(warehouseCookie, `/api/lists/${reportKey}${suffix}?pageSize=10`), 403);
    }
  }

  for (const contract of stockContracts) {
    const queryPath = `/api/lists/${contract.listKey}?keyword=${encodeURIComponent(contract.billNo)}&pageSize=10`;
    const exportPath = `/api/lists/${contract.listKey}/export.csv?keyword=${encodeURIComponent(contract.billNo)}&pageSize=10`;
    const adminQuery = await request(adminCookie, queryPath);
    const adminExport = await request(adminCookie, exportPath);
    const warehouseQuery = await request(warehouseCookie, queryPath);
    const warehouseExport = await request(warehouseCookie, exportPath);
    const financeQuery = await request(financeCookie, queryPath);
    const financeExport = await request(financeCookie, exportPath);
    expectStatus(`ADMIN ${contract.listKey} query`, adminQuery, 200);
    expectStatus(`ADMIN ${contract.listKey} export`, adminExport, 200);
    expectStatus(`WAREHOUSE ${contract.listKey} query`, warehouseQuery, 200);
    expectStatus(`WAREHOUSE ${contract.listKey} export`, warehouseExport, 200);
    expectStatus(`FINANCE ${contract.listKey} query`, financeQuery, 403);
    expectStatus(`FINANCE ${contract.listKey} export`, financeExport, 403);
    assert(adminQuery.data?.total === 1 && adminQuery.data?.rows?.length === 1, `${contract.listKey} 必须精确命中唯一 A139 夹具`, adminQuery.data);
    const actualFields = Object.keys(adminQuery.data.rows[0]).sort();
    const expectedFields = [...contract.expectedFields].sort();
    assert(JSON.stringify(actualFields) === JSON.stringify(expectedFields), `${contract.listKey} header 必须只返回固定字段`, { actualFields, expectedFields });
    assert(adminExport.text.includes(contract.billNo), `${contract.listKey} 引出必须包含夹具单号`);
    assert(!/客户|销售单号|含税金额|priceTaxTotal/.test(adminExport.text), `${contract.listKey} 引出不得包含销售列`, { header: adminExport.text.split(/\r?\n/)[0] });
    if (contract.listKey !== "stock-count-form-list") {
      assert(adminQuery.data.rows[0].sourceBillNo === countBillNo, `${contract.listKey} 必须返回真实源盘点单`, adminQuery.data.rows[0]);
    }
  }
}

async function closeTab(page, tabId) {
  const closeButton = page.getByTestId(`close-${tabId}`);
  if (await closeButton.isVisible({ timeout: 1000 }).catch(() => false)) {
    await closeButton.click();
    await page.waitForTimeout(300);
  }
}

async function openReportAndAssertKey(page, moduleName, reportKey, controlTestId) {
  await page.getByTestId(`module-${moduleName}`).hover();
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET" && url.pathname === `/api/lists/${reportKey}`;
  }, { timeout: 10000 });
  await page.getByTestId(controlTestId).click();
  const response = await responsePromise;
  assert(response.status() === 200, `${controlTestId} 必须查询原 report key`, { status: response.status(), url: response.url() });
  await page.getByTestId(`tab-${reportKey}`).waitFor({ state: "visible", timeout: 10000 });
  assert(!response.url().includes(`${reportKey}-list`), `${controlTestId} 不得拼接 -list`, { url: response.url() });
  await closeTab(page, reportKey);
}

async function verifyAdminBrowser() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1800, height: 920 } });
  try {
    await page.goto(frontendUrl, { waitUntil: "networkidle" });
    await loginAsAdmin(page);
    for (const entryId of hiddenEntryIds) {
      assert(await page.getByTestId(`entry-${entryId}`).count() === 0, `DOM 不得出现未交付入口 ${entryId}`);
      assert(await page.getByTestId(`query-${entryId}`).count() === 0, `DOM 不得出现未交付快捷查询 ${entryId}`);
    }
    for (const label of hiddenEntryLabels) {
      assert(await page.getByText(label, { exact: true }).count() === 0, `首页与 catalog 不得出现未交付文案 ${label}`);
    }
    const catalogShot = path.join(screenshotDir, `a139-admin-catalog-${batch}.png`);
    await page.screenshot({ path: catalogShot, fullPage: true });
    evidence.screenshots.push(path.relative(rootDir, catalogShot));

    await openReportAndAssertKey(page, "采购管理", "purchase-summary-report", "entry-purchase-summary-report");
    await openReportAndAssertKey(page, "采购管理", "purchase-summary-report", "query-purchase-summary-report");
    await openReportAndAssertKey(page, "生产管理", "task-track-report", "entry-task-track-report");
    await openReportAndAssertKey(page, "生产管理", "task-track-report", "query-task-track-report");

    for (const contract of stockContracts) {
      await page.getByTestId("module-库存管理").hover();
      await page.getByTestId(`query-${contract.entryId}`).click();
      await page.getByTestId(`tab-${contract.listKey}`).waitFor({ state: "visible", timeout: 10000 });
      await page.getByTestId("list-keyword").fill(contract.billNo);
      await page.getByTestId("list-keyword").press("Enter");
      await page.getByText(contract.billNo, { exact: true }).first().waitFor({ state: "visible", timeout: 10000 });
      const headerText = await page.locator(".data-list-native-table thead").innerText();
      const bodyText = await page.locator(".data-list-native-table tbody").innerText();
      for (const label of contract.visibleLabels) {
        assert(headerText.includes(label), `${contract.listKey} 浏览器表头必须显示 ${label}`, { headerText });
      }
      assert(!/客户|销售单号|含税金额/.test(headerText), `${contract.listKey} 浏览器表头不得显示销售列`, { headerText });
      assert(bodyText.includes(contract.billNo) && bodyText.includes("CP-001"), `${contract.listKey} 浏览器必须显示夹具单号和物料`, { bodyText });
      if (contract.listKey !== "stock-count-form-list") {
        assert(bodyText.includes(countBillNo), `${contract.listKey} 浏览器必须显示源盘点单`, { bodyText });
      }
      const screenshotPath = path.join(screenshotDir, `a139-${contract.listKey}-${batch}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      evidence.screenshots.push(path.relative(rootDir, screenshotPath));
      await closeTab(page, contract.listKey);
    }
  } finally {
    await browser.close();
  }
}

async function verifyWarehouseBrowser() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 850 } });
  try {
    await page.goto(frontendUrl, { waitUntil: "networkidle" });
    await loginAs(page, "warehouse", "warehouse123", "仓库员", "BLD-TEST");
    await page.getByTestId("module-采购管理").hover();
    assert(await page.getByTestId("entry-purchase-summary-report").count() === 0, "WAREHOUSE catalog 不得显示采购汇总表");
    await page.getByTestId("module-生产管理").hover();
    assert(await page.getByTestId("entry-task-track-report").count() === 0, "WAREHOUSE catalog 不得显示任务跟踪表");
    const screenshotPath = path.join(screenshotDir, `a139-warehouse-menu-${batch}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    evidence.screenshots.push(path.relative(rootDir, screenshotPath));
  } finally {
    await browser.close();
  }
}

let primaryError = null;
try {
  const adminCookie = await loginApi(apiBase, "admin", "admin123", "BLD-TEST");
  const warehouseCookie = await loginApi(apiBase, "warehouse", "warehouse123", "BLD-TEST");
  const financeCookie = await loginApi(apiBase, "finance", "finance123", "BLD-TEST");
  const [adminSession, warehouseSession, financeSession] = await Promise.all([
    request(adminCookie, "/api/system/session"),
    request(warehouseCookie, "/api/system/session"),
    request(financeCookie, "/api/system/session")
  ]);
  expectStatus("ADMIN session", adminSession, 200);
  expectStatus("WAREHOUSE session", warehouseSession, 200);
  expectStatus("FINANCE session", financeSession, 200);
  assert(
    adminSession.data?.tenant?.code === "BLD-TEST" && adminSession.data?.tenant?.schemaName === "public",
    "A139 直连 SQL 夹具只允许写入 BLD-TEST 的 public schema",
    adminSession.data?.tenant
  );
  const warehousePermissions = new Set(warehouseSession.data?.user?.permissionCodes ?? []);
  const financePermissions = new Set(financeSession.data?.user?.permissionCodes ?? []);
  for (const contract of stockContracts) {
    assert(warehousePermissions.has(contract.permission), `WAREHOUSE 验收前置必须包含 ${contract.permission}`);
    assert(!financePermissions.has(contract.permission), `FINANCE 验收前置不得包含 ${contract.permission}`);
  }
  createStockFixtures();
  await verifyUnknownKeys({ ADMIN: adminCookie, WAREHOUSE: warehouseCookie });
  await verifyHiddenEntryApis(adminCookie);
  await verifyPermissionsAndHeaders({ adminCookie, warehouseCookie, financeCookie });
  await verifyAdminBrowser();
  await verifyWarehouseBrowser();
  evidence.ok = true;
} catch (error) {
  primaryError = error;
  evidence.error = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  try {
    cleanupStockFixtures();
  } catch (cleanupError) {
    evidence.cleanup.error = cleanupError instanceof Error ? cleanupError.stack ?? cleanupError.message : String(cleanupError);
    if (!primaryError) primaryError = cleanupError;
  }
  if (evidence.cleanup.remainingRows !== 0) {
    const cleanupFailure = new Error(`A139 cleanup 必须零残留，当前为 ${evidence.cleanup.remainingRows}`);
    evidence.cleanup.error = cleanupFailure.message;
    if (!primaryError) primaryError = cleanupFailure;
  }
  if (primaryError) evidence.ok = false;
  await writeFile(resultPath, JSON.stringify(evidence, null, 2));
}

if (primaryError) throw primaryError;
console.log(JSON.stringify({ resultPath, assertions: evidence.assertions.length, requests: evidence.requests.length, screenshots: evidence.screenshots }, null, 2));
