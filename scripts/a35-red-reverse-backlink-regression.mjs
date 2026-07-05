import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { createSalesOutDraftViaDeliveryNotice } from "./helpers/sales-delivery-notice-flow.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a35-red-reverse-backlink-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
await installApiSession(apiBase);
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-24";
const lines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 3, unitPrice: 86 },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 2, unitPrice: 94 },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 4, unitPrice: 12 }
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
          qtyDelta: 1000,
          txnType: "A35_RED_REVERSE_LINK_IN",
          sourceBillType: `A35_RED_REVERSE_LINK:${batch}`
        }
      });
    }
  }
}

async function createSalesOutPair() {
  const orderNo = `XSDD-A35-${batch}`;
  const billNo = `XSCK-A35-${batch}`;
  await requireApi("/api/sales-orders/draft", {
    body: {
      billNo: orderNo,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
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
    ownerName: "本地管理员",
    lines
  }, `FHTZ-A35-${batch}`);
  await requireApi(`/api/sales-outs/${encodeURIComponent(billNo)}/audit`);
  const redDraft = await requireApi(`/api/sales-outs/${encodeURIComponent(billNo)}/red-reverse`, {
    body: { billDate, ownerName: "本地管理员" }
  });
  const redBillNo = redDraft.billNo;
  return { orderNo, billNo, redBillNo };
}

async function createPurchaseInPair() {
  const billNo = `CGRK-A35-${batch}`;
  await requireApi("/api/purchase-ins/draft", {
    body: {
      billNo,
      supplierCode: "GYS-001",
      billDate,
      department: "采购部",
      ownerName: "本地管理员",
      lines
    }
  });
  await requireApi(`/api/purchase-ins/${encodeURIComponent(billNo)}/audit`);
  const redDraft = await requireApi(`/api/purchase-ins/${encodeURIComponent(billNo)}/red-reverse`, {
    body: { billDate, ownerName: "本地管理员" }
  });
  const redBillNo = redDraft.billNo;
  return { billNo, redBillNo };
}

async function openDetailFromList(page, moduleName, entryId, listId, billNo) {
  await page.getByTestId(`module-${moduleName}`).hover();
  await page.getByTestId(`query-${entryId}`).click();
  await page.getByTestId(`tab-${listId}`).waitFor({ state: "visible" });
  await page.getByTestId("list-keyword").fill(billNo);
  await page.getByTestId("list-keyword").press("Enter");
  await page.getByTestId(`open-document-${billNo}`).click();
  await page.getByTestId("document-status").waitFor({ state: "visible" });
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

function assertEqual(name, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${name} expected ${expected}, got ${actual}`);
  }
}

await seedStock();
const sales = await createSalesOutPair();
const purchase = await createPurchaseInPair();
const salesOriginal = await requireApi(`/api/sales-outs/${encodeURIComponent(sales.billNo)}`, { method: "GET" });
const purchaseOriginal = await requireApi(`/api/purchase-ins/${encodeURIComponent(purchase.billNo)}`, { method: "GET" });
assertEqual("sales red reverse bill", salesOriginal.document.redReverseBillNo, sales.redBillNo);
assertEqual("purchase red reverse bill", purchaseOriginal.document.redReverseBillNo, purchase.redBillNo);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const screenshots = [];

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await openDetailFromList(page, "销售管理", "sales-out-form", "sales-out-form-list", sales.billNo);
  await page.getByTestId("open-red-reverse-bill").waitFor({ state: "visible" });
  const salesOriginalScreenshot = `a35-sales-original-red-link-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, salesOriginalScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${salesOriginalScreenshot}`);
	  await page.getByTestId("open-red-reverse-bill").click();
	  await waitInputValue(page, "sales-out-bill-no", sales.redBillNo);
	  await page.waitForFunction(() => document.querySelector('[data-testid="document-status"]')?.textContent?.trim() === "草稿");
  const salesScreenshot = `a35-sales-red-reverse-backlink-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, salesScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${salesScreenshot}`);

  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await openDetailFromList(page, "采购管理", "purchase-in-form", "purchase-in-form-list", purchase.billNo);
  await page.getByTestId("open-red-reverse-bill").waitFor({ state: "visible" });
  const purchaseOriginalScreenshot = `a35-purchase-original-red-link-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, purchaseOriginalScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${purchaseOriginalScreenshot}`);
	  await page.getByTestId("open-red-reverse-bill").click();
	  await waitInputValue(page, "purchase-in-bill-no", purchase.redBillNo);
	  await page.waitForFunction(() => document.querySelector('[data-testid="document-status"]')?.textContent?.trim() === "草稿");
  const purchaseScreenshot = `a35-purchase-red-reverse-backlink-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, purchaseScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${purchaseScreenshot}`);

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    salesOutNo: sales.billNo,
    salesRedReverseBillNo: sales.redBillNo,
    purchaseInNo: purchase.billNo,
    purchaseRedReverseBillNo: purchase.redBillNo,
    screenshots
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
