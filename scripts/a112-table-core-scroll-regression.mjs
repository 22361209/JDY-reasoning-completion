import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { addEntryLineBelow } from "./helpers/entry-table-actions.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a112-table-core-scroll-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-26";
let orderNo = "";
let noticeNo = "";
const listKeyword = `A112 table core ${batch}`;
const seededOrderNos = [];

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

async function seed() {
  for (let index = 0; index < 17; index += 1) {
    const lines = index === 0
      ? [
          { productCode: "CP-001", warehouseCode: "CK-001", qty: 8, unitPrice: 86, taxRate: 13, lineRemark: "A112 line 1", planDeliveryDate: "2026-07-06" },
          { productCode: "PJ-014", warehouseCode: "CK-002", qty: 3, unitPrice: 12, taxRate: 13, lineRemark: "A112 line 2", planDeliveryDate: "2026-07-07" }
        ]
      : [{ productCode: "CP-001", warehouseCode: "CK-001", qty: index + 1, unitPrice: 86, taxRate: 13, lineRemark: `A112 flex row ${index + 1}`, planDeliveryDate: "2026-07-06" }];
    const savedOrder = await api("/api/sales-orders/draft", {
      body: {
        billNo: null,
        customerCode: "KH-001",
        billDate,
        department: "销售部",
        ownerName: "本地管理员",
        remark: listKeyword,
        lines
      }
    });
    const generatedNo = generatedBillNo(savedOrder, "XSDD", `A112 sales order ${index + 1}`);
    await api(`/api/sales-orders/${encodeURIComponent(generatedNo)}/audit`);
    seededOrderNos.push(generatedNo);
  }
  [orderNo] = seededOrderNos;
  const savedNotice = await api("/api/delivery-notices/draft", {
    body: {
      billNo: null,
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
  noticeNo = generatedBillNo(savedNotice, "FHTZD", "A112 delivery notice");
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
      const style = getComputedStyle(node);
      return {
        scrollLeft: node.scrollLeft,
        clientWidth: node.clientWidth,
        scrollWidth: node.scrollWidth,
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        backgroundImage: style.backgroundImage,
        flexGrow: style.flexGrow,
        minHeight: style.minHeight
      };
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
    const titleMetric = (selector) => {
      const node = document.querySelector(selector);
      if (!(node instanceof HTMLElement)) {
        return { missing: true };
      }
      return {
        missing: false,
        text: node.textContent?.trim() ?? "",
        clientWidth: Math.round(node.clientWidth),
        scrollWidth: Math.round(node.scrollWidth)
      };
    };
    const entryControlMetric = (name, selector, controlSelector = null) => {
      const node = document.querySelector(selector);
      if (!node) {
        return { name, missing: true };
      }
      const cell = node.tagName === "TD" ? node : node.closest("td");
      const control = controlSelector
        ? node.querySelector(controlSelector)
        : node.tagName === "TD"
          ? node.firstElementChild
          : node;
      if (!cell || !control) {
        return { name, missing: true };
      }
      const cellBox = cell.getBoundingClientRect();
      const controlBox = control.getBoundingClientRect();
      return {
        name,
        cellHeight: Math.round(cellBox.height),
        controlHeight: Math.round(controlBox.height),
        topGap: Math.round(controlBox.top - cellBox.top),
        bottomGap: Math.round(cellBox.bottom - controlBox.bottom),
        className: control.className?.toString() ?? ""
      };
    };
    return {
      listScroll: scroll(".vxe-wrap"),
      listBodyScroll: scroll(".vxe-wrap .vxe-table--body-wrapper"),
      listFrameRect: rect(".vxe-wrap"),
      listBodyRect: rect(".vxe-wrap .vxe-table--body-wrapper"),
      listMainRect: rect(".data-list-main"),
      listPaginationRect: rect(".list-pagination"),
      entryScroll: scroll(".entry-table"),
      entryBodyScroll: scroll(".entry-table .table-core-body-wrapper"),
      entryBodyRect: rect(".entry-table .table-core-body-wrapper"),
      entryFooterRect: rect(".entry-table .table-core-footer-wrapper"),
      listHeaders: text(".vxe-wrap .vxe-header--column").slice(0, 8),
      entryHeaders: text(".entry-table thead th").slice(0, 8),
      listCoreHeaderCount: document.querySelectorAll(".vxe-wrap .table-core-header-cell").length,
      entryCoreHeaderCount: document.querySelectorAll(".entry-table .table-core-header-cell").length,
      entryProductCodeHeaderTitle: titleMetric("[data-testid='entry-column-drag-productCode'] .column-header-title"),
      entryQtyHeaderTitle: titleMetric("[data-testid='entry-column-drag-qty'] .column-header-title"),
      listBillNoHeaderTitle: titleMetric("[data-testid='column-drag-billNo'] .column-header-title"),
      listQtyFilterRightGap: rightGap("[data-testid='column-filter-qty']", "[data-testid='column-drag-qty']"),
      entryQtyFilterRightGap: rightGap("[data-testid='entry-column-filter-qty']", "[data-testid='entry-column-drag-qty']"),
      stockOnHandVisible: visibleInside("[data-testid='delivery-notice-line-stockOnHand']", ".entry-table"),
      stockAvailableVisible: visibleInside("[data-testid='delivery-notice-line-stockAvailable']", ".entry-table"),
      stockReservedVisible: visibleInside("[data-testid='delivery-notice-line-stockReserved']", ".entry-table"),
      entryCellControls: [
        entryControlMetric("productCode", "[data-testid='delivery-notice-line-product']"),
        entryControlMetric("productName", "[data-testid='delivery-notice-line-product-name']"),
        entryControlMetric("spec", "[data-testid='delivery-notice-line-spec']"),
        entryControlMetric("warehouse", "[data-testid='delivery-notice-line-warehouse']"),
        entryControlMetric("sourceOrderNo", "[data-testid='delivery-notice-line-source-order-no']"),
        entryControlMetric("qty", "[data-testid='delivery-notice-line-qty']"),
        entryControlMetric("stockOnHand", "[data-testid='delivery-notice-line-stockOnHand']"),
        entryControlMetric("stockReserved", "[data-testid='delivery-notice-line-stockReserved']"),
        entryControlMetric("stockAvailable", "[data-testid='delivery-notice-line-stockAvailable']")
      ]
    };
  });
}

async function headerWidths(page) {
  return page.evaluate(() => {
    const width = (field) => {
      const header = document.querySelector(`[data-testid='column-drag-${field}']`)?.closest(".vxe-header--column");
      return Math.round(header?.getBoundingClientRect().width ?? 0);
    };
    return {
      billNo: width("billNo"),
      customer: width("customer"),
      billDate: width("billDate")
    };
  });
}

async function dragBillNoWidth(page, deltaX) {
  const box = await page.getByTestId("column-resize-billNo").evaluate((node) => {
    const rect = node.getBoundingClientRect();
    if (!rect) {
      return null;
    }
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  assert(box, "billNo header resize box should be measurable");
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + deltaX, box.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(180);
}

await seed();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 710 } });
const screenshots = [];

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await page.evaluate(() => {
    localStorage.setItem("jdy:list-columns:v3:sales-order-form-list:header", JSON.stringify([
      { field: "status", width: 100, visible: true },
      { field: "partner", width: 160, visible: true }
    ]));
  });

  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("query-sales-order-form").click();
  await page.getByTestId("column-drag-billNo").waitFor({ state: "visible" });
  await page.getByTestId("column-drag-customer").waitFor({ state: "visible" });
  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("query-sales-quote-form").click();
  await page.getByTestId("column-drag-validUntil").waitFor({ state: "visible" });
  await page.getByTestId("column-drag-validStatus").waitFor({ state: "visible" });
  await page.locator("[data-testid^='open-document-XSBJ']").first().waitFor({ state: "visible" });
  const quoteListText = await page.locator(".data-list-page").innerText();
  assert(quoteListText.includes("XSBJ-"), `sales quote list should render quote rows after sales order tab: ${quoteListText.slice(0, 500)}`);
  assert(!quoteListText.includes(orderNo), `sales quote list must not retain seeded sales order ${orderNo}: ${quoteListText.slice(0, 500)}`);
  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("query-sales-order-form").click();
  await page.getByTestId("column-drag-outStatus").waitFor({ state: "visible" });
  await page.locator("[data-testid^='open-document-XSDD']").first().waitFor({ state: "visible" });
  const orderListText = await page.locator(".data-list-page").innerText();
  assert(orderListText.includes(orderNo), `sales order list should render seeded system-numbered order after quote tab: ${orderListText.slice(0, 500)}`);
  await page.getByTestId("list-keyword").fill(orderNo);
  await page.getByTestId("list-query").click();
  await page.getByTestId(`open-document-${orderNo}`).waitFor({ state: "visible" });
  const isolatedHeaderRowCount = await page.locator(".vxe-wrap .vxe-body--row").count();
  assert(isolatedHeaderRowCount === 1, `exact bill filter should isolate one self-owned header row, got ${isolatedHeaderRowCount}`);
  const salesListApiState = await page.evaluate(async (expectedBillNo) => {
    const read = async (view) => {
      const response = await fetch(`/api/lists/sales-order-form-list?keyword=${encodeURIComponent(expectedBillNo)}&page=1&pageSize=20&view=${view}`);
      const data = await response.json();
      return {
        view,
        status: response.status,
        total: data.total,
        rows: data.rows?.length ?? 0,
        first: data.rows?.[0] ?? null
      };
    };
    return {
      header: await read("header"),
      detail: await read("detail")
    };
  }, orderNo);
  assert(salesListApiState.header.status === 200, `sales order header list should load: ${JSON.stringify(salesListApiState)}`);
  assert(salesListApiState.detail.status === 200, `sales order detail list should load: ${JSON.stringify(salesListApiState)}`);
  assert(salesListApiState.header.total === 1 && salesListApiState.header.rows === 1, `seeded sales order should produce one isolated header row: ${JSON.stringify(salesListApiState)}`);
  assert(salesListApiState.detail.total === 2 && salesListApiState.detail.rows === 2, `seeded two-line sales order should produce two isolated detail rows: ${JSON.stringify(salesListApiState)}`);
  assert(salesListApiState.header.first?.billNo === orderNo && salesListApiState.detail.first?.billNo === orderNo, `isolated list queries should return the seeded order: ${JSON.stringify(salesListApiState)}`);
  assert(
    salesListApiState.header.first?.billNo && salesListApiState.header.first?.customer && salesListApiState.header.first?.amount,
    `sales order header rows should keep non-status fields: ${JSON.stringify(salesListApiState)}`
  );
  await screenshot(page, "a112b-header-sparse-fill", screenshots);
  const sparseHeaderMetrics = await tableMetrics(page);
  const sparseFramePaginationGap = Math.abs(sparseHeaderMetrics.listPaginationRect.y - sparseHeaderMetrics.listFrameRect.bottom);
  const sparseMainBottomGap = Math.abs(sparseHeaderMetrics.listMainRect.bottom - sparseHeaderMetrics.listPaginationRect.bottom);
  const sparseBodyFillsAvailable = sparseHeaderMetrics.listBodyScroll.clientHeight > 336
    && sparseFramePaginationGap <= 2
    && sparseMainBottomGap <= 2;
  assert(sparseHeaderMetrics.listScroll.overflowX === "scroll", `header view outer scrollbar should be always on: ${JSON.stringify(sparseHeaderMetrics.listScroll)}`);
  assert(sparseHeaderMetrics.listBodyScroll.overflowX === "hidden", `header view body should not own horizontal scroll: ${JSON.stringify(sparseHeaderMetrics.listBodyScroll)}`);
  assert(sparseHeaderMetrics.listBodyScroll.overflowY === "auto", `header view body should use auto vertical scroll: ${JSON.stringify(sparseHeaderMetrics.listBodyScroll)}`);
  assert(sparseHeaderMetrics.listBodyScroll.backgroundImage.includes("repeating-linear-gradient"), `header view empty space should continue grid lines: ${JSON.stringify(sparseHeaderMetrics.listBodyScroll)}`);
  assert(
    sparseHeaderMetrics.listPaginationRect
      && sparseHeaderMetrics.listFrameRect
      && sparseHeaderMetrics.listMainRect
      && sparseFramePaginationGap <= 2
      && sparseMainBottomGap <= 2,
    `pagination should stay directly below the flexed table frame: ${JSON.stringify(sparseHeaderMetrics)}`
  );
  assert(sparseHeaderMetrics.listCoreHeaderCount > 0, `header view should render shared table core header cells: ${JSON.stringify(sparseHeaderMetrics)}`);

  await page.getByTestId("list-keyword").fill(listKeyword);
  await page.getByTestId("list-query").click();
  await page.waitForFunction(
    (expectedCount) => document.querySelectorAll(".vxe-wrap .vxe-body--row").length === expectedCount,
    seededOrderNos.length
  );
  const batchHeaderRowCount = await page.locator(".vxe-wrap .vxe-body--row").count();
  assert(batchHeaderRowCount === seededOrderNos.length, `batch keyword should isolate ${seededOrderNos.length} self-owned header rows, got ${batchHeaderRowCount}`);
  const denseHeaderMetrics = await tableMetrics(page);
  assert(
    denseHeaderMetrics.listBodyScroll.scrollHeight > denseHeaderMetrics.listBodyScroll.clientHeight + 8,
    `seventeen self-owned rows should create real vertical overflow: ${JSON.stringify(denseHeaderMetrics.listBodyScroll)}`
  );
  await screenshot(page, "a112b-header-seventeen-row-scroll", screenshots);
  const beforeResize = await headerWidths(page);
  await dragBillNoWidth(page, 44);
  const afterResize = await headerWidths(page);
  await screenshot(page, "a112b-header-independent-column-resize", screenshots);
  assert(afterResize.billNo >= beforeResize.billNo + 24, `billNo column should resize independently: ${JSON.stringify({ beforeResize, afterResize })}`);
  assert(Math.abs(afterResize.customer - beforeResize.customer) <= 6, `customer neighbor width should stay stable after billNo resize: ${JSON.stringify({ beforeResize, afterResize })}`);

  await page.getByTestId(`open-document-${orderNo}`).click();
  await page.getByTestId("sales-line-product").waitFor({ state: "visible" });
  await page.waitForFunction((expected) => {
    const input = document.querySelector("[data-testid='sales-bill-no']");
    return input instanceof HTMLInputElement && input.value === expected;
  }, orderNo);
  const openedBillNo = await page.getByTestId("sales-bill-no").inputValue();
  assert(openedBillNo === orderNo, `opened sales order should show seeded bill no before tab switch: ${openedBillNo}`);
  await page.getByTestId("tab-sales-order-form-list").click();
  await page.getByTestId("tab-sales-order-form").click();
  const restoredBillNo = await page.getByTestId("sales-bill-no").inputValue();
  const restoredProduct = await page.getByTestId("sales-line-product").inputValue();
  assert(restoredBillNo === orderNo, `sales order tab should preserve bill no after switching to list and back: ${restoredBillNo}`);
  assert(restoredProduct === "CP-001", `sales order tab should preserve line data after switching to list and back: ${restoredProduct}`);
  await screenshot(page, "a112b-tab-state-preserved", screenshots);

  await page.getByTestId("tab-sales-order-form-list").click();
  await page.getByTestId("list-create").click();
  await page.getByTestId("sales-bill-no").waitFor({ state: "visible" });
  await addEntryLineBelow(page);
  await page.getByTestId("sales-line-product-2").waitFor({ state: "visible" });
  const newLine = {
    product: await page.getByTestId("sales-line-product-2").inputValue(),
    warehouse: await page.getByTestId("sales-line-warehouse-2").inputValue(),
    qty: await page.getByTestId("sales-line-qty-2").inputValue(),
    unitPrice: await page.getByTestId("sales-line-price-2").inputValue()
  };
  assert(newLine.product === "" && newLine.warehouse === "" && ["", "0"].includes(newLine.qty) && ["", "0"].includes(newLine.unitPrice), `new entry line should be blank: ${JSON.stringify(newLine)}`);
  await screenshot(page, "a112b-new-line-blank", screenshots);

  await page.getByTestId("tab-sales-order-form-list").click();
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
  assert(entryMetrics.entryBodyScroll.overflowX === "hidden", `entry body should not own horizontal scroll: ${JSON.stringify(entryMetrics.entryBodyScroll)}`);
  assert(entryMetrics.entryBodyScroll.overflowY === "auto", `entry body should use auto vertical scroll: ${JSON.stringify(entryMetrics.entryBodyScroll)}`);
  assert(entryMetrics.entryBodyScroll.backgroundImage === "none", `entry body should not draw duplicate background grid lines: ${JSON.stringify(entryMetrics.entryBodyScroll)}`);
  assert(
    entryMetrics.entryFooterRect && entryMetrics.entryBodyRect && entryMetrics.entryFooterRect.y >= entryMetrics.entryBodyRect.bottom - 1,
    `entry footer should render outside the scrollable body: ${JSON.stringify(entryMetrics)}`
  );
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
  const badEntryControls = entryLeftMetrics.entryCellControls.filter((metric) =>
    metric.missing || metric.cellHeight < 32 || metric.cellHeight > 33 || metric.controlHeight !== 28 || Math.abs(metric.topGap - metric.bottomGap) > 1
  );
  assert(
    !entryLeftMetrics.entryProductCodeHeaderTitle.missing
      && entryLeftMetrics.entryProductCodeHeaderTitle.scrollWidth <= entryLeftMetrics.entryProductCodeHeaderTitle.clientWidth + 1,
    `entry product code header title should not be squeezed by header actions: ${JSON.stringify(entryLeftMetrics.entryProductCodeHeaderTitle)}`
  );
  assert(
    !entryLeftMetrics.entryQtyHeaderTitle.missing
      && entryLeftMetrics.entryQtyHeaderTitle.scrollWidth <= entryLeftMetrics.entryQtyHeaderTitle.clientWidth + 1,
    `entry qty header title should not be squeezed when filter and bulk buttons coexist: ${JSON.stringify(entryLeftMetrics.entryQtyHeaderTitle)}`
  );
  assert(
    badEntryControls.length === 0,
    `entry editable/readonly cell controls should share one 32-33/28px geometry: ${JSON.stringify(entryLeftMetrics.entryCellControls)}`
  );

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    ok: sparseBodyFillsAvailable,
    orderNo,
    noticeNo,
    checks: {
      sparseHeader: sparseHeaderMetrics,
      denseHeader: denseHeaderMetrics,
      salesListApiState,
      isolatedHeaderRowCount,
      batchHeaderRowCount,
      seededOrderCount: seededOrderNos.length,
      headerResize: { beforeResize, afterResize },
      tabState: { openedBillNo, restoredBillNo, restoredProduct },
      newLine,
      list: listMetrics,
      entryScrolled: entryMetrics,
      entryLeft: entryLeftMetrics,
      filterRightGapDelta: Math.abs(entryLeftMetrics.entryQtyFilterRightGap - listMetrics.listQtyFilterRightGap)
    },
    screenshots
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  assert(
    sparseBodyFillsAvailable,
    `one-row sparse header body should fill the real data-list-main area: ${JSON.stringify({ body: sparseHeaderMetrics.listBodyScroll, sparseFramePaginationGap, sparseMainBottomGap })}`
  );
} finally {
  await browser.close();
}
