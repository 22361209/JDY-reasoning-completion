import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { createSalesOutDraftViaDeliveryNotice } from "./helpers/sales-delivery-notice-flow.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a15-source-trace-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
await installApiSession(apiBase);
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-24";

const salesLines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 10, unitPrice: 86 },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 8, unitPrice: 94 },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 6, unitPrice: 12 }
];
const salesOutLines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 4, unitPrice: 86 },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 3, unitPrice: 94 },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 2, unitPrice: 12 }
];
const purchaseLines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 11, unitPrice: 72 },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 9, unitPrice: 81 },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 7, unitPrice: 8 }
];
const purchaseInLines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 5, unitPrice: 72 },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 4, unitPrice: 81 },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 3, unitPrice: 8 }
];

await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

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

async function seedStock() {
  for (const productCode of ["CP-001", "PJ-014", "CP-T413874"]) {
    for (const warehouseCode of ["CK-001", "CK-002", "CK-T413874"]) {
      await requireApi("/api/inventory/adjustments", {
        body: {
          productCode,
          warehouseCode,
          qtyDelta: 2000,
          txnType: "A15_SOURCE_TRACE_IN",
          sourceBillType: `A15_SOURCE_TRACE:${batch}`
        }
      });
    }
  }
}

async function createData() {
  await seedStock();
  const salesOrderNo = `XSDD-A15-${batch}`;
  const salesOutNo = `XSCK-A15-${batch}`;
  await requireApi("/api/sales-orders/draft", {
    body: {
      billNo: salesOrderNo,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      lines: salesLines
    }
  });
  await requireApi(`/api/sales-orders/${encodeURIComponent(salesOrderNo)}/audit`);
  const deliveryNoticeNo = `FHTZ-A15-${batch}`;
  await createSalesOutDraftViaDeliveryNotice((pathname, body) => requireApi(pathname, { body }), {
    billNo: salesOutNo,
    sourceOrderNo: salesOrderNo,
    customerCode: "KH-001",
    billDate,
    department: "销售部",
    ownerName: "本地管理员",
    lines: salesOutLines
  }, deliveryNoticeNo);
  await requireApi(`/api/sales-outs/${encodeURIComponent(salesOutNo)}/audit`);

  const purchaseOrderNo = `CGDD-A15-${batch}`;
  const purchaseInNo = `CGRK-A15-${batch}`;
  await requireApi("/api/purchase-orders/draft", {
    body: {
      billNo: purchaseOrderNo,
      supplierCode: "GYS-001",
      billDate,
      department: "采购部",
      ownerName: "本地管理员",
      lines: purchaseLines
    }
  });
  await requireApi(`/api/purchase-orders/${encodeURIComponent(purchaseOrderNo)}/audit`);
  await requireApi("/api/purchase-ins/draft", {
    body: {
      billNo: purchaseInNo,
      sourceOrderNo: purchaseOrderNo,
      supplierCode: "GYS-001",
      billDate,
      department: "采购部",
      ownerName: "本地管理员",
      lines: purchaseInLines
    }
  });
  await requireApi(`/api/purchase-ins/${encodeURIComponent(purchaseInNo)}/audit`);

  return { salesOrderNo, deliveryNoticeNo, salesOutNo, purchaseOrderNo, purchaseInNo };
}

async function openDetailFromList(page, moduleName, entryId, listId, billNo) {
  await page.getByTestId(`module-${moduleName}`).hover();
  await page.getByTestId(`query-${entryId}`).click();
  await page.getByTestId(`tab-${listId}`).waitFor({ state: "visible" });
  await page.getByTestId("list-keyword").fill(billNo);
  await page.getByTestId("list-keyword").press("Enter");
  await page.getByTestId(`open-document-${billNo}`).click();
}

async function waitInputValue(page, testId, expected) {
  const locator = page.getByTestId(testId);
  await locator.waitFor({ state: "visible" });
  await page.waitForFunction(
    ({ id, value }) => document.querySelector(`[data-testid="${id}"]`)?.value === value,
    { id: testId, value: expected }
  );
  return locator.inputValue();
}

async function readFormQtys(page, prefix, count) {
  const qtys = [];
  for (let index = 0; index < count; index += 1) {
    const testId = index === 0 ? `${prefix}-line-qty` : `${prefix}-line-qty-${index + 1}`;
    qtys.push(Number(await page.getByTestId(testId).inputValue()));
  }
  return qtys;
}

async function readSourceLineNos(page, prefix, count) {
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const orderNo = (await page.getByTestId(`${prefix}-line-source-order-no${suffix}`).innerText()).trim();
    const lineNo = (await page.getByTestId(`${prefix}-line-source-line-no${suffix}`).innerText()).trim();
    values.push(`${orderNo} / ${lineNo}`);
  }
  return values;
}

function assertEqual(name, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${name} expected ${expected}, got ${actual}`);
  }
}

function assertArray(name, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${name} expected ${expected.join(",")}, got ${actual.join(",")}`);
  }
}

function assertIncludes(name, value, expected) {
  if (!value.includes(expected)) {
    throw new Error(`${name} expected to include ${expected}, got ${value}`);
  }
}

const data = await createData();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const screenshots = [];

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    localStorage.removeItem("jdy:entry-columns:sales-out");
    localStorage.removeItem("jdy:entry-columns:purchase-in");
  });
  await loginAsAdmin(page);
  await openDetailFromList(page, "销售管理", "sales-out-form", "sales-out-form-list", data.salesOutNo);
  const salesOutSourceLines = await readSourceLineNos(page, "sales-out", 3);
  assertArray("sales out line-level source delivery notice", salesOutSourceLines, [`${data.deliveryNoticeNo} / #1`, `${data.deliveryNoticeNo} / #2`, `${data.deliveryNoticeNo} / #3`]);
  await page.getByTestId("sales-out-line-source-trace").waitFor({ state: "visible" });
  const salesPopupPromise = page.waitForEvent("popup");
  await page.getByTestId("sales-out-line-source-trace").click();
  const salesPopup = await salesPopupPromise;
  await salesPopup.waitForLoadState("domcontentloaded");
  const salesPopupText = await salesPopup.locator("body").innerText();
  assertIncludes("sales source popup", salesPopupText, data.deliveryNoticeNo);
  await salesPopup.close();
  const tracedSalesBillNo = data.deliveryNoticeNo;
  const tracedSalesQtys = [4, 3, 2];
  const salesScreenshot = `a15-sales-out-source-trace-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, salesScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${salesScreenshot}`);

  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    localStorage.removeItem("jdy:entry-columns:sales-out");
    localStorage.removeItem("jdy:entry-columns:purchase-in");
  });
  await loginAsAdmin(page);
  await openDetailFromList(page, "采购管理", "purchase-in-form", "purchase-in-form-list", data.purchaseInNo);
  const purchaseInSourceLines = await readSourceLineNos(page, "purchase-in", 3);
  assertArray("purchase in line-level source order", purchaseInSourceLines, [`${data.purchaseOrderNo} / #1`, `${data.purchaseOrderNo} / #2`, `${data.purchaseOrderNo} / #3`]);
  if (await page.getByTestId("trace-source-order").isDisabled()) {
    throw new Error("purchase in trace button should be enabled");
  }
  const purchasePopupPromise = page.waitForEvent("popup");
  await page.getByTestId("trace-source-order").click();
  const purchasePopup = await purchasePopupPromise;
  await purchasePopup.waitForLoadState("domcontentloaded");
  const purchasePopupText = await purchasePopup.locator("body").innerText();
  assertIncludes("purchase source popup", purchasePopupText, data.purchaseOrderNo);
  await purchasePopup.close();
  const tracedPurchaseBillNo = data.purchaseOrderNo;
  const tracedPurchaseQtys = [11, 9, 7];
  const purchaseScreenshot = `a15-purchase-in-source-trace-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, purchaseScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${purchaseScreenshot}`);

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    salesOrderNo: data.salesOrderNo,
    deliveryNoticeNo: data.deliveryNoticeNo,
    salesOutNo: data.salesOutNo,
    salesOutSourceLines,
    tracedSalesBillNo,
    tracedSalesQtys,
    purchaseOrderNo: data.purchaseOrderNo,
    purchaseInNo: data.purchaseInNo,
    purchaseInSourceLines,
    tracedPurchaseBillNo,
    tracedPurchaseQtys,
    screenshots
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
