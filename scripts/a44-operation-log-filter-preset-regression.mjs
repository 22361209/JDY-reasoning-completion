import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a44-operation-log-filter-preset-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
await installApiSession(apiBase);
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-24";
const logDate = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
const operator = "本地管理员";
const presetName = `A44红冲审计-${batch}`;
const lines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 2, unitPrice: 86 },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 2, unitPrice: 94 },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 3, unitPrice: 12 }
];

await mkdir(screenshotDir, { recursive: true });

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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function ensureOperationLogFilters(page) {
  const moduleFilter = page.getByTestId("operation-log-module");
  if (await moduleFilter.isVisible({ timeout: 500 }).catch(() => false)) {
    return;
  }
  await ensureOperationLogFilters(page);
  if (await moduleFilter.isVisible({ timeout: 500 }).catch(() => false)) {
    return;
  }
  await ensureOperationLogFilters(page);
  await moduleFilter.waitFor({ state: "visible" });
}

async function seedStock() {
  for (const productCode of ["CP-001", "PJ-014", "CP-T413874"]) {
    for (const warehouseCode of ["CK-001", "CK-002", "CK-T413874"]) {
      await requireApi("/api/inventory/adjustments", {
        body: {
          productCode,
          warehouseCode,
          qtyDelta: 1000,
          txnType: "A44_OPERATION_LOG_PRESET_IN",
          sourceBillType: `A44_OPERATION_LOG:${batch}`
        }
      });
    }
  }
}

async function createRedReverseSalesOut() {
  const billNo = `XSCK-A44-${batch}`;
  const redBillNo = `RED-A44-XSCK-${batch}`;
  await requireApi("/api/sales-outs/draft", {
    body: {
      billNo,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: operator,
      lines
    }
  });
  await requireApi(`/api/sales-outs/${encodeURIComponent(billNo)}/audit`);
  await requireApi(`/api/sales-outs/${encodeURIComponent(billNo)}/red-reverse`, {
    body: { redBillNo, billDate, ownerName: operator }
  });
  return { billNo, redBillNo };
}

await seedStock();
const sales = await createRedReverseSalesOut();

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const screenshots = [];
let savedPresetCount = 0;
try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await page.evaluate(() => localStorage.removeItem("jdy:operation-log-filter-presets"));
  await page.reload({ waitUntil: "networkidle" });
  await page.getByTestId("module-系统设置").hover();
  await page.getByTestId("query-operation-log-list").click();
  await page.getByTestId("tab-operation-log-list").waitFor({ state: "visible" });
  await ensureOperationLogFilters(page);
  await page.getByTestId("list-keyword").fill(sales.redBillNo);
  await page.getByTestId("list-status").selectOption("成功");
  await page.getByTestId("operation-log-module").selectOption("SALES");
  await page.getByTestId("operation-log-action").selectOption("RED_REVERSE");
  await page.getByTestId("operation-log-operator").fill(operator);
  await page.getByTestId("operation-log-target-type").selectOption("sales_out");
  await page.getByTestId("operation-log-date-from").fill(logDate);
  await page.getByTestId("operation-log-date-to").fill(logDate);
  await page.getByTestId("operation-log-preset-name").fill(presetName);
  await page.getByTestId("operation-log-preset-save").click();
  await page.getByTestId("operation-log-preset-message").getByText("预设已保存").waitFor({ state: "visible" });
  const savedPresetNames = await page.evaluate(() => JSON.parse(localStorage.getItem("jdy:operation-log-filter-presets") || "[]").map((preset) => preset.name));
  savedPresetCount = savedPresetNames.length;
  assert(savedPresetNames.includes(presetName), `saved presets should include ${presetName}, got ${savedPresetNames.join(",")}`);

  await page.reload({ waitUntil: "networkidle" });
  await page.getByTestId("module-系统设置").hover();
  await page.getByTestId("query-operation-log-list").click();
  await page.getByTestId("tab-operation-log-list").waitFor({ state: "visible" });
  await ensureOperationLogFilters(page);
  const presetValue = await page.getByTestId("operation-log-preset-select").evaluate((select, name) => {
    const option = Array.from(select.options).find((item) => item.textContent?.includes(name));
    return option?.value ?? "";
  }, presetName);
  assert(presetValue, `preset select should contain ${presetName}`);
  await page.getByTestId("operation-log-preset-select").selectOption(presetValue);
  await page.getByTestId("operation-log-preset-apply").click();
  await page.getByTestId("operation-log-preset-message").getByText("预设已应用").waitFor({ state: "visible" });
  const keywordValue = await page.getByTestId("list-keyword").inputValue();
  const moduleValue = await page.getByTestId("operation-log-module").inputValue();
  const actionValue = await page.getByTestId("operation-log-action").inputValue();
  const targetTypeValue = await page.getByTestId("operation-log-target-type").inputValue();
  assert(keywordValue === sales.redBillNo, `preset keyword expected ${sales.redBillNo}, got ${keywordValue}`);
  assert(moduleValue === "SALES", `preset module expected SALES, got ${moduleValue}`);
  assert(actionValue === "RED_REVERSE", `preset action expected RED_REVERSE, got ${actionValue}`);
  assert(targetTypeValue === "sales_out", `preset targetType expected sales_out, got ${targetTypeValue}`);
  await page.getByTestId("vxe-list-table").getByText(sales.redBillNo).waitFor({ state: "visible" });
  await page.getByTestId("vxe-list-table").getByText("sales_out").first().waitFor({ state: "visible" });
  await page.getByTestId("vxe-list-table").getByText("RED_REVERSE").first().waitFor({ state: "visible" });
  const screenshot = `a44-operation-log-filter-preset-${batch}.png`;
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
  presetName,
  checks: {
    savedPresetCount,
    presetPersistsAfterReload: true,
    appliedPresetRestoresKeyword: true,
    appliedPresetRestoresModuleActionTargetType: true
  },
  screenshots
};
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
