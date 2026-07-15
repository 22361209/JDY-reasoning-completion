import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { saveDocument, auditDocument } from "./helpers/document-actions.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a87-other-stock-out-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
const runToken = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`.toUpperCase();
const fixtureKey = `A87-${runToken}`;
const warehouseCode = `A87-${runToken}`;
const warehouseName = `A87 其他出库回归仓 ${runToken}`;
const seedTxnType = `A87_OTHER_STOCK_OUT_SEED_${runToken}`;
const seedSourceType = `A87_OTHER_STOCK_OUT_SEED:${runToken}`;
const shortageFailureEndpoint = "POST /api/other-stock-outs/{billNo}/audit";
const runUsername = `a87_${runToken.toLowerCase().replaceAll(/[^a-z0-9]+/g, "_")}_admin`;
const runPassword = `A87-${runToken}-Admin1!`;
const runDisplayName = `A87 ${runToken} admin`;
const billDate = "2026-06-25";
const productCode = "CP-001";
const qty = 3;
const seedQty = qty + 2;
const unitPrice = 1;
const faultPhase = process.env.A87_OTHER_STOCK_OUT_FAULT_PHASE ?? "";

let accountSetId = "";
let runUserId = "";
let identityWriteAttempted = false;
let session = null;
let productId = "";
let warehouseId = "";
let billNo = "";
let headerId = "";
let lineId = "";
let shortageBillNo = "";
let shortageHeaderId = "";
let shortageLineId = "";
let seedTxnId = "";
let auditTxnId = "";
let reverseTxnId = "";
let primaryError = null;
let cleanupError = null;
let screenshots = [];
let beforeSeedState = null;
let beforeState = null;
let afterAuditState = null;
let afterReverseState = null;
let beforeShortageState = null;
let afterShortageState = null;
let detailAfterAudit = null;
let detailAfterReverse = null;
let shortageResponse = null;
let seedCandidates = [];
let auditCandidates = [];
let reverseCandidates = [];
let shortageCandidates = [];
let shortageAuditAttempted = false;
let shortageFailureBaselineCaptured = false;
let shortageFailureLogBaselineIds = [];
let shortageFailureLogs = [];
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

function createRunIdentity() {
  const existing = Number(dbScalar(`SELECT count(*) FROM public.sys_user WHERE username = ${sqlLiteral(runUsername)}`));
  assert(existing === 0, `A87 run user must be unique, found ${existing} rows for ${runUsername}`);
  runUserId = dbScalar(`
    BEGIN;
    DO $a87_identity_guard$
    BEGIN
      IF (SELECT count(*) FROM public.sys_role WHERE code = 'ADMIN' AND enabled = TRUE) <> 1 THEN
        RAISE EXCEPTION 'A87 requires exactly one enabled ADMIN role';
      END IF;
      IF (SELECT count(*) FROM public.sys_account_set WHERE code = 'BLD-TEST' AND schema_name = 'public' AND enabled = TRUE) <> 1 THEN
        RAISE EXCEPTION 'A87 requires exactly one enabled BLD-TEST/public account set';
      END IF;
    END;
    $a87_identity_guard$;
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
  assertUuid(runUserId, "A87 run user id");
  const identity = dbJson(`
    SELECT jsonb_build_object(
      'users', (SELECT count(*) FROM public.sys_user WHERE id = ${sqlLiteral(runUserId)}::uuid AND username = ${sqlLiteral(runUsername)}),
      'roles', (SELECT count(*) FROM public.sys_user_role link JOIN public.sys_role role_row ON role_row.id = link.role_id WHERE link.user_id = ${sqlLiteral(runUserId)}::uuid AND role_row.code = 'ADMIN' AND role_row.enabled = TRUE),
      'grants', (SELECT count(*) FROM public.sys_user_account_set grant_row JOIN public.sys_account_set account_set ON account_set.id = grant_row.account_set_id WHERE grant_row.user_id = ${sqlLiteral(runUserId)}::uuid AND grant_row.role_code = 'ADMIN' AND grant_row.is_default = TRUE AND grant_row.enabled = TRUE AND account_set.code = 'BLD-TEST' AND account_set.schema_name = 'public'),
      'otherGrants', (SELECT count(*) FROM public.sys_user_account_set grant_row JOIN public.sys_account_set account_set ON account_set.id = grant_row.account_set_id WHERE grant_row.user_id = ${sqlLiteral(runUserId)}::uuid AND account_set.code <> 'BLD-TEST')
    )::text
  `);
  assert(Number(identity.users) === 1 && Number(identity.roles) === 1 && Number(identity.grants) === 1 && Number(identity.otherGrants) === 0,
    `A87 run identity must have only one BLD-TEST ADMIN grant, got ${JSON.stringify(identity)}`);
}

function cleanupRunIdentity() {
  identityCleanup.attempted = true;
  const userPredicate = runUserId
    ? `app_user.id = ${sqlLiteral(runUserId)}::uuid OR app_user.username = ${sqlLiteral(runUsername)}`
    : `app_user.username = ${sqlLiteral(runUsername)}`;
  const expectedAccountSetId = dbScalar(`SELECT id::text FROM public.sys_account_set WHERE code = 'BLD-TEST' AND schema_name = 'public' AND enabled = TRUE`);
  assertUuid(expectedAccountSetId, "A87 identity cleanup BLD-TEST account set id");

  const users = dbJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(app_user) ORDER BY app_user.id), '[]'::jsonb)::text
    FROM public.sys_user app_user
    WHERE ${userPredicate}
  `);
  assert(runUserId ? users.length === 1 : users.length <= 1,
    `A87 identity cleanup refused missing or ambiguous known-id-or-username match ${JSON.stringify({ runUserId, users })}`);
  for (const user of users) {
    assertUuid(user.id, "A87 cleanup run user id");
    assert((!runUserId || String(user.id) === runUserId)
      && user.username === runUsername
      && user.display_name === runDisplayName
      && user.password_hash === `{noop}${runPassword}`
      && user.enabled === true
      && String(user.default_account_set_id) === expectedAccountSetId,
    `A87 identity cleanup refused changed user fields ${JSON.stringify(user)}`);
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
      `A87 identity cleanup refused orphan identity links ${JSON.stringify({ roleLinks, grants, sessionScopes })}`);
  } else {
    assert(roleLinks.length === 1
      && String(roleLinks[0].link?.user_id) === identityUserId
      && String(roleLinks[0].link?.role_id) === String(roleLinks[0].role?.id)
      && roleLinks[0].role?.code === "ADMIN" && roleLinks[0].role?.enabled === true,
    `A87 identity cleanup refused changed role-link semantics ${JSON.stringify(roleLinks)}`);
    assert(grants.length === 1
      && String(grants[0].grant?.user_id) === identityUserId
      && String(grants[0].grant?.account_set_id) === expectedAccountSetId
      && grants[0].grant?.role_code === "ADMIN"
      && grants[0].grant?.is_default === true && grants[0].grant?.enabled === true
      && String(grants[0].accountSet?.id) === expectedAccountSetId
      && grants[0].accountSet?.code === "BLD-TEST"
      && grants[0].accountSet?.schema_name === "public" && grants[0].accountSet?.enabled === true,
    `A87 identity cleanup refused changed account-set grant semantics ${JSON.stringify(grants)}`);
  }
  for (const scopeRow of sessionScopes) {
    assertUuid(scopeRow.session_token, "A87 identity cleanup session token");
    assertUuid(scopeRow.scope_token, "A87 identity cleanup scope token");
    assert(String(scopeRow.user_id) === identityUserId
      && String(scopeRow.account_set_id) === expectedAccountSetId,
    `A87 identity cleanup refused changed or cross-account session scope ${JSON.stringify(scopeRow)}`);
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
    assertUuid(logRow.id, "A87 identity cleanup log id");
    assert(String(logRow.operated_by ?? "") === identityUserId && logRow.actor_username === runUsername,
      `A87 identity cleanup refused external actor log targeting run identity ${JSON.stringify(logRow)}`);
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
      `A87 identity cleanup refused external or changed lock holder ${JSON.stringify(lockRow)}`);
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
    DO $a87_identity_cleanup_guard$
    DECLARE
      actual jsonb;
    BEGIN
      SELECT COALESCE(jsonb_agg(to_jsonb(app_user) ORDER BY app_user.id), '[]'::jsonb)
      INTO actual FROM public.sys_user app_user WHERE ${userPredicate};
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(users))}::jsonb THEN
        RAISE EXCEPTION 'A87 identity cleanup refused: user snapshot changed after discovery';
      END IF;

      SELECT COALESCE(jsonb_agg(jsonb_build_object('link', to_jsonb(link), 'role', to_jsonb(role_row)) ORDER BY link.user_id, link.role_id), '[]'::jsonb)
      INTO actual
      FROM public.sys_user_role link
      JOIN public.sys_role role_row ON role_row.id = link.role_id
      WHERE link.user_id = ANY(${userIds});
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(roleLinks))}::jsonb THEN
        RAISE EXCEPTION 'A87 identity cleanup refused: role-link snapshot changed after discovery';
      END IF;

      SELECT COALESCE(jsonb_agg(jsonb_build_object('grant', to_jsonb(grant_row), 'accountSet', to_jsonb(account_set)) ORDER BY grant_row.id), '[]'::jsonb)
      INTO actual
      FROM public.sys_user_account_set grant_row
      JOIN public.sys_account_set account_set ON account_set.id = grant_row.account_set_id
      WHERE grant_row.user_id = ANY(${userIds});
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(grants))}::jsonb THEN
        RAISE EXCEPTION 'A87 identity cleanup refused: account-set grant snapshot changed after discovery';
      END IF;

      SELECT COALESCE(jsonb_agg(to_jsonb(scope_row) ORDER BY scope_row.session_token), '[]'::jsonb)
      INTO actual
      FROM public.sys_session_account_scope scope_row
      WHERE scope_row.user_id = ANY(${userIds});
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(sessionScopes))}::jsonb THEN
        RAISE EXCEPTION 'A87 identity cleanup refused: session-scope snapshot changed after discovery';
      END IF;

      SELECT COALESCE(jsonb_agg(to_jsonb(log_row) ORDER BY log_row.id), '[]'::jsonb)
      INTO actual
      FROM public.sys_operation_log log_row
      WHERE log_row.operated_by = ANY(${userIds})
         OR log_row.actor_username = ${sqlLiteral(runUsername)}
         OR log_row.target_id = ANY(${userIds})
         OR log_row.target_no = ${sqlLiteral(runUsername)};
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(identityLogs))}::jsonb THEN
        RAISE EXCEPTION 'A87 identity cleanup refused: identity log set changed after discovery';
      END IF;

      SELECT COALESCE(jsonb_agg(to_jsonb(lock_row) ORDER BY lock_row.document_type, lock_row.bill_no), '[]'::jsonb)
      INTO actual
      FROM public.doc_edit_lock lock_row
      WHERE lock_row.holder_user_id = ANY(${userIds})
         OR lock_row.holder_username = ${sqlLiteral(runUsername)};
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(identityLocks))}::jsonb THEN
        RAISE EXCEPTION 'A87 identity cleanup refused: identity lock set changed after discovery';
      END IF;
    END;
    $a87_identity_cleanup_guard$;
    DELETE FROM public.doc_edit_lock lock_row WHERE ${lockKeyPredicate("lock_row", identityLocks)};
    DELETE FROM public.sys_operation_log WHERE id = ANY(${uuidArray(identityLogIds)});
    DELETE FROM public.sys_session_account_scope
    WHERE session_token = ANY(${uuidArray(sessionTokens)})
      AND user_id = ANY(${userIds});
    DELETE FROM public.sys_user_account_set WHERE user_id = ANY(${userIds});
    DELETE FROM public.sys_user_role WHERE user_id = ANY(${userIds});
    DELETE FROM public.sys_user WHERE id = ANY(${userIds}) AND username = ${sqlLiteral(runUsername)};
    DO $a87_identity_cleanup_closure$
    BEGIN
      IF EXISTS (SELECT 1 FROM public.sys_user WHERE id = ANY(${userIds}) OR username = ${sqlLiteral(runUsername)})
         OR EXISTS (SELECT 1 FROM public.sys_user_role WHERE user_id = ANY(${userIds}))
         OR EXISTS (SELECT 1 FROM public.sys_user_account_set WHERE user_id = ANY(${userIds}))
         OR EXISTS (SELECT 1 FROM public.sys_session_account_scope WHERE user_id = ANY(${userIds}) OR session_token = ANY(${uuidArray(sessionTokens)}))
         OR EXISTS (SELECT 1 FROM public.sys_operation_log WHERE operated_by = ANY(${userIds}) OR actor_username = ${sqlLiteral(runUsername)} OR target_id = ANY(${userIds}) OR target_no = ${sqlLiteral(runUsername)})
         OR EXISTS (SELECT 1 FROM public.doc_edit_lock WHERE holder_user_id = ANY(${userIds}) OR holder_username = ${sqlLiteral(runUsername)}) THEN
        RAISE EXCEPTION 'A87 identity cleanup closure is not zero';
      END IF;
    END;
    $a87_identity_cleanup_closure$;
    COMMIT;
  `);
  identityCleanup.residue = dbJson(`
    SELECT jsonb_build_object(
      'users', (SELECT count(*) FROM public.sys_user WHERE username = ${sqlLiteral(runUsername)} OR id = ANY(${userIds})),
      'roles', (SELECT count(*) FROM public.sys_user_role WHERE user_id = ANY(${userIds})),
      'grants', (SELECT count(*) FROM public.sys_user_account_set WHERE user_id = ANY(${userIds})),
      'sessionScopes', (SELECT count(*) FROM public.sys_session_account_scope WHERE user_id = ANY(${userIds}) OR session_token = ANY(${uuidArray(sessionTokens)})),
      'logs', (SELECT count(*) FROM public.sys_operation_log WHERE operated_by = ANY(${userIds}) OR actor_username = ${sqlLiteral(runUsername)} OR target_id = ANY(${userIds}) OR target_no = ${sqlLiteral(runUsername)}),
      'locks', (SELECT count(*) FROM public.doc_edit_lock WHERE holder_user_id = ANY(${userIds}) OR holder_username = ${sqlLiteral(runUsername)})
    )::text
  `);
  assert(Object.values(identityCleanup.residue).every((value) => Number(value) === 0),
    `A87 identity cleanup residue must be zero, got ${JSON.stringify(identityCleanup.residue)}`);
  identityCleanup.passed = true;
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

function endpointFailureLogs() {
  return dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', log.id::text,
      'module', log.module_code,
      'action', log.action_code,
      'targetType', log.target_type,
      'targetId', log.target_id::text,
      'targetNo', log.target_no,
      'success', log.success,
      'reason', log.failure_reason,
      'accountSetId', log.account_set_id::text,
      'accountSetCode', log.account_set_code,
      'actorType', log.actor_type,
      'actorUsername', log.actor_username
    ) ORDER BY log.operated_at, log.id), '[]'::jsonb)::text
    FROM public.sys_operation_log log
    WHERE log.module_code = 'SECURITY'
      AND log.action_code = 'WRITE_FAILED'
      AND log.target_type = 'http_endpoint'
      AND log.target_id IS NULL
      AND log.target_no = ${sqlLiteral(shortageFailureEndpoint)}
      AND log.success = FALSE
      AND log.failure_reason = '库存不足，不能调整为负数'
      AND log.account_set_id = ${sqlLiteral(accountSetId)}::uuid
      AND log.account_set_code = 'BLD-TEST'
      AND log.actor_type = 'USER'
      AND log.actor_username = ${sqlLiteral(runUsername)}
  `);
}

function captureNewShortageFailureLogs() {
  assert(shortageFailureBaselineCaptured, "A87 shortage failure-log baseline must be captured before audit");
  const baseline = new Set(shortageFailureLogBaselineIds);
  const rows = endpointFailureLogs().filter((row) => !baseline.has(row.id));
  for (const row of rows) {
    assertUuid(row.id, "A87 shortage WRITE_FAILED log id");
    assert(row.module === "SECURITY" && row.action === "WRITE_FAILED" && row.targetType === "http_endpoint"
      && row.targetId == null && row.targetNo === shortageFailureEndpoint && row.success === false
      && row.reason === "库存不足，不能调整为负数" && row.accountSetId === accountSetId
      && row.accountSetCode === "BLD-TEST" && row.actorType === "USER" && row.actorUsername === runUsername,
    `A87 shortage failure-log ownership mismatch ${JSON.stringify(row)}`);
  }
  return rows;
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
    FROM public.other_stock_out header
    JOIN public.other_stock_out_line line ON line.bill_id = header.id
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

function testSeedCandidates() {
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
      AND txn.txn_type = ${sqlLiteral(seedTxnType)}
      AND txn.source_bill_type = ${sqlLiteral(seedSourceType)}
  `);
}

function assertFormalTxn(txn, expected) {
  assertUuid(txn?.id, `${expected.postingAction} txn id`);
  assert(txn.accountSetId === accountSetId, `${expected.postingAction} txn account set should be ${accountSetId}, got ${txn.accountSetId}`);
  assert(txn.productId === productId, `${expected.postingAction} txn product should be ${productId}, got ${txn.productId}`);
  assert(txn.warehouseId === warehouseId, `${expected.postingAction} txn warehouse should be ${warehouseId}, got ${txn.warehouseId}`);
  assert(txn.txnType === expected.txnType, `${expected.postingAction} txn type should be ${expected.txnType}, got ${txn.txnType}`);
  assert(Number(txn.qtyDelta) === expected.qtyDelta, `${expected.postingAction} qty delta should be ${expected.qtyDelta}, got ${txn.qtyDelta}`);
  assert(txn.sourceBillType === "OTHER_STOCK_OUT", `${expected.postingAction} source bill type must remain canonical OTHER_STOCK_OUT, got ${txn.sourceBillType}`);
  assert(txn.sourceBillNo === billNo, `${expected.postingAction} source bill no should be ${billNo}, got ${txn.sourceBillNo}`);
  assert(txn.sourceBillId === headerId, `${expected.postingAction} source header id should be ${headerId}, got ${txn.sourceBillId}`);
  assert(txn.sourceBillLineId === lineId, `${expected.postingAction} source line id should be ${lineId}, got ${txn.sourceBillLineId}`);
  assert(txn.sourceBillDate === billDate, `${expected.postingAction} source bill date should be ${billDate}, got ${txn.sourceBillDate}`);
  assert(txn.postingAction === expected.postingAction, `posting action should be ${expected.postingAction}, got ${txn.postingAction}`);
  assert(txn.traceQuality === "EXACT", `${expected.postingAction} trace quality should be EXACT, got ${txn.traceQuality}`);
  assert((txn.reversalOfTxnId ?? null) === expected.reversalOfTxnId, `${expected.postingAction} reversal link should be ${JSON.stringify(expected.reversalOfTxnId)}, got ${JSON.stringify(txn.reversalOfTxnId)}`);
  assert(Number(txn.qtyOnHandAfter) === expected.qtyOnHandAfter, `${expected.postingAction} qtyOnHandAfter should be ${expected.qtyOnHandAfter}, got ${txn.qtyOnHandAfter}`);
}

function assertSeedTxn(txn) {
  assertUuid(txn?.id, "A87 seed txn id");
  assertUuid(txn?.sourceBillId, "A87 seed source header id");
  assertUuid(txn?.sourceBillLineId, "A87 seed source line id");
  assert(txn.accountSetId === accountSetId && txn.productId === productId && txn.warehouseId === warehouseId, `A87 seed txn must belong to the run-owned account/product/warehouse, got ${JSON.stringify(txn)}`);
  assert(txn.txnType === seedTxnType && txn.sourceBillType === seedSourceType, `A87 seed txn must keep its A-number test identity, got ${JSON.stringify(txn)}`);
  assert(txn.sourceBillNo === seedSourceType, `A87 seed source bill no should be ${seedSourceType}, got ${txn.sourceBillNo}`);
  assert(Number(txn.qtyDelta) === seedQty && Number(txn.qtyOnHandAfter) === seedQty, `A87 seed should establish exactly ${seedQty}, got ${JSON.stringify(txn)}`);
  assert(txn.postingAction === "AUDIT" && txn.traceQuality === "TEST", `A87 seed must remain an explicit TEST/AUDIT fact, got ${JSON.stringify(txn)}`);
  assert(txn.reversalOfTxnId == null, `A87 seed must not claim a reversal link, got ${txn.reversalOfTxnId}`);
}

async function createAndAuditInFrontend() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const captured = [];
  try {
    await page.goto(frontendUrl, { waitUntil: "networkidle" });
    await loginAsAdmin(page, runPassword, "BLD-TEST", runUsername);
    await page.getByTestId("module-库存管理").hover();
    await page.getByTestId("entry-other-out-form").click();
    await page.getByTestId("tab-other-out-form").waitFor({ state: "visible" });
    const billNoInput = page.getByTestId("other-stock-out-bill-no");
    assert(await billNoInput.inputValue() === "", "new other stock out bill no should be blank");
    assert(!(await billNoInput.isEditable()), "new other stock out bill no should be readonly");
    await page.getByTestId("other-stock-out-bill-date").fill(billDate);
    await page.getByTestId("other-stock-out-department").fill(fixtureKey);
    await page.getByTestId("other-stock-out-line-product").fill(productCode);
    await page.getByTestId("other-stock-out-line-warehouse").fill(warehouseCode);
    await page.locator(".master-selector__menu button").filter({ hasText: warehouseCode }).first().click();
    await page.getByTestId("other-stock-out-line-qty").fill(String(qty));
    await page.getByTestId("other-stock-out-line-price").fill(String(unitPrice));
    await page.getByTestId("other-stock-out-line-remark").fill(fixtureKey);
    await page.keyboard.press("Escape");
    await saveDocument(page);
    await page.waitForFunction(() => {
      const input = document.querySelector('[data-testid="other-stock-out-bill-no"]');
      return input instanceof HTMLInputElement && /^QTCK\d{6}$/.test(input.value);
    });
    billNo = await billNoInput.inputValue();
    assert(/^QTCK\d{6}$/.test(billNo), `saved other stock out bill no should match QTCK######, got ${JSON.stringify(billNo)}`);
    await auditDocument(page);
    await page.getByTestId("document-status").filter({ hasText: "已审核" }).waitFor({ state: "visible" });
    const formShot = `a87-other-stock-out-form-audited-${batch}-${runToken}.png`;
    await page.screenshot({ path: path.join(screenshotDir, formShot), fullPage: true });
    captured.push(`verification/playwright/${formShot}`);

    await page.getByTestId("module-库存管理").hover();
    await page.getByTestId("query-other-out-form").click();
    await page.getByTestId("tab-other-out-form-list").waitFor({ state: "visible" });
    await page.getByTestId("list-keyword").fill(billNo);
    await page.getByTestId("list-keyword").press("Enter");
    await page.getByText(billNo).waitFor({ state: "visible", timeout: 10000 });
    const listShot = `a87-other-stock-out-list-${batch}-${runToken}.png`;
    await page.screenshot({ path: path.join(screenshotDir, listShot), fullPage: true });
    captured.push(`verification/playwright/${listShot}`);
  } finally {
    await browser.close();
  }
  return captured;
}

function discoverCleanupArtifacts() {
  const warehouseRows = dbJson(`SELECT COALESCE(jsonb_agg(to_jsonb(warehouse_row) ORDER BY warehouse_row.id), '[]'::jsonb)::text FROM public.md_warehouse warehouse_row WHERE warehouse_row.id = ${sqlLiteral(warehouseId)}::uuid OR warehouse_row.code = ${sqlLiteral(warehouseCode)}`);
  assert(warehouseRows.length === 1 && warehouseRows[0].id === warehouseId && warehouseRows[0].code === warehouseCode
    && warehouseRows[0].name === warehouseName && warehouseRows[0].remark === fixtureKey,
    `A87 cleanup refused: warehouse ownership mismatch ${JSON.stringify(warehouseRows)}`);

  const headers = dbJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(header) ORDER BY header.id), '[]'::jsonb)::text
    FROM public.other_stock_out header
    WHERE header.department = ${sqlLiteral(fixtureKey)}
       OR header.id IN (SELECT line.bill_id FROM public.other_stock_out_line line WHERE line.warehouse_id = ${sqlLiteral(warehouseId)}::uuid)
  `);
  assert(headers.length <= 2 && headers.every((row) => row.department === fixtureKey && row.bill_date === billDate && /^QTCK\d{6}$/.test(row.bill_no)),
    `A87 cleanup refused: header ownership mismatch ${JSON.stringify(headers)}`);
  const headerIds = headers.map((row) => String(row.id)).sort();
  const billNos = headers.map((row) => row.bill_no).sort();

  const lines = dbJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(line) ORDER BY line.id), '[]'::jsonb)::text
    FROM public.other_stock_out_line line
    WHERE line.bill_id = ANY(${uuidArray(headerIds)}) OR line.warehouse_id = ${sqlLiteral(warehouseId)}::uuid
  `);
  assert(lines.length === headers.length && lines.every((row) => headerIds.includes(String(row.bill_id)) && String(row.product_id) === productId && String(row.warehouse_id) === warehouseId && Number(row.line_no) === 1 && Number(row.qty) > 0 && row.line_remark === fixtureKey),
    `A87 cleanup refused: header/line ownership closure mismatch ${JSON.stringify({ headers, lines })}`);
  const lineIds = lines.map((row) => String(row.id)).sort();
  const lineById = new Map(lines.map((row) => [String(row.id), row]));
  const headerById = new Map(headers.map((row) => [String(row.id), row]));

  const transactions = dbJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(txn) ORDER BY txn.id), '[]'::jsonb)::text
    FROM public.inv_stock_txn txn
    WHERE txn.warehouse_id = ${sqlLiteral(warehouseId)}::uuid OR txn.source_bill_id = ANY(${uuidArray(headerIds)})
  `);
  const seedRows = [];
  const auditRows = [];
  const reverseRows = [];
  for (const txn of transactions) {
    assertUuid(txn.id, "A87 cleanup transaction id");
    assert(String(txn.account_set_id) === accountSetId && String(txn.product_id) === productId && String(txn.warehouse_id) === warehouseId,
      `A87 cleanup refused: transaction dimensions mismatch ${JSON.stringify(txn)}`);
    if (txn.source_bill_type === seedSourceType) {
      assert(txn.txn_type === seedTxnType && txn.source_bill_no === seedSourceType && Number(txn.qty_delta) === seedQty && txn.posting_action === "AUDIT" && txn.trace_quality === "TEST" && txn.reversal_of_txn_id == null,
        `A87 cleanup refused: seed ownership mismatch ${JSON.stringify(txn)}`);
      seedRows.push(txn);
      continue;
    }
    const sourceHeader = headerById.get(String(txn.source_bill_id));
    const sourceLine = lineById.get(String(txn.source_bill_line_id));
    assert(txn.source_bill_type === "OTHER_STOCK_OUT" && sourceHeader && sourceLine && String(sourceLine.bill_id) === String(sourceHeader.id) && Number(sourceLine.qty) === qty
      && txn.source_bill_no === sourceHeader.bill_no && txn.source_bill_date === billDate && txn.trace_quality === "EXACT",
    `A87 cleanup refused: formal transaction ownership mismatch ${JSON.stringify(txn)}`);
    const isAudit = txn.posting_action === "AUDIT" && txn.txn_type === "OTHER_STOCK_OUT" && Number(txn.qty_delta) === -qty && txn.reversal_of_txn_id == null;
    const isReverse = txn.posting_action === "REVERSE" && txn.txn_type === "OTHER_STOCK_OUT_REVERSE" && Number(txn.qty_delta) === qty;
    assert(isAudit || isReverse, `A87 cleanup refused: unexpected formal transaction ${JSON.stringify(txn)}`);
    (isAudit ? auditRows : reverseRows).push(txn);
  }
  assert(seedRows.length <= 1 && auditRows.length <= 1 && reverseRows.length <= 1,
    `A87 cleanup refused: duplicate posting facts ${JSON.stringify(transactions)}`);
  if (reverseRows.length === 1) {
    assert(auditRows.length === 1 && String(reverseRows[0].reversal_of_txn_id) === String(auditRows[0].id),
      `A87 cleanup refused: reversal closure mismatch ${JSON.stringify(transactions)}`);
  }
  const transactionIds = transactions.map((row) => String(row.id)).sort();

  const balances = dbJson(`SELECT COALESCE(jsonb_agg(to_jsonb(balance) ORDER BY balance.id), '[]'::jsonb)::text FROM public.inv_stock_balance balance WHERE balance.warehouse_id = ${sqlLiteral(warehouseId)}::uuid`);
  assert(balances.length <= 1 && balances.every((row) => String(row.account_set_id) === accountSetId && String(row.product_id) === productId && String(row.warehouse_id) === warehouseId),
    `A87 cleanup refused: balance ownership mismatch ${JSON.stringify(balances)}`);
  const balanceIds = balances.map((row) => String(row.id)).sort();

  const logTargetIds = [...new Set([runUserId, ...headerIds].filter(Boolean))].sort();
  const logTargetNos = [...new Set([runUsername, ...billNos].filter(Boolean))].sort();
  const runLogs = dbJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(log_row) ORDER BY log_row.id), '[]'::jsonb)::text
    FROM public.sys_operation_log log_row
    WHERE log_row.operated_by = ${sqlLiteral(runUserId)}::uuid
       OR log_row.actor_username = ${sqlLiteral(runUsername)}
       OR log_row.target_id = ANY(${uuidArray(logTargetIds)})
       OR log_row.target_no = ANY(${textArray(logTargetNos)})
  `);
  for (const row of runLogs) {
    assertUuid(row.id, "A87 cleanup run log id");
    assert(String(row.operated_by) === runUserId && row.actor_username === runUsername,
      `A87 cleanup refused: run-log ownership mismatch ${JSON.stringify(row)}`);
  }
  const failureLogIds = shortageFailureLogs.map((row) => row.id).sort();
  const logIds = [...new Set([...runLogs.map((row) => String(row.id)), ...failureLogIds])].sort();
  assert(failureLogIds.every((id) => logIds.includes(id)), `A87 cleanup must include every run-owned failure log ${JSON.stringify({ failureLogIds, logIds })}`);
  const locks = dbJson(`SELECT COALESCE(jsonb_agg(to_jsonb(lock_row) ORDER BY lock_row.document_type, lock_row.bill_no), '[]'::jsonb)::text FROM public.doc_edit_lock lock_row WHERE lock_row.document_type = 'otherStockOut' AND lock_row.bill_no = ANY(${textArray(billNos)})`);
  assert(locks.every((lockRow) => String(lockRow.holder_user_id) === runUserId && lockRow.holder_username === runUsername),
    `A87 cleanup refused: external or changed document-lock holder ${JSON.stringify(locks)}`);
  const snapshots = {
    warehouses: warehouseRows,
    headers,
    lines,
    transactions,
    balances,
    logs: runLogs,
    locks
  };
  return {
    headerIds,
    billNos,
    lineIds,
    transactionIds,
    balanceIds,
    logIds,
    failureLogIds,
    logTargetIds,
    logTargetNos,
    locks,
    snapshots
  };
}

function cleanupRun() {
  cleanup.attempted = true;
  if (shortageAuditAttempted) {
    shortageFailureLogs = captureNewShortageFailureLogs();
    assert(shortageFailureLogs.length <= 1, `A87 cleanup refused: ambiguous new endpoint failure logs ${JSON.stringify(shortageFailureLogs)}`);
  }
  const artifacts = discoverCleanupArtifacts();
  cleanup.targets = artifacts;
  dbExecute(`
    BEGIN;
    SET LOCAL lock_timeout = '5s';
    SET LOCAL statement_timeout = '30s';
    LOCK TABLE public.md_warehouse,
               public.other_stock_out,
               public.other_stock_out_line,
               public.inv_stock_txn,
               public.inv_stock_balance,
               public.sys_operation_log,
               public.doc_edit_lock
      IN SHARE ROW EXCLUSIVE MODE;
    DO $a87_cleanup_guard$
    DECLARE
      actual jsonb;
    BEGIN
      SELECT COALESCE(jsonb_agg(to_jsonb(warehouse_row) ORDER BY warehouse_row.id), '[]'::jsonb)
      INTO actual
      FROM public.md_warehouse warehouse_row
      WHERE warehouse_row.id = ${sqlLiteral(warehouseId)}::uuid OR warehouse_row.code = ${sqlLiteral(warehouseCode)};
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(artifacts.snapshots.warehouses))}::jsonb THEN
        RAISE EXCEPTION 'A87 cleanup refused: warehouse set or fields changed after discovery';
      END IF;

      SELECT COALESCE(jsonb_agg(to_jsonb(header) ORDER BY header.id), '[]'::jsonb)
      INTO actual
      FROM public.other_stock_out header
      WHERE header.department = ${sqlLiteral(fixtureKey)}
         OR header.id IN (SELECT line.bill_id FROM public.other_stock_out_line line WHERE line.warehouse_id = ${sqlLiteral(warehouseId)}::uuid);
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(artifacts.snapshots.headers))}::jsonb THEN
        RAISE EXCEPTION 'A87 cleanup refused: header set or fields changed after discovery';
      END IF;

      SELECT COALESCE(jsonb_agg(to_jsonb(line) ORDER BY line.id), '[]'::jsonb)
      INTO actual
      FROM public.other_stock_out_line line
      WHERE line.bill_id = ANY(${uuidArray(artifacts.headerIds)}) OR line.warehouse_id = ${sqlLiteral(warehouseId)}::uuid;
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(artifacts.snapshots.lines))}::jsonb THEN
        RAISE EXCEPTION 'A87 cleanup refused: line set or fields changed after discovery';
      END IF;

      SELECT COALESCE(jsonb_agg(to_jsonb(txn) ORDER BY txn.id), '[]'::jsonb)
      INTO actual
      FROM public.inv_stock_txn txn
      WHERE txn.warehouse_id = ${sqlLiteral(warehouseId)}::uuid OR txn.source_bill_id = ANY(${uuidArray(artifacts.headerIds)});
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(artifacts.snapshots.transactions))}::jsonb THEN
        RAISE EXCEPTION 'A87 cleanup refused: transaction set or fields changed after discovery';
      END IF;

      SELECT COALESCE(jsonb_agg(to_jsonb(balance) ORDER BY balance.id), '[]'::jsonb)
      INTO actual
      FROM public.inv_stock_balance balance
      WHERE balance.warehouse_id = ${sqlLiteral(warehouseId)}::uuid;
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(artifacts.snapshots.balances))}::jsonb THEN
        RAISE EXCEPTION 'A87 cleanup refused: balance set or fields changed after discovery';
      END IF;

      SELECT COALESCE(jsonb_agg(to_jsonb(log_row) ORDER BY log_row.id), '[]'::jsonb)
      INTO actual
      FROM public.sys_operation_log log_row
      WHERE log_row.operated_by = ${sqlLiteral(runUserId)}::uuid
         OR log_row.actor_username = ${sqlLiteral(runUsername)}
         OR log_row.target_id = ANY(${uuidArray(artifacts.logTargetIds)})
         OR log_row.target_no = ANY(${textArray(artifacts.logTargetNos)});
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(artifacts.snapshots.logs))}::jsonb THEN
        RAISE EXCEPTION 'A87 cleanup refused: operation-log set or fields changed after discovery';
      END IF;

      SELECT COALESCE(jsonb_agg(to_jsonb(lock_row) ORDER BY lock_row.document_type, lock_row.bill_no), '[]'::jsonb)
      INTO actual
      FROM public.doc_edit_lock lock_row
      WHERE lock_row.document_type = 'otherStockOut' AND lock_row.bill_no = ANY(${textArray(artifacts.billNos)});
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(artifacts.snapshots.locks))}::jsonb THEN
        RAISE EXCEPTION 'A87 cleanup refused: document-lock set or fields changed after discovery';
      END IF;
    END;
    $a87_cleanup_guard$;
    DELETE FROM public.doc_edit_lock lock_row WHERE ${lockKeyPredicate("lock_row", artifacts.locks)};
    DELETE FROM public.sys_operation_log WHERE id = ANY(${uuidArray(artifacts.logIds)});
    DELETE FROM public.inv_stock_txn WHERE id = ANY(${uuidArray(artifacts.transactionIds)});
    DELETE FROM public.other_stock_out_line WHERE id = ANY(${uuidArray(artifacts.lineIds)});
    DELETE FROM public.other_stock_out WHERE id = ANY(${uuidArray(artifacts.headerIds)});
    DELETE FROM public.inv_stock_balance WHERE id = ANY(${uuidArray(artifacts.balanceIds)});
    DELETE FROM public.md_warehouse WHERE id = ${sqlLiteral(warehouseId)}::uuid AND code = ${sqlLiteral(warehouseCode)} AND name = ${sqlLiteral(warehouseName)} AND remark = ${sqlLiteral(fixtureKey)};
    DO $a87_cleanup_closure$
    BEGIN
      IF EXISTS (SELECT 1 FROM public.other_stock_out WHERE id = ANY(${uuidArray(artifacts.headerIds)}) OR department = ${sqlLiteral(fixtureKey)})
         OR EXISTS (SELECT 1 FROM public.other_stock_out_line WHERE id = ANY(${uuidArray(artifacts.lineIds)}) OR warehouse_id = ${sqlLiteral(warehouseId)}::uuid)
         OR EXISTS (SELECT 1 FROM public.inv_stock_txn WHERE id = ANY(${uuidArray(artifacts.transactionIds)}) OR warehouse_id = ${sqlLiteral(warehouseId)}::uuid OR source_bill_id = ANY(${uuidArray(artifacts.headerIds)}))
         OR EXISTS (SELECT 1 FROM public.inv_stock_balance WHERE id = ANY(${uuidArray(artifacts.balanceIds)}) OR warehouse_id = ${sqlLiteral(warehouseId)}::uuid)
         OR EXISTS (SELECT 1 FROM public.md_warehouse WHERE id = ${sqlLiteral(warehouseId)}::uuid OR code = ${sqlLiteral(warehouseCode)})
         OR EXISTS (SELECT 1 FROM public.sys_operation_log WHERE id = ANY(${uuidArray(artifacts.logIds)}) OR operated_by = ${sqlLiteral(runUserId)}::uuid OR actor_username = ${sqlLiteral(runUsername)} OR target_id = ANY(${uuidArray(artifacts.logTargetIds)}) OR target_no = ANY(${textArray(artifacts.logTargetNos)}))
         OR EXISTS (SELECT 1 FROM public.doc_edit_lock WHERE document_type = 'otherStockOut' AND bill_no = ANY(${textArray(artifacts.billNos)})) THEN
        RAISE EXCEPTION 'A87 cleanup closure is not zero';
      END IF;
    END;
    $a87_cleanup_closure$;
    COMMIT;
  `);
  cleanup.residue = dbJson(`
    SELECT jsonb_build_object(
      'headers', (SELECT count(*) FROM public.other_stock_out WHERE id = ANY(${uuidArray(artifacts.headerIds)}) OR department = ${sqlLiteral(fixtureKey)}),
      'lines', (SELECT count(*) FROM public.other_stock_out_line WHERE id = ANY(${uuidArray(artifacts.lineIds)}) OR warehouse_id = ${sqlLiteral(warehouseId)}::uuid),
      'transactions', (SELECT count(*) FROM public.inv_stock_txn WHERE id = ANY(${uuidArray(artifacts.transactionIds)}) OR warehouse_id = ${sqlLiteral(warehouseId)}::uuid OR source_bill_id = ANY(${uuidArray(artifacts.headerIds)})),
      'balances', (SELECT count(*) FROM public.inv_stock_balance WHERE id = ANY(${uuidArray(artifacts.balanceIds)}) OR warehouse_id = ${sqlLiteral(warehouseId)}::uuid),
      'warehouse', (SELECT count(*) FROM public.md_warehouse WHERE id = ${sqlLiteral(warehouseId)}::uuid OR code = ${sqlLiteral(warehouseCode)}),
      'logs', (SELECT count(*) FROM public.sys_operation_log WHERE id = ANY(${uuidArray(artifacts.logIds)}) OR operated_by = ${sqlLiteral(runUserId)}::uuid OR actor_username = ${sqlLiteral(runUsername)} OR target_id = ANY(${uuidArray(artifacts.logTargetIds)}) OR target_no = ANY(${textArray(artifacts.logTargetNos)})),
      'locks', (SELECT count(*) FROM public.doc_edit_lock WHERE document_type = 'otherStockOut' AND bill_no = ANY(${textArray(artifacts.billNos)}))
    )::text
  `);
  const nonZero = Object.entries(cleanup.residue).filter(([, value]) => Number(value) !== 0);
  assert(nonZero.length === 0, `A87 cleanup residue must be zero, got ${JSON.stringify(cleanup.residue)}`);
  cleanup.passed = true;
}

function serializeError(error) {
  if (!error) return null;
  return { name: error.name ?? "Error", message: error.message ?? String(error), stack: error.stack ?? "" };
}

await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

const health = await request("/api/system/health");
assert(health.status === 200, `A87 health precondition should return 200, got ${health.status}`);
assert(health.body?.testInventoryAdjustmentApi === true, `A87 requires health.testInventoryAdjustmentApi=true before any fixture write, got ${health.text}`);

try {
  identityWriteAttempted = true;
  createRunIdentity();
  if (faultPhase === "after-identity") {
    throw new Error("A87 injected other-stock-out failure after run identity creation");
  }
  await installApiSession(apiBase, runUsername, runPassword, "BLD-TEST");
  session = await request("/api/system/session");
  assert(session.status === 200, `A87 session precondition should return 200, got ${session.status}`);
  assert(session.body?.user?.username === runUsername, `A87 session actor must be ${runUsername}, got ${JSON.stringify(session.body?.user?.username)}`);
  assert(session.body?.tenant?.code === "BLD-TEST", `A87 must run only in tenant.code=BLD-TEST, got ${JSON.stringify(session.body?.tenant?.code)}`);
  assert(session.body?.tenant?.schemaName === "public", `A87 must run only in tenant.schemaName=public, got ${JSON.stringify(session.body?.tenant?.schemaName)}`);
  accountSetId = String(session.body?.tenant?.id ?? "");
  assertUuid(accountSetId, "A87 account set id");

  productId = dbScalar(`SELECT id::text FROM public.md_product WHERE code = ${sqlLiteral(productCode)} AND enabled = TRUE`);
  assertUuid(productId, `A87 product ${productCode}`);

  warehouseId = dbScalar(`
    INSERT INTO public.md_warehouse (
      code, name, warehouse_type, manager, allow_negative_stock, remark, enabled, audit_status
    ) VALUES (
      ${sqlLiteral(warehouseCode)}, ${sqlLiteral(warehouseName)}, '普通仓', 'A87', FALSE,
      ${sqlLiteral(fixtureKey)}, TRUE, 'AUDITED'
    )
    RETURNING id::text
  `);
  assertUuid(warehouseId, "A87 unique warehouse id");

  beforeSeedState = stockState();
  assert(Number(beforeSeedState.rows) === 0, `A87 unique warehouse must start without a balance row, got ${JSON.stringify(beforeSeedState)}`);
  assert(Number(beforeSeedState.onHand) === 0 && Number(beforeSeedState.available) === 0 && Number(beforeSeedState.reserved) === 0, `A87 unique warehouse must start at zero, got ${JSON.stringify(beforeSeedState)}`);

  const seedResponse = await request("/api/inventory/adjustments", {
    method: "POST",
    body: { productCode, warehouseCode, qtyDelta: seedQty, txnType: seedTxnType, sourceBillType: seedSourceType }
  });
  assert(seedResponse.status === 201, `A87 restricted test seed should return 201, got ${seedResponse.status}`);
  beforeState = stockState();
  assert(Number(beforeState.onHand) === seedQty && Number(beforeState.available) === seedQty && Number(beforeState.reserved) === 0, `A87 seed should establish exact stock state ${seedQty}/${seedQty}/0, got ${JSON.stringify(beforeState)}`);
  seedCandidates = testSeedCandidates();
  assert(seedCandidates.length === 1, `A87 should capture exactly one unique-warehouse seed txn, got ${JSON.stringify(seedCandidates)}`);
  assertSeedTxn(seedCandidates[0]);
  seedTxnId = seedCandidates[0].id;

  screenshots = await createAndAuditInFrontend();
  const identity = documentIdentity(billNo);
  headerId = identity.headerId;
  lineId = identity.lineId;
  assertUuid(headerId, "A87 other-stock-out header id");
  assertUuid(lineId, "A87 other-stock-out line id");
  assert(identity.billDate === billDate && identity.status === "AUDITED", `A87 saved identity should be audited on ${billDate}, got ${JSON.stringify(identity)}`);
  assert(identity.productId === productId && identity.warehouseId === warehouseId, `A87 saved line identity is outside the run-owned product/warehouse: ${JSON.stringify(identity)}`);
  assert(Number(identity.qty) === qty, `A87 saved line quantity should be ${qty}, got ${identity.qty}`);

  detailAfterAudit = (await request(`/api/other-stock-outs/${encodeURIComponent(billNo)}`)).body;
  afterAuditState = stockState();
  auditCandidates = txnCandidates(headerId);
  assert(detailAfterAudit?.document?.status === "AUDITED", `expected AUDITED, got ${detailAfterAudit?.document?.status}`);
  assert(Number(afterAuditState.onHand) === seedQty - qty && Number(afterAuditState.available) === seedQty - qty && Number(afterAuditState.reserved) === 0, `A87 audit should reduce stock to ${seedQty - qty}/${seedQty - qty}/0, got ${JSON.stringify(afterAuditState)}`);
  assert(auditCandidates.length === 1, `A87 audit should have exactly one run-owned formal txn candidate, got ${JSON.stringify(auditCandidates)}`);
  assertFormalTxn(auditCandidates[0], {
    txnType: "OTHER_STOCK_OUT",
    qtyDelta: -qty,
    postingAction: "AUDIT",
    reversalOfTxnId: null,
    qtyOnHandAfter: seedQty - qty
  });
  auditTxnId = auditCandidates[0].id;

  await request(`/api/other-stock-outs/${encodeURIComponent(billNo)}/reverse`, { method: "POST" });
  detailAfterReverse = (await request(`/api/other-stock-outs/${encodeURIComponent(billNo)}`)).body;
  afterReverseState = stockState();
  reverseCandidates = txnCandidates(headerId);
  assert(detailAfterReverse?.document?.status === "DRAFT", `expected DRAFT, got ${detailAfterReverse?.document?.status}`);
  assert(Number(afterReverseState.onHand) === seedQty && Number(afterReverseState.available) === seedQty && Number(afterReverseState.reserved) === 0, `A87 reverse should return stock to the exact seeded state, got ${JSON.stringify(afterReverseState)}`);
  assert(reverseCandidates.length === 2, `A87 audit+reverse should have exactly two run-owned formal txn candidates, got ${JSON.stringify(reverseCandidates)}`);
  const persistedAudit = reverseCandidates.find((txn) => txn.postingAction === "AUDIT");
  const reverseTxn = reverseCandidates.find((txn) => txn.postingAction === "REVERSE");
  assert(persistedAudit?.id === auditTxnId, `A87 reverse capture should retain audit txn ${auditTxnId}, got ${persistedAudit?.id}`);
  assertFormalTxn(persistedAudit, {
    txnType: "OTHER_STOCK_OUT",
    qtyDelta: -qty,
    postingAction: "AUDIT",
    reversalOfTxnId: null,
    qtyOnHandAfter: seedQty - qty
  });
  assertFormalTxn(reverseTxn, {
    txnType: "OTHER_STOCK_OUT_REVERSE",
    qtyDelta: qty,
    postingAction: "REVERSE",
    reversalOfTxnId: auditTxnId,
    qtyOnHandAfter: seedQty
  });
  reverseTxnId = reverseTxn.id;

  beforeShortageState = stockState();
  const shortageQty = Math.max(Number(beforeShortageState.onHand), Number(beforeShortageState.available)) + 100000;
  const shortageDraft = await request("/api/other-stock-outs/draft", {
    method: "POST",
    body: {
      billNo: "",
      billDate,
      department: fixtureKey,
      ownerName: fixtureKey,
      lines: [{ productCode, warehouseCode, qty: shortageQty, unitPrice, lineRemark: fixtureKey }]
    }
  });
  assert(shortageDraft.status === 201, `A87 shortage draft should return 201, got ${shortageDraft.status}`);
  shortageBillNo = String(shortageDraft.body?.billNo ?? "");
  assert(/^QTCK\d{6}$/.test(shortageBillNo), `shortage other stock out bill no should match QTCK######, got ${JSON.stringify(shortageBillNo)}`);
  const shortageIdentity = documentIdentity(shortageBillNo);
  shortageHeaderId = shortageIdentity.headerId;
  shortageLineId = shortageIdentity.lineId;
  assertUuid(shortageHeaderId, "A87 shortage header id");
  assertUuid(shortageLineId, "A87 shortage line id");
  assert(shortageIdentity.status === "DRAFT" && Number(shortageIdentity.qty) === shortageQty, `A87 shortage draft identity is invalid: ${JSON.stringify(shortageIdentity)}`);

  shortageFailureLogBaselineIds = endpointFailureLogs().map((row) => row.id);
  assert(shortageFailureLogBaselineIds.length === 0, `A87 unique run actor must start without endpoint failure logs, got ${JSON.stringify(shortageFailureLogBaselineIds)}`);
  shortageFailureBaselineCaptured = true;
  shortageAuditAttempted = true;
  shortageResponse = await request(`/api/other-stock-outs/${encodeURIComponent(shortageBillNo)}/audit`, { method: "POST", expectFailure: true });
  shortageFailureLogs = captureNewShortageFailureLogs();
  afterShortageState = stockState();
  const shortageReason = String(shortageResponse.body?.reason ?? shortageResponse.body?.message ?? "");
  assert(shortageResponse.status === 409, `shortage audit should fail with 409, got ${shortageResponse.status}`);
  assert(shortageFailureLogs.length === 1, `shortage audit should add exactly one run-owned WRITE_FAILED/http_endpoint log, got ${JSON.stringify(shortageFailureLogs)}`);
  assert(shortageReason === "库存不足，不能调整为负数", `shortage audit should report the formal inventory guard, got ${JSON.stringify(shortageReason)}`);
  assert(JSON.stringify(afterShortageState) === JSON.stringify(beforeShortageState), `shortage audit must leave the exact stock state unchanged: ${JSON.stringify({ beforeShortageState, afterShortageState })}`);
  shortageCandidates = txnCandidates(shortageHeaderId);
  assert(shortageCandidates.length === 0, `shortage audit must create zero run-owned inventory facts, got ${JSON.stringify(shortageCandidates)}`);
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
  fixture: {
    fixtureKey,
    billNo,
    headerId,
    lineId,
    shortageBillNo,
    shortageHeaderId,
    shortageLineId,
    productCode,
    productId,
    warehouseCode,
    warehouseId,
    qty,
    seedQty
  },
  transactionIds: { seedTxnId, auditTxnId, reverseTxnId },
  stock: {
    beforeSeed: beforeSeedState,
    afterSeed: beforeState,
    afterAudit: afterAuditState,
    afterReverse: afterReverseState,
    beforeShortage: beforeShortageState,
    afterShortage: afterShortageState
  },
  statuses: {
    afterAudit: detailAfterAudit?.document?.status ?? null,
    afterReverse: detailAfterReverse?.document?.status ?? null,
    shortage: shortageResponse?.status ?? null,
    shortageReason: String(shortageResponse?.body?.reason ?? shortageResponse?.body?.message ?? "")
  },
  ownedCandidates: {
    seed: seedCandidates,
    afterAudit: auditCandidates,
    afterReverse: reverseCandidates,
    shortage: shortageCandidates
  },
  shortageFailureLog: {
    endpoint: shortageFailureEndpoint,
    baselineCount: shortageFailureLogBaselineIds.length,
    rows: shortageFailureLogs
  },
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
