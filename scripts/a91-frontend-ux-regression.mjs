import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a91-frontend-ux-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-26";

await installApiSession(apiBase);
await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function api(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "POST",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok && !options.expectFailure) {
    throw new Error(`${options.method ?? "POST"} ${pathname} failed ${response.status}: ${text}`);
  }
  return { status: response.status, ok: response.ok, data, text };
}

function salesOrderPayload(billNo) {
  return {
    billNo,
    customerCode: "KH-001",
    billDate,
    department: "销售部",
    ownerName: "本地管理员",
    lines: [{ productCode: "CP-001", warehouseCode: "CK-001", qty: 1, unitPrice: 86, lineRemark: `A91-${batch}` }]
  };
}

const firstBillNo = `XSDD-A91-1-${batch}`;
const secondBillNo = `XSDD-A91-2-${batch}`;
await api("/api/sales-orders/draft", { body: salesOrderPayload(firstBillNo) });
await api("/api/sales-orders/draft", { body: salesOrderPayload(secondBillNo) });
const errorResponse = await api(`/api/sales-orders/${encodeURIComponent(firstBillNo)}/reverse`, { expectFailure: true });
assert(errorResponse.status === 409, `reverse draft should be 409, got ${errorResponse.status}`);
assert(errorResponse.data?.reason === "销售订单不存在或不能反审核", `error reason should be backend reason, got ${JSON.stringify(errorResponse.data)}`);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const screenshot = `a91-frontend-ux-${batch}.png`;

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("query-sales-order-form").click();
  await page.getByTestId("list-create").waitFor({ state: "visible" });

  await page.getByTestId("list-create").click();
  await page.getByTestId("sales-line-product").waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const input = document.querySelector('[data-testid="sales-bill-no"]');
    return input instanceof HTMLInputElement && /^XSDD\d{6}$/.test(input.value);
  });
  const confirmDialogsAfterCreate = await page.getByTestId("batch-confirm-dialog").count();
  const newBillNo = await page.getByTestId("sales-bill-no").inputValue();
  assert(confirmDialogsAfterCreate === 0, "document list create should not open generic batch confirm dialog");
  assert(/^XSDD\d{6}$/.test(newBillNo), `list create should open new sales order form, got billNo=${newBillNo}`);

  await page.getByTestId("sales-line-product").fill("CP-001");
  await page.getByTestId("sales-line-qty").fill("123456789012345");
  await page.getByTestId("sales-line-price").fill("86");
  await page.getByTestId("sales-line-menu").click();
  await page.getByTestId("sales-line-copy").click();
  assert(await page.getByTestId("sales-entry-row").count() === 2, "line menu copy should keep copy function");

  await page.getByTestId("entry-column-settings").click();
  await page.getByTestId("entry-column-settings-dialog").waitFor({ state: "visible" });
  await page.locator(".column-setting-row").filter({ hasText: "备注" }).locator('input[type="checkbox"]').uncheck();
  await page.getByTestId("entry-column-settings-ok").click();
  await page.getByTestId("sales-line-remark").waitFor({ state: "detached" });
  const totalBox = await page.getByTestId("document-total-amount").boundingBox();
  const priceTaxTotalBox = await page.getByTestId("sales-line-price-tax-total").locator("..").boundingBox();
  assert(totalBox && priceTaxTotalBox && Math.abs(totalBox.x - priceTaxTotalBox.x) < 2, "total amount should align under price-tax-total column");

  await page.getByTestId("tab-sales-order-form-list").click();
  await page.getByTestId("list-keyword").fill("XSDD-A91");
  await page.getByTestId("list-query").click();
  await page.getByTestId(`open-document-${firstBillNo}`).waitFor({ state: "visible" });
  await page.getByTestId(`open-document-${firstBillNo}`).click();
  await page.getByTestId("sales-line-product").waitFor({ state: "visible" });
  await page.getByTestId("tab-sales-order-form-list").click();
  const firstDisabled = await page.getByTestId(`open-document-${firstBillNo}`).isDisabled();
  const secondDisabled = await page.getByTestId(`open-document-${secondBillNo}`).isDisabled();
  assert(firstDisabled, "opened bill row should be locked");
  assert(!secondDisabled, "other bill rows should remain openable");

  await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });
  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    ok: true,
    firstBillNo,
    secondBillNo,
    newBillNo,
    confirmDialogsAfterCreate,
    backendReason: errorResponse.data.reason,
    rowLock: { firstDisabled, secondDisabled },
    screenshot: `verification/playwright/${screenshot}`
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
