import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a107-table-structure-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
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
  const billNo = `XSDD-A107-${batch}`;
  await api("/api/sales-orders/draft", {
    body: {
      billNo,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      remark: `A107 table structure ${batch}`,
      lines: [
        { productCode: "CP-001", warehouseCode: "CK-001", qty: 3, unitPrice: 86, taxRate: 13, lineRemark: "A107 line 1", planDeliveryDate: "2026-07-03" },
        { productCode: "PJ-014", warehouseCode: "CK-002", qty: 2, unitPrice: 12, taxRate: 13, lineRemark: "A107 line 2", planDeliveryDate: "2026-07-04" }
      ]
    }
  });
  await api(`/api/sales-orders/${encodeURIComponent(billNo)}/audit`);
  return billNo;
}

async function fetchList(listKey, query) {
  const search = new URLSearchParams({
    keyword: query.keyword ?? "",
    status: query.status ?? "",
    page: String(query.page ?? 1),
    pageSize: String(query.pageSize ?? 200),
    view: query.view ?? "header"
  });
  if (query.columnFilters) {
    search.set("columnFilters", JSON.stringify(query.columnFilters));
  }
  return api(`/api/lists/${encodeURIComponent(listKey)}?${search.toString()}`, { method: "GET" });
}

async function borderRightStyle(locator) {
  return locator.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      width: style.borderRightWidth,
      style: style.borderRightStyle,
      color: style.borderRightColor
    };
  });
}

function hasVisibleBorder(border) {
  return border.style !== "none" && Number.parseFloat(border.width) >= 1 && !border.color.includes("rgba(0, 0, 0, 0)");
}

const billNo = await createAuditedSalesOrder();
const detailRows = await fetchList("sales-order-form-list", { keyword: billNo, view: "detail" });
assert(detailRows.total === 2, `detail view should return two rows, got ${detailRows.total}`);
assert(detailRows.rows.every((row) => row.billNo === billNo), "detail rows should bind non-empty header billNo");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);

  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("query-sales-order-form").click();
  await page.getByTestId("list-keyword").fill(billNo);
  await page.getByTestId("list-query").click();
  await page.getByTestId(`open-document-${billNo}`).waitFor({ state: "visible" });

  const firstListHeaders = await page.locator(".vxe-wrap .vxe-header--column:visible").evaluateAll((nodes) => nodes.slice(0, 4).map((node) => ({
    text: node.textContent?.trim() ?? "",
    fixed: node.classList.contains("col--fixed"),
    checkbox: node.className.includes("col--checkbox"),
    seq: node.className.includes("col--seq")
  })));
  assert(firstListHeaders[0]?.fixed && firstListHeaders[0]?.checkbox, `list first column should be fixed checkbox: ${JSON.stringify(firstListHeaders)}`);
  assert(!firstListHeaders.some((header) => header.seq || header.text.includes("序号")), `list should not render sequence column after A112: ${JSON.stringify(firstListHeaders)}`);
  assert(firstListHeaders[1]?.text.includes("单据编号"), `list second visible column should be bill number after checkbox: ${JSON.stringify(firstListHeaders)}`);

  await page.getByTestId("list-detail-view-toggle").click();
  await page.getByTestId("column-drag-productCode").waitFor({ state: "visible" });
  await page.locator(".vxe-wrap", { hasText: billNo }).waitFor({ state: "visible" });
  const uiBillNoText = await page.getByTestId(`open-document-${billNo}`).first().textContent();
  assert(uiBillNoText?.trim() === billNo, `detail view billNo cell should be non-empty and bound, got ${uiBillNoText}`);
  const listGridBorder = await borderRightStyle(page.locator(".vxe-wrap .vxe-body--column:visible").nth(1));
  assert(hasVisibleBorder(listGridBorder), `list columns should show vertical grid line: ${JSON.stringify(listGridBorder)}`);

  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("entry-sales-out-form").click();
  await page.getByTestId("new-document").click();
  await page.getByTestId("sales-out-party-code").fill("KH-001");
  await page.getByTestId("sales-out-line-product").fill("CP-001");
  await page.getByTestId("sales-out-line-warehouse").fill("CK-001");
  await page.getByTestId("sales-out-line-qty").fill("1");
  await page.getByTestId("add-document-line").click();
  await page.getByTestId("sales-out-line-product-2").fill("PJ-014");
  await page.getByTestId("sales-out-line-warehouse-2").fill("CK-002");
  await page.getByTestId("sales-out-line-qty-2").fill("1");

  const entryHeaders = await page.locator(".entry-table thead th:visible").evaluateAll((nodes) => nodes.slice(0, 4).map((node) => ({
    text: node.textContent?.trim() ?? "",
    sticky: getComputedStyle(node).position,
    left: getComputedStyle(node).left,
    checkbox: Boolean(node.querySelector('input[type="checkbox"]')),
    testId: node.getAttribute("data-testid")
  })));
  assert(entryHeaders[0]?.checkbox && entryHeaders[0]?.sticky === "sticky" && entryHeaders[0]?.left === "0px", `entry first column should be fixed select-all checkbox: ${JSON.stringify(entryHeaders)}`);
  assert(entryHeaders[1]?.text.includes("序号") && entryHeaders[1]?.sticky === "sticky", `entry second column should be fixed row number: ${JSON.stringify(entryHeaders)}`);
  assert(await page.getByTestId("entry-select-all").isVisible(), "entry selection header should use select-all checkbox without text title");
  await page.getByTestId("entry-select-all").check();
  assert(await page.getByTestId("sales-out-line-select").isChecked(), "entry select-all should select first line");
  assert(await page.getByTestId("sales-out-line-select-2").isChecked(), "entry select-all should select second line");

  const rowNo = await page.getByTestId("sales-out-line-row-no").textContent();
  assert(rowNo?.trim() === "1", `entry second column should render row number, got ${rowNo}`);
  const entryGridBorder = await borderRightStyle(page.locator(".entry-table tbody tr[data-testid='sales-out-entry-row'] td:visible").nth(1));
  assert(hasVisibleBorder(entryGridBorder), `entry table columns should show vertical grid line: ${JSON.stringify(entryGridBorder)}`);

  const productHeader = page.getByTestId("entry-column-drag-productCode");
  const productHeaderBox = await productHeader.boundingBox();
  const productFilterBox = await page.getByTestId("entry-column-filter-productCode").boundingBox();
  assert(productHeaderBox && productFilterBox, "entry product filter and header should have boxes");
  assert(productFilterBox.x + productFilterBox.width >= productHeaderBox.x + productHeaderBox.width - 16, `entry filter button should be right aligned: ${JSON.stringify({ productHeaderBox, productFilterBox })}`);

  const screenshot = `a107-table-structure-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });
  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    ok: true,
    billNo,
    checks: {
      detailApiBillNoRows: detailRows.rows.map((row) => row.billNo),
      firstListHeaders,
      uiBillNoText,
      listGridBorder,
      entryHeaders,
      rowNo,
      entryGridBorder,
      productHeaderBox,
      productFilterBox
    },
    screenshots: [`verification/playwright/${screenshot}`]
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
