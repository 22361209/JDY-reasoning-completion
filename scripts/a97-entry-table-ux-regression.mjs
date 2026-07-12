import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { clickNewDocument, openSalesOutSourceSelector } from "./helpers/document-actions.mjs";
import { addEntryLineBelow } from "./helpers/entry-table-actions.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a97-entry-table-ux-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);

await installApiSession(apiBase);
await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function generatedBillNo(row, prefix, label) {
  const value = String(row?.billNo ?? "");
  assert(new RegExp(`^${prefix}\\d{6}$`).test(value), `${label} should return a system bill number, got ${JSON.stringify(row)}`);
  return value;
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

async function createAuditedOrder() {
  const lines = [
    { productCode: "CP-001", warehouseCode: "CK-001", qty: 3, unitPrice: 86, lineRemark: `A97 first ${batch}`, planDeliveryDate: "2026-07-03" },
    { productCode: "PJ-014", warehouseCode: "CK-002", qty: 2, unitPrice: 12, lineRemark: `A97 second ${batch}`, planDeliveryDate: "2026-07-04" }
  ];
  for (const line of lines) {
    await api("/api/inventory/adjustments", {
      body: {
        productCode: line.productCode,
        warehouseCode: line.warehouseCode,
        qtyDelta: 100,
        txnType: "A97_SOURCE_SELECTOR_IN",
        sourceBillType: `A97:${batch}`
      }
    });
  }
  const savedOrder = await api("/api/sales-orders/draft", {
    body: {
      billNo: null,
      customerCode: "KH-001",
      billDate: "2026-06-26",
      department: "销售部",
      ownerName: "本地管理员",
      remark: `A97 source ${batch}`,
      lines
    }
  });
  const billNo = generatedBillNo(savedOrder, "XSDD", "A97 sales order");
  await api(`/api/sales-orders/${encodeURIComponent(billNo)}/audit`);
  const savedNotice = await api("/api/delivery-notices/draft", {
    body: {
      billNo: null,
      sourceOrderNo: billNo,
      customerCode: "KH-001",
      billDate: "2026-06-26",
      department: "销售部",
      ownerName: "本地管理员",
      remark: `A97 notice ${batch}`,
      lines: lines.map((line, index) => ({ ...line, sourceOrderNo: billNo, sourceLineNo: index + 1 }))
    }
  });
  const noticeNo = generatedBillNo(savedNotice, "FHTZD", "A97 delivery notice");
  await api(`/api/delivery-notices/${encodeURIComponent(noticeNo)}/audit`);
  return { orderNo: billNo, noticeNo };
}

async function dragHorizontally(page, locator, deltaX) {
  const box = await locator.boundingBox();
  assert(box, "drag target should have a bounding box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + deltaX, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
}

async function waitForBoundingBox(locator, message) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    const box = await locator.boundingBox();
    if (box && box.width > 0 && box.height > 0) {
      return box;
    }
    await locator.page().waitForTimeout(100);
  }
  throw new Error(message);
}

const source = await createAuditedOrder();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);

  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("entry-sales-out-form").click();
  await page.getByTestId("sales-out-party-code").waitFor({ state: "visible" });
  await clickNewDocument(page);
  await page.getByTestId("sales-out-party-code").fill("KH-001");

  const remarkTag = await page.getByTestId("sales-out-remark").evaluate((node) => node.tagName.toLowerCase());
  const remarkResize = await page.getByTestId("sales-out-remark").evaluate((node) => getComputedStyle(node).resize);
  assert(remarkTag === "textarea", `document remark should be textarea, got ${remarkTag}`);
  assert(remarkResize.includes("vertical"), `document remark should resize vertically, got ${remarkResize}`);

  const entryScroll = await page.locator(".entry-table").evaluate((node) => ({
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
    overflowX: getComputedStyle(node).overflowX
  }));
  assert(entryScroll.scrollWidth > entryScroll.clientWidth, `entry table should have horizontal scroll: ${JSON.stringify(entryScroll)}`);
  assert(["auto", "scroll"].includes(entryScroll.overflowX), `entry table overflow-x should scroll, got ${entryScroll.overflowX}`);

  await page.getByTestId("entry-column-settings").click();
  await page.getByTestId("entry-column-settings-dialog").waitFor({ state: "visible" });
  await page.locator(".column-setting-row").filter({ hasText: "备注" }).locator('input[type="checkbox"]').uncheck();
  await page.getByTestId("entry-column-settings-ok").click();
  await page.getByTestId("sales-out-line-remark").waitFor({ state: "detached" });

  await page.getByTestId("sales-out-line-product").fill("CP-001");
  await page.getByTestId("sales-out-line-warehouse").fill("CK-001");
  await page.getByTestId("sales-out-line-qty").fill("1");
  await addEntryLineBelow(page, "sales-out");
  await page.getByTestId("sales-out-line-product-2").fill("PJ-014");
  await page.getByTestId("sales-out-line-warehouse-2").fill("CK-002");
  await page.getByTestId("sales-out-line-qty-2").fill("1");

  await page.getByTestId("entry-column-filter-productCode").click();
  await page.getByTestId("entry-column-filter-dialog").waitFor({ state: "visible" });
  await page.getByTestId("column-filter-input").fill("CP-001");
  await page.getByTestId("column-filter-ok").click();
  const hiddenRows = await page.locator('[data-testid="sales-out-entry-row"]').evaluateAll((rows) => rows.filter((row) => getComputedStyle(row).display === "none").length);
  assert(hiddenRows >= 1, "entry column filter should hide nonmatching rows");

  const productCellBefore = await page.getByTestId("sales-out-line-product").locator("..").boundingBox();
  await dragHorizontally(page, page.getByTestId("entry-column-resize-productCode"), 80);
  const productCellAfter = await page.getByTestId("sales-out-line-product").locator("..").boundingBox();
  assert(productCellBefore && productCellAfter && productCellAfter.width > productCellBefore.width + 30, "entry column width drag should widen product column");

  await openSalesOutSourceSelector(page);
  await page.getByTestId("sales-out-source-selector-search").fill(source.noticeNo);
  await page.getByTestId("sales-out-source-selector-query").click();
  await page.locator(".source-selector-table tbody tr", { hasText: source.noticeNo }).first().waitFor({ state: "visible" });
  const sourceTableScroll = await page.locator(".source-selector-table").evaluate((node) => ({
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
    overflowX: getComputedStyle(node).overflowX
  }));
  const sourceTableFrameScroll = await page.getByTestId("sales-out-source-selector-table-core").evaluate((node) => ({
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
    overflowX: getComputedStyle(node).overflowX
  }));
  assert(sourceTableFrameScroll.scrollWidth > sourceTableFrameScroll.clientWidth, `source selector table core should have horizontal scroll: ${JSON.stringify(sourceTableFrameScroll)}`);
  assert(["auto", "scroll"].includes(sourceTableFrameScroll.overflowX), `source selector table core overflow-x should scroll, got ${sourceTableFrameScroll.overflowX}`);
  await page.getByTestId("sales-out-source-selector-select-all").click();
  await page.getByTestId("sales-out-source-selector-count").waitFor({ state: "visible" });
  const selectedCount = await page.getByTestId("sales-out-source-selector-count").textContent();
  assert(selectedCount?.includes("2 行已选"), `source selector select-all should select visible rows, got ${selectedCount}`);
  await page.getByTestId("sales-out-source-selector-column-settings").click();
  await page.getByTestId("sales-out-source-selector-column-settings-dialog").waitFor({ state: "visible" });
  await page.locator(".column-setting-row").filter({ hasText: "单价" }).locator('input[type="checkbox"]').uncheck();
  await page.getByTestId("sales-out-source-selector-column-settings-ok").click();
  const unitPriceHeaderCount = await page.locator(".source-selector-table th", { hasText: "单价" }).count();
  assert(unitPriceHeaderCount === 0, "source selector column settings should hide unit price column");
  await page.getByTestId("sales-out-source-selector-cancel").click();

  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("query-sales-order-form").click();
  await page.getByTestId("list-keyword").fill(source.orderNo);
  await page.getByTestId("list-query").click();
  const visibleBillNoHeader = page.locator('[data-testid="column-drag-billNo"]:visible').first();
  await visibleBillNoHeader.waitFor({ state: "visible" });
  const headerBox = await waitForBoundingBox(visibleBillNoHeader, "list column header should have bounding box");
  await page.mouse.move(headerBox.x + 20, headerBox.y + 15);
  await page.mouse.down();
  await page.mouse.move(headerBox.x + 180, headerBox.y + 18, { steps: 6 });
  await page.getByTestId("column-drag-ghost").waitFor({ state: "visible" });
  const ghostText = await page.getByTestId("column-drag-ghost").textContent();
  await page.mouse.up();
  assert(ghostText?.includes("单据编号"), `list drag ghost should show dragged column title, got ${ghostText}`);

  const screenshot = `a97-entry-table-ux-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });
  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    ok: true,
    sourceOrderNo: source.orderNo,
    sourceNoticeNo: source.noticeNo,
    checks: {
      remarkTag,
      remarkResize,
      entryScroll,
      hiddenRows,
      sourceTableScroll,
      sourceTableFrameScroll,
      selectedCount,
      ghostText
    },
    screenshot: `verification/playwright/${screenshot}`
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
