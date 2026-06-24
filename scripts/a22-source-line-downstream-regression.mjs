import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a22-source-line-downstream-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-24";

const salesLines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 10, unitPrice: 86 },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 8, unitPrice: 94 },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 6, unitPrice: 12 }
];
const purchaseLines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 11, unitPrice: 72 },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 9, unitPrice: 81 },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 7, unitPrice: 8 }
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
          txnType: "A22_SOURCE_LINE_DOWNSTREAM_IN",
          sourceBillType: `A22_SOURCE_LINE_DOWNSTREAM:${batch}`
        }
      });
    }
  }
}

async function createData() {
  await seedStock();
  const salesOrderNo = `XSDD-A22-${batch}`;
  const salesOutNo = `XSCK-A22-${batch}`;
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
      lines: [
        { ...salesLines[2], sourceLineNo: 3, qty: 2 },
        { ...salesLines[0], sourceLineNo: 1, qty: 4 }
      ]
    }
  });
  await requireApi(`/api/sales-outs/${encodeURIComponent(salesOutNo)}/audit`);

  const purchaseOrderNo = `CGDD-A22-${batch}`;
  const purchaseInNo = `CGRK-A22-${batch}`;
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
      lines: [
        { ...purchaseLines[2], sourceLineNo: 3, qty: 3 },
        { ...purchaseLines[0], sourceLineNo: 1, qty: 5 }
      ]
    }
  });
  await requireApi(`/api/purchase-ins/${encodeURIComponent(purchaseInNo)}/audit`);

  return { salesOrderNo, salesOutNo, purchaseOrderNo, purchaseInNo };
}

async function openDetailFromList(page, moduleName, entryId, listId, billNo) {
  await page.getByTestId(`module-${moduleName}`).hover();
  await page.getByTestId(`query-${entryId}`).click();
  await page.getByTestId(`tab-${listId}`).waitFor({ state: "visible" });
  await page.getByTestId("list-keyword").fill(billNo);
  await page.getByTestId("list-keyword").press("Enter");
  await page.getByTestId(`open-document-${billNo}`).click();
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
  if (!value.includes(expected)) {
    throw new Error(`${name} expected to include ${expected}, got ${value}`);
  }
}

function assertEqual(name, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${name} expected ${expected}, got ${actual}`);
  }
}

function lineDocs(detail, lineNo) {
  const line = detail.lines.find((item) => Number(item.lineNo) === lineNo);
  return line?.downstreamDocs ?? [];
}

const data = await createData();
const salesDetail = await requireApi(`/api/sales-orders/${encodeURIComponent(data.salesOrderNo)}`, { method: "GET" });
const purchaseDetail = await requireApi(`/api/purchase-orders/${encodeURIComponent(data.purchaseOrderNo)}`, { method: "GET" });
const salesLine3Docs = lineDocs(salesDetail, 3);
const purchaseLine3Docs = lineDocs(purchaseDetail, 3);
assertEqual("sales line 3 downstream count", salesLine3Docs.length, 1);
assertEqual("sales line 3 downstream bill", String(salesLine3Docs[0].billNo), data.salesOutNo);
assertEqual("sales line 3 source line", Number(salesLine3Docs[0].sourceLineNo), 3);
assertEqual("sales line 3 downstream line", Number(salesLine3Docs[0].downstreamLineNo), 1);
assertEqual("purchase line 3 downstream count", purchaseLine3Docs.length, 1);
assertEqual("purchase line 3 downstream bill", String(purchaseLine3Docs[0].billNo), data.purchaseInNo);
assertEqual("purchase line 3 source line", Number(purchaseLine3Docs[0].sourceLineNo), 3);
assertEqual("purchase line 3 downstream line", Number(purchaseLine3Docs[0].downstreamLineNo), 1);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const screenshots = [];

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await openDetailFromList(page, "销售管理", "sales-order-form", "sales-order-form-list", data.salesOrderNo);
  await page.getByTestId("sales-line-downstream-trace-3").click();
  await page.getByTestId("downstream-trace-dialog").waitFor({ state: "visible" });
  const salesDialogText = await page.getByTestId("downstream-trace-dialog").innerText();
  assertIncludes("sales downstream dialog", salesDialogText, data.salesOutNo);
  assertIncludes("sales downstream dialog", salesDialogText, "销售出库单");
  assertIncludes("sales downstream dialog", salesDialogText, "#3");
  assertIncludes("sales downstream dialog", salesDialogText, "#1");
  assertIncludes("sales downstream dialog", salesDialogText, "24.00");
  const salesDialogScreenshot = `a22-sales-downstream-dialog-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, salesDialogScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${salesDialogScreenshot}`);
  await page.getByTestId("downstream-doc-open").click();
  await waitInputValue(page, "sales-out-source-order-no", data.salesOrderNo);
  const salesOpenScreenshot = `a22-sales-downstream-open-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, salesOpenScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${salesOpenScreenshot}`);

  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await openDetailFromList(page, "采购管理", "purchase-order-form", "purchase-order-form-list", data.purchaseOrderNo);
  await page.getByTestId("purchase-line-downstream-trace-3").click();
  await page.getByTestId("downstream-trace-dialog").waitFor({ state: "visible" });
  const purchaseDialogText = await page.getByTestId("downstream-trace-dialog").innerText();
  assertIncludes("purchase downstream dialog", purchaseDialogText, data.purchaseInNo);
  assertIncludes("purchase downstream dialog", purchaseDialogText, "采购入库单");
  assertIncludes("purchase downstream dialog", purchaseDialogText, "#3");
  assertIncludes("purchase downstream dialog", purchaseDialogText, "#1");
  assertIncludes("purchase downstream dialog", purchaseDialogText, "24.00");
  const purchaseDialogScreenshot = `a22-purchase-downstream-dialog-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, purchaseDialogScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${purchaseDialogScreenshot}`);
  await page.getByTestId("downstream-doc-open").click();
  await waitInputValue(page, "purchase-in-source-order-no", data.purchaseOrderNo);
  const purchaseOpenScreenshot = `a22-purchase-downstream-open-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, purchaseOpenScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${purchaseOpenScreenshot}`);

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    salesOrderNo: data.salesOrderNo,
    salesOutNo: data.salesOutNo,
    salesLine3Docs,
    purchaseOrderNo: data.purchaseOrderNo,
    purchaseInNo: data.purchaseInNo,
    purchaseLine3Docs,
    screenshots
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
