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

async function createAuditedOrder() {
  const billNo = `XSDD-A99-${batch}`;
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
  await api("/api/sales-orders/draft", {
    body: {
      billNo,
      customerCode: "KH-001",
      billDate: "2026-06-26",
      department: "销售部",
      ownerName: "本地管理员",
      remark: `A99 density ${batch}`,
      lines
    }
  });
  await api(`/api/sales-orders/${encodeURIComponent(billNo)}/audit`);
  const noticeNo = `FHTZ-A99-${batch}`;
  await api("/api/delivery-notices/draft", {
    body: {
      billNo: noticeNo,
      sourceOrderNo: billNo,
      customerCode: "KH-001",
      billDate: "2026-06-26",
      department: "销售部",
      ownerName: "本地管理员",
      remark: `A99 notice ${batch}`,
      lines: lines.map((line, index) => ({ ...line, sourceOrderNo: billNo, sourceLineNo: index + 1 }))
    }
  });
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
  assert(Math.max(...listRowHeights) <= 32.5 && Math.min(...listRowHeights) >= 30, `list rows should match document entry density around 32px, got ${listRowHeights.join(",")}`);
  assert(listHeaderHeight <= 29, `list header should match shared table header density around 28px, got ${listHeaderHeight}`);
  assert(listToolbarHeight <= 34, `list toolbar should be compact, got ${listToolbarHeight}`);
  assert(moreVisible, "list more actions menu trigger should be visible");
  const listScreenshot = `a99-density-list-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, listScreenshot), fullPage: true });

  await page.getByTestId(`open-document-${source.orderNo}`).click();
  await page.getByTestId("sales-line-product").waitFor({ state: "visible" });
  await markDocumentRoot(page, "sales-bill-no", source.orderNo, "a99-audited-root");
  const auditedEntryHeights = await waitForHeights(page, '[data-a99-root="a99-audited-root"] [data-testid="sales-entry-row"]');
  assert(Math.max(...auditedEntryHeights) <= 32.5 && Math.min(...auditedEntryHeights) >= 30, `audited entry rows should match list density around 32px, got ${auditedEntryHeights.join(",")}`);
  const formScreenshot = `a99-density-audited-entry-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, formScreenshot), fullPage: true });

  await page.getByTestId("tab-sales-order-form-list").click();
  await page.getByTestId("list-create").click();
  await page.getByTestId("sales-line-product").waitFor({ state: "visible" });
  const draftEntryHeights = await waitForHeights(page, '[data-testid="sales-entry-row"]');
  assert(Math.max(...draftEntryHeights) <= 33, `draft entry rows may expand only for editing, got ${draftEntryHeights.join(",")}`);
  assert(Math.max(...draftEntryHeights) >= 26, `draft entry rows should preserve editable input height, got ${draftEntryHeights.join(",")}`);

  await page.getByTestId("sales-line-product-open-selector").click();
  await page.getByTestId("master-selector-dialog").waitFor({ state: "visible" });
  const masterDialogRows = await waitForHeights(page, ".master-selector-dialog__table tbody tr");
  assert(masterDialogRows.length >= 1, "master selector should render rows");
  assert(Math.max(...masterDialogRows) <= 22.5, `master selector rows should be 20-22px, got ${masterDialogRows.join(",")}`);
  await page.getByTestId("master-selector-cancel").click();

  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("entry-sales-out-form").click();
  await clickNewDocument(page);
  await page.getByTestId("sales-out-party-code").fill("KH-001");
  await openSalesOutSourceSelector(page);
  await page.getByTestId("sales-out-source-selector-search").fill(source.noticeNo);
  await page.locator(".source-selector-table tbody tr", { hasText: source.noticeNo }).first().waitFor({ state: "visible" });
  const sourceSelectorRows = await waitForHeights(page, ".source-selector-table tbody tr");
  assert(Math.max(...sourceSelectorRows) <= 22.5, `source selector rows should be 20-22px, got ${sourceSelectorRows.join(",")}`);
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
