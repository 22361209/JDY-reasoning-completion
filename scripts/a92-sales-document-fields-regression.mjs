import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a92-sales-document-fields-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-26";
const firstPlanDate = "2026-07-08";
const secondPlanDate = "2026-07-15";
const batchPlanDate = "2026-07-20";
const orderRemark = `A92 表头备注 ${batch}`;

await installApiSession(apiBase);
await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

async function api(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "POST",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok && !options.expectFailure) {
    throw new Error(`${options.method ?? "POST"} ${pathname} failed ${response.status}: ${text}`);
  }
  return { ok: response.ok, status: response.status, data };
}

async function requireApi(pathname, options = {}) {
  const result = await api(pathname, options);
  if (!result.ok) {
    throw new Error(`${options.method ?? "POST"} ${pathname} failed ${result.status}: ${JSON.stringify(result.data)}`);
  }
  return result.data;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertArray(name, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${name} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function seedStock() {
  for (const productCode of ["CP-001"]) {
    for (const warehouseCode of ["CK-001"]) {
      await requireApi("/api/inventory/adjustments", {
        body: {
          productCode,
          warehouseCode,
          qtyDelta: 2000,
          txnType: "A92_SALES_FIELDS_IN",
          sourceBillType: `A92_SALES_FIELDS:${batch}`
        }
      });
    }
  }
}

async function createSalesOrder() {
  await seedStock();
  const salesOrderNo = `XSDD-A92-${batch}`;
  await requireApi("/api/sales-orders/draft", {
    body: {
      billNo: salesOrderNo,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "客户端伪造录入人",
      remark: orderRemark,
      lines: [
        { productCode: "CP-001", warehouseCode: "CK-001", qty: 6, unitPrice: 86, lineRemark: "A92 第一行备注", planDeliveryDate: firstPlanDate },
        { productCode: "CP-001", warehouseCode: "CK-001", qty: 4, unitPrice: 91, lineRemark: "A92 第二行备注", planDeliveryDate: secondPlanDate }
      ]
    }
  });
  const detail = await requireApi(`/api/sales-orders/${encodeURIComponent(salesOrderNo)}`, { method: "GET" });
  assert(detail.order.customerCode === "KH-001", `customerCode mismatch: ${detail.order.customerCode}`);
  assert(String(detail.order.customer || "").length > 0, "customer name should be returned");
  assert(detail.order.ownerName === "本地管理员", `ownerName should come from current session, got ${detail.order.ownerName}`);
  assert(detail.order.createdByName === "本地管理员", `createdByName should come from current session, got ${detail.order.createdByName}`);
  assert(detail.order.remark === orderRemark, `header remark mismatch: ${detail.order.remark}`);
  assertArray("order product duplicates", detail.lines.map((line) => `${line.productCode}/${line.warehouseCode}`), ["CP-001/CK-001", "CP-001/CK-001"]);
  assertArray("order plan dates", detail.lines.map((line) => line.planDeliveryDate), [firstPlanDate, secondPlanDate]);
  await requireApi(`/api/sales-orders/${encodeURIComponent(salesOrderNo)}/audit`);
  return { salesOrderNo, customerName: detail.order.customer };
}

async function openOrderDetailFromList(page, billNo) {
  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("query-sales-order-form").click();
  await page.getByTestId("tab-sales-order-form-list").waitFor({ state: "visible" });
  await page.getByTestId("list-keyword").fill(billNo);
  await page.getByTestId("list-keyword").press("Enter");
  await page.getByTestId(`open-document-${billNo}`).click();
  await page.getByTestId("sales-line-product").waitFor({ state: "visible" });
}

async function pushOrderFromList(page, billNo) {
  await page.getByTestId("tab-sales-order-form-list").click();
  await page.getByTestId("list-keyword").fill(billNo);
  await page.getByTestId("list-keyword").press("Enter");
  const row = page.locator(".vxe-body--row", { hasText: billNo }).first();
  await row.waitFor({ state: "visible" });
  await row.locator(".vxe-checkbox--icon").first().click();
  await page.getByTestId("push-sales-out").click();
  await page.getByTestId("sales-out-party-code").waitFor({ state: "visible" });
}

const { salesOrderNo, customerName } = await createSalesOrder();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const screenshots = [];

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await openOrderDetailFromList(page, salesOrderNo);

  assert(await page.getByTestId("sales-party-name").inputValue() === customerName, "sales order customer name should display");
  assert(await page.getByTestId("sales-owner-name").inputValue() === "本地管理员", "sales order owner should display current login name");
  assert(await page.getByTestId("sales-remark").inputValue() === orderRemark, "sales order header remark should display");
  assert(await page.getByTestId("sales-line-plan-delivery-date").inputValue() === firstPlanDate, "first plan date should display");
  assert(await page.getByTestId("sales-line-plan-delivery-date-2").inputValue() === secondPlanDate, "second plan date should display");

  const orderScreenshot = `a92-sales-order-fields-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, orderScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${orderScreenshot}`);

  await page.getByTestId("push-sales-out-from-order-detail").click();
  await page.getByTestId("sales-out-party-code").waitFor({ state: "visible" });
  const pushed = {
    headerSourceOrderNo: await page.getByTestId("sales-out-source-order-no").count() === 0
      ? ""
      : await page.getByTestId("sales-out-source-order-no").inputValue(),
    customerCode: await page.getByTestId("sales-out-party-code").inputValue(),
    customerName: await page.getByTestId("sales-out-party-name").inputValue(),
    ownerName: await page.getByTestId("sales-out-owner-name").inputValue(),
    sourceLines: [
      await lineSourceText(page, "sales-out", 0),
      await lineSourceText(page, "sales-out", 1)
    ],
    products: [
      await page.getByTestId("sales-out-line-product").inputValue(),
      await page.getByTestId("sales-out-line-product-2").inputValue()
    ],
    warehouses: [
      await page.getByTestId("sales-out-line-warehouse").inputValue(),
      await page.getByTestId("sales-out-line-warehouse-2").inputValue()
    ],
    qtys: [
      Number(await page.getByTestId("sales-out-line-qty").inputValue()),
      Number(await page.getByTestId("sales-out-line-qty-2").inputValue())
    ],
    prices: [
      Number(await page.getByTestId("sales-out-line-price").inputValue()),
      Number(await page.getByTestId("sales-out-line-price-2").inputValue())
    ],
    remarks: [
      await page.getByTestId("sales-out-line-remark").inputValue(),
      await page.getByTestId("sales-out-line-remark-2").inputValue()
    ],
    planDates: [
      await page.getByTestId("sales-out-line-plan-delivery-date").inputValue(),
      await page.getByTestId("sales-out-line-plan-delivery-date-2").inputValue()
    ]
  };
  assert(pushed.headerSourceOrderNo === "", `pushed header source order should be empty: ${pushed.headerSourceOrderNo}`);
  assert(pushed.customerCode === "KH-001", `pushed customer code mismatch: ${pushed.customerCode}`);
  assert(pushed.customerName === customerName, `pushed customer name mismatch: ${pushed.customerName}`);
  assert(pushed.ownerName === "本地管理员", `pushed owner mismatch: ${pushed.ownerName}`);
  assertArray("pushed line-level source refs", pushed.sourceLines, [`${salesOrderNo} / #1`, `${salesOrderNo} / #2`]);
  assertArray("pushed duplicate products", pushed.products, ["CP-001", "CP-001"]);
  assertArray("pushed warehouses", pushed.warehouses, ["CK-001", "CK-001"]);
  assertArray("pushed remaining qtys", pushed.qtys, [6, 4]);
  assertArray("pushed prices", pushed.prices, [86, 91]);
  assertArray("pushed line remarks", pushed.remarks, ["A92 第一行备注", "A92 第二行备注"]);
  assertArray("pushed plan dates", pushed.planDates, [firstPlanDate, secondPlanDate]);

  await page.getByTestId("sales-out-remark").fill(`A92 出库备注 ${batch}`);
  await page.getByTestId("save-sales-order").click();
  await page.getByText("草稿已保存").waitFor({ state: "visible" });
  const salesOutNo = await page.getByTestId("sales-out-bill-no").inputValue();

  const outScreenshot = `a92-sales-out-pushdown-fields-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, outScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${outScreenshot}`);

  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("entry-sales-order-form").click();
  await page.getByTestId("sales-line-product").waitFor({ state: "visible" });
  await page.getByTestId("new-document").click();
  await page.getByRole("button", { name: "+ 增加明细行" }).click();
  await page.getByTestId("sales-line-plan-delivery-date").fill(firstPlanDate);
  await page.getByTestId("batch-plan-delivery-date").fill(batchPlanDate);
  await page.getByTestId("sales-line-select-2").check();
  await page.getByTestId("apply-batch-plan-delivery-date").click();
  assert(await page.getByTestId("sales-line-plan-delivery-date").inputValue() === firstPlanDate, "unselected line plan date should stay unchanged");
  assert(await page.getByTestId("sales-line-plan-delivery-date-2").inputValue() === batchPlanDate, "selected line plan date should be batch-filled");

  const batchFillScreenshot = `a92-sales-order-batch-plan-date-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, batchFillScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${batchFillScreenshot}`);

  const outDetail = await requireApi(`/api/sales-outs/${encodeURIComponent(salesOutNo)}`, { method: "GET" });
  assert(outDetail.document.customer === customerName, "sales out detail should return customer name");
  assert(outDetail.document.createdByName === "本地管理员", "sales out detail should return current creator");
  assert(outDetail.document.remark === `A92 出库备注 ${batch}`, "sales out header remark should persist");
  assertArray("sales out persisted plan dates", outDetail.lines.map((line) => line.planDeliveryDate), [firstPlanDate, secondPlanDate]);

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    salesOrderNo,
    salesOutNo,
    customerName,
    orderRemark,
    pushed,
    persistedSalesOut: {
      customer: outDetail.document.customer,
      createdByName: outDetail.document.createdByName,
      remark: outDetail.document.remark,
      planDates: outDetail.lines.map((line) => line.planDeliveryDate)
    },
    screenshots
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}

async function lineSourceText(page, prefix, index) {
  const suffix = index === 0 ? "" : `-${index + 1}`;
  const orderNo = (await page.getByTestId(`${prefix}-line-source-order-no${suffix}`).innerText()).trim();
  const lineNo = (await page.getByTestId(`${prefix}-line-source-line-no${suffix}`).innerText()).trim();
  return `${orderNo} / ${lineNo}`;
}
