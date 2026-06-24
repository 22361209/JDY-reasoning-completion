import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a14-push-confirm-bulk-tools-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-24";

const salesLines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 10, unitPrice: 86 },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 8, unitPrice: 94 },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 6, unitPrice: 12 }
];
const salesFirstOutLines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 4, unitPrice: 86 },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 3, unitPrice: 94 },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 2, unitPrice: 12 }
];

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
          txnType: "A14_PUSH_CONFIRM_TOOLS_IN",
          sourceBillType: `A14_PUSH_CONFIRM_TOOLS:${batch}`
        }
      });
    }
  }
}

async function createData() {
  await seedStock();
  const salesOrderNo = `XSDD-A14-${batch}`;
  const firstSalesOutNo = `XSCK-A14-PART-${batch}`;
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
  return {
    salesOrderNo,
    expectedRemaining: [6, 5, 4],
    expectedHalf: [3, 2.5, 2]
  };
}

async function openListAndPush(page, billNo) {
  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("query-sales-order-form").click();
  await page.getByTestId("tab-sales-order-form-list").waitFor({ state: "visible" });
  await page.getByTestId("list-keyword").fill(billNo);
  await page.getByTestId("list-keyword").press("Enter");
  const row = page.locator(".vxe-body--row", { hasText: billNo }).first();
  await row.waitFor({ state: "visible" });
  await row.locator(".vxe-checkbox--icon").first().click();
  await page.getByTestId("push-sales-out").click();
  await page.getByTestId("push-confirm-dialog").waitFor({ state: "visible" });
}

async function readPushConfirmQtys(page) {
  const qtys = [];
  for (let index = 0; index < 3; index += 1) {
    const testId = index === 0 ? "push-confirm-qty" : `push-confirm-qty-${index + 1}`;
    qtys.push(Number(await page.getByTestId(testId).inputValue()));
  }
  return qtys;
}

async function readFormQtys(page) {
  const qtys = [];
  for (let index = 0; index < 3; index += 1) {
    const testId = index === 0 ? "sales-out-line-qty" : `sales-out-line-qty-${index + 1}`;
    qtys.push(Number(await page.getByTestId(testId).inputValue()));
  }
  return qtys;
}

function assertArray(name, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${name} expected ${expected.join(",")}, got ${actual.join(",")}`);
  }
}

const data = await createData();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await openListAndPush(page, data.salesOrderNo);
  const defaults = await readPushConfirmQtys(page);
  assertArray("default remaining", defaults, data.expectedRemaining);

  await page.getByTestId("push-confirm-clear").click();
  const afterClear = await readPushConfirmQtys(page);
  assertArray("clear qtys", afterClear, [0, 0, 0]);

  await page.getByTestId("push-confirm-all").click();
  const afterAll = await readPushConfirmQtys(page);
  assertArray("all remaining qtys", afterAll, data.expectedRemaining);

  await page.getByTestId("push-confirm-ratio").fill("125");
  await page.getByTestId("push-confirm-apply-ratio").click();
  await page.getByTestId("push-confirm-error").waitFor({ state: "visible" });
  const afterInvalidRatio = await readPushConfirmQtys(page);
  assertArray("invalid ratio keeps values", afterInvalidRatio, data.expectedRemaining);

  await page.getByTestId("push-confirm-ratio").fill("50");
  await page.getByTestId("push-confirm-apply-ratio").click();
  const afterHalf = await readPushConfirmQtys(page);
  assertArray("half remaining qtys", afterHalf, data.expectedHalf);

  const dialogScreenshot = `a14-push-confirm-tools-dialog-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, dialogScreenshot), fullPage: true });

  await page.getByTestId("push-confirm-ok").click();
  await page.getByTestId("sales-out-source-order-no").waitFor({ state: "visible" });
  const formQtys = await readFormQtys(page);
  assertArray("form qtys", formQtys, data.expectedHalf);
  const formScreenshot = `a14-push-confirm-tools-form-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, formScreenshot), fullPage: true });

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    salesOrderNo: data.salesOrderNo,
    defaults,
    afterClear,
    afterAll,
    afterInvalidRatio,
    afterHalf,
    formQtys,
    screenshots: [
      `verification/playwright/${dialogScreenshot}`,
      `verification/playwright/${formScreenshot}`
    ]
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
