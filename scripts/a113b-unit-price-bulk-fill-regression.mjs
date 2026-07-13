import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { clickNewDocument } from "./helpers/document-actions.mjs";
import { addEntryLineBelow } from "./helpers/entry-table-actions.mjs";
import { upsertMasterDataFixture } from "./helpers/master-data-actions.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a113b-unit-price-bulk-fill-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);

await installApiSession(apiBase);
await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${options.method ?? "POST"} ${pathname} failed ${response.status}: ${text}`);
  }
  return data;
}

async function upsertProduct(payload) {
  return upsertMasterDataFixture({ apiBase, type: "product", payload, audit: true });
}

async function upsertCustomer(payload) {
  return upsertMasterDataFixture({ apiBase, type: "customer", payload, audit: true });
}

async function createAuditedOrder(label, customerCode, lines, billDate) {
  const saved = await api("/api/sales-orders/draft", {
    body: {
      billNo: null,
      customerCode,
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      lines
    }
  });
  const billNo = generatedSalesOrderNo(saved, `A113B ${label} sales order`);
  await api(`/api/sales-orders/${encodeURIComponent(billNo)}/audit`, { method: "POST" });
  return billNo;
}

async function expectInputValue(page, testId, expected) {
  await page.waitForFunction(
    ({ id, value }) => document.querySelector(`[data-testid="${id}"]`)?.value === value,
    { id: testId, value: String(expected) },
    { timeout: 10000 }
  );
  const actual = await page.getByTestId(testId).inputValue();
  assert(Number(actual) === Number(expected), `${testId} expected ${expected}, got ${actual}`);
}

const customerCode = `KH-A113B-${batch}`;
const productA = `CP-A113B-A-${batch}`;
const productB = `CP-A113B-B-${batch}`;
const expectedA = 155;
const expectedB = 265;

await upsertCustomer({
  code: customerCode,
  name: `A113B批填客户${batch}`,
  contact: "A113B",
  phone: "13811300000",
  region: "广东佛山",
  status: "启用"
});
await upsertProduct({
  code: productA,
  name: `A113B单价批填A${batch}`,
  spec: "历史最高价来源",
  category: "成品总成",
  unit: "只",
  defaultSalePrice: "101",
  status: "启用"
});
await upsertProduct({
  code: productB,
  name: `A113B单价批填B${batch}`,
  spec: "历史最高价来源",
  category: "成品总成",
  unit: "只",
  defaultSalePrice: "202",
  status: "启用"
});
await api("/api/inventory/adjustments", {
  body: {
    productCode: productA,
    warehouseCode: "CK-001",
    qtyDelta: 20,
    txnType: "A113B_STOCK",
    sourceBillType: `A113B:${batch}`
  }
});
await api("/api/inventory/adjustments", {
  body: {
    productCode: productB,
    warehouseCode: "CK-001",
    qtyDelta: 20,
    txnType: "A113B_STOCK",
    sourceBillType: `A113B:${batch}`
  }
});

const oldOrderNo = await createAuditedOrder("OLD", customerCode, [
  { productCode: productA, warehouseCode: "CK-001", qty: 1, unitPrice: 120, taxRate: 13 },
  { productCode: productB, warehouseCode: "CK-001", qty: 1, unitPrice: 220, taxRate: 13 }
], "2026-06-20");
const maxOrderNo = await createAuditedOrder("MAX", customerCode, [
  { productCode: productA, warehouseCode: "CK-001", qty: 1, unitPrice: 150, taxRate: 13 },
  { productCode: productB, warehouseCode: "CK-001", qty: 1, unitPrice: 260, taxRate: 13 }
], "2026-06-21");

const sources = await api(`/api/sales-prices/unit-price-sources?${new URLSearchParams({ customerCode, productCodes: `${productA},${productB}` })}`, { method: "GET" });
assert(Number(sources.products[productA].defaultPrice.value) === 101, "product A default price source mismatch");
assert(Number(sources.products[productA].historyMaxPrice.value) === 150, "product A history max price source mismatch");
assert(Number(sources.products[productB].historyMaxPrice.value) === 260, "product B history max price source mismatch");
assert("costPrice" in sources.products[productA], "cost price source should be present even when unavailable");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 820 } });
const screenshots = [];
try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.removeItem("jdy:entry-columns:sales"));
  await loginAsAdmin(page);
  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("entry-sales-order-form").click();
  await page.getByTestId("sales-line-product").waitFor({ state: "visible" });
  await clickNewDocument(page);
  await page.getByTestId("sales-party-code").fill(customerCode);
  await page.getByTestId("sales-line-product").fill(productA);
  await page.getByTestId("sales-line-warehouse").fill("CK-001");
  await page.getByTestId("sales-line-qty").fill("1");
  await addEntryLineBelow(page);
  await page.getByTestId("sales-line-product-2").fill(productB);
  await page.getByTestId("sales-line-warehouse-2").fill("CK-001");
  await page.getByTestId("sales-line-qty-2").fill("1");

  await page.getByTestId("entry-column-bulk-unitPrice").click();
  await page.getByTestId("entry-column-bulk-dialog").waitFor({ state: "visible" });
  await page.getByTestId("entry-bulk-price-source").selectOption("historyMaxPrice");
  await page.getByTestId("entry-bulk-price-operator").selectOption("+");
  await page.getByTestId("entry-bulk-price-factor").fill("5");
  const popupScreenshot = `a113b-unit-price-bulk-popup-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, popupScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${popupScreenshot}`);
  await page.getByTestId("entry-bulk-price-ok").click();

  await expectInputValue(page, "sales-line-price", expectedA);
  await expectInputValue(page, "sales-line-price-2", expectedB);
  const appliedScreenshot = `a113b-unit-price-bulk-applied-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, appliedScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${appliedScreenshot}`);
} finally {
  await browser.close();
}

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  ok: true,
  customerCode,
  historyOrderNos: [oldOrderNo, maxOrderNo],
  productCodes: [productA, productB],
  sourceAssertions: {
    [productA]: {
      defaultPrice: Number(sources.products[productA].defaultPrice.value),
      historyMaxPrice: Number(sources.products[productA].historyMaxPrice.value)
    },
    [productB]: {
      historyMaxPrice: Number(sources.products[productB].historyMaxPrice.value)
    }
  },
  uiAssertions: {
    source: "historyMaxPrice",
    operator: "+",
    factor: 5,
    expectedPrices: [expectedA, expectedB]
  },
  screenshots
};
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
