import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a24-push-confirm-selected-warehouse-regression.json");
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
    for (const warehouseCode of ["CK-001", "CK-002", "CK-003", "CK-T413874"]) {
      await requireApi("/api/inventory/adjustments", {
        body: {
          productCode,
          warehouseCode,
          qtyDelta: 2000,
          txnType: "A24_PUSH_CONFIRM_WAREHOUSE_IN",
          sourceBillType: `A24_PUSH_CONFIRM_WAREHOUSE:${batch}`
        }
      });
    }
  }
}

async function createData() {
  await seedStock();
  const salesOrderNo = `XSDD-A24-${batch}`;
  const firstSalesOutNo = `XSCK-A24-PART-${batch}`;
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

  const purchaseOrderNo = `CGDD-A24-${batch}`;
  const firstPurchaseInNo = `CGRK-A24-PART-${batch}`;
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

  return { salesOrderNo, purchaseOrderNo };
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

async function readPushConfirmWarehouses(page) {
  const values = [];
  for (let index = 0; index < 3; index += 1) {
    const testId = index === 0 ? "push-confirm-warehouse" : `push-confirm-warehouse-${index + 1}`;
    values.push((await page.getByTestId(testId).innerText()).trim());
  }
  return values;
}

async function readFormWarehouses(page, prefix) {
  const values = [];
  for (let index = 0; index < 3; index += 1) {
    const testId = index === 0 ? `${prefix}-line-warehouse` : `${prefix}-line-warehouse-${index + 1}`;
    values.push(await page.getByTestId(testId).inputValue());
  }
  return values;
}

async function readFormQtys(page, prefix) {
  const qtys = [];
  for (let index = 0; index < 3; index += 1) {
    const testId = index === 0 ? `${prefix}-line-qty` : `${prefix}-line-qty-${index + 1}`;
    qtys.push(Number(await page.getByTestId(testId).inputValue()));
  }
  return qtys;
}

async function exercisePushConfirmWarehouse(page, flow) {
  await openListAndPush(page, flow.moduleName, flow.entryId, flow.listId, flow.billNo, flow.pushTestId);
  const defaultWarehouses = await readPushConfirmWarehouses(page);
  assertArray(`${flow.name} default warehouses`, defaultWarehouses, ["CK-001", "CK-T413874", "CK-002"]);

  await page.getByTestId("push-confirm-warehouse-code").fill("CK-003");
  await page.getByTestId("push-confirm-apply-warehouse").click();
  const allWarehouses = await readPushConfirmWarehouses(page);
  assertArray(`${flow.name} no selection applies warehouse to all`, allWarehouses, ["CK-003", "CK-003", "CK-003"]);

  await page.getByTestId("push-confirm-select-2").check();
  await page.getByTestId("push-confirm-warehouse-code").fill("CK-002");
  await page.getByTestId("push-confirm-apply-warehouse").click();
  const selectedWarehouses = await readPushConfirmWarehouses(page);
  assertArray(`${flow.name} selected warehouse only changes row 2`, selectedWarehouses, ["CK-003", "CK-002", "CK-003"]);

  const dialogScreenshot = `${flow.screenshotPrefix}-dialog-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, dialogScreenshot), fullPage: true });

  await page.getByTestId("push-confirm-ok").click();
  await page.getByTestId(flow.sourceInputTestId).waitFor({ state: "visible" });
  const formWarehouses = await readFormWarehouses(page, flow.formPrefix);
  assertArray(`${flow.name} form warehouses`, formWarehouses, ["CK-003", "CK-002", "CK-003"]);
  const formQtys = await readFormQtys(page, flow.formPrefix);
  assertArray(`${flow.name} form qtys`, formQtys, [6, 5, 4]);
  const formScreenshot = `${flow.screenshotPrefix}-form-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, formScreenshot), fullPage: true });

  return {
    defaultWarehouses,
    allWarehouses,
    selectedWarehouses,
    formWarehouses,
    formQtys,
    screenshots: [
      `verification/playwright/${dialogScreenshot}`,
      `verification/playwright/${formScreenshot}`
    ]
  };
}

function assertArray(name, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${name} expected ${expected.join(",")}, got ${actual.join(",")}`);
  }
}

const data = await createData();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  const sales = await exercisePushConfirmWarehouse(page, {
    name: "sales",
    moduleName: "销售管理",
    entryId: "sales-order-form",
    listId: "sales-order-form-list",
    billNo: data.salesOrderNo,
    pushTestId: "push-sales-out",
    formPrefix: "sales-out",
    sourceInputTestId: "sales-out-source-order-no",
    screenshotPrefix: "a24-sales-push-confirm-warehouse"
  });

  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  const purchase = await exercisePushConfirmWarehouse(page, {
    name: "purchase",
    moduleName: "采购管理",
    entryId: "purchase-order-form",
    listId: "purchase-order-form-list",
    billNo: data.purchaseOrderNo,
    pushTestId: "push-purchase-in",
    formPrefix: "purchase-in",
    sourceInputTestId: "purchase-in-source-order-no",
    screenshotPrefix: "a24-purchase-push-confirm-warehouse"
  });

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    salesOrderNo: data.salesOrderNo,
    purchaseOrderNo: data.purchaseOrderNo,
    sales,
    purchase,
    screenshots: [...sales.screenshots, ...purchase.screenshots]
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
