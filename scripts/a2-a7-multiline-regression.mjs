import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { createSalesOutDraftViaDeliveryNotice } from "./helpers/sales-delivery-notice-flow.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a2-a7-multiline-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
await installApiSession(apiBase);
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-24";

const lines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 2, unitPrice: 86 },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 3, unitPrice: 94 },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 4, unitPrice: 12 }
];
const purchaseLines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 5, unitPrice: 72 },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 6, unitPrice: 81 },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 7, unitPrice: 8 }
];
const completeLines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 1, unitPrice: 120 },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 2, unitPrice: 130 },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 3, unitPrice: 140 }
];

const screenshots = [];
const stateCoverage = [];

await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

async function api(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "POST",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${options.method ?? "POST"} ${pathname} failed ${response.status}: ${text}`);
  }
  return response.json();
}

async function get(pathname) {
  return api(pathname, { method: "GET" });
}

async function post(pathname, body) {
  return api(pathname, { method: "POST", body });
}

async function seedStock() {
  for (const productCode of ["CP-001", "PJ-014", "CP-T413874"]) {
    for (const warehouseCode of ["CK-001", "CK-002", "CK-T413874"]) {
      await post("/api/inventory/adjustments", {
        productCode,
        warehouseCode,
        qtyDelta: 2000,
        txnType: "A2_A7_REGRESSION_IN",
        sourceBillType: `A2_A7_REGRESSION:${batch}`
      });
    }
  }
}

async function createBusinessData() {
  await seedStock();

  const salesOrderDraft = `XSDD-A2A7-D-${batch}`;
  const salesOrderAudited = `XSDD-A2A7-A-${batch}`;
  await post("/api/sales-orders/draft", salesOrderPayload(salesOrderDraft));
  await post("/api/sales-orders/draft", salesOrderPayload(salesOrderAudited));
  await post(`/api/sales-orders/${encodeURIComponent(salesOrderAudited)}/audit`);
  stateCoverage.push(["销售订单", "草稿", salesOrderDraft], ["销售订单", "已审核", salesOrderAudited]);

  const salesOutDraft = `XSCK-A2A7-D-${batch}`;
  const salesOutAudited = `XSCK-A2A7-A-${batch}`;
  const salesOutReverse = `XSCK-A2A7-R-${batch}`;
  const salesOutRedSource = `XSCK-A2A7-RS-${batch}`;
  const salesOutRed = `XSCK-A2A7-HC-${batch}`;
  for (const billNo of [salesOutDraft, salesOutAudited, salesOutReverse, salesOutRedSource]) {
    await createSalesOutDraftViaDeliveryNotice(post, stockPayload(billNo, "KH-001", lines, "销售部"));
  }
  await post(`/api/sales-outs/${encodeURIComponent(salesOutAudited)}/audit`);
  await post(`/api/sales-outs/${encodeURIComponent(salesOutReverse)}/audit`);
  await post(`/api/sales-outs/${encodeURIComponent(salesOutReverse)}/reverse`);
  await post(`/api/sales-outs/${encodeURIComponent(salesOutRedSource)}/audit`);
  await post(`/api/sales-outs/${encodeURIComponent(salesOutRedSource)}/red-reverse`, {
    redBillNo: salesOutRed,
    billDate,
    ownerName: "本地管理员"
  });
  stateCoverage.push(
    ["销售出库", "草稿", salesOutDraft],
    ["销售出库", "已审核", salesOutAudited],
    ["销售出库", "草稿", salesOutReverse],
    ["销售出库", "已红冲", salesOutRed]
  );

  const purchaseOrderDraft = `CGDD-A2A7-D-${batch}`;
  const purchaseOrderAudited = `CGDD-A2A7-A-${batch}`;
  await post("/api/purchase-orders/draft", purchaseOrderPayload(purchaseOrderDraft));
  await post("/api/purchase-orders/draft", purchaseOrderPayload(purchaseOrderAudited));
  await post(`/api/purchase-orders/${encodeURIComponent(purchaseOrderAudited)}/audit`);
  stateCoverage.push(["采购订单", "草稿", purchaseOrderDraft], ["采购订单", "已审核", purchaseOrderAudited]);

  const purchaseInDraft = `CGRK-A2A7-D-${batch}`;
  const purchaseInAudited = `CGRK-A2A7-A-${batch}`;
  const purchaseInReverse = `CGRK-A2A7-R-${batch}`;
  const purchaseInRedSource = `CGRK-A2A7-RS-${batch}`;
  const purchaseInRed = `CGRK-A2A7-HC-${batch}`;
  for (const billNo of [purchaseInDraft, purchaseInAudited, purchaseInReverse, purchaseInRedSource]) {
    await post("/api/purchase-ins/draft", purchaseInPayload(billNo));
  }
  await post(`/api/purchase-ins/${encodeURIComponent(purchaseInAudited)}/audit`);
  await post(`/api/purchase-ins/${encodeURIComponent(purchaseInReverse)}/audit`);
  await post(`/api/purchase-ins/${encodeURIComponent(purchaseInReverse)}/reverse`);
  await post(`/api/purchase-ins/${encodeURIComponent(purchaseInRedSource)}/audit`);
  await post(`/api/purchase-ins/${encodeURIComponent(purchaseInRedSource)}/red-reverse`, {
    redBillNo: purchaseInRed,
    billDate,
    ownerName: "本地管理员"
  });
  stateCoverage.push(
    ["采购入库", "草稿", purchaseInDraft],
    ["采购入库", "已审核", purchaseInAudited],
    ["采购入库", "草稿", purchaseInReverse],
    ["采购入库", "已红冲", purchaseInRed]
  );

  const bomCode = `BOM-A2A7-${batch}`;
  const taskIssue = `SCRW-A2A7-I-${batch}`;
  const taskComplete = `SCRW-A2A7-C-${batch}`;
  await post("/api/production/boms", {
    code: bomCode,
    productCode: "CP-001",
    qty: 1,
    lines: [
      { materialCode: "CP-001", qty: 1 },
      { materialCode: "CP-T413874", qty: 2 },
      { materialCode: "PJ-014", qty: 3 }
    ]
  });
  await post(`/api/production/boms/${encodeURIComponent(bomCode)}/audit`);
  await post("/api/production/tasks", { billNo: taskIssue, bomCode, warehouseCode: "CK-001", qty: 2 });
  await post("/api/production/tasks", { billNo: taskComplete, bomCode, warehouseCode: "CK-001", qty: 30 });

  const issueAudited = `SCLL-A2A7-A-${batch}`;
  const issueReverse = `SCLL-A2A7-R-${batch}`;
  const issueRedSource = `SCLL-A2A7-RS-${batch}`;
  const issueRed = `SCLL-A2A7-HC-${batch}`;
  await post(`/api/production/tasks/${encodeURIComponent(taskIssue)}/issue`, { billNo: issueAudited, materialWarehouseCode: "CK-002" });
  await post(`/api/production/tasks/${encodeURIComponent(taskIssue)}/issue`, { billNo: issueReverse, materialWarehouseCode: "CK-002" });
  await post(`/api/production/material-issues/${encodeURIComponent(issueReverse)}/reverse`);
  await post(`/api/production/tasks/${encodeURIComponent(taskIssue)}/issue`, { billNo: issueRedSource, materialWarehouseCode: "CK-002" });
  await post(`/api/production/material-issues/${encodeURIComponent(issueRedSource)}/red-reverse`, { redBillNo: issueRed });
  stateCoverage.push(
    ["生产领料", "已审核", issueAudited],
    ["生产领料", "草稿", issueReverse],
    ["生产领料", "已红冲", issueRed]
  );

  const productInAudited = `CPRK-A2A7-A-${batch}`;
  const productInReverse = `CPRK-A2A7-R-${batch}`;
  const productInRedSource = `CPRK-A2A7-RS-${batch}`;
  const productInRed = `CPRK-A2A7-HC-${batch}`;
  await post(`/api/production/tasks/${encodeURIComponent(taskComplete)}/complete`, { billNo: productInAudited, lines: completeLines });
  await post(`/api/production/tasks/${encodeURIComponent(taskComplete)}/complete`, { billNo: productInReverse, lines: completeLines });
  await post(`/api/production/product-ins/${encodeURIComponent(productInReverse)}/reverse`);
  await post(`/api/production/tasks/${encodeURIComponent(taskComplete)}/complete`, { billNo: productInRedSource, lines: completeLines });
  await post(`/api/production/product-ins/${encodeURIComponent(productInRedSource)}/red-reverse`, { redBillNo: productInRed });
  stateCoverage.push(
    ["产品入库", "已审核", productInAudited],
    ["产品入库", "草稿", productInReverse],
    ["产品入库", "已红冲", productInRed]
  );

  return [
    { name: "销售订单", module: "销售管理", entry: "sales-order-form", list: "sales-order-form-list", type: "sales", billNo: salesOrderAudited, expectedStatus: "已审核" },
    { name: "销售出库", module: "销售管理", entry: "sales-out-form", list: "sales-out-form-list", type: "sales-out", billNo: salesOutRed, expectedStatus: "已红冲" },
    { name: "采购订单", module: "采购管理", entry: "purchase-order-form", list: "purchase-order-form-list", type: "purchase", billNo: purchaseOrderAudited, expectedStatus: "已审核" },
    { name: "采购入库", module: "采购管理", entry: "purchase-in-form", list: "purchase-in-form-list", type: "purchase-in", billNo: purchaseInReverse, expectedStatus: "草稿" },
    { name: "生产领料", module: "生产管理", entry: "material-issue-form", list: "material-issue-form-list", type: "material-issue", billNo: issueRed, expectedStatus: "已红冲" },
    { name: "产品入库", module: "生产管理", entry: "product-in-form", list: "product-in-form-list", type: "product-in", billNo: productInReverse, expectedStatus: "草稿" }
  ];
}

function salesOrderPayload(billNo) {
  return {
    billNo,
    customerCode: "KH-001",
    billDate,
    department: "销售部",
    ownerName: "本地管理员",
    lines
  };
}

function purchaseOrderPayload(billNo) {
  return {
    billNo,
    supplierCode: "GYS-001",
    billDate,
    department: "采购部",
    ownerName: "本地管理员",
    lines: purchaseLines
  };
}

function stockPayload(billNo, partyCode, sourceLines, department) {
  return {
    billNo,
    partyCode,
    customerCode: partyCode,
    billDate,
    department,
    ownerName: "本地管理员",
    lines: sourceLines
  };
}

function purchaseInPayload(billNo) {
  return {
    billNo,
    supplierCode: "GYS-001",
    billDate,
    department: "采购部",
    ownerName: "本地管理员",
    lines: purchaseLines
  };
}

async function openList(page, item) {
  console.log(`open ${item.name} ${item.billNo}`);
  await page.getByTestId(`module-${item.module}`).hover();
  await page.getByTestId(`query-${item.entry}`).click();
  await page.getByTestId(`tab-${item.list}`).waitFor({ state: "visible" });
  const keyword = page.getByTestId("list-keyword");
  await keyword.fill(item.billNo);
  await keyword.press("Enter");
  await page.getByTestId(`open-document-${item.billNo}`).click();
  await page.getByTestId("document-status").waitFor({ state: "visible" });
}

async function assertDetail(page, item) {
  await page.getByText(item.billNo).first().waitFor({ state: "visible" });
  const rows = page.getByTestId(`${item.type}-entry-row`);
  const rowCount = await rows.count();
  if (rowCount !== 3) {
    throw new Error(`${item.name} ${item.billNo} row count expected 3, got ${rowCount}`);
  }
  const amounts = [];
  const taxTotals = [];
  for (let index = 0; index < rowCount; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const text = await page.getByTestId(`${item.type}-line-amount${suffix}`).innerText();
    amounts.push(Number(text.replace(/,/g, "")));
    const taxTotalCell = page.getByTestId(`${item.type}-line-price-tax-total${suffix}`);
    if (await taxTotalCell.count()) {
      const taxTotalText = await taxTotalCell.innerText();
      taxTotals.push(Number(taxTotalText.replace(/,/g, "")));
    }
  }
  const totalText = await page.getByTestId("document-total-amount").innerText();
  const total = Number(totalText.replace(/,/g, ""));
  const sumSource = taxTotals.length === rowCount ? taxTotals : amounts;
  const sum = Number(sumSource.reduce((value, amount) => value + amount, 0).toFixed(2));
  if (Math.abs(total - sum) > 0.001) {
    throw new Error(`${item.name} ${item.billNo} total expected ${sum}, got ${total}`);
  }
  const status = (await page.getByTestId("document-status").innerText()).trim();
  if (status !== item.expectedStatus) {
    throw new Error(`${item.name} ${item.billNo} status expected ${item.expectedStatus}, got ${status}`);
  }
  const screenshot = `a2-a7-regression-${item.type}-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });
  return { ...item, rowCount, amounts, taxTotals, total, status, screenshot: `verification/playwright/${screenshot}` };
}

const documents = await createBusinessData();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  for (const item of documents) {
    try {
      await openList(page, item);
      screenshots.push(await assertDetail(page, item));
      await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
    } catch (error) {
      const failureShot = `a2-a7-regression-failure-${item.type}-${batch}.png`;
      await page.screenshot({ path: path.join(screenshotDir, failureShot), fullPage: true });
      console.error(`failed ${item.name} ${item.billNo}; screenshot=verification/playwright/${failureShot}`);
      throw error;
    }
  }
} finally {
  await browser.close();
}

const detailChecks = [];
for (const item of documents) {
  const endpoint = {
    "sales": `/api/sales-orders/${item.billNo}`,
    "sales-out": `/api/sales-outs/${item.billNo}`,
    "purchase": `/api/purchase-orders/${item.billNo}`,
    "purchase-in": `/api/purchase-ins/${item.billNo}`,
    "material-issue": `/api/production/material-issues/${item.billNo}`,
    "product-in": `/api/production/product-ins/${item.billNo}`
  }[item.type];
  const detail = await get(endpoint);
  const doc = detail.document ?? detail.order;
  detailChecks.push({
    name: item.name,
    billNo: item.billNo,
    backendStatus: doc.status,
    lineCount: detail.lines.length,
    backendTotal: Number(doc.totalAmount ?? 0),
    lineSum: Number(detail.lines.reduce((sum, line) => sum + Number(line.priceTaxTotal ?? line.amount ?? Number(line.qty ?? 0) * Number(line.unitPrice ?? 0)), 0).toFixed(2))
  });
}

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  screenshots,
  stateCoverage: stateCoverage.map(([name, status, billNo]) => ({ name, status, billNo })),
  detailChecks
};
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
