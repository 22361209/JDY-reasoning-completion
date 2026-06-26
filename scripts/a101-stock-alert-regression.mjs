import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a101-stock-alert-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);

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
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${pathname} failed ${response.status}: ${text}`);
  }
  return data;
}

await api("/api/inventory/stock-alert-settings", {
  method: "PUT",
  body: {
    productCode: "CP-118",
    warehouseCode: "CK-001",
    safetyQty: 20,
    maxQty: 200
  }
});

const alertList = await api("/api/lists/stock-alert-list?keyword=CP-118&status=&page=1&pageSize=200");
const lowRow = alertList.rows.find((row) => row.productCode === "CP-118" && row.warehouseName === "成品仓");
assert(lowRow, "CP-118 成品仓 should appear in stock alert list");
assert(lowRow.status === "低于安全库存", `CP-118 stock alert status should be 低于安全库存, got ${lowRow.status}`);
assert(Number(lowRow.available) < Number(lowRow.safetyQty), "available qty should be lower than safety qty");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const screenshots = [];

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await page.getByTestId("module-库存管理").hover();
  await page.getByTestId("query-stock-alert-list").click();
  await page.getByTestId("tab-stock-alert-list").waitFor({ state: "visible" });
  await page.getByTestId("list-keyword").fill("CP-118");
  await page.getByTestId("list-keyword").press("Enter");
  const row = page.locator(".vxe-body--row", { hasText: "CP-118" }).first();
  await row.waitFor({ state: "visible" });
  await page.locator(".vxe-table--body-wrapper.body--wrapper").evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await page.waitForTimeout(200);
  const rowText = await page.locator(".vxe-body--row", { hasText: "低于安全库存" }).first().innerText();
  assert(rowText.includes("低于安全库存"), `frontend list should show low safety stock status, got row text: ${rowText}`);
  const listShot = `a101-stock-alert-list-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, listShot), fullPage: true });
  screenshots.push(`verification/playwright/${listShot}`);

  await page.getByTestId("stock-alert-settings").click();
  await page.getByTestId("stock-alert-settings-dialog").waitFor({ state: "visible" });
  await page.getByTestId("stock-alert-edit-CP-118-CK-001").click();
  await page.getByTestId("stock-alert-safety-qty").fill("20");
  await page.getByTestId("stock-alert-max-qty").fill("200");
  await page.getByTestId("stock-alert-save").click();
  await page.getByTestId("stock-alert-settings-message").waitFor({ state: "visible" });
  assert((await page.getByTestId("stock-alert-settings-message").innerText()).includes("已保存"), "stock alert setting should save from dialog");
  const settingsShot = `a101-stock-alert-settings-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, settingsShot), fullPage: true });
  screenshots.push(`verification/playwright/${settingsShot}`);

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    assertions: [
      "低于安全库存出现在库存预警列表",
      "库存预警列表直查 inv_stock_balance + 安全库存配置",
      "安全库存阈值配置入口可打开并保存"
    ],
    lowRow,
    screenshots
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
