import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a112-table-core-scroll-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-26";
const orderNo = `XSDD-A112-${batch}`;
const noticeNo = `FHTZD-A112-${batch}`;

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
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${options.method ?? "POST"} ${pathname} failed ${response.status}: ${text}`);
  }
  return data;
}

async function seed() {
  await api("/api/sales-orders/draft", {
    body: {
      billNo: orderNo,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      remark: `A112 table core ${batch}`,
      lines: [
        { productCode: "CP-001", warehouseCode: "CK-001", qty: 8, unitPrice: 86, taxRate: 13, lineRemark: "A112 line 1", planDeliveryDate: "2026-07-06" },
        { productCode: "PJ-014", warehouseCode: "CK-002", qty: 3, unitPrice: 12, taxRate: 13, lineRemark: "A112 line 2", planDeliveryDate: "2026-07-07" }
      ]
    }
  });
  await api(`/api/sales-orders/${encodeURIComponent(orderNo)}/audit`);
  await api("/api/delivery-notices/draft", {
    body: {
      billNo: noticeNo,
      sourceOrderNo: orderNo,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      remark: `A112 stock scroll ${batch}`,
      lines: [
        { productCode: "CP-001", warehouseCode: "CK-001", sourceOrderNo: orderNo, sourceLineNo: 1, qty: 8, unitPrice: 86, taxRate: 13, lineRemark: "A112 stock line", planDeliveryDate: "2026-07-06" }
      ]
    }
  });
  await api(`/api/delivery-notices/${encodeURIComponent(noticeNo)}/audit`);
}

async function screenshot(page, name, screenshots) {
  const file = `a112-${name}-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, file), fullPage: true });
  screenshots.push(`verification/playwright/${file}`);
  return screenshots.at(-1);
}

async function tableMetrics(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
    };
    const scroll = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      return { scrollLeft: node.scrollLeft, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth };
    };
    const text = (selector) => [...document.querySelectorAll(selector)]
      .filter((node) => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      })
      .map((node) => node.textContent?.trim() ?? "");
    const rightGap = (innerSelector, outerSelector) => {
      const inner = rect(innerSelector);
      const outer = rect(outerSelector);
      if (!inner || !outer) return null;
      return Math.round(outer.right - inner.right);
    };
    const visibleInside = (nodeSelector, frameSelector) => {
      const node = document.querySelector(nodeSelector);
      const frame = document.querySelector(frameSelector);
      if (!node || !frame) return false;
      const box = node.getBoundingClientRect();
      const frameBox = frame.getBoundingClientRect();
      return box.width > 0 && box.right > frameBox.left && box.left < frameBox.right;
    };
    return {
      listScroll: scroll(".vxe-wrap"),
      entryScroll: scroll(".entry-table"),
      listHeaders: text(".vxe-wrap .vxe-header--column").slice(0, 8),
      entryHeaders: text(".entry-table thead th").slice(0, 8),
      listQtyFilterRightGap: rightGap("[data-testid='column-filter-qty']", "[data-testid='column-drag-qty']"),
      entryQtyFilterRightGap: rightGap("[data-testid='entry-column-filter-qty']", "[data-testid='entry-column-drag-qty']"),
      stockOnHandVisible: visibleInside("[data-testid='delivery-notice-line-stockOnHand']", ".entry-table"),
      stockAvailableVisible: visibleInside("[data-testid='delivery-notice-line-stockAvailable']", ".entry-table"),
      stockReservedVisible: visibleInside("[data-testid='delivery-notice-line-stockReserved']", ".entry-table")
    };
  });
}

await seed();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const screenshots = [];

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);

  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("query-sales-order-form").click();
  await page.getByTestId("list-keyword").fill(orderNo);
  await page.getByTestId("list-query").click();
  await page.getByTestId(`open-document-${orderNo}`).waitFor({ state: "visible" });
  await page.getByTestId("list-detail-view-toggle").click();
  await page.getByTestId("column-drag-qty").waitFor({ state: "visible" });
  await page.locator(".vxe-wrap .vxe-body--row").first().waitFor({ state: "visible" });
  await screenshot(page, "list-filter-alignment-no-seq", screenshots);
  const listMetrics = await tableMetrics(page);
  assert(listMetrics.listScroll.scrollWidth > listMetrics.listScroll.clientWidth + 8, `list should have real horizontal overflow: ${JSON.stringify(listMetrics.listScroll)}`);
  assert(!listMetrics.listHeaders.some((header) => header.includes("序号")), `list must not render sequence column: ${JSON.stringify(listMetrics.listHeaders)}`);

  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("query-delivery-notice-form").click();
  await page.getByTestId("list-keyword").fill(noticeNo);
  await page.getByTestId("list-query").click();
  await page.getByTestId(`open-document-${noticeNo}`).click();
  await page.getByTestId("delivery-notice-line-stockOnHand").waitFor({ state: "visible" });
  await page.locator(".entry-table").evaluate((node) => {
    const stockCell = document.querySelector("[data-testid='delivery-notice-line-stockOnHand']");
    const stockLeft = stockCell instanceof HTMLElement ? stockCell.offsetLeft : node.scrollWidth;
    node.scrollLeft = Math.max(0, stockLeft - 120);
  });
  await page.waitForTimeout(150);
  await screenshot(page, "entry-stock-columns-horizontal-scroll", screenshots);
  const entryMetrics = await tableMetrics(page);
  assert(entryMetrics.entryScroll.scrollWidth > entryMetrics.entryScroll.clientWidth + 8, `entry table should have real horizontal overflow: ${JSON.stringify(entryMetrics.entryScroll)}`);
  assert(entryMetrics.entryScroll.scrollLeft > 0, `entry horizontal scroll should move right: ${JSON.stringify(entryMetrics.entryScroll)}`);
  assert(entryMetrics.stockOnHandVisible && entryMetrics.stockAvailableVisible && entryMetrics.stockReservedVisible, `stock columns should be visible after horizontal scroll: ${JSON.stringify(entryMetrics)}`);
  assert(entryMetrics.entryHeaders.some((header) => header.includes("序号")), `entry table must keep sequence column: ${JSON.stringify(entryMetrics.entryHeaders)}`);

  await page.locator(".entry-table").evaluate((node) => {
    node.scrollLeft = 0;
  });
  await page.waitForTimeout(150);
  await screenshot(page, "entry-filter-alignment-seq-kept", screenshots);
  const entryLeftMetrics = await tableMetrics(page);
  assert(entryLeftMetrics.entryQtyFilterRightGap !== null && listMetrics.listQtyFilterRightGap !== null, "filter positions should be measurable");
  assert(
    Math.abs(entryLeftMetrics.entryQtyFilterRightGap - listMetrics.listQtyFilterRightGap) <= 3,
    `list and entry filter buttons should share the same relative right position: ${JSON.stringify({ list: listMetrics.listQtyFilterRightGap, entry: entryLeftMetrics.entryQtyFilterRightGap })}`
  );

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    ok: true,
    orderNo,
    noticeNo,
    checks: {
      list: listMetrics,
      entryScrolled: entryMetrics,
      entryLeft: entryLeftMetrics,
      filterRightGapDelta: Math.abs(entryLeftMetrics.entryQtyFilterRightGap - listMetrics.listQtyFilterRightGap)
    },
    screenshots
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
