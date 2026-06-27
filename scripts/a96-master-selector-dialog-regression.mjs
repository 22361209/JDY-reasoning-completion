import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { clickNewDocument } from "./helpers/document-actions.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a96-master-selector-dialog-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
await installApiSession(apiBase);
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);

const product = {
  code: `A96-P-${batch}`,
  name: `A96整列表选择商品${batch}`,
  spec: "弹窗回填",
  category: "成品总成",
  unit: "只",
  status: "启用"
};

await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

async function api(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "GET",
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
    throw new Error(`${options.method ?? "GET"} ${pathname} failed ${result.status}: ${JSON.stringify(result.data)}`);
  }
  return result.data;
}

async function upsertProduct() {
  const created = await api("/api/master-data/product", { method: "POST", body: product });
  if (created.ok) {
    return created.data;
  }
  if (created.status === 409) {
    return requireApi(`/api/master-data/product/${encodeURIComponent(product.code)}`, { method: "PUT", body: product });
  }
  throw new Error(`create product ${product.code} failed ${created.status}: ${JSON.stringify(created.data)}`);
}

async function chooseFromDialog(page, openTestId, keyword, rowCode) {
  await page.getByTestId(openTestId).click();
  await page.getByTestId("master-selector-dialog").waitFor({ state: "visible" });
  await page.getByTestId("master-selector-total").waitFor({ state: "visible" });
  await page.getByTestId("master-selector-search").fill(keyword);
  await page.getByTestId("master-selector-search-button").click();
  const row = page.getByTestId(`master-selector-row-${rowCode}`);
  await row.waitFor({ state: "visible" });
  await row.click();
  await page.getByTestId("master-selector-dialog").waitFor({ state: "hidden" });
}

function assertEqual(name, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${name} expected ${expected}, got ${actual}`);
  }
}

await upsertProduct();

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);

  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("entry-sales-order-form").click();
  await page.getByTestId("sales-line-product").waitFor({ state: "visible" });
  await clickNewDocument(page);
  await page.waitForFunction(() => {
    const input = document.querySelector('[data-testid="sales-bill-no"]');
    return input instanceof HTMLInputElement && input.value.length > 0;
  });

  await chooseFromDialog(page, "sales-party-open-selector", "KH-001", "KH-001");
  assertEqual("sales customer code", await page.getByTestId("sales-party-code").inputValue(), "KH-001");
  const salesCustomerName = await page.getByTestId("sales-party-name").inputValue();
  if (!salesCustomerName) {
    throw new Error("sales customer dialog should backfill customer name");
  }

  await chooseFromDialog(page, "sales-line-product-open-selector", product.code, product.code);
  assertEqual("sales product code", await page.getByTestId("sales-line-product").inputValue(), product.code);

  await chooseFromDialog(page, "sales-line-warehouse-open-selector", "CK-002", "CK-002");
  assertEqual("sales warehouse code", await page.getByTestId("sales-line-warehouse").inputValue(), "CK-002");

  const salesScreenshot = `a96-master-selector-sales-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, salesScreenshot), fullPage: true });

  await page.getByTestId("module-采购管理").hover();
  await page.getByTestId("entry-purchase-order-form").click();
  await page.getByTestId("purchase-party-code").waitFor({ state: "visible" });
  await clickNewDocument(page);
  await page.waitForFunction(() => {
    const input = document.querySelector('[data-testid="purchase-bill-no"]');
    return input instanceof HTMLInputElement && input.value.length > 0;
  });

  await chooseFromDialog(page, "purchase-party-open-selector", "GYS-001", "GYS-001");
  assertEqual("purchase supplier code", await page.getByTestId("purchase-party-code").inputValue(), "GYS-001");
  const supplierName = await page.getByTestId("purchase-party-name").inputValue();
  if (!supplierName) {
    throw new Error("purchase supplier dialog should backfill supplier name");
  }

  const purchaseScreenshot = `a96-master-selector-purchase-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, purchaseScreenshot), fullPage: true });

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    product,
    checks: {
      salesCustomerCode: "KH-001",
      salesProductCode: product.code,
      salesWarehouseCode: "CK-002",
      purchaseSupplierCode: "GYS-001",
      customerNameBackfilled: Boolean(salesCustomerName),
      supplierNameBackfilled: Boolean(supplierName)
    },
    screenshots: [
      `verification/playwright/${salesScreenshot}`,
      `verification/playwright/${purchaseScreenshot}`
    ]
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
