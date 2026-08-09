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
let billNo = "";
let gainBillNo = "";
let lossBillNo = "";
let tabSwitchLookupCount = 0;
let multiLineErrorVerified = false;
let legacyHiddenPreferenceRecovered = false;
let malformedPreferenceRecovered = false;
let missingPreferenceRecovered = false;
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

async function assertNumericText(page, testId, expected, label) {
  await page.waitForFunction(({ targetTestId, targetValue }) => {
    const element = document.querySelector(`[data-testid="${targetTestId}"]`);
    if (!(element instanceof HTMLElement)) return false;
    const value = Number(element.innerText.replaceAll(",", "").trim());
    return Number.isFinite(value) && value === targetValue;
  }, { targetTestId: testId, targetValue: expected });
  const actualText = await page.getByTestId(testId).innerText();
  const actual = Number(actualText.replaceAll(",", "").trim());
  assert(Number.isFinite(actual) && actual === expected, `${label} expected ${expected}, got ${JSON.stringify(actualText)}`);
}

async function openStockCountForm(page) {
  await page.getByTestId("module-库存管理").hover();
  await page.getByTestId("entry-stock-count-form").click();
  await page.getByTestId("tab-stock-count-form").waitFor({ state: "visible" });
}

async function assertRequiredCountColumns(page, label) {
  for (const title of ["实盘数量", "系统库存", "差异"]) {
    await page.getByRole("columnheader", { name: new RegExp(title) }).waitFor({ state: "visible" });
  }
  await page.getByTestId("entry-column-settings").click();
  for (const title of ["实盘数量", "系统库存", "差异"]) {
    const checkbox = page.getByRole("checkbox", { name: title, exact: true });
    assert(await checkbox.isChecked(), `${label}: ${title} must be forced visible`);
    assert(await checkbox.isDisabled(), `${label}: ${title} visibility must be locked for auditability`);
  }
  await page.getByTestId("entry-column-settings-ok").click();
}

function isBookQuantityResponse(response, expectedStatus) {
  const url = new URL(response.url());
  return response.request().method() === "GET"
    && url.pathname === "/api/stock-counts/book-quantity"
    && url.searchParams.get("productCode") === productCode
    && url.searchParams.get("warehouseCode") === warehouseCode
    && (expectedStatus === undefined || response.status() === expectedStatus);
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
assert(session?.tenant?.schemaName === "public", `A88 direct SQL expects the BLD-TEST public schema, got ${JSON.stringify(session?.tenant?.schemaName)}`);

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
    LEFT JOIN inv_stock_balance b ON b.product_id = p.id AND b.warehouse_id = w.id AND b.account_set_id = '${accountSetId}'::uuid
    WHERE p.code = '${productCode}'
  `);
}

async function ensureStockAtLeast(minQty) {
  const before = stockQty();
  if (before >= minQty) return;
  const seedDraft = await api("/api/other-stock-ins/draft", {
    body: {
      billNo: "",
      billDate,
      department: "仓储部",
      ownerName: "本地管理员",
      lines: [{ productCode, warehouseCode, qty: minQty - before, unitPrice, lineRemark: "A88盘点基线补库" }]
    }
  });
  const seedBillNo = String(seedDraft.billNo ?? "");
  assert(/^QTRK\d{6}$/.test(seedBillNo), `seed other stock in bill no should match QTRK######, got ${JSON.stringify(seedBillNo)}`);
  await api(`/api/other-stock-ins/${encodeURIComponent(seedBillNo)}/audit`);
}

async function createAndAuditInFrontend(countedQty, expectedBookQty) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const screenshots = [];
  try {
    await page.addInitScript(() => {
      if (sessionStorage.getItem("a183-stock-count-preference-seeded") === "true") return;
      const orderedKeys = ["productCode", "productName", "spec", "unit", "netWeight", "grossWeight", "warehouse", "qty", "executedQty", "remainingQty", "unitPrice", "amount", "remark"];
      localStorage.setItem("jdy:entry-columns:stock-count", JSON.stringify(orderedKeys.map((key) => ({
        key,
        width: 104,
        visible: !["qty", "executedQty", "remainingQty"].includes(key),
        fixed: ""
      }))));
      sessionStorage.setItem("a183-stock-count-preference-seeded", "true");
    });
    await page.goto(frontendUrl, { waitUntil: "networkidle" });
    await loginAsAdmin(page);
    await openStockCountForm(page);
    await assertRequiredCountColumns(page, "legacy hidden stock-count preference");
    legacyHiddenPreferenceRecovered = true;
    const billNoInput = page.getByTestId("stock-count-bill-no");
    assert(await billNoInput.inputValue() === "", "new stock count bill no should be blank");
    assert(!(await billNoInput.isEditable()), "new stock count bill no should be readonly");
    await page.getByTestId("stock-count-bill-date").fill(billDate);
    await page.getByTestId("stock-count-department").fill("仓储部");
    await page.getByTestId("stock-count-line-product").fill(productCode);
    await page.getByTestId("stock-count-line-warehouse").fill("");
    await page.getByTestId("stock-count-line-warehouse-open-selector").click();
    await page.getByTestId("master-selector-source-selector-dialog").waitFor({ state: "visible" });
    assert(await page.getByTestId("master-selector-source-selector-search").inputValue() === "", "stock-count warehouse dialog must open without reusing the current line value as a filter");
    await page.getByTestId(`master-selector-source-line-${warehouseCode}`).waitFor({ state: "visible" });
    const bookQuantityResponse = page.waitForResponse((response) => isBookQuantityResponse(response));
    await page.getByTestId(`master-selector-source-line-${warehouseCode}`).click();
    const bookQuantityResult = await (await bookQuantityResponse).json();
    assert(Number(bookQuantityResult.bookQuantity) === expectedBookQty, `book quantity endpoint expected ${expectedBookQty}, got ${bookQuantityResult.bookQuantity}`);
    await assertNumericText(page, "stock-count-line-executed-qty", expectedBookQty, "visible book quantity");
    assert(await page.getByTestId("stock-count-line-executed-qty").locator("input").count() === 0, "system inventory must remain readonly");
    await page.getByTestId("stock-count-line-qty").fill(String(countedQty));
    await assertNumericText(page, "stock-count-line-remaining-qty", countedQty - expectedBookQty, "visible count difference");
    await page.getByTestId("stock-count-line-price").fill(String(unitPrice));

    let lookupMode = "pass";
    let delayedLookupOrdinal = 0;
    const lookupPattern = "**/api/stock-counts/book-quantity?**";
    const lookupRoute = async (route) => {
      if (lookupMode === "fail") {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ message: "A181账面数量模拟查询失败" })
        });
        return;
      }
      if (lookupMode === "delay") {
        delayedLookupOrdinal += 1;
        tabSwitchLookupCount += 1;
        if (delayedLookupOrdinal === 1) {
          await new Promise((resolve) => setTimeout(resolve, 750));
        }
      }
      await route.continue();
    };
    await page.route(lookupPattern, lookupRoute);

    lookupMode = "fail";
    const firstFailure = page.waitForResponse((response) => isBookQuantityResponse(response, 500));
    await page.getByTestId("stock-count-line-warehouse").fill("");
    await page.getByTestId("stock-count-line-warehouse").fill(warehouseCode);
    await firstFailure;
    await page.getByTestId("stock-count-line-insert").click();
    await page.getByTestId("stock-count-line-product-2").fill(productCode);
    const secondFailure = page.waitForResponse((response) => isBookQuantityResponse(response, 500));
    await page.getByTestId("stock-count-line-warehouse-2").fill(warehouseCode);
    await secondFailure;
    await page.getByTestId("form-message").filter({ hasText: "另有 1 行账面数量查询失败" }).waitFor({ state: "visible" });

    lookupMode = "pass";
    const secondRecovery = page.waitForResponse((response) => isBookQuantityResponse(response, 200));
    await page.getByTestId("stock-count-line-product-2").fill("");
    await page.getByTestId("stock-count-line-product-2").fill(productCode);
    await secondRecovery;
    await assertNumericText(page, "stock-count-line-executed-qty-2", expectedBookQty, "second-line recovered book quantity");
    await page.getByTestId("stock-count-line-qty-2").fill(String(countedQty));
    await assertNumericText(page, "stock-count-line-remaining-qty-2", countedQty - expectedBookQty, "second-line visible count difference");
    const remainingError = await page.getByTestId("form-message").textContent();
    assert(remainingError?.includes("A181账面数量模拟查询失败") && !remainingError.includes("另有"), `resolving one row must retain the other row error, got ${JSON.stringify(remainingError)}`);

    const firstRecovery = page.waitForResponse((response) => isBookQuantityResponse(response, 200));
    await page.getByTestId("stock-count-line-product").fill("");
    await page.getByTestId("stock-count-line-product").fill(productCode);
    await firstRecovery;
    await assertNumericText(page, "stock-count-line-executed-qty", expectedBookQty, "first-line recovered book quantity");
    await page.getByTestId("form-message").waitFor({ state: "hidden" });
    multiLineErrorVerified = true;
    await page.getByTestId("stock-count-entry-row").nth(1).hover();
    await page.getByTestId("stock-count-line-delete-2").click();

    await page.keyboard.press("Escape");
    await saveDocument(page);
    await page.waitForFunction(() => {
      const input = document.querySelector('[data-testid="stock-count-bill-no"]');
      return input instanceof HTMLInputElement && /^PD\d{6}$/.test(input.value);
    });
    billNo = await billNoInput.inputValue();
    assert(/^PD\d{6}$/.test(billNo), `saved stock count bill no should match PD######, got ${JSON.stringify(billNo)}`);

    lookupMode = "delay";
    delayedLookupOrdinal = 0;
    const pendingTabSwitchLookup = page.waitForRequest((request) =>
      request.method() === "GET" && request.url().includes("/api/stock-counts/book-quantity?")
    );
    await page.getByTestId("stock-count-line-warehouse").fill("");
    await page.getByTestId("stock-count-line-warehouse").fill(warehouseCode);
    await pendingTabSwitchLookup;
    await page.getByTestId("tab-home").click();
    await page.getByTestId("tab-stock-count-form").click();
    await assertRequiredCountColumns(page, "tab-remounted stock-count preference");
    await assertNumericText(page, "stock-count-line-executed-qty", expectedBookQty, "remounted book quantity");
    assert(tabSwitchLookupCount >= 2, `pending lookup must retry after tab remount, got ${tabSwitchLookupCount} requests`);
    lookupMode = "pass";
    await saveDocument(page);
    assert(await billNoInput.inputValue() === billNo, "race-regression resave must preserve the stock count bill number");

    const auditResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().endsWith(`/api/stock-counts/${encodeURIComponent(billNo)}/audit`)
    );
    await auditDocument(page);
    const auditResult = await (await auditResponsePromise).json();
    gainBillNo = String(auditResult.gainBillNo ?? "");
    lossBillNo = String(auditResult.lossBillNo ?? "");
    assert(gainBillNo === `PY-${billNo}`, `stock count gain bill no should derive from source, got ${JSON.stringify(gainBillNo)}`);
    assert(lossBillNo === `PK-${billNo}`, `stock count loss bill no should derive from source, got ${JSON.stringify(lossBillNo)}`);
    await page.getByTestId("document-status").filter({ hasText: "已审核" }).waitFor({ state: "visible" });
    const formShot = `a88-stock-count-form-audited-${batch}.png`;
    await page.screenshot({ path: path.join(screenshotDir, formShot), fullPage: true });
    screenshots.push(`verification/playwright/${formShot}`);

    await page.evaluate(() => localStorage.setItem("jdy:entry-columns:stock-count", "{malformed-json"));
    await page.reload({ waitUntil: "networkidle" });
    await openStockCountForm(page);
    await assertRequiredCountColumns(page, "malformed stock-count preference");
    malformedPreferenceRecovered = true;

    await page.evaluate(() => {
      localStorage.setItem("jdy:entry-columns:stock-count", JSON.stringify([
        null,
        { key: "productCode", width: 140, visible: true, fixed: "" },
        { key: "qty", width: 104, visible: "invalid", fixed: "" },
        { key: "remainingQty", width: 104, visible: false, fixed: "" }
      ]));
    });
    await page.reload({ waitUntil: "networkidle" });
    await openStockCountForm(page);
    await assertRequiredCountColumns(page, "missing-column stock-count preference");
    missingPreferenceRecovered = true;

    await page.getByTestId("module-库存管理").hover();
    await page.getByTestId("query-stock-count-form").click();
    await page.getByTestId("tab-stock-count-form-list").waitFor({ state: "visible" });
    await page.getByTestId("list-keyword").fill(billNo);
    await page.getByTestId("list-keyword").press("Enter");
    const listShot = `a88-stock-count-list-${batch}.png`;
    await page.screenshot({ path: path.join(screenshotDir, listShot), fullPage: true });
    screenshots.push(`verification/playwright/${listShot}`);
    await page.unroute(lookupPattern, lookupRoute);
  } finally {
    await browser.close();
  }
  return screenshots;
}

await ensureStockAtLeast(5);
const beforeQty = stockQty();
const countedQty = beforeQty + 2;
const screenshots = await createAndAuditInFrontend(countedQty, beforeQty);
const afterAuditQty = stockQty();
const detail = await api(`/api/stock-counts/${encodeURIComponent(billNo)}`, { method: "GET" });
const gainDetail = await api(`/api/stock-count-gains/${encodeURIComponent(gainBillNo)}`, { method: "GET" });
const lossExists = lossBillNo === "" ? 0 : dbNumber(`SELECT count(*) FROM stock_count_loss WHERE bill_no = '${lossBillNo}'`);
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
  tabSwitchLookupCount,
  multiLineErrorVerified,
  legacyHiddenPreferenceRecovered,
  malformedPreferenceRecovered,
  missingPreferenceRecovered,
  screenshots
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
