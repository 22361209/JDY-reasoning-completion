import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a110-table-display-brand-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const phaseArg = process.argv.find((arg) => arg.startsWith("--phase="));
const phase = phaseArg?.split("=")[1] === "before" ? "before" : "after";
const billDate = "2026-06-26";

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

async function createAuditedSalesOrder() {
  const billNo = `XSDD-A110-${batch}`;
  await api("/api/sales-orders/draft", {
    body: {
      billNo,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      remark: `A110 table display ${batch}`,
      lines: [
        { productCode: "CP-001", warehouseCode: "CK-001", qty: 1234.5678, unitPrice: 86.25, taxRate: 13, lineRemark: "A110 numeric padding", planDeliveryDate: "2026-07-03" },
        { productCode: "PJ-014", warehouseCode: "CK-002", qty: 98.5, unitPrice: 12.34, taxRate: 13, lineRemark: "A110 detail view", planDeliveryDate: "2026-07-04" }
      ]
    }
  });
  await api(`/api/sales-orders/${encodeURIComponent(billNo)}/audit`);
  return billNo;
}

async function capture(page, name, screenshots) {
  const file = `a110-${phase}-${name}-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, file), fullPage: true });
  screenshots.push(`verification/playwright/${file}`);
}

async function metricsFor(page) {
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
      return { clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight };
    };
    const style = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const computed = getComputedStyle(node);
      return {
        overflowX: computed.overflowX,
        overflowY: computed.overflowY,
        paddingLeft: computed.paddingLeft,
        paddingRight: computed.paddingRight,
        lineHeight: computed.lineHeight,
        height: computed.height,
        display: computed.display,
        alignItems: computed.alignItems,
        textAlign: computed.textAlign
      };
    };
    return {
      loginBrandText: document.querySelector(".login-panel__brand")?.textContent?.trim() ?? "",
      loginTitleText: document.querySelector(".login-panel h1")?.textContent?.trim() ?? "",
      navBrandText: document.querySelector(".product-mark")?.textContent?.trim() ?? "",
      listScroll: scroll(".vxe-wrap .vxe-table--body-wrapper"),
      listWrapScroll: scroll(".vxe-wrap"),
      entryScroll: scroll(".entry-table"),
      listQtyCellRect: rect(".vxe-wrap .vxe-body--column.col--right .vxe-cell, .vxe-wrap .vxe-body--column.col--align-right .vxe-cell"),
      listQtyCellStyle: style(".vxe-wrap .vxe-body--column.col--right .vxe-cell, .vxe-wrap .vxe-body--column.col--align-right .vxe-cell"),
      entryQtyCellRect: rect(".entry-table td.entry-number-cell"),
      entryQtyCellStyle: style(".entry-table td.entry-number-cell"),
      entryQtyInputRect: rect(".entry-table td.entry-number-cell input"),
      entryQtyInputStyle: style(".entry-table td.entry-number-cell input"),
      listFilterRect: rect("[data-testid='column-filter-qty']"),
      listHeaderRect: rect("[data-testid='column-drag-qty']"),
      entryFilterRect: rect("[data-testid='entry-column-filter-qty']"),
      entryHeaderRect: rect("[data-testid='entry-column-drag-qty']")
    };
  });
}

function hasHorizontalOverflow(scroll) {
  return Boolean(scroll && scroll.scrollWidth > scroll.clientWidth + 8);
}

function rightGap(inner, outer) {
  if (!inner || !outer) return null;
  return Math.round((outer.x + outer.width) - (inner.x + inner.width));
}

const billNo = await createAuditedSalesOrder();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const screenshots = [];

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await capture(page, "login-brand", screenshots);
  const loginMetrics = await metricsFor(page);

  await loginAsAdmin(page);
  await page.getByText("首页工作台").first().waitFor({ state: "visible" });
  await capture(page, "workbench-brand", screenshots);

  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("query-sales-order-form").click();
  await page.getByTestId("list-keyword").fill(billNo);
  await page.getByTestId("list-query").click();
  await page.getByTestId(`open-document-${billNo}`).waitFor({ state: "visible" });
  await page.getByTestId("list-detail-view-toggle").click();
  await page.getByTestId("column-drag-qty").waitFor({ state: "visible" });
  await page.locator(".vxe-wrap .vxe-body--row").first().waitFor({ state: "visible" });
  await capture(page, "detail-list-scrollbar", screenshots);
  const detailMetrics = await metricsFor(page);

  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("entry-sales-order-form").click();
  await page.getByTestId("new-document").click();
  await page.getByTestId("sales-party-code").fill("KH-001");
  await page.getByTestId("sales-line-product").fill("CP-001");
  await page.getByTestId("sales-line-warehouse").fill("CK-001");
  await page.getByTestId("sales-line-qty").fill("1234.5678");
  await page.getByTestId("sales-line-price").fill("86.25");
  await page.getByTestId("entry-column-drag-qty").waitFor({ state: "visible" });
  await capture(page, "entry-table-scrollbar", screenshots);
  const entryMetrics = await metricsFor(page);

  const checks = {
    loginBrandText: loginMetrics.loginBrandText,
    loginTitleText: loginMetrics.loginTitleText,
    navBrandText: entryMetrics.navBrandText,
    detailListHasHorizontalOverflow: hasHorizontalOverflow(detailMetrics.listScroll) || hasHorizontalOverflow(detailMetrics.listWrapScroll),
    entryTableHasHorizontalOverflow: hasHorizontalOverflow(entryMetrics.entryScroll),
    detailListQtyPaddingRight: Number.parseFloat(detailMetrics.listQtyCellStyle?.paddingRight ?? "0"),
    entryQtyPaddingRight: Number.parseFloat(entryMetrics.entryQtyCellStyle?.paddingRight ?? "0"),
    entryQtyInputPaddingRight: Number.parseFloat(entryMetrics.entryQtyInputStyle?.paddingRight ?? "0"),
    entryFilterRightGap: rightGap(entryMetrics.entryFilterRect, entryMetrics.entryHeaderRect),
    listFilterRightGap: rightGap(detailMetrics.listFilterRect, detailMetrics.listHeaderRect),
    entryQtyCellHeight: entryMetrics.entryQtyCellRect?.height ?? 0,
    entryQtyInputHeight: entryMetrics.entryQtyInputRect?.height ?? 0
  };

  if (phase === "after") {
    assert(checks.loginBrandText === "BLD", `login brand should be BLD, got ${checks.loginBrandText}`);
    assert(checks.loginTitleText === "博莱德机械工作台", `login title should be renamed, got ${checks.loginTitleText}`);
    assert(checks.navBrandText === "BLD", `nav brand should be BLD, got ${checks.navBrandText}`);
    assert(checks.detailListHasHorizontalOverflow, "detail list should expose horizontal overflow for scrollbar");
    assert(checks.entryTableHasHorizontalOverflow, "entry table should expose horizontal overflow for scrollbar");
    assert(checks.detailListQtyPaddingRight >= 10, `detail numeric cell needs right padding, got ${checks.detailListQtyPaddingRight}`);
    assert(checks.entryQtyPaddingRight >= 10 || checks.entryQtyInputPaddingRight >= 8, `entry numeric cell/input needs right padding, got ${JSON.stringify(checks)}`);
    assert(checks.entryQtyInputHeight <= checks.entryQtyCellHeight + 2, `entry input should not be clipped vertically: ${JSON.stringify(checks)}`);
    assert(checks.entryFilterRightGap !== null && checks.listFilterRightGap !== null, "filter buttons should be measurable");
    assert(Math.abs(checks.entryFilterRightGap - checks.listFilterRightGap) <= 3, `entry filter right gap should match list filter: ${JSON.stringify(checks)}`);
  }

  const result = {
    batch,
    phase,
    generatedAt: new Date().toISOString(),
    ok: true,
    billNo,
    checks,
    screenshots
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
