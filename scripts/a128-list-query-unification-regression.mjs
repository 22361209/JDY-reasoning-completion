#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { installApiSession, loginApi, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const apiBase = "http://127.0.0.1:8080";
const frontendUrl = "http://127.0.0.1:5173/";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const evidenceDir = path.join(rootDir, "verification");
const screenshotDir = path.join(evidenceDir, "playwright");
const resultPath = path.join(evidenceDir, `a128-list-query-unification-${batch}.json`);

await mkdir(evidenceDir, { recursive: true });
await mkdir(screenshotDir, { recursive: true });
await installApiSession(apiBase);
const warehouseCookie = await loginApi(apiBase, "warehouse", "warehouse123", "BLD-TEST");

const evidence = {
  batch,
  generatedAt: new Date().toISOString(),
  assertions: [],
  screenshots: []
};

function shanghaiDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

function monthRange(year, month) {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  const iso = (value) => value.toISOString().slice(0, 10);
  return { from: iso(start), to: iso(end) };
}

function shiftMonth(year, month, offset) {
  const date = new Date(Date.UTC(year, month - 1 + offset, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

const shanghaiToday = shanghaiDateParts();
const currentMonth = monthRange(shanghaiToday.year, shanghaiToday.month);
const previousMonthParts = shiftMonth(shanghaiToday.year, shanghaiToday.month, -1);
const previousMonth = monthRange(previousMonthParts.year, previousMonthParts.month);
const previousQuarterEndMonth = Math.floor((shanghaiToday.month - 1) / 3) * 3;
const previousQuarterStartMonth = previousQuarterEndMonth - 2;
const previousQuarter = previousQuarterEndMonth === 0
  ? { from: `${shanghaiToday.year - 1}-10-01`, to: `${shanghaiToday.year - 1}-12-31` }
  : { from: monthRange(shanghaiToday.year, previousQuarterStartMonth).from, to: monthRange(shanghaiToday.year, previousQuarterEndMonth).to };

function assert(condition, message, details = undefined) {
  if (!condition) {
    const suffix = details ? ` ${JSON.stringify(details)}` : "";
    throw new Error(`${message}${suffix}`);
  }
  evidence.assertions.push({ ok: true, message, details });
}

function generatedSalesOrderNo(row, label) {
  const value = String(row?.billNo ?? "");
  assert(/^XSDD\d{6}$/.test(value), `${label} should return a system sales order number`, row);
  return value;
}

async function api(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "POST",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let data = null;
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!response.ok && !options.expectFailure) {
    throw new Error(`${options.method ?? "POST"} ${pathname} failed ${response.status}: ${text}`);
  }
  return { ok: response.ok, status: response.status, data, text };
}

async function removeSalesOrder(billNo) {
  if (!billNo) return;
  const detail = await api(`/api/sales-orders/${encodeURIComponent(billNo)}`, { method: "GET" });
  if (detail.status === 404) return;
  if (!detail.ok) throw new Error(`A128 cleanup could not read sales order ${billNo}`);
  const status = detail.data?.order?.status ?? detail.data?.document?.status;
  if (status === "AUDITED") await api(`/api/sales-orders/${encodeURIComponent(billNo)}/reverse`);
  if (status !== "DRAFT" && status !== "AUDITED") throw new Error(`A128 cleanup refuses sales order ${billNo} in ${status}`);
  const deleted = await api(`/api/sales-orders/${encodeURIComponent(billNo)}`, { method: "DELETE" });
  if (!deleted.ok) throw new Error(`A128 cleanup could not delete sales order ${billNo}`);
  const residue = await api(`/api/sales-orders/${encodeURIComponent(billNo)}`, { method: "GET", expectFailure: true });
  if (residue.status !== 404) throw new Error(`A128 cleanup left sales order ${billNo}`);
}

function salesOrderPayload(billNo, billDate, remark, qty = 1) {
  return {
    billNo,
    customerCode: "KH-001",
    billDate,
    department: "销售部",
    ownerName: "本地管理员",
    remark,
    lines: [{
      productCode: "CP-001",
      warehouseCode: "CK-001",
      qty,
      unitPrice: 86,
      lineRemark: remark,
      planDeliveryDate: billDate
    }]
  };
}

async function currentViewToggleText(page) {
  const toggle = page.getByTestId("list-detail-view-toggle");
  if (!(await toggle.isVisible({ timeout: 1000 }).catch(() => false))) {
    return "";
  }
  return (await toggle.innerText()).trim();
}

async function ensureHeaderView(page) {
  if (await currentViewToggleText(page) === "整单视图") {
    await page.getByTestId("list-detail-view-toggle").click();
  }
}

async function ensureDetailView(page) {
  if (await currentViewToggleText(page) === "明细视图") {
    await page.getByTestId("list-detail-view-toggle").click();
  }
}

async function buttonBox(page, testId) {
  return page.getByTestId(testId).evaluate((node) => {
    const style = window.getComputedStyle(node);
    return {
      height: style.height,
      borderTopWidth: style.borderTopWidth,
      borderTopColor: style.borderTopColor,
      backgroundColor: style.backgroundColor,
      borderRadius: style.borderRadius,
      fontSize: style.fontSize
    };
  });
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const screenshot = path.join(screenshotDir, `a128-list-query-unification-${batch}.png`);
let julyBillNo = "";
let juneBillNo = "";

try {
  const julyDraft = await api("/api/sales-orders/draft", { body: salesOrderPayload(null, currentMonth.from, `A128KEY ${batch} current month`) });
  assert(julyDraft.ok, "A128 current-month sales order should be created", julyDraft.data);
  julyBillNo = generatedSalesOrderNo(julyDraft.data, "A128 current-month sales order");
  const juneDraft = await api("/api/sales-orders/draft", { body: salesOrderPayload(null, previousMonth.from, `A128KEY ${batch} previous month`) });
  assert(juneDraft.ok, "A128 previous-month sales order should be created", juneDraft.data);
  juneBillNo = generatedSalesOrderNo(juneDraft.data, "A128 previous-month sales order");
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("query-sales-order-form").click();
  await page.getByTestId("tab-sales-order-form-list").waitFor({ state: "visible" });

  assert(await page.getByTestId("list-status").count() === 0, "普通列表顶部不再渲染状态下拉");
  assert(await page.getByText(`${previousMonth.from} 至 ${previousMonth.to}`).count() === 0, "普通列表不再渲染旧只读日期占位");

  const queryButtonBox = await buttonBox(page, "list-reset");
  const quickDateButtonBox = await buttonBox(page, "list-quick-date");
  const dateRangeButtonBox = await buttonBox(page, "list-date-range");
  assert(JSON.stringify(quickDateButtonBox) === JSON.stringify(queryButtonBox), "常用过滤条件按钮与普通查询区按钮视觉一致", { quickDateButtonBox, queryButtonBox });
  assert(JSON.stringify(dateRangeButtonBox) === JSON.stringify(queryButtonBox), "日期范围按钮与普通查询区按钮视觉一致", { dateRangeButtonBox, queryButtonBox });
  const dateRangeButtonPositionBefore = await page.getByTestId("list-date-range").boundingBox();
  await page.getByTestId("list-quick-date").click();
  await page.getByTestId("list-quick-date-menu").waitFor({ state: "visible", timeout: 10000 });
  const dateRangeButtonPositionAfter = await page.getByTestId("list-date-range").boundingBox();
  assert(
    Math.abs((dateRangeButtonPositionAfter?.x ?? 0) - (dateRangeButtonPositionBefore?.x ?? 0)) < 1,
    "打开常用过滤条件不应推动日期范围按钮",
    { before: dateRangeButtonPositionBefore, after: dateRangeButtonPositionAfter }
  );
  assert(await page.getByTestId("list-quick-date-menu").getByRole("button", { name: "上季度" }).count() === 1, "常用过滤条件必须包含上季度");
  await page.getByTestId("list-quick-date-menu").getByRole("button", { name: "上季度" }).click();
  await page.getByTestId("list-active-date-range").waitFor({ state: "visible", timeout: 10000 });
  const previousQuarterLabel = (await page.getByTestId("list-active-date-range").innerText()).trim();
  assert(previousQuarterLabel === `${previousQuarter.from} 至 ${previousQuarter.to}`, "上季度快捷过滤落到 dateFrom/dateTo", { previousQuarterLabel, previousQuarter });
  await page.getByTestId("list-reset").click();

  await ensureHeaderView(page);
  let listRequestCount = 0;
  const countListRequest = (request) => {
    if (request.url().includes("/api/lists/sales-order-form-list")) {
      listRequestCount += 1;
    }
  };
  page.on("request", countListRequest);
  await page.getByTestId("list-keyword").fill(`NO_AUTO_QUERY_${batch}`);
  await page.waitForTimeout(300);
  page.off("request", countListRequest);
  assert(listRequestCount === 0, "关键字输入不即时查询，必须回车或点击查询触发", { listRequestCount });

  await page.getByTestId("list-keyword").fill(`A128KEY ${batch} CP-001`);
  await page.getByTestId("list-query").click();
  await page.getByTestId(`open-document-${julyBillNo}`).waitFor({ state: "visible", timeout: 10000 });
  await page.getByTestId(`open-document-${juneBillNo}`).waitFor({ state: "visible", timeout: 10000 });
  let totalText = (await page.locator(".list-pagination").innerText()).trim();
  assert(totalText.includes("共 2 条"), "整单视图可用明细商品字段命中订单且只显示订单", { totalText });
  assert(await page.locator(".data-list-native-table tbody tr").count() === 2, "整单视图商品关键字命中后不展开明细行");

  await ensureDetailView(page);
  await page.getByTestId("list-keyword").fill(`A128KEY ${batch} CP-001`);
  await page.getByTestId("list-query").click();
  await page.getByTestId(`open-document-${julyBillNo}`).waitFor({ state: "visible", timeout: 10000 });
  await page.getByTestId(`open-document-${juneBillNo}`).waitFor({ state: "visible", timeout: 10000 });
  totalText = (await page.locator(".list-pagination").innerText()).trim();
  assert(totalText.includes("共 2 条"), "多词关键字按 AND 匹配两个 A128 明细行", { totalText });

  await page.getByTestId("list-keyword").fill(`A128KEY ${batch} 不存在词`);
  await page.getByTestId("list-query").click();
  await page.getByText("没有匹配数据").waitFor({ state: "visible", timeout: 10000 }).catch(async () => {
    const paginationText = await page.locator(".list-pagination").innerText();
    assert(paginationText.includes("共 0 条"), "不存在词组合应返回空结果", { paginationText });
  });

  await page.getByTestId("list-keyword").fill(`A128KEY ${batch}`);
  await page.getByTestId("list-query").click();
  await page.getByTestId("list-quick-date").click();
  await page.getByTestId("list-quick-date-menu").getByRole("button", { name: "本月" }).click();
  await page.getByTestId("list-active-date-range").waitFor({ state: "visible", timeout: 10000 });
  const quickDateLabel = (await page.getByTestId("list-active-date-range").innerText()).trim();
  assert(quickDateLabel === `${currentMonth.from} 至 ${currentMonth.to}`, "本月快捷过滤落到 dateFrom/dateTo", { quickDateLabel, currentMonth, timeZone: "Asia/Shanghai" });
  await page.getByTestId(`open-document-${julyBillNo}`).waitFor({ state: "visible", timeout: 10000 });
  assert(await page.getByTestId(`open-document-${juneBillNo}`).count() === 0, "本月快捷过滤排除 2026-06 单据");

  await page.getByTestId("list-date-range").click();
  await page.getByTestId("list-date-from").fill(previousMonth.from);
  await page.getByTestId("list-date-to").fill(previousMonth.to);
  await page.getByTestId("list-date-range-apply").click();
  await page.getByTestId(`open-document-${juneBillNo}`).waitFor({ state: "visible", timeout: 10000 });
  assert(await page.getByTestId(`open-document-${julyBillNo}`).count() === 0, "任意日期范围过滤排除范围外单据");

  await page.getByTestId("list-reset").click();
  await ensureHeaderView(page);
  await page.getByTestId("list-keyword").fill(`A128KEY ${batch}`);
  await page.getByTestId("list-query").click();
  await page.getByTestId("column-filter-status").click();
  await page.getByTestId("column-filter-input").fill("草稿");
  await page.getByTestId("column-filter-ok").click();
  await page.getByTestId(`open-document-${julyBillNo}`).waitFor({ state: "visible", timeout: 10000 });
  assert(await page.getByTestId("column-filter-status").evaluate((node) => node.className.includes("active")), "状态筛选通过列头筛选激活");

  const exportResponse = await page.evaluate(async ({ billNo }) => {
    const columnFilters = encodeURIComponent(JSON.stringify({ status: { operator: "等于", value: "草稿" } }));
    const response = await fetch(`/api/lists/sales-order-form-list/export.csv?keyword=${encodeURIComponent(billNo)}&columnFilters=${columnFilters}&view=header&pageSize=1000`);
    return { ok: response.ok, text: await response.text() };
  }, { billNo: julyBillNo });
  assert(exportResponse.ok && exportResponse.text.includes(julyBillNo), "导出接口复用关键字和列头筛选参数");

  const guardedExportResponse = await fetch(`${apiBase}/api/lists/purchase-summary-report/export.csv?pageSize=1000`, {
    headers: { Cookie: warehouseCookie }
  });
  const guardedExportText = await guardedExportResponse.text();
  assert(!guardedExportResponse.ok && guardedExportResponse.status === 403, "导出接口必须复用列表真实权限门禁，仓库用户读取采购汇总返回 403", {
    status: guardedExportResponse.status,
    text: guardedExportText
  });

  const amountFilterResponse = await page.evaluate(async ({ billNo }) => {
    const noMatchFilters = encodeURIComponent(JSON.stringify({ amount: { operator: "等于", value: "NO_MATCH_AMOUNT" } }));
    const matchFilters = encodeURIComponent(JSON.stringify({ amount: { operator: "等于", value: "86.00" } }));
    const [noMatchResponse, matchResponse] = await Promise.all([
      fetch(`/api/lists/sales-order-form-list?keyword=${encodeURIComponent(billNo)}&columnFilters=${noMatchFilters}&view=header&pageSize=200`),
      fetch(`/api/lists/sales-order-form-list?keyword=${encodeURIComponent(billNo)}&columnFilters=${matchFilters}&view=header&pageSize=200`)
    ]);
    return {
      noMatch: await noMatchResponse.json(),
      match: await matchResponse.json()
    };
  }, { billNo: julyBillNo });
  assert(amountFilterResponse.noMatch.total === 0, "销售订单金额列筛选按显示文本匹配且不应静默忽略", { total: amountFilterResponse.noMatch.total });
  assert(amountFilterResponse.match.total === 1, "销售订单金额列筛选可命中显示文本 86.00", { total: amountFilterResponse.match.total });

  const unknownFilterResponse = await page.evaluate(async ({ billNo }) => {
    const unknownFilters = encodeURIComponent(JSON.stringify({ unsupportedA128Column: { operator: "等于", value: "x" } }));
    const response = await fetch(`/api/lists/sales-order-form-list?keyword=${encodeURIComponent(billNo)}&columnFilters=${unknownFilters}&view=header&pageSize=200`);
    return { ok: response.ok, status: response.status, text: await response.text() };
  }, { billNo: julyBillNo });
  assert(!unknownFilterResponse.ok && unknownFilterResponse.status === 400 && unknownFilterResponse.text.includes("Unsupported sales order list column filter"), "销售订单未知列筛选必须按协议错误返回 400，不能静默忽略", unknownFilterResponse);

  await page.screenshot({ path: screenshot, fullPage: true });
  evidence.screenshots.push(screenshot);
} finally {
  await browser.close();
  await removeSalesOrder(julyBillNo);
  await removeSalesOrder(juneBillNo);
}

await writeFile(resultPath, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ resultPath, screenshots: evidence.screenshots, assertions: evidence.assertions.length }, null, 2));
