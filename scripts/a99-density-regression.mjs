import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { clickNewDocument, openSalesOutSourceSelector } from "./helpers/document-actions.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a99-density-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const kingdeeListReference = "/Users/linzhenyue/Projects/JDY-复刻-local/01_金蝶调研/截图/采购管理/采购报表H3/2034_purchase-detail-report-query-result.png";
const kingdeeEntryReference = "/Users/linzhenyue/Projects/JDY-复刻-local/01_金蝶调研/截图/采购管理/采购H3/1434_采购申请_新增单据首屏态.png";
const denseTableRowMinHeight = 20;
const denseTableRowMaxHeight = 22.5;
const businessListRowMinHeight = 30;
const businessListRowMaxHeight = 33;
const documentEntryRowMinHeight = 30;
const documentEntryRowMaxHeight = 33;

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
    { productCode: "CP-001", warehouseCode: "CK-001", qty: 3, unitPrice: 86, lineRemark: "A99 row 1", planDeliveryDate: "2026-07-03" },
    { productCode: "PJ-014", warehouseCode: "CK-002", qty: 2, unitPrice: 12, lineRemark: "A99 row 2", planDeliveryDate: "2026-07-04" }
  ];
  for (const line of lines) {
    await api("/api/inventory/adjustments", {
      body: {
        productCode: line.productCode,
        warehouseCode: line.warehouseCode,
        qtyDelta: 100,
        txnType: "A99_DENSITY_IN",
        sourceBillType: `A99:${batch}`
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
      remark: `A99 density ${batch}`,
      lines
    }
  });
  const billNo = generatedBillNo(savedOrder, "XSDD", "A99 sales order");
  await api(`/api/sales-orders/${encodeURIComponent(billNo)}/audit`);
  const savedNotice = await api("/api/delivery-notices/draft", {
    body: {
      billNo: null,
      sourceOrderNo: billNo,
      customerCode: "KH-001",
      billDate: "2026-06-26",
      department: "销售部",
      ownerName: "本地管理员",
      remark: `A99 notice ${batch}`,
      lines: lines.map((line, index) => ({ ...line, sourceOrderNo: billNo, sourceLineNo: index + 1 }))
    }
  });
  const noticeNo = generatedBillNo(savedNotice, "FHTZD", "A99 delivery notice");
  await api(`/api/delivery-notices/${encodeURIComponent(noticeNo)}/audit`);
  return { orderNo: billNo, noticeNo };
}

async function heightStats(page, selector) {
  return page.locator(selector).evaluateAll((nodes) => nodes
    .filter((node) => {
      function hasHiddenAncestor(element) {
        let current = element;
        while (current && current instanceof HTMLElement) {
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
            return true;
          }
          current = current.parentElement;
        }
        return false;
      }
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !hasHiddenAncestor(node);
    })
    .map((node) => {
      const rect = node.getBoundingClientRect();
      return Math.round(rect.height * 10) / 10;
    }));
}

async function firstHeight(page, selector) {
  const heights = await waitForHeights(page, selector);
  return heights[0];
}

async function waitForHeights(page, selector) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const heights = await heightStats(page, selector);
    if (heights.length > 0) {
      return heights;
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`no visible rows for ${selector}`);
}

async function markDocumentRoot(page, billNoTestId, billNo, marker) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const marked = await page.evaluate(({ billNoTestId, billNo, marker }) => {
      document.querySelectorAll("[data-a99-root]").forEach((node) => node.removeAttribute("data-a99-root"));
      const inputs = Array.from(document.querySelectorAll(`[data-testid="${billNoTestId}"]`));
      const input = inputs.find((node) => node instanceof HTMLInputElement && node.value === billNo);
      const root = input?.closest(".business-page");
      if (!root) {
        return false;
      }
      root.setAttribute("data-a99-root", marker);
      return true;
    }, { billNoTestId, billNo, marker });
    if (marked) {
      return;
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`document root should be found for ${billNo}`);
}

const source = await createAuditedOrder();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);

  const quickEntryHeight = await firstHeight(page, ".quick-entry");
  assert(quickEntryHeight <= 36, `home quick entry should be compact row, got ${quickEntryHeight}`);

  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("query-sales-order-form").click();
  await page.getByTestId("list-keyword").fill(source.orderNo);
  await page.getByTestId("list-query").click();
  await page.getByTestId(`open-document-${source.orderNo}`).waitFor({ state: "visible" });

  const listRowHeights = await waitForHeights(page, ".vxe-wrap .vxe-body--row");
  const listHeaderHeight = await firstHeight(page, ".vxe-wrap .vxe-header--row");
  const listToolbarHeight = await firstHeight(page, ".list-toolbar");
  const moreVisible = await page.getByTestId("list-more-actions").isVisible();
  assert(listRowHeights.length >= 1, "list should render at least one row");
  assert(
    Math.max(...listRowHeights) <= businessListRowMaxHeight && Math.min(...listRowHeights) >= businessListRowMinHeight,
    `business list rows should match the shared 32px document-entry contract, got ${listRowHeights.join(",")}`
  );
  assert(listHeaderHeight <= 29, `list header should match shared table header density around 28px, got ${listHeaderHeight}`);
  assert(listToolbarHeight <= 34, `list toolbar should be compact, got ${listToolbarHeight}`);
  assert(moreVisible, "list more actions menu trigger should be visible");
  const listScreenshot = `a99-density-list-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, listScreenshot), fullPage: true });

  await page.getByTestId(`open-document-${source.orderNo}`).click();
  await page.getByTestId("sales-line-product").waitFor({ state: "visible" });
  await markDocumentRoot(page, "sales-bill-no", source.orderNo, "a99-audited-root");
  const auditedEntryHeights = await waitForHeights(page, '[data-a99-root="a99-audited-root"] [data-testid="sales-entry-row"]');
  assert(
    Math.max(...auditedEntryHeights) <= documentEntryRowMaxHeight && Math.min(...auditedEntryHeights) >= documentEntryRowMinHeight,
    `audited document entry rows should keep the shared 32px document contract, got ${auditedEntryHeights.join(",")}`
  );
  const formScreenshot = `a99-density-audited-entry-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, formScreenshot), fullPage: true });

  await page.getByTestId("tab-sales-order-form-list").click();
  await page.getByTestId("list-create").click();
  await page.getByTestId("sales-line-product").waitFor({ state: "visible" });
  const draftEntryHeights = await waitForHeights(page, '[data-testid="sales-entry-row"]');
  assert(
    Math.max(...draftEntryHeights) <= documentEntryRowMaxHeight && Math.min(...draftEntryHeights) >= documentEntryRowMinHeight,
    `draft document entry rows should keep the shared 32px editing contract, got ${draftEntryHeights.join(",")}`
  );

  await page.getByTestId("sales-line-product-open-selector").click();
  await page.getByTestId("master-selector-source-selector-dialog").waitFor({ state: "visible" });
  const masterDialogRows = await waitForHeights(page, '[data-testid="master-selector-source-selector-dialog"] .vxe-body--row');
  assert(masterDialogRows.length >= 1, "master selector should render rows");
  assert(
    Math.max(...masterDialogRows) <= denseTableRowMaxHeight && Math.min(...masterDialogRows) >= denseTableRowMinHeight,
    `master selector rows should keep 20-22px high-density contract, got ${masterDialogRows.join(",")}`
  );
  await page.getByTestId("master-selector-source-selector-cancel").click();

  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("entry-sales-out-form").click();
  await clickNewDocument(page);
  await page.getByTestId("sales-out-party-code").fill("KH-001");
  await openSalesOutSourceSelector(page);
  await page.getByTestId("sales-out-source-selector-search").fill(source.noticeNo);
  await page.getByTestId("sales-out-source-selector-query").click();
  await page.locator(".source-selector-table tbody tr", { hasText: source.noticeNo }).first().waitFor({ state: "visible" });
  const sourceSelectorRows = await waitForHeights(page, ".source-selector-table tbody tr");
  assert(
    Math.max(...sourceSelectorRows) <= denseTableRowMaxHeight && Math.min(...sourceSelectorRows) >= denseTableRowMinHeight,
    `source selector rows should keep 20-22px high-density contract, got ${sourceSelectorRows.join(",")}`
  );
  const sourceScreenshot = `a99-density-source-selector-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, sourceScreenshot), fullPage: true });

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    ok: true,
    sourceOrderNo: source.orderNo,
    sourceNoticeNo: source.noticeNo,
    checks: {
      quickEntryHeight,
      listRowHeights,
      listHeaderHeight,
      listToolbarHeight,
      moreVisible,
      auditedEntryHeights,
      draftEntryHeights,
      masterDialogRows,
      sourceSelectorRows
    },
    kingdeeReferences: {
      list: kingdeeListReference,
      entry: kingdeeEntryReference
    },
    screenshots: {
      list: `verification/playwright/${listScreenshot}`,
      auditedEntry: `verification/playwright/${formScreenshot}`,
      sourceSelector: `verification/playwright/${sourceScreenshot}`
    }
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
