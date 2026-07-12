import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { saveDocument, auditDocument } from "./helpers/document-actions.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a88-stock-count-loss-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
let billNo = "";
let shortageBillNo = "";
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

const sessionResponse = await api("/api/system/session", { method: "GET" });
const accountSetId = String(sessionResponse.body?.tenant?.id ?? "");
assert(/^[0-9a-f-]{36}$/i.test(accountSetId), `current session should expose account set id, got ${JSON.stringify(accountSetId)}`);
assert(sessionResponse.body?.tenant?.schemaName === "public", `A88 direct SQL expects the BLD-TEST public schema, got ${JSON.stringify(sessionResponse.body?.tenant?.schemaName)}`);

function dbNumber(sql) {
  return Number(execFileSync("docker", ["exec", "jdy-erp-postgres", "psql", "-U", "jdy", "-d", "jdy_erp", "-tA", "-c", sql], { encoding: "utf8" }).trim() || "0");
}

function stockState() {
  const raw = execFileSync("docker", ["exec", "jdy-erp-postgres", "psql", "-U", "jdy", "-d", "jdy_erp", "-tA", "-c", `SELECT COALESCE(b.qty_on_hand, 0) || '|' || COALESCE(b.qty_available, 0) || '|' || COALESCE(b.qty_reserved, 0) FROM md_product p JOIN md_warehouse w ON w.code = '${warehouseCode}' LEFT JOIN inv_stock_balance b ON b.product_id = p.id AND b.warehouse_id = w.id AND b.account_set_id = '${accountSetId}'::uuid WHERE p.code = '${productCode}'`], { encoding: "utf8" }).trim();
  const [onHand, available, reserved] = raw.split("|").map(Number);
  assert([onHand, available, reserved].every(Number.isFinite), `stock state should be numeric, got ${JSON.stringify(raw)}`);
  return { onHand, available, reserved };
}

function stockQty() {
  return stockState().onHand;
}

function txnCount(txnType, targetBillNo = billNo) {
  return dbNumber(`SELECT count(*) FROM inv_stock_txn t JOIN md_product p ON p.id = t.product_id JOIN md_warehouse w ON w.id = t.warehouse_id WHERE p.code = '${productCode}' AND w.code = '${warehouseCode}' AND t.account_set_id = '${accountSetId}'::uuid AND t.txn_type = '${txnType}' AND t.source_bill_type = '${txnType}:${targetBillNo}'`);
}

async function ensureStockAtLeast(minQty) {
  const before = stockState();
  if (before.available >= minQty) return;
  const seedDraft = await api("/api/other-stock-ins/draft", { body: { billNo: "", billDate, department: "仓储部", ownerName: "本地管理员", lines: [{ productCode, warehouseCode, qty: minQty - before.available, unitPrice, lineRemark: "A88盘亏基线补库" }] } });
  const seedBillNo = String(seedDraft.body?.billNo ?? "");
  assert(/^QTRK\d{6}$/.test(seedBillNo), `seed other stock in bill no should match QTRK######, got ${JSON.stringify(seedBillNo)}`);
  await api(`/api/other-stock-ins/${encodeURIComponent(seedBillNo)}/audit`);
  assert(stockState().available >= minQty, `seed should establish at least ${minQty} available stock`);
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
    const billNoInput = page.getByTestId("stock-count-loss-bill-no");
    assert(await billNoInput.inputValue() === "", "new stock count loss bill no should be blank");
    assert(!(await billNoInput.isEditable()), "new stock count loss bill no should be readonly");
    await page.getByTestId("stock-count-loss-bill-date").fill(billDate);
    await page.getByTestId("stock-count-loss-department").fill("仓储部");
    await page.getByTestId("stock-count-loss-line-product").fill(productCode);
    await page.getByTestId("stock-count-loss-line-warehouse").fill(warehouseCode);
    await page.locator(".master-selector__menu button").filter({ hasText: warehouseCode }).first().click();
    await page.getByTestId("stock-count-loss-line-qty").fill(String(qty));
    await page.getByTestId("stock-count-loss-line-price").fill(String(unitPrice));
    await page.keyboard.press("Escape");
    await saveDocument(page);
    await page.waitForFunction(() => {
      const input = document.querySelector('[data-testid="stock-count-loss-bill-no"]');
      return input instanceof HTMLInputElement && /^PK\d{6}$/.test(input.value);
    });
    billNo = await billNoInput.inputValue();
    assert(/^PK\d{6}$/.test(billNo), `saved stock count loss bill no should match PK######, got ${JSON.stringify(billNo)}`);
    await auditDocument(page);
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

const shortageState = stockState();
const shortageDraft = await api("/api/stock-count-losses/draft", { body: { billNo: "", billDate, department: "仓储部", ownerName: "本地管理员", lines: [{ productCode, warehouseCode, qty: Math.max(shortageState.onHand, shortageState.available) + 100000, unitPrice, lineRemark: "盘亏非负守卫断言" }] } });
shortageBillNo = String(shortageDraft.body?.billNo ?? "");
assert(/^PK\d{6}$/.test(shortageBillNo), `shortage stock count loss bill no should match PK######, got ${JSON.stringify(shortageBillNo)}`);
const beforeShortage = stockQty();
const shortageResponse = await api(`/api/stock-count-losses/${encodeURIComponent(shortageBillNo)}/audit`, { expectFailure: true });
const afterShortage = stockQty();
const shortageReason = String(shortageResponse.body?.reason ?? shortageResponse.body?.message ?? "");
const financeCount = dbNumber(`SELECT (SELECT count(*) FROM ar_receivable WHERE source_bill_no IN ('${billNo}', '${shortageBillNo}')) + (SELECT count(*) FROM ap_payable WHERE source_bill_no IN ('${billNo}', '${shortageBillNo}'))`);

assert(detailAfterAudit.document.status === "AUDITED", `expected AUDITED, got ${detailAfterAudit.document.status}`);
assert(afterAuditQty === beforeQty - qty, `stock should decrease to ${beforeQty - qty}, got ${afterAuditQty}`);
assert(txnCount("STOCK_COUNT_LOSS") === 1, "loss audit should write one stock txn");
assert(detailAfterReverse.document.status === "DRAFT", `expected DRAFT, got ${detailAfterReverse.document.status}`);
assert(afterReverseQty === beforeQty, `stock should return to ${beforeQty}, got ${afterReverseQty}`);
assert(txnCount("STOCK_COUNT_LOSS_REVERSE") === 1, "loss reverse should write one stock txn");
assert(shortageResponse.status === 409, `shortage audit should fail with 409, got ${shortageResponse.status}`);
assert(shortageReason === "库存不足，不能调整为负数", `shortage audit should report the formal inventory guard, got ${JSON.stringify(shortageReason)}`);
assert(afterShortage === beforeShortage, "shortage loss audit must not change stock");
assert(txnCount("STOCK_COUNT_LOSS", shortageBillNo) === 0, "shortage loss audit must not create txn");
assert(financeCount === 0, "stock count loss must not create finance documents");

const result = { batch, generatedAt: new Date().toISOString(), billNo, shortageBillNo, productCode, warehouseCode, qty, beforeQty, afterAuditQty, afterReverseQty, shortageStatus: shortageResponse.status, shortageReason, financeCount, screenshots };
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
