import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { clickNewDocument, openSalesOutSourceSelector, confirmSalesOutSourceSelector } from "./helpers/document-actions.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a102-core-flow-ui-regression.json");
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

async function createAuditedSalesOrder(label, withNotice = false) {
  const lines = [
    { productCode: "CP-001", warehouseCode: "CK-001", qty: 3, unitPrice: 86, taxRate: 13, lineRemark: `A102 ${label} 1`, planDeliveryDate: "2026-07-03" },
    { productCode: "PJ-014", warehouseCode: "CK-002", qty: 2, unitPrice: 12, taxRate: 13, lineRemark: `A102 ${label} 2`, planDeliveryDate: "2026-07-04" }
  ];
  for (const line of lines) {
    await api("/api/inventory/adjustments", {
      body: {
        productCode: line.productCode,
        warehouseCode: line.warehouseCode,
        qtyDelta: 100,
        txnType: "A102_CORE_FLOW_IN",
        sourceBillType: `A102:${batch}`
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
      remark: `A102 ${label}`,
      lines
    }
  });
  const billNo = generatedBillNo(savedOrder, "XSDD", `A102 ${label} sales order`);
  await api(`/api/sales-orders/${encodeURIComponent(billNo)}/audit`);
  if (!withNotice) {
    return { orderNo: billNo, noticeNo: "" };
  }
  const savedNotice = await api("/api/delivery-notices/draft", {
    body: {
      billNo: null,
      sourceOrderNo: billNo,
      customerCode: "KH-001",
      billDate: "2026-06-26",
      department: "销售部",
      ownerName: "本地管理员",
      remark: `A102 notice ${label}`,
      lines: lines.map((line, index) => ({ ...line, sourceOrderNo: billNo, sourceLineNo: index + 1 }))
    }
  });
  const noticeNo = generatedBillNo(savedNotice, "FHTZD", `A102 ${label} delivery notice`);
  await api(`/api/delivery-notices/${encodeURIComponent(noticeNo)}/audit`);
  return { orderNo: billNo, noticeNo };
}

async function drag(page, locator, dx, dy = 0) {
  const box = await locator.boundingBox();
  assert(box, "drag target should have bounding box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 8 });
  await page.mouse.up();
}

async function dragColumnBoundary(page, headerLocator, dx) {
  const box = await headerLocator.evaluate((node) => {
    const rect = (node.closest("th") ?? node).getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  assert(box.width > 0 && box.height > 0, "column header should have measurable box");
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2 + dx, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
}

async function openDeliveryNoticeSourceSelector(page) {
  await page.getByTestId("delivery-notice-open-source-selector").click();
  await page.getByTestId("delivery-notice-source-selector-dialog").waitFor({ state: "visible" });
}

async function confirmDeliveryNoticeSourceSelector(page) {
  const dialog = page.getByTestId("delivery-notice-source-selector-dialog");
  await page.getByTestId("delivery-notice-source-selector-ok").click();
  await dialog.waitFor({ state: "hidden" }).catch(() => undefined);
}

const source = await createAuditedSalesOrder("SRC", true);
const deliveryLocalSource = await createAuditedSalesOrder("DNLOCAL");
const reverse = await createAuditedSalesOrder("REV");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);

  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("entry-delivery-notice-form").click();
  await page.getByTestId("delivery-notice-party-code").waitFor({ state: "visible" });
  await clickNewDocument(page);
  await page.getByTestId("delivery-notice-party-code").fill("KH-001");
  await openDeliveryNoticeSourceSelector(page);
  await page.getByTestId("delivery-notice-source-selector-search").fill(deliveryLocalSource.orderNo);
  await page.getByTestId("delivery-notice-source-selector-query").click();
  await page.locator(".source-selector-table tbody tr", { hasText: deliveryLocalSource.orderNo }).first().waitFor({ state: "visible" });
  await page.getByTestId("delivery-notice-source-selector-select-all").click();
  const deliveryNoticeSelectedCount = await page.getByTestId("delivery-notice-source-selector-count").textContent();
  assert(deliveryNoticeSelectedCount?.includes("2 行已选"), `delivery notice source selector should select source lines, got ${deliveryNoticeSelectedCount}`);
  await confirmDeliveryNoticeSourceSelector(page);
  await page.getByTestId("delivery-notice-line-source-order-no").filter({ hasText: deliveryLocalSource.orderNo }).first().waitFor({ state: "visible" });
  const deliveryNoticeSourceOrderCell = (await page.getByTestId("delivery-notice-line-source-order-no").first().textContent())?.trim();
  assert(deliveryNoticeSourceOrderCell === deliveryLocalSource.orderNo, `delivery notice source column should show selected sales order no, got ${deliveryNoticeSourceOrderCell}`);
  await openDeliveryNoticeSourceSelector(page);
  await page.getByTestId("delivery-notice-source-selector-search").fill(deliveryLocalSource.orderNo);
  await page.getByTestId("delivery-notice-source-selector-query").click();
  await page.getByTestId("delivery-notice-source-selector-message").filter({ hasText: "当前过滤条件下暂无可选销售订单明细。" }).waitFor({ state: "visible" });
  const deliveryNoticeRepeatedSourceSummaryText = (await page.getByTestId("delivery-notice-source-selector-summary").textContent())?.replace(/\s+/g, " ").trim();
  assert(deliveryNoticeRepeatedSourceSummaryText?.includes("当前明细：0 行"), `delivery notice reopened selector should deduct current document allocation, got ${deliveryNoticeRepeatedSourceSummaryText}`);
  assert(deliveryNoticeRepeatedSourceSummaryText?.includes("已选：0 行"), `delivery notice reopened selector should start with empty basket, got ${deliveryNoticeRepeatedSourceSummaryText}`);
  await page.getByTestId("delivery-notice-source-selector-cancel").click();

  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("entry-sales-out-form").click();
  await page.getByTestId("sales-out-party-code").waitFor({ state: "visible" });
  await clickNewDocument(page);

  const sourceHeaderInputCount = await page.getByTestId("sales-out-source-order-no").count();
  const toolbarSourceVisible = await page.getByTestId("sales-out-open-source-selector").isVisible();
  assert(sourceHeaderInputCount === 0, "sales out header source-order input should be removed");
  assert(toolbarSourceVisible, "sales out source selector should be in action toolbar");

  const headerSelectorButton = page.getByTestId("sales-out-party-open-selector");
  const headerButtonStyle = await headerSelectorButton.evaluate((node) => {
    const style = getComputedStyle(node);
    return { borderRadius: style.borderRadius, width: style.width, height: style.height, display: style.display };
  });
  assert(headerButtonStyle.borderRadius.includes("50%") || headerButtonStyle.borderRadius === "9px", `header selector should be circular, got ${JSON.stringify(headerButtonStyle)}`);

  await page.getByTestId("sales-out-party-code").fill("KH-001");
  await openSalesOutSourceSelector(page);
  const sourceDialogMetrics = await page.locator(".source-selector-dialog").evaluate((node) => ({
    width: Math.round(node.getBoundingClientRect().width),
    height: Math.round(node.getBoundingClientRect().height),
    overflow: getComputedStyle(node).overflow
  }));
  assert(sourceDialogMetrics.width >= 1300, `source selector should be wide enough for source detail lines, got ${JSON.stringify(sourceDialogMetrics)}`);
  assert(sourceDialogMetrics.height >= 700, `source selector should be tall enough for source detail lines, got ${JSON.stringify(sourceDialogMetrics)}`);
  assert(sourceDialogMetrics.overflow === "hidden", `source selector dialog should keep scrolling inside the table body, got ${JSON.stringify(sourceDialogMetrics)}`);

  await page.getByTestId("sales-out-source-selector-search").fill(source.noticeNo);
  await page.getByTestId("sales-out-source-selector-query").click();
  await page.locator(".source-selector-table tbody tr", { hasText: source.noticeNo }).first().waitFor({ state: "visible" });
  const sourceSummaryText = (await page.getByTestId("sales-out-source-selector-summary").textContent())?.replace(/\s+/g, " ").trim();
  assert(sourceSummaryText?.includes("当前明细：2 行"), `source selector summary should show visible line count, got ${sourceSummaryText}`);
  assert(sourceSummaryText?.includes("剩余可出合计"), `source selector summary should show remaining qty total, got ${sourceSummaryText}`);
  const sourceTableScroll = await page.locator(".source-selector-table .table-core-frame").evaluate((node) => ({
    outerOverflowX: getComputedStyle(node.closest(".source-selector-table")).overflowX,
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
    overflowX: getComputedStyle(node).overflowX
  }));
  assert(sourceTableScroll.outerOverflowX === "hidden", `source selector outer wrapper should not own horizontal scroll, got ${JSON.stringify(sourceTableScroll)}`);
  assert(sourceTableScroll.overflowX === "scroll", `source selector should reuse TableCore horizontal scroll, got ${JSON.stringify(sourceTableScroll)}`);
  assert(sourceTableScroll.scrollWidth > sourceTableScroll.clientWidth, `source selector needs horizontal scroll, got ${JSON.stringify(sourceTableScroll)}`);
  await page.getByTestId("sales-out-source-selector-select-all").click();
  const selectedCount = await page.getByTestId("sales-out-source-selector-count").textContent();
  assert(selectedCount?.includes("2 行已选"), `source selector select all should select visible lines, got ${selectedCount}`);
  await page.getByTestId("sales-out-source-selector-column-settings").click();
  await page.getByTestId("sales-out-source-selector-column-settings-dialog").waitFor({ state: "visible" });
  await page.locator(".column-setting-row").filter({ hasText: "单价" }).locator('input[type="checkbox"]').uncheck();
  await page.getByTestId("sales-out-source-selector-column-settings-ok").click();
  assert(await page.locator(".source-selector-table th", { hasText: "单价" }).count() === 0, "source selector column settings should hide selected column");
  await page.getByTestId("sales-out-source-selector-search").fill(`NO-HIT-${batch}`);
  await page.getByTestId("sales-out-source-selector-query").click();
  await page.getByTestId("sales-out-source-selector-message").filter({ hasText: "当前过滤条件下暂无可选发货通知明细。" }).waitFor({ state: "visible" });
  const hiddenSelectedCount = await page.getByTestId("sales-out-source-selector-count").textContent();
  assert(hiddenSelectedCount?.includes("2 行已选"), `source selector query changes should keep selected basket, got ${hiddenSelectedCount}`);
  const hiddenSourceSummaryText = (await page.getByTestId("sales-out-source-selector-summary").textContent())?.replace(/\s+/g, " ").trim();
  assert(hiddenSourceSummaryText?.includes("当前明细：0 行"), `source selector hidden summary should use current visible rows, got ${hiddenSourceSummaryText}`);
  assert(hiddenSourceSummaryText?.includes("已选：2 行"), `source selector hidden summary should use selected basket, got ${hiddenSourceSummaryText}`);
  await confirmSalesOutSourceSelector(page);

  await page.getByTestId("sales-out-line-source-order-no").waitFor({ state: "visible" });
  const sourceOrderCell = (await page.getByTestId("sales-out-line-source-order-no").textContent())?.trim();
  const sourceLineCell = (await page.getByTestId("sales-out-line-source-line-no").textContent())?.replace(/\s+/g, " ").trim();
  assert(sourceOrderCell === source.noticeNo, `source column should show delivery notice no only, got ${sourceOrderCell}`);
  assert(sourceLineCell?.includes("#1"), `source line column should show line no, got ${sourceLineCell}`);
  assert(await page.locator(".table-core-header-cell", { hasText: "源单号" }).count() > 0, "entry table should have source order header");
  assert(await page.locator(".table-core-header-cell", { hasText: "源单行号" }).count() > 0, "entry table should have source line header");

  await openSalesOutSourceSelector(page);
  await page.getByTestId("sales-out-source-selector-search").fill(source.noticeNo);
  await page.getByTestId("sales-out-source-selector-query").click();
  await page.getByTestId("sales-out-source-selector-message").filter({ hasText: "当前过滤条件下暂无可选发货通知明细。" }).waitFor({ state: "visible" });
  const repeatedSourceSummaryText = (await page.getByTestId("sales-out-source-selector-summary").textContent())?.replace(/\s+/g, " ").trim();
  assert(repeatedSourceSummaryText?.includes("当前明细：0 行"), `reopened source selector should deduct current document allocation, got ${repeatedSourceSummaryText}`);
  assert(repeatedSourceSummaryText?.includes("已选：0 行"), `reopened source selector should start with empty basket, got ${repeatedSourceSummaryText}`);
  await page.getByTestId("sales-out-source-selector-cancel").click();

  const productOpenButton = page.getByTestId("sales-out-line-product-open-selector");
  const hiddenOpacity = await productOpenButton.evaluate((node) => getComputedStyle(node).opacity);
  await page.getByTestId("sales-out-line-product").hover();
  const hoverOpacity = await productOpenButton.evaluate((node) => getComputedStyle(node).opacity);
  assert(Number(hiddenOpacity) === 0 && Number(hoverOpacity) > 0.8, `entry selector trigger should appear on hover/focus, got ${hiddenOpacity}/${hoverOpacity}`);

  const entryHeader = page.getByTestId("entry-column-drag-productCode");
  const headerBox = await entryHeader.boundingBox();
  assert(headerBox, "entry header should have bounding box");
  await page.mouse.move(headerBox.x + 24, headerBox.y + 10);
  await page.mouse.down();
  await page.mouse.move(headerBox.x + 220, headerBox.y + 12, { steps: 8 });
  await page.getByTestId("entry-column-drag-ghost").waitFor({ state: "visible" });
  const entryGhostText = (await page.getByTestId("entry-column-drag-ghost").textContent())?.trim();
  await page.mouse.up();
  assert(entryGhostText === "物料编码", `entry table drag ghost should show title, got ${entryGhostText}`);
  const resizeHeader = page.getByTestId("entry-column-drag-warehouse");
  const widthBefore = await resizeHeader.evaluate((node) => node.closest("th")?.getBoundingClientRect().width ?? 0);
  const resizeHit = await resizeHeader.evaluate((node) => {
    const rect = (node.closest("th") ?? node).getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width - 2, rect.y + rect.height / 2);
    return {
      tag: hit?.tagName ?? "",
      className: hit instanceof HTMLElement ? hit.className : "",
      testId: hit instanceof HTMLElement ? hit.dataset.testid ?? "" : "",
      parentClassName: hit?.parentElement instanceof HTMLElement ? hit.parentElement.className : "",
      parentTestId: hit?.parentElement instanceof HTMLElement ? hit.parentElement.dataset.testid ?? "" : ""
    };
  });
  await dragColumnBoundary(page, resizeHeader, 70);
  const widthAfter = await resizeHeader.evaluate((node) => node.closest("th")?.getBoundingClientRect().width ?? 0);
  assert(widthAfter > widthBefore + 30, `entry column resize should change width, got ${widthBefore} -> ${widthAfter}; hit ${JSON.stringify(resizeHit)}`);

  await page.getByTestId("sales-out-party-open-selector").click();
  const masterSelectorDialog = page.getByTestId("master-selector-source-selector-dialog");
  await masterSelectorDialog.waitFor({ state: "visible" });
  const masterDialogMetrics = await masterSelectorDialog.locator(".source-selector-dialog").evaluate((node) => ({
    width: Math.round(node.getBoundingClientRect().width),
    height: Math.round(node.getBoundingClientRect().height),
    tableMinWidth: Math.round(node.querySelector("table")?.getBoundingClientRect().width ?? 0)
  }));
  assert(masterDialogMetrics.width >= 1000, `master selector should be large modal, got ${JSON.stringify(masterDialogMetrics)}`);
  await page.getByTestId("master-selector-source-selector-cancel").click();

  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("query-sales-order-form").click();
  await page.getByTestId("list-keyword").fill(reverse.orderNo);
  await page.getByTestId("list-query").click();
  await page.getByText(reverse.orderNo).waitFor({ state: "visible" });
  await page.locator(".vxe-body--row", { hasText: reverse.orderNo }).locator("[data-testid^='list-select-toggle-']").first().click();
  await page.getByTestId("batch-reverse").click();
  await page.getByTestId("batch-confirm-dialog").waitFor({ state: "visible" });
  await page.locator('[data-testid="batch-confirm-dialog"] .danger-action').click();
  await page.getByTestId("list-batch-message").filter({ hasText: "已反审核" }).waitFor({ state: "visible" });
  const reversedDetail = await api(`/api/sales-orders/${encodeURIComponent(reverse.orderNo)}`, { method: "GET" });
  assert(reversedDetail.order?.status === "DRAFT", `batch reverse should return order to DRAFT, got ${reversedDetail.order?.status}`);

  const screenshot = `a102-core-flow-ui-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });
  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    ok: true,
    sourceOrderNo: source.orderNo,
    sourceNoticeNo: source.noticeNo,
    deliveryLocalSourceOrderNo: deliveryLocalSource.orderNo,
    reverseOrderNo: reverse.orderNo,
    reverseNoticeNo: reverse.noticeNo,
    checks: {
      sourceHeaderInputCount,
      toolbarSourceVisible,
      headerButtonStyle,
      sourceDialogMetrics,
      sourceTableScroll,
      deliveryNoticeSelectedCount,
      deliveryNoticeSourceOrderCell,
      deliveryNoticeRepeatedSourceSummaryText,
      selectedCount,
      sourceOrderCell,
      sourceLineCell,
      repeatedSourceSummaryText,
      hiddenOpacity,
      hoverOpacity,
      entryGhostText,
      widthBefore,
      widthAfter,
      masterDialogMetrics,
      reversedStatus: reversedDetail.order?.status
    },
    screenshots: [`verification/playwright/${screenshot}`]
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
