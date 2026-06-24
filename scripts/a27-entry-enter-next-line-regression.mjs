import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a27-entry-enter-next-line-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
await installApiSession(apiBase);
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);

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

async function activeTestId(page) {
  return page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? "");
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

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("entry-sales-order-form").click();
  await page.getByTestId("sales-line-product").waitFor({ state: "visible" });
  await page.getByTestId("new-document").click();
  const billNo = await page.getByTestId("sales-bill-no").inputValue();

  await page.getByTestId("sales-line-product").fill(`A27-MARK-${batch}`);
  await page.getByTestId("sales-line-product").fill("CP-001");
  await page.getByTestId("sales-line-warehouse").fill("CK-001");
  await page.getByTestId("sales-line-qty").fill("3");
  await page.keyboard.press("Enter");
  const focusAfterQtyEnter = await activeTestId(page);
  assertEqual("focus after qty Enter", focusAfterQtyEnter, "sales-line-price");

  await page.getByTestId("sales-line-price").fill("21");
  await page.keyboard.press("Enter");
  await page.getByTestId("sales-line-product-2").waitFor({ state: "visible" });
  const focusAfterPriceEnter = await activeTestId(page);
  assertEqual("focus after price Enter", focusAfterPriceEnter, "sales-line-product-2");
  assertEqual("row count after price Enter", await page.getByTestId("sales-entry-row").count(), 2);

  await page.getByTestId("sales-line-product-2").fill("PJ-014");
  await page.getByTestId("sales-line-warehouse-2").fill("CK-002");
  await page.getByTestId("sales-line-qty-2").fill("2");
  await page.getByTestId("sales-line-price-2").fill("5");
  await page.keyboard.press("Escape");

  const line1Amount = (await page.getByTestId("sales-line-amount").innerText()).trim();
  const line2Amount = (await page.getByTestId("sales-line-amount-2").innerText()).trim();
  const total = (await page.getByTestId("document-total-amount").innerText()).trim();
  assertEqual("line 1 amount", line1Amount, "63.00");
  assertEqual("line 2 amount", line2Amount, "10.00");
  assertEqual("total", total, "73.00");

  const screenshot = `a27-entry-enter-next-line-form-${batch}.png`;
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
  assertDeepEqual("saved lines", savedLines, [
    { productCode: "CP-001", warehouseCode: "CK-001", qty: 3, unitPrice: 21 },
    { productCode: "PJ-014", warehouseCode: "CK-002", qty: 2, unitPrice: 5 }
  ]);

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    billNo,
    focusAfterQtyEnter,
    focusAfterPriceEnter,
    line1Amount,
    line2Amount,
    total,
    savedLines,
    screenshots: [`verification/playwright/${screenshot}`]
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
