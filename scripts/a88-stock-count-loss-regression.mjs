import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a88-stock-count-loss-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billNo = `PK-A88-${batch}`;
const shortageBillNo = `PK-A88-SHORT-${batch}`;
const billDate = "2026-06-26";
const productCode = "CP-001";
const warehouseCode = "CK-001";
const qty = 2;
const unitPrice = 1;

await installApiSession(apiBase);
await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function api(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "POST",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  if (!response.ok && !options.expectFailure) throw new Error(`${options.method ?? "POST"} ${pathname} failed ${response.status}: ${text}`);
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function dbNumber(sql) {
  return Number(execFileSync("docker", ["exec", "jdy-erp-postgres", "psql", "-U", "jdy", "-d", "jdy_erp", "-tA", "-c", sql], { encoding: "utf8" }).trim() || "0");
}

function stockQty() {
  return dbNumber(`SELECT COALESCE(b.qty_on_hand, 0) FROM md_product p JOIN md_warehouse w ON w.code = '${warehouseCode}' LEFT JOIN inv_stock_balance b ON b.product_id = p.id AND b.warehouse_id = w.id WHERE p.code = '${productCode}'`);
}

function txnCount(txnType, targetBillNo = billNo) {
  return dbNumber(`SELECT count(*) FROM inv_stock_txn t JOIN md_product p ON p.id = t.product_id JOIN md_warehouse w ON w.id = t.warehouse_id WHERE p.code = '${productCode}' AND w.code = '${warehouseCode}' AND t.txn_type = '${txnType}' AND t.source_bill_type = '${txnType}:${targetBillNo}'`);
}

async function ensureStockAtLeast(minQty) {
  const before = stockQty();
  if (before >= minQty) return;
  const seedBillNo = `QTRK-A88-LOSS-SEED-${batch}`;
  await api("/api/other-stock-ins/draft", { body: { billNo: seedBillNo, billDate, department: "仓储部", ownerName: "本地管理员", lines: [{ productCode, warehouseCode, qty: minQty - before, unitPrice, lineRemark: "A88盘亏基线补库" }] } });
  await api(`/api/other-stock-ins/${encodeURIComponent(seedBillNo)}/audit`);
}

async function createAndAuditInFrontend() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const screenshots = [];
  try {
    await page.goto(frontendUrl, { waitUntil: "networkidle" });
    await loginAsAdmin(page);
    await page.getByTestId("module-库存管理").hover();
    await page.getByTestId("entry-stock-count-loss-form").click();
    await page.getByTestId("tab-stock-count-loss-form").waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const input = document.querySelector('[data-testid="stock-count-loss-bill-no"]');
      return input instanceof HTMLInputElement && input.value.length > 0;
    });
    await page.getByTestId("stock-count-loss-bill-no").fill(billNo);
    await page.getByTestId("stock-count-loss-bill-date").fill(billDate);
    await page.getByTestId("stock-count-loss-department").fill("仓储部");
    await page.getByTestId("stock-count-loss-line-product").fill(productCode);
    await page.getByTestId("stock-count-loss-line-warehouse").fill(warehouseCode);
    await page.locator(".master-selector__menu button").filter({ hasText: warehouseCode }).first().click();
    await page.getByTestId("stock-count-loss-line-qty").fill(String(qty));
    await page.getByTestId("stock-count-loss-line-price").fill(String(unitPrice));
    await page.keyboard.press("Escape");
    await page.getByTestId("save-sales-order").click();
    await page.getByText("草稿已保存").waitFor({ state: "visible", timeout: 10000 });
    await page.getByTestId("audit-sales-order").click();
    await page.getByText("审核成功").waitFor({ state: "visible", timeout: 10000 });
    const formShot = `a88-stock-count-loss-form-audited-${batch}.png`;
    await page.screenshot({ path: path.join(screenshotDir, formShot), fullPage: true });
    screenshots.push(`verification/playwright/${formShot}`);
    await page.getByTestId("module-库存管理").hover();
    await page.getByTestId("query-stock-count-loss-form").click();
    await page.getByTestId("tab-stock-count-loss-form-list").waitFor({ state: "visible" });
    await page.getByTestId("list-keyword").fill(billNo);
    await page.getByTestId("list-keyword").press("Enter");
    const listShot = `a88-stock-count-loss-list-${batch}.png`;
    await page.screenshot({ path: path.join(screenshotDir, listShot), fullPage: true });
    screenshots.push(`verification/playwright/${listShot}`);
  } finally {
    await browser.close();
  }
  return screenshots;
}

await ensureStockAtLeast(qty + 1);
const beforeQty = stockQty();
const screenshots = await createAndAuditInFrontend();
const afterAuditQty = stockQty();
const detailAfterAudit = (await api(`/api/stock-count-losses/${encodeURIComponent(billNo)}`, { method: "GET" })).body;
await api(`/api/stock-count-losses/${encodeURIComponent(billNo)}/reverse`);
const afterReverseQty = stockQty();
const detailAfterReverse = (await api(`/api/stock-count-losses/${encodeURIComponent(billNo)}`, { method: "GET" })).body;

await api("/api/stock-count-losses/draft", { body: { billNo: shortageBillNo, billDate, department: "仓储部", ownerName: "本地管理员", lines: [{ productCode, warehouseCode, qty: stockQty() + 100000, unitPrice, lineRemark: "盘亏非负守卫断言" }] } });
const beforeShortage = stockQty();
const shortageResponse = await api(`/api/stock-count-losses/${encodeURIComponent(shortageBillNo)}/audit`, { expectFailure: true });
const afterShortage = stockQty();
const financeCount = dbNumber(`SELECT (SELECT count(*) FROM ar_receivable WHERE source_bill_no IN ('${billNo}', '${shortageBillNo}')) + (SELECT count(*) FROM ap_payable WHERE source_bill_no IN ('${billNo}', '${shortageBillNo}'))`);

assert(detailAfterAudit.document.status === "AUDITED", `expected AUDITED, got ${detailAfterAudit.document.status}`);
assert(afterAuditQty === beforeQty - qty, `stock should decrease to ${beforeQty - qty}, got ${afterAuditQty}`);
assert(txnCount("STOCK_COUNT_LOSS") === 1, "loss audit should write one stock txn");
assert(detailAfterReverse.document.status === "DRAFT", `expected DRAFT, got ${detailAfterReverse.document.status}`);
assert(afterReverseQty === beforeQty, `stock should return to ${beforeQty}, got ${afterReverseQty}`);
assert(txnCount("STOCK_COUNT_LOSS_REVERSE") === 1, "loss reverse should write one stock txn");
assert(shortageResponse.status === 409, `shortage audit should fail with 409, got ${shortageResponse.status}`);
assert(afterShortage === beforeShortage, "shortage loss audit must not change stock");
assert(txnCount("STOCK_COUNT_LOSS", shortageBillNo) === 0, "shortage loss audit must not create txn");
assert(financeCount === 0, "stock count loss must not create finance documents");

const result = { batch, generatedAt: new Date().toISOString(), billNo, shortageBillNo, productCode, warehouseCode, qty, beforeQty, afterAuditQty, afterReverseQty, shortageStatus: shortageResponse.status, financeCount, screenshots };
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
