import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a64-production-red-source-ui-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const bomIssueMethod = `A64-${batch}`;

await mkdir(screenshotDir, { recursive: true });

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

async function browserFetch(page, pathname, options = {}) {
  return page.evaluate(async ({ pathname, options }) => {
    const response = await fetch(pathname, {
      method: options.method ?? "GET",
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    return { status: response.status, ok: response.ok, text: await response.text() };
  }, { pathname, options });
}

async function requireJson(page, pathname, options = {}) {
  const response = await browserFetch(page, pathname, options);
  assert(response.ok, `${options.method ?? "GET"} ${pathname} failed ${response.status}: ${response.text}`);
  return response.text ? JSON.parse(response.text) : {};
}

async function auditBomAllowNewVersion(page, code) {
  const preview = await requireJson(page, `/api/production/boms/${encodeURIComponent(code)}/audit-preview`);
  const body = preview.requiresConfirmation
    ? {
        confirmNewVersion: true,
        latestBomCode: preview.latestBomCode,
        latestVersionNo: preview.latestVersionNo
      }
    : undefined;
  return requireJson(page, `/api/production/boms/${encodeURIComponent(code)}/audit`, { method: "POST", body });
}

async function loginAsAdmin(page) {
  await page.getByTestId("login-page").waitFor({ state: "visible" });
  await page.getByTestId("login-username").fill("admin");
  await page.getByTestId("login-account-set").selectOption("BLD-TEST");
  await page.getByTestId("login-password").fill("admin123");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("session-user-role").filter({ hasText: "系统管理员" }).waitFor({ state: "visible" });
}

async function seedStock(page) {
  for (const productCode of ["CP-001", "PJ-014", "CP-T413874"]) {
    for (const warehouseCode of ["CK-001", "CK-002", "CK-003"]) {
      await requireJson(page, "/api/inventory/adjustments", {
        method: "POST",
        body: {
          productCode,
          warehouseCode,
          qtyDelta: 4000,
          txnType: "A64_PRODUCTION_RED_SOURCE_UI_SEED",
          sourceBillType: `A64_RED_SOURCE_UI:${batch}`
        }
      });
    }
  }
}

async function createProductionPairs(page) {
  await seedStock(page);
  const bomCode = `BOM-A64-${batch}`;

  await requireJson(page, "/api/production/boms", {
    method: "POST",
    body: {
      code: bomCode,
      productCode: "CP-001",
      qty: 1,
      lines: [
        { materialCode: "CP-001", qty: 1, issueWarehouseCode: "CK-002" },
        { materialCode: "PJ-014", qty: 2, issueWarehouseCode: "CK-001" },
        { materialCode: "CP-T413874", qty: 3, issueMethod: bomIssueMethod }
      ]
    }
  });
  await auditBomAllowNewVersion(page, bomCode);
  const issueTaskNo = generatedBillNo(await requireJson(page, "/api/production/tasks", {
    method: "POST",
    body: { bomCode, warehouseCode: "CK-001", qty: 3 }
  }), "生产任务领料红冲 UI 样本");
  const completeTaskNo = generatedBillNo(await requireJson(page, "/api/production/tasks", {
    method: "POST",
    body: { bomCode, warehouseCode: "CK-001", qty: 10 }
  }), "生产任务完工红冲 UI 样本");
  await requireJson(page, `/api/production/tasks/${encodeURIComponent(issueTaskNo)}/audit`, { method: "POST" });
  await requireJson(page, `/api/production/tasks/${encodeURIComponent(completeTaskNo)}/audit`, { method: "POST" });
  const issueNo = generatedBillNo(await requireJson(page, `/api/production/tasks/${encodeURIComponent(issueTaskNo)}/issue`, {
    method: "POST",
    body: { materialWarehouseCode: "CK-002" }
  }), "生产领料红冲 UI 来源");
  await requireJson(page, `/api/production/material-issues/${encodeURIComponent(issueNo)}/audit`, { method: "POST" });
  const redIssue = await requireJson(page, `/api/production/material-issues/${encodeURIComponent(issueNo)}/red-reverse`, {
    method: "POST",
    body: {}
  });
  const completeIssueNo = generatedBillNo(await requireJson(page, `/api/production/tasks/${encodeURIComponent(completeTaskNo)}/issue`, {
    method: "POST",
    body: { materialWarehouseCode: "CK-002" }
  }), "完工任务领料红冲 UI 样本");
  await requireJson(page, `/api/production/material-issues/${encodeURIComponent(completeIssueNo)}/audit`, { method: "POST" });
  const productInNo = generatedBillNo(await requireJson(page, `/api/production/tasks/${encodeURIComponent(completeTaskNo)}/complete`, {
    method: "POST",
    body: {
      lines: [
        { productCode: "CP-001", warehouseCode: "CK-001", qty: 1, unitPrice: 10 },
        { productCode: "PJ-014", warehouseCode: "CK-002", qty: 2, unitPrice: 5 },
        { productCode: "CP-T413874", warehouseCode: "CK-003", qty: 3, unitPrice: 20 }
      ]
    }
  }), "产品入库红冲 UI 来源");
  await requireJson(page, `/api/production/product-ins/${encodeURIComponent(productInNo)}/audit`, { method: "POST" });
  const redProductIn = await requireJson(page, `/api/production/product-ins/${encodeURIComponent(productInNo)}/red-reverse`, {
    method: "POST",
    body: {}
  });

  return [
    {
      name: "生产领料单",
      listQueryTestId: "query-material-issue-form",
      listPageTestId: "list-page-material-issue-form-list",
      billInputTestId: "material-issue-bill-no",
      redBillNo: redIssue.billNo,
      sourceBillNo: issueNo
    },
    {
      name: "产品入库单",
      listQueryTestId: "query-product-in-form",
      listPageTestId: "list-page-product-in-form-list",
      billInputTestId: "product-in-bill-no",
      redBillNo: redProductIn.billNo,
      sourceBillNo: productInNo
    }
  ];
}

async function openRedFromListAndTraceSource(page, document) {
  await page.getByTestId("module-生产管理").hover();
  await page.getByTestId(document.listQueryTestId).click();
  await page.getByTestId(document.listPageTestId).waitFor({ state: "visible" });
  await page.getByTestId("list-keyword").fill(document.redBillNo);
  await page.getByTestId("list-query").click();
  await page.getByTestId(`open-document-${document.redBillNo}`).waitFor({ state: "visible", timeout: 10000 });
  await page.getByTestId(`open-document-${document.redBillNo}`).click();
  await page.getByTestId(document.billInputTestId).waitFor({ state: "visible" });
  await page.waitForFunction(
    ({ testId, expected }) => document.querySelector(`[data-testid="${testId}"]`)?.value === expected,
    { testId: document.billInputTestId, expected: document.redBillNo }
  );
  await page.getByTestId("open-red-source-bill").filter({ hasText: document.sourceBillNo }).waitFor({ state: "visible" });
  const redScreenshot = `a64-${document.billInputTestId}-red-source-visible-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, redScreenshot), fullPage: true });
  await page.getByTestId("open-red-source-bill").click();
  await page.getByTestId(document.billInputTestId).waitFor({ state: "visible" });
  await page.waitForFunction(
    ({ testId, expected }) => document.querySelector(`[data-testid="${testId}"]`)?.value === expected,
    { testId: document.billInputTestId, expected: document.sourceBillNo }
  );
  await page.getByText(`已打开来源原单 ${document.sourceBillNo}`).waitFor({ state: "visible" });
  const sourceScreenshot = `a64-${document.billInputTestId}-source-opened-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, sourceScreenshot), fullPage: true });
  return {
    name: document.name,
    redBillNo: document.redBillNo,
    sourceBillNo: document.sourceBillNo,
    openedRedBill: true,
    sourceButtonVisible: true,
    openedSourceBill: true,
    screenshots: [
      `verification/playwright/${redScreenshot}`,
      `verification/playwright/${sourceScreenshot}`
    ]
  };
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  const documents = await createProductionPairs(page);
  const checks = [];
  for (const document of documents) {
    checks.push(await openRedFromListAndTraceSource(page, document));
  }
  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    checks
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
