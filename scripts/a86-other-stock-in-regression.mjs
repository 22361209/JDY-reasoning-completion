import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { saveDocument, auditDocument } from "./helpers/document-actions.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a86-other-stock-in-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
let billNo = "";
const billDate = "2026-06-25";
const productCode = "CP-001";
const warehouseCode = "CK-001";
const qty = 7;
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
  if (!response.ok) {
    throw new Error(`${options.method ?? "POST"} ${pathname} failed ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

const session = await api("/api/system/session", { method: "GET" });
const accountSetId = String(session?.tenant?.id ?? "");
assert(/^[0-9a-f-]{36}$/i.test(accountSetId), `current session should expose account set id, got ${JSON.stringify(accountSetId)}`);
assert(session?.tenant?.schemaName === "public", `A86 direct SQL expects the BLD-TEST public schema, got ${JSON.stringify(session?.tenant?.schemaName)}`);

function dbScalar(sql) {
  const output = execFileSync("docker", [
    "exec",
    "jdy-erp-postgres",
    "psql",
    "-U",
    "jdy",
    "-d",
    "jdy_erp",
    "-tA",
    "-c",
    sql
  ], { encoding: "utf8" });
  return output.trim();
}

function dbNumber(sql) {
  const value = dbScalar(sql);
  return Number(value || "0");
}

function stockQty() {
  return dbNumber(`
    SELECT COALESCE(b.qty_on_hand, 0)
    FROM md_product p
    JOIN md_warehouse w ON w.code = '${warehouseCode}'
    LEFT JOIN inv_stock_balance b ON b.product_id = p.id AND b.warehouse_id = w.id AND b.account_set_id = '${accountSetId}'::uuid
    WHERE p.code = '${productCode}'
  `);
}

function txnCount(txnType) {
  return dbNumber(`
    SELECT count(*)
    FROM inv_stock_txn t
    JOIN md_product p ON p.id = t.product_id
    JOIN md_warehouse w ON w.id = t.warehouse_id
    WHERE p.code = '${productCode}'
      AND w.code = '${warehouseCode}'
      AND t.account_set_id = '${accountSetId}'::uuid
      AND t.txn_type = '${txnType}'
      AND t.source_bill_type = '${txnType}:${billNo}'
  `);
}

async function createAndAuditInFrontend() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const screenshots = [];
  try {
    await page.goto(frontendUrl, { waitUntil: "networkidle" });
    await loginAsAdmin(page);
    await page.getByTestId("module-库存管理").hover();
    await page.getByTestId("entry-other-in-form").click();
    await page.getByTestId("tab-other-in-form").waitFor({ state: "visible" });
    const billNoInput = page.getByTestId("other-stock-in-bill-no");
    assert(await billNoInput.inputValue() === "", "new other stock in bill no should be blank");
    assert(!(await billNoInput.isEditable()), "new other stock in bill no should be readonly");
    await page.getByTestId("other-stock-in-bill-date").fill(billDate);
    await page.getByTestId("other-stock-in-department").fill("仓储部");
    await page.getByTestId("other-stock-in-line-product").fill(productCode);
    await page.getByTestId("other-stock-in-line-warehouse").fill(warehouseCode);
    await page.locator(".master-selector__menu button").filter({ hasText: warehouseCode }).first().click();
    await page.getByTestId("other-stock-in-line-qty").fill(String(qty));
    await page.getByTestId("other-stock-in-line-price").fill(String(unitPrice));
    await page.keyboard.press("Escape");
    await saveDocument(page);
    await page.waitForFunction(() => {
      const input = document.querySelector('[data-testid="other-stock-in-bill-no"]');
      return input instanceof HTMLInputElement && /^QTRK\d{6}$/.test(input.value);
    });
    billNo = await billNoInput.inputValue();
    assert(/^QTRK\d{6}$/.test(billNo), `saved other stock in bill no should match QTRK######, got ${JSON.stringify(billNo)}`);
    await auditDocument(page);
    await page.getByTestId("document-status").filter({ hasText: "已审核" }).waitFor({ state: "visible" });
    await page.locator(".business-head h2").filter({ hasText: "其他入库单" }).click();
    const formShot = `a86-other-stock-in-form-audited-${batch}.png`;
    await page.screenshot({ path: path.join(screenshotDir, formShot), fullPage: true });
    screenshots.push(`verification/playwright/${formShot}`);

    await page.getByTestId("module-库存管理").hover();
    await page.getByTestId("query-other-in-form").click();
    await page.getByTestId("tab-other-in-form-list").waitFor({ state: "visible" });
    await page.getByTestId("tab-other-in-form-list").locator("span").click();
    await page.getByTestId("list-page-other-in-form-list").waitFor({ state: "visible" });
    await page.getByTestId("list-keyword").fill(billNo);
    await page.getByTestId("list-keyword").press("Enter");
    await page.getByText(billNo).waitFor({ state: "visible", timeout: 10000 });
    const listShot = `a86-other-stock-in-list-${batch}.png`;
    await page.screenshot({ path: path.join(screenshotDir, listShot), fullPage: true });
    screenshots.push(`verification/playwright/${listShot}`);
  } finally {
    await browser.close();
  }
  return screenshots;
}

const beforeQty = stockQty();
const screenshots = await createAndAuditInFrontend();
const detailAfterAudit = await api(`/api/other-stock-ins/${encodeURIComponent(billNo)}`, { method: "GET" });
const afterAuditQty = stockQty();
const auditTxnCount = txnCount("OTHER_STOCK_IN");

assert(detailAfterAudit.document.status === "AUDITED", `expected AUDITED, got ${detailAfterAudit.document.status}`);
assert(afterAuditQty === beforeQty + qty, `stock should increase from ${beforeQty} to ${beforeQty + qty}, got ${afterAuditQty}`);
assert(auditTxnCount === 1, `audit should write exactly one positive inventory txn, got ${auditTxnCount}`);

await api(`/api/other-stock-ins/${encodeURIComponent(billNo)}/reverse`);
const detailAfterReverse = await api(`/api/other-stock-ins/${encodeURIComponent(billNo)}`, { method: "GET" });
const afterReverseQty = stockQty();
const reverseTxnCount = txnCount("OTHER_STOCK_IN_REVERSE");

assert(detailAfterReverse.document.status === "DRAFT", `expected DRAFT, got ${detailAfterReverse.document.status}`);
assert(afterReverseQty === beforeQty, `stock should return to ${beforeQty}, got ${afterReverseQty}`);
assert(reverseTxnCount === 1, `reverse should write exactly one negative inventory txn, got ${reverseTxnCount}`);

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  billNo,
  productCode,
  warehouseCode,
  qty,
  beforeQty,
  afterAuditQty,
  afterReverseQty,
  auditTxnCount,
  reverseTxnCount,
  statuses: {
    afterAudit: detailAfterAudit.document.status,
    afterReverse: detailAfterReverse.document.status
  },
  screenshots
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
