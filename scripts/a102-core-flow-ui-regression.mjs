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
  const billNo = `XSDD-A102-${label}-${batch}`;
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
  await api("/api/sales-orders/draft", {
    body: {
      billNo,
      customerCode: "KH-001",
      billDate: "2026-06-26",
      department: "销售部",
      ownerName: "本地管理员",
      remark: `A102 ${label}`,
      lines
    }
  });
  await api(`/api/sales-orders/${encodeURIComponent(billNo)}/audit`);
  if (!withNotice) {
    return { orderNo: billNo, noticeNo: "" };
  }
  const noticeNo = `FHTZ-A102-${label}-${batch}`;
  await api("/api/delivery-notices/draft", {
    body: {
      billNo: noticeNo,
      sourceOrderNo: billNo,
      customerCode: "KH-001",
      billDate: "2026-06-26",
      department: "销售部",
      ownerName: "本地管理员",
      remark: `A102 notice ${label}`,
      lines: lines.map((line, index) => ({ ...line, sourceOrderNo: billNo, sourceLineNo: index + 1 }))
    }
  });
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

const source = await createAuditedSalesOrder("SRC", true);
const reverse = await createAuditedSalesOrder("REV");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);

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
    height: Math.round(node.getBoundingClientRect().height)
  }));
  assert(sourceDialogMetrics.width >= 1000, `source selector should be large modal, got ${JSON.stringify(sourceDialogMetrics)}`);

  await page.getByTestId("sales-out-source-selector-search").fill(source.noticeNo);
  await page.locator(".source-selector-table tbody tr", { hasText: source.noticeNo }).first().waitFor({ state: "visible" });
  const sourceTableScroll = await page.locator(".source-selector-table").evaluate((node) => ({
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
    overflowX: getComputedStyle(node).overflowX
  }));
  assert(sourceTableScroll.scrollWidth > sourceTableScroll.clientWidth, `source selector needs horizontal scroll, got ${JSON.stringify(sourceTableScroll)}`);
  await page.getByTestId("sales-out-source-selector-select-all").click();
  const selectedCount = await page.getByTestId("sales-out-source-selector-count").textContent();
  assert(selectedCount?.includes("2 行已选"), `source selector select all should select visible lines, got ${selectedCount}`);
  await page.getByTestId("sales-out-source-selector-column-settings").click();
  await page.getByTestId("sales-out-source-selector-column-settings-dialog").waitFor({ state: "visible" });
  await page.locator(".column-setting-row").filter({ hasText: "单价" }).locator('input[type="checkbox"]').uncheck();
  await page.getByTestId("sales-out-source-selector-column-settings-ok").click();
  assert(await page.locator(".source-selector-table th", { hasText: "单价" }).count() === 0, "source selector column settings should hide selected column");
  await confirmSalesOutSourceSelector(page);

  await page.getByTestId("sales-out-line-source-order-no").waitFor({ state: "visible" });
  const sourceOrderCell = (await page.getByTestId("sales-out-line-source-order-no").textContent())?.trim();
  const sourceLineCell = (await page.getByTestId("sales-out-line-source-line-no").textContent())?.replace(/\s+/g, " ").trim();
  assert(sourceOrderCell === source.noticeNo, `source column should show delivery notice no only, got ${sourceOrderCell}`);
  assert(sourceLineCell?.includes("#1"), `source line column should show line no, got ${sourceLineCell}`);
  assert(await page.locator(".table-core-header-cell", { hasText: "源单号" }).count() > 0, "entry table should have source order header");
  assert(await page.locator(".table-core-header-cell", { hasText: "源单行号" }).count() > 0, "entry table should have source line header");

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
  assert(entryGhostText === "商品编码", `entry table drag ghost should show title, got ${entryGhostText}`);
  const widthBefore = (await page.getByTestId("sales-out-line-source-order-no").boundingBox())?.width ?? 0;
  await drag(page, page.getByTestId("entry-column-resize-sourceOrderNo"), 70);
  const widthAfter = (await page.getByTestId("sales-out-line-source-order-no").boundingBox())?.width ?? 0;
  assert(widthAfter > widthBefore + 30, `entry column resize should change width, got ${widthBefore} -> ${widthAfter}`);

  await page.getByTestId("sales-out-party-open-selector").click();
  await page.getByTestId("master-selector-dialog").waitFor({ state: "visible" });
  const masterDialogMetrics = await page.locator(".master-selector-dialog").evaluate((node) => ({
    width: Math.round(node.getBoundingClientRect().width),
    height: Math.round(node.getBoundingClientRect().height),
    tableMinWidth: Math.round(node.querySelector("table")?.getBoundingClientRect().width ?? 0)
  }));
  assert(masterDialogMetrics.width >= 1000, `master selector should be large modal, got ${JSON.stringify(masterDialogMetrics)}`);
  await page.getByTestId("master-selector-cancel").click();

  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("query-sales-order-form").click();
  await page.getByTestId("list-keyword").fill(reverse.orderNo);
  await page.getByTestId("list-query").click();
  await page.getByText(reverse.orderNo).waitFor({ state: "visible" });
  await page.locator(".vxe-body--row", { hasText: reverse.orderNo }).locator(".vxe-checkbox--icon").first().click({ force: true });
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
    reverseOrderNo: reverse.orderNo,
    reverseNoticeNo: reverse.noticeNo,
    checks: {
      sourceHeaderInputCount,
      toolbarSourceVisible,
      headerButtonStyle,
      sourceDialogMetrics,
      sourceTableScroll,
      selectedCount,
      sourceOrderCell,
      sourceLineCell,
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
