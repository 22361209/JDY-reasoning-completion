import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loginAsAdmin } from "./helpers/regression-auth.mjs";
import { clickNewDocument } from "./helpers/document-actions.mjs";
import { addEntryLineBelow } from "./helpers/entry-table-actions.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a31-zero-value-reason-remark-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);

await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

async function requireApi(page, pathname) {
  const result = await page.evaluate(async (url) => {
    const response = await fetch(url);
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  }, pathname);
  const data = result.text ? JSON.parse(result.text) : {};
  if (!result.ok) {
    throw new Error(`GET ${pathname} failed ${result.status}: ${JSON.stringify(data)}`);
  }
  return data;
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
  assertEqual("zero warning row count", await dialog.locator("tbody tr").count(), 1);
  await page.getByTestId("entry-zero-reason").selectOption("样品");
  const reasonScreenshot = `a31-zero-value-reason-dialog-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, reasonScreenshot), fullPage: true });

  await page.getByTestId("entry-zero-confirm").click();
  const saveMessage = "草稿已保存，已确认 1 行零值分录";
  const billNo = await waitForGeneratedSalesOrderNo(page, billNoInput);
  await page.getByTestId("form-message").filter({ hasText: saveMessage }).waitFor({ state: "visible" });
  if (!/^XSDD\d{6}$/.test(billNo)) {
    throw new Error(`saved sales order bill no should match XSDD######, got ${JSON.stringify(billNo)}`);
  }
  const firstRemark = await page.getByTestId("sales-line-remark").inputValue();
  const secondRemark = await page.getByTestId("sales-line-remark-2").inputValue();
  assertEqual("first remark", firstRemark, "零值原因：样品（单价为 0）");
  assertEqual("second remark", secondRemark, "");

  const detail = await requireApi(page, `/api/sales-orders/${encodeURIComponent(billNo)}`);
  const savedRemarks = detail.lines.map((line) => String(line.lineRemark ?? ""));
  assertDeepEqual("saved remarks", savedRemarks, [
    "零值原因：样品（单价为 0）",
    "",
    ""
  ]);
  const savedLines = detail.lines.map((line) => ({
    productCode: String(line.productCode ?? ""),
    warehouseCode: String(line.warehouseCode ?? ""),
    qty: Number(line.qty ?? 0),
    unitPrice: Number(line.unitPrice ?? 0),
    lineRemark: String(line.lineRemark ?? "")
  }));

  const savedScreenshot = `a31-zero-value-reason-saved-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, savedScreenshot), fullPage: true });

  const auditButton = page.getByTestId("audit-sales-order");
  if (!await auditButton.isEnabled()) {
    throw new Error(`zero-quantity draft should keep the audit action enabled so the backend can enforce the formal rule: ${JSON.stringify({ status: await page.getByTestId("document-status").innerText(), message: await page.getByTestId("form-message").innerText() })}`);
  }
  const auditEndpoint = `/api/sales-orders/${encodeURIComponent(billNo)}/audit`;
  const auditResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST" && response.url().endsWith(auditEndpoint)
  ));
  await auditButton.click();
  const auditResponse = await auditResponsePromise;
  const auditResponseBody = await auditResponse.text();
  assertEqual("zero-quantity audit status", auditResponse.status(), 400);
  const auditMessage = "销售订单数量必须大于 0";
  await page.waitForFunction((previousMessage) => {
    const message = document.querySelector('[data-testid="form-message"]')?.textContent?.trim() ?? "";
    return Boolean(message) && message !== previousMessage;
  }, saveMessage);
  const actualAuditMessage = (await page.getByTestId("form-message").innerText()).trim();
  if (!actualAuditMessage.includes(auditMessage)) {
    throw new Error(`zero-quantity audit should return the formal positive-quantity reason, got ${JSON.stringify(actualAuditMessage)}`);
  }
  assertEqual("status after rejected audit", (await page.getByTestId("document-status").innerText()).trim(), "草稿");
  const detailAfterAudit = await requireApi(page, `/api/sales-orders/${encodeURIComponent(billNo)}`);
  assertEqual("backend status after rejected audit", String(detailAfterAudit.order?.status ?? ""), "DRAFT");
  const auditScreenshot = `a31-zero-quantity-audit-rejected-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, auditScreenshot), fullPage: true });

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    billNo,
    saveMessage,
    firstRemark,
    secondRemark,
    auditMessage,
    auditResponseStatus: auditResponse.status(),
    auditResponseBody,
    savedLines,
    screenshots: [
      `verification/playwright/${reasonScreenshot}`,
      `verification/playwright/${savedScreenshot}`,
      `verification/playwright/${auditScreenshot}`
    ]
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
