import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a34-risky-action-confirm-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
await installApiSession(apiBase);
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-24";
const lines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 3, unitPrice: 86 },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 2, unitPrice: 94 },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 4, unitPrice: 12 }
];

await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

async function api(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "POST",
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
    throw new Error(`${options.method ?? "POST"} ${pathname} failed ${result.status}: ${JSON.stringify(result.data)}`);
  }
  return result.data;
}

async function seedStock() {
  for (const productCode of ["CP-001", "PJ-014", "CP-T413874"]) {
    for (const warehouseCode of ["CK-001", "CK-002", "CK-T413874"]) {
      await requireApi("/api/inventory/adjustments", {
        body: {
          productCode,
          warehouseCode,
          qtyDelta: 1000,
          txnType: "A34_RISKY_CONFIRM_IN",
          sourceBillType: `A34_RISKY_CONFIRM:${batch}`
        }
      });
    }
  }
}

async function createData() {
  await seedStock();
  const salesOutNo = `XSCK-A34-R-${batch}`;
  await requireApi("/api/sales-outs/draft", {
    body: {
      billNo: salesOutNo,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      lines
    }
  });
  await requireApi(`/api/sales-outs/${encodeURIComponent(salesOutNo)}/audit`);

  const purchaseInNo = `CGRK-A34-HC-${batch}`;
  await requireApi("/api/purchase-ins/draft", {
    body: {
      billNo: purchaseInNo,
      supplierCode: "GYS-001",
      billDate,
      department: "采购部",
      ownerName: "本地管理员",
      lines
    }
  });
  await requireApi(`/api/purchase-ins/${encodeURIComponent(purchaseInNo)}/audit`);

  return { salesOutNo, purchaseInNo };
}

async function openDetailFromList(page, moduleName, entryId, listId, billNo) {
  await page.getByTestId(`module-${moduleName}`).hover();
  await page.getByTestId(`query-${entryId}`).click();
  await page.getByTestId(`tab-${listId}`).waitFor({ state: "visible" });
  await page.getByTestId("list-keyword").fill(billNo);
  await page.getByTestId("list-keyword").press("Enter");
  await page.getByTestId(`open-document-${billNo}`).click();
  await page.getByTestId("document-status").waitFor({ state: "visible" });
}

async function expectStatus(page, expected) {
  await page.waitForFunction(
    (value) => document.querySelector('[data-testid="document-status"]')?.textContent?.trim() === value,
    expected
  );
}

async function waitInputValue(page, testId, expected) {
  const locator = page.getByTestId(testId);
  await locator.waitFor({ state: "visible" });
  await page.waitForFunction(
    ({ id, value }) => document.querySelector(`[data-testid="${id}"]`)?.value === value,
    { id: testId, value: expected }
  );
  return locator.inputValue();
}

function assertIncludes(name, value, expected) {
  if (!String(value).includes(expected)) {
    throw new Error(`${name} expected to include ${expected}, got ${value}`);
  }
}

const data = await createData();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const screenshots = [];

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await openDetailFromList(page, "销售管理", "sales-out-form", "sales-out-form-list", data.salesOutNo);
  await expectStatus(page, "已审核");
  await page.getByTestId("reverse-document").click();
  await page.getByTestId("risky-action-dialog").waitFor({ state: "visible" });
  const reverseDialogText = await page.getByTestId("risky-action-dialog").innerText();
  assertIncludes("reverse dialog", reverseDialogText, "反审核确认");
  assertIncludes("reverse dialog", reverseDialogText, "反审核将冲销销售出库库存流水");
  const reverseDialogScreenshot = `a34-reverse-confirm-dialog-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, reverseDialogScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${reverseDialogScreenshot}`);
  await page.getByTestId("risky-action-cancel").click();
  await expectStatus(page, "已审核");
  assertIncludes("cancel reverse message", await page.getByTestId("form-message").innerText(), "已取消反审核");
  await page.getByTestId("reverse-document").click();
  await page.getByTestId("risky-action-confirm").click();
  await expectStatus(page, "草稿");
  assertIncludes("reverse success message", await page.getByTestId("form-message").innerText(), "反审核成功");

  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await openDetailFromList(page, "采购管理", "purchase-in-form", "purchase-in-form-list", data.purchaseInNo);
  await expectStatus(page, "已审核");
  await page.getByTestId("red-reverse-document").click();
  await page.getByTestId("risky-action-dialog").waitFor({ state: "visible" });
  const redDialogText = await page.getByTestId("risky-action-dialog").innerText();
  assertIncludes("red reverse dialog", redDialogText, "红冲确认");
  assertIncludes("red reverse dialog", redDialogText, `HC-${data.purchaseInNo}`);
  assertIncludes("red reverse dialog", redDialogText, "红冲将生成负数采购入库单");
  const redDialogScreenshot = `a34-red-reverse-confirm-dialog-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, redDialogScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${redDialogScreenshot}`);
  await page.getByTestId("risky-action-cancel").click();
  await expectStatus(page, "已审核");
  assertIncludes("cancel red reverse message", await page.getByTestId("form-message").innerText(), "已取消红冲");
  await page.getByTestId("red-reverse-document").click();
  await page.getByTestId("risky-action-confirm").click();
  await expectStatus(page, "已红冲");
  const redBillNo = `HC-${data.purchaseInNo}`;
  await waitInputValue(page, "purchase-in-bill-no", redBillNo);
  assertIncludes("red reverse success message", await page.getByTestId("form-message").innerText(), "红冲成功");

  const salesOutDetail = await requireApi(`/api/sales-outs/${encodeURIComponent(data.salesOutNo)}`, { method: "GET" });
  const purchaseInDetail = await requireApi(`/api/purchase-ins/${encodeURIComponent(redBillNo)}`, { method: "GET" });
  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    salesOutNo: data.salesOutNo,
    salesOutStatus: salesOutDetail.document.status,
    purchaseInNo: data.purchaseInNo,
    redPurchaseInNo: redBillNo,
    purchaseInStatus: purchaseInDetail.document.status,
    screenshots
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
