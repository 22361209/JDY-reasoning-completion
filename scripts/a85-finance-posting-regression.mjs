import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { createSalesOutDraftViaDeliveryNotice } from "./helpers/sales-delivery-notice-flow.mjs";

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

async function collectListRows(listKey, keywords) {
  const rowsByKey = new Map();
  for (const keyword of keywords) {
    const rows = (await getList(listKey, keyword)).rows ?? [];
    for (const row of rows) {
      rowsByKey.set(`${row.billNo}|${row.sourceBillNo ?? ""}`, row);
    }
  }
  return [...rowsByKey.values()];
}

function stableFinanceRows(rows) {
  return [...rows]
    .map((row) => Object.fromEntries(Object.entries(row).sort(([left], [right]) => left.localeCompare(right))))
    .sort((left, right) => `${left.billNo ?? ""}|${left.sourceBillNo ?? ""}`.localeCompare(`${right.billNo ?? ""}|${right.sourceBillNo ?? ""}`));
}

async function completeFinanceState(listKey) {
  const pageSize = 1000;
  const rows = [];
  let total = 0;
  for (let page = 1; page === 1 || rows.length < total; page += 1) {
    const search = new URLSearchParams({ keyword: "", status: "", page: String(page), pageSize: String(pageSize) });
    const data = await api(`/api/lists/${encodeURIComponent(listKey)}?${search.toString()}`, { method: "GET" });
    if (page === 1) {
      total = Number(data.total);
    } else {
      assert(Number(data.total) === total, `${listKey} total changed while taking a serial full-state snapshot`);
    }
    const pageRows = data.rows ?? [];
    assert(pageRows.length > 0 || rows.length === total, `${listKey} pagination ended before all ${total} rows were read`);
    rows.push(...pageRows);
  }
  assert(rows.length === total, `${listKey} full-state snapshot should include all rows, got ${rows.length}/${total}`);
  return { total, rows: stableFinanceRows(rows) };
}

function generatedBillNo(row, prefix, label) {
  const billNo = String(row?.billNo ?? "");
  if (!new RegExp(`^${prefix}\\d{6}$`).test(billNo)) {
    throw new Error(`${label} did not return a system ${prefix} bill number: ${JSON.stringify(row)}`);
  }
  return billNo;
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

function salesOutPayload() {
  return {
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

function purchaseInPayload() {
  return {
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

  const salesOutNos = [];
  for (const label of ["审核", "反审核", "红冲来源"]) {
    const orderNo = generatedBillNo(await post("/api/sales-orders/draft", salesOutPayload()), "XSDD", `A85销售订单${label}`);
    await post(`/api/sales-orders/${encodeURIComponent(orderNo)}/audit`);
    const flow = await createSalesOutDraftViaDeliveryNotice((pathname, body) => post(pathname, body), {
      ...salesOutPayload(),
      sourceOrderNo: orderNo
    });
    assert(/^FHTZD\d{6}$/.test(flow.noticeNo), `A85发货通知${label} should use a system bill number, got ${flow.noticeNo}`);
    assert(/^XSCKD\d{6}$/.test(flow.salesOutNo), `A85销售出库${label} should use a system bill number, got ${flow.salesOutNo}`);
    await post(`/api/sales-outs/${encodeURIComponent(flow.salesOutNo)}/audit`);
    salesOutNos.push(flow.salesOutNo);
  }
  const [salesOutAudited, salesOutReverse, salesOutRedSource] = salesOutNos;
  await post(`/api/sales-outs/${encodeURIComponent(salesOutReverse)}/reverse`);
  const salesFinanceBeforeRedDraft = await completeFinanceState("receivable-list");
  const salesOutRedDraft = await post(`/api/sales-outs/${encodeURIComponent(salesOutRedSource)}/red-reverse`, {
    billDate,
    ownerName: "本地管理员"
  });
  const salesOutRed = generatedBillNo(salesOutRedDraft, "XSCKD", "A85销售出库红冲");
  assert(/^XSCKD\d{6}$/.test(salesOutRed), `sales red bill no should be generated, got ${salesOutRed}`);
  assert(salesOutRedDraft.status === "DRAFT", `sales red bill should start as DRAFT, got ${salesOutRedDraft.status}`);
  const salesFinanceAfterRedDraft = await completeFinanceState("receivable-list");
  assert(
    JSON.stringify(salesFinanceAfterRedDraft) === JSON.stringify(salesFinanceBeforeRedDraft),
    "sales red draft must leave the complete receivable set and every existing row unchanged"
  );
  const salesRowsBeforeRedAudit = salesFinanceAfterRedDraft.rows;
  assert(!rowBySource(salesRowsBeforeRedAudit, salesOutRed), "sales red draft must not create receivable before audit");
  const salesOutRedAudited = await post(`/api/sales-outs/${encodeURIComponent(salesOutRed)}/audit`);
  assert(salesOutRedAudited.status === "AUDITED", `sales red bill should be AUDITED after audit, got ${salesOutRedAudited.status}`);

  const purchaseInNos = [];
  for (const label of ["审核", "反审核", "红冲来源"]) {
    const billNo = generatedBillNo(await post("/api/purchase-ins/draft", purchaseInPayload()), "CGRK", `A85采购入库${label}`);
    await post(`/api/purchase-ins/${encodeURIComponent(billNo)}/audit`);
    purchaseInNos.push(billNo);
  }
  const [purchaseInAudited, purchaseInReverse, purchaseInRedSource] = purchaseInNos;
  await post(`/api/purchase-ins/${encodeURIComponent(purchaseInReverse)}/reverse`);
  const purchaseFinanceBeforeRedDraft = await completeFinanceState("payable-list");
  const purchaseInRedDraft = await post(`/api/purchase-ins/${encodeURIComponent(purchaseInRedSource)}/red-reverse`, {
    billDate,
    ownerName: "本地管理员"
  });
  const purchaseInRed = generatedBillNo(purchaseInRedDraft, "CGRK", "A85采购入库红冲");
  assert(/^CGRK\d{6}$/.test(purchaseInRed), `purchase red bill no should be generated, got ${purchaseInRed}`);
  assert(purchaseInRedDraft.status === "DRAFT", `purchase red bill should start as DRAFT, got ${purchaseInRedDraft.status}`);
  const purchaseFinanceAfterRedDraft = await completeFinanceState("payable-list");
  assert(
    JSON.stringify(purchaseFinanceAfterRedDraft) === JSON.stringify(purchaseFinanceBeforeRedDraft),
    "purchase red draft must leave the complete payable set and every existing row unchanged"
  );
  const purchaseRowsBeforeRedAudit = purchaseFinanceAfterRedDraft.rows;
  assert(!rowBySource(purchaseRowsBeforeRedAudit, purchaseInRed), "purchase red draft must not create payable before audit");
  const purchaseInRedAudited = await post(`/api/purchase-ins/${encodeURIComponent(purchaseInRed)}/audit`);
  assert(purchaseInRedAudited.status === "AUDITED", `purchase red bill should be AUDITED after audit, got ${purchaseInRedAudited.status}`);

  return {
    salesOutAudited,
    salesOutReverse,
    salesOutRedSource,
    salesOutRed,
    purchaseInAudited,
    purchaseInReverse,
    purchaseInRedSource,
    purchaseInRed,
    redLifecycle: {
      salesOut: {
        billNo: salesOutRed,
        draftStatus: salesOutRedDraft.status,
        auditedStatus: salesOutRedAudited.status,
        financeRowCountBeforeAudit: salesFinanceAfterRedDraft.total,
        completeFinanceStateUnchangedBeforeAudit: true,
        matchingFinanceRowsBeforeAudit: salesRowsBeforeRedAudit.filter((row) => row.sourceBillNo === salesOutRed).length
      },
      purchaseIn: {
        billNo: purchaseInRed,
        draftStatus: purchaseInRedDraft.status,
        auditedStatus: purchaseInRedAudited.status,
        financeRowCountBeforeAudit: purchaseFinanceAfterRedDraft.total,
        completeFinanceStateUnchangedBeforeAudit: true,
        matchingFinanceRowsBeforeAudit: purchaseRowsBeforeRedAudit.filter((row) => row.sourceBillNo === purchaseInRed).length
      }
    },
    expectedReceivableAmount: 235.04,
    expectedPayableAmount: 370.64
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
  const manualReceipt = await request(`/api/finance/receivables/${encodeURIComponent(`YS-${data.salesOutAudited}`)}/receipt`, {
    body: {
      billNo: `SK-A85-${batch}`,
      date: billDate,
      amount: 1
    }
  });
  assert(manualReceipt.response.status === 409, `manual receipt bill no should be rejected, got ${manualReceipt.response.status}`);
  assert(manualReceipt.text.includes("单据编号只能由系统自动生成，不能手工指定"), `manual receipt bill no rejection should report the formal numbering reason: ${manualReceipt.text}`);
  const receipt = await post(`/api/finance/receivables/${encodeURIComponent(`YS-${data.salesOutAudited}`)}/receipt`, {
    date: billDate,
    amount: 50
  });
  const payment = await post(`/api/finance/payables/${encodeURIComponent(`YF-${data.purchaseInAudited}`)}/payment`, {
    date: billDate,
    amount: 60
  });
  assert(/^SKD\d{6}$/.test(String(receipt.receiptBillNo ?? "")), `receipt bill no should be generated, got ${JSON.stringify(receipt)}`);
  assert(/^FKD\d{6}$/.test(String(payment.paymentBillNo ?? "")), `payment bill no should be generated, got ${JSON.stringify(payment)}`);

  const receivables = await collectListRows("receivable-list", [
    `YS-${data.salesOutAudited}`,
    data.salesOutAudited,
    `YS-CX-${data.salesOutReverse}`,
    data.salesOutReverse,
    data.salesOutRed
  ]);
  const payables = await collectListRows("payable-list", [
    `YF-${data.purchaseInAudited}`,
    data.purchaseInAudited,
    `YF-CX-${data.purchaseInReverse}`,
    data.purchaseInReverse,
    data.purchaseInRed
  ]);
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

  return { receivables, payables, receiptBillNo: receipt.receiptBillNo, paymentBillNo: payment.paymentBillNo };
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
    await page.getByTestId("list-keyword").fill(`YS-${data.salesOutAudited}`);
    await page.getByTestId("list-keyword").press("Enter");
    await page.getByText(`YS-${data.salesOutAudited}`).waitFor({ state: "visible" });
    const receivableShot = `a85-receivable-list-${batch}.png`;
    await page.screenshot({ path: path.join(screenshotDir, receivableShot), fullPage: true });
    screenshots.push(`verification/playwright/${receivableShot}`);

    await page.getByTestId("module-应收应付").hover();
    await page.getByTestId("query-payable-list").click();
    await page.getByTestId("tab-payable-list").waitFor({ state: "visible" });
    await page.getByTestId("list-keyword").fill(`YF-${data.purchaseInAudited}`);
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
  settlementBills: { receiptBillNo: financeRows.receiptBillNo, paymentBillNo: financeRows.paymentBillNo },
  screenshots
};
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
