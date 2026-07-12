import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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
const userPresetName = `A51本人默认-生产冲销-${batch}-${randomBytes(8).toString("hex")}`;
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

function exactPresetSnapshot(presets) {
  return JSON.stringify([...presets].sort((left, right) => String(left.id).localeCompare(String(right.id))));
}

function scopeRows(presets, roleCode, userName) {
  return presets.filter((preset) =>
    (preset.role_code ?? null) === roleCode && (preset.user_name ?? null) === userName
  );
}

function scopeIds(presets, roleCode, userName) {
  return scopeRows(presets, roleCode, userName).map((preset) => preset.id).sort();
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function nullableSql(value, type = "text") {
  return value == null ? `NULL::${type}` : `${sqlLiteral(value)}::${type}`;
}

function jsonbSql(value) {
  return value == null ? "NULL::jsonb" : `${sqlLiteral(JSON.stringify(value))}::jsonb`;
}

function booleanSql(value) {
  return value ? "TRUE" : "FALSE";
}

function sqlScalar(sql) {
  return execFileSync(
    "docker",
    ["exec", "jdy-erp-postgres", "psql", "-X", "-U", "jdy", "-d", "jdy_erp", "-v", "ON_ERROR_STOP=1", "-tAq", "-c", sql],
    { encoding: "utf8" }
  ).trim();
}

function readCompletePresetSnapshot() {
  const raw = sqlScalar(`
    SELECT COALESCE(jsonb_agg(to_jsonb(preset) ORDER BY preset.id::text), '[]'::jsonb)::text
    FROM public.sys_list_filter_preset preset
    WHERE preset.list_key = ${sqlLiteral(listKey)}
  `);
  const presets = JSON.parse(raw || "[]");
  assert(Array.isArray(presets), `A51 preset snapshot should be an array, got ${raw}`);
  return presets;
}

function exactPresetInsert(preset) {
  return `
    INSERT INTO public.sys_list_filter_preset (
      id, list_key, name, query, column_filters, shared, created_by,
      created_at, updated_at, is_default, read_only, role_code, user_name
    ) VALUES (
      ${nullableSql(preset.id, "uuid")},
      ${sqlLiteral(preset.list_key)},
      ${sqlLiteral(preset.name)},
      ${jsonbSql(preset.query)},
      ${jsonbSql(preset.column_filters)},
      ${booleanSql(preset.shared)},
      ${nullableSql(preset.created_by, "uuid")},
      ${nullableSql(preset.created_at, "timestamptz")},
      ${nullableSql(preset.updated_at, "timestamptz")},
      ${booleanSql(preset.is_default)},
      ${booleanSql(preset.read_only)},
      ${nullableSql(preset.role_code)},
      ${nullableSql(preset.user_name)}
    );
  `;
}

function restorePresetScope(baselinePresets, roleCode, userName) {
  const baselineScopeRows = scopeRows(baselinePresets, roleCode, userName);
  sqlScalar(`
    BEGIN;
    DELETE FROM public.sys_list_filter_preset
    WHERE list_key = ${sqlLiteral(listKey)}
      AND role_code IS NOT DISTINCT FROM ${nullableSql(roleCode)}
      AND user_name IS NOT DISTINCT FROM ${nullableSql(userName)};
    ${baselineScopeRows.map(exactPresetInsert).join("\n")}
    COMMIT;
  `);
}

async function finishCleanup(primaryError, cleanupTasks) {
  const cleanupErrors = [];
  for (const task of cleanupTasks) {
    try {
      await task();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length === 0) {
    return;
  }
  if (primaryError) {
    for (const error of cleanupErrors) {
      console.error(`A51 cleanup failed after primary error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    }
    return;
  }
  throw cleanupErrors[0];
}

async function ensurePresetSelectVisible(page) {
  const isPresetSelectVisible = () =>
    Boolean(
      document.querySelector('[data-testid="operation-log-preset-select"]')?.getClientRects().length
    );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await page.evaluate(isPresetSelectVisible)) {
      return;
    }
    await page.getByTestId("list-toggle-filter").click();
    await page.waitForTimeout(200);
  }
  await page.waitForFunction(isPresetSelectVisible, null, { timeout: 10000 });
}

async function waitForPresetOption(page, expectedText) {
  await page.waitForFunction(
    (text) =>
      Array.from(document.querySelectorAll('[data-testid="operation-log-preset-select"] option')).some((option) =>
        (option.textContent || "").includes(text)
      ),
    expectedText,
    { timeout: 10000 }
  );
}

let session;
let presetUserName;
let affectedRoleCode;
let userPreset;
let presets;
let roleDefaultPreset;
let browser;
const screenshots = [];
let primaryError;
let baselinePresets = [];
let baselinePresetSnapshot = "";
let baselineAffectedScopeIds = [];
let snapshotTaken = false;
let mutationStarted = false;
let restoredExactPresetSnapshot = false;
let restoredOriginalIds = false;

try {
  session = await requireApi("/api/system/session");
  assert(session.user.roleCode === "ADMIN", "session should expose ADMIN role code");
  assert(session.user.username === "admin", "session should expose current login username");
  assert(session.user.name === "本地管理员", "session should expose current display name");
  assert(session?.tenant?.schemaName === "public", `A51 preset snapshot SQL expects the BLD-TEST public schema, got ${JSON.stringify(session?.tenant?.schemaName)}`);
  presetUserName = session.user.username;
  affectedRoleCode = session.user.roleCode;

  baselinePresets = readCompletePresetSnapshot();
  baselinePresetSnapshot = exactPresetSnapshot(baselinePresets);
  baselineAffectedScopeIds = scopeIds(baselinePresets, affectedRoleCode, presetUserName);
  snapshotTaken = true;

  const baselineVisiblePresets = await requireApi(`/api/list-presets/${listKey}`);
  roleDefaultPreset = baselineVisiblePresets.find((preset) =>
    preset.name === roleDefaultPresetName
      && preset.roleCode === affectedRoleCode
      && preset.userName === ""
  );
  assert(roleDefaultPreset, "role default preset should be visible before A51 writes any fixture");
  assert(roleDefaultPreset.isDefault === true, "role default should be default before A51 writes any fixture");
  assert(roleDefaultPreset.readOnly === true, "role default should remain read only");

  mutationStarted = true;
  userPreset = await requireApi(`/api/list-presets/${listKey}`, {
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
  assert(userPreset.roleCode === affectedRoleCode, "user preset should keep current role code for audit context");
  assert(userPreset.userName === presetUserName, "user preset should be scoped to the immutable current username");
  assert(userPreset.isDefault === true, "user preset should be saved as default");
  const exactUserScopeCount = Number(sqlScalar(`
    SELECT count(*)
    FROM public.sys_list_filter_preset
    WHERE id = ${nullableSql(userPreset.id, "uuid")}
      AND list_key = ${sqlLiteral(listKey)}
      AND role_code = ${sqlLiteral(affectedRoleCode)}
      AND user_name = ${sqlLiteral(presetUserName)}
  `));
  assert(exactUserScopeCount === 1, `saved user preset should have the exact DB scope, got ${exactUserScopeCount}`);

  presets = await requireApi(`/api/list-presets/${listKey}`);
  const visibleUserPreset = presets.find((preset) => preset.id === userPreset.id);
  const visibleRoleDefaultPreset = presets.find((preset) => preset.id === roleDefaultPreset.id);
  assert(visibleUserPreset, "user default preset should be visible to current user");
  assert(visibleRoleDefaultPreset, "role default preset should remain visible");
  assert(visibleRoleDefaultPreset.roleCode === affectedRoleCode, "role default should remain scoped to ADMIN");
  assert(visibleRoleDefaultPreset.userName === "", "role default should not be converted to a user preset");
  assert(visibleRoleDefaultPreset.isDefault === true, "role default should remain default in its own scope");
  assert(presets.findIndex((preset) => preset.id === userPreset.id) < presets.findIndex((preset) => preset.id === roleDefaultPreset.id), "user default should be ordered before role default");

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await page.evaluate(() => localStorage.removeItem("jdy:operation-log-filter-presets"));
  await page.reload({ waitUntil: "networkidle" });
  await page.getByTestId("module-系统设置").hover();
  await page.getByTestId("query-operation-log-list").click();
  await page.getByTestId("tab-operation-log-list").waitFor({ state: "visible" });
  await ensurePresetSelectVisible(page);
  await waitForPresetOption(page, `${userPresetName}（本人:${presetUserName}）（默认）`);
  await waitForPresetOption(page, `${roleDefaultPresetName}（ADMIN）（默认）（只读）`);
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
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  await finishCleanup(primaryError, [
    async () => {
      if (browser) {
        await browser.close();
      }
    },
    async () => {
      if (mutationStarted) {
        restorePresetScope(baselinePresets, affectedRoleCode, presetUserName);
      }
    },
    async () => {
      if (!snapshotTaken) {
        return;
      }
      const restoredPresets = readCompletePresetSnapshot();
      restoredOriginalIds = JSON.stringify(scopeIds(restoredPresets, affectedRoleCode, presetUserName)) === JSON.stringify(baselineAffectedScopeIds);
      assert(restoredOriginalIds, `A51 cleanup should restore original current-user preset IDs: ${JSON.stringify({ baselineAffectedScopeIds, restoredAffectedScopeIds: scopeIds(restoredPresets, affectedRoleCode, presetUserName) })}`);
      restoredExactPresetSnapshot = exactPresetSnapshot(restoredPresets) === baselinePresetSnapshot;
      assert(restoredExactPresetSnapshot, "A51 cleanup should restore the exact complete operation-log preset snapshot");
    }
  ]);
}

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
    userDefaultOrderedBeforeRoleDefault: presets.findIndex((preset) => preset.id === userPreset.id) < presets.findIndex((preset) => preset.id === roleDefaultPreset.id),
    frontendAppliedUserDefault: true,
    frontendKeptRoleDefaultVisible: true,
    frontendRestoredColumnFilter: true,
    restoredExactPresetSnapshot,
    restoredOriginalIds
  },
  screenshots
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
