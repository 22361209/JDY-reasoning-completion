import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { createSalesOutDraftViaDeliveryNotice } from "./helpers/sales-delivery-notice-flow.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a33-downstream-impact-chain-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
await installApiSession(apiBase);
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-24";

const salesLines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 10, unitPrice: 86 },
  { productCode: "CP-T413874", warehouseCode: "CK-003", qty: 8, unitPrice: 94 },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 6, unitPrice: 12 }
];
const purchaseLines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 11, unitPrice: 72 },
  { productCode: "CP-T413874", warehouseCode: "CK-003", qty: 9, unitPrice: 81 },
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

function generatedBillNo(row, label) {
  const billNo = String(row?.billNo ?? "");
  if (!billNo) {
    throw new Error(`${label} did not return billNo: ${JSON.stringify(row)}`);
  }
  return billNo;
}

async function seedStock() {
  for (const productCode of ["CP-001", "PJ-014", "CP-T413874"]) {
    for (const warehouseCode of ["CK-001", "CK-002", "CK-003"]) {
      await requireApi("/api/inventory/adjustments", {
        body: {
          productCode,
          warehouseCode,
          qtyDelta: 2000,
          txnType: "A33_DOWNSTREAM_IMPACT_IN",
          sourceBillType: `A33_DOWNSTREAM_IMPACT:${batch}`
        }
      });
    }
  }
}

async function createData() {
  await seedStock();
  const salesOrderNo = generatedBillNo(await requireApi("/api/sales-orders/draft", {
    body: {
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      lines: salesLines
    }
  }), "A33销售订单");
  await requireApi(`/api/sales-orders/${encodeURIComponent(salesOrderNo)}/audit`);
  const salesFlow = await createSalesOutDraftViaDeliveryNotice((pathname, body) => requireApi(pathname, { body }), {
    sourceOrderNo: salesOrderNo,
    customerCode: "KH-001",
    billDate,
    department: "销售部",
    ownerName: "本地管理员",
    lines: [
      { ...salesLines[2], sourceLineNo: 3, qty: 2 },
      { ...salesLines[0], sourceLineNo: 1, qty: 4 }
    ]
  });
  const { noticeNo: deliveryNoticeNo, salesOutNo } = salesFlow;
  await requireApi(`/api/sales-outs/${encodeURIComponent(salesOutNo)}/audit`);

  const purchaseOrderNo = generatedBillNo(await requireApi("/api/purchase-orders/draft", {
    body: {
      supplierCode: "GYS-001",
      billDate,
      department: "采购部",
      ownerName: "本地管理员",
      lines: purchaseLines
    }
  }), "A33采购订单");
  await requireApi(`/api/purchase-orders/${encodeURIComponent(purchaseOrderNo)}/audit`);
  const purchaseInNo = generatedBillNo(await requireApi("/api/purchase-ins/draft", {
    body: {
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
  }), "A33采购入库");
  await requireApi(`/api/purchase-ins/${encodeURIComponent(purchaseInNo)}/audit`);

  return { salesOrderNo, deliveryNoticeNo, salesOutNo, purchaseOrderNo, purchaseInNo };
}

async function openDetailFromList(page, moduleName, entryId, listId, billNo, billNoTestId) {
  await page.getByTestId(`module-${moduleName}`).hover();
  await page.getByTestId(`query-${entryId}`).click();
  await page.getByTestId(`tab-${listId}`).waitFor({ state: "visible" });
  await page.getByTestId("list-keyword").fill(billNo);
  await page.getByTestId("list-keyword").press("Enter");
  await page.getByTestId(`open-document-${billNo}`).click();
  await waitInputValue(page, billNoTestId, billNo);
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

function lineDocs(detail, lineNo) {
  const line = detail.lines.find((item) => Number(item.lineNo) === lineNo);
  return line?.downstreamDocs ?? [];
}

function assertIncludes(name, value, expected) {
  if (!String(value).includes(expected)) {
    throw new Error(`${name} expected to include ${expected}, got ${value}`);
  }
}

function assertEqual(name, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${name} expected ${expected}, got ${actual}`);
  }
}

const data = await createData();
const salesDetail = await requireApi(`/api/sales-orders/${encodeURIComponent(data.salesOrderNo)}`, { method: "GET" });
const purchaseDetail = await requireApi(`/api/purchase-orders/${encodeURIComponent(data.purchaseOrderNo)}`, { method: "GET" });
const salesLine3Docs = lineDocs(salesDetail, 3);
const purchaseLine3Docs = lineDocs(purchaseDetail, 3);
assertEqual("sales line 3 downstream count", salesLine3Docs.length, 1);
assertEqual("purchase line 3 downstream count", purchaseLine3Docs.length, 1);
assertIncludes("sales reverse impact", salesLine3Docs[0].reverseImpact, "反审核发货通知将释放预留库存");
assertIncludes("sales red reverse impact", salesLine3Docs[0].redReverseImpact, "发货通知单不支持红冲");
assertIncludes("purchase reverse impact", purchaseLine3Docs[0].reverseImpact, "反审核将冲销采购入库库存流水");
assertIncludes("purchase red reverse impact", purchaseLine3Docs[0].redReverseImpact, "红冲将生成负数采购入库单");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const screenshots = [];

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await openDetailFromList(page, "销售管理", "sales-order-form", "sales-order-form-list", data.salesOrderNo, "sales-bill-no");
  await page.getByTestId("sales-line-downstream-trace-3").click();
  await page.getByTestId("downstream-trace-dialog").waitFor({ state: "visible" });
  const salesDialogText = await page.getByTestId("downstream-trace-dialog").innerText();
  assertIncludes("sales dialog note", salesDialogText, "影响提示");
  assertIncludes("sales dialog reverse", salesDialogText, "反审核发货通知将释放预留库存");
  assertIncludes("sales dialog red reverse", salesDialogText, "发货通知单不支持红冲");
  const salesScreenshot = `a33-sales-downstream-impact-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, salesScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${salesScreenshot}`);
  await page.getByTestId("downstream-doc-open").click();
  await page.getByTestId("delivery-notice-line-source-order-no").filter({ hasText: data.salesOrderNo }).waitFor({ state: "visible" });
  await page.getByTestId("delivery-notice-line-source-line-no").filter({ hasText: "#3" }).waitFor({ state: "visible" });

  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await openDetailFromList(page, "采购管理", "purchase-order-form", "purchase-order-form-list", data.purchaseOrderNo, "purchase-bill-no");
  await page.getByTestId("purchase-line-downstream-trace-3").click();
  await page.getByTestId("downstream-trace-dialog").waitFor({ state: "visible" });
  const purchaseDialogText = await page.getByTestId("downstream-trace-dialog").innerText();
  assertIncludes("purchase dialog note", purchaseDialogText, "影响提示");
  assertIncludes("purchase dialog reverse", purchaseDialogText, "反审核将冲销采购入库库存流水");
  assertIncludes("purchase dialog red reverse", purchaseDialogText, "红冲将生成负数采购入库单");
  const purchaseScreenshot = `a33-purchase-downstream-impact-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, purchaseScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${purchaseScreenshot}`);
  await page.getByTestId("downstream-doc-open").click();
  await page.getByTestId("purchase-in-line-source-order-no").filter({ hasText: data.purchaseOrderNo }).waitFor({ state: "visible" });
  await page.getByTestId("purchase-in-line-source-line-no").filter({ hasText: "#3" }).waitFor({ state: "visible" });

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    salesOrderNo: data.salesOrderNo,
    deliveryNoticeNo: data.deliveryNoticeNo,
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
