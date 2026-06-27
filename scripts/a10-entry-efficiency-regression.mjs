import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a10-entry-efficiency-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);

await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("entry-sales-order-form").click();
  await page.getByTestId("sales-line-product").waitFor({ state: "visible" });

  await page.getByTestId("sales-line-product").fill("CP-001");
  await page.getByTestId("sales-line-qty").fill("2");
  await page.getByTestId("sales-line-price").fill("86");
  await page.getByTestId("sales-line-insert").click();
  await page.getByTestId("sales-line-product-2").fill("PJ-014");
  await page.getByTestId("sales-line-qty-2").fill("3");
  await page.getByTestId("sales-line-price-2").fill("12");

  const rowCountAfterInsert = await page.getByTestId("sales-entry-row").count();
  if (rowCountAfterInsert !== 2) {
    throw new Error(`insert row expected 2 rows, got ${rowCountAfterInsert}`);
  }
  const insertedProduct = await page.getByTestId("sales-line-product-2").inputValue();
  const insertedQty = Number(await page.getByTestId("sales-line-qty-2").inputValue());
  if (insertedProduct !== "PJ-014" || insertedQty !== 3) {
    throw new Error(`inserted row mismatch product=${insertedProduct} qty=${insertedQty}`);
  }

  await page.getByTestId("entry-column-bulk-warehouse").click();
  await page.getByTestId("entry-bulk-warehouse-input").fill("CK-002");
  await page.getByTestId("entry-bulk-warehouse-ok").click();
  const warehouses = [
    await page.getByTestId("sales-line-warehouse").inputValue(),
    await page.getByTestId("sales-line-warehouse-2").inputValue()
  ];
  if (warehouses.some((warehouse) => warehouse !== "CK-002")) {
    throw new Error(`batch warehouse expected CK-002, got ${warehouses.join(",")}`);
  }

  await page.getByTestId("sales-line-qty").focus();
  await page.keyboard.press("ArrowDown");
  const focusedAfterArrowDown = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  if (focusedAfterArrowDown !== "sales-line-qty-2") {
    throw new Error(`ArrowDown should focus sales-line-qty-2, got ${focusedAfterArrowDown}`);
  }
  await page.keyboard.press("ArrowUp");
  const focusedAfterArrowUp = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  if (focusedAfterArrowUp !== "sales-line-qty") {
    throw new Error(`ArrowUp should focus sales-line-qty, got ${focusedAfterArrowUp}`);
  }

  const screenshot = `a10-entry-efficiency-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });
  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    rowCountAfterInsert,
    insertedProduct,
    insertedQty,
    warehouses,
    focusedAfterArrowDown,
    focusedAfterArrowUp,
    screenshot: `verification/playwright/${screenshot}`
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
