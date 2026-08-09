import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { installApiSession, loginApi, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { upsertMasterDataFixture } from "./helpers/master-data-actions.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const apiBase = "http://127.0.0.1:8080";
const frontendUrl = "http://127.0.0.1:5173/";
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a160-master-data-publication-regression.json");
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);

const cases = [
  {
    type: "unit",
    listKey: "unit-master-list",
    code: `A160-U-${batch}`,
    name: `A160单位${batch}`,
    payload: { code: `A160-U-${batch}`, name: `A160单位${batch}`, decimalPlaces: "2", sortNo: "16", remark: "A160单位原备注", status: "启用" },
    patchField: "decimalPlaces",
    patchValue: 3,
    retainedField: "sortNo",
    uiField: "remark",
    uiValue: `A160单位页面备注-${batch}`
  },
  {
    type: "productionDepartment",
    listKey: "production-department-list",
    code: `A160-D-${batch}`,
    name: `A160生产部门${batch}`,
    payload: { code: `A160-D-${batch}`, name: `A160生产部门${batch}`, manager: "A160原负责人", remark: "A160部门原备注", status: "启用" },
    patchField: "manager",
    patchValue: `A160负责人-${batch}`,
    retainedField: "remark",
    uiField: "remark",
    uiValue: `A160部门页面备注-${batch}`
  }
];

const narrowCases = [
  ...cases,
  {
    type: "product",
    listKey: "product-master-list",
    code: `A160-NP-${batch}`,
    payload: { code: `A160-NP-${batch}`, name: `A160窄屏物料${batch}`, category: "成品总成", unit: "只", spec: "A160窄屏规格", status: "启用" }
  },
  {
    type: "customer",
    listKey: "customer-master-list",
    code: `A160-NC-${batch}`,
    payload: { code: `A160-NC-${batch}`, name: `A160窄屏客户${batch}`, contact: "A160窄屏联系人", status: "启用" }
  },
  {
    type: "supplier",
    listKey: "supplier-master-list",
    code: `A160-NS-${batch}`,
    payload: { code: `A160-NS-${batch}`, name: `A160窄屏供应商${batch}`, contact: "A160窄屏联系人", status: "启用" }
  },
  {
    type: "warehouse",
    listKey: "warehouse-master-list",
    code: `A160-NW-${batch}`,
    payload: { code: `A160-NW-${batch}`, name: `A160窄屏仓库${batch}`, warehouseType: "普通仓", manager: "A160窄屏仓管员", status: "启用" }
  }
];

await installApiSession(apiBase);
await mkdir(screenshotDir, { recursive: true });
await mkdir(verificationDir, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function request(pathname, options = {}) {
  const headers = new Headers(options.body === undefined ? undefined : { "Content-Type": "application/json" });
  if (options.cookie) headers.set("Cookie", options.cookie);
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { text };
  }
  return { status: response.status, text, data };
}

function expectStatus(label, response, expected) {
  assert(response.status === expected, `${label} expected HTTP ${expected}, got ${response.status}: ${response.text}`);
}

async function exactRow(fixture) {
  const query = new URLSearchParams({ keyword: fixture.code, page: "1", pageSize: "200" });
  const response = await request(`/api/lists/${fixture.listKey}?${query}`);
  expectStatus(`${fixture.type} list query`, response, 200);
  const rows = Array.isArray(response.data?.rows) ? response.data.rows.filter((row) => row.code === fixture.code) : [];
  assert(rows.length === 1, `${fixture.type} exact list query expected one row, got ${rows.length}`);
  assert(Number.isInteger(rows[0].version) && rows[0].version >= 0, `${fixture.type} list row must expose nonnegative version`);
  return rows[0];
}

function assertResponseShape(fixture, response, expectedVersion) {
  for (const field of ["id", "code", "name", "version", "status", "auditStatus"]) {
    assert(Object.hasOwn(response.data, field), `${fixture.type} response missing ${field}: ${response.text}`);
  }
  if (fixture.type === "productionDepartment") {
    assert(Object.hasOwn(response.data, "systemNo"), `productionDepartment response missing systemNo: ${response.text}`);
  }
  assert(response.data.code === fixture.code, `${fixture.type} response code mismatch: ${response.text}`);
  assert(response.data.version === expectedVersion, `${fixture.type} response version mismatch: ${response.text}`);
}

function patchPath(fixture) {
  return `/api/master-data/${fixture.type}/${encodeURIComponent(fixture.code)}`;
}

const warehouseCookie = await loginApi(apiBase, "warehouse", "warehouse123", "BLD-TEST");
const evidence = { batch, generatedAt: new Date().toISOString(), api: [], browser: [], narrowBrowser: [], published: [], selectors: {}, operationLogs: {} };

for (const fixture of cases) {
  const created = await request(`/api/master-data/${fixture.type}`, { method: "POST", body: fixture.payload });
  expectStatus(`${fixture.type} create`, created, 201);
  assertResponseShape(fixture, created, 0);

  const legacyPut = await request(patchPath(fixture), { method: "PUT", body: fixture.payload });
  expectStatus(`${fixture.type} legacy PUT`, legacyPut, 405);

  const beforeDenied = await exactRow(fixture);
  const denied = await request(patchPath(fixture), {
    method: "PATCH",
    cookie: warehouseCookie,
    body: { version: beforeDenied.version, changes: { remark: `A160无权写入-${batch}` } }
  });
  expectStatus(`${fixture.type} PATCH permission`, denied, 403);
  assert(same(await exactRow(fixture), beforeDenied), `${fixture.type} 403 must not mutate data`);

  const sparse = await request(patchPath(fixture), {
    method: "PATCH",
    body: { version: beforeDenied.version, changes: { [fixture.patchField]: fixture.patchValue } }
  });
  expectStatus(`${fixture.type} sparse PATCH`, sparse, 200);
  assertResponseShape(fixture, sparse, beforeDenied.version + 1);
  const afterSparse = await exactRow(fixture);
  assert(afterSparse[fixture.patchField] === fixture.patchValue, `${fixture.type} PATCH did not persist ${fixture.patchField}`);
  assert(same(afterSparse[fixture.retainedField], beforeDenied[fixture.retainedField]), `${fixture.type} PATCH changed omitted ${fixture.retainedField}`);

  const stale = await request(patchPath(fixture), {
    method: "PATCH",
    body: { version: beforeDenied.version, changes: { remark: `A160陈旧写入-${batch}` } }
  });
  expectStatus(`${fixture.type} stale PATCH`, stale, 409);
  assert(same(await exactRow(fixture), afterSparse), `${fixture.type} stale PATCH must not mutate data`);

  const audit = await request(`${patchPath(fixture)}/audit`, { method: "POST" });
  expectStatus(`${fixture.type} audit`, audit, 200);
  const audited = await exactRow(fixture);
  assert(audited.auditStatus === "已审核", `${fixture.type} audit must persist audited state`);
  const duplicateAudit = await request(`${patchPath(fixture)}/audit`, { method: "POST" });
  expectStatus(`${fixture.type} duplicate audit`, duplicateAudit, 409);
  const auditedPatch = await request(patchPath(fixture), {
    method: "PATCH",
    body: { version: audited.version, changes: { remark: `A160审核后写入-${batch}` } }
  });
  expectStatus(`${fixture.type} audited PATCH`, auditedPatch, 409);
  assert(same(await exactRow(fixture), audited), `${fixture.type} audited PATCH must not mutate data`);

  const reverse = await request(`${patchPath(fixture)}/reverse`, { method: "POST" });
  expectStatus(`${fixture.type} reverse`, reverse, 200);
  const reversed = await exactRow(fixture);
  assert(reversed.auditStatus !== "已审核", `${fixture.type} reverse must restore draft`);
  const duplicateReverse = await request(`${patchPath(fixture)}/reverse`, { method: "POST" });
  expectStatus(`${fixture.type} duplicate reverse`, duplicateReverse, 409);

  const disable = await request(`${patchPath(fixture)}/status`, { method: "PATCH", body: { status: "禁用" } });
  expectStatus(`${fixture.type} disable`, disable, 200);
  const disabled = await exactRow(fixture);
  assert(disabled.status === "禁用", `${fixture.type} disable must persist`);
  const enable = await request(`${patchPath(fixture)}/status`, { method: "PATCH", body: { status: "启用" } });
  expectStatus(`${fixture.type} enable`, enable, 200);
  const enabled = await exactRow(fixture);
  assert(enabled.status === "启用", `${fixture.type} enable must persist`);

  const logQuery = new URLSearchParams({ scope: "current", keyword: fixture.code, page: "1", pageSize: "100" });
  const logs = await request(`/api/lists/operation-log-list?${logQuery}`);
  expectStatus(`${fixture.type} operation log query`, logs, 200);
  const actions = new Set((logs.data?.rows ?? []).map((row) => row.action));
  for (const action of ["CREATE_MASTER_DATA", "PATCH_MASTER_DATA", "AUDIT_MASTER_DATA", "REVERSE_MASTER_DATA", "DISABLE_MASTER_DATA", "ENABLE_MASTER_DATA"]) {
    assert(actions.has(action), `${fixture.type} operation log missing ${action}: ${JSON.stringify([...actions])}`);
  }
  evidence.operationLogs[fixture.type] = [...actions].filter((action) => action.includes("MASTER_DATA"));
  evidence.api.push({ type: fixture.type, code: fixture.code, version: enabled.version, status: enabled.status, auditStatus: enabled.auditStatus });
}

const narrowProductFixture = narrowCases.find((fixture) => fixture.type === "product");
assert(narrowProductFixture, "A160 narrow product fixture is required");
await upsertMasterDataFixture({
  apiBase,
  type: "productName",
  payload: {
    code: `A160-NPN-${batch}`,
    name: narrowProductFixture.payload.name,
    status: "启用"
  },
  audit: true
});

for (const fixture of narrowCases.slice(cases.length)) {
  const created = await request(`/api/master-data/${fixture.type}`, { method: "POST", body: fixture.payload });
  expectStatus(`${fixture.type} narrow fixture create`, created, 201);
}

async function ensureBrowserSession(page) {
  await page.goto(frontendUrl, { waitUntil: "domcontentloaded" });
  if (await page.getByTestId("content-area").isVisible({ timeout: 1500 }).catch(() => false)) return;
  const accountSetSelect = page.getByTestId("login-account-set");
  if (await accountSetSelect.isVisible({ timeout: 1500 }).catch(() => false)) {
    const accountSetOption = accountSetSelect.locator('option[value="BLD-TEST"]');
    const loaded = await accountSetOption.waitFor({ state: "attached", timeout: 5000 }).then(() => true).catch(() => false);
    if (!loaded) {
      if (await page.getByTestId("content-area").isVisible({ timeout: 1000 }).catch(() => false)) return;
      const publicChoices = await page.evaluate(async () => {
        const response = await fetch("/api/system/account-sets");
        return response.ok ? (await response.json()).accountSets ?? [] : [];
      });
      assert(publicChoices.some((choice) => choice?.code === "BLD-TEST"), `login account-set API did not expose BLD-TEST: ${JSON.stringify(publicChoices)}`);
      if (await page.getByTestId("content-area").isVisible({ timeout: 1000 }).catch(() => false)) return;
      await page.reload({ waitUntil: "domcontentloaded" });
      await accountSetOption.waitFor({ state: "attached", timeout: 15000 });
    }
  }
  await loginAsAdmin(page);
}

async function openRecord(page, fixture, editing) {
  await page.getByTestId("module-基础资料").hover();
  await page.getByTestId(`entry-${fixture.listKey}`).click();
  await page.getByTestId(`list-page-${fixture.listKey}`).waitFor({ state: "visible" });
  await page.getByTestId("list-keyword").fill(fixture.code);
  await page.getByTestId("list-keyword").press("Enter");
  await page.getByTestId(`open-master-${fixture.code}`).click();
  await page.getByTestId("master-record-page").waitFor({ state: "visible" });
  if (editing) await page.getByTestId("master-record-edit").click();
}

function isPatchResponse(response, fixture) {
  const url = new URL(response.url());
  return response.request().method() === "PATCH" && url.pathname === patchPath(fixture);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
try {
  await ensureBrowserSession(page);
  for (const fixture of cases) {
    await openRecord(page, fixture, true);
    const field = page.getByTestId(`master-record-${fixture.uiField}`);
    await field.fill(fixture.uiValue);
    const savePromise = page.waitForResponse((response) => isPatchResponse(response, fixture));
    await page.getByTestId("master-record-save").click();
    const saved = await savePromise;
    assert(saved.status() === 200, `${fixture.type} browser PATCH expected 200, got ${saved.status()}`);
    await page.getByTestId("master-record-cancel").click();
    await page.getByTestId(`list-page-${fixture.listKey}`).waitFor({ state: "visible" });
    await page.getByTestId("list-keyword").fill(fixture.code);
    await page.getByTestId("list-keyword").press("Enter");
    await page.getByTestId(`open-master-${fixture.code}`).click();
    await page.getByTestId("master-record-page").waitFor({ state: "visible" });
    assert(await page.getByTestId(`master-record-${fixture.uiField}`).inputValue() === fixture.uiValue, `${fixture.type} browser reopen lost saved value`);
    const screenshot = `a160-${fixture.type}-save-reopen-${batch}.png`;
    await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });
    evidence.browser.push({ type: fixture.type, saveStatus: saved.status(), screenshot: `verification/playwright/${screenshot}` });
  }

  for (const fixture of cases) {
    const publish = await request(`${patchPath(fixture)}/audit`, { method: "POST" });
    expectStatus(`${fixture.type} publish after browser save`, publish, 200);
    const published = await exactRow(fixture);
    assert(published.auditStatus === "已审核", `${fixture.type} must be audited before product selector verification`);
    evidence.published.push({ type: fixture.type, code: fixture.code, version: published.version, auditStatus: published.auditStatus });
  }

  await page.goto(frontendUrl, { waitUntil: "domcontentloaded" });
  await ensureBrowserSession(page);
  await page.getByTestId("module-基础资料").click();
  await page.getByTestId("entry-product-master-list").waitFor({ state: "visible" });
  await page.getByTestId("entry-product-master-list").click();
  await page.getByTestId("list-page-product-master-list").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "新增", exact: true }).click();
  await page.getByTestId("master-record-page").waitFor({ state: "visible" });
  await page.getByTestId("master-record-unit").fill(cases[0].code);
  await page.getByTestId("master-record-unit").press("Enter");
  assert(await page.getByTestId("master-record-unit").inputValue() === cases[0].code, "product unit selector did not resolve published unit");
  await page.getByTestId("master-record-defaultWorkshop").fill(cases[1].name);
  await page.getByTestId("master-record-defaultWorkshop").press("Enter");
  assert(await page.getByTestId("master-record-defaultWorkshop").inputValue() === cases[1].name, "product workshop selector did not resolve published department");
  const selectorScreenshot = `a160-product-selector-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, selectorScreenshot), fullPage: true });
  evidence.selectors = { unit: cases[0].code, productionDepartment: cases[1].name, screenshot: `verification/playwright/${selectorScreenshot}` };
} finally {
  await browser.close();
}

const narrowBrowser = await chromium.launch({ headless: true });
const narrowContext = await narrowBrowser.newContext({ viewport: { width: 390, height: 844 } });
try {
  for (const fixture of narrowCases) {
    const narrowPage = await narrowContext.newPage();
    await ensureBrowserSession(narrowPage);
    await openRecord(narrowPage, fixture, false);
    assert(await narrowPage.getByTestId("master-record-page").isVisible(), `${fixture.type} narrow record page must be visible`);
    const screenshot = `a160-narrow-${fixture.type}-${batch}.png`;
    await narrowPage.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });
    evidence.narrowBrowser.push({ type: fixture.type, code: fixture.code, viewport: "390x844", screenshot: `verification/playwright/${screenshot}` });
    await narrowPage.close();
  }
} finally {
  await narrowBrowser.close();
}

await writeFile(resultPath, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
