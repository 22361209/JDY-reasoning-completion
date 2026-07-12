import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { saveDocument, auditDocument } from "./helpers/document-actions.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a87-other-stock-out-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
let billNo = "";
let shortageBillNo = "";
const billDate = "2026-06-25";
const productCode = "CP-001";
const warehouseCode = "CK-001";
const qty = 3;
const unitPrice = 1;

await installApiSession(apiBase);
await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function api(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "POST",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  if (!response.ok && !options.expectFailure) {
    throw new Error(`${options.method ?? "POST"} ${pathname} failed ${response.status}: ${text}`);
  }
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const sessionResponse = await api("/api/system/session", { method: "GET" });
const accountSetId = String(sessionResponse.body?.tenant?.id ?? "");
assert(/^[0-9a-f-]{36}$/i.test(accountSetId), `current session should expose account set id, got ${JSON.stringify(accountSetId)}`);
assert(sessionResponse.body?.tenant?.schemaName === "public", `A87 direct SQL expects the BLD-TEST public schema, got ${JSON.stringify(sessionResponse.body?.tenant?.schemaName)}`);

function dbScalar(sql) {
  return execFileSync("docker", [
    "exec", "jdy-erp-postgres", "psql", "-U", "jdy", "-d", "jdy_erp", "-tA", "-c", sql
  ], { encoding: "utf8" }).trim();
}

function dbNumber(sql) {
  return Number(dbScalar(sql) || "0");
}

function stockState() {
  const raw = dbScalar(`
    SELECT COALESCE(b.qty_on_hand, 0) || '|' || COALESCE(b.qty_available, 0) || '|' || COALESCE(b.qty_reserved, 0)
    FROM md_product p
    JOIN md_warehouse w ON w.code = '${warehouseCode}'
    LEFT JOIN inv_stock_balance b ON b.product_id = p.id AND b.warehouse_id = w.id AND b.account_set_id = '${accountSetId}'::uuid
    WHERE p.code = '${productCode}'
  `);
  const [onHand, available, reserved] = raw.split("|").map(Number);
  assert([onHand, available, reserved].every(Number.isFinite), `stock state should be numeric, got ${JSON.stringify(raw)}`);
  return { onHand, available, reserved };
}

function stockQty() {
  return stockState().onHand;
}

function txnCount(txnType, targetBillNo = billNo) {
  return dbNumber(`
    SELECT count(*)
    FROM inv_stock_txn t
    JOIN md_product p ON p.id = t.product_id
    JOIN md_warehouse w ON w.id = t.warehouse_id
    WHERE p.code = '${productCode}'
      AND w.code = '${warehouseCode}'
      AND t.account_set_id = '${accountSetId}'::uuid
      AND t.txn_type = '${txnType}'
      AND t.source_bill_type = '${txnType}:${targetBillNo}'
  `);
}

async function ensureAvailableAtLeast(minQty) {
  const before = stockState();
  if (before.available >= minQty) return;
  await api("/api/inventory/adjustments", {
    body: {
      productCode,
      warehouseCode,
      qtyDelta: minQty - before.available,
      txnType: "A87_OTHER_STOCK_OUT_SEED",
      sourceBillType: `A87_OTHER_STOCK_OUT_SEED:${batch}`
    }
  });
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
    await page.getByTestId("entry-other-out-form").click();
    await page.getByTestId("tab-other-out-form").waitFor({ state: "visible" });
    const billNoInput = page.getByTestId("other-stock-out-bill-no");
    assert(await billNoInput.inputValue() === "", "new other stock out bill no should be blank");
    assert(!(await billNoInput.isEditable()), "new other stock out bill no should be readonly");
    await page.getByTestId("other-stock-out-bill-date").fill(billDate);
    await page.getByTestId("other-stock-out-department").fill("仓储部");
    await page.getByTestId("other-stock-out-line-product").fill(productCode);
    await page.getByTestId("other-stock-out-line-warehouse").fill(warehouseCode);
    await page.locator(".master-selector__menu button").filter({ hasText: warehouseCode }).first().click();
    await page.getByTestId("other-stock-out-line-qty").fill(String(qty));
    await page.getByTestId("other-stock-out-line-price").fill(String(unitPrice));
    await page.keyboard.press("Escape");
    await saveDocument(page);
    await page.waitForFunction(() => {
      const input = document.querySelector('[data-testid="other-stock-out-bill-no"]');
      return input instanceof HTMLInputElement && /^QTCK\d{6}$/.test(input.value);
    });
    billNo = await billNoInput.inputValue();
    assert(/^QTCK\d{6}$/.test(billNo), `saved other stock out bill no should match QTCK######, got ${JSON.stringify(billNo)}`);
    await auditDocument(page);
    await page.getByTestId("document-status").filter({ hasText: "已审核" }).waitFor({ state: "visible" });
    const formShot = `a87-other-stock-out-form-audited-${batch}.png`;
    await page.screenshot({ path: path.join(screenshotDir, formShot), fullPage: true });
    screenshots.push(`verification/playwright/${formShot}`);

    await page.getByTestId("module-库存管理").hover();
    await page.getByTestId("query-other-out-form").click();
    await page.getByTestId("tab-other-out-form-list").waitFor({ state: "visible" });
    await page.getByTestId("list-keyword").fill(billNo);
    await page.getByTestId("list-keyword").press("Enter");
    await page.getByText(billNo).waitFor({ state: "visible", timeout: 10000 });
    const listShot = `a87-other-stock-out-list-${batch}.png`;
    await page.screenshot({ path: path.join(screenshotDir, listShot), fullPage: true });
    screenshots.push(`verification/playwright/${listShot}`);
  } finally {
    await browser.close();
  }
  return screenshots;
}

await ensureAvailableAtLeast(qty + 1);
const beforeQty = stockQty();
const screenshots = await createAndAuditInFrontend();
const detailAfterAudit = (await api(`/api/other-stock-outs/${encodeURIComponent(billNo)}`, { method: "GET" })).body;
const afterAuditQty = stockQty();
const auditTxnCount = txnCount("OTHER_STOCK_OUT");

assert(detailAfterAudit.document.status === "AUDITED", `expected AUDITED, got ${detailAfterAudit.document.status}`);
assert(afterAuditQty === beforeQty - qty, `stock should decrease from ${beforeQty} to ${beforeQty - qty}, got ${afterAuditQty}`);
assert(auditTxnCount === 1, `audit should write exactly one negative inventory txn, got ${auditTxnCount}`);

await api(`/api/other-stock-outs/${encodeURIComponent(billNo)}/reverse`);
const detailAfterReverse = (await api(`/api/other-stock-outs/${encodeURIComponent(billNo)}`, { method: "GET" })).body;
const afterReverseQty = stockQty();
const reverseTxnCount = txnCount("OTHER_STOCK_OUT_REVERSE");

assert(detailAfterReverse.document.status === "DRAFT", `expected DRAFT, got ${detailAfterReverse.document.status}`);
assert(afterReverseQty === beforeQty, `stock should return to ${beforeQty}, got ${afterReverseQty}`);
assert(reverseTxnCount === 1, `reverse should write exactly one positive inventory txn, got ${reverseTxnCount}`);

const shortageState = stockState();
const shortageDraft = await api("/api/other-stock-outs/draft", {
  body: {
    billNo: "",
    billDate,
    department: "仓储部",
    ownerName: "本地管理员",
    lines: [{ productCode, warehouseCode, qty: Math.max(shortageState.onHand, shortageState.available) + 100000, unitPrice, lineRemark: "库存不足断言" }]
  }
});
shortageBillNo = String(shortageDraft.body?.billNo ?? "");
assert(/^QTCK\d{6}$/.test(shortageBillNo), `shortage other stock out bill no should match QTCK######, got ${JSON.stringify(shortageBillNo)}`);
const beforeShortageAuditQty = stockQty();
const shortageResponse = await api(`/api/other-stock-outs/${encodeURIComponent(shortageBillNo)}/audit`, { expectFailure: true });
const afterShortageAuditQty = stockQty();
const shortageReason = String(shortageResponse.body?.reason ?? shortageResponse.body?.message ?? "");

assert(shortageResponse.status === 409, `shortage audit should fail with 409, got ${shortageResponse.status}`);
assert(shortageReason === "库存不足，不能调整为负数", `shortage audit should report the formal inventory guard, got ${JSON.stringify(shortageReason)}`);
assert(afterShortageAuditQty === beforeShortageAuditQty, "shortage audit must not change stock");
assert(txnCount("OTHER_STOCK_OUT", shortageBillNo) === 0, "shortage audit must not create stock txn");

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  billNo,
  shortageBillNo,
  productCode,
  warehouseCode,
  qty,
  beforeQty,
  afterAuditQty,
  afterReverseQty,
  shortageStatus: shortageResponse.status,
  shortageReason,
  auditTxnCount,
  reverseTxnCount,
  screenshots
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
