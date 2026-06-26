import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loginApi, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a9-partial-pushdown-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-24";

const salesLines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 10, unitPrice: 86, lineRemark: "A9 销售第一行", planDeliveryDate: "2026-07-01" },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 8, unitPrice: 94, lineRemark: "A9 销售第二行", planDeliveryDate: "2026-07-02" },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 6, unitPrice: 12, lineRemark: "A9 销售第三行", planDeliveryDate: "2026-07-03" }
];
const salesFirstOutLines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 4, unitPrice: 86 },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 3, unitPrice: 94 },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 2, unitPrice: 12 }
];
const purchaseLines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 11, unitPrice: 72 },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 9, unitPrice: 81 },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 7, unitPrice: 8 }
];
const purchaseFirstInLines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 5, unitPrice: 72 },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 4, unitPrice: 81 },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 3, unitPrice: 8 }
];

await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });
const apiCookie = await loginApi(apiBase);

async function api(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "POST",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      Cookie: apiCookie
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  return { ok: response.ok, status: response.status, data };
}

async function requireApi(pathname, options = {}) {
  const result = await api(pathname, options);
  if (!result.ok) {
    throw new Error(`${options.method ?? "POST"} ${pathname} failed ${result.status}: ${JSON.stringify(result.data)}`);
  }
  return result.data;
}

async function seedStock() {
  for (const productCode of ["CP-001", "PJ-014", "CP-T413874"]) {
    for (const warehouseCode of ["CK-001", "CK-002", "CK-T413874"]) {
      await requireApi("/api/inventory/adjustments", {
        body: {
          productCode,
          warehouseCode,
          qtyDelta: 2000,
          txnType: "A9_PARTIAL_PUSH_IN",
          sourceBillType: `A9_PARTIAL_PUSH:${batch}`
        }
      });
    }
  }
}

async function createData() {
  await seedStock();
  const salesOrderNo = `XSDD-A9-${batch}`;
  const firstSalesOutNo = `XSCK-A9-PART-${batch}`;
  const overSalesOutNo = `XSCK-A9-OVER-${batch}`;
  await requireApi("/api/sales-orders/draft", {
    body: {
      billNo: salesOrderNo,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      lines: salesLines
    }
  });
  await requireApi(`/api/sales-orders/${encodeURIComponent(salesOrderNo)}/audit`);
  await requireApi("/api/sales-outs/draft", {
    body: {
      billNo: firstSalesOutNo,
      sourceOrderNo: salesOrderNo,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      lines: salesFirstOutLines
    }
  });
  await requireApi(`/api/sales-outs/${encodeURIComponent(firstSalesOutNo)}/audit`);
  await requireApi("/api/sales-outs/draft", {
    body: {
      billNo: overSalesOutNo,
      sourceOrderNo: salesOrderNo,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      lines: salesLines
    }
  });
  const salesOverAudit = await api(`/api/sales-outs/${encodeURIComponent(overSalesOutNo)}/audit`);
  if (salesOverAudit.ok || salesOverAudit.status !== 409) {
    throw new Error(`sales over-push audit should fail with 409, got ${salesOverAudit.status}`);
  }

  const purchaseOrderNo = `CGDD-A9-${batch}`;
  const firstPurchaseInNo = `CGRK-A9-PART-${batch}`;
  const overPurchaseInNo = `CGRK-A9-OVER-${batch}`;
  await requireApi("/api/purchase-orders/draft", {
    body: {
      billNo: purchaseOrderNo,
      supplierCode: "GYS-001",
      billDate,
      department: "采购部",
      ownerName: "本地管理员",
      lines: purchaseLines
    }
  });
  await requireApi(`/api/purchase-orders/${encodeURIComponent(purchaseOrderNo)}/audit`);
  await requireApi("/api/purchase-ins/draft", {
    body: {
      billNo: firstPurchaseInNo,
      sourceOrderNo: purchaseOrderNo,
      supplierCode: "GYS-001",
      billDate,
      department: "采购部",
      ownerName: "本地管理员",
      lines: purchaseFirstInLines
    }
  });
  await requireApi(`/api/purchase-ins/${encodeURIComponent(firstPurchaseInNo)}/audit`);
  await requireApi("/api/purchase-ins/draft", {
    body: {
      billNo: overPurchaseInNo,
      sourceOrderNo: purchaseOrderNo,
      supplierCode: "GYS-001",
      billDate,
      department: "采购部",
      ownerName: "本地管理员",
      lines: purchaseLines
    }
  });
  const purchaseOverAudit = await api(`/api/purchase-ins/${encodeURIComponent(overPurchaseInNo)}/audit`);
  if (purchaseOverAudit.ok || purchaseOverAudit.status !== 409) {
    throw new Error(`purchase over-push audit should fail with 409, got ${purchaseOverAudit.status}`);
  }

  return {
    salesOrderNo,
    purchaseOrderNo,
    expectedSalesRemaining: [6, 5, 4],
    expectedPurchaseRemaining: [6, 5, 4],
    overChecks: [
      { document: overSalesOutNo, status: salesOverAudit.status },
      { document: overPurchaseInNo, status: purchaseOverAudit.status }
    ]
  };
}

async function openListAndPush(page, moduleName, entryId, listId, billNo, pushTestId) {
  await page.getByTestId(`module-${moduleName}`).hover();
  await page.getByTestId(`query-${entryId}`).click();
  await page.getByTestId(`tab-${listId}`).waitFor({ state: "visible" });
  await page.getByTestId("list-keyword").fill(billNo);
  await page.getByTestId("list-keyword").press("Enter");
  const row = page.locator(".vxe-body--row", { hasText: billNo }).first();
  await row.waitFor({ state: "visible" });
  await row.locator(".vxe-checkbox--icon").first().click();
  await page.getByTestId(pushTestId).click();
  if (pushTestId === "push-sales-out") {
    await page.getByTestId("sales-out-source-order-no").waitFor({ state: "visible" });
    return;
  }
  await page.getByTestId("push-confirm-ok").waitFor({ state: "visible" });
  await page.getByTestId("push-confirm-ok").click();
}

async function assertQtys(page, prefix, expectedQtys) {
  const actual = [];
  for (let index = 0; index < expectedQtys.length; index += 1) {
    const testId = index === 0 ? `${prefix}-line-qty` : `${prefix}-line-qty-${index + 1}`;
    const value = await page.getByTestId(testId).inputValue();
    actual.push(Number(value));
  }
  if (JSON.stringify(actual) !== JSON.stringify(expectedQtys)) {
    throw new Error(`${prefix} expected remaining ${expectedQtys.join(",")}, got ${actual.join(",")}`);
  }
  return actual;
}

async function assertInputValues(page, prefix, field, expectedValues) {
  const actual = [];
  for (let index = 0; index < expectedValues.length; index += 1) {
    const testId = index === 0 ? `${prefix}-line-${field}` : `${prefix}-line-${field}-${index + 1}`;
    actual.push(await page.getByTestId(testId).inputValue());
  }
  if (JSON.stringify(actual) !== JSON.stringify(expectedValues)) {
    throw new Error(`${prefix} ${field} expected ${expectedValues.join(",")}, got ${actual.join(",")}`);
  }
  return actual;
}

const data = await createData();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const screenshots = [];
try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await openListAndPush(page, "销售管理", "sales-order-form", "sales-order-form-list", data.salesOrderNo, "push-sales-out");
  await page.getByTestId("sales-out-source-order-no").waitFor({ state: "visible" });
  const salesSource = (await page.getByTestId("sales-out-line-source-trace").innerText()).trim();
  if (salesSource !== `${data.salesOrderNo} / #1`) {
    throw new Error(`sales line source expected ${data.salesOrderNo} / #1, got ${salesSource}`);
  }
  const salesQtys = await assertQtys(page, "sales-out", data.expectedSalesRemaining);
  const salesRemarks = await assertInputValues(page, "sales-out", "remark", salesLines.map((line) => line.lineRemark));
  const salesPlanDates = await assertInputValues(page, "sales-out", "plan-delivery-date", salesLines.map((line) => line.planDeliveryDate));
  const salesScreenshot = `a9-sales-remaining-pushdown-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, salesScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${salesScreenshot}`);

  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await openListAndPush(page, "采购管理", "purchase-order-form", "purchase-order-form-list", data.purchaseOrderNo, "push-purchase-in");
  await page.getByTestId("purchase-in-line-source-trace").waitFor({ state: "visible" });
  const purchaseSource = (await page.getByTestId("purchase-in-line-source-trace").innerText()).trim();
  if (purchaseSource !== `${data.purchaseOrderNo} / #1`) {
    throw new Error(`purchase line source expected ${data.purchaseOrderNo} / #1, got ${purchaseSource}`);
  }
  const purchaseQtys = await assertQtys(page, "purchase-in", data.expectedPurchaseRemaining);
  const purchaseScreenshot = `a9-purchase-remaining-pushdown-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, purchaseScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${purchaseScreenshot}`);

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    salesOrderNo: data.salesOrderNo,
    purchaseOrderNo: data.purchaseOrderNo,
    salesRemainingQtys: salesQtys,
    salesRemarks,
    salesPlanDates,
    purchaseRemainingQtys: purchaseQtys,
    overChecks: data.overChecks,
    screenshots
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
