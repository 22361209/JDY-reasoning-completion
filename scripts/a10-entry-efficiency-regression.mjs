import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

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
  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("entry-sales-order-form").click();
  await page.getByTestId("sales-line-product").waitFor({ state: "visible" });

  await page.getByTestId("sales-line-product").fill("CP-001");
  await page.getByTestId("sales-line-qty").fill("2");
  await page.getByTestId("sales-line-price").fill("86");
  await page.getByTestId("sales-line-copy").click();

  const rowCountAfterCopy = await page.getByTestId("sales-entry-row").count();
  if (rowCountAfterCopy !== 2) {
    throw new Error(`copy row expected 2 rows, got ${rowCountAfterCopy}`);
  }
  const copiedProduct = await page.getByTestId("sales-line-product-2").inputValue();
  const copiedQty = Number(await page.getByTestId("sales-line-qty-2").inputValue());
  if (copiedProduct !== "CP-001" || copiedQty !== 2) {
    throw new Error(`copied row mismatch product=${copiedProduct} qty=${copiedQty}`);
  }

  await page.getByTestId("batch-warehouse-code").fill("CK-002");
  await page.getByTestId("apply-batch-warehouse").click();
  const warehouses = [
    await page.getByTestId("sales-line-warehouse").inputValue(),
    await page.getByTestId("sales-line-warehouse-2").inputValue()
  ];
  if (warehouses.some((warehouse) => warehouse !== "CK-002")) {
    throw new Error(`batch warehouse expected CK-002, got ${warehouses.join(",")}`);
  }

  await page.getByTestId("sales-line-qty").focus();
  await page.keyboard.press("Enter");
  const focusedAfterEnter = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  if (focusedAfterEnter !== "sales-line-qty-2") {
    throw new Error(`Enter should focus sales-line-qty-2, got ${focusedAfterEnter}`);
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
    rowCountAfterCopy,
    copiedProduct,
    copiedQty,
    warehouses,
    focusedAfterEnter,
    focusedAfterArrowUp,
    screenshot: `verification/playwright/${screenshot}`
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
