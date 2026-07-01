import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { saveDocument, auditDocument } from "./helpers/document-actions.mjs";
import { chooseSalesOutSourceSelections, lineSourceText, openNewSalesOut } from "./helpers/sales-pages.mjs";

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
  const billNo = `XSDD-A98-${suffix}-${batch}`;
  await requireApi("/api/sales-orders/draft", {
    body: {
      billNo,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      remark: `A98 ${suffix}`,
      lines: [{ productCode, warehouseCode: "CK-001", qty, unitPrice, lineRemark: `A98 ${suffix} 行`, planDeliveryDate: "2026-07-18" }]
    }
  });
  await requireApi(`/api/sales-orders/${encodeURIComponent(billNo)}/audit`);
  const noticeNo = `FHTZ-A98-${suffix}-${batch}`;
  await requireApi("/api/delivery-notices/draft", {
    body: {
      billNo: noticeNo,
      sourceOrderNo: billNo,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      remark: `A98 ${suffix}`,
      lines: [{ productCode, warehouseCode: "CK-001", sourceOrderNo: billNo, sourceLineNo: 1, qty, unitPrice, lineRemark: `A98 ${suffix} 行`, planDeliveryDate: "2026-07-18" }]
    }
  });
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
  await chooseSalesOutSourceSelections(page, {
    search: batch,
    selections: [
      { billNo: noticeA, lineNos: [1] },
      { billNo: noticeB, lineNos: [1] }
    ]
  });
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

  const sourceTexts = [await lineSourceText(page, "sales-out", 0), await lineSourceText(page, "sales-out", 1)];
  assert(sourceTexts.includes(`${data.sourceA.noticeNo} / #1`), `line sources should include notice A, got ${sourceTexts.join(",")}`);
  assert(sourceTexts.includes(`${data.sourceB.noticeNo} / #1`), `line sources should include notice B, got ${sourceTexts.join(",")}`);
  assert(await page.getByTestId("sales-out-source-order-no").count() === 0, "header source order input should be removed after multi-source selection");

  const popupPromise = page.waitForEvent("popup");
  await page.getByTestId("sales-out-line-source-trace").click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  const popupText = await popup.locator("body").innerText();
  const openedSourceNotice = [data.sourceA.noticeNo, data.sourceB.noticeNo].find((billNo) => popupText.includes(billNo)) ?? "";
  assert([data.sourceA.noticeNo, data.sourceB.noticeNo].includes(openedSourceNotice), `line source trace should open clicked source notice, got ${openedSourceNotice}`);
  const draftProducts = [
    await page.getByTestId("sales-out-line-product").inputValue(),
    await page.getByTestId("sales-out-line-product-2").inputValue()
  ];
  assert(draftProducts.includes("CP-001") && draftProducts.includes("PJ-014"), `sales out draft lines should remain after source trace navigation, got ${draftProducts.join(",")}`);
  await popup.close();

  const shot = `a98-multi-source-line-trace-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, shot), fullPage: true });
  screenshots.push(`verification/playwright/${shot}`);

  const salesOutNo = await page.getByTestId("sales-out-bill-no").inputValue();
  await saveDocument(page);
  await auditDocument(page);

  const detail = await requireApi(`/api/sales-outs/${encodeURIComponent(salesOutNo)}`, { method: "GET" });
  assert(!detail.document.sourceOrderNo, "audited sales out header sourceOrderNo should be empty");
  const persistedOrderSources = detail.lines.map((line) => line.sourceOrderNo);
  const persistedNoticeSources = detail.lines.map((line) => line.sourceDeliveryNoticeNo);
  assert(persistedOrderSources.includes(data.sourceA.orderNo) && persistedOrderSources.includes(data.sourceB.orderNo), `audited sales out should persist line-level sales order numbers, got ${persistedOrderSources.join(",")}`);
  assert(persistedNoticeSources.includes(data.sourceA.noticeNo) && persistedNoticeSources.includes(data.sourceB.noticeNo), `audited sales out should persist line-level delivery notice numbers, got ${persistedNoticeSources.join(",")}`);

  const orderADetail = await requireApi(`/api/sales-orders/${encodeURIComponent(data.sourceA.orderNo)}`, { method: "GET" });
  const orderBDetail = await requireApi(`/api/sales-orders/${encodeURIComponent(data.sourceB.orderNo)}`, { method: "GET" });
  assert(Number(orderADetail.lines[0].remainingQty) === 0, "order A should have no remaining qty after audit");
  assert(Number(orderBDetail.lines[0].remainingQty) === 0, "order B should have no remaining qty after audit");

  const duplicateNo = `XSCK-A98-DUP-${batch}`;
  await requireApi("/api/sales-outs/draft", {
    body: {
      billNo: duplicateNo,
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
  const duplicateAudit = await api(`/api/sales-outs/${encodeURIComponent(duplicateNo)}/audit`, { expectFailure: true });
  assert(duplicateAudit.status === 409, `duplicate over-push audit should be blocked with 409, got ${duplicateAudit.status}`);

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
    lineSources: detail.lines.map((line) => ({ lineNo: line.lineNo, sourceOrderNo: line.sourceOrderNo, sourceLineNo: line.sourceLineNo })),
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
