import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { saveDocument, auditDocument } from "./helpers/document-actions.mjs";
import { assertEntryArrays, chooseSalesOutSourceLines, openNewSalesOut, openSalesOrderListAndSelect, readSalesOutLines } from "./helpers/sales-pages.mjs";

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

function generatedBillNo(row, label) {
  const billNo = String(row?.billNo ?? "");
  if (!billNo) {
    throw new Error(`${label} did not return billNo: ${JSON.stringify(row)}`);
  }
  return billNo;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function seedStock() {
  for (const productCode of ["CP-001", "PJ-014", "CP-T413874"]) {
    for (const warehouseCode of ["CK-001", "CK-002", "CK-003"]) {
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
  const billNo = generatedBillNo(await requireApi("/api/sales-orders/draft", {
    body: {
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      remark: `A93 ${suffix}`,
      lines
    }
  }), `A93销售订单${suffix}`);
  await requireApi(`/api/sales-orders/${encodeURIComponent(billNo)}/audit`);
  return billNo;
}

async function createDeliveryNotice(orderNo, suffix, lines) {
  const billNo = generatedBillNo(await requireApi("/api/delivery-notices/draft", {
    body: {
      sourceOrderNo: orderNo,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      remark: `A93 ${suffix}`,
      lines: lines.map((line, index) => ({
        ...line,
        sourceOrderNo: orderNo,
        sourceLineNo: index + 1
      }))
    }
  }), `A93发货通知${suffix}`);
  await requireApi(`/api/delivery-notices/${encodeURIComponent(billNo)}/audit`);
  return billNo;
}

async function createData() {
  await seedStock();
  const lines = [
    { productCode: "CP-001", warehouseCode: "CK-001", qty: 6, unitPrice: 86, lineRemark: "A93 第一行备注", planDeliveryDate: "2026-07-01" },
    { productCode: "PJ-014", warehouseCode: "CK-002", qty: 4, unitPrice: 12, lineRemark: "A93 第二行备注", planDeliveryDate: "2026-07-02" }
  ];
  const listPushOrderNo = await createOrder("PUSH", lines);
  const sourceInputOrderNo = await createOrder("SRC", lines);
  const customerPickOrderNo = await createOrder("PICK", lines);
  return {
    listPushOrderNo,
    sourceInputOrderNo,
    sourceInputNoticeNo: await createDeliveryNotice(sourceInputOrderNo, "SRC", lines),
    customerPickOrderNo,
    customerPickNoticeNo: await createDeliveryNotice(customerPickOrderNo, "PICK", lines),
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

function assertSalesOutLines(name, actual, expected) {
  assertEntryArrays(name, actual, expected);
}

function assertLineSources(name, actual, sourceOrderNo) {
  assertEntryArrays(name, actual, { sources: [`${sourceOrderNo} / #1`, `${sourceOrderNo} / #2`] });
}

const data = await createData();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const screenshots = [];

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await openSalesOrderListAndSelect(page, data.listPushOrderNo);
  await page.getByTestId("push-sales-out").click();
  await page.getByTestId("delivery-notice-party-code").waitFor({ state: "visible" });
  const noticeNoInput = page.getByTestId("delivery-notice-bill-no");
  assert(await noticeNoInput.inputValue() === "", "new delivery notice should not have a bill number before save");
  await saveDocument(page);
  await page.waitForFunction(() => {
    const input = document.querySelector('[data-testid="delivery-notice-bill-no"]');
    return input instanceof HTMLInputElement && /^FHTZD\d{6}$/.test(input.value);
  });
  const listPushNoticeNo = await noticeNoInput.inputValue();
  assert(/^FHTZD\d{6}$/.test(listPushNoticeNo), `saved delivery notice should use system number, got ${listPushNoticeNo}`);
  await auditDocument(page);
  await page.getByTestId("push-sales-out-from-delivery-notice").click();
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
  await chooseSalesOutSourceLines(page, { billNo: data.sourceInputNoticeNo, lineNos: [1, 2], search: data.sourceInputNoticeNo });
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
  await chooseSalesOutSourceLines(page, {
    billNo: data.customerPickNoticeNo,
    lineNos: [1, 2],
    search: data.customerPickNoticeNo
  });
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
    listPushNoticeNo,
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
