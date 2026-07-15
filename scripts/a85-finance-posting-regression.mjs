import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
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
const cleanupFixture = {
  accountCode: "",
  accountCreated: false,
  receiptBillNo: "",
  receiptAudited: false,
  paymentBillNo: "",
  paymentAudited: false
};

await installApiSession(apiBase);
await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function dbScalar(sql) {
  return execFileSync(
    "docker",
    ["exec", "jdy-erp-postgres", "psql", "-X", "-U", "jdy", "-d", "jdy_erp", "-v", "ON_ERROR_STOP=1", "-tAq", "-c", sql],
    { encoding: "utf8" }
  ).trim();
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

async function ensureCnySettlementAccount() {
  let rows = (await getList("financial-account-settlement-selector", "")).rows ?? [];
  let account = rows.find((row) => row.currency === "CNY");
  if (account?.id) return { account, created: false };

  const code = `A85-CNY-${batch}`;
  await post("/api/master-data/financialAccount", {
    code,
    name: `A85 回归现金账户 ${batch}`,
    accountType: "CASH",
    currency: "CNY",
    remark: "A85 正式收付款自包含夹具",
    status: "启用"
  });
  cleanupFixture.accountCode = code;
  cleanupFixture.accountCreated = true;
  await post(`/api/master-data/financialAccount/${encodeURIComponent(code)}/audit`, {});
  rows = (await getList("financial-account-settlement-selector", code)).rows ?? [];
  account = rows.find((row) => row.code === code && row.currency === "CNY");
  assert(account?.id, `A85 self-seeded audited CNY account must enter settlement selector: ${JSON.stringify(rows)}`);
  return { account, created: true };
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
    currency: "CNY",
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
    currency: "CNY",
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
  const arBillNo = `YS-${data.salesOutAudited}`;
  const apBillNo = `YF-${data.purchaseInAudited}`;
  const beforeRetired = {
    receivables: await completeFinanceState("receivable-list"),
    payables: await completeFinanceState("payable-list"),
    receipts: await completeFinanceState("ar-receipt-form-list"),
    payments: await completeFinanceState("ap-payment-form-list")
  };
  const successLogCount = async (action) => {
    const search = new URLSearchParams({ keyword: "", action, page: "1", pageSize: "1" });
    const rows = await api(`/api/lists/operation-log-list?${search}`, { method: "GET" });
    return Number(rows.total);
  };
  const oldLogBaseline = { receive: await successLogCount("RECEIVE"), pay: await successLogCount("PAY") };
  const retiredReceipt = await request(`/api/finance/receivables/${encodeURIComponent(arBillNo)}/receipt`, {
    body: { billNo: `SK-A85-${batch}`, date: billDate, amount: 1, currency: "CNY" }
  });
  const retiredPayment = await request(`/api/finance/payables/${encodeURIComponent(apBillNo)}/payment`, {
    body: { billNo: `FK-A85-${batch}`, date: billDate, amount: 1, currency: "CNY" }
  });
  assert(retiredReceipt.response.status === 410, `retired receipt endpoint should return 410, got ${retiredReceipt.response.status}`);
  assert(retiredPayment.response.status === 410, `retired payment endpoint should return 410, got ${retiredPayment.response.status}`);
  assert(retiredReceipt.text.includes("/api/finance/receipts/draft"), `retired receipt should point to formal draft endpoint: ${retiredReceipt.text}`);
  assert(retiredPayment.text.includes("/api/finance/payments/draft"), `retired payment should point to formal draft endpoint: ${retiredPayment.text}`);
  const afterRetired = {
    receivables: await completeFinanceState("receivable-list"),
    payables: await completeFinanceState("payable-list"),
    receipts: await completeFinanceState("ar-receipt-form-list"),
    payments: await completeFinanceState("ap-payment-form-list")
  };
  assert(JSON.stringify(afterRetired) === JSON.stringify(beforeRetired), "retired receipt/payment endpoints must leave all finance business facts unchanged");
  assert(await successLogCount("RECEIVE") === oldLogBaseline.receive && await successLogCount("PAY") === oldLogBaseline.pay, "retired endpoints must not create legacy RECEIVE/PAY success logs");

  const accountFixture = await ensureCnySettlementAccount();
  const cnyAccount = accountFixture.account;
  assert(!Object.prototype.hasOwnProperty.call(cnyAccount, "accountNo") && !Object.prototype.hasOwnProperty.call(cnyAccount, "accountHolder"), "settlement selector must not expose account number or holder");
  const paymentMethod = cnyAccount.accountType === "CASH" ? "CASH" : "BANK_TRANSFER";
  const arSources = (await getList("ar-receivable-settlement-source-selector", arBillNo)).rows ?? [];
  const apSources = (await getList("ap-payable-settlement-source-selector", apBillNo)).rows ?? [];
  const arSource = arSources.find((row) => row.billNo === arBillNo);
  const apSource = apSources.find((row) => row.billNo === apBillNo);
  assert(arSource?.id && arSource.currency === "CNY", `formal receipt source must be explicit CNY: ${JSON.stringify(arSources)}`);
  assert(apSource?.id && apSource.currency === "CNY", `formal payment source must be explicit CNY: ${JSON.stringify(apSources)}`);

  const formalPayload = (partyId, sourceId, amount, label) => ({
    partyId,
    billDate,
    currency: "CNY",
    amount,
    remark: `A85 ${label} ${batch}`,
    fundLines: [{ lineNo: 1, accountId: cnyAccount.id, paymentMethod, amount, fee: 0, transactionNo: `A85-${batch}-${label}`, remark: "A85 formal fund" }],
    allocations: [{ lineNo: 1, sourceId, settlementAmount: amount, remark: "A85 formal allocation" }]
  });
  const receipt = await post("/api/finance/receipts/draft", formalPayload(arSource.partyId, arSource.id, 50, "receipt"));
  cleanupFixture.receiptBillNo = String(receipt.billNo ?? "");
  const payment = await post("/api/finance/payments/draft", formalPayload(apSource.partyId, apSource.id, 60, "payment"));
  cleanupFixture.paymentBillNo = String(payment.billNo ?? "");
  assert(/^SKD\d{6}$/.test(String(receipt.billNo ?? "")) && receipt.status === "DRAFT" && receipt.currency === "CNY", `formal receipt draft should be generated in CNY, got ${JSON.stringify(receipt)}`);
  assert(/^FKD\d{6}$/.test(String(payment.billNo ?? "")) && payment.status === "DRAFT" && payment.currency === "CNY", `formal payment draft should be generated in CNY, got ${JSON.stringify(payment)}`);
  await post(`/api/finance/receipts/${encodeURIComponent(receipt.billNo)}/audit`);
  cleanupFixture.receiptAudited = true;
  await post(`/api/finance/payments/${encodeURIComponent(payment.billNo)}/audit`);
  cleanupFixture.paymentAudited = true;

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

  return {
    receivables,
    payables,
    receiptBillNo: receipt.billNo,
    paymentBillNo: payment.billNo,
    settlementAccount: { code: cnyAccount.code, created: accountFixture.created },
    retiredStatuses: [retiredReceipt.response.status, retiredPayment.response.status]
  };
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
    await page.getByTestId("module-应收应付").click();
    await page.getByTestId("entry-receivable-detail").click();
    await page.getByTestId("tab-receivable-detail").waitFor({ state: "visible" });
    await page.getByTestId("report-date-from").fill(billDate);
    await page.getByTestId("report-date-to").fill(billDate);
    await page.getByTestId("report-keyword").fill(`YS-${data.salesOutAudited}`);
    await page.getByTestId("report-query").click();
    await page.getByText(`YS-${data.salesOutAudited}`).first().waitFor({ state: "visible" });
    const receivableShot = `a85-receivable-list-${batch}.png`;
    await page.screenshot({ path: path.join(screenshotDir, receivableShot), fullPage: true });
    screenshots.push(`verification/playwright/${receivableShot}`);

    await page.getByTestId("module-应收应付").click();
    await page.getByTestId("entry-payable-detail").click();
    await page.getByTestId("tab-payable-detail").waitFor({ state: "visible" });
    await page.getByTestId("report-date-from").fill(billDate);
    await page.getByTestId("report-date-to").fill(billDate);
    await page.getByTestId("report-keyword").fill(`YF-${data.purchaseInAudited}`);
    await page.getByTestId("report-query").click();
    await page.getByText(`YF-${data.purchaseInAudited}`).first().waitFor({ state: "visible" });
    const payableShot = `a85-payable-list-${batch}.png`;
    await page.screenshot({ path: path.join(screenshotDir, payableShot), fullPage: true });
    screenshots.push(`verification/playwright/${payableShot}`);
  } finally {
    await browser.close();
  }
  return screenshots;
}

async function cleanupSettlementFixtures() {
  const cleanup = { attempted: true, remaining: null, cleanupError: "" };
  const errors = [];
  for (const fixture of [
    { collection: "receipts", billNo: cleanupFixture.receiptBillNo, audited: cleanupFixture.receiptAudited },
    { collection: "payments", billNo: cleanupFixture.paymentBillNo, audited: cleanupFixture.paymentAudited }
  ]) {
    if (!fixture.billNo) continue;
    if (fixture.audited) {
      try {
        await post(`/api/finance/${fixture.collection}/${encodeURIComponent(fixture.billNo)}/reverse`, {});
      } catch (error) {
        errors.push(`reverse ${fixture.billNo}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      await api(`/api/finance/${fixture.collection}/${encodeURIComponent(fixture.billNo)}`, { method: "DELETE" });
    } catch (error) {
      errors.push(`delete ${fixture.billNo}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const exactTargets = [cleanupFixture.accountCode, cleanupFixture.receiptBillNo, cleanupFixture.paymentBillNo].filter(Boolean);
  if (exactTargets.length > 0) {
    try {
      const targetSql = exactTargets.map(sqlLiteral).join(", ");
      dbScalar(`DELETE FROM public.sys_operation_log WHERE target_no IN (${targetSql})`);
    } catch (error) {
      errors.push(`delete exact fixture logs: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (cleanupFixture.accountCreated && cleanupFixture.accountCode) {
    try {
      dbScalar(`DELETE FROM public.md_financial_account WHERE code = ${sqlLiteral(cleanupFixture.accountCode)}`);
    } catch (error) {
      errors.push(`delete account ${cleanupFixture.accountCode}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    const targetFilter = exactTargets.length > 0
      ? `target_no IN (${exactTargets.map(sqlLiteral).join(", ")})`
      : "FALSE";
    cleanup.remaining = {
      account: cleanupFixture.accountCreated && cleanupFixture.accountCode
        ? Number(dbScalar(`SELECT count(*) FROM public.md_financial_account WHERE code = ${sqlLiteral(cleanupFixture.accountCode)}`))
        : 0,
      receipt: cleanupFixture.receiptBillNo
        ? Number(dbScalar(`SELECT count(*) FROM public.ar_receipt WHERE bill_no = ${sqlLiteral(cleanupFixture.receiptBillNo)}`))
        : 0,
      payment: cleanupFixture.paymentBillNo
        ? Number(dbScalar(`SELECT count(*) FROM public.ap_payment WHERE bill_no = ${sqlLiteral(cleanupFixture.paymentBillNo)}`))
        : 0,
      logs: Number(dbScalar(`SELECT count(*) FROM public.sys_operation_log WHERE ${targetFilter}`))
    };
    if (Object.values(cleanup.remaining).some((value) => value !== 0)) {
      errors.push(`fixture residue remains: ${JSON.stringify(cleanup.remaining)}`);
    }
  } catch (error) {
    errors.push(`verify cleanup: ${error instanceof Error ? error.message : String(error)}`);
  }
  cleanup.cleanupError = errors.join(" | ");
  return cleanup;
}

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  ok: false,
  data: null,
  retiredEndpoints: null,
  receivableBills: [],
  payableBills: [],
  settlementBills: null,
  screenshots: [],
  cleanup: { attempted: false, remaining: null, cleanupError: "" },
  failure: null
};
let runError = null;
try {
  const data = await createFinanceData();
  const retiredEndpoints = await assertRetiredEndpoints(data);
  const financeRows = await assertFinanceRows(data);
  await assertFrontendHasNoManualOrderGeneration();
  const screenshots = await captureFinanceLists(data);
  Object.assign(result, {
    data,
    retiredEndpoints,
    receivableBills: financeRows.receivables.map((row) => ({ billNo: row.billNo, sourceBillNo: row.sourceBillNo, amount: row.amount, status: row.status })),
    payableBills: financeRows.payables.map((row) => ({ billNo: row.billNo, sourceBillNo: row.sourceBillNo, amount: row.amount, status: row.status })),
    settlementBills: { receiptBillNo: financeRows.receiptBillNo, paymentBillNo: financeRows.paymentBillNo, account: financeRows.settlementAccount },
    screenshots
  });
} catch (error) {
  runError = error;
  result.failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) };
} finally {
  result.cleanup = await cleanupSettlementFixtures();
  result.ok = runError === null && result.cleanup.cleanupError === "";
  await writeFile(resultPath, JSON.stringify(result, null, 2));
}

if (runError) throw runError;
assert(result.cleanup.cleanupError === "", `A85 cleanup must be residue-free: ${result.cleanup.cleanupError}`);
console.log(JSON.stringify(result, null, 2));
