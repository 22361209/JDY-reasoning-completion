import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a93-sales-out-source-selection-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-26";

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
  for (const productCode of ["CP-001", "PJ-014", "CP-T413874"]) {
    for (const warehouseCode of ["CK-001", "CK-002", "CK-T413874"]) {
      await requireApi("/api/inventory/adjustments", {
        body: {
          productCode,
          warehouseCode,
          qtyDelta: 2000,
          txnType: "A93_SOURCE_SELECTION_IN",
          sourceBillType: `A93_SOURCE_SELECTION:${batch}`
        }
      });
    }
  }
}

async function createOrder(suffix, lines) {
  const billNo = `XSDD-A93-${suffix}-${batch}`;
  await requireApi("/api/sales-orders/draft", {
    body: {
      billNo,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      remark: `A93 ${suffix}`,
      lines
    }
  });
  await requireApi(`/api/sales-orders/${encodeURIComponent(billNo)}/audit`);
  return billNo;
}

async function createData() {
  await seedStock();
  const lines = [
    { productCode: "CP-001", warehouseCode: "CK-001", qty: 6, unitPrice: 86, lineRemark: "A93 第一行备注", planDeliveryDate: "2026-07-01" },
    { productCode: "PJ-014", warehouseCode: "CK-002", qty: 4, unitPrice: 12, lineRemark: "A93 第二行备注", planDeliveryDate: "2026-07-02" }
  ];
  return {
    listPushOrderNo: await createOrder("PUSH", lines),
    sourceInputOrderNo: await createOrder("SRC", lines),
    customerPickOrderNo: await createOrder("PICK", lines),
    expected: {
      products: ["CP-001", "PJ-014"],
      warehouses: ["CK-001", "CK-002"],
      qtys: [6, 4],
      prices: [86, 12],
      remarks: ["A93 第一行备注", "A93 第二行备注"],
      planDates: ["2026-07-01", "2026-07-02"]
    }
  };
}

async function openSalesOrderList(page, billNo) {
  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("query-sales-order-form").click();
  await page.getByTestId("tab-sales-order-form-list").waitFor({ state: "visible" });
  await page.getByTestId("list-keyword").fill(billNo);
  await page.getByTestId("list-keyword").press("Enter");
  const row = page.locator(".vxe-body--row", { hasText: billNo }).first();
  await row.waitFor({ state: "visible" });
  await row.locator(".vxe-checkbox--icon").first().click();
}

async function openNewSalesOut(page) {
  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("entry-sales-out-form").click();
  await page.getByTestId("sales-out-party-code").waitFor({ state: "visible" });
}

async function readSalesOutLines(page) {
  return {
    sources: [
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
}

async function lineSourceText(page, prefix, index) {
  const suffix = index === 0 ? "" : `-${index + 1}`;
  const orderNo = (await page.getByTestId(`${prefix}-line-source-order-no${suffix}`).innerText()).trim();
  const lineNo = (await page.getByTestId(`${prefix}-line-source-line-no${suffix}`).innerText()).trim();
  return `${orderNo} / ${lineNo}`;
}

function assertSalesOutLines(name, actual, expected) {
  assertArray(`${name} products`, actual.products, expected.products);
  assertArray(`${name} warehouses`, actual.warehouses, expected.warehouses);
  assertArray(`${name} qtys`, actual.qtys, expected.qtys);
  assertArray(`${name} prices`, actual.prices, expected.prices);
  assertArray(`${name} remarks`, actual.remarks, expected.remarks);
  assertArray(`${name} plan dates`, actual.planDates, expected.planDates);
}

function assertLineSources(name, actual, sourceOrderNo) {
  assertArray(`${name} line sources`, actual.sources, [`${sourceOrderNo} / #1`, `${sourceOrderNo} / #2`]);
}

const data = await createData();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const screenshots = [];

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await openSalesOrderList(page, data.listPushOrderNo);
  await page.getByTestId("push-sales-out").click();
  await page.getByTestId("sales-out-party-code").waitFor({ state: "visible" });
  assert(await page.getByTestId("push-confirm-dialog").count() === 0, "sales pushdown confirm dialog should not appear");
  assert(await page.getByTestId("sales-out-source-order-no").count() === 0, "direct push should not keep source order on header");
  const directPushLines = await readSalesOutLines(page);
  assertSalesOutLines("direct push", directPushLines, data.expected);
  assertLineSources("direct push", directPushLines, data.listPushOrderNo);
  await page.getByTestId("sales-out-line-qty").fill("5");
  assert(Number(await page.getByTestId("sales-out-line-qty").inputValue()) === 5, "direct push qty should be edited in sales out form");
  const directShot = `a93-sales-direct-push-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, directShot), fullPage: true });
  screenshots.push(`verification/playwright/${directShot}`);

  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await openNewSalesOut(page);
  await page.getByTestId("sales-out-party-code").fill("KH-001");
  await page.getByTestId("sales-out-open-source-selector").click();
  await page.getByTestId("sales-out-source-selector-dialog").waitFor({ state: "visible" });
  await page.getByTestId("sales-out-source-selector-search").fill(data.sourceInputOrderNo);
  await page.getByTestId(`sales-out-source-line-${data.sourceInputOrderNo}:1`).check();
  await page.getByTestId(`sales-out-source-line-${data.sourceInputOrderNo}:2`).check();
  await page.getByTestId("sales-out-source-selector-ok").click();
  await page.getByTestId("sales-out-line-product-2").waitFor({ state: "visible" });
  assert(await page.getByTestId("sales-out-party-code").inputValue() === "KH-001", "source order should carry customer code");
  assert(await page.getByTestId("sales-out-source-order-no").count() === 0, "source input should be removed after A102");
  const sourceInputLines = await readSalesOutLines(page);
  assertSalesOutLines("source order input", sourceInputLines, data.expected);
  assertLineSources("source order input", sourceInputLines, data.sourceInputOrderNo);
  const sourceShot = `a93-sales-source-order-load-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, sourceShot), fullPage: true });
  screenshots.push(`verification/playwright/${sourceShot}`);

  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await openNewSalesOut(page);
  await page.getByTestId("sales-out-party-code").fill("KH-001");
  await page.getByTestId("sales-out-open-source-selector").click();
  await page.getByTestId("sales-out-source-selector-dialog").waitFor({ state: "visible" });
  await page.getByTestId(`sales-out-source-line-${data.customerPickOrderNo}:1`).check();
  await page.getByTestId(`sales-out-source-line-${data.customerPickOrderNo}:2`).check();
  await page.getByTestId("sales-out-source-selector-ok").click();
  await page.getByTestId("sales-out-line-product-2").waitFor({ state: "visible" });
  assert(await page.getByTestId("sales-out-source-order-no").count() === 0, "customer selector should not put source order on header");
  const customerPickLines = await readSalesOutLines(page);
  assertSalesOutLines("customer selector", customerPickLines, data.expected);
  assertLineSources("customer selector", customerPickLines, data.customerPickOrderNo);
  const selectorShot = `a93-sales-customer-source-selector-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, selectorShot), fullPage: true });
  screenshots.push(`verification/playwright/${selectorShot}`);

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    orders: data,
    directPushLines,
    sourceInputLines,
    customerPickLines,
    noPushConfirmDialog: true,
    screenshots
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
