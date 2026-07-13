import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginApi, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { queryExactMasterData, upsertMasterDataFixture } from "./helpers/master-data-actions.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a138-master-data-sparse-patch-regression.json");
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

function same(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function request(pathname, options = {}) {
  const method = options.method ?? "GET";
  const headers = new Headers(options.body === undefined ? undefined : { "Content-Type": "application/json" });
  if (options.cookie) {
    headers.set("Cookie", options.cookie);
  }
  const response = await fetch(`${apiBase}${pathname}`, {
    method,
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
  return { status: response.status, ok: response.ok, data, text };
}

function expectStatus(label, result, status) {
  assert(result.status === status, `${label} expected HTTP ${status}, got ${result.status}: ${result.text}`);
}

function assertSuccessEnvelope(label, data, code, expectedVersion) {
  for (const key of ["id", "systemNo", "code", "name", "version", "auditStatus", "status"]) {
    assert(Object.prototype.hasOwnProperty.call(data, key), `${label} response is missing ${key}: ${JSON.stringify(data)}`);
  }
  assert(data.code === code, `${label} response code mismatch: ${JSON.stringify(data)}`);
  assert(data.version === expectedVersion, `${label} response version expected ${expectedVersion}, got ${JSON.stringify(data.version)}`);
}

function assertSparsePreserved(label, before, after, changedField) {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === changedField || key === "version" || key === "updatedAt") {
      continue;
    }
    assert(same(after[key], before[key]), `${label} omitted field ${key} changed from ${JSON.stringify(before[key])} to ${JSON.stringify(after[key])}`);
  }
  assert(after.version === before.version + 1, `${label} version expected ${before.version + 1}, got ${after.version}`);
}

function errorReason(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const body = JSON.parse(trimmed);
    return [body.message, body.detail, body.reason].find((value) => typeof value === "string" && value.trim())?.trim() ?? "";
  } catch {
    return trimmed;
  }
}

const apiCases = [
  {
    type: "product",
    listKey: "product-master-list",
    code: `A138-P-${batch}`,
    patchField: "spec",
    patchValue: `A138稀疏规格-${batch}`,
    payload: {
      code: `A138-P-${batch}`,
      name: `A138稀疏物料${batch}`,
      category: "成品总成",
      unit: "只",
      spec: "A138原规格",
      defaultWarehouseCode: "CK-001",
      remark: "A138物料原备注",
      status: "启用"
    }
  },
  {
    type: "customer",
    listKey: "customer-master-list",
    code: `A138-C-${batch}`,
    patchField: "contact",
    patchValue: `A138客户联系人-${batch}`,
    payload: {
      code: `A138-C-${batch}`,
      name: `A138稀疏客户${batch}`,
      contact: "A138客户原联系人",
      phone: "13813800001",
      region: "广东佛山",
      remark: "A138客户原备注",
      status: "启用"
    }
  },
  {
    type: "supplier",
    listKey: "supplier-master-list",
    code: `A138-S-${batch}`,
    patchField: "contact",
    patchValue: `A138供应商联系人-${batch}`,
    payload: {
      code: `A138-S-${batch}`,
      name: `A138稀疏供应商${batch}`,
      contact: "A138供应商原联系人",
      phone: "13813800002",
      remark: "A138供应商原备注",
      status: "启用"
    }
  },
  {
    type: "warehouse",
    listKey: "warehouse-master-list",
    code: `A138-W-${batch}`,
    patchField: "manager",
    patchValue: `A138仓管员-${batch}`,
    payload: {
      code: `A138-W-${batch}`,
      name: `A138稀疏仓库${batch}`,
      warehouseType: "普通仓",
      manager: "A138原仓管员",
      address: "A138原仓库地址",
      remark: "A138仓库原备注",
      status: "启用"
    }
  }
];

for (const fixture of apiCases) {
  await upsertMasterDataFixture({ apiBase, type: fixture.type, payload: fixture.payload, audit: false });
}

const warehouseCookie = await loginApi(apiBase, "warehouse", "warehouse123", "BLD-TEST");
const apiEvidence = {
  legacyPut405: [],
  permission403: [],
  sparsePreserve: [],
  explicitNull: [],
  cas: {},
  auditedConflict: {},
  referenceRollback: {}
};

for (const fixture of apiCases) {
  const put = await request(`/api/master-data/${fixture.type}/${encodeURIComponent(fixture.code)}`, {
    method: "PUT",
    body: fixture.payload
  });
  expectStatus(`${fixture.type} legacy PUT`, put, 405);
  apiEvidence.legacyPut405.push({ type: fixture.type, status: put.status });

  const beforeDenied = await queryExactMasterData(apiBase, fixture.type, fixture.code);
  const denied = await request(`/api/master-data/${fixture.type}/${encodeURIComponent(fixture.code)}`, {
    method: "PATCH",
    cookie: warehouseCookie,
    body: { version: beforeDenied.version, changes: { remark: `A138无权写入-${batch}` } }
  });
  expectStatus(`${fixture.type} permission denial`, denied, 403);
  const afterDenied = await queryExactMasterData(apiBase, fixture.type, fixture.code);
  assert(same(afterDenied, beforeDenied), `${fixture.type} 403 must not mutate the record`);
  apiEvidence.permission403.push({ type: fixture.type, status: denied.status, version: afterDenied.version });

  const beforeSparse = afterDenied;
  const sparse = await request(`/api/master-data/${fixture.type}/${encodeURIComponent(fixture.code)}`, {
    method: "PATCH",
    body: { version: beforeSparse.version, changes: { [fixture.patchField]: fixture.patchValue } }
  });
  expectStatus(`${fixture.type} sparse PATCH`, sparse, 200);
  assertSuccessEnvelope(`${fixture.type} sparse PATCH`, sparse.data, fixture.code, beforeSparse.version + 1);
  const afterSparse = await queryExactMasterData(apiBase, fixture.type, fixture.code);
  assert(afterSparse[fixture.patchField] === fixture.patchValue, `${fixture.type} sparse PATCH did not persist ${fixture.patchField}`);
  assertSparsePreserved(`${fixture.type} sparse PATCH`, beforeSparse, afterSparse, fixture.patchField);
  apiEvidence.sparsePreserve.push({ type: fixture.type, field: fixture.patchField, version: afterSparse.version });

  const clear = await request(`/api/master-data/${fixture.type}/${encodeURIComponent(fixture.code)}`, {
    method: "PATCH",
    body: { version: afterSparse.version, changes: { remark: null } }
  });
  expectStatus(`${fixture.type} explicit null`, clear, 200);
  assertSuccessEnvelope(`${fixture.type} explicit null`, clear.data, fixture.code, afterSparse.version + 1);
  const afterNull = await queryExactMasterData(apiBase, fixture.type, fixture.code);
  assert(afterNull.remark === "", `${fixture.type} explicit null should clear remark, got ${JSON.stringify(afterNull.remark)}`);
  assertSparsePreserved(`${fixture.type} explicit null`, afterSparse, afterNull, "remark");
  apiEvidence.explicitNull.push({ type: fixture.type, field: "remark", version: afterNull.version });
}

const customer = apiCases.find((fixture) => fixture.type === "customer");
const beforeCas = await queryExactMasterData(apiBase, customer.type, customer.code);
const casWinnerValue = `A138-CAS-WIN-${batch}`;
const casLoserValue = `A138-CAS-LOSE-${batch}`;
const casWinner = await request(`/api/master-data/customer/${encodeURIComponent(customer.code)}`, {
  method: "PATCH",
  body: { version: beforeCas.version, changes: { contact: casWinnerValue } }
});
expectStatus("CAS first writer", casWinner, 200);
const casLoser = await request(`/api/master-data/customer/${encodeURIComponent(customer.code)}`, {
  method: "PATCH",
  body: { version: beforeCas.version, changes: { contact: casLoserValue } }
});
expectStatus("CAS stale writer", casLoser, 409);
const afterCas = await queryExactMasterData(apiBase, customer.type, customer.code);
assert(afterCas.contact === casWinnerValue, `CAS winner was overwritten: ${JSON.stringify(afterCas)}`);
assert(afterCas.version === beforeCas.version + 1, `CAS failure must not increment version: ${JSON.stringify(afterCas)}`);
apiEvidence.cas = { firstStatus: casWinner.status, staleStatus: casLoser.status, version: afterCas.version, persisted: afterCas.contact };

const supplier = apiCases.find((fixture) => fixture.type === "supplier");
const audit = await request(`/api/master-data/supplier/${encodeURIComponent(supplier.code)}/audit`, { method: "POST" });
expectStatus("supplier audit", audit, 200);
const audited = await queryExactMasterData(apiBase, supplier.type, supplier.code);
assert(audited.auditStatus === "已审核", `supplier should be audited before audited PATCH check: ${JSON.stringify(audited)}`);
const auditedPatch = await request(`/api/master-data/supplier/${encodeURIComponent(supplier.code)}`, {
  method: "PATCH",
  body: { version: audited.version, changes: { contact: `A138审核后写入-${batch}` } }
});
expectStatus("audited supplier PATCH", auditedPatch, 409);
const afterAuditedPatch = await queryExactMasterData(apiBase, supplier.type, supplier.code);
assert(same(afterAuditedPatch, audited), "audited PATCH must preserve all fields and version");
apiEvidence.auditedConflict = { status: auditedPatch.status, version: afterAuditedPatch.version, reason: errorReason(auditedPatch.text) };

const product = apiCases.find((fixture) => fixture.type === "product");
const beforeReferenceFailure = await queryExactMasterData(apiBase, product.type, product.code);
const referenceFailure = await request(`/api/master-data/product/${encodeURIComponent(product.code)}`, {
  method: "PATCH",
  body: {
    version: beforeReferenceFailure.version,
    changes: {
      spec: `A138不应落库-${batch}`,
      defaultWarehouseCode: `A138-MISSING-${batch}`
    }
  }
});
expectStatus("invalid product reference", referenceFailure, 400);
const afterReferenceFailure = await queryExactMasterData(apiBase, product.type, product.code);
assert(same(afterReferenceFailure, beforeReferenceFailure), "invalid product reference must roll back business fields and version");
apiEvidence.referenceRollback = {
  status: referenceFailure.status,
  version: afterReferenceFailure.version,
  defaultWarehouseCode: afterReferenceFailure.defaultWarehouseCode,
  reason: errorReason(referenceFailure.text)
};

const browserCases = [
  {
    type: "product",
    listKey: "product-master-list",
    code: `A138-UI-P-${batch}`,
    field: "spec",
    value: `A138页面规格-${batch}`,
    payload: { code: `A138-UI-P-${batch}`, name: `A138页面物料${batch}`, category: "成品总成", unit: "只", spec: "A138页面原规格", status: "启用" }
  },
  {
    type: "customer",
    listKey: "customer-master-list",
    code: `A138-UI-C-${batch}`,
    field: "contact",
    value: `A138页面客户联系人-${batch}`,
    payload: { code: `A138-UI-C-${batch}`, name: `A138页面客户${batch}`, contact: "A138页面原联系人", remark: "A138页面客户备注", status: "启用" }
  },
  {
    type: "supplier",
    listKey: "supplier-master-list",
    code: `A138-UI-S-${batch}`,
    field: "contact",
    value: `A138页面供应商联系人-${batch}`,
    payload: { code: `A138-UI-S-${batch}`, name: `A138页面供应商${batch}`, contact: "A138页面原联系人", remark: "A138页面供应商备注", status: "启用" }
  },
  {
    type: "warehouse",
    listKey: "warehouse-master-list",
    code: `A138-UI-W-${batch}`,
    field: "manager",
    value: `A138页面仓管员-${batch}`,
    payload: { code: `A138-UI-W-${batch}`, name: `A138页面仓库${batch}`, warehouseType: "普通仓", manager: "A138页面原仓管员", remark: "A138页面仓库备注", status: "启用" }
  }
];

for (const fixture of browserCases) {
  await upsertMasterDataFixture({ apiBase, type: fixture.type, payload: fixture.payload, audit: false });
}

async function ensureBrowserSession(page) {
  if (!page.url().startsWith(frontendUrl)) {
    await page.goto(frontendUrl, { waitUntil: "domcontentloaded" });
  }
  const contentArea = page.getByTestId("content-area");
  if (await contentArea.isVisible({ timeout: 10000 }).catch(() => false)) {
    return;
  }
  const accountSetSelect = page.getByTestId("login-account-set");
  if (await accountSetSelect.isVisible({ timeout: 1500 }).catch(() => false)) {
    const accountSetOption = accountSetSelect.locator('option[value="BLD-TEST"]');
    const loaded = await accountSetOption.waitFor({ state: "attached", timeout: 5000 }).then(() => true).catch(() => false);
    if (!loaded) {
      if (await contentArea.isVisible({ timeout: 1000 }).catch(() => false)) {
        return;
      }
      const publicChoices = await page.evaluate(async () => {
        const response = await fetch("/api/system/account-sets");
        return response.ok ? (await response.json()).accountSets ?? [] : [];
      });
      assert(publicChoices.some((choice) => choice?.code === "BLD-TEST"), `login account-set API did not expose BLD-TEST: ${JSON.stringify(publicChoices)}`);
      if (await contentArea.isVisible({ timeout: 1000 }).catch(() => false)) {
        return;
      }
      await page.reload({ waitUntil: "domcontentloaded" });
      await accountSetOption.waitFor({ state: "attached", timeout: 10000 });
    }
  }
  await loginAsAdmin(page);
}

async function openMasterRecord(page, fixture, editing) {
  await ensureBrowserSession(page);
  await page.getByTestId("module-基础资料").hover();
  await page.getByTestId(`entry-${fixture.listKey}`).click();
  await page.getByTestId(`list-page-${fixture.listKey}`).waitFor({ state: "visible" });
  await page.getByTestId("list-keyword").fill(fixture.code);
  await page.getByTestId("list-keyword").press("Enter");
  await page.getByTestId(`open-master-${fixture.code}`).waitFor({ state: "visible" });
  await page.getByTestId(`open-master-${fixture.code}`).click();
  await page.getByTestId("master-record-page").waitFor({ state: "visible" });
  if (editing) {
    await page.getByTestId("master-record-edit").click();
    assert(await page.getByTestId(`master-record-${fixture.field}`).isEditable(), `${fixture.type} field ${fixture.field} should be editable`);
  }
}

async function reopenMasterRecordFromCurrentList(page, fixture) {
  await page.getByTestId("master-record-cancel").click();
  await page.getByTestId(`list-page-${fixture.listKey}`).waitFor({ state: "visible" });
  await page.getByTestId("list-keyword").fill(fixture.code);
  await page.getByTestId("list-keyword").press("Enter");
  await page.getByTestId(`open-master-${fixture.code}`).waitFor({ state: "visible" });
  await page.getByTestId(`open-master-${fixture.code}`).click();
  await page.getByTestId("master-record-page").waitFor({ state: "visible" });
}

function isPatchResponse(response, fixture) {
  const url = new URL(response.url());
  return response.request().method() === "PATCH"
    && url.pathname === `/api/master-data/${fixture.type}/${fixture.code}`;
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const browserEvidence = [];
let conflictEvidence = {};

try {
  for (const fixture of browserCases) {
    await openMasterRecord(page, fixture, true);
    const field = page.getByTestId(`master-record-${fixture.field}`);
    await field.fill(fixture.value);
    const saveResponsePromise = page.waitForResponse((response) => isPatchResponse(response, fixture));
    await page.getByTestId("master-record-save").click();
    const saveResponse = await saveResponsePromise;
    assert(saveResponse.status() === 200, `${fixture.type} browser save expected 200, got ${saveResponse.status()}: ${await saveResponse.text()}`);
    assert(await field.inputValue() === fixture.value, `${fixture.type} browser save changed the edited value`);

    await reopenMasterRecordFromCurrentList(page, fixture);
    const reopenedValue = await page.getByTestId(`master-record-${fixture.field}`).inputValue();
    assert(reopenedValue === fixture.value, `${fixture.type} reopen expected ${fixture.value}, got ${reopenedValue}`);
    const screenshot = `a138-${fixture.type}-save-reopen-${batch}.png`;
    await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });
    browserEvidence.push({
      type: fixture.type,
      code: fixture.code,
      field: fixture.field,
      value: reopenedValue,
      saveStatus: saveResponse.status(),
      screenshot: `verification/playwright/${screenshot}`
    });
  }

  const conflictFixture = browserCases.find((fixture) => fixture.type === "customer");
  const pageA = page;
  const pageB = await context.newPage();
  await openMasterRecord(pageA, conflictFixture, true);
  await openMasterRecord(pageB, conflictFixture, true);
  const winnerValue = `A138浏览器先保存-${batch}`;
  const loserValue = `A138浏览器后保存-${batch}`;
  await pageA.getByTestId("master-record-remark").fill(winnerValue);
  await pageB.getByTestId("master-record-remark").fill(loserValue);

  const winnerResponsePromise = pageA.waitForResponse((response) => isPatchResponse(response, conflictFixture));
  await pageA.getByTestId("master-record-save").click();
  const winnerResponse = await winnerResponsePromise;
  assert(winnerResponse.status() === 200, `browser conflict winner expected 200, got ${winnerResponse.status()}`);

  const loserResponsePromise = pageB.waitForResponse((response) => isPatchResponse(response, conflictFixture));
  await pageB.getByTestId("master-record-save").click();
  const loserResponse = await loserResponsePromise;
  const loserBody = await loserResponse.text();
  assert(loserResponse.status() === 409, `browser conflict loser expected 409, got ${loserResponse.status()}: ${loserBody}`);
  const reason = errorReason(loserBody);
  const errorText = (await pageB.getByTestId("master-record-error").innerText()).trim();
  assert(reason && errorText.includes(reason), `browser conflict should show backend reason ${JSON.stringify(reason)}, got ${JSON.stringify(errorText)}`);
  assert(await pageB.getByTestId("master-record-remark").inputValue() === loserValue, "browser conflict must retain the losing editor input");
  const conflictScreenshot = `a138-browser-cas-conflict-${batch}.png`;
  await pageB.screenshot({ path: path.join(screenshotDir, conflictScreenshot), fullPage: true });
  conflictEvidence = {
    code: conflictFixture.code,
    winnerStatus: winnerResponse.status(),
    loserStatus: loserResponse.status(),
    winnerValue,
    retainedLoserValue: loserValue,
    reason,
    errorText,
    screenshot: `verification/playwright/${conflictScreenshot}`
  };
} finally {
  await browser.close();
}

const conflictFixture = browserCases.find((fixture) => fixture.type === "customer");
const persistedConflict = await queryExactMasterData(apiBase, conflictFixture.type, conflictFixture.code);
assert(persistedConflict.remark === conflictEvidence.winnerValue, `browser conflict database value expected winner, got ${JSON.stringify(persistedConflict.remark)}`);
conflictEvidence.persistedValue = persistedConflict.remark;
conflictEvidence.version = persistedConflict.version;

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  api: apiEvidence,
  browser: browserEvidence,
  browserConflict: conflictEvidence,
  screenshots: [
    ...browserEvidence.map((item) => item.screenshot),
    conflictEvidence.screenshot
  ]
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
