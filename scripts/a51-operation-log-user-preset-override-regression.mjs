import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a51-operation-log-user-preset-override-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
await installApiSession(apiBase);
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const listKey = "operation-log-list";
const userPresetName = `A51本人默认-生产冲销-${batch}`;
const roleDefaultPresetName = "系统默认-红冲审计";

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
assert(session.user.username === "admin", "session should expose current login username");
assert(session.user.name === "本地管理员", "session should expose current display name");
const presetUserName = session.user.name;

await cleanupA51Presets();

const userPreset = await requireApi(`/api/list-presets/${listKey}`, {
  method: "POST",
  body: {
    name: userPresetName,
    userName: presetUserName,
    shared: true,
    isDefault: true,
    query: {
      keyword: "",
      status: "成功",
      module: "PRODUCTION",
      action: "RED_REVERSE_ISSUE",
      operator: "",
      targetType: "production_material_issue",
      dateFrom: "",
      dateTo: ""
    },
    columnFilters: {
      targetNo: { operator: "包含", value: "SCLL" }
    }
  }
});
assert(userPreset.roleCode === "ADMIN", "user preset should keep current role code for audit context");
assert(userPreset.userName === presetUserName, "user preset should be scoped to current user display name");
assert(userPreset.isDefault === true, "user preset should be saved as default");

const presets = await requireApi(`/api/list-presets/${listKey}`);
const visibleUserPreset = presets.find((preset) => preset.name === userPresetName);
const roleDefaultPreset = presets.find((preset) => preset.name === roleDefaultPresetName);
assert(visibleUserPreset, "user default preset should be visible to current user");
assert(roleDefaultPreset, "role default preset should remain visible");
assert(roleDefaultPreset.roleCode === "ADMIN", "role default should remain scoped to ADMIN");
assert(roleDefaultPreset.userName === "", "role default should not be converted to a user preset");
assert(roleDefaultPreset.isDefault === true, "role default should remain default in its own scope");
assert(presets.findIndex((preset) => preset.name === userPresetName) < presets.findIndex((preset) => preset.name === roleDefaultPresetName), "user default should be ordered before role default");

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
  const optionTexts = await page.getByTestId("operation-log-preset-select").locator("option").evaluateAll((options) => options.map((option) => option.textContent || ""));
  assert(optionTexts.some((text) => text.includes(`${userPresetName}（本人:${presetUserName}）（默认）`)), "frontend should show current-user default preset");
  assert(optionTexts.some((text) => text.includes(`${roleDefaultPresetName}（ADMIN）（默认）（只读）`)), "frontend should keep ADMIN role default preset visible");
  assert(await page.getByTestId("operation-log-module").inputValue() === "PRODUCTION", "user default should override role default module");
  assert(await page.getByTestId("operation-log-action").inputValue() === "RED_REVERSE_ISSUE", "user default should override role default action");
  assert(await page.getByTestId("operation-log-target-type").inputValue() === "production_material_issue", "user default should override role default target type");
  await page.getByTestId("column-filter-targetNo").first().click();
  await page.getByTestId("column-filter-input").waitFor({ state: "visible" });
  assert(await page.getByTestId("column-filter-input").inputValue() === "SCLL", "user default should restore column filter");
  const screenshot = `a51-operation-log-user-preset-override-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });
  screenshots.push(`verification/playwright/${screenshot}`);
} finally {
  await browser.close();
}

await cleanupA51Presets();

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  currentUserName: presetUserName,
  currentRoleCode: session.user.roleCode,
  userPresetId: userPreset.id,
  roleDefaultPresetId: roleDefaultPreset.id,
  checks: {
    sessionHasUsername: session.user.username === "admin",
    sessionHasDisplayName: session.user.name === "本地管理员",
    userPresetSavedAsDefault: userPreset.isDefault === true,
    roleDefaultStillDefault: roleDefaultPreset.isDefault === true,
    userDefaultOrderedBeforeRoleDefault: presets.findIndex((preset) => preset.name === userPresetName) < presets.findIndex((preset) => preset.name === roleDefaultPresetName),
    frontendAppliedUserDefault: true,
    frontendKeptRoleDefaultVisible: true,
    frontendRestoredColumnFilter: true
  },
  screenshots
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));

async function cleanupA51Presets() {
  const presets = await requireApi(`/api/list-presets/${listKey}`);
  const stalePresets = presets.filter((preset) => String(preset.name || "").startsWith("A51本人默认-"));
  for (const preset of stalePresets) {
    if (!preset.readOnly) {
      await requireApi(`/api/list-presets/${listKey}/${encodeURIComponent(preset.id)}`, { method: "DELETE" });
    }
  }
}
