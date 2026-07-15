import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { saveDocument, auditDocument } from "./helpers/document-actions.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a86-other-stock-in-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
const runToken = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`.toUpperCase();
const fixtureKey = `A86-${runToken}`;
const warehouseCode = `A86-${runToken}`;
const warehouseName = `A86 其他入库回归仓 ${runToken}`;
const runUsername = `a86_${runToken.toLowerCase().replaceAll(/[^a-z0-9]+/g, "_")}_admin`;
const runPassword = `A86-${runToken}-Admin1!`;
const runDisplayName = `A86 ${runToken} admin`;
const billDate = "2026-06-25";
const productCode = "CP-001";
const qty = 7;
const unitPrice = 1;

let accountSetId = "";
let runUserId = "";
let identityWriteAttempted = false;
let session = null;
let productId = "";
let warehouseId = "";
let billNo = "";
let headerId = "";
let lineId = "";
let auditTxnId = "";
let reverseTxnId = "";
let primaryError = null;
let cleanupError = null;
let screenshots = [];
let beforeState = null;
let afterAuditState = null;
let afterReverseState = null;
let detailAfterAudit = null;
let detailAfterReverse = null;
let auditCandidates = [];
let reverseCandidates = [];
let cleanup = { attempted: false, passed: false, residue: null };
let identityCleanup = { attempted: false, passed: false, residue: null };

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertUuid(value, label) {
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? "")), `${label} should be a UUID, got ${JSON.stringify(value)}`);
}

function sqlLiteral(value) {
  if (value == null) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function dbScalar(sql) {
  return execFileSync("docker", [
    "exec", "jdy-erp-postgres", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-qAt",
    "-U", "jdy", "-d", "jdy_erp", "-c", sql
  ], { encoding: "utf8" }).trim();
}

function dbExecute(sql) {
  execFileSync("docker", [
    "exec", "jdy-erp-postgres", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-q",
    "-U", "jdy", "-d", "jdy_erp", "-c", sql
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function dbJson(sql) {
  const raw = dbScalar(sql);
  assert(raw, `SQL JSON query returned no row: ${sql}`);
  return JSON.parse(raw);
}

function uuidArray(values) {
  return values.length === 0
    ? "ARRAY[]::uuid[]"
    : `ARRAY[${values.map(sqlLiteral).join(", ")}]::uuid[]`;
}

function textArray(values) {
  return values.length === 0
    ? "ARRAY[]::text[]"
    : `ARRAY[${values.map(sqlLiteral).join(", ")}]::text[]`;
}

function lockKeyPredicate(alias, locks) {
  if (locks.length === 0) return "FALSE";
  return locks.map((lockRow) => `(${alias}.document_type = ${sqlLiteral(lockRow.document_type)} AND ${alias}.bill_no = ${sqlLiteral(lockRow.bill_no)})`).join(" OR ");
}

function createRunIdentity() {
  const existing = Number(dbScalar(`SELECT count(*) FROM public.sys_user WHERE username = ${sqlLiteral(runUsername)}`));
  assert(existing === 0, `A86 run user must be unique, found ${existing} rows for ${runUsername}`);
  runUserId = dbScalar(`
    BEGIN;
    DO $a86_identity_guard$
    BEGIN
      IF (SELECT count(*) FROM public.sys_role WHERE code = 'ADMIN' AND enabled = TRUE) <> 1 THEN
        RAISE EXCEPTION 'A86 requires exactly one enabled ADMIN role';
      END IF;
      IF (SELECT count(*) FROM public.sys_account_set WHERE code = 'BLD-TEST' AND schema_name = 'public' AND enabled = TRUE) <> 1 THEN
        RAISE EXCEPTION 'A86 requires exactly one enabled BLD-TEST/public account set';
      END IF;
    END;
    $a86_identity_guard$;
    INSERT INTO public.sys_user (username, display_name, password_hash, enabled, default_account_set_id)
    SELECT ${sqlLiteral(runUsername)}, ${sqlLiteral(runDisplayName)}, ${sqlLiteral(`{noop}${runPassword}`)}, TRUE, account_set.id
    FROM public.sys_account_set account_set
    WHERE account_set.code = 'BLD-TEST' AND account_set.schema_name = 'public' AND account_set.enabled = TRUE;
    INSERT INTO public.sys_user_role (user_id, role_id)
    SELECT app_user.id, role_row.id
    FROM public.sys_user app_user, public.sys_role role_row
    WHERE app_user.username = ${sqlLiteral(runUsername)} AND role_row.code = 'ADMIN' AND role_row.enabled = TRUE;
    INSERT INTO public.sys_user_account_set (user_id, account_set_id, role_code, is_default, enabled)
    SELECT app_user.id, account_set.id, 'ADMIN', TRUE, TRUE
    FROM public.sys_user app_user, public.sys_account_set account_set
    WHERE app_user.username = ${sqlLiteral(runUsername)}
      AND account_set.code = 'BLD-TEST' AND account_set.schema_name = 'public' AND account_set.enabled = TRUE;
    COMMIT;
    SELECT id::text FROM public.sys_user WHERE username = ${sqlLiteral(runUsername)};
  `);
  assertUuid(runUserId, "A86 run user id");
  const identity = dbJson(`
    SELECT jsonb_build_object(
      'users', (SELECT count(*) FROM public.sys_user WHERE id = ${sqlLiteral(runUserId)}::uuid AND username = ${sqlLiteral(runUsername)}),
      'roles', (SELECT count(*) FROM public.sys_user_role link JOIN public.sys_role role_row ON role_row.id = link.role_id WHERE link.user_id = ${sqlLiteral(runUserId)}::uuid AND role_row.code = 'ADMIN' AND role_row.enabled = TRUE),
      'grants', (SELECT count(*) FROM public.sys_user_account_set grant_row JOIN public.sys_account_set account_set ON account_set.id = grant_row.account_set_id WHERE grant_row.user_id = ${sqlLiteral(runUserId)}::uuid AND grant_row.role_code = 'ADMIN' AND grant_row.is_default = TRUE AND grant_row.enabled = TRUE AND account_set.code = 'BLD-TEST' AND account_set.schema_name = 'public'),
      'otherGrants', (SELECT count(*) FROM public.sys_user_account_set grant_row JOIN public.sys_account_set account_set ON account_set.id = grant_row.account_set_id WHERE grant_row.user_id = ${sqlLiteral(runUserId)}::uuid AND account_set.code <> 'BLD-TEST')
    )::text
  `);
  assert(Number(identity.users) === 1 && Number(identity.roles) === 1 && Number(identity.grants) === 1 && Number(identity.otherGrants) === 0,
    `A86 run identity must have only one BLD-TEST ADMIN grant, got ${JSON.stringify(identity)}`);
}

function cleanupRunIdentity() {
  identityCleanup.attempted = true;
  const userPredicate = runUserId
    ? `app_user.id = ${sqlLiteral(runUserId)}::uuid OR app_user.username = ${sqlLiteral(runUsername)}`
    : `app_user.username = ${sqlLiteral(runUsername)}`;
  const expectedAccountSetId = dbScalar(`SELECT id::text FROM public.sys_account_set WHERE code = 'BLD-TEST' AND schema_name = 'public' AND enabled = TRUE`);
  assertUuid(expectedAccountSetId, "A86 identity cleanup BLD-TEST account set id");

  const users = dbJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(app_user) ORDER BY app_user.id), '[]'::jsonb)::text
    FROM public.sys_user app_user
    WHERE ${userPredicate}
  `);
  assert(runUserId ? users.length === 1 : users.length <= 1,
    `A86 identity cleanup refused missing or ambiguous known-id-or-username match ${JSON.stringify({ runUserId, users })}`);
  for (const user of users) {
    assertUuid(user.id, "A86 identity cleanup user id");
    assert((!runUserId || String(user.id) === runUserId)
      && user.username === runUsername
      && user.display_name === runDisplayName
      && user.password_hash === `{noop}${runPassword}`
      && user.enabled === true
      && String(user.default_account_set_id) === expectedAccountSetId,
    `A86 identity cleanup refused changed user fields ${JSON.stringify(user)}`);
  }
  const knownUserIds = [...new Set([runUserId, ...users.map((row) => String(row.id))].filter(Boolean))].sort();
  const userIds = uuidArray(knownUserIds);
  const identityUserId = runUserId || String(users[0]?.id ?? "");

  const roleLinks = dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'link', to_jsonb(link),
      'role', to_jsonb(role_row)
    ) ORDER BY link.user_id, link.role_id), '[]'::jsonb)::text
    FROM public.sys_user_role link
    JOIN public.sys_role role_row ON role_row.id = link.role_id
    WHERE link.user_id = ANY(${userIds})
  `);
  const grants = dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'grant', to_jsonb(grant_row),
      'accountSet', to_jsonb(account_set)
    ) ORDER BY grant_row.id), '[]'::jsonb)::text
    FROM public.sys_user_account_set grant_row
    JOIN public.sys_account_set account_set ON account_set.id = grant_row.account_set_id
    WHERE grant_row.user_id = ANY(${userIds})
  `);
  const sessionScopes = dbJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(scope_row) ORDER BY scope_row.session_token), '[]'::jsonb)::text
    FROM public.sys_session_account_scope scope_row
    WHERE scope_row.user_id = ANY(${userIds})
  `);
  if (users.length === 0) {
    assert(roleLinks.length === 0 && grants.length === 0 && sessionScopes.length === 0,
      `A86 identity cleanup refused orphan identity links ${JSON.stringify({ roleLinks, grants, sessionScopes })}`);
  } else {
    assert(roleLinks.length === 1
      && String(roleLinks[0].link?.user_id) === identityUserId
      && String(roleLinks[0].link?.role_id) === String(roleLinks[0].role?.id)
      && roleLinks[0].role?.code === "ADMIN" && roleLinks[0].role?.enabled === true,
    `A86 identity cleanup refused changed role-link semantics ${JSON.stringify(roleLinks)}`);
    assert(grants.length === 1
      && String(grants[0].grant?.user_id) === identityUserId
      && String(grants[0].grant?.account_set_id) === expectedAccountSetId
      && grants[0].grant?.role_code === "ADMIN"
      && grants[0].grant?.is_default === true && grants[0].grant?.enabled === true
      && String(grants[0].accountSet?.id) === expectedAccountSetId
      && grants[0].accountSet?.code === "BLD-TEST"
      && grants[0].accountSet?.schema_name === "public" && grants[0].accountSet?.enabled === true,
    `A86 identity cleanup refused changed account-set grant semantics ${JSON.stringify(grants)}`);
  }
  for (const scopeRow of sessionScopes) {
    assertUuid(scopeRow.session_token, "A86 identity cleanup session token");
    assertUuid(scopeRow.scope_token, "A86 identity cleanup scope token");
    assert(String(scopeRow.user_id) === identityUserId
      && String(scopeRow.account_set_id) === expectedAccountSetId,
    `A86 identity cleanup refused changed or cross-account session scope ${JSON.stringify(scopeRow)}`);
  }
  const sessionTokens = sessionScopes.map((row) => String(row.session_token)).sort();

  const identityLogs = dbJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(log_row) ORDER BY log_row.id), '[]'::jsonb)::text
    FROM public.sys_operation_log log_row
    WHERE log_row.operated_by = ANY(${userIds})
       OR log_row.actor_username = ${sqlLiteral(runUsername)}
       OR log_row.target_id = ANY(${userIds})
       OR log_row.target_no = ${sqlLiteral(runUsername)}
  `);
  for (const logRow of identityLogs) {
    assertUuid(logRow.id, "A86 identity cleanup log id");
    assert(String(logRow.operated_by ?? "") === identityUserId && logRow.actor_username === runUsername,
      `A86 identity cleanup refused external actor log targeting run identity ${JSON.stringify(logRow)}`);
  }
  const identityLogIds = identityLogs.map((row) => String(row.id)).sort();

  const identityLocks = dbJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(lock_row) ORDER BY lock_row.document_type, lock_row.bill_no), '[]'::jsonb)::text
    FROM public.doc_edit_lock lock_row
    WHERE lock_row.holder_user_id = ANY(${userIds})
       OR lock_row.holder_username = ${sqlLiteral(runUsername)}
  `);
  for (const lockRow of identityLocks) {
    assert(String(lockRow.holder_user_id ?? "") === identityUserId && lockRow.holder_username === runUsername,
      `A86 identity cleanup refused external or changed lock holder ${JSON.stringify(lockRow)}`);
  }

  const snapshots = { users, roleLinks, grants, sessionScopes, logs: identityLogs, locks: identityLocks };
  identityCleanup.targets = { userIds: knownUserIds, sessionTokens, logIds: identityLogIds, snapshots };
  dbExecute(`
    BEGIN;
    SET LOCAL lock_timeout = '5s';
    SET LOCAL statement_timeout = '30s';
    LOCK TABLE public.sys_user,
               public.sys_role,
               public.sys_user_role,
               public.sys_account_set,
               public.sys_user_account_set,
               public.sys_session_account_scope,
               public.sys_operation_log,
               public.doc_edit_lock
      IN SHARE ROW EXCLUSIVE MODE;
    DO $a86_identity_cleanup_guard$
    DECLARE
      actual jsonb;
    BEGIN
      SELECT COALESCE(jsonb_agg(to_jsonb(app_user) ORDER BY app_user.id), '[]'::jsonb)
      INTO actual FROM public.sys_user app_user WHERE ${userPredicate};
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(users))}::jsonb THEN
        RAISE EXCEPTION 'A86 identity cleanup refused: user snapshot changed after discovery';
      END IF;

      SELECT COALESCE(jsonb_agg(jsonb_build_object('link', to_jsonb(link), 'role', to_jsonb(role_row)) ORDER BY link.user_id, link.role_id), '[]'::jsonb)
      INTO actual
      FROM public.sys_user_role link
      JOIN public.sys_role role_row ON role_row.id = link.role_id
      WHERE link.user_id = ANY(${userIds});
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(roleLinks))}::jsonb THEN
        RAISE EXCEPTION 'A86 identity cleanup refused: role-link snapshot changed after discovery';
      END IF;

      SELECT COALESCE(jsonb_agg(jsonb_build_object('grant', to_jsonb(grant_row), 'accountSet', to_jsonb(account_set)) ORDER BY grant_row.id), '[]'::jsonb)
      INTO actual
      FROM public.sys_user_account_set grant_row
      JOIN public.sys_account_set account_set ON account_set.id = grant_row.account_set_id
      WHERE grant_row.user_id = ANY(${userIds});
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(grants))}::jsonb THEN
        RAISE EXCEPTION 'A86 identity cleanup refused: account-set grant snapshot changed after discovery';
      END IF;

      SELECT COALESCE(jsonb_agg(to_jsonb(scope_row) ORDER BY scope_row.session_token), '[]'::jsonb)
      INTO actual
      FROM public.sys_session_account_scope scope_row
      WHERE scope_row.user_id = ANY(${userIds});
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(sessionScopes))}::jsonb THEN
        RAISE EXCEPTION 'A86 identity cleanup refused: session-scope snapshot changed after discovery';
      END IF;

      SELECT COALESCE(jsonb_agg(to_jsonb(log_row) ORDER BY log_row.id), '[]'::jsonb)
      INTO actual
      FROM public.sys_operation_log log_row
      WHERE log_row.operated_by = ANY(${userIds})
         OR log_row.actor_username = ${sqlLiteral(runUsername)}
         OR log_row.target_id = ANY(${userIds})
         OR log_row.target_no = ${sqlLiteral(runUsername)};
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(identityLogs))}::jsonb THEN
        RAISE EXCEPTION 'A86 identity cleanup refused: identity-log snapshot changed after discovery';
      END IF;

      SELECT COALESCE(jsonb_agg(to_jsonb(lock_row) ORDER BY lock_row.document_type, lock_row.bill_no), '[]'::jsonb)
      INTO actual
      FROM public.doc_edit_lock lock_row
      WHERE lock_row.holder_user_id = ANY(${userIds})
         OR lock_row.holder_username = ${sqlLiteral(runUsername)};
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(identityLocks))}::jsonb THEN
        RAISE EXCEPTION 'A86 identity cleanup refused: identity-lock snapshot changed after discovery';
      END IF;
    END;
    $a86_identity_cleanup_guard$;
    DELETE FROM public.doc_edit_lock lock_row WHERE ${lockKeyPredicate("lock_row", identityLocks)};
    DELETE FROM public.sys_operation_log WHERE id = ANY(${uuidArray(identityLogIds)});
    DELETE FROM public.sys_session_account_scope
    WHERE session_token = ANY(${uuidArray(sessionTokens)})
      AND user_id = ANY(${userIds});
    DELETE FROM public.sys_user_account_set WHERE user_id = ANY(${userIds});
    DELETE FROM public.sys_user_role WHERE user_id = ANY(${userIds});
    DELETE FROM public.sys_user WHERE id = ANY(${userIds}) AND username = ${sqlLiteral(runUsername)};
    DO $a86_identity_cleanup_closure$
    BEGIN
      IF EXISTS (SELECT 1 FROM public.sys_user WHERE id = ANY(${userIds}) OR username = ${sqlLiteral(runUsername)})
         OR EXISTS (SELECT 1 FROM public.sys_user_role WHERE user_id = ANY(${userIds}))
         OR EXISTS (SELECT 1 FROM public.sys_user_account_set WHERE user_id = ANY(${userIds}))
         OR EXISTS (SELECT 1 FROM public.sys_session_account_scope WHERE user_id = ANY(${userIds}) OR session_token = ANY(${uuidArray(sessionTokens)}))
         OR EXISTS (SELECT 1 FROM public.sys_operation_log WHERE operated_by = ANY(${userIds}) OR actor_username = ${sqlLiteral(runUsername)} OR target_id = ANY(${userIds}) OR target_no = ${sqlLiteral(runUsername)})
         OR EXISTS (SELECT 1 FROM public.doc_edit_lock WHERE holder_user_id = ANY(${userIds}) OR holder_username = ${sqlLiteral(runUsername)}) THEN
        RAISE EXCEPTION 'A86 identity cleanup closure is not zero';
      END IF;
    END;
    $a86_identity_cleanup_closure$;
    COMMIT;
  `);

  identityCleanup.residue = dbJson(`
    SELECT jsonb_build_object(
      'users', (SELECT count(*) FROM public.sys_user WHERE id = ANY(${userIds}) OR username = ${sqlLiteral(runUsername)}),
      'roles', (SELECT count(*) FROM public.sys_user_role WHERE user_id = ANY(${userIds})),
      'grants', (SELECT count(*) FROM public.sys_user_account_set WHERE user_id = ANY(${userIds})),
      'sessionScopes', (SELECT count(*) FROM public.sys_session_account_scope WHERE user_id = ANY(${userIds}) OR session_token = ANY(${uuidArray(sessionTokens)})),
      'logs', (SELECT count(*) FROM public.sys_operation_log WHERE operated_by = ANY(${userIds}) OR actor_username = ${sqlLiteral(runUsername)} OR target_id = ANY(${userIds}) OR target_no = ${sqlLiteral(runUsername)}),
      'locks', (SELECT count(*) FROM public.doc_edit_lock WHERE holder_user_id = ANY(${userIds}) OR holder_username = ${sqlLiteral(runUsername)})
    )::text
  `);
  assert(Object.values(identityCleanup.residue).every((value) => Number(value) === 0),
    `A86 identity cleanup residue must be zero, got ${JSON.stringify(identityCleanup.residue)}`);
  identityCleanup.passed = true;
}

async function request(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "GET",
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
  if (!response.ok && !options.expectFailure) {
    throw new Error(`${options.method ?? "GET"} ${pathname} failed ${response.status}: ${text}`);
  }
  return { status: response.status, body, text };
}

function stockState() {
  return dbJson(`
    SELECT jsonb_build_object(
      'rows', count(*),
      'onHand', COALESCE(sum(balance.qty_on_hand), 0)::text,
      'available', COALESCE(sum(balance.qty_available), 0)::text,
      'reserved', COALESCE(sum(balance.qty_reserved), 0)::text
    )::text
    FROM public.inv_stock_balance balance
    WHERE balance.account_set_id = ${sqlLiteral(accountSetId)}::uuid
      AND balance.product_id = ${sqlLiteral(productId)}::uuid
      AND balance.warehouse_id = ${sqlLiteral(warehouseId)}::uuid
  `);
}

function documentIdentity(targetBillNo) {
  return dbJson(`
    SELECT jsonb_build_object(
      'headerId', header.id::text,
      'lineId', line.id::text,
      'billNo', header.bill_no,
      'billDate', header.bill_date::text,
      'status', header.status,
      'productId', line.product_id::text,
      'warehouseId', line.warehouse_id::text,
      'lineNo', line.line_no,
      'qty', line.qty::text
    )::text
    FROM public.other_stock_in header
    JOIN public.other_stock_in_line line ON line.bill_id = header.id
    WHERE header.bill_no = ${sqlLiteral(targetBillNo)}
      AND header.department = ${sqlLiteral(fixtureKey)}
      AND line.warehouse_id = ${sqlLiteral(warehouseId)}::uuid
    ORDER BY line.line_no
    LIMIT 1
  `);
}

function txnCandidates(sourceBillId) {
  return dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', txn.id::text,
      'txnType', txn.txn_type,
      'accountSetId', txn.account_set_id::text,
      'productId', txn.product_id::text,
      'warehouseId', txn.warehouse_id::text,
      'qtyDelta', txn.qty_delta::text,
      'sourceBillType', txn.source_bill_type,
      'sourceBillNo', txn.source_bill_no,
      'sourceBillId', txn.source_bill_id::text,
      'sourceBillLineId', txn.source_bill_line_id::text,
      'sourceBillDate', txn.source_bill_date::text,
      'postingAction', txn.posting_action,
      'qtyOnHandAfter', txn.qty_on_hand_after::text,
      'traceQuality', txn.trace_quality,
      'reversalOfTxnId', txn.reversal_of_txn_id::text
    ) ORDER BY txn.occurred_at, txn.id), '[]'::jsonb)::text
    FROM public.inv_stock_txn txn
    WHERE txn.account_set_id = ${sqlLiteral(accountSetId)}::uuid
      AND txn.warehouse_id = ${sqlLiteral(warehouseId)}::uuid
      AND txn.source_bill_id = ${sqlLiteral(sourceBillId)}::uuid
  `);
}

function assertFormalTxn(txn, expected) {
  assertUuid(txn?.id, `${expected.postingAction} txn id`);
  assert(txn.accountSetId === accountSetId, `${expected.postingAction} txn account set should be ${accountSetId}, got ${txn.accountSetId}`);
  assert(txn.productId === productId, `${expected.postingAction} txn product should be ${productId}, got ${txn.productId}`);
  assert(txn.warehouseId === warehouseId, `${expected.postingAction} txn warehouse should be ${warehouseId}, got ${txn.warehouseId}`);
  assert(txn.txnType === expected.txnType, `${expected.postingAction} txn type should be ${expected.txnType}, got ${txn.txnType}`);
  assert(Number(txn.qtyDelta) === expected.qtyDelta, `${expected.postingAction} qty delta should be ${expected.qtyDelta}, got ${txn.qtyDelta}`);
  assert(txn.sourceBillType === "OTHER_STOCK_IN", `${expected.postingAction} source bill type must remain canonical OTHER_STOCK_IN, got ${txn.sourceBillType}`);
  assert(txn.sourceBillNo === billNo, `${expected.postingAction} source bill no should be ${billNo}, got ${txn.sourceBillNo}`);
  assert(txn.sourceBillId === headerId, `${expected.postingAction} source header id should be ${headerId}, got ${txn.sourceBillId}`);
  assert(txn.sourceBillLineId === lineId, `${expected.postingAction} source line id should be ${lineId}, got ${txn.sourceBillLineId}`);
  assert(txn.sourceBillDate === billDate, `${expected.postingAction} source bill date should be ${billDate}, got ${txn.sourceBillDate}`);
  assert(txn.postingAction === expected.postingAction, `posting action should be ${expected.postingAction}, got ${txn.postingAction}`);
  assert(txn.traceQuality === "EXACT", `${expected.postingAction} trace quality should be EXACT, got ${txn.traceQuality}`);
  assert((txn.reversalOfTxnId ?? null) === expected.reversalOfTxnId, `${expected.postingAction} reversal link should be ${JSON.stringify(expected.reversalOfTxnId)}, got ${JSON.stringify(txn.reversalOfTxnId)}`);
  assert(Number(txn.qtyOnHandAfter) === expected.qtyOnHandAfter, `${expected.postingAction} qtyOnHandAfter should be ${expected.qtyOnHandAfter}, got ${txn.qtyOnHandAfter}`);
}

async function createAndAuditInFrontend() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const captured = [];
  try {
    await page.goto(frontendUrl, { waitUntil: "networkidle" });
    await loginAsAdmin(page, runPassword, "BLD-TEST", runUsername);
    await page.getByTestId("module-库存管理").hover();
    await page.getByTestId("entry-other-in-form").click();
    await page.getByTestId("tab-other-in-form").waitFor({ state: "visible" });
    const billNoInput = page.getByTestId("other-stock-in-bill-no");
    assert(await billNoInput.inputValue() === "", "new other stock in bill no should be blank");
    assert(!(await billNoInput.isEditable()), "new other stock in bill no should be readonly");
    await page.getByTestId("other-stock-in-bill-date").fill(billDate);
    await page.getByTestId("other-stock-in-department").fill(fixtureKey);
    await page.getByTestId("other-stock-in-line-product").fill(productCode);
    await page.getByTestId("other-stock-in-line-warehouse").fill(warehouseCode);
    await page.locator(".master-selector__menu button").filter({ hasText: warehouseCode }).first().click();
    await page.getByTestId("other-stock-in-line-qty").fill(String(qty));
    await page.getByTestId("other-stock-in-line-price").fill(String(unitPrice));
    await page.getByTestId("other-stock-in-line-remark").fill(fixtureKey);
    await page.keyboard.press("Escape");
    await saveDocument(page);
    await page.waitForFunction(() => {
      const input = document.querySelector('[data-testid="other-stock-in-bill-no"]');
      return input instanceof HTMLInputElement && /^QTRK\d{6}$/.test(input.value);
    });
    billNo = await billNoInput.inputValue();
    assert(/^QTRK\d{6}$/.test(billNo), `saved other stock in bill no should match QTRK######, got ${JSON.stringify(billNo)}`);
    await auditDocument(page);
    await page.getByTestId("document-status").filter({ hasText: "已审核" }).waitFor({ state: "visible" });
    await page.locator(".business-head h2").filter({ hasText: "其他入库单" }).click();
    const formShot = `a86-other-stock-in-form-audited-${batch}-${runToken}.png`;
    await page.screenshot({ path: path.join(screenshotDir, formShot), fullPage: true });
    captured.push(`verification/playwright/${formShot}`);

    await page.getByTestId("module-库存管理").hover();
    await page.getByTestId("query-other-in-form").click();
    await page.getByTestId("tab-other-in-form-list").waitFor({ state: "visible" });
    await page.getByTestId("tab-other-in-form-list").locator("span").click();
    await page.getByTestId("list-page-other-in-form-list").waitFor({ state: "visible" });
    await page.getByTestId("list-keyword").fill(billNo);
    await page.getByTestId("list-keyword").press("Enter");
    await page.getByText(billNo).waitFor({ state: "visible", timeout: 10000 });
    const listShot = `a86-other-stock-in-list-${batch}-${runToken}.png`;
    await page.screenshot({ path: path.join(screenshotDir, listShot), fullPage: true });
    captured.push(`verification/playwright/${listShot}`);
  } finally {
    await browser.close();
  }
  return captured;
}

function discoverCleanupArtifacts() {
  const warehouses = dbJson(`SELECT COALESCE(jsonb_agg(to_jsonb(warehouse_row) ORDER BY warehouse_row.id), '[]'::jsonb)::text FROM public.md_warehouse warehouse_row WHERE warehouse_row.id = ${sqlLiteral(warehouseId)}::uuid OR warehouse_row.code = ${sqlLiteral(warehouseCode)}`);
  assert(warehouses.length === 1
    && String(warehouses[0].id) === warehouseId
    && warehouses[0].code === warehouseCode
    && warehouses[0].name === warehouseName
    && warehouses[0].warehouse_type === "普通仓"
    && warehouses[0].manager === "A86"
    && warehouses[0].allow_negative_stock === false
    && warehouses[0].remark === fixtureKey
    && warehouses[0].enabled === true
    && warehouses[0].audit_status === "AUDITED",
  `A86 cleanup refused: warehouse ownership mismatch ${JSON.stringify(warehouses)}`);

  const headers = dbJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(header) ORDER BY header.id), '[]'::jsonb)::text
    FROM public.other_stock_in header
    WHERE header.department = ${sqlLiteral(fixtureKey)}
       OR header.id IN (SELECT line.bill_id FROM public.other_stock_in_line line WHERE line.warehouse_id = ${sqlLiteral(warehouseId)}::uuid)
  `);
  assert(headers.length <= 1, `A86 cleanup refused: unexpected header set ${JSON.stringify(headers)}`);
  for (const header of headers) {
    assertUuid(header.id, "A86 cleanup header id");
    assert((!headerId || String(header.id) === headerId)
      && (!billNo || header.bill_no === billNo)
      && header.department === fixtureKey
      && header.bill_date === billDate
      && /^QTRK\d{6}$/.test(String(header.bill_no ?? ""))
      && header.business_type === "其他入库"
      && ["DRAFT", "AUDITED"].includes(header.status)
      && Number(header.total_amount) === qty * unitPrice,
    `A86 cleanup refused: header ownership mismatch ${JSON.stringify(header)}`);
  }
  const headerIds = headers.map((row) => String(row.id)).sort();
  const billNos = headers.map((row) => String(row.bill_no)).sort();

  const lines = dbJson(`SELECT COALESCE(jsonb_agg(to_jsonb(line) ORDER BY line.id), '[]'::jsonb)::text FROM public.other_stock_in_line line WHERE line.bill_id = ANY(${uuidArray(headerIds)}) OR line.warehouse_id = ${sqlLiteral(warehouseId)}::uuid`);
  assert(lines.length === headers.length, `A86 cleanup refused: header/line closure mismatch ${JSON.stringify({ headers, lines })}`);
  for (const line of lines) {
    assertUuid(line.id, "A86 cleanup line id");
    assert((!lineId || String(line.id) === lineId)
      && headerIds.includes(String(line.bill_id))
      && String(line.product_id) === productId
      && String(line.warehouse_id) === warehouseId
      && Number(line.line_no) === 1
      && Number(line.qty) === qty
      && Number(line.unit_price) === unitPrice
      && Number(line.amount) === qty * unitPrice
      && line.line_remark === fixtureKey,
    `A86 cleanup refused: line ownership mismatch ${JSON.stringify(line)}`);
  }
  const lineIds = lines.map((row) => String(row.id)).sort();
  const lineById = new Map(lines.map((row) => [String(row.id), row]));
  const headerById = new Map(headers.map((row) => [String(row.id), row]));

  const transactions = dbJson(`SELECT COALESCE(jsonb_agg(to_jsonb(txn) ORDER BY txn.id), '[]'::jsonb)::text FROM public.inv_stock_txn txn WHERE txn.warehouse_id = ${sqlLiteral(warehouseId)}::uuid OR txn.source_bill_id = ANY(${uuidArray(headerIds)})`);
  const auditRows = [];
  const reverseRows = [];
  for (const txn of transactions) {
    const sourceHeader = headerById.get(String(txn.source_bill_id));
    const sourceLine = lineById.get(String(txn.source_bill_line_id));
    assertUuid(txn.id, "A86 cleanup transaction id");
    assert(String(txn.account_set_id) === accountSetId
      && String(txn.product_id) === productId
      && String(txn.warehouse_id) === warehouseId
      && txn.source_bill_type === "OTHER_STOCK_IN"
      && sourceHeader && sourceLine
      && String(sourceLine.bill_id) === String(sourceHeader.id)
      && Number(sourceLine.qty) === qty
      && txn.source_bill_no === sourceHeader.bill_no
      && txn.source_bill_date === billDate
      && txn.trace_quality === "EXACT",
    `A86 cleanup refused: transaction ownership mismatch ${JSON.stringify(txn)}`);
    const isAudit = txn.posting_action === "AUDIT" && txn.txn_type === "OTHER_STOCK_IN" && Number(txn.qty_delta) === qty && txn.reversal_of_txn_id == null;
    const isReverse = txn.posting_action === "REVERSE" && txn.txn_type === "OTHER_STOCK_IN_REVERSE" && Number(txn.qty_delta) === -qty;
    assert(isAudit || isReverse, `A86 cleanup refused: unexpected transaction shape ${JSON.stringify(txn)}`);
    (isAudit ? auditRows : reverseRows).push(txn);
  }
  assert(auditRows.length <= 1 && reverseRows.length <= 1, `A86 cleanup refused: duplicate posting facts ${JSON.stringify(transactions)}`);
  if (reverseRows.length === 1) {
    assert(auditRows.length === 1 && String(reverseRows[0].reversal_of_txn_id) === String(auditRows[0].id),
      `A86 cleanup refused: reversal closure mismatch ${JSON.stringify(transactions)}`);
  }
  const transactionIds = transactions.map((row) => String(row.id)).sort();

  const balances = dbJson(`SELECT COALESCE(jsonb_agg(to_jsonb(balance) ORDER BY balance.id), '[]'::jsonb)::text FROM public.inv_stock_balance balance WHERE balance.warehouse_id = ${sqlLiteral(warehouseId)}::uuid`);
  assert(balances.length <= 1 && balances.every((row) => String(row.account_set_id) === accountSetId && String(row.product_id) === productId && String(row.warehouse_id) === warehouseId),
    `A86 cleanup refused: balance ownership mismatch ${JSON.stringify(balances)}`);
  const balanceIds = balances.map((row) => String(row.id)).sort();

  const logTargetIds = [...new Set([runUserId, ...headerIds].filter(Boolean))].sort();
  const logTargetNos = [...new Set([runUsername, ...billNos].filter(Boolean))].sort();
  const logs = dbJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(log_row) ORDER BY log_row.id), '[]'::jsonb)::text
    FROM public.sys_operation_log log_row
    WHERE log_row.operated_by = ${sqlLiteral(runUserId)}::uuid
       OR log_row.actor_username = ${sqlLiteral(runUsername)}
       OR log_row.target_id = ANY(${uuidArray(logTargetIds)})
       OR log_row.target_no = ANY(${textArray(logTargetNos)})
  `);
  for (const logRow of logs) {
    assertUuid(logRow.id, "A86 cleanup operation-log id");
    assert(String(logRow.operated_by ?? "") === runUserId && logRow.actor_username === runUsername,
      `A86 cleanup refused: external actor log matched a run target ${JSON.stringify(logRow)}`);
  }
  const logIds = logs.map((row) => String(row.id)).sort();

  const locks = dbJson(`SELECT COALESCE(jsonb_agg(to_jsonb(lock_row) ORDER BY lock_row.document_type, lock_row.bill_no), '[]'::jsonb)::text FROM public.doc_edit_lock lock_row WHERE lock_row.document_type = 'otherStockIn' AND lock_row.bill_no = ANY(${textArray(billNos)})`);
  for (const lockRow of locks) {
    assert(lockRow.document_type === "otherStockIn"
      && billNos.includes(lockRow.bill_no)
      && String(lockRow.holder_user_id ?? "") === runUserId
      && lockRow.holder_username === runUsername,
    `A86 cleanup refused: external or changed document-lock holder ${JSON.stringify(lockRow)}`);
  }

  const snapshots = { warehouses, headers, lines, transactions, balances, logs, locks };
  return { headerIds, billNos, lineIds, transactionIds, balanceIds, logIds, logTargetIds, logTargetNos, locks, snapshots };
}

function cleanupRun() {
  cleanup.attempted = true;
  const artifacts = discoverCleanupArtifacts();
  cleanup.targets = artifacts;
  dbExecute(`
    BEGIN;
    SET LOCAL lock_timeout = '5s';
    SET LOCAL statement_timeout = '30s';
    LOCK TABLE public.md_warehouse,
               public.other_stock_in,
               public.other_stock_in_line,
               public.inv_stock_txn,
               public.inv_stock_balance,
               public.sys_operation_log,
               public.doc_edit_lock
      IN SHARE ROW EXCLUSIVE MODE;

    DO $a86_cleanup_guard$
    DECLARE
      actual jsonb;
    BEGIN
      SELECT COALESCE(jsonb_agg(to_jsonb(warehouse_row) ORDER BY warehouse_row.id), '[]'::jsonb)
      INTO actual
      FROM public.md_warehouse warehouse_row
      WHERE warehouse_row.id = ${sqlLiteral(warehouseId)}::uuid OR warehouse_row.code = ${sqlLiteral(warehouseCode)};
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(artifacts.snapshots.warehouses))}::jsonb THEN
        RAISE EXCEPTION 'A86 cleanup refused: warehouse snapshot changed after discovery';
      END IF;

      SELECT COALESCE(jsonb_agg(to_jsonb(header) ORDER BY header.id), '[]'::jsonb)
      INTO actual
      FROM public.other_stock_in header
      WHERE header.department = ${sqlLiteral(fixtureKey)}
         OR header.id IN (SELECT line.bill_id FROM public.other_stock_in_line line WHERE line.warehouse_id = ${sqlLiteral(warehouseId)}::uuid);
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(artifacts.snapshots.headers))}::jsonb THEN
        RAISE EXCEPTION 'A86 cleanup refused: header snapshot changed after discovery';
      END IF;

      SELECT COALESCE(jsonb_agg(to_jsonb(line) ORDER BY line.id), '[]'::jsonb)
      INTO actual
      FROM public.other_stock_in_line line
      WHERE line.bill_id = ANY(${uuidArray(artifacts.headerIds)})
         OR line.warehouse_id = ${sqlLiteral(warehouseId)}::uuid;
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(artifacts.snapshots.lines))}::jsonb THEN
        RAISE EXCEPTION 'A86 cleanup refused: line snapshot changed after discovery';
      END IF;

      SELECT COALESCE(jsonb_agg(to_jsonb(txn) ORDER BY txn.id), '[]'::jsonb)
      INTO actual
      FROM public.inv_stock_txn txn
      WHERE txn.warehouse_id = ${sqlLiteral(warehouseId)}::uuid
         OR txn.source_bill_id = ANY(${uuidArray(artifacts.headerIds)});
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(artifacts.snapshots.transactions))}::jsonb THEN
        RAISE EXCEPTION 'A86 cleanup refused: transaction snapshot changed after discovery';
      END IF;

      SELECT COALESCE(jsonb_agg(to_jsonb(balance) ORDER BY balance.id), '[]'::jsonb)
      INTO actual
      FROM public.inv_stock_balance balance
      WHERE balance.warehouse_id = ${sqlLiteral(warehouseId)}::uuid;
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(artifacts.snapshots.balances))}::jsonb THEN
        RAISE EXCEPTION 'A86 cleanup refused: balance snapshot changed after discovery';
      END IF;

      SELECT COALESCE(jsonb_agg(to_jsonb(log_row) ORDER BY log_row.id), '[]'::jsonb)
      INTO actual
      FROM public.sys_operation_log log_row
      WHERE log_row.operated_by = ${sqlLiteral(runUserId)}::uuid
         OR log_row.actor_username = ${sqlLiteral(runUsername)}
         OR log_row.target_id = ANY(${uuidArray(artifacts.logTargetIds)})
         OR log_row.target_no = ANY(${textArray(artifacts.logTargetNos)});
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(artifacts.snapshots.logs))}::jsonb THEN
        RAISE EXCEPTION 'A86 cleanup refused: operation-log snapshot changed after discovery';
      END IF;

      SELECT COALESCE(jsonb_agg(to_jsonb(lock_row) ORDER BY lock_row.document_type, lock_row.bill_no), '[]'::jsonb)
      INTO actual
      FROM public.doc_edit_lock lock_row
      WHERE lock_row.document_type = 'otherStockIn'
        AND lock_row.bill_no = ANY(${textArray(artifacts.billNos)});
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(artifacts.snapshots.locks))}::jsonb THEN
        RAISE EXCEPTION 'A86 cleanup refused: document-lock snapshot changed after discovery';
      END IF;
    END;
    $a86_cleanup_guard$;

    DELETE FROM public.doc_edit_lock lock_row WHERE ${lockKeyPredicate("lock_row", artifacts.locks)};
    DELETE FROM public.sys_operation_log WHERE id = ANY(${uuidArray(artifacts.logIds)});
    DELETE FROM public.inv_stock_txn WHERE id = ANY(${uuidArray(artifacts.transactionIds)});
    DELETE FROM public.other_stock_in_line WHERE id = ANY(${uuidArray(artifacts.lineIds)});
    DELETE FROM public.other_stock_in WHERE id = ANY(${uuidArray(artifacts.headerIds)});
    DELETE FROM public.inv_stock_balance WHERE id = ANY(${uuidArray(artifacts.balanceIds)});
    DELETE FROM public.md_warehouse
    WHERE id = ${sqlLiteral(warehouseId)}::uuid
      AND code = ${sqlLiteral(warehouseCode)}
      AND name = ${sqlLiteral(warehouseName)}
      AND remark = ${sqlLiteral(fixtureKey)};
    DO $a86_cleanup_closure$
    BEGIN
      IF EXISTS (SELECT 1 FROM public.other_stock_in WHERE id = ANY(${uuidArray(artifacts.headerIds)}) OR department = ${sqlLiteral(fixtureKey)})
         OR EXISTS (SELECT 1 FROM public.other_stock_in_line WHERE id = ANY(${uuidArray(artifacts.lineIds)}) OR warehouse_id = ${sqlLiteral(warehouseId)}::uuid)
         OR EXISTS (SELECT 1 FROM public.inv_stock_txn WHERE id = ANY(${uuidArray(artifacts.transactionIds)}) OR warehouse_id = ${sqlLiteral(warehouseId)}::uuid OR source_bill_id = ANY(${uuidArray(artifacts.headerIds)}))
         OR EXISTS (SELECT 1 FROM public.inv_stock_balance WHERE id = ANY(${uuidArray(artifacts.balanceIds)}) OR warehouse_id = ${sqlLiteral(warehouseId)}::uuid)
         OR EXISTS (SELECT 1 FROM public.md_warehouse WHERE id = ${sqlLiteral(warehouseId)}::uuid OR code = ${sqlLiteral(warehouseCode)})
         OR EXISTS (SELECT 1 FROM public.sys_operation_log WHERE id = ANY(${uuidArray(artifacts.logIds)}) OR operated_by = ${sqlLiteral(runUserId)}::uuid OR actor_username = ${sqlLiteral(runUsername)} OR target_id = ANY(${uuidArray(artifacts.logTargetIds)}) OR target_no = ANY(${textArray(artifacts.logTargetNos)}))
         OR EXISTS (SELECT 1 FROM public.doc_edit_lock WHERE document_type = 'otherStockIn' AND bill_no = ANY(${textArray(artifacts.billNos)})) THEN
        RAISE EXCEPTION 'A86 cleanup closure is not zero';
      END IF;
    END;
    $a86_cleanup_closure$;
    COMMIT;
  `);

  cleanup.residue = dbJson(`
    SELECT jsonb_build_object(
      'headers', (SELECT count(*) FROM public.other_stock_in WHERE id = ANY(${uuidArray(artifacts.headerIds)}) OR department = ${sqlLiteral(fixtureKey)}),
      'lines', (SELECT count(*) FROM public.other_stock_in_line WHERE id = ANY(${uuidArray(artifacts.lineIds)}) OR warehouse_id = ${sqlLiteral(warehouseId)}::uuid),
      'transactions', (SELECT count(*) FROM public.inv_stock_txn WHERE id = ANY(${uuidArray(artifacts.transactionIds)}) OR warehouse_id = ${sqlLiteral(warehouseId)}::uuid OR source_bill_id = ANY(${uuidArray(artifacts.headerIds)})),
      'balances', (SELECT count(*) FROM public.inv_stock_balance WHERE id = ANY(${uuidArray(artifacts.balanceIds)}) OR warehouse_id = ${sqlLiteral(warehouseId)}::uuid),
      'warehouse', (SELECT count(*) FROM public.md_warehouse WHERE id = ${sqlLiteral(warehouseId)}::uuid OR code = ${sqlLiteral(warehouseCode)}),
      'logs', (SELECT count(*) FROM public.sys_operation_log WHERE id = ANY(${uuidArray(artifacts.logIds)}) OR operated_by = ${sqlLiteral(runUserId)}::uuid OR actor_username = ${sqlLiteral(runUsername)} OR target_id = ANY(${uuidArray(artifacts.logTargetIds)}) OR target_no = ANY(${textArray(artifacts.logTargetNos)})),
      'locks', (SELECT count(*) FROM public.doc_edit_lock WHERE document_type = 'otherStockIn' AND bill_no = ANY(${textArray(artifacts.billNos)}))
    )::text
  `);
  const nonZero = Object.entries(cleanup.residue).filter(([, value]) => Number(value) !== 0);
  assert(nonZero.length === 0, `A86 cleanup residue must be zero, got ${JSON.stringify(cleanup.residue)}`);
  cleanup.passed = true;
}

function serializeError(error) {
  if (!error) return null;
  return { name: error.name ?? "Error", message: error.message ?? String(error), stack: error.stack ?? "" };
}

const health = await request("/api/system/health");
assert(health.status === 200, `A86 health precondition should return 200, got ${health.status}`);
assert(health.body?.testInventoryAdjustmentApi === true, `A86 requires health.testInventoryAdjustmentApi=true before any fixture write, got ${health.text}`);

try {
  identityWriteAttempted = true;
  createRunIdentity();
  await installApiSession(apiBase, runUsername, runPassword, "BLD-TEST");
  session = await request("/api/system/session");
  assert(session.status === 200, `A86 session precondition should return 200, got ${session.status}`);
  assert(session.body?.user?.username === runUsername, `A86 session actor must be ${runUsername}, got ${JSON.stringify(session.body?.user?.username)}`);
  assert(session.body?.tenant?.code === "BLD-TEST", `A86 must run only in tenant.code=BLD-TEST, got ${JSON.stringify(session.body?.tenant?.code)}`);
  assert(session.body?.tenant?.schemaName === "public", `A86 must run only in tenant.schemaName=public, got ${JSON.stringify(session.body?.tenant?.schemaName)}`);
  accountSetId = String(session.body?.tenant?.id ?? "");
  assertUuid(accountSetId, "A86 account set id");

  productId = dbScalar(`SELECT id::text FROM public.md_product WHERE code = ${sqlLiteral(productCode)} AND enabled = TRUE`);
  assertUuid(productId, `A86 product ${productCode}`);

  await mkdir(screenshotDir, { recursive: true });
  await mkdir(path.dirname(resultPath), { recursive: true });

  warehouseId = dbScalar(`
    INSERT INTO public.md_warehouse (
      code, name, warehouse_type, manager, allow_negative_stock, remark, enabled, audit_status
    ) VALUES (
      ${sqlLiteral(warehouseCode)}, ${sqlLiteral(warehouseName)}, '普通仓', 'A86', FALSE,
      ${sqlLiteral(fixtureKey)}, TRUE, 'AUDITED'
    )
    RETURNING id::text
  `);
  assertUuid(warehouseId, "A86 unique warehouse id");

  beforeState = stockState();
  assert(Number(beforeState.rows) === 0, `A86 unique warehouse must start without a balance row, got ${JSON.stringify(beforeState)}`);
  assert(Number(beforeState.onHand) === 0 && Number(beforeState.available) === 0 && Number(beforeState.reserved) === 0, `A86 unique warehouse must start at zero, got ${JSON.stringify(beforeState)}`);

  screenshots = await createAndAuditInFrontend();
  const identity = documentIdentity(billNo);
  headerId = identity.headerId;
  lineId = identity.lineId;
  assertUuid(headerId, "A86 other-stock-in header id");
  assertUuid(lineId, "A86 other-stock-in line id");
  assert(identity.billDate === billDate && identity.status === "AUDITED", `A86 saved identity should be audited on ${billDate}, got ${JSON.stringify(identity)}`);
  assert(identity.productId === productId && identity.warehouseId === warehouseId, `A86 saved line identity is outside the run-owned product/warehouse: ${JSON.stringify(identity)}`);
  assert(Number(identity.qty) === qty, `A86 saved line quantity should be ${qty}, got ${identity.qty}`);

  detailAfterAudit = (await request(`/api/other-stock-ins/${encodeURIComponent(billNo)}`)).body;
  afterAuditState = stockState();
  auditCandidates = txnCandidates(headerId);
  assert(detailAfterAudit?.document?.status === "AUDITED", `expected AUDITED, got ${detailAfterAudit?.document?.status}`);
  assert(Number(afterAuditState.onHand) === qty && Number(afterAuditState.available) === qty && Number(afterAuditState.reserved) === 0, `A86 audit should establish exact stock state ${qty}/${qty}/0, got ${JSON.stringify(afterAuditState)}`);
  assert(auditCandidates.length === 1, `A86 audit should have exactly one run-owned txn candidate, got ${JSON.stringify(auditCandidates)}`);
  assertFormalTxn(auditCandidates[0], {
    txnType: "OTHER_STOCK_IN",
    qtyDelta: qty,
    postingAction: "AUDIT",
    reversalOfTxnId: null,
    qtyOnHandAfter: qty
  });
  auditTxnId = auditCandidates[0].id;

  await request(`/api/other-stock-ins/${encodeURIComponent(billNo)}/reverse`, { method: "POST" });
  detailAfterReverse = (await request(`/api/other-stock-ins/${encodeURIComponent(billNo)}`)).body;
  afterReverseState = stockState();
  reverseCandidates = txnCandidates(headerId);
  assert(detailAfterReverse?.document?.status === "DRAFT", `expected DRAFT, got ${detailAfterReverse?.document?.status}`);
  assert(Number(afterReverseState.onHand) === 0 && Number(afterReverseState.available) === 0 && Number(afterReverseState.reserved) === 0, `A86 reverse should return stock to zero, got ${JSON.stringify(afterReverseState)}`);
  assert(reverseCandidates.length === 2, `A86 audit+reverse should have exactly two run-owned txn candidates, got ${JSON.stringify(reverseCandidates)}`);
  const persistedAudit = reverseCandidates.find((txn) => txn.postingAction === "AUDIT");
  const reverseTxn = reverseCandidates.find((txn) => txn.postingAction === "REVERSE");
  assert(persistedAudit?.id === auditTxnId, `A86 reverse capture should retain audit txn ${auditTxnId}, got ${persistedAudit?.id}`);
  assertFormalTxn(persistedAudit, {
    txnType: "OTHER_STOCK_IN",
    qtyDelta: qty,
    postingAction: "AUDIT",
    reversalOfTxnId: null,
    qtyOnHandAfter: qty
  });
  assertFormalTxn(reverseTxn, {
    txnType: "OTHER_STOCK_IN_REVERSE",
    qtyDelta: -qty,
    postingAction: "REVERSE",
    reversalOfTxnId: auditTxnId,
    qtyOnHandAfter: 0
  });
  reverseTxnId = reverseTxn.id;
} catch (error) {
  primaryError = error;
} finally {
  const cleanupErrors = [];
  if (warehouseId) {
    try {
      cleanupRun();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (identityWriteAttempted) {
    try {
      cleanupRunIdentity();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    cleanupError = new Error(cleanupErrors.map((error) => error instanceof Error ? error.message : String(error)).join(" | "));
  }
}

const result = {
  batch,
  runToken,
  generatedAt: new Date().toISOString(),
  preconditions: {
    healthStatus: health.body?.status,
    testInventoryAdjustmentApi: health.body?.testInventoryAdjustmentApi,
    tenantCode: session?.body?.tenant?.code,
    schemaName: session?.body?.tenant?.schemaName,
    accountSetId,
    actorUsername: runUsername,
    actorUserId: runUserId
  },
  fixture: { fixtureKey, billNo, headerId, lineId, productCode, productId, warehouseCode, warehouseId, qty },
  transactionIds: { auditTxnId, reverseTxnId },
  stock: { before: beforeState, afterAudit: afterAuditState, afterReverse: afterReverseState },
  statuses: {
    afterAudit: detailAfterAudit?.document?.status ?? null,
    afterReverse: detailAfterReverse?.document?.status ?? null
  },
  ownedCandidates: { afterAudit: auditCandidates, afterReverse: reverseCandidates },
  screenshots,
  cleanup,
  identityCleanup,
  failure: serializeError(primaryError),
  cleanupFailure: serializeError(cleanupError)
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));

if (primaryError) throw primaryError;
if (cleanupError) throw cleanupError;
