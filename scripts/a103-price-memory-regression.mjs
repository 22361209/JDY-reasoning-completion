import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { clickNewDocument } from "./helpers/document-actions.mjs";
import { addEntryLineBelow } from "./helpers/entry-table-actions.mjs";
import { salesOutPayloadViaDeliveryNotice } from "./helpers/sales-delivery-notice-flow.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a103-price-memory-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-26";

await installApiSession(apiBase);
await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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

async function post(pathname, body) {
  return api(pathname, { method: "POST", body });
}

async function upsertProduct(payload) {
  const create = await fetch(`${apiBase}/api/master-data/product`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (create.status === 409) {
    return api(`/api/master-data/product/${encodeURIComponent(payload.code)}`, { method: "PUT", body: payload });
  }
  const text = await create.text();
  if (!create.ok) {
    throw new Error(`create product ${payload.code} failed ${create.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

async function upsertCustomer(payload) {
  const create = await fetch(`${apiBase}/api/master-data/customer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (create.status === 409) {
    return api(`/api/master-data/customer/${encodeURIComponent(payload.code)}`, { method: "PUT", body: payload });
  }
  const text = await create.text();
  if (!create.ok) {
    throw new Error(`create customer ${payload.code} failed ${create.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

async function selectMasterRow(page, openerTestId, rowCode) {
  await page.getByTestId(openerTestId).click();
  await page.getByTestId("master-selector-dialog").waitFor({ state: "visible" });
  await page.getByTestId("master-selector-search").fill(rowCode);
  await page.getByTestId("master-selector-search-button").click();
  await page.getByTestId(`master-selector-row-${rowCode}`).click();
}

async function assertPriceInput(page, testId, expected, label) {
  await page.waitForFunction(
    ({ testId: id, expectedValue }) => document.querySelector(`[data-testid="${id}"]`)?.value === expectedValue,
    { testId, expectedValue: String(expected) },
    { timeout: 10000 }
  );
  const actual = await page.getByTestId(testId).inputValue();
  assert(Number(actual) === expected, `${label} expected ${expected}, got ${actual}`);
}

const customerCode = `KH-A103-${batch}`;
const historyProductCode = `CP-A103-H-${batch}`;
const defaultProductCode = `CP-A103-D-${batch}`;
const zeroProductCode = `CP-A103-Z-${batch}`;
const olderOrderNo = `XSDD-A103-OLD-${batch}`;
const newerOutNo = `XSCK-A103-NEW-${batch}`;
const expectedHistoryPrice = 222;
const expectedDefaultPrice = 333;

await upsertCustomer({
  code: customerCode,
  name: `A103价格客户${batch}`,
  contact: "A103",
  phone: "13810300000",
  region: "广东广州",
  status: "启用"
});
await upsertProduct({
  code: historyProductCode,
  name: `A103历史价商品${batch}`,
  spec: "历史成交价",
  category: "成品总成",
  unit: "只",
  defaultSalePrice: "88",
  status: "启用"
});
await upsertProduct({
  code: defaultProductCode,
  name: `A103默认价商品${batch}`,
  spec: "默认销售价",
  category: "成品总成",
  unit: "只",
  defaultSalePrice: String(expectedDefaultPrice),
  status: "启用"
});
await upsertProduct({
  code: zeroProductCode,
  name: `A103零价商品${batch}`,
  spec: "无默认价",
  category: "成品总成",
  unit: "只",
  status: "启用"
});
await post("/api/inventory/adjustments", {
  productCode: historyProductCode,
  warehouseCode: "CK-001",
  qtyDelta: 20,
  txnType: "A103_PRICE_MEMORY_STOCK",
  sourceBillType: `A103:${batch}`
});

await post("/api/sales-orders/draft", {
  billNo: olderOrderNo,
  customerCode,
  billDate: "2026-06-20",
  department: "销售部",
  ownerName: "本地管理员",
  isTaxInclusive: false,
  lines: [{ productCode: historyProductCode, warehouseCode: "CK-001", qty: 1, unitPrice: 111, taxRate: 13 }]
});
await post(`/api/sales-orders/${encodeURIComponent(olderOrderNo)}/audit`);
const newerOutPayload = {
  billNo: newerOutNo,
  customerCode,
  billDate: "2026-06-25",
  department: "销售部",
  ownerName: "本地管理员",
  isTaxInclusive: false,
  lines: [{ productCode: historyProductCode, warehouseCode: "CK-001", qty: 1, unitPrice: expectedHistoryPrice, taxRate: 13 }]
};
const newerOutFlow = salesOutPayloadViaDeliveryNotice(newerOutPayload, `FHTZ-A103-NEW-${batch}`);
await post("/api/delivery-notices/draft", newerOutFlow.noticePayload);
await post(`/api/delivery-notices/${encodeURIComponent(newerOutFlow.noticeNo)}/audit`);
await post("/api/sales-outs/draft", newerOutFlow.outPayload);
await post(`/api/sales-outs/${encodeURIComponent(newerOutNo)}/audit`);

const historyQuote = await api(`/api/sales-prices/unit-price?${new URLSearchParams({ customerCode, productCode: historyProductCode })}`, { method: "GET" });
const defaultQuote = await api(`/api/sales-prices/unit-price?${new URLSearchParams({ customerCode, productCode: defaultProductCode })}`, { method: "GET" });
const zeroQuote = await api(`/api/sales-prices/unit-price?${new URLSearchParams({ customerCode, productCode: zeroProductCode })}`, { method: "GET" });
assert(Number(historyQuote.unitPrice) === expectedHistoryPrice && historyQuote.source === "salesOut", `history quote mismatch: ${JSON.stringify(historyQuote)}`);
assert(Number(defaultQuote.unitPrice) === expectedDefaultPrice && defaultQuote.source === "productDefault", `default quote mismatch: ${JSON.stringify(defaultQuote)}`);
assert(Number(zeroQuote.unitPrice) === 0 && zeroQuote.source === "zero", `zero quote mismatch: ${JSON.stringify(zeroQuote)}`);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const screenshots = [];
try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("entry-sales-order-form").click();
  await page.getByTestId("sales-line-product").waitFor({ state: "visible" });
  await clickNewDocument(page);
  await selectMasterRow(page, "sales-party-open-selector", customerCode);
  await selectMasterRow(page, "sales-line-product-open-selector", historyProductCode);
  await assertPriceInput(page, "sales-line-price", expectedHistoryPrice, "history price");

  await addEntryLineBelow(page);
  await selectMasterRow(page, "sales-line-product-2-open-selector", defaultProductCode);
  await assertPriceInput(page, "sales-line-price-2", expectedDefaultPrice, "default price");

  await addEntryLineBelow(page);
  await selectMasterRow(page, "sales-line-product-3-open-selector", zeroProductCode);
  await assertPriceInput(page, "sales-line-price-3", 0, "zero fallback price");

  const screenshot = `a103-price-memory-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });
  screenshots.push(`verification/playwright/${screenshot}`);
} finally {
  await browser.close();
}

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  ok: true,
  customerCode,
  historyProductCode,
  defaultProductCode,
  zeroProductCode,
  historyQuote,
  defaultQuote,
  zeroQuote,
  assertions: [
    "选客户后/选商品后按最近已审核销售出库成交 unitPrice 回填",
    "无成交记录时按商品默认销售价回填",
    "成交和默认价都没有时回填 0"
  ],
  screenshots
};
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
