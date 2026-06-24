import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a45-operation-log-shared-preset-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-24";
const operator = "本地管理员";
const presetName = `A45共享红冲审计-${batch}`;
const listKey = "operation-log-list";
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

async function seedStock() {
  for (const productCode of ["CP-001", "PJ-014", "CP-T413874"]) {
    for (const warehouseCode of ["CK-001", "CK-002", "CK-T413874"]) {
      await requireApi("/api/inventory/adjustments", {
        body: {
          productCode,
          warehouseCode,
          qtyDelta: 1000,
          txnType: "A45_OPERATION_LOG_SHARED_PRESET_IN",
          sourceBillType: `A45_OPERATION_LOG:${batch}`
        }
      });
    }
  }
}

async function createRedReverseSalesOut() {
  const billNo = `XSCK-A45-${batch}`;
  const redBillNo = `RED-A45-XSCK-${batch}`;
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
const preset = await requireApi(`/api/list-presets/${listKey}`, {
  body: {
    name: presetName,
    shared: true,
    query: {
      keyword: sales.redBillNo,
      status: "成功",
      module: "SALES",
      action: "RED_REVERSE",
      operator,
      targetType: "sales_out",
      dateFrom: billDate,
      dateTo: billDate
    },
    columnFilters: {}
  }
});
assert(preset.id, "saved preset should return id");

const presetsBefore = await requireApi(`/api/list-presets/${listKey}`, { method: "GET" });
assert(presetsBefore.some((item) => item.name === presetName), "GET presets should contain saved preset");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const screenshots = [];
try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.removeItem("jdy:operation-log-filter-presets"));
  await page.reload({ waitUntil: "networkidle" });
  await page.getByTestId("module-系统设置").hover();
  await page.getByTestId("query-operation-log-list").click();
  await page.getByTestId("tab-operation-log-list").waitFor({ state: "visible" });
  await page.getByTestId("list-toggle-filter").click();
  await page.getByTestId("operation-log-preset-select").locator("option", { hasText: presetName }).waitFor({ state: "attached" });
  await page.getByTestId("operation-log-preset-select").selectOption({ label: presetName });
  await page.getByTestId("operation-log-preset-apply").click();
  await page.getByTestId("operation-log-preset-message").getByText("预设已应用").waitFor({ state: "visible" });
  assert(await page.getByTestId("list-keyword").inputValue() === sales.redBillNo, "applied shared preset should restore keyword");
  assert(await page.getByTestId("operation-log-module").inputValue() === "SALES", "applied shared preset should restore module");
  assert(await page.getByTestId("operation-log-target-type").inputValue() === "sales_out", "applied shared preset should restore target type");
  await page.getByTestId("vxe-list-table").getByText(sales.redBillNo).waitFor({ state: "visible" });
  await page.getByTestId("vxe-list-table").getByText("RED_REVERSE").waitFor({ state: "visible" });
  const screenshot = `a45-operation-log-shared-preset-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });
  screenshots.push(`verification/playwright/${screenshot}`);
  await page.getByTestId("operation-log-preset-delete").click();
  await page.getByTestId("operation-log-preset-message").getByText("预设已删除").waitFor({ state: "visible" });
} finally {
  await browser.close();
}

const presetsAfterDelete = await requireApi(`/api/list-presets/${listKey}`, { method: "GET" });
const presetStillExists = presetsAfterDelete.some((item) => item.name === presetName);
assert(!presetStillExists, "deleted shared preset should not remain in backend");

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  salesOutNo: sales.billNo,
  salesRedReverseBillNo: sales.redBillNo,
  presetName,
  presetId: preset.id,
  checks: {
    apiSavedPreset: true,
    loadedFromBackendWithLocalStorageEmpty: true,
    appliedSharedPresetRestoresKeyword: true,
    backendDeleteRemovesPreset: !presetStillExists
  },
  screenshots
};
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
