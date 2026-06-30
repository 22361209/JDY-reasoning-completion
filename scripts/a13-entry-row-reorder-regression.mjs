import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a13-entry-row-reorder-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);

await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

function productTestId(index) {
  return index === 0 ? "sales-line-product" : `sales-line-product-${index + 1}`;
}

function qtyTestId(index) {
  return index === 0 ? "sales-line-qty" : `sales-line-qty-${index + 1}`;
}

async function fillLine(page, index, productCode, qty) {
  await page.getByTestId(productTestId(index)).fill(productCode);
  await page.getByTestId(qtyTestId(index)).fill(String(qty));
}

async function readProducts(page, count) {
  const products = [];
  for (let index = 0; index < count; index += 1) {
    products.push(await page.getByTestId(productTestId(index)).inputValue());
  }
  return products;
}

async function dragRow(page, fromIndex, toIndex) {
  const from = page.getByTestId(productTestId(fromIndex));
  const to = page.getByTestId(productTestId(toIndex));
  const fromBox = await from.boundingBox();
  const toBox = await to.boundingBox();
  if (!fromBox || !toBox) {
    throw new Error("cannot locate drag source or target");
  }
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 12 });
  await page.mouse.up();
}

function assertArray(name, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${name} expected ${expected.join(",")}, got ${actual.join(",")}`);
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
  await fillLine(page, 0, "CP-001", 1);

  await page.getByTestId("sales-line-insert").click();
  await fillLine(page, 1, "CP-T413874", 2);
  const afterButtonInsert = await readProducts(page, 2);
  assertArray("button insert products", afterButtonInsert, ["CP-001", "CP-T413874"]);

  await page.getByTestId("sales-line-qty-2").press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  await fillLine(page, 2, "PJ-014", 3);
  const afterKeyboardInsert = await readProducts(page, 3);
  assertArray("keyboard insert products", afterKeyboardInsert, ["CP-001", "CP-T413874", "PJ-014"]);

  await dragRow(page, 2, 0);
  const afterBlockedDrag = await readProducts(page, 3);
  assertArray("blocked drag products", afterBlockedDrag, ["CP-001", "CP-T413874", "PJ-014"]);

  const screenshot = `a13-entry-row-reorder-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    afterButtonInsert,
    afterKeyboardInsert,
    afterBlockedDrag,
    rowDragPolicy: "disabled",
    screenshot: `verification/playwright/${screenshot}`
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
