import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a26-selector-next-field-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);

const product = {
  code: `A26-P-${batch}`,
  name: `A26键盘跳格商品${batch}`,
  spec: "自动跳格",
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

async function activeTestId(page) {
  return page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? "");
}

async function chooseByKeyboard(page, inputTestId, keyword, key = "Enter") {
  const input = page.getByTestId(inputTestId);
  await input.focus();
  await input.fill(keyword);
  await page.locator(".master-selector__menu button", { hasText: keyword }).first().waitFor({ state: "visible" });
  await page.keyboard.press(key);
}

function assertEqual(name, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${name} expected ${expected}, got ${actual}`);
  }
}

function assertDeepEqual(name, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${name} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

await upsertProduct();

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("entry-sales-order-form").click();
  await page.getByTestId("sales-line-product").waitFor({ state: "visible" });
  await page.getByTestId("new-document").click();
  const billNo = await page.getByTestId("sales-bill-no").inputValue();

  await chooseByKeyboard(page, "sales-party-code", "KH-001", "Enter");
  const focusAfterParty = await activeTestId(page);
  assertEqual("focus after party selector", focusAfterParty, "sales-bill-date");

  await chooseByKeyboard(page, "sales-line-product", product.code, "Enter");
  const focusAfterProduct = await activeTestId(page);
  assertEqual("focus after product selector", focusAfterProduct, "sales-line-warehouse");
  assertEqual("product code after selector", await page.getByTestId("sales-line-product").inputValue(), product.code);

  await chooseByKeyboard(page, "sales-line-warehouse", "CK-002", "Tab");
  const focusAfterWarehouse = await activeTestId(page);
  assertEqual("focus after warehouse selector", focusAfterWarehouse, "sales-line-qty");
  assertEqual("warehouse code after selector", await page.getByTestId("sales-line-warehouse").inputValue(), "CK-002");

  await page.getByTestId("sales-line-qty").fill("7");
  await page.getByTestId("sales-line-price").fill("19");
  const amount = (await page.getByTestId("sales-line-amount").innerText()).trim();
  assertEqual("amount", amount, "133.00");

  const screenshot = `a26-selector-next-field-form-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });

  await page.getByTestId("save-sales-order").click();
  await page.getByText("草稿已保存").waitFor({ state: "visible" });
  const detail = await requireApi(`/api/sales-orders/${encodeURIComponent(billNo)}`);
  const savedLines = detail.lines.map((line) => ({
    productCode: String(line.productCode ?? ""),
    warehouseCode: String(line.warehouseCode ?? ""),
    qty: Number(line.qty ?? 0),
    unitPrice: Number(line.unitPrice ?? 0)
  }));
  assertDeepEqual("saved line", savedLines, [
    { productCode: product.code, warehouseCode: "CK-002", qty: 7, unitPrice: 19 }
  ]);

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    billNo,
    product,
    focusAfterParty,
    focusAfterProduct,
    focusAfterWarehouse,
    amount,
    savedLines,
    screenshots: [`verification/playwright/${screenshot}`]
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
