import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a87-other-stock-out-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billNo = `QTCK-A87-${batch}`;
const shortageBillNo = `QTCK-A87-SHORT-${batch}`;
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

function dbScalar(sql) {
  return execFileSync("docker", [
    "exec", "jdy-erp-postgres", "psql", "-U", "jdy", "-d", "jdy_erp", "-tA", "-c", sql
  ], { encoding: "utf8" }).trim();
}

function dbNumber(sql) {
  return Number(dbScalar(sql) || "0");
}

function stockQty() {
  return dbNumber(`
    SELECT COALESCE(b.qty_on_hand, 0)
    FROM md_product p
    JOIN md_warehouse w ON w.code = '${warehouseCode}'
    LEFT JOIN inv_stock_balance b ON b.product_id = p.id AND b.warehouse_id = w.id
    WHERE p.code = '${productCode}'
  `);
}

function txnCount(txnType, targetBillNo = billNo) {
  return dbNumber(`
    SELECT count(*)
    FROM inv_stock_txn t
    JOIN md_product p ON p.id = t.product_id
    JOIN md_warehouse w ON w.id = t.warehouse_id
    WHERE p.code = '${productCode}'
      AND w.code = '${warehouseCode}'
      AND t.txn_type = '${txnType}'
      AND t.source_bill_type = '${txnType}:${targetBillNo}'
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
    await page.getByTestId("entry-other-out-form").click();
    await page.getByTestId("tab-other-out-form").waitFor({ state: "visible" });
    await page.getByTestId("other-stock-out-bill-no").fill(billNo);
    await page.getByTestId("other-stock-out-bill-date").fill(billDate);
    await page.getByTestId("other-stock-out-department").fill("仓储部");
    await page.getByTestId("other-stock-out-line-product").fill(productCode);
    await page.getByTestId("other-stock-out-line-warehouse").fill(warehouseCode);
    await page.locator(".master-selector__menu button").filter({ hasText: warehouseCode }).first().click();
    await page.getByTestId("other-stock-out-line-qty").fill(String(qty));
    await page.getByTestId("other-stock-out-line-price").fill(String(unitPrice));
    await page.keyboard.press("Escape");
    await page.getByTestId("save-sales-order").click();
    await page.getByText("草稿已保存").waitFor({ state: "visible", timeout: 10000 });
    await page.getByTestId("audit-sales-order").click();
    await page.getByText("审核成功").waitFor({ state: "visible", timeout: 10000 });
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

const beforeQty = stockQty();
const screenshots = await createAndAuditInFrontend();
const detailAfterAudit = (await api(`/api/other-stock-outs/${encodeURIComponent(billNo)}`, { method: "GET" })).body;
const afterAuditQty = stockQty();
const auditTxnCount = txnCount("OTHER_STOCK_OUT");

assert(detailAfterAudit.document.status === "AUDITED", `expected AUDITED, got ${detailAfterAudit.document.status}`);
assert(afterAuditQty === beforeQty - qty, `stock should decrease from ${beforeQty} to ${beforeQty - qty}, got ${afterAuditQty}`);
assert(auditTxnCount >= 1, "audit should write negative inventory txn");

await api(`/api/other-stock-outs/${encodeURIComponent(billNo)}/reverse`);
const detailAfterReverse = (await api(`/api/other-stock-outs/${encodeURIComponent(billNo)}`, { method: "GET" })).body;
const afterReverseQty = stockQty();
const reverseTxnCount = txnCount("OTHER_STOCK_OUT_REVERSE");

assert(detailAfterReverse.document.status === "REVERSED", `expected REVERSED, got ${detailAfterReverse.document.status}`);
assert(afterReverseQty === beforeQty, `stock should return to ${beforeQty}, got ${afterReverseQty}`);
assert(reverseTxnCount >= 1, "reverse should write positive inventory txn");

await api("/api/other-stock-outs/draft", {
  body: {
    billNo: shortageBillNo,
    billDate,
    department: "仓储部",
    ownerName: "本地管理员",
    lines: [{ productCode, warehouseCode, qty: beforeQty + 100000, unitPrice, lineRemark: "库存不足断言" }]
  }
});
const beforeShortageAuditQty = stockQty();
const shortageResponse = await api(`/api/other-stock-outs/${encodeURIComponent(shortageBillNo)}/audit`, { expectFailure: true });
const afterShortageAuditQty = stockQty();

assert(shortageResponse.status === 409, `shortage audit should fail with 409, got ${shortageResponse.status}`);
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
  auditTxnCount,
  reverseTxnCount,
  screenshots
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
