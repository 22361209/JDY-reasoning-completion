import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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
const hiddenWarehousePresetName = `A50仓库不可见-${batch}-${randomBytes(8).toString("hex")}`;
const affectedRoleCode = "WAREHOUSE";
const affectedUserName = null;

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
  assert(Array.isArray(presets), `A50 preset snapshot should be an array, got ${raw}`);
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
      console.error(`A50 cleanup failed after primary error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
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

let session;
let warehousePreset;
let presets;
let defaultPreset;
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
  assert(session?.tenant?.schemaName === "public", `A50 preset snapshot SQL expects the BLD-TEST public schema, got ${JSON.stringify(session?.tenant?.schemaName)}`);

  baselinePresets = readCompletePresetSnapshot();
  baselinePresetSnapshot = exactPresetSnapshot(baselinePresets);
  baselineAffectedScopeIds = scopeIds(baselinePresets, affectedRoleCode, affectedUserName);
  snapshotTaken = true;

  const baselineVisiblePresets = await requireApi(`/api/list-presets/${listKey}`);
  defaultPreset = baselineVisiblePresets.find((preset) =>
    preset.name === defaultPresetName
      && preset.roleCode === "ADMIN"
      && preset.userName === ""
  );
  assert(defaultPreset, "default preset should be returned for current ADMIN role");
  assert(defaultPreset.isDefault === true, "ADMIN default preset should be default before A50 writes any fixture");
  assert(defaultPreset.readOnly === true, "ADMIN default preset should remain read only");

  mutationStarted = true;
  warehousePreset = await requireApi(`/api/list-presets/${listKey}`, {
    method: "POST",
    body: {
      name: hiddenWarehousePresetName,
      roleCode: affectedRoleCode,
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
  assert(warehousePreset.roleCode === affectedRoleCode, "saved warehouse preset should keep role code");
  const exactWarehouseScopeCount = Number(sqlScalar(`
    SELECT count(*)
    FROM public.sys_list_filter_preset
    WHERE id = ${nullableSql(warehousePreset.id, "uuid")}
      AND list_key = ${sqlLiteral(listKey)}
      AND role_code = ${sqlLiteral(affectedRoleCode)}
      AND user_name IS NULL
  `));
  assert(exactWarehouseScopeCount === 1, `saved warehouse preset should have the exact DB scope, got ${exactWarehouseScopeCount}`);

  presets = await requireApi(`/api/list-presets/${listKey}`);
  const visibleDefaultPreset = presets.find((preset) => preset.id === defaultPreset.id);
  assert(visibleDefaultPreset?.isDefault === true, "WAREHOUSE fixture must not change the ADMIN default");
  assert(!presets.some((preset) => preset.name === hiddenWarehousePresetName), "WAREHOUSE preset should not be visible to ADMIN session");

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
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="operation-log-preset-select"] option').length > 1,
    null,
    { timeout: 10000 }
  );
  const optionTexts = await page.getByTestId("operation-log-preset-select").locator("option").evaluateAll((options) => options.map((option) => option.textContent || ""));
  assert(optionTexts.some((text) => text.includes(`${defaultPresetName}（ADMIN）（默认）（只读）`)), "frontend should show ADMIN scoped default preset");
  assert(!optionTexts.some((text) => text.includes(hiddenWarehousePresetName)), "frontend should hide WAREHOUSE scoped preset");
  assert(await page.getByTestId("operation-log-module").inputValue() === "SALES", "ADMIN default preset should apply module");
  assert(await page.getByTestId("operation-log-target-type").inputValue() === "sales_out", "ADMIN default preset should apply target type");
  const screenshot = `a50-operation-log-role-scoped-preset-${batch}.png`;
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
        restorePresetScope(baselinePresets, affectedRoleCode, affectedUserName);
      }
    },
    async () => {
      if (!snapshotTaken) {
        return;
      }
      const restoredPresets = readCompletePresetSnapshot();
      restoredOriginalIds = JSON.stringify(scopeIds(restoredPresets, affectedRoleCode, affectedUserName)) === JSON.stringify(baselineAffectedScopeIds);
      assert(restoredOriginalIds, `A50 cleanup should restore original WAREHOUSE preset IDs: ${JSON.stringify({ baselineAffectedScopeIds, restoredAffectedScopeIds: scopeIds(restoredPresets, affectedRoleCode, affectedUserName) })}`);
      restoredExactPresetSnapshot = exactPresetSnapshot(restoredPresets) === baselinePresetSnapshot;
      assert(restoredExactPresetSnapshot, "A50 cleanup should restore the exact complete operation-log preset snapshot");
    }
  ]);
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
    frontendHidesWarehouseScopedPreset: true,
    restoredExactPresetSnapshot,
    restoredOriginalIds
  },
  screenshots
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
