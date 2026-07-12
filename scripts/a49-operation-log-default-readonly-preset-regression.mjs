import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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
const readonlyFixtureName = `A49只读负例-${batch}-${randomBytes(8).toString("hex")}`;
const lines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 2, unitPrice: 86 },
  { productCode: "CP-T413874", warehouseCode: "CK-003", qty: 2, unitPrice: 94 },
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

function generatedBillNo(row, prefix, label) {
  const billNo = String(row?.billNo ?? "");
  if (!new RegExp(`^${prefix}\\d{6}$`).test(billNo)) {
    throw new Error(`${label} did not return a system ${prefix} bill number: ${JSON.stringify(row)}`);
  }
  return billNo;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function exactPresetSnapshot(presets) {
  return JSON.stringify([...presets].sort((left, right) => String(left.id).localeCompare(String(right.id))));
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlScalar(sql) {
  return execFileSync(
    "docker",
    ["exec", "jdy-erp-postgres", "psql", "-U", "jdy", "-d", "jdy_erp", "-tAq", "-c", sql],
    { encoding: "utf8" }
  ).trim();
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
      console.error(`A49 cleanup failed after primary error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    }
    return;
  }
  throw cleanupErrors[0];
}

async function seedStock() {
  for (const productCode of ["CP-001", "PJ-014", "CP-T413874"]) {
    for (const warehouseCode of ["CK-001", "CK-002", "CK-003"]) {
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
  const orderNo = generatedBillNo(await requireApi("/api/sales-orders/draft", {
    body: {
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: operator,
      lines
    }
  }), "XSDD", "A49销售订单");
  await requireApi(`/api/sales-orders/${encodeURIComponent(orderNo)}/audit`);
  const flow = await createSalesOutDraftViaDeliveryNotice((pathname, body) => requireApi(pathname, { body }), {
    sourceOrderNo: orderNo,
    customerCode: "KH-001",
    billDate,
    department: "销售部",
    ownerName: operator,
    lines
  });
  assert(/^FHTZD\d{6}$/.test(flow.noticeNo), `A49 delivery notice should use a system bill number, got ${flow.noticeNo}`);
  assert(/^XSCKD\d{6}$/.test(flow.salesOutNo), `A49 sales out should use a system bill number, got ${flow.salesOutNo}`);
  const billNo = flow.salesOutNo;
  await requireApi(`/api/sales-outs/${encodeURIComponent(billNo)}/audit`);
  const redBillNo = generatedBillNo(await requireApi(`/api/sales-outs/${encodeURIComponent(billNo)}/red-reverse`, {
    body: { billDate, ownerName: operator }
  }), "XSCKD", "A49销售出库红冲");
  await requireApi(`/api/sales-outs/${encodeURIComponent(redBillNo)}/audit`);
  return { orderNo, billNo, redBillNo };
}

let sales;
let defaultPreset;
let deleteReadonly;
let overwriteReadonly;
let browser;
const screenshots = [];
let primaryError;
let baselinePresets = [];
let baselinePresetSnapshot = "";
let readonlyFixtureId = "";
let fixtureInsertAttempted = false;

function createReadonlyFixture() {
  const existingCount = Number(sqlScalar(`
    SELECT count(*)
    FROM public.sys_list_filter_preset
    WHERE list_key = ${sqlLiteral(listKey)}
      AND name = ${sqlLiteral(readonlyFixtureName)}
  `));
  assert(existingCount === 0, `A49 readonly fixture name must be unique before insert, got ${existingCount}`);
  fixtureInsertAttempted = true;
  const id = sqlScalar(`
    INSERT INTO public.sys_list_filter_preset (
      list_key, name, role_code, user_name, query, column_filters,
      shared, is_default, read_only, updated_at
    ) VALUES (
      ${sqlLiteral(listKey)}, ${sqlLiteral(readonlyFixtureName)}, 'ADMIN', NULL,
      '{"keyword":"A49_READONLY_FIXTURE"}'::jsonb, '{}'::jsonb,
      TRUE, FALSE, TRUE, now()
    )
    RETURNING id::text
  `);
  assert(/^[0-9a-f-]{36}$/i.test(id), `A49 readonly fixture insert should return a UUID, got ${JSON.stringify(id)}`);
  readonlyFixtureId = id;
}

async function removeReadonlyFixture() {
  if (!fixtureInsertAttempted) {
    return;
  }
  sqlScalar(`
    DELETE FROM public.sys_list_filter_preset
    WHERE id = ${readonlyFixtureId ? `${sqlLiteral(readonlyFixtureId)}::uuid` : "NULL::uuid"}
       OR (list_key = ${sqlLiteral(listKey)} AND name = ${sqlLiteral(readonlyFixtureName)})
  `);
  const restoredPresets = await requireApi(`/api/list-presets/${listKey}`, { method: "GET" });
  assert(
    exactPresetSnapshot(restoredPresets) === baselinePresetSnapshot,
    `A49 cleanup should restore the exact visible preset baseline: ${JSON.stringify({ baselinePresets, restoredPresets })}`
  );
}

try {
  baselinePresets = await requireApi(`/api/list-presets/${listKey}`, { method: "GET" });
  baselinePresetSnapshot = exactPresetSnapshot(baselinePresets);
  const readonlyAdminDefaults = baselinePresets.filter((preset) =>
    preset.name === defaultPresetName
      && preset.readOnly
      && preset.isDefault
      && preset.roleCode === "ADMIN"
      && preset.userName === ""
  );
  assert(readonlyAdminDefaults.length === 1, `expected one clean ADMIN readonly default baseline, got ${JSON.stringify(readonlyAdminDefaults)}`);
  [defaultPreset] = readonlyAdminDefaults;
  const visibleDefaults = baselinePresets.filter((preset) => preset.isDefault);
  assert(
    visibleDefaults.length === 1 && visibleDefaults[0].id === defaultPreset.id,
    `readonly ADMIN preset must be the only visible default before frontend auto-apply can be verified: ${JSON.stringify(visibleDefaults)}`
  );
  assert(defaultPreset.query.status === "成功", "default preset should use visible status label");
  assert(defaultPreset.query.module === "SALES", "default preset should filter sales module");
  assert(defaultPreset.query.action === "RED_REVERSE", "default preset should filter red reverse action");
  assert(defaultPreset.query.targetType === "sales_out", "default preset should filter sales out target type");

  const session = await requireApi("/api/system/session", { method: "GET" });
  assert(session?.tenant?.schemaName === "public", `A49 readonly fixture SQL expects the BLD-TEST public schema, got ${JSON.stringify(session?.tenant?.schemaName)}`);
  createReadonlyFixture();
  const presetsWithFixture = await requireApi(`/api/list-presets/${listKey}`, { method: "GET" });
  const readonlyFixture = presetsWithFixture.find((preset) => preset.id === readonlyFixtureId);
  assert(readonlyFixture?.readOnly === true && readonlyFixture?.isDefault === false, `A49 isolated readonly fixture should be visible and non-default: ${JSON.stringify(readonlyFixture)}`);
  const fixturePresetSnapshot = exactPresetSnapshot(presetsWithFixture);

  deleteReadonly = await api(`/api/list-presets/${listKey}/${encodeURIComponent(readonlyFixtureId)}`, { method: "DELETE" });
  const presetsAfterDeleteAttempt = await requireApi(`/api/list-presets/${listKey}`, { method: "GET" });
  assert(
    exactPresetSnapshot(presetsAfterDeleteAttempt) === fixturePresetSnapshot,
    `readonly fixture delete attempt must not change any visible preset field: ${JSON.stringify({ presetsWithFixture, presetsAfterDeleteAttempt })}`
  );
  assert(deleteReadonly.status === 409, "deleting readonly preset should be rejected");
  assert(JSON.stringify(deleteReadonly.data).includes("系统预设不可删除"), `deleting readonly preset should return formal business reason, got ${JSON.stringify(deleteReadonly.data)}`);

  overwriteReadonly = await api(`/api/list-presets/${listKey}`, {
    body: {
      name: readonlyFixtureName,
      roleCode: "ADMIN",
      shared: true,
      query: { keyword: "SHOULD_NOT_SAVE" },
      columnFilters: {}
    }
  });
  const presetsAfterOverwriteAttempt = await requireApi(`/api/list-presets/${listKey}`, { method: "GET" });
  assert(
    exactPresetSnapshot(presetsAfterOverwriteAttempt) === fixturePresetSnapshot,
    `readonly fixture overwrite attempt must not change any visible preset field: ${JSON.stringify({ presetsWithFixture, presetsAfterOverwriteAttempt })}`
  );
  assert(overwriteReadonly.status === 409, `overwriting readonly preset should be rejected, got ${overwriteReadonly.status}: ${JSON.stringify(overwriteReadonly.data)}`);
  assert(JSON.stringify(overwriteReadonly.data).includes("系统预设不可覆盖"), `overwriting readonly preset should return formal business reason, got ${JSON.stringify(overwriteReadonly.data)}`);

  await seedStock();
  sales = await createRedReverseSalesOut();

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
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
  assert(await page.getByTestId("column-filter-status").evaluate((node) => node.className.includes("active")), "default preset should apply the visible status as a column filter");
  assert(await page.locator('[data-testid="operation-log-preset-delete"]').isDisabled(), "readonly default preset delete button should be disabled");
  await page.getByTestId("vxe-list-table").getByText(sales.redBillNo).waitFor({ state: "visible", timeout: 3000 });
  await page.getByTestId("vxe-list-table").getByText("RED_REVERSE").first().waitFor({ state: "visible" });
  const screenshot = `a49-operation-log-default-readonly-preset-${batch}.png`;
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
    removeReadonlyFixture
  ]);
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
