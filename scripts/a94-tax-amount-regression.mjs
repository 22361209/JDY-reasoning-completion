import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { salesOutPayloadViaDeliveryNotice } from "./helpers/sales-delivery-notice-flow.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a94-tax-amount-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-26";

await installApiSession(apiBase);
await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function money(value) {
  return Number(Number(value).toFixed(2));
}

function lineTax(qty, unitPrice, taxRate, inclusive) {
  const gross = qty * unitPrice;
  if (inclusive) {
    const priceTaxTotal = money(gross);
    const amount = money(gross / (1 + taxRate / 100));
    return { amount, taxAmount: money(priceTaxTotal - amount), priceTaxTotal };
  }
  const amount = money(gross);
  const taxAmount = money(amount * taxRate / 100);
  return { amount, taxAmount, priceTaxTotal: money(amount + taxAmount) };
}

async function api(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "POST",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${options.method ?? "POST"} ${pathname} failed ${response.status}: ${text}`);
  }
  return data;
}

async function post(pathname, body) {
  return api(pathname, { method: "POST", body });
}

async function getList(listKey, keyword) {
  const search = new URLSearchParams({ keyword, status: "", page: "1", pageSize: "50" });
  return api(`/api/lists/${encodeURIComponent(listKey)}?${search.toString()}`, { method: "GET" });
}

async function seedStock() {
  for (const productCode of ["CP-001", "PJ-014"]) {
    for (const warehouseCode of ["CK-001", "CK-002"]) {
      await post("/api/inventory/adjustments", {
        productCode,
        warehouseCode,
        qtyDelta: 800,
        txnType: "A94_TAX_IN",
        sourceBillType: `A94_TAX:${batch}`
      });
    }
  }
}

const salesLines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 2, unitPrice: 100, taxRate: 13, lineRemark: "13%" },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 3, unitPrice: 50, taxRate: 9, lineRemark: "9%" }
];
const salesExpected = salesLines.map((line) => lineTax(line.qty, line.unitPrice, line.taxRate, false));
const salesTotal = money(salesExpected.reduce((sum, line) => sum + line.priceTaxTotal, 0));

const purchaseLines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 4, unitPrice: 113, taxRate: 13, lineRemark: "含税13%" },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 2, unitPrice: 109, taxRate: 9, lineRemark: "含税9%" }
];
const purchaseExpected = purchaseLines.map((line) => lineTax(line.qty, line.unitPrice, line.taxRate, true));
const purchaseTotal = money(purchaseExpected.reduce((sum, line) => sum + line.priceTaxTotal, 0));

await seedStock();

const salesOutNo = `XSCK-A94-${batch}`;
const salesOutPayload = {
  billNo: salesOutNo,
  customerCode: "KH-001",
  billDate,
  department: "销售部",
  ownerName: "本地管理员",
  isTaxInclusive: false,
  lines: salesLines
};
const salesFlow = salesOutPayloadViaDeliveryNotice(salesOutPayload, `FHTZ-A94-${batch}`);
await post("/api/delivery-notices/draft", salesFlow.noticePayload);
await post(`/api/delivery-notices/${encodeURIComponent(salesFlow.noticeNo)}/audit`);
await post("/api/sales-outs/draft", salesFlow.outPayload);
await post(`/api/sales-outs/${encodeURIComponent(salesOutNo)}/audit`);
const salesOutDetail = await api(`/api/sales-outs/${encodeURIComponent(salesOutNo)}`, { method: "GET" });
assert(salesOutDetail.document.isTaxInclusive === false, "sales out should save as tax exclusive");
assert(Number(salesOutDetail.document.totalAmount) === salesTotal, `sales out total expected ${salesTotal}, got ${salesOutDetail.document.totalAmount}`);
salesOutDetail.lines.forEach((line, index) => {
  const expected = salesExpected[index];
  assert(Number(line.taxRate) === salesLines[index].taxRate, `sales line ${index + 1} tax rate mismatch`);
  assert(Number(line.amount) === expected.amount, `sales line ${index + 1} amount expected ${expected.amount}, got ${line.amount}`);
  assert(Number(line.taxAmount) === expected.taxAmount, `sales line ${index + 1} tax expected ${expected.taxAmount}, got ${line.taxAmount}`);
  assert(Number(line.priceTaxTotal) === expected.priceTaxTotal, `sales line ${index + 1} total expected ${expected.priceTaxTotal}, got ${line.priceTaxTotal}`);
});

const purchaseInNo = `CGRK-A94-${batch}`;
await post("/api/purchase-ins/draft", {
  billNo: purchaseInNo,
  supplierCode: "GYS-001",
  billDate,
  department: "采购部",
  ownerName: "本地管理员",
  isTaxInclusive: true,
  lines: purchaseLines
});
await post(`/api/purchase-ins/${encodeURIComponent(purchaseInNo)}/audit`);
const purchaseInDetail = await api(`/api/purchase-ins/${encodeURIComponent(purchaseInNo)}`, { method: "GET" });
assert(purchaseInDetail.document.isTaxInclusive === true, "purchase in should save as tax inclusive");
assert(Number(purchaseInDetail.document.totalAmount) === purchaseTotal, `purchase in total expected ${purchaseTotal}, got ${purchaseInDetail.document.totalAmount}`);
purchaseInDetail.lines.forEach((line, index) => {
  const expected = purchaseExpected[index];
  assert(Number(line.amount) === expected.amount, `purchase line ${index + 1} amount expected ${expected.amount}, got ${line.amount}`);
  assert(Number(line.taxAmount) === expected.taxAmount, `purchase line ${index + 1} tax expected ${expected.taxAmount}, got ${line.taxAmount}`);
  assert(Number(line.priceTaxTotal) === expected.priceTaxTotal, `purchase line ${index + 1} total expected ${expected.priceTaxTotal}, got ${line.priceTaxTotal}`);
});

const receivables = (await getList("receivable-list", salesOutNo)).rows;
const payables = (await getList("payable-list", purchaseInNo)).rows;
const receivable = receivables.find((row) => row.sourceBillNo === salesOutNo);
const payable = payables.find((row) => row.sourceBillNo === purchaseInNo);
assert(receivable && Number(receivable.amount) === salesTotal, `receivable should use tax total ${salesTotal}, got ${receivable?.amount}`);
assert(payable && Number(payable.amount) === purchaseTotal, `payable should use tax total ${purchaseTotal}, got ${payable?.amount}`);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const screenshots = [];
try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("query-sales-out-form").click();
  await page.getByTestId("tab-sales-out-form-list").waitFor({ state: "visible" });
  await page.getByTestId("list-keyword").fill(salesOutNo);
  await page.getByTestId("list-query").click();
  await page.getByTestId(`open-document-${salesOutNo}`).waitFor({ state: "visible", timeout: 10000 });
  await page.getByTestId(`open-document-${salesOutNo}`).click();
  await page.getByTestId("sales-out-line-tax-rate").waitFor({ state: "visible" });
  await page.waitForFunction((billNo) => {
    const input = document.querySelector('[data-testid="sales-out-bill-no"]');
    return input instanceof HTMLInputElement && input.value === billNo;
  }, salesOutNo);
  assert((await page.getByTestId("sales-out-tax-mode").inputValue()) === "net", "sales out UI should show tax exclusive");
  assert((await page.getByTestId("sales-out-line-tax-rate").inputValue()) === "13", "sales out first tax rate should display");
  assert((await page.getByTestId("sales-out-line-tax-amount-2").innerText()).trim() === salesExpected[1].taxAmount.toFixed(2), "sales out second tax amount should display");
  assert((await page.getByTestId("document-total-amount").innerText()).trim() === salesTotal.toFixed(2), "sales out UI total should be tax total");
  const salesShot = `a94-sales-tax-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, salesShot), fullPage: true });
  screenshots.push(`verification/playwright/${salesShot}`);

  await page.getByTestId("module-采购管理").hover();
  await page.getByTestId("query-purchase-in-form").click();
  await page.getByTestId("tab-purchase-in-form-list").waitFor({ state: "visible" });
  await page.getByTestId("list-keyword").fill(purchaseInNo);
  await page.getByTestId("list-query").click();
  await page.getByTestId(`open-document-${purchaseInNo}`).waitFor({ state: "visible", timeout: 10000 });
  await page.getByTestId(`open-document-${purchaseInNo}`).click();
  await page.getByTestId("purchase-in-line-price-tax-total").waitFor({ state: "visible" });
  await page.waitForFunction((billNo) => {
    const input = document.querySelector('[data-testid="purchase-in-bill-no"]');
    return input instanceof HTMLInputElement && input.value === billNo;
  }, purchaseInNo);
  assert((await page.getByTestId("purchase-in-tax-mode").inputValue()) === "tax", "purchase in UI should show tax inclusive");
  assert((await page.getByTestId("purchase-in-line-amount").innerText()).trim() === purchaseExpected[0].amount.toFixed(2), "purchase inclusive net amount should display");
  assert((await page.getByTestId("document-total-amount").innerText()).trim() === purchaseTotal.toFixed(2), "purchase UI total should be tax total");
  const purchaseShot = `a94-purchase-tax-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, purchaseShot), fullPage: true });
  screenshots.push(`verification/playwright/${purchaseShot}`);
} finally {
  await browser.close();
}

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  salesOutNo,
  purchaseInNo,
  salesExpected,
  salesTotal,
  purchaseExpected,
  purchaseTotal,
  receivable: { billNo: receivable.billNo, sourceBillNo: receivable.sourceBillNo, amount: receivable.amount },
  payable: { billNo: payable.billNo, sourceBillNo: payable.sourceBillNo, amount: payable.amount },
  screenshots
};
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
