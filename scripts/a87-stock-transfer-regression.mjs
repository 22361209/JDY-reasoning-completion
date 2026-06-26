import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a87-stock-transfer-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billNo = `DBD-A87-${batch}`;
const shortageBillNo = `DBD-A87-SHORT-${batch}`;
const billDate = "2026-06-25";
const productCode = "CP-001";
const sourceWarehouseCode = "CK-001";
const targetWarehouseCode = "CK-002";
const qty = 4;
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

function stockQty(warehouseCode) {
  return dbNumber(`
    SELECT COALESCE(b.qty_on_hand, 0)
    FROM md_product p
    JOIN md_warehouse w ON w.code = '${warehouseCode}'
    LEFT JOIN inv_stock_balance b ON b.product_id = p.id AND b.warehouse_id = w.id
    WHERE p.code = '${productCode}'
  `);
}

function txnCount(txnType, warehouseCode, targetBillNo = billNo) {
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

function financeCount(targetBillNo = billNo) {
  return dbNumber(`
    SELECT
      (SELECT count(*) FROM ar_receivable WHERE source_bill_no = '${targetBillNo}')
      +
      (SELECT count(*) FROM ap_payable WHERE source_bill_no = '${targetBillNo}')
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
    await page.getByTestId("entry-stock-transfer-form").click();
    await page.getByTestId("tab-stock-transfer-form").waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const input = document.querySelector('[data-testid="stock-transfer-bill-no"]');
      return input instanceof HTMLInputElement && input.value.length > 0;
    });
    await page.getByTestId("stock-transfer-bill-no").fill(billNo);
    await page.getByTestId("stock-transfer-bill-date").fill(billDate);
    await page.getByTestId("stock-transfer-department").fill("仓储部");
    await page.getByTestId("stock-transfer-line-product").fill(productCode);
    await page.getByTestId("stock-transfer-line-warehouse").fill(sourceWarehouseCode);
    await page.locator(".master-selector__menu button").filter({ hasText: sourceWarehouseCode }).first().click();
    await page.getByTestId("stock-transfer-line-target-warehouse").fill(targetWarehouseCode);
    await page.locator(".master-selector__menu button").filter({ hasText: targetWarehouseCode }).first().click();
    await page.getByTestId("stock-transfer-line-qty").fill(String(qty));
    await page.getByTestId("stock-transfer-line-price").fill(String(unitPrice));
    await page.keyboard.press("Escape");
    await page.getByTestId("save-sales-order").click();
    await page.getByText("草稿已保存").waitFor({ state: "visible", timeout: 10000 });
    await page.getByTestId("audit-sales-order").click();
    await page.getByText("审核成功").waitFor({ state: "visible", timeout: 10000 });
    await page.getByTestId("document-status").filter({ hasText: "已审核" }).waitFor({ state: "visible" });
    const formShot = `a87-stock-transfer-form-audited-${batch}.png`;
    await page.screenshot({ path: path.join(screenshotDir, formShot), fullPage: true });
    screenshots.push(`verification/playwright/${formShot}`);

    await page.getByTestId("module-库存管理").hover();
    await page.getByTestId("query-stock-transfer-form").click();
    await page.getByTestId("tab-stock-transfer-form-list").waitFor({ state: "visible" });
    await page.getByTestId("list-keyword").fill(billNo);
    await page.getByTestId("list-keyword").press("Enter");
    await page.getByText(billNo).waitFor({ state: "visible", timeout: 10000 });
    const listShot = `a87-stock-transfer-list-${batch}.png`;
    await page.screenshot({ path: path.join(screenshotDir, listShot), fullPage: true });
    screenshots.push(`verification/playwright/${listShot}`);
  } finally {
    await browser.close();
  }
  return screenshots;
}

const beforeSourceQty = stockQty(sourceWarehouseCode);
const beforeTargetQty = stockQty(targetWarehouseCode);
const screenshots = await createAndAuditInFrontend();
const detailAfterAudit = (await api(`/api/stock-transfers/${encodeURIComponent(billNo)}`, { method: "GET" })).body;
const afterAuditSourceQty = stockQty(sourceWarehouseCode);
const afterAuditTargetQty = stockQty(targetWarehouseCode);
const outTxnCount = txnCount("STOCK_TRANSFER_OUT", sourceWarehouseCode);
const inTxnCount = txnCount("STOCK_TRANSFER_IN", targetWarehouseCode);

assert(detailAfterAudit.document.status === "AUDITED", `expected AUDITED, got ${detailAfterAudit.document.status}`);
assert(afterAuditSourceQty === beforeSourceQty - qty, `source stock should decrease to ${beforeSourceQty - qty}, got ${afterAuditSourceQty}`);
assert(afterAuditTargetQty === beforeTargetQty + qty, `target stock should increase to ${beforeTargetQty + qty}, got ${afterAuditTargetQty}`);
assert(outTxnCount === 1, `source leg should write one txn, got ${outTxnCount}`);
assert(inTxnCount === 1, `target leg should write one txn, got ${inTxnCount}`);
assert(financeCount() === 0, "stock transfer must not create finance documents");

await api(`/api/stock-transfers/${encodeURIComponent(billNo)}/reverse`);
const detailAfterReverse = (await api(`/api/stock-transfers/${encodeURIComponent(billNo)}`, { method: "GET" })).body;
const afterReverseSourceQty = stockQty(sourceWarehouseCode);
const afterReverseTargetQty = stockQty(targetWarehouseCode);
const inReverseTxnCount = txnCount("STOCK_TRANSFER_IN_REVERSE", targetWarehouseCode);
const outReverseTxnCount = txnCount("STOCK_TRANSFER_OUT_REVERSE", sourceWarehouseCode);

assert(detailAfterReverse.document.status === "DRAFT", `expected DRAFT, got ${detailAfterReverse.document.status}`);
assert(afterReverseSourceQty === beforeSourceQty, `source stock should return to ${beforeSourceQty}, got ${afterReverseSourceQty}`);
assert(afterReverseTargetQty === beforeTargetQty, `target stock should return to ${beforeTargetQty}, got ${afterReverseTargetQty}`);
assert(inReverseTxnCount === 1, `target reverse leg should write one txn, got ${inReverseTxnCount}`);
assert(outReverseTxnCount === 1, `source reverse leg should write one txn, got ${outReverseTxnCount}`);

await api("/api/stock-transfers/draft", {
  body: {
    billNo: shortageBillNo,
    billDate,
    department: "仓储部",
    ownerName: "本地管理员",
    lines: [{
      productCode,
      warehouseCode: sourceWarehouseCode,
      targetWarehouseCode,
      qty: beforeSourceQty + 100000,
      unitPrice,
      lineRemark: "源仓不足断言"
    }]
  }
});
const sourceBeforeShortage = stockQty(sourceWarehouseCode);
const targetBeforeShortage = stockQty(targetWarehouseCode);
const shortageResponse = await api(`/api/stock-transfers/${encodeURIComponent(shortageBillNo)}/audit`, { expectFailure: true });
const sourceAfterShortage = stockQty(sourceWarehouseCode);
const targetAfterShortage = stockQty(targetWarehouseCode);

assert(shortageResponse.status === 409, `shortage audit should fail with 409, got ${shortageResponse.status}`);
assert(sourceAfterShortage === sourceBeforeShortage, "shortage audit must not change source stock");
assert(targetAfterShortage === targetBeforeShortage, "shortage audit must not change target stock");
assert(txnCount("STOCK_TRANSFER_OUT", sourceWarehouseCode, shortageBillNo) === 0, "shortage audit must not create source leg");
assert(txnCount("STOCK_TRANSFER_IN", targetWarehouseCode, shortageBillNo) === 0, "shortage audit must not create target leg");
assert(financeCount(shortageBillNo) === 0, "failed stock transfer must not create finance documents");

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  billNo,
  shortageBillNo,
  productCode,
  sourceWarehouseCode,
  targetWarehouseCode,
  qty,
  beforeSourceQty,
  beforeTargetQty,
  afterAuditSourceQty,
  afterAuditTargetQty,
  afterReverseSourceQty,
  afterReverseTargetQty,
  shortageStatus: shortageResponse.status,
  outTxnCount,
  inTxnCount,
  inReverseTxnCount,
  outReverseTxnCount,
  screenshots
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
