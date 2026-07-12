import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loginAsAdmin } from "./helpers/regression-auth.mjs";
import { clickNewDocument } from "./helpers/document-actions.mjs";
import { addEntryLineBelow } from "./helpers/entry-table-actions.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a30-entry-zero-value-confirm-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);

await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

async function api(page, pathname, options = {}) {
  return page.evaluate(async ({ url, method, body }) => {
    const response = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, data: text ? JSON.parse(text) : {} };
  }, { url: pathname, method: options.method ?? "GET", body: options.body });
}

async function requireApi(page, pathname, options = {}) {
  const result = await api(page, pathname, options);
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

function assertIncludes(name, text, expected) {
  if (!text.includes(expected)) {
    throw new Error(`${name} expected to include ${expected}, got ${text}`);
  }
}

function assertDeepEqual(name, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${name} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function waitForGeneratedSalesOrderNo(page, billNoInput) {
  try {
    await page.waitForFunction(() => {
      const input = document.querySelector('[data-testid="sales-bill-no"]');
      return input instanceof HTMLInputElement && /^XSDD\d{6}$/.test(input.value);
    });
  } catch (error) {
    const message = await page.getByTestId("form-message").innerText().catch(() => "");
    throw new Error(`sales order number was not generated after zero-value confirmation; message=${JSON.stringify(message)}`, { cause: error });
  }
  return billNoInput.inputValue();
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
  await page.getByTestId("sales-line-warehouse").fill("CK-001");
  await page.getByTestId("sales-line-qty").fill("1");
  await page.getByTestId("sales-line-price").fill("0");

  await addEntryLineBelow(page);
  await page.getByTestId("sales-line-product-2").fill("PJ-014");
  await page.getByTestId("sales-line-warehouse-2").fill("CK-002");
  await page.getByTestId("sales-line-qty-2").fill("0");
  await page.getByTestId("sales-line-price-2").fill("5");

  await addEntryLineBelow(page);
  await page.getByTestId("sales-line-product-3").fill("CP-T413874");
  await page.getByTestId("sales-line-warehouse-3").fill("CK-001");
  await page.getByTestId("sales-line-qty-3").fill("2");
  await page.getByTestId("sales-line-price-3").fill("30");

  await page.getByTestId("save-sales-order").click();
  const dialog = page.getByTestId("entry-zero-confirm-dialog");
  await dialog.waitFor({ state: "visible" });
  const dialogText = await dialog.innerText();
  assertIncludes("zero confirm dialog", dialogText, "第 1 行");
  assertIncludes("zero confirm dialog", dialogText, "单价为 0");
  if (dialogText.includes("第 2 行") || dialogText.includes("数量为 0")) {
    throw new Error(`zero-quantity sales-order line should bypass the reason dialog, got ${dialogText}`);
  }
  const warningRows = await dialog.locator("tbody tr").count();
  assertEqual("zero warning row count", warningRows, 1);

  const confirmScreenshot = `a30-entry-zero-value-confirm-dialog-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, confirmScreenshot), fullPage: true });

  await page.getByTestId("entry-zero-cancel").click();
  const cancelMessage = "已取消保存，请检查零数量/零单价分录。";
  await page.getByText(cancelMessage).waitFor({ state: "visible" });

  await page.getByTestId("save-sales-order").click();
  await dialog.waitFor({ state: "visible" });
  await page.getByTestId("entry-zero-confirm").click();
  const saveMessage = "草稿已保存，已确认 1 行零值分录";
  const billNo = await waitForGeneratedSalesOrderNo(page, billNoInput);
  await page.getByTestId("form-message").filter({ hasText: saveMessage }).waitFor({ state: "visible" });
  if (!/^XSDD\d{6}$/.test(billNo)) {
    throw new Error(`saved sales order bill no should match XSDD######, got ${JSON.stringify(billNo)}`);
  }

  const rowCountAfterSave = await page.getByTestId("sales-entry-row").count();
  assertEqual("row count after zero confirm", rowCountAfterSave, 3);
  const total = (await page.getByTestId("document-total-amount").innerText()).trim();
  assertEqual("total", total, "67.80");

  const detail = await requireApi(page, `/api/sales-orders/${encodeURIComponent(billNo)}`);
  const savedLines = detail.lines.map((line) => ({
    productCode: String(line.productCode ?? ""),
    warehouseCode: String(line.warehouseCode ?? ""),
    qty: Number(line.qty ?? 0),
    unitPrice: Number(line.unitPrice ?? 0),
    lineRemark: String(line.lineRemark ?? "")
  }));
  assertDeepEqual("saved lines", savedLines, [
    { productCode: "CP-001", warehouseCode: "CK-001", qty: 1, unitPrice: 0, lineRemark: "零值原因：赠品（单价为 0）" },
    { productCode: "PJ-014", warehouseCode: "CK-002", qty: 0, unitPrice: 5, lineRemark: "" },
    { productCode: "CP-T413874", warehouseCode: "CK-001", qty: 2, unitPrice: 30, lineRemark: "" }
  ]);

  const savedScreenshot = `a30-entry-zero-value-confirm-saved-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, savedScreenshot), fullPage: true });

  const negativeQtyMessage = "销售订单数量不能小于 0";
  const negativeSave = await api(page, "/api/sales-orders/draft", {
    method: "POST",
    body: {
      billNo: null,
      customerCode: "KH-001",
      billDate: "2026-07-12",
      department: "销售部",
      ownerName: "本地管理员",
      lines: [{ productCode: "CP-001", warehouseCode: "CK-001", qty: -1, unitPrice: 5, taxRate: 13 }]
    }
  });
  assertEqual("negative-quantity status", negativeSave.status, 400);
  assertIncludes("negative-quantity reason", JSON.stringify(negativeSave.data), negativeQtyMessage);

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    billNo,
    warningRows,
    cancelMessage,
    saveMessage,
    rowCountAfterSave,
    total,
    savedLines,
    negativeQtyMessage,
    screenshots: [
      `verification/playwright/${confirmScreenshot}`,
      `verification/playwright/${savedScreenshot}`
    ]
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
