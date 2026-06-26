import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { createSalesOutDraftViaDeliveryNotice } from "./helpers/sales-delivery-notice-flow.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a16-source-line-trace-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
await installApiSession(apiBase);
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-24";

const salesLines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 10, unitPrice: 86, lineRemark: "A16 销售源一", planDeliveryDate: "2026-07-11" },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 8, unitPrice: 94, lineRemark: "A16 销售源二", planDeliveryDate: "2026-07-12" },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 6, unitPrice: 12, lineRemark: "A16 销售源三", planDeliveryDate: "2026-07-13" }
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
          txnType: "A16_SOURCE_LINE_TRACE_IN",
          sourceBillType: `A16_SOURCE_LINE_TRACE:${batch}`
        }
      });
    }
  }
}

async function createData() {
  await seedStock();
  const salesOrderNo = `XSDD-A16-${batch}`;
  const salesOutNo = `XSCK-A16-${batch}`;
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
  const deliveryNoticeNo = `FHTZ-A16-${batch}`;
  await createSalesOutDraftViaDeliveryNotice((pathname, body) => requireApi(pathname, { body }), {
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
  }, deliveryNoticeNo);
  await requireApi(`/api/sales-outs/${encodeURIComponent(salesOutNo)}/audit`);

  const purchaseOrderNo = `CGDD-A16-${batch}`;
  const purchaseInNo = `CGRK-A16-${batch}`;
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

  return { salesOrderNo, deliveryNoticeNo, salesOutNo, purchaseOrderNo, purchaseInNo };
}

async function openDetailFromList(page, moduleName, entryId, listId, billNo) {
  await page.getByTestId(`module-${moduleName}`).hover();
  await page.getByTestId(`query-${entryId}`).click();
  await page.getByTestId(`tab-${listId}`).waitFor({ state: "visible" });
  await page.getByTestId("list-keyword").fill(billNo);
  await page.getByTestId("list-keyword").press("Enter");
  await page.getByTestId(`open-document-${billNo}`).click();
}

async function readSourceLineNos(page, prefix, count) {
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const orderNo = (await page.getByTestId(`${prefix}-line-source-order-no${suffix}`).innerText()).trim();
    const lineNo = (await page.getByTestId(`${prefix}-line-source-line-no${suffix}`).innerText()).trim();
    values.push(`${orderNo} / ${lineNo}`);
  }
  return values;
}

function assertArray(name, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${name} expected ${expected.join(",")}, got ${actual.join(",")}`);
  }
}

function numberArray(lines, field) {
  return lines.map((line) => Number(line[field] ?? 0));
}

const data = await createData();
const salesDetail = await requireApi(`/api/sales-orders/${encodeURIComponent(data.salesOrderNo)}`, { method: "GET" });
const salesOutDetail = await requireApi(`/api/sales-outs/${encodeURIComponent(data.salesOutNo)}`, { method: "GET" });
const purchaseDetail = await requireApi(`/api/purchase-orders/${encodeURIComponent(data.purchaseOrderNo)}`, { method: "GET" });
const salesShipped = numberArray(salesDetail.lines, "shippedQty");
const purchaseReceived = numberArray(purchaseDetail.lines, "receivedQty");
assertArray("sales shipped by source line", salesShipped, [4, 0, 2]);
assertArray("sales out carried remarks", salesOutDetail.lines.map((line) => line.lineRemark), ["A16 销售源三", "A16 销售源一"]);
assertArray("sales out carried plan dates", salesOutDetail.lines.map((line) => line.planDeliveryDate), ["2026-07-13", "2026-07-11"]);
assertArray("purchase received by source line", purchaseReceived, [5, 0, 3]);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const screenshots = [];

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await openDetailFromList(page, "销售管理", "sales-out-form", "sales-out-form-list", data.salesOutNo);
  const salesOutSourceLines = await readSourceLineNos(page, "sales-out", 2);
  assertArray("sales out source line nos", salesOutSourceLines, [`${data.deliveryNoticeNo} / #1`, `${data.deliveryNoticeNo} / #2`]);
  const salesScreenshot = `a16-sales-out-source-line-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, salesScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${salesScreenshot}`);

  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await openDetailFromList(page, "采购管理", "purchase-in-form", "purchase-in-form-list", data.purchaseInNo);
  const purchaseInSourceLines = await readSourceLineNos(page, "purchase-in", 2);
  assertArray("purchase in source line nos", purchaseInSourceLines, [`${data.purchaseOrderNo} / #3`, `${data.purchaseOrderNo} / #1`]);
  const purchaseScreenshot = `a16-purchase-in-source-line-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, purchaseScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${purchaseScreenshot}`);

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    salesOrderNo: data.salesOrderNo,
    deliveryNoticeNo: data.deliveryNoticeNo,
    salesOutNo: data.salesOutNo,
    salesOutSourceLines,
    salesShipped,
    salesOutCarriedRemarks: salesOutDetail.lines.map((line) => line.lineRemark),
    salesOutCarriedPlanDates: salesOutDetail.lines.map((line) => line.planDeliveryDate),
    purchaseOrderNo: data.purchaseOrderNo,
    purchaseInNo: data.purchaseInNo,
    purchaseInSourceLines,
    purchaseReceived,
    screenshots
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
