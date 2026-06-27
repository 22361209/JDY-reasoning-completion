import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { clickNewDocument } from "./helpers/document-actions.mjs";
import { addEntryLineBelow } from "./helpers/entry-table-actions.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a29-entry-save-validation-regression.json");
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
  await clickNewDocument(page);
  await page.waitForFunction(() => {
    const input = document.querySelector('[data-testid="sales-bill-no"]');
    return input instanceof HTMLInputElement && input.value.length > 0;
  });
  const billNo = await page.getByTestId("sales-bill-no").inputValue();
  await page.getByTestId("sales-party-code").fill("KH-001");

  await page.getByTestId("sales-line-product").fill("CP-001");
  await page.getByTestId("sales-line-warehouse").fill("CK-001");
  await page.getByTestId("sales-line-qty").fill("2");
  await page.getByTestId("sales-line-price").fill("30");
  await addEntryLineBelow(page);
  await page.getByTestId("sales-line-product-2").fill("CP-001");
  await page.getByTestId("sales-line-warehouse-2").fill("CK-001");
  await page.getByTestId("sales-line-qty-2").fill("3");
  await page.getByTestId("sales-line-price-2").fill("31");

  await page.getByTestId("save-sales-order").dispatchEvent("click");
  await page.getByText("草稿已保存").waitFor({ state: "visible" });
  const duplicateMessage = "重复商品+仓库允许保存";
  const duplicateScreenshot = `a29-entry-save-validation-duplicate-allowed-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, duplicateScreenshot), fullPage: true });

  await addEntryLineBelow(page);
  await page.getByTestId("sales-line-product-3").fill("");
  await page.getByTestId("sales-line-qty-3").fill("0");
  await page.getByTestId("sales-line-price-3").fill("0");
  await page.keyboard.press("Escape");

  await page.getByTestId("save-sales-order").dispatchEvent("click");
  const saveMessage = "草稿已保存，已移除 1 行空白分录";
  await page.getByText(saveMessage).waitFor({ state: "visible" });
  const rowCountAfterSave = await page.getByTestId("sales-entry-row").count();
  assertEqual("row count after blank cleanup", rowCountAfterSave, 2);
  const total = (await page.getByTestId("document-total-amount").innerText()).trim();
  assertEqual("total", total, "172.89");

  const detail = await requireApi(`/api/sales-orders/${encodeURIComponent(billNo)}`);
  const savedLines = detail.lines.map((line) => ({
    productCode: String(line.productCode ?? ""),
    warehouseCode: String(line.warehouseCode ?? ""),
    qty: Number(line.qty ?? 0),
    unitPrice: Number(line.unitPrice ?? 0)
  }));
  assertDeepEqual("saved lines", savedLines, [
    { productCode: "CP-001", warehouseCode: "CK-001", qty: 2, unitPrice: 30 },
    { productCode: "CP-001", warehouseCode: "CK-001", qty: 3, unitPrice: 31 }
  ]);
  const duplicateSavedLines = savedLines;

  const cleanScreenshot = `a29-entry-save-validation-clean-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, cleanScreenshot), fullPage: true });

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    billNo,
    duplicateMessage,
    duplicateSavedLines,
    saveMessage,
    rowCountAfterSave,
    total,
    savedLines,
    screenshots: [
      `verification/playwright/${duplicateScreenshot}`,
      `verification/playwright/${cleanScreenshot}`
    ]
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
