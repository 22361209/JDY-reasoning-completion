import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { saveDocument, auditDocument, confirmSalesOutSourceSelector, openSalesOutSourceSelector } from "./helpers/document-actions.mjs";
import { lineSourceText, openNewSalesOut, selectSalesOutSourceLines } from "./helpers/sales-pages.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a98-line-level-source-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-26";

await installApiSession(apiBase);
await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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
  if (!response.ok && !options.expectFailure) {
    throw new Error(`${options.method ?? "POST"} ${pathname} failed ${response.status}: ${text}`);
  }
  return { ok: response.ok, status: response.status, data };
}

async function requireApi(pathname, options = {}) {
  const result = await api(pathname, options);
  assert(result.ok, `${options.method ?? "POST"} ${pathname} failed ${result.status}`);
  return result.data;
}

async function seedStock() {
  for (const productCode of ["CP-001", "PJ-014"]) {
    await requireApi("/api/inventory/adjustments", {
      body: {
        productCode,
        warehouseCode: "CK-001",
        qtyDelta: 2000,
        txnType: "A98_LINE_SOURCE_IN",
        sourceBillType: `A98_LINE_SOURCE:${batch}`
      }
    });
  }
}

async function createOrder(suffix, productCode, qty, unitPrice) {
  const savedOrder = await requireApi("/api/sales-orders/draft", {
    body: {
      billNo: null,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      remark: `A98 ${suffix}`,
      lines: [{ productCode, warehouseCode: "CK-001", qty, unitPrice, lineRemark: `A98 ${suffix} 行`, planDeliveryDate: "2026-07-18" }]
    }
  });
  const billNo = generatedBillNo(savedOrder, "XSDD", `A98 ${suffix} sales order`);
  await requireApi(`/api/sales-orders/${encodeURIComponent(billNo)}/audit`);
  const savedNotice = await requireApi("/api/delivery-notices/draft", {
    body: {
      billNo: null,
      sourceOrderNo: billNo,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      remark: `A98 ${suffix}`,
      lines: [{ productCode, warehouseCode: "CK-001", sourceOrderNo: billNo, sourceLineNo: 1, qty, unitPrice, lineRemark: `A98 ${suffix} 行`, planDeliveryDate: "2026-07-18" }]
    }
  });
  const noticeNo = generatedBillNo(savedNotice, "FHTZD", `A98 ${suffix} delivery notice`);
  await requireApi(`/api/delivery-notices/${encodeURIComponent(noticeNo)}/audit`);
  return { orderNo: billNo, noticeNo };
}

async function createData() {
  await seedStock();
  return {
    sourceA: await createOrder("A", "CP-001", 3, 86),
    sourceB: await createOrder("B", "PJ-014", 2, 12)
  };
}

async function selectSourceLines(page, noticeA, noticeB) {
  await page.getByTestId("sales-out-party-code").fill("KH-001");
  await openSalesOutSourceSelector(page);
  for (const billNo of [noticeA, noticeB]) {
    await page.getByTestId("sales-out-source-selector-search").fill(billNo);
    await page.getByTestId("sales-out-source-selector-query").click();
    await selectSalesOutSourceLines(page, billNo, [1]);
  }
  await confirmSalesOutSourceSelector(page);
  await page.getByTestId("sales-out-line-source-trace-2").waitFor({ state: "visible" });
}

const data = await createData();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const screenshots = [];

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.removeItem("jdy:entry-columns:sales-out"));
  await loginAsAdmin(page);
  await openNewSalesOut(page);
  await selectSourceLines(page, data.sourceA.noticeNo, data.sourceB.noticeNo);

  assert(await page.getByTestId("sales-out-source-order-no").count() === 0, "header source order input should be removed after multi-source selection");
  const draftProducts = [
    await page.getByTestId("sales-out-line-product").inputValue(),
    await page.getByTestId("sales-out-line-product-2").inputValue()
  ];
  assert(draftProducts.includes("CP-001") && draftProducts.includes("PJ-014"), `sales out draft should retain both selected source lines, got ${draftProducts.join(",")}`);

  const draftSourceTexts = [await lineSourceText(page, "sales-out", 0), await lineSourceText(page, "sales-out", 1)];
  assert(draftSourceTexts[0] === `${data.sourceA.orderNo} / #1`, `first unsaved source trace should bind to XSDD A, got ${draftSourceTexts[0]}`);
  assert(draftSourceTexts[1] === `${data.sourceB.orderNo} / #1`, `second unsaved source trace should bind to XSDD B, got ${draftSourceTexts[1]}`);
  const draftPopupPromise = page.waitForEvent("popup", { timeout: 5000 });
  await page.getByTestId("sales-out-line-source-trace").click();
  const draftPopup = await draftPopupPromise;
  await draftPopup.waitForLoadState("domcontentloaded");
  const draftPopupHeading = (await draftPopup.locator("h1").innerText()).trim();
  assert(draftPopupHeading === `销售订单 ${data.sourceA.orderNo}`, `unsaved source trace should open exact XSDD A page, got ${draftPopupHeading}`);
  assert((await draftPopup.title()).includes(`销售订单 ${data.sourceA.orderNo}`), "unsaved source trace title should identify the sales order");
  const draftActiveLine = (await draftPopup.locator("tbody tr.active").innerText()).replace(/\s+/g, " ").trim();
  assert(draftActiveLine.includes("CP-001") && draftActiveLine.startsWith("1 "), `unsaved source trace should highlight exact source line 1: ${draftActiveLine}`);
  const draftTraceShot = `a98-unsaved-source-trace-${batch}.png`;
  await draftPopup.screenshot({ path: path.join(screenshotDir, draftTraceShot), fullPage: true });
  screenshots.push(`verification/playwright/${draftTraceShot}`);
  await draftPopup.close();

  assert(await page.getByTestId("sales-out-bill-no").inputValue() === "", "multi-source sales out should keep bill no empty before first save");
  await saveDocument(page);
  await page.waitForFunction(() => /^XSCKD\d{6}$/.test(document.querySelector('[data-testid="sales-out-bill-no"]')?.value ?? ""));
  const salesOutNo = await page.getByTestId("sales-out-bill-no").inputValue();
  assert(/^XSCKD\d{6}$/.test(salesOutNo), `multi-source sales out should use a system bill number after save, got ${salesOutNo}`);
  await auditDocument(page);

  const detail = await requireApi(`/api/sales-outs/${encodeURIComponent(salesOutNo)}`, { method: "GET" });
  assert(!detail.document.sourceOrderNo, "audited sales out header sourceOrderNo should be empty");
  const persistedSources = detail.lines.map((line) => ({
    sourceOrderNo: line.sourceOrderNo,
    sourceLineNo: Number(line.sourceLineNo),
    sourceDeliveryNoticeNo: line.sourceDeliveryNoticeNo,
    sourceDeliveryLineNo: Number(line.sourceDeliveryLineNo)
  }));
  const expectedPersistedSources = [
    { sourceOrderNo: data.sourceA.orderNo, sourceLineNo: 1, sourceDeliveryNoticeNo: data.sourceA.noticeNo, sourceDeliveryLineNo: 1 },
    { sourceOrderNo: data.sourceB.orderNo, sourceLineNo: 1, sourceDeliveryNoticeNo: data.sourceB.noticeNo, sourceDeliveryLineNo: 1 }
  ];
  assert(JSON.stringify(persistedSources) === JSON.stringify(expectedPersistedSources), `audited sales out should preserve sales-order and delivery-notice source layers: ${JSON.stringify(persistedSources)}`);

  const orderADetail = await requireApi(`/api/sales-orders/${encodeURIComponent(data.sourceA.orderNo)}`, { method: "GET" });
  const orderBDetail = await requireApi(`/api/sales-orders/${encodeURIComponent(data.sourceB.orderNo)}`, { method: "GET" });
  assert(Number(orderADetail.lines[0].remainingQty) === 0, "order A should have no remaining qty after audit");
  assert(Number(orderBDetail.lines[0].remainingQty) === 0, "order B should have no remaining qty after audit");

  const duplicateDraft = await requireApi("/api/sales-outs/draft", {
    body: {
      billNo: null,
      sourceOrderNo: data.sourceA.noticeNo,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      lines: [{
        productCode: "CP-001",
        warehouseCode: "CK-001",
        sourceOrderNo: data.sourceA.noticeNo,
        sourceLineNo: 1,
        sourceDeliveryNoticeNo: data.sourceA.noticeNo,
        sourceDeliveryLineNo: 1,
        qty: 1,
        unitPrice: 86
      }]
    }
  });
  const duplicateNo = generatedBillNo(duplicateDraft, "XSCKD", "A98 duplicate sales out");
  const duplicateAudit = await api(`/api/sales-outs/${encodeURIComponent(duplicateNo)}/audit`, { expectFailure: true });
  assert(duplicateAudit.status === 409, `duplicate over-push audit should be blocked with 409, got ${duplicateAudit.status}`);
  assert(JSON.stringify(duplicateAudit.data).includes("销售出库数量不能超过发货通知剩余可出数量"), `duplicate over-push should report the formal remaining-quantity guard: ${JSON.stringify(duplicateAudit.data)}`);

  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("query-sales-out-form").click();
  await page.getByTestId("tab-sales-out-form-list").waitFor({ state: "visible" });
  await page.getByTestId("list-keyword").waitFor({ state: "visible" });
  await page.getByTestId("list-keyword").fill(salesOutNo);
  await page.getByTestId("list-keyword").press("Enter");
  await page.getByTestId(`open-document-${salesOutNo}`).click();
  await page.waitForFunction((expectedBillNo) => {
    const input = document.querySelector('[data-testid="sales-out-bill-no"]');
    return input instanceof HTMLInputElement && input.value === expectedBillNo;
  }, salesOutNo);

  const reloadedSourceTexts = [await lineSourceText(page, "sales-out", 0), await lineSourceText(page, "sales-out", 1)];
  assert(reloadedSourceTexts.includes(`${data.sourceA.orderNo} / #1`), `reloaded line sources should include sales order A, got ${reloadedSourceTexts.join(",")}`);
  assert(reloadedSourceTexts.includes(`${data.sourceB.orderNo} / #1`), `reloaded line sources should include sales order B, got ${reloadedSourceTexts.join(",")}`);
  const clickedSourceOrderNo = persistedSources[0].sourceOrderNo;
  assert(
    reloadedSourceTexts[0] === `${clickedSourceOrderNo} / #1`,
    `first reloaded trace control should stay bound to its exact persisted sales order: ${JSON.stringify({ clickedSourceOrderNo, reloadedSourceTexts })}`
  );
  const reloadedProducts = [
    await page.getByTestId("sales-out-line-product").inputValue(),
    await page.getByTestId("sales-out-line-product-2").inputValue()
  ];
  assert(reloadedProducts.includes("CP-001") && reloadedProducts.includes("PJ-014"), `reloaded sales out should retain both source lines, got ${reloadedProducts.join(",")}`);

  const shot = `a98-multi-source-line-trace-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, shot), fullPage: true });
  screenshots.push(`verification/playwright/${shot}`);

  const popupPromise = page.waitForEvent("popup", { timeout: 5000 });
  await page.getByTestId("sales-out-line-source-trace").click();
  const popup = await popupPromise.catch((error) => {
    throw new Error(
      `saved sales-out source trace should open its exact XSDD source order after both source layers survive save/reload: ${JSON.stringify({ clickedSourceOrderNo, persistedSources, reloadedSourceTexts })}`,
      { cause: error }
    );
  });
  await popup.waitForLoadState("domcontentloaded");
  const savedPopupHeading = (await popup.locator("h1").innerText()).trim();
  const openedSourceOrder = savedPopupHeading.replace(/^销售订单\s+/, "");
  assert(openedSourceOrder === clickedSourceOrderNo, `saved line source trace should open the exact clicked sales order ${clickedSourceOrderNo}, got ${openedSourceOrder}`);
  assert(savedPopupHeading === `销售订单 ${clickedSourceOrderNo}`, `saved source trace should identify the sales-order page, got ${savedPopupHeading}`);
  assert((await popup.title()).includes(`销售订单 ${clickedSourceOrderNo}`), "saved source trace title should identify the sales order");
  const savedActiveLine = (await popup.locator("tbody tr.active").innerText()).replace(/\s+/g, " ").trim();
  assert(savedActiveLine.startsWith("1 "), `saved source trace should highlight exact source line 1: ${savedActiveLine}`);
  await popup.close();

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    assertions: [
      "多源单出库行级源单",
      "下推后源单追溯不丢明细不重复下推"
    ],
    orderA: data.sourceA.orderNo,
    orderB: data.sourceB.orderNo,
    noticeA: data.sourceA.noticeNo,
    noticeB: data.sourceB.noticeNo,
    salesOutNo,
    lineSources: persistedSources,
    draftSourceTexts,
    reloadedSourceTexts,
    remainingQty: {
      [data.sourceA.orderNo]: Number(orderADetail.lines[0].remainingQty),
      [data.sourceB.orderNo]: Number(orderBDetail.lines[0].remainingQty)
    },
    duplicateAuditStatus: duplicateAudit.status,
    screenshots
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
