import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a37-operation-log-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-24";
const lines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 2, unitPrice: 86 },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 2, unitPrice: 94 },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 3, unitPrice: 12 }
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
          qtyDelta: 1000,
          txnType: "A37_OPERATION_LOG_IN",
          sourceBillType: `A37_OPERATION_LOG:${batch}`
        }
      });
    }
  }
}

async function createRedReverseSalesOut() {
  const billNo = `XSCK-A37-${batch}`;
  const redBillNo = `RED-A37-XSCK-${batch}`;
  await requireApi("/api/sales-outs/draft", {
    body: {
      billNo,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      lines
    }
  });
  await requireApi(`/api/sales-outs/${encodeURIComponent(billNo)}/audit`);
  await requireApi(`/api/sales-outs/${encodeURIComponent(billNo)}/red-reverse`, {
    body: { redBillNo, billDate, ownerName: "本地管理员" }
  });
  return { billNo, redBillNo };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

await seedStock();
const sales = await createRedReverseSalesOut();
const logResult = await requireApi(`/api/lists/operation-log-list?keyword=${encodeURIComponent(sales.redBillNo)}&status=成功&page=1&pageSize=200`, { method: "GET" });
const redLog = logResult.rows.find((row) => row.targetNo === sales.redBillNo && row.action === "RED_REVERSE");
assert(redLog, `operation log should contain RED_REVERSE for ${sales.redBillNo}`);
assert(redLog.module === "SALES", `operation log module expected SALES, got ${redLog.module}`);
assert(redLog.status === "成功", `operation log status expected 成功, got ${redLog.status}`);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const screenshots = [];

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await page.getByTestId("module-系统设置").hover();
  await page.getByTestId("query-operation-log-list").click();
  await page.getByTestId("tab-operation-log-list").waitFor({ state: "visible" });
  await page.getByTestId("list-keyword").fill(sales.redBillNo);
  await page.getByTestId("list-keyword").press("Enter");
  const table = page.getByTestId("vxe-list-table");
  await table.getByText(sales.redBillNo).waitFor({ state: "visible" });
  await table.getByText("RED_REVERSE").waitFor({ state: "visible" });
  await table.getByText("成功").first().waitFor({ state: "visible" });
  const screenshot = `a37-operation-log-red-reverse-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });
  screenshots.push(`verification/playwright/${screenshot}`);
} finally {
  await browser.close();
}

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  salesOutNo: sales.billNo,
  salesRedReverseBillNo: sales.redBillNo,
  logRow: redLog,
  screenshots
};
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
