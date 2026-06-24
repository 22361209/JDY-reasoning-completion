import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a11-push-confirm-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
await installApiSession(apiBase);
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-24";

const salesLines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 10, unitPrice: 86 },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 8, unitPrice: 94 },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 6, unitPrice: 12 }
];
const salesFirstOutLines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 4, unitPrice: 86 },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 3, unitPrice: 94 },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 2, unitPrice: 12 }
];
const purchaseLines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 11, unitPrice: 72 },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 9, unitPrice: 81 },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 7, unitPrice: 8 }
];
const purchaseFirstInLines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 5, unitPrice: 72 },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 4, unitPrice: 81 },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 3, unitPrice: 8 }
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
          qtyDelta: 2000,
          txnType: "A11_PUSH_CONFIRM_IN",
          sourceBillType: `A11_PUSH_CONFIRM:${batch}`
        }
      });
    }
  }
}

async function createData() {
  await seedStock();
  const salesOrderNo = `XSDD-A11-${batch}`;
  const firstSalesOutNo = `XSCK-A11-PART-${batch}`;
  await requireApi("/api/sales-orders/draft", {
    body: {
      billNo: salesOrderNo,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      lines: salesLines
    }
  });
  await requireApi(`/api/sales-orders/${encodeURIComponent(salesOrderNo)}/audit`);
  await requireApi("/api/sales-outs/draft", {
    body: {
      billNo: firstSalesOutNo,
      sourceOrderNo: salesOrderNo,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      lines: salesFirstOutLines
    }
  });
  await requireApi(`/api/sales-outs/${encodeURIComponent(firstSalesOutNo)}/audit`);

  const purchaseOrderNo = `CGDD-A11-${batch}`;
  const firstPurchaseInNo = `CGRK-A11-PART-${batch}`;
  await requireApi("/api/purchase-orders/draft", {
    body: {
      billNo: purchaseOrderNo,
      supplierCode: "GYS-001",
      billDate,
      department: "采购部",
      ownerName: "本地管理员",
      lines: purchaseLines
    }
  });
  await requireApi(`/api/purchase-orders/${encodeURIComponent(purchaseOrderNo)}/audit`);
  await requireApi("/api/purchase-ins/draft", {
    body: {
      billNo: firstPurchaseInNo,
      sourceOrderNo: purchaseOrderNo,
      supplierCode: "GYS-001",
      billDate,
      department: "采购部",
      ownerName: "本地管理员",
      lines: purchaseFirstInLines
    }
  });
  await requireApi(`/api/purchase-ins/${encodeURIComponent(firstPurchaseInNo)}/audit`);

  return {
    salesOrderNo,
    purchaseOrderNo,
    expectedSalesRemaining: [6, 5, 4],
    confirmedSalesQtys: [2, 1, 3],
    expectedPurchaseRemaining: [6, 5, 4],
    confirmedPurchaseQtys: [1, 2, 3]
  };
}

async function openListAndPush(page, moduleName, entryId, listId, billNo, pushTestId) {
  await page.getByTestId(`module-${moduleName}`).hover();
  await page.getByTestId(`query-${entryId}`).click();
  await page.getByTestId(`tab-${listId}`).waitFor({ state: "visible" });
  await page.getByTestId("list-keyword").fill(billNo);
  await page.getByTestId("list-keyword").press("Enter");
  const row = page.locator(".vxe-body--row", { hasText: billNo }).first();
  await row.waitFor({ state: "visible" });
  await row.locator(".vxe-checkbox--icon").first().click();
  await page.getByTestId(pushTestId).click();
  await page.getByTestId("push-confirm-dialog").waitFor({ state: "visible" });
}

async function readPushConfirmQtys(page, count) {
  const qtys = [];
  for (let index = 0; index < count; index += 1) {
    const testId = index === 0 ? "push-confirm-qty" : `push-confirm-qty-${index + 1}`;
    qtys.push(Number(await page.getByTestId(testId).inputValue()));
  }
  return qtys;
}

async function fillPushConfirmQtys(page, qtys) {
  for (let index = 0; index < qtys.length; index += 1) {
    const testId = index === 0 ? "push-confirm-qty" : `push-confirm-qty-${index + 1}`;
    await page.getByTestId(testId).fill(String(qtys[index]));
  }
}

async function assertFormQtys(page, prefix, expectedQtys) {
  const actual = [];
  for (let index = 0; index < expectedQtys.length; index += 1) {
    const testId = index === 0 ? `${prefix}-line-qty` : `${prefix}-line-qty-${index + 1}`;
    const value = await page.getByTestId(testId).inputValue();
    actual.push(Number(value));
  }
  if (JSON.stringify(actual) !== JSON.stringify(expectedQtys)) {
    throw new Error(`${prefix} expected confirmed ${expectedQtys.join(",")}, got ${actual.join(",")}`);
  }
  return actual;
}

async function saveAndAuditCurrent(page) {
  await page.getByTestId("save-sales-order").click();
  await page.getByText("草稿已保存").waitFor({ state: "visible" });
  await page.getByTestId("audit-sales-order").click();
  await page.getByText("审核成功").waitFor({ state: "visible" });
}

function assertSameArray(name, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${name} expected ${expected.join(",")}, got ${actual.join(",")}`);
  }
}

const data = await createData();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const screenshots = [];
try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await openListAndPush(page, "销售管理", "sales-order-form", "sales-order-form-list", data.salesOrderNo, "push-sales-out");
  const salesDefaultQtys = await readPushConfirmQtys(page, 3);
  assertSameArray("sales default remaining", salesDefaultQtys, data.expectedSalesRemaining);
  const salesDialogScreenshot = `a11-sales-push-confirm-dialog-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, salesDialogScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${salesDialogScreenshot}`);
  await page.getByTestId("push-confirm-qty").fill("7");
  await page.getByTestId("push-confirm-ok").click();
  await page.getByTestId("push-confirm-error").waitFor({ state: "visible" });
  await fillPushConfirmQtys(page, data.confirmedSalesQtys);
  await page.getByTestId("push-confirm-ok").click();
  await page.getByTestId("sales-out-source-order-no").waitFor({ state: "visible" });
  const salesConfirmedQtys = await assertFormQtys(page, "sales-out", data.confirmedSalesQtys);
  await saveAndAuditCurrent(page);
  const salesScreenshot = `a11-sales-push-confirm-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, salesScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${salesScreenshot}`);

  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await openListAndPush(page, "采购管理", "purchase-order-form", "purchase-order-form-list", data.purchaseOrderNo, "push-purchase-in");
  const purchaseDefaultQtys = await readPushConfirmQtys(page, 3);
  assertSameArray("purchase default remaining", purchaseDefaultQtys, data.expectedPurchaseRemaining);
  const purchaseDialogScreenshot = `a11-purchase-push-confirm-dialog-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, purchaseDialogScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${purchaseDialogScreenshot}`);
  await fillPushConfirmQtys(page, data.confirmedPurchaseQtys);
  await page.getByTestId("push-confirm-ok").click();
  await page.getByTestId("purchase-in-source-order-no").waitFor({ state: "visible" });
  const purchaseConfirmedQtys = await assertFormQtys(page, "purchase-in", data.confirmedPurchaseQtys);
  await saveAndAuditCurrent(page);
  const purchaseScreenshot = `a11-purchase-push-confirm-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, purchaseScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${purchaseScreenshot}`);

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    salesOrderNo: data.salesOrderNo,
    purchaseOrderNo: data.purchaseOrderNo,
    salesDefaultQtys,
    salesConfirmedQtys,
    purchaseDefaultQtys,
    purchaseConfirmedQtys,
    frontGuardChecked: true,
    savedAndAudited: true,
    screenshots
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
