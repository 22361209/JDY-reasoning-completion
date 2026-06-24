import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a50-operation-log-role-scoped-preset-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
await installApiSession(apiBase);
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const listKey = "operation-log-list";
const defaultPresetName = "系统默认-红冲审计";
const hiddenWarehousePresetName = `A50仓库不可见-${batch}`;

await mkdir(screenshotDir, { recursive: true });

async function api(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "GET",
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
    throw new Error(`${options.method ?? "GET"} ${pathname} failed ${result.status}: ${JSON.stringify(result.data)}`);
  }
  return result.data;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const session = await requireApi("/api/system/session");
assert(session.user.roleCode === "ADMIN", "session should expose ADMIN role code");

const warehousePreset = await requireApi(`/api/list-presets/${listKey}`, {
  method: "POST",
  body: {
    name: hiddenWarehousePresetName,
    roleCode: "WAREHOUSE",
    shared: true,
    isDefault: false,
    query: {
      keyword: "WAREHOUSE_SHOULD_NOT_BE_VISIBLE",
      status: "成功",
      module: "SALES",
      action: "RED_REVERSE",
      operator: "",
      targetType: "sales_out",
      dateFrom: "",
      dateTo: ""
    },
    columnFilters: {}
  }
});
assert(warehousePreset.roleCode === "WAREHOUSE", "saved warehouse preset should keep role code");

const presets = await requireApi(`/api/list-presets/${listKey}`);
const defaultPreset = presets.find((preset) => preset.name === defaultPresetName);
assert(defaultPreset, "default preset should be returned for current ADMIN role");
assert(defaultPreset.roleCode === "ADMIN", "default preset should be scoped to ADMIN");
assert(defaultPreset.isDefault === true, "ADMIN default preset should be default");
assert(defaultPreset.readOnly === true, "ADMIN default preset should remain read only");
assert(!presets.some((preset) => preset.name === hiddenWarehousePresetName), "WAREHOUSE preset should not be visible to ADMIN session");

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
  if (!(await page.getByTestId("operation-log-preset-select").isVisible().catch(() => false))) {
    await page.getByTestId("list-toggle-filter").click();
  }
  await page.getByTestId("operation-log-preset-select").locator("option", { hasText: `${defaultPresetName}（ADMIN）（默认）（只读）` }).waitFor({ state: "attached" });
  const optionTexts = await page.getByTestId("operation-log-preset-select").locator("option").evaluateAll((options) => options.map((option) => option.textContent || ""));
  assert(optionTexts.some((text) => text.includes(`${defaultPresetName}（ADMIN）（默认）（只读）`)), "frontend should show ADMIN scoped default preset");
  assert(!optionTexts.some((text) => text.includes(hiddenWarehousePresetName)), "frontend should hide WAREHOUSE scoped preset");
  assert(await page.getByTestId("operation-log-module").inputValue() === "SALES", "ADMIN default preset should apply module");
  assert(await page.getByTestId("operation-log-target-type").inputValue() === "sales_out", "ADMIN default preset should apply target type");
  const screenshot = `a50-operation-log-role-scoped-preset-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });
  screenshots.push(`verification/playwright/${screenshot}`);
} finally {
  await browser.close();
}

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  currentRoleCode: session.user.roleCode,
  defaultPresetId: defaultPreset.id,
  hiddenWarehousePresetName,
  hiddenWarehousePresetId: warehousePreset.id,
  checks: {
    sessionHasRoleCode: session.user.roleCode === "ADMIN",
    defaultPresetScopedToAdmin: defaultPreset.roleCode === "ADMIN",
    warehousePresetSaved: warehousePreset.roleCode === "WAREHOUSE",
    warehousePresetHiddenFromAdmin: !presets.some((preset) => preset.name === hiddenWarehousePresetName),
    frontendShowsAdminScopedDefault: true,
    frontendHidesWarehouseScopedPreset: true
  },
  screenshots
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
