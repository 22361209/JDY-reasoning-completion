import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { createSalesOutDraftViaDeliveryNotice } from "./helpers/sales-delivery-notice-flow.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a49-operation-log-default-readonly-preset-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
await installApiSession(apiBase);
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-24";
const operator = "本地管理员";
const listKey = "operation-log-list";
const defaultPresetName = "系统默认-红冲审计";
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
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { text };
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

async function ensureOperationLogFilters(page) {
  const presetSelect = page.getByTestId("operation-log-preset-select");
  if (await presetSelect.isVisible({ timeout: 500 }).catch(() => false)) {
    return;
  }
  await page.getByTestId("list-toggle-filter").click();
  if (await presetSelect.isVisible({ timeout: 500 }).catch(() => false)) {
    return;
  }
  await page.getByTestId("list-toggle-filter").click();
  await presetSelect.waitFor({ state: "visible" });
}

async function seedStock() {
  for (const productCode of ["CP-001", "PJ-014", "CP-T413874"]) {
    for (const warehouseCode of ["CK-001", "CK-002", "CK-T413874"]) {
      await requireApi("/api/inventory/adjustments", {
        body: {
          productCode,
          warehouseCode,
          qtyDelta: 1000,
          txnType: "A49_OPERATION_LOG_DEFAULT_PRESET_IN",
          sourceBillType: `A49_OPERATION_LOG:${batch}`
        }
      });
    }
  }
}

async function createRedReverseSalesOut() {
  const orderNo = `XSDD-A49-${batch}`;
  const billNo = `XSCK-A49-${batch}`;
  const redBillNo = `RED-A49-XSCK-${batch}`;
  await requireApi("/api/sales-orders/draft", {
    body: {
      billNo: orderNo,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: operator,
      lines
    }
  });
  await requireApi(`/api/sales-orders/${encodeURIComponent(orderNo)}/audit`);
  await createSalesOutDraftViaDeliveryNotice((pathname, body) => requireApi(pathname, { body }), {
    billNo,
    sourceOrderNo: orderNo,
    customerCode: "KH-001",
    billDate,
    department: "销售部",
    ownerName: operator,
    lines
  }, `FHTZ-A49-${batch}`);
  await requireApi(`/api/sales-outs/${encodeURIComponent(billNo)}/audit`);
  await requireApi(`/api/sales-outs/${encodeURIComponent(billNo)}/red-reverse`, {
    body: { redBillNo, billDate, ownerName: operator }
  });
  return { orderNo, billNo, redBillNo };
}

await seedStock();
const sales = await createRedReverseSalesOut();

const presets = await requireApi(`/api/list-presets/${listKey}`, { method: "GET" });
for (const preset of presets.filter((item) => item.name === defaultPresetName && !item.readOnly)) {
  await api(`/api/list-presets/${listKey}/${encodeURIComponent(preset.id)}`, { method: "DELETE" });
}
const refreshedPresets = await requireApi(`/api/list-presets/${listKey}`, { method: "GET" });
const defaultPreset = refreshedPresets.find((preset) => preset.name === defaultPresetName && preset.readOnly && preset.isDefault);
assert(defaultPreset, "default readonly preset should exist");
assert(defaultPreset.isDefault === true, "default preset should be marked default");
assert(defaultPreset.readOnly === true, "default preset should be read only");
assert(defaultPreset.query.status === "成功", "default preset should use visible status label");
assert(defaultPreset.query.module === "SALES", "default preset should filter sales module");
assert(defaultPreset.query.action === "RED_REVERSE", "default preset should filter red reverse action");
assert(defaultPreset.query.targetType === "sales_out", "default preset should filter sales out target type");

const deleteReadonly = await api(`/api/list-presets/${listKey}/${encodeURIComponent(defaultPreset.id)}`, { method: "DELETE" });
assert(deleteReadonly.status === 409, "deleting readonly preset should be rejected");

const overwriteReadonly = await api(`/api/list-presets/${listKey}`, {
  body: {
    name: defaultPresetName,
    shared: true,
    query: { keyword: "SHOULD_NOT_SAVE" },
    columnFilters: {}
  }
});
if (overwriteReadonly.status !== 409) {
  const afterOverwritePresets = await requireApi(`/api/list-presets/${listKey}`, { method: "GET" });
  const defaultStillExists = afterOverwritePresets.some((preset) => preset.id === defaultPreset.id && preset.readOnly && preset.isDefault);
  assert(defaultStillExists, "saving same name must not overwrite the readonly default preset");
  for (const preset of afterOverwritePresets.filter((item) => item.name === defaultPresetName && !item.readOnly)) {
    await api(`/api/list-presets/${listKey}/${encodeURIComponent(preset.id)}`, { method: "DELETE" });
  }
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const screenshots = [];
try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await page.evaluate(() => localStorage.removeItem("jdy:operation-log-filter-presets"));
  await page.reload({ waitUntil: "networkidle" });
  await page.getByTestId("module-系统设置").hover();
  await page.getByTestId("query-operation-log-list").click();
  await page.getByTestId("tab-operation-log-list").waitFor({ state: "visible" });
  await ensureOperationLogFilters(page);
  await page.getByTestId("operation-log-preset-select").locator("option", { hasText: defaultPresetName }).waitFor({ state: "attached" });
  assert(await page.getByTestId("operation-log-preset-select").inputValue() === defaultPreset.id, "default preset should be selected automatically");
  assert(await page.getByTestId("operation-log-module").inputValue() === "SALES", "default preset should apply module");
  assert(await page.getByTestId("operation-log-target-type").inputValue() === "sales_out", "default preset should apply target type");
  assert(await page.locator('[data-testid="operation-log-preset-delete"]').isDisabled(), "readonly default preset delete button should be disabled");
  await page.getByTestId("vxe-list-table").getByText(sales.redBillNo).waitFor({ state: "visible" });
  await page.getByTestId("vxe-list-table").getByText("RED_REVERSE").first().waitFor({ state: "visible" });
  const screenshot = `a49-operation-log-default-readonly-preset-${batch}.png`;
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
  defaultPresetId: defaultPreset.id,
  checks: {
    defaultPresetExists: true,
    defaultPresetReadOnly: defaultPreset.readOnly === true,
    defaultPresetUsesVisibleStatus: defaultPreset.query.status === "成功",
    deleteReadonlyRejected: deleteReadonly.status === 409,
    overwriteReadonlyRejected: overwriteReadonly.status === 409,
    frontendAutoAppliedDefault: true,
    readonlyDeleteDisabled: true
  },
  screenshots
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
