import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { loginApi } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const resultPath = path.join(verificationDir, "a134-security-boundary-regression.json");
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const token = randomBytes(6).toString("hex");
const fixtureKey = `A134_SECURITY_${batch}_${token}`;
const salesRemark = fixtureKey;
const presetListKey = "operation-log-list";
const personalPresetName = `${fixtureKey}_PERSONAL`;
const rolePresetName = `${fixtureKey}_ROLE`;
const generalPresetName = `${fixtureKey}_GENERAL`;
const missingResetUsername = `a134missing${batch}${token}`;
const existingResetContact = `${fixtureKey}_RESET_EXISTING`;
const missingResetContact = `${fixtureKey}_RESET_MISSING`;
const receivableBillNo = `YS-${fixtureKey}`;
const payableBillNo = `YF-${fixtureKey}`;
const inventoryTxnType = `A134_SECURITY_ADJUST_${batch}_${token}`;
const inventorySourceType = `A134_SECURITY:${batch}:${token}`;
const legacySourceBillNo = `${fixtureKey}_LEGACY`;
const productCode = "CP-001";
const warehouseCode = "CK-001";

await mkdir(verificationDir, { recursive: true });

const result = {
  batch,
  fixtureKey,
  generatedAt: new Date().toISOString(),
  ok: false,
  requests: [],
  assertions: [],
  cleanup: {},
  intentionalArtifacts: {
    numberingSequencesRestored: false,
    reason: "Formal document numbers are never reused; temporary sales-order, receipt, and payment numbers remain consumed after their rows are removed."
  }
};
const cleanupTasks = [];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function errorText(error) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function nullableSql(value, type = "numeric") {
  return value == null ? `NULL::${type}` : `${sqlLiteral(value)}::${type}`;
}

function jsonbSql(value) {
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
}

function sqlScalar(statement) {
  return execFileSync(
    "docker",
    ["exec", "jdy-erp-postgres", "psql", "-X", "-U", "jdy", "-d", "jdy_erp", "-v", "ON_ERROR_STOP=1", "-tAq", "-c", statement],
    { encoding: "utf8" }
  ).trim();
}

function sqlJson(statement) {
  const raw = sqlScalar(statement);
  return raw ? JSON.parse(raw) : null;
}

async function request(cookie, pathname, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (cookie) {
    headers.set("Cookie", cookie);
  }
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { text };
    }
  }
  return { status: response.status, ok: response.ok, data, text };
}

function expectStatus(label, response, expectedStatus) {
  result.requests.push({ label, expectedStatus, actualStatus: response.status });
  assert(response.status === expectedStatus, `${label} should return ${expectedStatus}, got ${response.status}: ${response.text}`);
}

function pass(name, details = {}) {
  result.assertions.push({ name, ...details });
}

function addCleanup(name, task) {
  cleanupTasks.push({ name, task });
}

function presetSnapshot() {
  return sqlJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(preset) ORDER BY preset.id::text), '[]'::jsonb)::text
    FROM public.sys_list_filter_preset preset
    WHERE preset.list_key = ${sqlLiteral(presetListKey)}
  `);
}

function passwordResetFingerprint() {
  return sqlJson(`
    SELECT jsonb_build_object(
      'requests', (
        SELECT md5(COALESCE(string_agg(to_jsonb(row_value)::text, E'\\n' ORDER BY row_value.id::text), ''))
        FROM public.sys_password_reset_request row_value
      ),
      'requestLogs', (
        SELECT md5(COALESCE(string_agg(to_jsonb(row_value)::text, E'\\n' ORDER BY row_value.id::text), ''))
        FROM public.sys_operation_log row_value
        WHERE row_value.module_code = 'SYSTEM' AND row_value.action_code = 'PASSWORD_RESET_REQUEST'
      )
    )::text
  `);
}

function financeFingerprint() {
  return sqlJson(`
    SELECT jsonb_build_object(
      'receivables', (SELECT md5(COALESCE(string_agg(to_jsonb(row_value)::text, E'\\n' ORDER BY row_value.id::text), '')) FROM public.ar_receivable row_value),
      'receipts', (SELECT md5(COALESCE(string_agg(to_jsonb(row_value)::text, E'\\n' ORDER BY row_value.id::text), '')) FROM public.ar_receipt row_value),
      'payables', (SELECT md5(COALESCE(string_agg(to_jsonb(row_value)::text, E'\\n' ORDER BY row_value.id::text), '')) FROM public.ap_payable row_value),
      'payments', (SELECT md5(COALESCE(string_agg(to_jsonb(row_value)::text, E'\\n' ORDER BY row_value.id::text), '')) FROM public.ap_payment row_value),
      'successLogs', (
        SELECT md5(COALESCE(string_agg(to_jsonb(row_value)::text, E'\\n' ORDER BY row_value.id::text), ''))
        FROM public.sys_operation_log row_value
        WHERE row_value.module_code = 'FINANCE' AND row_value.success = TRUE
      )
    )::text
  `);
}

function financeFixtureSnapshot() {
  return sqlJson(`
    SELECT jsonb_build_object(
      'receivable', (SELECT to_jsonb(row_value) FROM public.ar_receivable row_value WHERE row_value.bill_no = ${sqlLiteral(receivableBillNo)}),
      'receipts', COALESCE((
        SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id::text)
        FROM public.ar_receipt row_value
        WHERE row_value.receivable_id = (SELECT id FROM public.ar_receivable WHERE bill_no = ${sqlLiteral(receivableBillNo)})
      ), '[]'::jsonb),
      'payable', (SELECT to_jsonb(row_value) FROM public.ap_payable row_value WHERE row_value.bill_no = ${sqlLiteral(payableBillNo)}),
      'payments', COALESCE((
        SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id::text)
        FROM public.ap_payment row_value
        WHERE row_value.payable_id = (SELECT id FROM public.ap_payable WHERE bill_no = ${sqlLiteral(payableBillNo)})
      ), '[]'::jsonb),
      'successLogs', COALESCE((
        SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.operated_at, row_value.id::text)
        FROM public.sys_operation_log row_value
        WHERE row_value.success = TRUE
          AND row_value.target_id IN (
            SELECT id FROM public.ar_receivable WHERE bill_no = ${sqlLiteral(receivableBillNo)}
            UNION ALL
            SELECT id FROM public.ap_payable WHERE bill_no = ${sqlLiteral(payableBillNo)}
          )
      ), '[]'::jsonb)
    )::text
  `);
}

function salesOrderSnapshot(billNo) {
  return sqlJson(`
    SELECT jsonb_build_object(
      'header', (SELECT to_jsonb(row_value) FROM public.sales_order row_value WHERE row_value.bill_no = ${sqlLiteral(billNo)}),
      'lines', COALESCE((
        SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.line_no, row_value.id::text)
        FROM public.sales_order_line row_value
        WHERE row_value.order_id = (SELECT id FROM public.sales_order WHERE bill_no = ${sqlLiteral(billNo)})
      ), '[]'::jsonb),
      'successLogs', COALESCE((
        SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.operated_at, row_value.id::text)
        FROM public.sys_operation_log row_value
        WHERE row_value.success = TRUE
          AND row_value.target_id = (SELECT id FROM public.sales_order WHERE bill_no = ${sqlLiteral(billNo)})
      ), '[]'::jsonb),
      'locks', COALESCE((
        SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.document_type, row_value.bill_no)
        FROM public.doc_edit_lock row_value
        WHERE row_value.document_type = 'salesOrder' AND row_value.bill_no = ${sqlLiteral(billNo)}
      ), '[]'::jsonb)
    )::text
  `);
}

function lockSnapshot(billNo) {
  return sqlJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY row_value.document_type, row_value.bill_no), '[]'::jsonb)::text
    FROM public.doc_edit_lock row_value
    WHERE row_value.document_type = 'salesOrder' AND row_value.bill_no = ${sqlLiteral(billNo)}
  `);
}

function inventorySnapshot() {
  return sqlJson(`
    SELECT jsonb_build_object(
      'balance', (
        SELECT to_jsonb(balance)
        FROM public.inv_stock_balance balance
        JOIN public.sys_account_set account_set ON account_set.id = balance.account_set_id
        JOIN public.md_product product ON product.id = balance.product_id
        JOIN public.md_warehouse warehouse ON warehouse.id = balance.warehouse_id
        WHERE account_set.code = 'BLD-TEST'
          AND product.code = ${sqlLiteral(productCode)}
          AND warehouse.code = ${sqlLiteral(warehouseCode)}
      ),
      'fixtureTxns', COALESCE((
        SELECT jsonb_agg(to_jsonb(txn) ORDER BY txn.occurred_at, txn.id::text)
        FROM public.inv_stock_txn txn
        JOIN public.sys_account_set account_set ON account_set.id = txn.account_set_id
        JOIN public.md_product product ON product.id = txn.product_id
        JOIN public.md_warehouse warehouse ON warehouse.id = txn.warehouse_id
        WHERE account_set.code = 'BLD-TEST'
          AND product.code = ${sqlLiteral(productCode)}
          AND warehouse.code = ${sqlLiteral(warehouseCode)}
          AND (
            (txn.txn_type = ${sqlLiteral(inventoryTxnType)} AND txn.source_bill_type = ${sqlLiteral(inventorySourceType)})
            OR (txn.txn_type = 'SALES_OUT' AND txn.source_bill_type = ${sqlLiteral(inventorySourceType)})
            OR (txn.txn_type = 'SALES_OUT' AND txn.source_bill_type = ${sqlLiteral(`SALES_OUT:${legacySourceBillNo}`)})
            OR (txn.txn_type = 'PURCHASE_IN' AND txn.source_bill_type = ${sqlLiteral(`PURCHASE_IN:${legacySourceBillNo}`)})
          )
      ), '[]'::jsonb)
    )::text
  `);
}

function requirePermissions(session, expectedPresent, expectedAbsent, label) {
  const permissions = new Set(session.user.permissionCodes ?? []);
  for (const permission of expectedPresent) {
    assert(permissions.has(permission), `${label} should have ${permission}`);
  }
  for (const permission of expectedAbsent) {
    assert(!permissions.has(permission), `${label} should not have ${permission}`);
  }
}

let primaryError = null;
let adminCookie = "";
let warehouseCookie = "";
let financeCookie = "";
let adminSession = null;
let warehouseSession = null;
let financeSession = null;
let salesBillNo = "";
let salesOrderId = "";
let presetBaseline = null;
let passwordResetBaseline = null;
let financeBaseline = null;
let inventoryBaseline = null;

try {
  const health = await request("", "/api/system/health");
  expectStatus("anonymous health", health, 200);
  assert(health.data?.testInventoryAdjustmentApi === true, `A134 requires the restricted BLD-TEST adjustment capability, got ${health.text}`);

  adminCookie = await loginApi(apiBase, "admin", "admin123", "BLD-TEST");
  warehouseCookie = await loginApi(apiBase, "warehouse", "warehouse123", "BLD-TEST");
  financeCookie = await loginApi(apiBase, "finance", "finance123", "BLD-TEST");
  const adminSessionResponse = await request(adminCookie, "/api/system/session");
  const warehouseSessionResponse = await request(warehouseCookie, "/api/system/session");
  const financeSessionResponse = await request(financeCookie, "/api/system/session");
  expectStatus("ADMIN session", adminSessionResponse, 200);
  expectStatus("WAREHOUSE session", warehouseSessionResponse, 200);
  expectStatus("FINANCE session", financeSessionResponse, 200);
  adminSession = adminSessionResponse.data;
  warehouseSession = warehouseSessionResponse.data;
  financeSession = financeSessionResponse.data;
  assert(adminSession?.user?.roleCode === "ADMIN", "ADMIN session should expose ADMIN role");
  assert(warehouseSession?.user?.roleCode === "WAREHOUSE", "WAREHOUSE session should expose WAREHOUSE role");
  assert(financeSession?.user?.roleCode === "FINANCE", "FINANCE session should expose FINANCE role");
  assert(adminSession?.tenant?.code === "BLD-TEST" && adminSession?.tenant?.schemaName === "public", "ADMIN must be in the BLD-TEST public schema");
  assert(warehouseSession?.tenant?.code === "BLD-TEST", "WAREHOUSE must be in BLD-TEST");
  assert(financeSession?.tenant?.code === "BLD-TEST", "FINANCE must be in BLD-TEST");
  const securityPermissions = ["sales.order.audit", "system.role_permission.manage", "system.account_set.manage", "finance.settle"];
  requirePermissions(adminSession, securityPermissions, [], "ADMIN");
  requirePermissions(warehouseSession, [], securityPermissions, "WAREHOUSE");
  requirePermissions(financeSession, ["finance.settle"], ["sales.order.audit", "system.role_permission.manage", "system.account_set.manage"], "FINANCE");
  pass("security actor preconditions", { admin: adminSession.user.username, warehouse: warehouseSession.user.username, finance: financeSession.user.username });

  const anonymousUsers = await request("", "/api/system/users");
  const warehouseUsers = await request(warehouseCookie, "/api/system/users");
  const financeUsers = await request(financeCookie, "/api/system/users");
  const adminUsers = await request(adminCookie, "/api/system/users");
  expectStatus("anonymous system users", anonymousUsers, 401);
  expectStatus("WAREHOUSE system users", warehouseUsers, 403);
  expectStatus("FINANCE system users", financeUsers, 403);
  expectStatus("ADMIN system users", adminUsers, 200);
  assert(Array.isArray(adminUsers.data?.users), "ADMIN system users should return a users array");
  assert(adminUsers.data.users.some((user) => user.username === "admin"), "ADMIN user list should contain admin");
  assert(adminUsers.data.users.some((user) => user.username === "warehouse"), "ADMIN user list should contain warehouse");
  assert(adminUsers.data.users.every((user) => !("password" in user) && !("passwordHash" in user)), "system users must not expose password fields");
  pass("system users 401/403/200");

  passwordResetBaseline = passwordResetFingerprint();
  addCleanup("password-reset fixtures", async () => {
    sqlScalar(`
      BEGIN;
      CREATE TEMP TABLE a134_reset_targets ON COMMIT DROP AS
      SELECT id
      FROM public.sys_password_reset_request
      WHERE contact_note IN (${sqlLiteral(existingResetContact)}, ${sqlLiteral(missingResetContact)});
      DELETE FROM public.sys_operation_log log_row
      USING a134_reset_targets target
      WHERE log_row.module_code = 'SYSTEM'
        AND log_row.action_code = 'PASSWORD_RESET_REQUEST'
        AND log_row.failure_reason = '申请编号 ' || target.id::text;
      DELETE FROM public.sys_password_reset_request request_row
      USING a134_reset_targets target
      WHERE request_row.id = target.id;
      COMMIT;
    `);
    assert(same(passwordResetFingerprint(), passwordResetBaseline), "password-reset cleanup must restore the exact request and request-log fingerprint");
  });
  const existingReset = await request("", "/api/system/password-reset-requests", {
    method: "POST",
    body: { username: "admin", contactNote: existingResetContact }
  });
  const missingReset = await request("", "/api/system/password-reset-requests", {
    method: "POST",
    body: { username: missingResetUsername, contactNote: missingResetContact }
  });
  expectStatus("password reset for existing account", existingReset, 200);
  expectStatus("password reset for missing account", missingReset, 200);
  assert(same(Object.keys(existingReset.data ?? {}).sort(), Object.keys(missingReset.data ?? {}).sort()), "existing and missing password-reset responses must have the same JSON structure");
  assert(existingReset.data?.message === missingReset.data?.message, "existing and missing password-reset responses must have indistinguishable copy");
  assert(same(existingReset.data, missingReset.data), "existing and missing password-reset response bodies must be completely indistinguishable");
  assert(!Object.prototype.hasOwnProperty.call(existingReset.data ?? {}, "matched") && !Object.prototype.hasOwnProperty.call(missingReset.data ?? {}, "matched"), "password-reset responses must not expose matched");
  const resetFixtureCounts = sqlJson(`
    SELECT jsonb_build_object(
      'requests', (
        SELECT count(*) FROM public.sys_password_reset_request
        WHERE contact_note IN (${sqlLiteral(existingResetContact)}, ${sqlLiteral(missingResetContact)})
      ),
      'logs', (
        SELECT count(*)
        FROM public.sys_operation_log log_row
        JOIN public.sys_password_reset_request request_row
          ON log_row.failure_reason = '申请编号 ' || request_row.id::text
        WHERE log_row.module_code = 'SYSTEM'
          AND log_row.action_code = 'PASSWORD_RESET_REQUEST'
          AND request_row.contact_note IN (${sqlLiteral(existingResetContact)}, ${sqlLiteral(missingResetContact)})
      )
    )::text
  `);
  assert(Number(resetFixtureCounts.requests) === 2 && Number(resetFixtureCounts.logs) === 2, `password-reset fixture should create exactly two requests and two exact logs: ${JSON.stringify(resetFixtureCounts)}`);
  pass("password-reset account existence is indistinguishable and exactly recoverable");

  addCleanup("sales-order fixture", async () => {
    sqlScalar(`
      BEGIN;
      CREATE TEMP TABLE a134_sales_targets ON COMMIT DROP AS
      SELECT id, bill_no FROM public.sales_order WHERE remark = ${sqlLiteral(salesRemark)};
      DELETE FROM public.doc_edit_lock lock_row USING a134_sales_targets target
      WHERE lock_row.document_type = 'salesOrder' AND lock_row.bill_no = target.bill_no;
      DELETE FROM public.sys_operation_log log_row USING a134_sales_targets target WHERE log_row.target_id = target.id;
      DELETE FROM public.sales_order_line line_row USING a134_sales_targets target WHERE line_row.order_id = target.id;
      DELETE FROM public.sales_order header_row USING a134_sales_targets target WHERE header_row.id = target.id;
      COMMIT;
    `);
    const residue = Number(sqlScalar(`SELECT count(*) FROM public.sales_order WHERE remark = ${sqlLiteral(salesRemark)}`));
    assert(residue === 0, `sales fixture cleanup should leave zero headers, got ${residue}`);
  });

  const salesPayload = {
    billNo: null,
    customerCode: "KH-001",
    billDate: "2026-07-12",
    department: "销售部",
    ownerName: fixtureKey,
    remark: salesRemark,
    lines: [{ productCode, warehouseCode, qty: 1, unitPrice: 1, lineRemark: salesRemark }]
  };
  assert(Number(sqlScalar(`SELECT count(*) FROM public.sales_order WHERE remark = ${sqlLiteral(salesRemark)}`)) === 0, "sales fixture should not pre-exist");
  const anonymousDraft = await request("", "/api/sales-orders/draft", { method: "POST", body: salesPayload });
  expectStatus("anonymous sales draft", anonymousDraft, 401);
  assert(Number(sqlScalar(`SELECT count(*) FROM public.sales_order WHERE remark = ${sqlLiteral(salesRemark)}`)) === 0, "anonymous draft must not persist a header");
  const warehouseDraft = await request(warehouseCookie, "/api/sales-orders/draft", { method: "POST", body: salesPayload });
  expectStatus("WAREHOUSE sales draft", warehouseDraft, 403);
  assert(Number(sqlScalar(`SELECT count(*) FROM public.sales_order WHERE remark = ${sqlLiteral(salesRemark)}`)) === 0, "WAREHOUSE draft must not persist a header");
  const financeDraft = await request(financeCookie, "/api/sales-orders/draft", { method: "POST", body: salesPayload });
  expectStatus("FINANCE sales draft", financeDraft, 403);
  assert(Number(sqlScalar(`SELECT count(*) FROM public.sales_order WHERE remark = ${sqlLiteral(salesRemark)}`)) === 0, "FINANCE draft must not persist a header");
  const adminDraft = await request(adminCookie, "/api/sales-orders/draft", { method: "POST", body: salesPayload });
  expectStatus("ADMIN sales draft", adminDraft, 201);
  salesBillNo = String(adminDraft.data?.billNo ?? "");
  assert(/^XSDD\d{6}$/.test(salesBillNo), `ADMIN sales draft should use automatic numbering, got ${adminDraft.text}`);
  const savedSales = sqlJson(`
    SELECT jsonb_build_object(
      'id', header_row.id::text,
      'status', header_row.status,
      'lineCount', (SELECT count(*) FROM public.sales_order_line WHERE order_id = header_row.id)
    )::text
    FROM public.sales_order header_row
    WHERE header_row.bill_no = ${sqlLiteral(salesBillNo)} AND header_row.remark = ${sqlLiteral(salesRemark)}
  `);
  assert(savedSales?.status === "DRAFT" && Number(savedSales.lineCount) === 1, `ADMIN sales draft DB state is invalid: ${JSON.stringify(savedSales)}`);
  salesOrderId = savedSales.id;
  pass("sales draft 401/403/201 with automatic numbering", { billNo: salesBillNo });

  const audited = await request(adminCookie, `/api/sales-orders/${encodeURIComponent(salesBillNo)}/audit`, { method: "POST" });
  expectStatus("ADMIN sales audit", audited, 200);
  assert(audited.data?.status === "AUDITED", `sales fixture should be audited: ${audited.text}`);
  const lifecycleBeforeDenied = salesOrderSnapshot(salesBillNo);
  const closeBody = { reason: `${fixtureKey} lifecycle permission` };
  const anonymousClose = await request("", `/api/document-lifecycle/salesOrder/${encodeURIComponent(salesBillNo)}/close`, { method: "POST", body: closeBody });
  expectStatus("anonymous sales-order close", anonymousClose, 401);
  assert(same(salesOrderSnapshot(salesBillNo), lifecycleBeforeDenied), "anonymous lifecycle denial must leave the complete business snapshot unchanged");
  const warehouseClose = await request(warehouseCookie, `/api/document-lifecycle/salesOrder/${encodeURIComponent(salesBillNo)}/close`, { method: "POST", body: closeBody });
  expectStatus("WAREHOUSE sales-order close", warehouseClose, 403);
  assert(same(salesOrderSnapshot(salesBillNo), lifecycleBeforeDenied), "WAREHOUSE lifecycle denial must leave the complete business snapshot unchanged");
  const versionBeforeClose = Number(lifecycleBeforeDenied.header.version);
  const closeLogCountBefore = lifecycleBeforeDenied.successLogs.filter((log) => log.action_code === "CLOSE").length;
  const uncloseLogCountBefore = lifecycleBeforeDenied.successLogs.filter((log) => log.action_code === "UNCLOSE").length;
  const adminClose = await request(adminCookie, `/api/document-lifecycle/salesOrder/${encodeURIComponent(salesBillNo)}/close`, { method: "POST", body: closeBody });
  expectStatus("ADMIN sales-order close", adminClose, 200);
  assert(adminClose.data?.closeStatus === "CLOSED" && adminClose.data?.closeMode === "MANUAL", `ADMIN close response is invalid: ${adminClose.text}`);
  const afterClose = salesOrderSnapshot(salesBillNo);
  assert(afterClose.header.close_status === "CLOSED" && afterClose.header.close_mode === "MANUAL", "ADMIN close must persist the manual closed state");
  assert(Number(afterClose.header.version) === versionBeforeClose + 1, "ADMIN close must increment version exactly once");
  assert(afterClose.successLogs.filter((log) => log.action_code === "CLOSE").length === closeLogCountBefore + 1, "ADMIN close must add exactly one successful CLOSE log");
  const adminUnclose = await request(adminCookie, `/api/document-lifecycle/salesOrder/${encodeURIComponent(salesBillNo)}/unclose`, { method: "POST" });
  expectStatus("ADMIN sales-order unclose", adminUnclose, 200);
  const afterUnclose = salesOrderSnapshot(salesBillNo);
  assert(afterUnclose.header.close_status === "OPEN" && afterUnclose.header.close_mode == null && afterUnclose.header.close_reason == null, "ADMIN unclose must restore OPEN and clear manual-close fields");
  assert(Number(afterUnclose.header.version) === versionBeforeClose + 2, "ADMIN unclose must increment version exactly once");
  assert(afterUnclose.successLogs.filter((log) => log.action_code === "UNCLOSE").length === uncloseLogCountBefore + 1, "ADMIN unclose must add exactly one successful UNCLOSE log");
  pass("lifecycle 401/403/admin close+unclose", { salesOrderId });

  assert(lockSnapshot(salesBillNo).length === 0, "sales fixture should start without a document lock");
  const anonymousLockStatus = await request("", `/api/document-locks/salesOrder/${encodeURIComponent(salesBillNo)}`);
  const warehouseLockStatus = await request(warehouseCookie, `/api/document-locks/salesOrder/${encodeURIComponent(salesBillNo)}`);
  const anonymousAcquire = await request("", `/api/document-locks/salesOrder/${encodeURIComponent(salesBillNo)}/acquire`, { method: "POST" });
  const warehouseAcquire = await request(warehouseCookie, `/api/document-locks/salesOrder/${encodeURIComponent(salesBillNo)}/acquire`, { method: "POST" });
  expectStatus("anonymous document-lock status", anonymousLockStatus, 401);
  expectStatus("WAREHOUSE document-lock status", warehouseLockStatus, 403);
  expectStatus("anonymous document-lock acquire", anonymousAcquire, 401);
  expectStatus("WAREHOUSE document-lock acquire", warehouseAcquire, 403);
  assert(lockSnapshot(salesBillNo).length === 0, "denied document-lock requests must not create a lock");
  const adminAcquire = await request(adminCookie, `/api/document-locks/salesOrder/${encodeURIComponent(salesBillNo)}/acquire`, { method: "POST" });
  expectStatus("ADMIN document-lock acquire", adminAcquire, 200);
  assert(adminAcquire.data?.readOnly === false, `ADMIN should acquire an editable lock: ${adminAcquire.text}`);
  const adminLock = lockSnapshot(salesBillNo);
  assert(adminLock.length === 1 && adminLock[0].holder_username === "admin", `ADMIN lock DB state is invalid: ${JSON.stringify(adminLock)}`);
  const warehouseRelease = await request(warehouseCookie, `/api/document-locks/salesOrder/${encodeURIComponent(salesBillNo)}`, { method: "DELETE" });
  expectStatus("WAREHOUSE release ADMIN lock", warehouseRelease, 200);
  assert(warehouseRelease.data?.released === false, "WAREHOUSE must not release another user's lock");
  assert(lockSnapshot(salesBillNo).length === 1 && lockSnapshot(salesBillNo)[0].holder_username === "admin", "WAREHOUSE release must leave the ADMIN lock unchanged");
  const adminRelease = await request(adminCookie, `/api/document-locks/salesOrder/${encodeURIComponent(salesBillNo)}`, { method: "DELETE" });
  expectStatus("ADMIN document-lock release", adminRelease, 200);
  assert(adminRelease.data?.released === true && lockSnapshot(salesBillNo).length === 0, "ADMIN should release its own lock exactly once");
  pass("document lock 401/403/owner-scoped release");

  presetBaseline = presetSnapshot();
  addCleanup("preset fixture", async () => {
    sqlScalar(`
      DELETE FROM public.sys_list_filter_preset
      WHERE list_key = ${sqlLiteral(presetListKey)}
        AND name IN (${sqlLiteral(personalPresetName)}, ${sqlLiteral(rolePresetName)}, ${sqlLiteral(generalPresetName)})
    `);
    assert(same(presetSnapshot(), presetBaseline), "preset cleanup must restore the exact complete baseline snapshot");
  });
  const basePresetBody = {
    query: { keyword: fixtureKey },
    columnFilters: {},
    shared: false,
    isDefault: false
  };
  const anonymousPreset = await request("", `/api/list-presets/${presetListKey}`, {
    method: "POST",
    body: { ...basePresetBody, name: personalPresetName, scope: "PERSONAL", roleCode: "ADMIN", userName: "本地管理员" }
  });
  expectStatus("anonymous personal preset", anonymousPreset, 401);
  assert(same(presetSnapshot(), presetBaseline), "anonymous preset denial must leave the complete preset snapshot unchanged");
  const warehousePersonal = await request(warehouseCookie, `/api/list-presets/${presetListKey}`, {
    method: "POST",
    body: { ...basePresetBody, name: personalPresetName, scope: "PERSONAL", roleCode: "ADMIN", userName: "本地管理员" }
  });
  expectStatus("WAREHOUSE forged personal preset", warehousePersonal, 200);
  assert(warehousePersonal.data?.roleCode === "WAREHOUSE", `personal preset must use current role: ${warehousePersonal.text}`);
  assert(warehousePersonal.data?.userName === warehouseSession.user.username, `personal preset must use the stable current username: ${warehousePersonal.text}`);
  const storedPersonal = sqlJson(`
    SELECT to_jsonb(row_value)::text
    FROM public.sys_list_filter_preset row_value
    WHERE row_value.id = ${sqlLiteral(warehousePersonal.data.id)}::uuid
  `);
  assert(storedPersonal?.role_code === "WAREHOUSE" && storedPersonal?.user_name === warehouseSession.user.username, `stored personal preset scope is invalid: ${JSON.stringify(storedPersonal)}`);
  const warehouseRole = await request(warehouseCookie, `/api/list-presets/${presetListKey}`, {
    method: "POST",
    body: { ...basePresetBody, name: rolePresetName, scope: "ROLE", roleCode: "ADMIN", userName: "本地管理员" }
  });
  const warehouseGeneral = await request(warehouseCookie, `/api/list-presets/${presetListKey}`, {
    method: "POST",
    body: { ...basePresetBody, name: generalPresetName, scope: "GENERAL", roleCode: "ADMIN", userName: "本地管理员" }
  });
  expectStatus("WAREHOUSE forged role preset", warehouseRole, 403);
  expectStatus("WAREHOUSE forged general preset", warehouseGeneral, 403);
  const forbiddenPresetCount = Number(sqlScalar(`
    SELECT count(*) FROM public.sys_list_filter_preset
    WHERE list_key = ${sqlLiteral(presetListKey)} AND name IN (${sqlLiteral(rolePresetName)}, ${sqlLiteral(generalPresetName)})
  `));
  assert(forbiddenPresetCount === 0, `forbidden role/general preset requests must persist zero rows, got ${forbiddenPresetCount}`);
  const deletePersonal = await request(warehouseCookie, `/api/list-presets/${presetListKey}/${encodeURIComponent(warehousePersonal.data.id)}`, { method: "DELETE" });
  expectStatus("WAREHOUSE delete own personal preset", deletePersonal, 200);
  assert(deletePersonal.data?.deleted === 1, "WAREHOUSE should delete exactly its own personal preset");
  assert(same(presetSnapshot(), presetBaseline), "personal preset create/delete must restore the exact baseline snapshot");
  pass("request-scoped preset authorization and exact restoration");

  financeBaseline = financeFingerprint();
  addCleanup("finance fixtures", async () => {
    sqlScalar(`
      BEGIN;
      DELETE FROM public.ar_receipt WHERE receivable_id IN (SELECT id FROM public.ar_receivable WHERE bill_no = ${sqlLiteral(receivableBillNo)});
      DELETE FROM public.ap_payment WHERE payable_id IN (SELECT id FROM public.ap_payable WHERE bill_no = ${sqlLiteral(payableBillNo)});
      DELETE FROM public.sys_operation_log
      WHERE target_id IN (
        SELECT id FROM public.ar_receivable WHERE bill_no = ${sqlLiteral(receivableBillNo)}
        UNION ALL
        SELECT id FROM public.ap_payable WHERE bill_no = ${sqlLiteral(payableBillNo)}
      );
      DELETE FROM public.ar_receivable WHERE bill_no = ${sqlLiteral(receivableBillNo)};
      DELETE FROM public.ap_payable WHERE bill_no = ${sqlLiteral(payableBillNo)};
      COMMIT;
    `);
    assert(same(financeFingerprint(), financeBaseline), "finance cleanup must restore the exact complete finance fingerprint");
  });
  const receivableId = sqlScalar(`
    INSERT INTO public.ar_receivable (bill_no, source_bill_no, customer_id, bill_date, amount, received_amount, status)
    SELECT ${sqlLiteral(receivableBillNo)}, ${sqlLiteral(fixtureKey)}, id, DATE '2026-07-12', 100, 0, 'OPEN'
    FROM public.md_customer WHERE code = 'KH-001'
    RETURNING id::text
  `);
  const payableId = sqlScalar(`
    INSERT INTO public.ap_payable (bill_no, source_bill_no, supplier_id, bill_date, amount, paid_amount, status)
    SELECT ${sqlLiteral(payableBillNo)}, ${sqlLiteral(fixtureKey)}, id, DATE '2026-07-12', 100, 0, 'OPEN'
    FROM public.md_supplier WHERE code = 'GYS-001'
    RETURNING id::text
  `);
  assert(receivableId && payableId, "finance fixture insertion should return both target IDs");
  const financeBeforeDenied = financeFixtureSnapshot();
  const settlementBody = { date: "2026-07-12", amount: 1 };
  const anonymousReceipt = await request("", `/api/finance/receivables/${encodeURIComponent(receivableBillNo)}/receipt`, { method: "POST", body: settlementBody });
  const anonymousPayment = await request("", `/api/finance/payables/${encodeURIComponent(payableBillNo)}/payment`, { method: "POST", body: settlementBody });
  expectStatus("anonymous receivable settlement", anonymousReceipt, 401);
  expectStatus("anonymous payable settlement", anonymousPayment, 401);
  assert(same(financeFixtureSnapshot(), financeBeforeDenied), "anonymous settlement denials must leave valid finance targets unchanged");
  const warehouseReceipt = await request(warehouseCookie, `/api/finance/receivables/${encodeURIComponent(receivableBillNo)}/receipt`, { method: "POST", body: settlementBody });
  const warehousePayment = await request(warehouseCookie, `/api/finance/payables/${encodeURIComponent(payableBillNo)}/payment`, { method: "POST", body: settlementBody });
  expectStatus("WAREHOUSE receivable settlement", warehouseReceipt, 403);
  expectStatus("WAREHOUSE payable settlement", warehousePayment, 403);
  assert(same(financeFixtureSnapshot(), financeBeforeDenied), "WAREHOUSE settlement denials must leave valid finance targets, settlements, and successful logs unchanged");
  const financeReceipt = await request(financeCookie, `/api/finance/receivables/${encodeURIComponent(receivableBillNo)}/receipt`, { method: "POST", body: settlementBody });
  const financePayment = await request(financeCookie, `/api/finance/payables/${encodeURIComponent(payableBillNo)}/payment`, { method: "POST", body: settlementBody });
  expectStatus("FINANCE receivable settlement", financeReceipt, 201);
  expectStatus("FINANCE payable settlement", financePayment, 201);
  assert(/^SKD\d{6}$/.test(String(financeReceipt.data?.receiptBillNo ?? "")), `FINANCE receipt must use automatic numbering: ${financeReceipt.text}`);
  assert(/^FKD\d{6}$/.test(String(financePayment.data?.paymentBillNo ?? "")), `FINANCE payment must use automatic numbering: ${financePayment.text}`);
  const financeAfterAllowed = financeFixtureSnapshot();
  assert(Number(financeAfterAllowed.receivable.received_amount) === 1 && financeAfterAllowed.receivable.status === "PART_SETTLED", "FINANCE receipt must settle exactly one unit on the real receivable");
  assert(Number(financeAfterAllowed.payable.paid_amount) === 1 && financeAfterAllowed.payable.status === "PART_SETTLED", "FINANCE payment must settle exactly one unit on the real payable");
  assert(financeAfterAllowed.receipts.length === 1 && Number(financeAfterAllowed.receipts[0].amount) === 1, "FINANCE receipt must create exactly one receipt fact");
  assert(financeAfterAllowed.payments.length === 1 && Number(financeAfterAllowed.payments[0].amount) === 1, "FINANCE payment must create exactly one payment fact");
  assert(financeAfterAllowed.successLogs.filter((log) => log.action_code === "RECEIVE").length === 1, "FINANCE receipt must create exactly one successful RECEIVE log");
  assert(financeAfterAllowed.successLogs.filter((log) => log.action_code === "PAY").length === 1, "FINANCE payment must create exactly one successful PAY log");
  pass("finance settlement 401/403 and FINANCE positive success with exact facts", {
    receivableId,
    payableId,
    receiptBillNo: financeReceipt.data.receiptBillNo,
    paymentBillNo: financePayment.data.paymentBillNo
  });

  inventoryBaseline = inventorySnapshot();
  assert(inventoryBaseline?.balance, `inventory baseline should contain ${productCode}/${warehouseCode}`);
  assert(inventoryBaseline.fixtureTxns.length === 0, "inventory fixture transaction keys must be unique before the run");
  addCleanup("inventory fixture", async () => {
    const current = inventorySnapshot();
    const before = inventoryBaseline.balance;
    assert(current?.balance, "inventory cleanup requires the current balance row");
    sqlScalar(`
      BEGIN;
      DO $a134_inventory_cleanup$
      DECLARE
        baseline_balance jsonb := ${jsonbSql(before)};
        expected_current_balance jsonb := ${jsonbSql(current.balance)};
        expected_current_txns jsonb := ${jsonbSql(current.fixtureTxns)};
        locked_balance jsonb;
        locked_txns jsonb;
        fixture_delta numeric;
        fixture_posting_count bigint;
        deleted_count bigint;
      BEGIN
        PERFORM 1
        FROM public.inv_stock_balance
        WHERE id = ${sqlLiteral(before.id)}::uuid
        FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'A134 inventory cleanup refused: balance row disappeared before lock';
        END IF;

        SELECT to_jsonb(balance)
        INTO locked_balance
        FROM public.inv_stock_balance balance
        WHERE balance.id = ${sqlLiteral(before.id)}::uuid;
        IF locked_balance IS DISTINCT FROM expected_current_balance THEN
          RAISE EXCEPTION 'A134 inventory cleanup refused: complete balance state changed before row lock';
        END IF;

        SELECT COALESCE(jsonb_agg(to_jsonb(candidate) ORDER BY candidate.occurred_at, candidate.id::text), '[]'::jsonb),
               COALESCE(sum(candidate.qty_delta), 0),
               count(*)
        INTO locked_txns, fixture_delta, fixture_posting_count
        FROM public.inv_stock_txn candidate
        JOIN public.sys_account_set account_set ON account_set.id = candidate.account_set_id
        JOIN public.md_product product ON product.id = candidate.product_id
        JOIN public.md_warehouse warehouse ON warehouse.id = candidate.warehouse_id
        WHERE account_set.code = 'BLD-TEST'
          AND product.code = ${sqlLiteral(productCode)}
          AND warehouse.code = ${sqlLiteral(warehouseCode)}
          AND (
            (candidate.txn_type = ${sqlLiteral(inventoryTxnType)} AND candidate.source_bill_type = ${sqlLiteral(inventorySourceType)})
            OR (candidate.txn_type = 'SALES_OUT' AND candidate.source_bill_type = ${sqlLiteral(inventorySourceType)})
            OR (candidate.txn_type = 'SALES_OUT' AND candidate.source_bill_type = ${sqlLiteral(`SALES_OUT:${legacySourceBillNo}`)})
            OR (candidate.txn_type = 'PURCHASE_IN' AND candidate.source_bill_type = ${sqlLiteral(`PURCHASE_IN:${legacySourceBillNo}`)})
          );
        IF locked_txns IS DISTINCT FROM expected_current_txns THEN
          RAISE EXCEPTION 'A134 inventory cleanup refused: fixture transaction set changed before row lock';
        END IF;

        IF locked_balance->'id' IS DISTINCT FROM baseline_balance->'id'
          OR locked_balance->'account_set_id' IS DISTINCT FROM baseline_balance->'account_set_id'
          OR locked_balance->'product_id' IS DISTINCT FROM baseline_balance->'product_id'
          OR locked_balance->'warehouse_id' IS DISTINCT FROM baseline_balance->'warehouse_id'
          OR locked_balance->'qty_reserved' IS DISTINCT FROM baseline_balance->'qty_reserved'
          OR locked_balance->'unit_cost' IS DISTINCT FROM baseline_balance->'unit_cost'
          OR locked_balance->'amount' IS DISTINCT FROM baseline_balance->'amount'
          OR locked_balance->'created_at' IS DISTINCT FROM baseline_balance->'created_at' THEN
          RAISE EXCEPTION 'A134 inventory cleanup refused: non-fixture balance fields changed';
        END IF;
        IF (locked_balance->>'qty_on_hand')::numeric IS DISTINCT FROM (baseline_balance->>'qty_on_hand')::numeric + fixture_delta
          OR (locked_balance->>'qty_available')::numeric IS DISTINCT FROM (baseline_balance->>'qty_available')::numeric + fixture_delta
          OR (locked_balance->>'version')::bigint IS DISTINCT FROM (baseline_balance->>'version')::bigint + fixture_posting_count THEN
          RAISE EXCEPTION 'A134 inventory cleanup refused: quantity/version delta does not equal the locked fixture transactions';
        END IF;
        IF fixture_posting_count = 0 AND locked_balance->'updated_at' IS DISTINCT FROM baseline_balance->'updated_at' THEN
          RAISE EXCEPTION 'A134 inventory cleanup refused: updated_at changed without a fixture posting';
        END IF;
        IF fixture_posting_count > 0
          AND (locked_balance->>'updated_at')::timestamptz <= (baseline_balance->>'updated_at')::timestamptz THEN
          RAISE EXCEPTION 'A134 inventory cleanup refused: fixture posting did not advance updated_at';
        END IF;

        DELETE FROM public.inv_stock_txn candidate
        USING public.sys_account_set account_set, public.md_product product, public.md_warehouse warehouse
        WHERE account_set.id = candidate.account_set_id
          AND product.id = candidate.product_id
          AND warehouse.id = candidate.warehouse_id
          AND account_set.code = 'BLD-TEST'
          AND product.code = ${sqlLiteral(productCode)}
          AND warehouse.code = ${sqlLiteral(warehouseCode)}
          AND (
            (candidate.txn_type = ${sqlLiteral(inventoryTxnType)} AND candidate.source_bill_type = ${sqlLiteral(inventorySourceType)})
            OR (candidate.txn_type = 'SALES_OUT' AND candidate.source_bill_type = ${sqlLiteral(inventorySourceType)})
            OR (candidate.txn_type = 'SALES_OUT' AND candidate.source_bill_type = ${sqlLiteral(`SALES_OUT:${legacySourceBillNo}`)})
            OR (candidate.txn_type = 'PURCHASE_IN' AND candidate.source_bill_type = ${sqlLiteral(`PURCHASE_IN:${legacySourceBillNo}`)})
          );
        GET DIAGNOSTICS deleted_count = ROW_COUNT;
        IF deleted_count IS DISTINCT FROM fixture_posting_count THEN
          RAISE EXCEPTION 'A134 inventory cleanup refused: deleted fixture transaction count mismatch';
        END IF;

        UPDATE public.inv_stock_balance
        SET qty_on_hand = ${nullableSql(before.qty_on_hand)},
            qty_available = ${nullableSql(before.qty_available)},
            qty_reserved = ${nullableSql(before.qty_reserved)},
            unit_cost = ${nullableSql(before.unit_cost)},
            amount = ${nullableSql(before.amount)},
            created_at = ${nullableSql(before.created_at, "timestamptz")},
            updated_at = ${nullableSql(before.updated_at, "timestamptz")},
            version = ${nullableSql(before.version, "bigint")}
        WHERE id = ${sqlLiteral(before.id)}::uuid;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'A134 inventory cleanup refused: locked balance restore updated zero rows';
        END IF;
      END;
      $a134_inventory_cleanup$;
      COMMIT;
    `);
    assert(same(inventorySnapshot(), inventoryBaseline), "inventory cleanup must restore the exact balance and fixture transaction baseline");
  });
  const adjustmentBody = { productCode, warehouseCode, qtyDelta: 1, txnType: inventoryTxnType, sourceBillType: inventorySourceType };
  const anonymousAdjustment = await request("", "/api/inventory/adjustments", { method: "POST", body: adjustmentBody });
  expectStatus("anonymous inventory adjustment", anonymousAdjustment, 401);
  assert(same(inventorySnapshot(), inventoryBaseline), "anonymous inventory adjustment denial must leave stock unchanged");
  const warehouseAdjustment = await request(warehouseCookie, "/api/inventory/adjustments", { method: "POST", body: adjustmentBody });
  expectStatus("WAREHOUSE inventory adjustment", warehouseAdjustment, 403);
  assert(same(inventorySnapshot(), inventoryBaseline), "WAREHOUSE inventory adjustment denial must leave stock unchanged");
  const financeAdjustment = await request(financeCookie, "/api/inventory/adjustments", { method: "POST", body: adjustmentBody });
  expectStatus("FINANCE inventory adjustment", financeAdjustment, 403);
  assert(same(inventorySnapshot(), inventoryBaseline), "FINANCE inventory adjustment denial must leave stock unchanged");
  const spoofedAdjustment = await request(adminCookie, "/api/inventory/adjustments", {
    method: "POST",
    body: { productCode, warehouseCode, qtyDelta: 1, txnType: "SALES_OUT", sourceBillType: inventorySourceType }
  });
  expectStatus("ADMIN formal-source inventory adjustment spoof", spoofedAdjustment, 400);
  assert(same(inventorySnapshot(), inventoryBaseline), "formal-source spoof rejection must leave stock unchanged");
  const adminAdjustment = await request(adminCookie, "/api/inventory/adjustments", { method: "POST", body: adjustmentBody });
  expectStatus("ADMIN restricted inventory adjustment", adminAdjustment, 201);
  const inventoryAfterAdjustment = inventorySnapshot();
  assert(Number(inventoryAfterAdjustment.balance.qty_on_hand) === Number(inventoryBaseline.balance.qty_on_hand) + 1, "valid test adjustment must increase on-hand by exactly one");
  assert(Number(inventoryAfterAdjustment.balance.qty_available) === Number(inventoryBaseline.balance.qty_available) + 1, "valid test adjustment must increase available by exactly one");
  assert(Number(inventoryAfterAdjustment.balance.qty_reserved) === Number(inventoryBaseline.balance.qty_reserved), "valid test adjustment must not change reserved quantity");
  assert(Number(inventoryAfterAdjustment.balance.version) === Number(inventoryBaseline.balance.version) + 1, "valid test adjustment must increment version exactly once");
  assert(inventoryAfterAdjustment.fixtureTxns.length === 1, `valid test adjustment must write exactly one transaction: ${JSON.stringify(inventoryAfterAdjustment.fixtureTxns)}`);
  const adjustmentTxn = inventoryAfterAdjustment.fixtureTxns[0];
  assert(adjustmentTxn.txn_type === inventoryTxnType && adjustmentTxn.source_bill_type === inventorySourceType && Number(adjustmentTxn.qty_delta) === 1, "valid test adjustment transaction identity is invalid");
  const retiredSalesOut = await request(adminCookie, "/api/inventory/sales-out", {
    method: "POST",
    body: { productCode, warehouseCode, qty: 1, sourceBillNo: legacySourceBillNo }
  });
  const retiredPurchaseIn = await request(adminCookie, "/api/inventory/purchase-in", {
    method: "POST",
    body: { productCode, warehouseCode, qty: 1, sourceBillNo: legacySourceBillNo }
  });
  expectStatus("retired inventory sales-out route", retiredSalesOut, 404);
  expectStatus("retired inventory purchase-in route", retiredPurchaseIn, 404);
  assert(same(inventorySnapshot(), inventoryAfterAdjustment), "retired inventory routes must leave the valid adjustment state unchanged");
  pass("inventory 401/403/400/201 and retired route 404 boundaries");
} catch (error) {
  primaryError = error;
}

const cleanupErrors = [];
for (const cleanup of [...cleanupTasks].reverse()) {
  try {
    await cleanup.task();
    result.cleanup[cleanup.name] = { ok: true };
  } catch (error) {
    cleanupErrors.push(error);
    result.cleanup[cleanup.name] = { ok: false, error: errorText(error) };
  }
}

result.ok = primaryError == null && cleanupErrors.length === 0;
if (primaryError) {
  result.primaryError = errorText(primaryError);
}
result.cleanupErrors = cleanupErrors.map(errorText);
result.completedAt = new Date().toISOString();
await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));

if (!result.ok) {
  throw new AggregateError(
    [primaryError, ...cleanupErrors].filter(Boolean),
    "A134 security boundary regression failed"
  );
}
