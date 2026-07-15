import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { saveDocument, auditDocument } from "./helpers/document-actions.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a88-stock-count-gain-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const runId = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
const compactRunId = runId.replaceAll("-", "").toUpperCase();
const fixtureTag = `A88-STOCK-COUNT-GAIN-${runId}`;
const warehouseCode = `A88G-${compactRunId}`;
const warehouseName = `A88 盘盈仓 ${runId}`;
const billDate = "2026-06-26";
const productCode = "CP-001";
const qty = 2;
const unitPrice = 1;
const uuidPattern = /^[0-9a-f-]{36}$/i;
const documentType = "stockCountGain";
const faultPhase = process.env.A88_STOCK_COUNT_GAIN_FAULT_PHASE ?? "";
const fixtureUsername = `a88g_${compactRunId.toLowerCase()}`;
const fixturePassword = `A88-${compactRunId.slice(-8)}-Admin!`;
const fixtureDisplayName = `A88 盘盈管理员 ${runId}`;

let accountSetId = "";
let productId = "";
let fixtureUserId = "";
let fixtureGrantId = "";
let adminRoleId = "";
let billNo = "";
let browser = null;
const capturedTxnIds = new Set();
const capturedLogIds = new Set();
const createdWarehouseIds = new Set();

const result = {
  runId,
  generatedAt: new Date().toISOString(),
  ok: false,
  environment: {},
  billNo: "",
  productCode,
  warehouseCode,
  qty,
  stock: {},
  transactions: [],
  artifacts: { fixtureUsername, fixtureUserId: null, fixtureGrantId: null, adminRoleId: null },
  screenshots: [],
  cleanup: { attempted: false, capturedTxnIds: [], capturedLogIds: [], residue: null, error: "" },
  failure: null
};

await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

function assert(condition, message, detail = undefined) {
  if (!condition) throw new Error(detail === undefined ? message : `${message}: ${JSON.stringify(detail)}`);
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function uuidArray(values) {
  const normalized = [...new Set(values.filter((value) => uuidPattern.test(String(value))))].sort();
  return normalized.length
    ? `ARRAY[${normalized.map((value) => `${sqlLiteral(value)}::uuid`).join(",")}]`
    : "ARRAY[]::uuid[]";
}

function textArray(values) {
  const normalized = [...new Set(values.filter(Boolean).map(String))].sort();
  return normalized.length ? `ARRAY[${normalized.map(sqlLiteral).join(",")}]::text[]` : "ARRAY[]::text[]";
}

function lockKeyPredicate(alias, locks) {
  if (locks.length === 0) return "FALSE";
  return locks.map((row) => `(${alias}.document_type=${sqlLiteral(row.document_type)} AND ${alias}.bill_no=${sqlLiteral(row.bill_no)})`).join(" OR ");
}

function scopeKeyPredicate(alias, scopes) {
  if (scopes.length === 0) return "FALSE";
  return scopes.map((row) => `(${alias}.session_token=${sqlLiteral(row.session_token)}::uuid AND ${alias}.user_id=${sqlLiteral(row.user_id)}::uuid)`).join(" OR ");
}

function dbScalar(sql) {
  return execFileSync("docker", [
    "exec", "jdy-erp-postgres", "psql", "-U", "jdy", "-d", "jdy_erp", "-v", "ON_ERROR_STOP=1", "-tA", "-c", sql
  ], { encoding: "utf8" }).trim();
}

function dbJson(sql) {
  const value = dbScalar(sql);
  return value ? JSON.parse(value) : null;
}

function dbNumber(sql) {
  return Number(dbScalar(sql) || "0");
}

async function api(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "POST",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok && !options.expectFailure) throw new Error(`${options.method ?? "POST"} ${pathname} failed ${response.status}: ${text}`);
  return { status: response.status, body };
}

function warehouseRowsByCode() {
  return dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id::text, 'code', code, 'name', name, 'remark', COALESCE(remark, '')) ORDER BY id::text), '[]'::jsonb)::text
    FROM public.md_warehouse WHERE code=${sqlLiteral(warehouseCode)}
  `) ?? [];
}

function ownedWarehouseRows() {
  if (createdWarehouseIds.size === 0) return [];
  return dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id::text, 'code', code, 'name', name, 'remark', COALESCE(remark, '')) ORDER BY id::text), '[]'::jsonb)::text
    FROM public.md_warehouse WHERE id=ANY(${uuidArray([...createdWarehouseIds])})
  `) ?? [];
}

function stockState() {
  return dbJson(`
    SELECT jsonb_build_object(
      'balanceId', balance.id::text,
      'onHand', balance.qty_on_hand::text,
      'available', balance.qty_available::text,
      'reserved', balance.qty_reserved::text,
      'version', balance.version::text
    )::text
    FROM public.inv_stock_balance balance
    JOIN public.md_product product ON product.id=balance.product_id
    JOIN public.md_warehouse warehouse ON warehouse.id=balance.warehouse_id
    WHERE balance.account_set_id=${sqlLiteral(accountSetId)}::uuid
      AND product.code=${sqlLiteral(productCode)}
      AND warehouse.code=${sqlLiteral(warehouseCode)}
  `) ?? { balanceId: null, onHand: "0", available: "0", reserved: "0", version: null };
}

function runDocuments() {
  return dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'headerId', header.id::text,
      'billNo', header.bill_no,
      'billDate', header.bill_date::text,
      'status', header.status,
      'lineId', line.id::text,
      'lineNo', line.line_no,
      'productId', line.product_id::text,
      'warehouseId', line.warehouse_id::text,
      'qty', line.qty::text
    ) ORDER BY header.bill_no, line.line_no), '[]'::jsonb)::text
    FROM public.stock_count_gain header
    JOIN public.stock_count_gain_line line ON line.bill_id=header.id
    WHERE header.department=${sqlLiteral(fixtureTag)}
  `) ?? [];
}

function documentByBillNo(targetBillNo) {
  return runDocuments().find((row) => row.billNo === targetBillNo) ?? null;
}

function transactionsForDocument(headerId) {
  return dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', txn.id::text,
      'txnType', txn.txn_type,
      'sourceBillType', txn.source_bill_type,
      'sourceBillId', txn.source_bill_id::text,
      'sourceBillLineId', txn.source_bill_line_id::text,
      'sourceBillNo', txn.source_bill_no,
      'sourceBillDate', txn.source_bill_date::text,
      'postingAction', txn.posting_action,
      'traceQuality', txn.trace_quality,
      'reversalOfTxnId', txn.reversal_of_txn_id::text,
      'warehouseId', txn.warehouse_id::text,
      'warehouseCode', warehouse.code,
      'qtyDelta', txn.qty_delta::text
    ) ORDER BY txn.created_at, txn.id::text), '[]'::jsonb)::text
    FROM public.inv_stock_txn txn
    JOIN public.md_warehouse warehouse ON warehouse.id=txn.warehouse_id
    WHERE txn.account_set_id=${sqlLiteral(accountSetId)}::uuid
      AND txn.source_bill_type='STOCK_COUNT_GAIN'
      AND txn.source_bill_id=${sqlLiteral(headerId)}::uuid
  `) ?? [];
}

function capture(rows) {
  for (const row of rows) {
    assert(uuidPattern.test(row.id), "owned gain transaction must expose a UUID", row);
    capturedTxnIds.add(row.id);
  }
  return rows;
}

function assertGainTrace(rows, document, reversed) {
  const expected = reversed
    ? [
        { txnType: "STOCK_COUNT_GAIN", qtyDelta: qty, action: "AUDIT", reverseOf: null },
        { txnType: "STOCK_COUNT_GAIN_REVERSE", qtyDelta: -qty, action: "REVERSE", reverseOf: "STOCK_COUNT_GAIN" }
      ]
    : [{ txnType: "STOCK_COUNT_GAIN", qtyDelta: qty, action: "AUDIT", reverseOf: null }];
  assert(rows.length === expected.length, `stock count gain should expose ${expected.length} exact owned transactions`, rows);
  for (const spec of expected) {
    const row = rows.find((candidate) => candidate.txnType === spec.txnType);
    assert(row, `missing ${spec.txnType} inventory transaction`, rows);
    assert(row.sourceBillType === "STOCK_COUNT_GAIN", `${spec.txnType} must keep canonical source type`, row);
    assert(row.sourceBillId === document.headerId, `${spec.txnType} must point to the exact header UUID`, row);
    assert(row.sourceBillLineId === document.lineId, `${spec.txnType} must point to the exact line UUID`, row);
    assert(row.sourceBillNo === document.billNo, `${spec.txnType} must keep canonical bill number`, row);
    assert(row.sourceBillDate === billDate, `${spec.txnType} must keep the business date`, row);
    assert(row.postingAction === spec.action, `${spec.txnType} posting action mismatch`, row);
    assert(row.traceQuality === "EXACT", `${spec.txnType} must be EXACT`, row);
    assert(row.warehouseId === document.warehouseId && row.warehouseCode === warehouseCode, `${spec.txnType} warehouse mismatch`, row);
    assert(Number(row.qtyDelta) === spec.qtyDelta, `${spec.txnType} quantity mismatch`, row);
    if (spec.reverseOf === null) {
      assert(row.reversalOfTxnId === null, `${spec.txnType} original posting must not link a reversal`, row);
    } else {
      const original = rows.find((candidate) => candidate.txnType === spec.reverseOf);
      assert(original && row.reversalOfTxnId === original.id, `${spec.txnType} must pair with ${spec.reverseOf}`, { row, original });
    }
  }
}

async function assertHealthBeforeSession() {
  assert(new URL(apiBase).hostname === "127.0.0.1" && new URL(frontendUrl).hostname === "127.0.0.1", "A88 gain may only write through local services");
  const health = await api("/api/system/health", { method: "GET" });
  assert(health.status === 200, "local health endpoint must be available", health);
  assert(health.body?.testInventoryAdjustmentApi === true, "A88 gain requires the restricted test inventory capability", health.body);
  result.environment.health = health.body;
}

async function assertAuthenticatedEnvironmentBeforeWrites() {
  const session = await api("/api/system/session", { method: "GET" });
  const sessionAccountSetId = String(session.body?.tenant?.id ?? "");
  assert(uuidPattern.test(sessionAccountSetId) && sessionAccountSetId === accountSetId, "session must expose the exact fixture account-set UUID", session.body);
  assert(session.body?.tenant?.code === "BLD-TEST", "A88 gain writes are allowed only in BLD-TEST", session.body?.tenant);
  assert(session.body?.tenant?.schemaName === "public", "A88 gain direct SQL is allowed only in public", session.body?.tenant);
  const account = dbJson(`
    SELECT jsonb_build_object('id', id::text, 'code', code, 'schemaName', schema_name, 'enabled', enabled)::text
    FROM public.sys_account_set WHERE id=${sqlLiteral(accountSetId)}::uuid
  `);
  assert(account?.code === "BLD-TEST" && account?.schemaName === "public" && account?.enabled === true, "database account-set route must match BLD-TEST/public", account);
  const authenticatedProductId = dbScalar(`SELECT id::text FROM public.md_product WHERE code=${sqlLiteral(productCode)} AND enabled=TRUE`);
  assert(authenticatedProductId === productId, "A88 gain authenticated route must retain the prepared product UUID", { productCode, productId, authenticatedProductId });
  result.environment.tenant = session.body.tenant;
  result.environment.productId = productId;
}

function prepareFixtureRoute() {
  const route = dbJson(`
    SELECT jsonb_build_object('accountSetId', account_set.id::text, 'accountSetCode', account_set.code,
      'schemaName', account_set.schema_name, 'accountEnabled', account_set.enabled,
      'adminRoleId', role.id::text, 'roleEnabled', role.enabled)::text
    FROM public.sys_account_set account_set CROSS JOIN public.sys_role role
    WHERE account_set.code='BLD-TEST' AND role.code='ADMIN'
  `);
  assert(route?.accountSetCode === "BLD-TEST" && route?.schemaName === "public" && route?.accountEnabled === true
    && route?.roleEnabled === true && uuidPattern.test(route.accountSetId) && uuidPattern.test(route.adminRoleId), "fixture admin route must be enabled BLD-TEST/public ADMIN", route);
  accountSetId = route.accountSetId;
  adminRoleId = route.adminRoleId;
  productId = dbScalar(`SELECT id::text FROM public.md_product WHERE code=${sqlLiteral(productCode)} AND enabled=TRUE`);
  assert(uuidPattern.test(productId), "A88 gain requires an enabled run product UUID before fixture identity writes", { productCode, productId });
}

function setupFixtureAdminUser() {
  assert(uuidPattern.test(accountSetId) && uuidPattern.test(adminRoleId) && uuidPattern.test(productId), "fixture route must be prepared before creating gain identity");
  assert(dbNumber(`SELECT count(*) FROM public.sys_user WHERE username=${sqlLiteral(fixtureUsername)}`) === 0, "run-unique fixture admin username must not pre-exist", fixtureUsername);
  const created = dbJson(`
    WITH created_user AS (
      INSERT INTO public.sys_user (username, display_name, password_hash, enabled, default_account_set_id)
      VALUES (${sqlLiteral(fixtureUsername)}, ${sqlLiteral(fixtureDisplayName)}, ${sqlLiteral(`{noop}${fixturePassword}`)}, TRUE, ${sqlLiteral(accountSetId)}::uuid) RETURNING id
    ), created_role_link AS (
      INSERT INTO public.sys_user_role (user_id, role_id) SELECT id, ${sqlLiteral(adminRoleId)}::uuid FROM created_user RETURNING user_id, role_id
    ), created_grant AS (
      INSERT INTO public.sys_user_account_set (user_id, account_set_id, role_code, is_default, enabled)
      SELECT id, ${sqlLiteral(accountSetId)}::uuid, 'ADMIN', TRUE, TRUE FROM created_user RETURNING id, user_id
    )
    SELECT jsonb_build_object('userId', created_user.id::text, 'grantId', created_grant.id::text, 'roleId', created_role_link.role_id::text)::text
    FROM created_user JOIN created_role_link ON created_role_link.user_id=created_user.id JOIN created_grant ON created_grant.user_id=created_user.id
  `);
  assert(uuidPattern.test(created?.userId) && uuidPattern.test(created?.grantId) && created?.roleId === adminRoleId, "fixture admin UUID closure must be complete", created);
  fixtureUserId = created.userId;
  fixtureGrantId = created.grantId;
  Object.assign(result.artifacts, { fixtureUserId, fixtureGrantId, adminRoleId });
}

function setupWarehouse() {
  const collisions = warehouseRowsByCode();
  assert(collisions.length === 0, "run-unique gain warehouse must not pre-exist", collisions);
  const inserted = dbJson(`
    WITH created AS (
      INSERT INTO public.md_warehouse (code, name, allow_negative_stock, enabled, audit_status, remark)
      VALUES (${sqlLiteral(warehouseCode)}, ${sqlLiteral(warehouseName)}, FALSE, TRUE, 'AUDITED', ${sqlLiteral(fixtureTag)})
      RETURNING id, code, name, remark
    )
    SELECT jsonb_agg(jsonb_build_object('id', id::text, 'code', code, 'name', name, 'remark', COALESCE(remark, '')))::text FROM created
  `) ?? [];
  assert(inserted.length === 1 && uuidPattern.test(inserted[0].id) && inserted[0].remark === fixtureTag, "one run-unique gain warehouse must be inserted", inserted);
  createdWarehouseIds.add(inserted[0].id);
  const owned = ownedWarehouseRows();
  assert(owned.length === 1 && owned[0].code === warehouseCode && owned[0].name === warehouseName && owned[0].remark === fixtureTag, "created gain warehouse must retain exact ownership", owned);
  assert(stockState().balanceId === null, "gain warehouse must begin without a seeded balance", stockState());
}

async function createAndAuditInFrontend() {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const screenshots = [];
  try {
    await page.goto(frontendUrl, { waitUntil: "networkidle" });
    await loginAsAdmin(page, fixturePassword, "BLD-TEST", fixtureUsername);
    await page.getByTestId("module-库存管理").hover();
    await page.getByTestId("entry-stock-count-gain-form").click();
    await page.getByTestId("tab-stock-count-gain-form").waitFor({ state: "visible" });
    const billNoInput = page.getByTestId("stock-count-gain-bill-no");
    assert(await billNoInput.inputValue() === "", "new stock count gain bill number should be blank");
    assert(!(await billNoInput.isEditable()), "new stock count gain bill number should be readonly");
    await page.getByTestId("stock-count-gain-bill-date").fill(billDate);
    await page.getByTestId("stock-count-gain-department").fill(fixtureTag);
    await page.getByTestId("stock-count-gain-line-product").fill(productCode);
    await page.getByTestId("stock-count-gain-line-warehouse").fill(warehouseCode);
    await page.locator(".master-selector__menu button").filter({ hasText: warehouseCode }).first().click();
    await page.getByTestId("stock-count-gain-line-qty").fill(String(qty));
    await page.getByTestId("stock-count-gain-line-price").fill(String(unitPrice));
    await page.keyboard.press("Escape");
    await saveDocument(page);
    await page.waitForFunction(() => {
      const input = document.querySelector('[data-testid="stock-count-gain-bill-no"]');
      return input instanceof HTMLInputElement && /^PY\d{6}$/.test(input.value);
    });
    billNo = await billNoInput.inputValue();
    result.billNo = billNo;
    assert(/^PY\d{6}$/.test(billNo), "saved gain bill number must be generated", billNo);
    await auditDocument(page);
    await page.getByTestId("document-status").filter({ hasText: "已审核" }).waitFor({ state: "visible" });
    const formShot = `a88-stock-count-gain-form-audited-${runId}.png`;
    await page.screenshot({ path: path.join(screenshotDir, formShot), fullPage: true });
    screenshots.push(`verification/playwright/${formShot}`);
    await page.getByTestId("module-库存管理").hover();
    await page.getByTestId("query-stock-count-gain-form").click();
    await page.getByTestId("tab-stock-count-gain-form-list").waitFor({ state: "visible" });
    await page.getByTestId("list-keyword").fill(billNo);
    await page.getByTestId("list-keyword").press("Enter");
    await page.getByText(billNo).waitFor({ state: "visible", timeout: 10000 });
    const listShot = `a88-stock-count-gain-list-${runId}.png`;
    await page.screenshot({ path: path.join(screenshotDir, listShot), fullPage: true });
    screenshots.push(`verification/playwright/${listShot}`);
  } finally {
    await browser.close();
    browser = null;
  }
  return screenshots;
}

async function runScenario() {
  setupWarehouse();
  if (faultPhase === "after-warehouse") {
    throw new Error("A88 injected gain failure after unique warehouse creation");
  }
  const before = stockState();
  result.screenshots = await createAndAuditInFrontend();
  const document = documentByBillNo(billNo);
  assert(document && uuidPattern.test(document.headerId) && uuidPattern.test(document.lineId), "saved gain must expose exact header and line UUIDs", document);
  assert(document.billDate === billDate, "saved gain business date mismatch", document);
  const detailAfterAudit = (await api(`/api/stock-count-gains/${encodeURIComponent(billNo)}`, { method: "GET" })).body;
  const auditRows = capture(transactionsForDocument(document.headerId));
  assertGainTrace(auditRows, document, false);
  const afterAudit = stockState();
  assert(detailAfterAudit.document.status === "AUDITED", "gain must be audited", detailAfterAudit.document);
  assert(Number(afterAudit.onHand) === Number(before.onHand) + qty, "gain audit stock delta mismatch", { before, afterAudit });

  await api(`/api/stock-count-gains/${encodeURIComponent(billNo)}/reverse`);
  const detailAfterReverse = (await api(`/api/stock-count-gains/${encodeURIComponent(billNo)}`, { method: "GET" })).body;
  const reverseRows = capture(transactionsForDocument(document.headerId));
  assertGainTrace(reverseRows, document, true);
  const afterReverse = stockState();
  assert(detailAfterReverse.document.status === "DRAFT", "reversed gain must return to DRAFT", detailAfterReverse.document);
  assert(Number(afterReverse.onHand) === Number(before.onHand), "gain reverse must restore zero stock", { before, afterReverse });
  const financeCount = dbNumber(`
    SELECT (SELECT count(*) FROM public.ar_receivable WHERE source_bill_no=${sqlLiteral(billNo)})
         + (SELECT count(*) FROM public.ap_payable WHERE source_bill_no=${sqlLiteral(billNo)})
  `);
  assert(financeCount === 0, "stock count gain must not create finance documents", financeCount);
  result.stock = { before, afterAudit, afterReverse };
  result.transactions = reverseRows;
}

function fixtureUserState() {
  const users = dbJson(`SELECT COALESCE(jsonb_agg(to_jsonb(app_user) ORDER BY app_user.id), '[]'::jsonb)::text
    FROM public.sys_user app_user WHERE app_user.id=${sqlLiteral(fixtureUserId)}::uuid OR app_user.username=${sqlLiteral(fixtureUsername)}`) ?? [];
  assert(users.length === 1 && String(users[0].id) === fixtureUserId && users[0].username === fixtureUsername
    && users[0].display_name === fixtureDisplayName && users[0].password_hash === `{noop}${fixturePassword}`
    && users[0].enabled === true && String(users[0].default_account_set_id) === accountSetId,
  "cleanup refused a fixture gain admin without exact UUID/identity", users);
  const roleLinks = dbJson(`SELECT COALESCE(jsonb_agg(jsonb_build_object('link', to_jsonb(link), 'role', to_jsonb(role_row)) ORDER BY link.user_id, link.role_id), '[]'::jsonb)::text
    FROM public.sys_user_role link JOIN public.sys_role role_row ON role_row.id=link.role_id
    WHERE link.user_id=${sqlLiteral(fixtureUserId)}::uuid`) ?? [];
  assert(roleLinks.length === 1 && String(roleLinks[0].link?.user_id) === fixtureUserId
    && String(roleLinks[0].link?.role_id) === adminRoleId && String(roleLinks[0].role?.id) === adminRoleId
    && roleLinks[0].role?.code === "ADMIN" && roleLinks[0].role?.enabled === true,
  "cleanup refused a fixture gain role outside exact ADMIN link", roleLinks);
  const grants = dbJson(`SELECT COALESCE(jsonb_agg(jsonb_build_object('grant', to_jsonb(grant_row), 'accountSet', to_jsonb(account_set)) ORDER BY grant_row.id), '[]'::jsonb)::text
    FROM public.sys_user_account_set grant_row JOIN public.sys_account_set account_set ON account_set.id=grant_row.account_set_id
    WHERE grant_row.user_id=${sqlLiteral(fixtureUserId)}::uuid`) ?? [];
  assert(grants.length === 1 && String(grants[0].grant?.id) === fixtureGrantId
    && String(grants[0].grant?.user_id) === fixtureUserId && String(grants[0].grant?.account_set_id) === accountSetId
    && grants[0].grant?.role_code === "ADMIN" && grants[0].grant?.is_default === true && grants[0].grant?.enabled === true
    && String(grants[0].accountSet?.id) === accountSetId && grants[0].accountSet?.code === "BLD-TEST"
    && grants[0].accountSet?.schema_name === "public" && grants[0].accountSet?.enabled === true,
  "cleanup refused a fixture gain account grant outside exact BLD-TEST ADMIN grant", grants);
  const sessionScopes = dbJson(`SELECT COALESCE(jsonb_agg(to_jsonb(scope_row) ORDER BY scope_row.session_token), '[]'::jsonb)::text
    FROM public.sys_session_account_scope scope_row WHERE scope_row.user_id=${sqlLiteral(fixtureUserId)}::uuid`) ?? [];
  for (const scope of sessionScopes) {
    assert(uuidPattern.test(String(scope.session_token)) && uuidPattern.test(String(scope.scope_token))
      && String(scope.user_id) === fixtureUserId && String(scope.account_set_id) === accountSetId,
    "cleanup refused a gain session scope outside the exact fixture actor/account", scope);
  }
  return { users, roleLinks, grants, sessionScopes };
}

function discoverCleanupState() {
  const fixtureUser = fixtureUserState();
  const warehouses = dbJson(`SELECT COALESCE(jsonb_agg(to_jsonb(warehouse_row) ORDER BY warehouse_row.id), '[]'::jsonb)::text
    FROM public.md_warehouse warehouse_row
    WHERE warehouse_row.id=ANY(${uuidArray([...createdWarehouseIds])}) OR warehouse_row.code=${sqlLiteral(warehouseCode)}`) ?? [];
  assert(warehouses.length === createdWarehouseIds.size && warehouses.every((row) => createdWarehouseIds.has(String(row.id))
    && row.code === warehouseCode && row.name === warehouseName && row.remark === fixtureTag
    && row.allow_negative_stock === false && row.enabled === true && row.audit_status === "AUDITED"),
  "cleanup refused a gain warehouse without exact UUID/fixture ownership", warehouses);
  const warehouseIds = warehouses.map((row) => String(row.id)).sort();
  const ownedWarehouseIdSet = new Set(warehouseIds);
  const headers = dbJson(`SELECT COALESCE(jsonb_agg(to_jsonb(header) ORDER BY header.id), '[]'::jsonb)::text
    FROM public.stock_count_gain header
    WHERE header.department=${sqlLiteral(fixtureTag)}
       OR header.id IN (SELECT line.bill_id FROM public.stock_count_gain_line line WHERE line.warehouse_id=ANY(${uuidArray(warehouseIds)}))`) ?? [];
  assert(headers.length <= 1 && headers.every((row) => uuidPattern.test(String(row.id)) && /^PY\d{6}$/.test(row.bill_no)
    && row.bill_date === billDate && row.department === fixtureTag && row.document_type === "STK_StockCountGain"
    && row.business_type === "盘盈单"), "cleanup refused a gain header outside the exact fixture closure", headers);
  const documentIds = headers.map((row) => String(row.id)).sort();
  const billNos = headers.map((row) => row.bill_no).sort();
  const headerById = new Map(headers.map((row) => [String(row.id), row]));
  const lines = dbJson(`SELECT COALESCE(jsonb_agg(to_jsonb(line) ORDER BY line.id), '[]'::jsonb)::text
    FROM public.stock_count_gain_line line
    WHERE line.bill_id=ANY(${uuidArray(documentIds)}) OR line.warehouse_id=ANY(${uuidArray(warehouseIds)})`) ?? [];
  assert(lines.length === headers.length && lines.every((row) => uuidPattern.test(String(row.id))
    && headerById.has(String(row.bill_id)) && Number(row.line_no) === 1 && String(row.product_id) === productId
    && ownedWarehouseIdSet.has(String(row.warehouse_id)) && Number(row.qty) === qty),
  "cleanup refused a gain line outside the exact current document closure", lines);
  const lineById = new Map(lines.map((row) => [String(row.id), row]));
  const transactions = dbJson(`SELECT COALESCE(jsonb_agg(to_jsonb(txn) ORDER BY txn.id), '[]'::jsonb)::text
    FROM public.inv_stock_txn txn
    WHERE txn.warehouse_id=ANY(${uuidArray(warehouseIds)}) OR txn.source_bill_id=ANY(${uuidArray(documentIds)})`) ?? [];
  for (const txn of transactions) {
    const sourceLine = lineById.get(String(txn.source_bill_line_id));
    const isAudit = txn.txn_type === "STOCK_COUNT_GAIN" && txn.posting_action === "AUDIT"
      && Number(txn.qty_delta) === Number(sourceLine?.qty) && txn.reversal_of_txn_id === null;
    const isReverse = txn.txn_type === "STOCK_COUNT_GAIN_REVERSE" && txn.posting_action === "REVERSE"
      && Number(txn.qty_delta) === -Number(sourceLine?.qty);
    assert(uuidPattern.test(String(txn.id)) && String(txn.account_set_id) === accountSetId
      && String(txn.product_id) === productId && ownedWarehouseIdSet.has(String(txn.warehouse_id))
      && txn.source_bill_type === "STOCK_COUNT_GAIN"
      && sourceLine
      && String(sourceLine.bill_id) === String(txn.source_bill_id)
      && String(sourceLine.warehouse_id) === String(txn.warehouse_id)
      && txn.source_bill_no === headerById.get(String(sourceLine.bill_id))?.bill_no
      && txn.source_bill_date === billDate && txn.trace_quality === "EXACT"
      && (isAudit || isReverse), "cleanup refused a gain fact outside the exact current header/line/source/action closure", { txn, sourceLine });
    capturedTxnIds.add(String(txn.id));
  }
  for (const line of lines) {
    const rows = transactions.filter((txn) => String(txn.source_bill_line_id) === String(line.id));
    const auditRows = rows.filter((txn) => txn.txn_type === "STOCK_COUNT_GAIN" && txn.posting_action === "AUDIT");
    const reverseRows = rows.filter((txn) => txn.txn_type === "STOCK_COUNT_GAIN_REVERSE" && txn.posting_action === "REVERSE");
    assert((rows.length === 0 || rows.length === 1 || rows.length === 2)
      && auditRows.length === (rows.length === 0 ? 0 : 1)
      && reverseRows.length === (rows.length === 2 ? 1 : 0), "cleanup refused an incomplete or duplicate gain posting set", rows);
    if (reverseRows.length === 1) {
      assert(String(reverseRows[0].reversal_of_txn_id) === String(auditRows[0].id), "gain reverse fact must pair with the exact same-line audit fact", rows);
    }
  }
  const balances = dbJson(`SELECT COALESCE(jsonb_agg(to_jsonb(balance) ORDER BY balance.id), '[]'::jsonb)::text
    FROM public.inv_stock_balance balance WHERE balance.warehouse_id=ANY(${uuidArray(warehouseIds)})`) ?? [];
  assert(balances.every((row) => String(row.account_set_id) === accountSetId && String(row.product_id) === productId
    && ownedWarehouseIdSet.has(String(row.warehouse_id))), "cleanup refused a foreign gain balance", balances);
  const logTargetIds = [...new Set([fixtureUserId, ...documentIds])].sort();
  const logTargetNos = [...new Set([fixtureUsername, ...billNos])].sort();
  const logs = dbJson(`SELECT COALESCE(jsonb_agg(to_jsonb(log_row) ORDER BY log_row.id), '[]'::jsonb)::text
    FROM public.sys_operation_log log_row
    WHERE log_row.operated_by=${sqlLiteral(fixtureUserId)}::uuid OR log_row.actor_username=${sqlLiteral(fixtureUsername)}
       OR log_row.target_id=ANY(${uuidArray(logTargetIds)}) OR log_row.target_no=ANY(${textArray(logTargetNos)})`) ?? [];
  for (const log of logs) {
    assert(uuidPattern.test(String(log.id)) && String(log.operated_by ?? "") === fixtureUserId
      && log.actor_type === "USER" && log.actor_username === fixtureUsername,
      "cleanup refused an operation log outside the exact gain fixture actor", log);
    capturedLogIds.add(String(log.id));
  }
  const locks = dbJson(`SELECT COALESCE(jsonb_agg(to_jsonb(lock_row) ORDER BY lock_row.document_type, lock_row.bill_no), '[]'::jsonb)::text
    FROM public.doc_edit_lock lock_row
    WHERE (lock_row.document_type=${sqlLiteral(documentType)} AND lock_row.bill_no=ANY(${textArray(billNos)}))
       OR lock_row.holder_user_id=${sqlLiteral(fixtureUserId)}::uuid OR lock_row.holder_username=${sqlLiteral(fixtureUsername)}`) ?? [];
  for (const lock of locks) {
    assert(lock.document_type === documentType && billNos.includes(lock.bill_no)
      && String(lock.holder_user_id) === fixtureUserId && lock.holder_username === fixtureUsername,
    "cleanup refused a gain document lock outside the exact fixture actor/document", lock);
  }
  return {
    fixtureUser, warehouses, headers, lines, transactions, balances, logs, locks,
    warehouseIds, documentIds, billNos, lineIds: lines.map((row) => String(row.id)).sort(),
    txnIds: transactions.map((row) => String(row.id)).sort(), balanceIds: balances.map((row) => String(row.id)).sort(),
    logIds: logs.map((row) => String(row.id)).sort(), logTargetIds, logTargetNos
  };
}

function cleanupFixtures() {
  result.cleanup.attempted = true;
  const state = discoverCleanupState();
  const { documentIds, lineIds, billNos, warehouseIds, txnIds, balanceIds, logIds, logTargetIds, logTargetNos } = state;
  const scopeTokens = state.fixtureUser.sessionScopes.map((row) => String(row.session_token)).sort();
  result.cleanup.capturedTxnIds = [...capturedTxnIds].sort();
  result.cleanup.capturedLogIds = [...capturedLogIds].sort();
  assert(txnIds.every((id) => capturedTxnIds.has(id)), "all gain cleanup inventory facts must have captured UUIDs", { txnIds, captured: result.cleanup.capturedTxnIds });

  dbScalar(`
    BEGIN;
    SET LOCAL lock_timeout='5s';
    SET LOCAL statement_timeout='30s';
    LOCK TABLE public.sys_user, public.sys_role, public.sys_user_role, public.sys_account_set,
      public.sys_user_account_set, public.sys_session_account_scope, public.md_warehouse,
      public.stock_count_gain, public.stock_count_gain_line, public.inv_stock_txn,
      public.inv_stock_balance, public.sys_operation_log, public.doc_edit_lock
      IN SHARE ROW EXCLUSIVE MODE;
    DO $a88_stock_count_gain_cleanup$
    DECLARE
      actual jsonb;
    BEGIN
      SELECT COALESCE(jsonb_agg(to_jsonb(app_user) ORDER BY app_user.id), '[]'::jsonb) INTO actual FROM public.sys_user app_user
      WHERE app_user.id=${sqlLiteral(fixtureUserId)}::uuid OR app_user.username=${sqlLiteral(fixtureUsername)};
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(state.fixtureUser.users))}::jsonb THEN RAISE EXCEPTION 'A88 gain cleanup refused: user snapshot changed'; END IF;
      SELECT COALESCE(jsonb_agg(jsonb_build_object('link', to_jsonb(link), 'role', to_jsonb(role_row)) ORDER BY link.user_id, link.role_id), '[]'::jsonb) INTO actual
      FROM public.sys_user_role link JOIN public.sys_role role_row ON role_row.id=link.role_id WHERE link.user_id=${sqlLiteral(fixtureUserId)}::uuid;
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(state.fixtureUser.roleLinks))}::jsonb THEN RAISE EXCEPTION 'A88 gain cleanup refused: role snapshot changed'; END IF;
      SELECT COALESCE(jsonb_agg(jsonb_build_object('grant', to_jsonb(grant_row), 'accountSet', to_jsonb(account_set)) ORDER BY grant_row.id), '[]'::jsonb) INTO actual
      FROM public.sys_user_account_set grant_row JOIN public.sys_account_set account_set ON account_set.id=grant_row.account_set_id WHERE grant_row.user_id=${sqlLiteral(fixtureUserId)}::uuid;
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(state.fixtureUser.grants))}::jsonb THEN RAISE EXCEPTION 'A88 gain cleanup refused: grant snapshot changed'; END IF;
      SELECT COALESCE(jsonb_agg(to_jsonb(scope_row) ORDER BY scope_row.session_token), '[]'::jsonb) INTO actual FROM public.sys_session_account_scope scope_row WHERE scope_row.user_id=${sqlLiteral(fixtureUserId)}::uuid;
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(state.fixtureUser.sessionScopes))}::jsonb THEN RAISE EXCEPTION 'A88 gain cleanup refused: session scope snapshot changed'; END IF;
      SELECT COALESCE(jsonb_agg(to_jsonb(warehouse_row) ORDER BY warehouse_row.id), '[]'::jsonb) INTO actual FROM public.md_warehouse warehouse_row
      WHERE warehouse_row.id=ANY(${uuidArray([...createdWarehouseIds])}) OR warehouse_row.code=${sqlLiteral(warehouseCode)};
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(state.warehouses))}::jsonb THEN RAISE EXCEPTION 'A88 gain cleanup refused: warehouse snapshot changed'; END IF;
      SELECT COALESCE(jsonb_agg(to_jsonb(header) ORDER BY header.id), '[]'::jsonb) INTO actual FROM public.stock_count_gain header
      WHERE header.department=${sqlLiteral(fixtureTag)} OR header.id IN (SELECT line.bill_id FROM public.stock_count_gain_line line WHERE line.warehouse_id=ANY(${uuidArray(warehouseIds)}));
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(state.headers))}::jsonb THEN RAISE EXCEPTION 'A88 gain cleanup refused: header snapshot changed'; END IF;
      SELECT COALESCE(jsonb_agg(to_jsonb(line) ORDER BY line.id), '[]'::jsonb) INTO actual FROM public.stock_count_gain_line line
      WHERE line.bill_id=ANY(${uuidArray(documentIds)}) OR line.warehouse_id=ANY(${uuidArray(warehouseIds)});
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(state.lines))}::jsonb THEN RAISE EXCEPTION 'A88 gain cleanup refused: line snapshot changed'; END IF;
      SELECT COALESCE(jsonb_agg(to_jsonb(txn) ORDER BY txn.id), '[]'::jsonb) INTO actual FROM public.inv_stock_txn txn
      WHERE txn.warehouse_id=ANY(${uuidArray(warehouseIds)}) OR txn.source_bill_id=ANY(${uuidArray(documentIds)});
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(state.transactions))}::jsonb THEN RAISE EXCEPTION 'A88 gain cleanup refused: transaction snapshot changed'; END IF;
      SELECT COALESCE(jsonb_agg(to_jsonb(balance) ORDER BY balance.id), '[]'::jsonb) INTO actual FROM public.inv_stock_balance balance WHERE balance.warehouse_id=ANY(${uuidArray(warehouseIds)});
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(state.balances))}::jsonb THEN RAISE EXCEPTION 'A88 gain cleanup refused: balance snapshot changed'; END IF;
      SELECT COALESCE(jsonb_agg(to_jsonb(log_row) ORDER BY log_row.id), '[]'::jsonb) INTO actual FROM public.sys_operation_log log_row
      WHERE log_row.operated_by=${sqlLiteral(fixtureUserId)}::uuid OR log_row.actor_username=${sqlLiteral(fixtureUsername)}
         OR log_row.target_id=ANY(${uuidArray(logTargetIds)}) OR log_row.target_no=ANY(${textArray(logTargetNos)});
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(state.logs))}::jsonb THEN RAISE EXCEPTION 'A88 gain cleanup refused: log snapshot changed'; END IF;
      SELECT COALESCE(jsonb_agg(to_jsonb(lock_row) ORDER BY lock_row.document_type, lock_row.bill_no), '[]'::jsonb) INTO actual FROM public.doc_edit_lock lock_row
      WHERE (lock_row.document_type=${sqlLiteral(documentType)} AND lock_row.bill_no=ANY(${textArray(billNos)}))
         OR lock_row.holder_user_id=${sqlLiteral(fixtureUserId)}::uuid OR lock_row.holder_username=${sqlLiteral(fixtureUsername)};
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(state.locks))}::jsonb THEN RAISE EXCEPTION 'A88 gain cleanup refused: document lock snapshot changed'; END IF;

      DELETE FROM public.doc_edit_lock lock_row WHERE ${lockKeyPredicate("lock_row", state.locks)};
      DELETE FROM public.sys_operation_log WHERE id=ANY(${uuidArray(logIds)});
      DELETE FROM public.inv_stock_txn WHERE id=ANY(${uuidArray(txnIds)});
      DELETE FROM public.stock_count_gain_line WHERE id=ANY(${uuidArray(lineIds)});
      DELETE FROM public.stock_count_gain WHERE id=ANY(${uuidArray(documentIds)});
      DELETE FROM public.inv_stock_balance WHERE id=ANY(${uuidArray(balanceIds)});
      DELETE FROM public.md_warehouse WHERE id=ANY(${uuidArray(warehouseIds)});
      DELETE FROM public.sys_session_account_scope scope_row WHERE ${scopeKeyPredicate("scope_row", state.fixtureUser.sessionScopes)};
      DELETE FROM public.sys_user_account_set WHERE id=${sqlLiteral(fixtureGrantId)}::uuid AND user_id=${sqlLiteral(fixtureUserId)}::uuid;
      DELETE FROM public.sys_user_role WHERE user_id=${sqlLiteral(fixtureUserId)}::uuid AND role_id=${sqlLiteral(adminRoleId)}::uuid;
      DELETE FROM public.sys_user WHERE id=${sqlLiteral(fixtureUserId)}::uuid AND username=${sqlLiteral(fixtureUsername)};

      IF EXISTS (SELECT 1 FROM public.stock_count_gain WHERE id=ANY(${uuidArray(documentIds)}) OR department=${sqlLiteral(fixtureTag)})
         OR EXISTS (SELECT 1 FROM public.stock_count_gain_line WHERE id=ANY(${uuidArray(lineIds)}) OR warehouse_id=ANY(${uuidArray(warehouseIds)}))
         OR EXISTS (SELECT 1 FROM public.inv_stock_txn WHERE id=ANY(${uuidArray(txnIds)}) OR warehouse_id=ANY(${uuidArray(warehouseIds)}) OR source_bill_id=ANY(${uuidArray(documentIds)}))
         OR EXISTS (SELECT 1 FROM public.inv_stock_balance WHERE id=ANY(${uuidArray(balanceIds)}) OR warehouse_id=ANY(${uuidArray(warehouseIds)}))
         OR EXISTS (SELECT 1 FROM public.md_warehouse WHERE id=ANY(${uuidArray(warehouseIds)}) OR code=${sqlLiteral(warehouseCode)})
         OR EXISTS (SELECT 1 FROM public.sys_operation_log WHERE id=ANY(${uuidArray(logIds)}) OR operated_by=${sqlLiteral(fixtureUserId)}::uuid OR actor_username=${sqlLiteral(fixtureUsername)} OR target_id=ANY(${uuidArray(logTargetIds)}) OR target_no=ANY(${textArray(logTargetNos)}))
         OR EXISTS (SELECT 1 FROM public.doc_edit_lock WHERE (document_type=${sqlLiteral(documentType)} AND bill_no=ANY(${textArray(billNos)})) OR holder_user_id=${sqlLiteral(fixtureUserId)}::uuid OR holder_username=${sqlLiteral(fixtureUsername)})
         OR EXISTS (SELECT 1 FROM public.sys_session_account_scope WHERE user_id=${sqlLiteral(fixtureUserId)}::uuid OR session_token=ANY(${uuidArray(scopeTokens)}))
         OR EXISTS (SELECT 1 FROM public.sys_user_account_set WHERE user_id=${sqlLiteral(fixtureUserId)}::uuid OR id=${sqlLiteral(fixtureGrantId)}::uuid)
         OR EXISTS (SELECT 1 FROM public.sys_user_role WHERE user_id=${sqlLiteral(fixtureUserId)}::uuid)
         OR EXISTS (SELECT 1 FROM public.sys_user WHERE id=${sqlLiteral(fixtureUserId)}::uuid OR username=${sqlLiteral(fixtureUsername)}) THEN
        RAISE EXCEPTION 'A88 gain cleanup closure is not zero';
      END IF;
    END;
    $a88_stock_count_gain_cleanup$;
    COMMIT;
  `);

  const residue = {
    documents: dbNumber(`SELECT count(*) FROM public.stock_count_gain WHERE department=${sqlLiteral(fixtureTag)}`),
    lines: lineIds.length ? dbNumber(`SELECT count(*) FROM public.stock_count_gain_line WHERE id=ANY(${uuidArray(lineIds)})`) : 0,
    transactions: txnIds.length ? dbNumber(`SELECT count(*) FROM public.inv_stock_txn WHERE id=ANY(${uuidArray(txnIds)})`) : 0,
    balances: balanceIds.length ? dbNumber(`SELECT count(*) FROM public.inv_stock_balance WHERE id=ANY(${uuidArray(balanceIds)})`) : 0,
    warehouses: dbNumber(`SELECT count(*) FROM public.md_warehouse WHERE code=${sqlLiteral(warehouseCode)}`),
    locks: dbNumber(`SELECT count(*) FROM public.doc_edit_lock WHERE (document_type=${sqlLiteral(documentType)} AND bill_no=ANY(${textArray(billNos)})) OR holder_user_id=${sqlLiteral(fixtureUserId)}::uuid OR holder_username=${sqlLiteral(fixtureUsername)}`),
    logs: dbNumber(`SELECT count(*) FROM public.sys_operation_log WHERE id=ANY(${uuidArray(logIds)}) OR operated_by=${sqlLiteral(fixtureUserId)}::uuid OR actor_username=${sqlLiteral(fixtureUsername)} OR target_id=ANY(${uuidArray(logTargetIds)}) OR target_no=ANY(${textArray(logTargetNos)})`),
    actorLogs: dbNumber(`SELECT count(*) FROM public.sys_operation_log WHERE operated_by=${sqlLiteral(fixtureUserId)}::uuid OR actor_username=${sqlLiteral(fixtureUsername)}`),
    sessionScopes: dbNumber(`SELECT count(*) FROM public.sys_session_account_scope WHERE user_id=${sqlLiteral(fixtureUserId)}::uuid OR session_token=ANY(${uuidArray(scopeTokens)})`),
    userRoles: dbNumber(`SELECT count(*) FROM public.sys_user_role WHERE user_id=${sqlLiteral(fixtureUserId)}::uuid`),
    userGrants: dbNumber(`SELECT count(*) FROM public.sys_user_account_set WHERE user_id=${sqlLiteral(fixtureUserId)}::uuid OR id=${sqlLiteral(fixtureGrantId)}::uuid`),
    users: dbNumber(`SELECT count(*) FROM public.sys_user WHERE id=${sqlLiteral(fixtureUserId)}::uuid OR username=${sqlLiteral(fixtureUsername)}`)
  };
  result.cleanup.residue = residue;
  assert(Object.values(residue).every((value) => value === 0), "A88 gain cleanup must leave zero residue", residue);
}

let primaryError = null;
try {
  await assertHealthBeforeSession();
  prepareFixtureRoute();
  setupFixtureAdminUser();
  if (faultPhase === "after-identity") {
    throw new Error("A88 injected gain failure after fixture identity creation");
  }
  await installApiSession(apiBase, fixtureUsername, fixturePassword, "BLD-TEST");
  await assertAuthenticatedEnvironmentBeforeWrites();
  await runScenario();
} catch (error) {
  primaryError = error;
  result.failure = error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { message: String(error) };
} finally {
  if (browser) {
    await browser.close().catch(() => null);
    browser = null;
  }
  if (fixtureUserId) {
    try {
      cleanupFixtures();
    } catch (error) {
      result.cleanup.error = error instanceof Error ? error.message : String(error);
    }
  }
  result.ok = primaryError === null && result.cleanup.error === "" && result.cleanup.residue !== null
    && Object.values(result.cleanup.residue).every((value) => value === 0);
  await writeFile(resultPath, JSON.stringify(result, null, 2));
}

if (primaryError || result.cleanup.error) {
  throw new Error(`A88 stock count gain regression failed: ${primaryError?.message ?? "scenario passed"}; cleanup: ${result.cleanup.error || "ok"}`, { cause: primaryError ?? undefined });
}

console.log(JSON.stringify(result, null, 2));
