import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { saveDocument, auditDocument } from "./helpers/document-actions.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a88-stock-count-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billNo = `PD-A88-${batch}`;
const gainBillNo = `PY-${billNo}`;
const lossBillNo = `PK-${billNo}`;
const billDate = "2026-06-26";
const productCode = "CP-001";
const warehouseCode = "CK-001";
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
  if (!response.ok) {
    throw new Error(`${options.method ?? "POST"} ${pathname} failed ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

function dbScalar(sql) {
  return execFileSync("docker", ["exec", "jdy-erp-postgres", "psql", "-U", "jdy", "-d", "jdy_erp", "-tA", "-c", sql], { encoding: "utf8" }).trim();
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

async function ensureStockAtLeast(minQty) {
  const before = stockQty();
  if (before >= minQty) return;
  const seedBillNo = `QTRK-A88-SEED-${batch}`;
  await api("/api/other-stock-ins/draft", {
    body: {
      billNo: seedBillNo,
      billDate,
      department: "仓储部",
      ownerName: "本地管理员",
      lines: [{ productCode, warehouseCode, qty: minQty - before, unitPrice, lineRemark: "A88盘点基线补库" }]
    }
  });
  await api(`/api/other-stock-ins/${encodeURIComponent(seedBillNo)}/audit`);
}

async function createAndAuditInFrontend(countedQty) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const screenshots = [];
  try {
    await page.goto(frontendUrl, { waitUntil: "networkidle" });
    await loginAsAdmin(page);
    await page.getByTestId("module-库存管理").hover();
    await page.getByTestId("entry-stock-count-form").click();
    await page.getByTestId("tab-stock-count-form").waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const input = document.querySelector('[data-testid="stock-count-bill-no"]');
      return input instanceof HTMLInputElement && input.value.length > 0;
    });
    await page.getByTestId("stock-count-bill-no").fill(billNo);
    await page.getByTestId("stock-count-bill-date").fill(billDate);
    await page.getByTestId("stock-count-department").fill("仓储部");
    await page.getByTestId("stock-count-line-product").fill(productCode);
    await page.getByTestId("stock-count-line-warehouse").fill(warehouseCode);
    await page.locator(".master-selector__menu button").filter({ hasText: warehouseCode }).first().click();
    await page.getByTestId("stock-count-line-qty").fill(String(countedQty));
    await page.getByTestId("stock-count-line-price").fill(String(unitPrice));
    await page.keyboard.press("Escape");
    await saveDocument(page);
    await auditDocument(page);
    await page.getByTestId("document-status").filter({ hasText: "已审核" }).waitFor({ state: "visible" });
    const formShot = `a88-stock-count-form-audited-${batch}.png`;
    await page.screenshot({ path: path.join(screenshotDir, formShot), fullPage: true });
    screenshots.push(`verification/playwright/${formShot}`);

    await page.getByTestId("module-库存管理").hover();
    await page.getByTestId("query-stock-count-form").click();
    await page.getByTestId("tab-stock-count-form-list").waitFor({ state: "visible" });
    await page.getByTestId("list-keyword").fill(billNo);
    await page.getByTestId("list-keyword").press("Enter");
    const listShot = `a88-stock-count-list-${batch}.png`;
    await page.screenshot({ path: path.join(screenshotDir, listShot), fullPage: true });
    screenshots.push(`verification/playwright/${listShot}`);
  } finally {
    await browser.close();
  }
  return screenshots;
}

await ensureStockAtLeast(5);
const beforeQty = stockQty();
const countedQty = beforeQty + 2;
const screenshots = await createAndAuditInFrontend(countedQty);
const afterAuditQty = stockQty();
const detail = await api(`/api/stock-counts/${encodeURIComponent(billNo)}`, { method: "GET" });
const gainDetail = await api(`/api/stock-count-gains/${encodeURIComponent(gainBillNo)}`, { method: "GET" });
const lossExists = dbNumber(`SELECT count(*) FROM stock_count_loss WHERE bill_no = '${lossBillNo}'`);
const financeCount = dbNumber(`SELECT (SELECT count(*) FROM ar_receivable WHERE source_bill_no IN ('${billNo}', '${gainBillNo}', '${lossBillNo}')) + (SELECT count(*) FROM ap_payable WHERE source_bill_no IN ('${billNo}', '${gainBillNo}', '${lossBillNo}'))`);

assert(detail.document.status === "AUDITED", `expected stock count AUDITED, got ${detail.document.status}`);
assert(Number(detail.lines[0].systemQty) === beforeQty, `system qty snapshot expected ${beforeQty}, got ${detail.lines[0].systemQty}`);
assert(Number(detail.lines[0].diffQty) === countedQty - beforeQty, `diff expected ${countedQty - beforeQty}, got ${detail.lines[0].diffQty}`);
assert(afterAuditQty === beforeQty, "stock count audit must not change stock");
assert(gainDetail.document.status === "DRAFT", `gain draft expected DRAFT, got ${gainDetail.document.status}`);
assert(Number(gainDetail.lines[0].qty) === 2, `gain qty expected 2, got ${gainDetail.lines[0].qty}`);
assert(lossExists === 0, "positive diff should not create loss draft");
assert(financeCount === 0, "stock count chain draft generation must not create finance documents");

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  billNo,
  gainBillNo,
  productCode,
  warehouseCode,
  beforeQty,
  countedQty,
  afterAuditQty,
  gainStatus: gainDetail.document.status,
  gainQty: Number(gainDetail.lines[0].qty),
  lossExists,
  financeCount,
  screenshots
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
