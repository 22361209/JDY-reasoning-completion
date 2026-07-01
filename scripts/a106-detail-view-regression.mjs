import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a106-detail-view-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-26";
const kingdeeReference = "/Users/linzhenyue/Projects/JDY-复刻-local/01_金蝶调研/截图清单.md:2118";

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
  const billNo = `XSDD-A106-${batch}`;
  await api("/api/sales-orders/draft", {
    body: {
      billNo,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      remark: `A106 detail view ${batch}`,
      lines: [
        { productCode: "CP-001", warehouseCode: "CK-001", qty: 3, unitPrice: 86, taxRate: 13, customerMaterialCode: `KHWL-A106-${batch}-1`, lineRemark: "A106 line 1", planDeliveryDate: "2026-07-03" },
        { productCode: "PJ-014", warehouseCode: "CK-002", qty: 2, unitPrice: 12, taxRate: 13, customerMaterialCode: `KHWL-A106-${batch}-2`, lineRemark: "A106 line 2", planDeliveryDate: "2026-07-04" }
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

async function dragColumnWidth(page, field) {
  const header = page.getByTestId(`column-drag-${field}`).first();
  const box = await header.boundingBox();
  assert(box, `column ${field} should be visible before resize`);
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 48, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
}

async function toolbarSignature(page) {
  return page.locator(".list-toolbar .list-toolbar-actions button").evaluateAll((buttons) => buttons.map((button) => ({
    testId: button.getAttribute("data-testid"),
    label: button.textContent?.trim(),
    disabled: button.hasAttribute("disabled")
  })));
}

const billNo = await createAuditedSalesOrder();
const headerRows = await fetchList("sales-order-form-list", { keyword: billNo, view: "header" });
const detailRows = await fetchList("sales-order-form-list", { keyword: billNo, view: "detail" });
const filteredDetailRows = await fetchList("sales-order-form-list", {
  keyword: billNo,
  view: "detail",
  columnFilters: { productCode: { operator: "等于", value: "CP-001" } }
});

assert(headerRows.view === "header", "header list should report header view");
assert(headerRows.total === 1, `header view should return one bill row, got ${headerRows.total}`);
assert(headerRows.rows[0].customerCode === "KH-001", "header view should expose customer code");
assert(!Object.hasOwn(headerRows.rows[0], "customerMaterialCode"), "header view should not expose customer material code");
assert(headerRows.rows[0].billDate === billDate, "header view should use billDate as document date");
assert(headerRows.rows[0].planDeliveryDate === "2026-07-03", "header view should expose earliest expected delivery date");
assert(detailRows.view === "detail", "detail list should report detail view");
assert(detailRows.total === 2, `detail view should return one row per entry, got ${detailRows.total}`);
assert(detailRows.rows.every((row) => row.billNo === billNo), "detail rows should carry header bill number");
assert(detailRows.rows.every((row) => row.customerCode === "KH-001"), "detail rows should expose customer code");
assert(detailRows.rows.every((row) => row.billDate === billDate), "detail rows should carry header bill date");
assert(detailRows.rows.every((row) => row.partner === "广州测试客户"), "detail rows should carry customer header");
assert(detailRows.rows.some((row) => row.customerMaterialCode === `KHWL-A106-${batch}-1` && row.planDeliveryDate === "2026-07-03"), "detail rows should include customer material code and expected delivery date");
assert(detailRows.rows.some((row) => row.productCode === "CP-001" && row.warehouse === "成品仓"), "detail rows should include line product and warehouse");
assert(detailRows.rows.some((row) => row.productCode === "PJ-014" && row.warehouse === "原料仓"), "detail rows should include second entry line");
assert(filteredDetailRows.total === 1, `detail column filter should apply to entry rows, got ${filteredDetailRows.total}`);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const screenshots = [];

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("query-sales-order-form").click();
  await page.getByTestId("list-keyword").fill(billNo);
  await page.getByTestId("list-query").click();
  await page.getByTestId(`open-document-${billNo}`).waitFor({ state: "visible" });

  const headerCount = await page.locator(".vxe-wrap .vxe-body--row").count();
  assert(headerCount === 1, `UI header view should render one row, got ${headerCount}`);
  const headerToolbar = await toolbarSignature(page);

  await page.getByTestId("list-detail-view-toggle").click();
  await page.getByTestId("column-drag-productCode").waitFor({ state: "visible" });
  const detailToolbar = await toolbarSignature(page);
  assert(
    JSON.stringify(detailToolbar.map(({ testId, label }) => ({ testId, label }))) === JSON.stringify(headerToolbar.map(({ testId, label }) => ({ testId, label }))),
    `header/detail toolbar actions should keep the same order and labels, header=${JSON.stringify(headerToolbar)}, detail=${JSON.stringify(detailToolbar)}`
  );
  await page.getByTestId("column-drag-customerCode").waitFor({ state: "visible" });
  await page.getByTestId("column-drag-customerMaterialCode").waitFor({ state: "visible" });
  await page.getByTestId("column-drag-planDeliveryDate").waitFor({ state: "visible" });
  await page.locator(".vxe-wrap", { hasText: "CP-001" }).waitFor({ state: "visible" });
  await page.locator(".vxe-wrap", { hasText: "PJ-014" }).waitFor({ state: "visible" });
  await page.getByTestId("column-settings").click();
  await page.getByTestId("column-settings-dialog").waitFor({ state: "visible" });
  await page.getByTestId("column-settings-ok").click();
  await page.getByTestId("column-filter-productCode").first().click();
  await page.getByTestId("column-filter-dialog").waitFor({ state: "visible" });
  await page.getByTestId("column-filter-input").fill("CP-001");
  await page.getByTestId("column-filter-ok").click();
  await page.locator(".vxe-wrap", { hasText: "CP-001" }).waitFor({ state: "visible" });
  await page.locator(".vxe-wrap", { hasText: "PJ-014" }).waitFor({ state: "hidden" });
  await dragColumnWidth(page, "productCode");
  await page.getByTestId("column-filter-productCode").first().click();
  await page.getByTestId("column-filter-dialog").waitFor({ state: "visible" });
  await page.getByTestId("column-filter-dialog").getByRole("button", { name: "重置" }).click();
  await page.getByTestId("column-filter-dialog").waitFor({ state: "hidden" });
  await page.locator(".vxe-wrap", { hasText: "CP-001" }).waitFor({ state: "visible" });
  await page.locator(".vxe-wrap", { hasText: "PJ-014" }).waitFor({ state: "visible" });
  await page.locator(".vxe-wrap .vxe-body--row").first().locator('[role="checkbox"]').click();
  const reverseButton = page.getByTestId("batch-reverse");
  assert(await reverseButton.isEnabled(), "detail view selected audited line should enable document-level reverse audit");
  await reverseButton.click();
  await page.getByTestId("batch-confirm-dialog").waitFor({ state: "visible" });
  await page.getByTestId("batch-confirm-dialog").getByRole("button", { name: "确定" }).click();
  await page.getByTestId("list-batch-message").waitFor({ state: "visible" });
  const reverseMessage = await page.getByTestId("list-batch-message").innerText();
  assert(reverseMessage.includes("已反审核 1 张单据"), `detail reverse should dedupe selected lines by billNo, got: ${reverseMessage}`);
  const reversedRows = await fetchList("sales-order-form-list", { keyword: billNo, view: "header" });
  assert(reversedRows.rows[0].status === "草稿", `detail reverse should return document to draft, got ${reversedRows.rows[0].status}`);

  const detailScreenshot = `a106-detail-view-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, detailScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${detailScreenshot}`);

  await page.getByTestId("list-detail-view-toggle").click();
  await page.getByTestId("column-drag-productCode").waitFor({ state: "hidden" });
  const restoredHeaderCount = await page.locator(".vxe-wrap .vxe-body--row").count();
  assert(await page.getByTestId("column-drag-productCode").count() === 0, "header view should restore header columns and hide detail productCode column");

  const paginationVisible = await page.locator(".list-pagination").isVisible();
  assert(paginationVisible, "pagination should remain visible in detail view workflow");

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    ok: true,
    billNo,
    checks: {
      headerTotal: headerRows.total,
      detailTotal: detailRows.total,
      filteredDetailTotal: filteredDetailRows.total,
      headerCount,
      restoredHeaderCount,
      paginationVisible,
      toolbarParity: true,
      detailReverseEnabled: true,
      reverseMessage
    },
    detailRows: detailRows.rows,
    kingdeeReference,
    screenshots
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
