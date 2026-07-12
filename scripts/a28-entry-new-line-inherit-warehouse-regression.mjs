import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { clickNewDocument, saveDocument } from "./helpers/document-actions.mjs";
import { addEntryLineBelow } from "./helpers/entry-table-actions.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a28-entry-new-line-inherit-warehouse-regression.json");
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
  await clickNewDocument(page);
  const billNoInput = page.getByTestId("sales-bill-no");
  assertEqual("new sales order bill no", await billNoInput.inputValue(), "");
  assertEqual("new sales order bill no editable", await billNoInput.isEditable(), false);
  await page.getByTestId("sales-party-code").fill("KH-001");

  await page.getByTestId("sales-line-product").fill("CP-001");
  await page.getByTestId("sales-line-warehouse").fill("CK-002");
  await page.getByTestId("sales-line-qty").fill("2");
  await page.getByTestId("sales-line-price").fill("30");
  await addEntryLineBelow(page);
  await page.getByTestId("sales-line-product-2").waitFor({ state: "visible" });
  const newLineAfterAddButton = {
    productCode: await page.getByTestId("sales-line-product-2").inputValue(),
    warehouseCode: await page.getByTestId("sales-line-warehouse-2").inputValue(),
    qty: await page.getByTestId("sales-line-qty-2").inputValue(),
    unitPrice: await page.getByTestId("sales-line-price-2").inputValue()
  };
  assertDeepEqual("new line blank after add button", newLineAfterAddButton, { productCode: "", warehouseCode: "", qty: "0", unitPrice: "0" });

  await page.getByTestId("sales-line-product-2").fill("PJ-014");
  await page.getByTestId("sales-line-warehouse-2").fill("CK-003");
  await page.getByTestId("sales-line-qty-2").fill("4");
  await page.getByTestId("sales-line-price-2").fill("6");
  await page.keyboard.press("Enter");
  const focusAfterPriceEnter = await activeTestId(page);
  assertEqual("focus after price enter", focusAfterPriceEnter, "sales-line-tax-rate-2");
  await page.keyboard.press("Enter");
  const focusAfterTaxRateEnter = await activeTestId(page);
  assertEqual("focus after tax rate enter", focusAfterTaxRateEnter, "sales-line-plan-delivery-date-2");
  await page.keyboard.press("Enter");
  const focusAfterPlanDateEnter = await activeTestId(page);
  assertEqual("focus after plan delivery date enter", focusAfterPlanDateEnter, "sales-line-remark-2");
  await page.getByTestId("sales-line-remark-2").fill("A28 行备注");
  await page.keyboard.press("Enter");
  await page.getByTestId("sales-line-product-3").waitFor({ state: "visible" });
  const focusAfterRemarkEnter = await activeTestId(page);
  const newLineAfterEnter = {
    productCode: await page.getByTestId("sales-line-product-3").inputValue(),
    warehouseCode: await page.getByTestId("sales-line-warehouse-3").inputValue(),
    qty: await page.getByTestId("sales-line-qty-3").inputValue(),
    unitPrice: await page.getByTestId("sales-line-price-3").inputValue()
  };
  assertEqual("focus after remark enter", focusAfterRemarkEnter, "sales-line-product-3");
  assertDeepEqual("new line blank after enter", newLineAfterEnter, { productCode: "", warehouseCode: "", qty: "0", unitPrice: "0" });

  await page.getByTestId("sales-line-product-3").fill("CP-T413874");
  await page.getByTestId("sales-line-warehouse-3").fill("CK-003");
  await page.keyboard.press("Escape");
  await page.getByTestId("sales-line-qty-3").fill("1");
  await page.getByTestId("sales-line-price-3").fill("8");
  await page.keyboard.press("Escape");

  const amounts = [
    (await page.getByTestId("sales-line-amount").innerText()).trim(),
    (await page.getByTestId("sales-line-amount-2").innerText()).trim(),
    (await page.getByTestId("sales-line-amount-3").innerText()).trim()
  ];
  assertDeepEqual("amounts", amounts, ["60.00", "24.00", "8.00"]);
  const total = (await page.getByTestId("document-total-amount").innerText()).trim();
  assertEqual("total", total, "103.96");

  const screenshot = `a28-entry-new-line-blank-form-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });

  await saveDocument(page);
  await page.waitForFunction(() => {
    const input = document.querySelector('[data-testid="sales-bill-no"]');
    return input instanceof HTMLInputElement && /^XSDD\d{6}$/.test(input.value);
  });
  const billNo = await billNoInput.inputValue();
  if (!/^XSDD\d{6}$/.test(billNo)) {
    throw new Error(`saved sales order bill no should match XSDD######, got ${JSON.stringify(billNo)}`);
  }
  const detail = await requireApi(`/api/sales-orders/${encodeURIComponent(billNo)}`);
  const savedLines = detail.lines.map((line) => ({
    productCode: String(line.productCode ?? ""),
    warehouseCode: String(line.warehouseCode ?? ""),
    qty: Number(line.qty ?? 0),
    unitPrice: Number(line.unitPrice ?? 0)
  }));
  assertDeepEqual("saved lines", savedLines, [
    { productCode: "CP-001", warehouseCode: "CK-002", qty: 2, unitPrice: 30 },
    { productCode: "PJ-014", warehouseCode: "CK-003", qty: 4, unitPrice: 6 },
    { productCode: "CP-T413874", warehouseCode: "CK-003", qty: 1, unitPrice: 8 }
  ]);

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    billNo,
    newLineAfterAddButton,
    focusAfterPriceEnter,
    focusAfterTaxRateEnter,
    focusAfterPlanDateEnter,
    focusAfterRemarkEnter,
    newLineAfterEnter,
    amounts,
    total,
    savedLines,
    screenshots: [`verification/playwright/${screenshot}`]
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
