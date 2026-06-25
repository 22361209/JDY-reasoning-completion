import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a85-finance-posting-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-25";

await installApiSession(apiBase);
await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function request(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "POST",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let body = null;
  if (text) {
    body = JSON.parse(text);
  }
  return { response, body, text };
}

async function api(pathname, options = {}) {
  const result = await request(pathname, options);
  if (!result.response.ok) {
    throw new Error(`${options.method ?? "POST"} ${pathname} failed ${result.response.status}: ${result.text}`);
  }
  return result.body;
}

async function post(pathname, body) {
  return api(pathname, { method: "POST", body });
}

async function getList(listKey, keyword = "") {
  const search = new URLSearchParams({ keyword, status: "", page: "1", pageSize: "50" });
  return api(`/api/lists/${encodeURIComponent(listKey)}?${search.toString()}`, { method: "GET" });
}

function amountOf(row) {
  return Number(String(row.amount).replace(/,/g, ""));
}

function rowByBill(rows, billNo) {
  return rows.find((row) => row.billNo === billNo);
}

function rowBySource(rows, sourceBillNo) {
  return rows.find((row) => row.sourceBillNo === sourceBillNo);
}

async function seedStock() {
  for (const productCode of ["CP-001", "PJ-014"]) {
    for (const warehouseCode of ["CK-001", "CK-002"]) {
      await post("/api/inventory/adjustments", {
        productCode,
        warehouseCode,
        qtyDelta: 500,
        txnType: "A85_REGRESSION_IN",
        sourceBillType: `A85_REGRESSION:${batch}`
      });
    }
  }
}

function salesOutPayload(billNo) {
  return {
    billNo,
    customerCode: "KH-001",
    billDate,
    department: "销售部",
    ownerName: "本地管理员",
    lines: [
      { productCode: "CP-001", warehouseCode: "CK-001", qty: 2, unitPrice: 86 },
      { productCode: "PJ-014", warehouseCode: "CK-002", qty: 3, unitPrice: 12 }
    ]
  };
}

function purchaseInPayload(billNo) {
  return {
    billNo,
    supplierCode: "GYS-001",
    billDate,
    department: "采购部",
    ownerName: "本地管理员",
    lines: [
      { productCode: "CP-001", warehouseCode: "CK-001", qty: 4, unitPrice: 72 },
      { productCode: "PJ-014", warehouseCode: "CK-002", qty: 5, unitPrice: 8 }
    ]
  };
}

async function createFinanceData() {
  await seedStock();

  const salesOutAudited = `XSCK-A85-A-${batch}`;
  const salesOutReverse = `XSCK-A85-R-${batch}`;
  const salesOutRedSource = `XSCK-A85-RS-${batch}`;
  const salesOutRed = `XSCK-A85-HC-${batch}`;
  for (const billNo of [salesOutAudited, salesOutReverse, salesOutRedSource]) {
    await post("/api/sales-outs/draft", salesOutPayload(billNo));
    await post(`/api/sales-outs/${encodeURIComponent(billNo)}/audit`);
  }
  await post(`/api/sales-outs/${encodeURIComponent(salesOutReverse)}/reverse`);
  await post(`/api/sales-outs/${encodeURIComponent(salesOutRedSource)}/red-reverse`, {
    redBillNo: salesOutRed,
    billDate,
    ownerName: "本地管理员"
  });

  const purchaseInAudited = `CGRK-A85-A-${batch}`;
  const purchaseInReverse = `CGRK-A85-R-${batch}`;
  const purchaseInRedSource = `CGRK-A85-RS-${batch}`;
  const purchaseInRed = `CGRK-A85-HC-${batch}`;
  for (const billNo of [purchaseInAudited, purchaseInReverse, purchaseInRedSource]) {
    await post("/api/purchase-ins/draft", purchaseInPayload(billNo));
    await post(`/api/purchase-ins/${encodeURIComponent(billNo)}/audit`);
  }
  await post(`/api/purchase-ins/${encodeURIComponent(purchaseInReverse)}/reverse`);
  await post(`/api/purchase-ins/${encodeURIComponent(purchaseInRedSource)}/red-reverse`, {
    redBillNo: purchaseInRed,
    billDate,
    ownerName: "本地管理员"
  });

  return {
    salesOutAudited,
    salesOutReverse,
    salesOutRedSource,
    salesOutRed,
    purchaseInAudited,
    purchaseInReverse,
    purchaseInRedSource,
    purchaseInRed,
    expectedReceivableAmount: 208,
    expectedPayableAmount: 328
  };
}

async function assertRetiredEndpoints(data) {
  const oldReceivable = await request(`/api/finance/receivables/from-sales-order/${encodeURIComponent(data.salesOutAudited)}`);
  const oldPayable = await request(`/api/finance/payables/from-purchase-order/${encodeURIComponent(data.purchaseInAudited)}`);
  assert(oldReceivable.response.status === 404 || oldReceivable.response.status === 405, `old receivable endpoint should be retired, got ${oldReceivable.response.status}`);
  assert(oldPayable.response.status === 404 || oldPayable.response.status === 405, `old payable endpoint should be retired, got ${oldPayable.response.status}`);
  return {
    receivableFromSalesOrderStatus: oldReceivable.response.status,
    payableFromPurchaseOrderStatus: oldPayable.response.status
  };
}

async function assertFinanceRows(data) {
  await post(`/api/finance/receivables/${encodeURIComponent(`YS-${data.salesOutAudited}`)}/receipt`, {
    billNo: `SK-A85-${batch}`,
    date: billDate,
    amount: 50
  });
  await post(`/api/finance/payables/${encodeURIComponent(`YF-${data.purchaseInAudited}`)}/payment`, {
    billNo: `FK-A85-${batch}`,
    date: billDate,
    amount: 60
  });

  const receivables = (await getList("receivable-list", "A85")).rows;
  const payables = (await getList("payable-list", "A85")).rows;
  const auditedAr = rowByBill(receivables, `YS-${data.salesOutAudited}`);
  const reversedAr = rowByBill(receivables, `YS-CX-${data.salesOutReverse}`);
  const redAr = rowBySource(receivables, data.salesOutRed);
  const auditedAp = rowByBill(payables, `YF-${data.purchaseInAudited}`);
  const reversedAp = rowByBill(payables, `YF-CX-${data.purchaseInReverse}`);
  const redAp = rowBySource(payables, data.purchaseInRed);

  assert(auditedAr, "audited sales out should create receivable");
  assert(auditedAr.sourceBillNo === data.salesOutAudited, `receivable source should be sales out bill, got ${auditedAr.sourceBillNo}`);
  assert(amountOf(auditedAr) === data.expectedReceivableAmount, `receivable amount expected ${data.expectedReceivableAmount}, got ${auditedAr.amount}`);
  assert(auditedAr.status === "部分核销", `receipt should settle automatic receivable to partial status, got ${auditedAr.status}`);
  assert(reversedAr && amountOf(reversedAr) === -data.expectedReceivableAmount, "sales out reverse should create negative receivable reversal");
  assert(redAr && amountOf(redAr) === -data.expectedReceivableAmount, "sales out red reverse should create negative receivable");

  assert(auditedAp, "audited purchase in should create payable");
  assert(auditedAp.sourceBillNo === data.purchaseInAudited, `payable source should be purchase in bill, got ${auditedAp.sourceBillNo}`);
  assert(amountOf(auditedAp) === data.expectedPayableAmount, `payable amount expected ${data.expectedPayableAmount}, got ${auditedAp.amount}`);
  assert(auditedAp.status === "部分核销", `payment should settle automatic payable to partial status, got ${auditedAp.status}`);
  assert(reversedAp && amountOf(reversedAp) === -data.expectedPayableAmount, "purchase in reverse should create negative payable reversal");
  assert(redAp && amountOf(redAp) === -data.expectedPayableAmount, "purchase in red reverse should create negative payable");

  return { receivables, payables };
}

async function assertFrontendHasNoManualOrderGeneration() {
  const dataList = await readFile(path.join(rootDir, "frontend/src/components/DataListPage.vue"), "utf8");
  assert(!dataList.includes("销售订单生成应收"), "frontend should not mention sales order generated receivable");
  assert(!dataList.includes("采购订单生成应付"), "frontend should not mention purchase order generated payable");
  const allFrontendText = await readFile(path.join(rootDir, "frontend/src/modules/catalog.ts"), "utf8");
  assert(!allFrontendText.includes("从订单生成应收"), "frontend catalog should not contain manual receivable generation");
  assert(!allFrontendText.includes("从订单生成应付"), "frontend catalog should not contain manual payable generation");
}

async function captureFinanceLists(data) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const screenshots = [];
  try {
    await page.goto(frontendUrl, { waitUntil: "networkidle" });
    await loginAsAdmin(page);
    await page.getByTestId("module-应收应付").hover();
    await page.getByTestId("query-receivable-list").click();
    await page.getByTestId("tab-receivable-list").waitFor({ state: "visible" });
    await page.getByTestId("list-keyword").fill(data.salesOutAudited);
    await page.getByTestId("list-keyword").press("Enter");
    await page.getByText(`YS-${data.salesOutAudited}`).waitFor({ state: "visible" });
    const receivableShot = `a85-receivable-list-${batch}.png`;
    await page.screenshot({ path: path.join(screenshotDir, receivableShot), fullPage: true });
    screenshots.push(`verification/playwright/${receivableShot}`);

    await page.getByTestId("module-应收应付").hover();
    await page.getByTestId("query-payable-list").click();
    await page.getByTestId("tab-payable-list").waitFor({ state: "visible" });
    await page.getByTestId("list-keyword").fill(data.purchaseInAudited);
    await page.getByTestId("list-keyword").press("Enter");
    await page.getByText(`YF-${data.purchaseInAudited}`).waitFor({ state: "visible" });
    const payableShot = `a85-payable-list-${batch}.png`;
    await page.screenshot({ path: path.join(screenshotDir, payableShot), fullPage: true });
    screenshots.push(`verification/playwright/${payableShot}`);
  } finally {
    await browser.close();
  }
  return screenshots;
}

const data = await createFinanceData();
const retiredEndpoints = await assertRetiredEndpoints(data);
const financeRows = await assertFinanceRows(data);
await assertFrontendHasNoManualOrderGeneration();
const screenshots = await captureFinanceLists(data);

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  data,
  retiredEndpoints,
  receivableBills: financeRows.receivables.map((row) => ({ billNo: row.billNo, sourceBillNo: row.sourceBillNo, amount: row.amount, status: row.status })),
  payableBills: financeRows.payables.map((row) => ({ billNo: row.billNo, sourceBillNo: row.sourceBillNo, amount: row.amount, status: row.status })),
  screenshots
};
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
