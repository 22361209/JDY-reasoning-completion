import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a12-execution-columns-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-24";

const salesLines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 10, unitPrice: 86 },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 8, unitPrice: 94 },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 6, unitPrice: 12 }
];
const salesOutLines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 4, unitPrice: 86 },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 3, unitPrice: 94 },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 2, unitPrice: 12 }
];
const purchaseLines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 11, unitPrice: 72 },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 9, unitPrice: 81 },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 7, unitPrice: 8 }
];
const purchaseInLines = [
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
          txnType: "A12_EXECUTION_COLUMNS_IN",
          sourceBillType: `A12_EXECUTION_COLUMNS:${batch}`
        }
      });
    }
  }
}

async function createData() {
  await seedStock();
  const salesOrderNo = `XSDD-A12-${batch}`;
  const salesOutNo = `XSCK-A12-PART-${batch}`;
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
      billNo: salesOutNo,
      sourceOrderNo: salesOrderNo,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      lines: salesOutLines
    }
  });
  await requireApi(`/api/sales-outs/${encodeURIComponent(salesOutNo)}/audit`);

  const purchaseOrderNo = `CGDD-A12-${batch}`;
  const purchaseInNo = `CGRK-A12-PART-${batch}`;
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
      billNo: purchaseInNo,
      sourceOrderNo: purchaseOrderNo,
      supplierCode: "GYS-001",
      billDate,
      department: "采购部",
      ownerName: "本地管理员",
      lines: purchaseInLines
    }
  });
  await requireApi(`/api/purchase-ins/${encodeURIComponent(purchaseInNo)}/audit`);

  return {
    salesOrderNo,
    purchaseOrderNo,
    expectedSalesExecuted: [4, 3, 2],
    expectedSalesRemaining: [6, 5, 4],
    expectedPurchaseExecuted: [5, 4, 3],
    expectedPurchaseRemaining: [6, 5, 4]
  };
}

async function openOrderDetail(page, moduleName, entryId, listId, billNo) {
  await page.getByTestId(`module-${moduleName}`).hover();
  await page.getByTestId(`query-${entryId}`).click();
  await page.getByTestId(`tab-${listId}`).waitFor({ state: "visible" });
  await page.getByTestId("list-keyword").fill(billNo);
  await page.getByTestId("list-keyword").press("Enter");
  await page.getByTestId(`open-document-${billNo}`).click();
}

async function readReadonlyQtys(page, prefix, kind, count) {
  const qtys = [];
  for (let index = 0; index < count; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const text = await page.getByTestId(`${prefix}-line-${kind}-qty${suffix}`).innerText();
    qtys.push(Number(text));
  }
  return qtys;
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
  await openOrderDetail(page, "销售管理", "sales-order-form", "sales-order-form-list", data.salesOrderNo);
  await page.getByTestId("sales-line-executed-qty").waitFor({ state: "visible" });
  const salesExecuted = await readReadonlyQtys(page, "sales", "executed", 3);
  const salesRemaining = await readReadonlyQtys(page, "sales", "remaining", 3);
  assertSameArray("sales executed", salesExecuted, data.expectedSalesExecuted);
  assertSameArray("sales remaining", salesRemaining, data.expectedSalesRemaining);
  const salesScreenshot = `a12-sales-execution-columns-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, salesScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${salesScreenshot}`);

  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await openOrderDetail(page, "采购管理", "purchase-order-form", "purchase-order-form-list", data.purchaseOrderNo);
  await page.getByTestId("purchase-line-executed-qty").waitFor({ state: "visible" });
  const purchaseExecuted = await readReadonlyQtys(page, "purchase", "executed", 3);
  const purchaseRemaining = await readReadonlyQtys(page, "purchase", "remaining", 3);
  assertSameArray("purchase executed", purchaseExecuted, data.expectedPurchaseExecuted);
  assertSameArray("purchase remaining", purchaseRemaining, data.expectedPurchaseRemaining);
  const purchaseScreenshot = `a12-purchase-execution-columns-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, purchaseScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${purchaseScreenshot}`);

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    salesOrderNo: data.salesOrderNo,
    purchaseOrderNo: data.purchaseOrderNo,
    salesExecuted,
    salesRemaining,
    purchaseExecuted,
    purchaseRemaining,
    screenshots
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
