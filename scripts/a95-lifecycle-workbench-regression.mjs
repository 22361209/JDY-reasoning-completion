import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a95-lifecycle-workbench-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const anonymousFetch = globalThis.fetch.bind(globalThis);
const runId = randomUUID();
const runToken = runId.replaceAll("-", "").slice(0, 12).toUpperCase();
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const fixturePrefix = `A95-${runToken}`;
const warehouseCode = `A95-W-${runToken}`;
const warehouseName = `A95生命周期隔离仓-${runToken}`;
const seedTxnType = `A95_SEED_IN_${runToken}`;
const seedSourceBillType = `A95:${runToken}`;
const runUsername = `a95_${runToken.toLowerCase()}_admin`;
const runDisplayName = `A95 ${runToken} admin`;
const runPassword = `A95-${runToken}-Admin1!`;
const billDate = "2026-06-26";
const productCode = "CP-001";
const qty = 2;

const documentDefinitions = Object.freeze({
  order: {
    table: "sales_order",
    lineTable: "sales_order_line",
    lineForeignKey: "order_id",
    endpoint: "sales-orders",
    detailKey: "order",
    allowedRemarks: [`${fixturePrefix}-order-initial`, `${fixturePrefix}-order-edited`]
  },
  notice: {
    table: "delivery_notice",
    lineTable: "delivery_notice_line",
    lineForeignKey: "bill_id",
    endpoint: "delivery-notices",
    detailKey: "document",
    allowedRemarks: [`${fixturePrefix}-notice`]
  },
  out: {
    table: "sales_out",
    lineTable: "sales_out_line",
    lineForeignKey: "bill_id",
    endpoint: "sales-outs",
    detailKey: "document",
    allowedRemarks: [`${fixturePrefix}-out-initial`, `${fixturePrefix}-out-edited`]
  }
});

const artifacts = {
  identity: { userId: "", username: runUsername },
  accountSet: null,
  product: null,
  warehouse: { id: "", code: warehouseCode, snapshot: null },
  seed: {
    txnType: seedTxnType,
    sourceBillType: seedSourceBillType,
    sourceHeaderId: "",
    sourceLineId: "",
    txnIds: []
  },
  documents: {
    order: { id: "", billNo: "", lineIds: [], currentLines: [], currentSnapshot: null, versions: [], deleteAttempted: false, cleanupDeletionForbidden: "" },
    notice: { id: "", billNo: "", lineIds: [], currentLines: [], currentSnapshot: null, versions: [], deleteAttempted: false, cleanupDeletionForbidden: "" },
    out: { id: "", billNo: "", lineIds: [], currentLines: [], currentSnapshot: null, versions: [], deleteAttempted: false, cleanupDeletionForbidden: "" }
  },
  txnIds: [],
  txnSnapshots: {},
  txnPairs: [],
  balanceIds: [],
  balanceSnapshots: {},
  receivableIds: [],
  receivableSnapshots: {},
  endpointFailureLogIds: [],
  operationLogIds: [],
  operationLogSnapshots: {},
  editLockSnapshots: []
};

const evidence = {
  runId,
  runToken,
  fixturePrefix,
  generatedAt: new Date().toISOString(),
  preflight: { write: null, cleanup: null },
  fixtures: artifacts,
  lifecycle: null,
  workbench: null,
  cleanup: {
    attempted: false,
    apiRecovery: [],
    canonicalTraceBeforeDelete: null,
    directDelete: null,
    identity: { attempted: false, passed: false, residue: null },
    residue: null,
    errors: []
  },
  ok: false,
  failure: null
};

let controlledWriteAuthorized = false;
let identityWriteAttempted = false;

function assert(condition, message, details = undefined) {
  if (!condition) {
    const suffix = details === undefined ? "" : `: ${JSON.stringify(details)}`;
    throw new Error(`${message}${suffix}`);
  }
}

function assertUuid(value, label) {
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? "")), `${label} must be a UUID`, value);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function pushUnique(target, ...values) {
  target.push(...values.filter(Boolean));
  target.splice(0, target.length, ...unique(target));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])])
    );
  }
  return value;
}

function jsonEqual(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function uuidIn(values) {
  const normalized = unique(values);
  return normalized.length
    ? normalized.map((value) => `${sqlLiteral(value)}::uuid`).join(", ")
    : "NULL::uuid";
}

function textIn(values) {
  const normalized = unique(values);
  return normalized.length ? normalized.map(sqlLiteral).join(", ") : "NULL";
}

function notRecorded(column, values) {
  const normalized = unique(values);
  return normalized.length ? `${column} NOT IN (${uuidIn(normalized)})` : "TRUE";
}

function runUserPredicate(alias = "") {
  const column = (name) => `${alias ? `${alias}.` : ""}${name}`;
  const predicates = [`${column("username")}=${sqlLiteral(runUsername)}`];
  if (artifacts.identity.userId) {
    predicates.unshift(`${column("id")}=${sqlLiteral(artifacts.identity.userId)}::uuid`);
  }
  return `(${predicates.join(" OR ")})`;
}

function runActorCandidatePredicate(alias = "") {
  const column = (name) => `${alias ? `${alias}.` : ""}${name}`;
  const predicates = [`${column("actor_username")}=${sqlLiteral(runUsername)}`];
  if (artifacts.identity.userId) {
    predicates.unshift(`${column("operated_by")}=${sqlLiteral(artifacts.identity.userId)}::uuid`);
  }
  return `(${predicates.join(" OR ")})`;
}

function runActorOwnedPredicate(alias = "") {
  const column = (name) => `${alias ? `${alias}.` : ""}${name}`;
  if (!artifacts.identity.userId) return "(FALSE)";
  return `(${column("operated_by")}=${sqlLiteral(artifacts.identity.userId)}::uuid AND ${column("actor_username")}=${sqlLiteral(runUsername)})`;
}

function psql(sql) {
  return execFileSync("docker", [
    "exec",
    "jdy-erp-postgres",
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "jdy",
    "-d",
    "jdy_erp",
    "-tA",
    "-c",
    sql
  ], { encoding: "utf8" }).trim();
}

function dbJson(sql) {
  const output = psql(sql);
  if (!output || output === "null") return null;
  return JSON.parse(output);
}

function dbNumber(sql) {
  return Number(psql(sql) || "0");
}

function createRunIdentity() {
  assert(dbNumber(`SELECT count(*) FROM public.sys_user WHERE username=${sqlLiteral(runUsername)}`) === 0,
    "A95 run username must be unique before identity creation", runUsername);
  identityWriteAttempted = true;
  psql(`
    BEGIN;
    DO $a95_identity_guard$
    BEGIN
      IF (SELECT count(*) FROM public.sys_role WHERE code='ADMIN' AND enabled=TRUE) <> 1 THEN
        RAISE EXCEPTION 'A95 requires exactly one enabled ADMIN role';
      END IF;
      IF (SELECT count(*) FROM public.sys_account_set WHERE code='BLD-TEST' AND schema_name='public' AND enabled=TRUE) <> 1 THEN
        RAISE EXCEPTION 'A95 requires exactly one enabled BLD-TEST/public account set';
      END IF;
    END;
    $a95_identity_guard$;
    INSERT INTO public.sys_user (username, display_name, password_hash, enabled, default_account_set_id)
    SELECT ${sqlLiteral(runUsername)}, ${sqlLiteral(runDisplayName)}, ${sqlLiteral(`{noop}${runPassword}`)}, TRUE, account_set.id
    FROM public.sys_account_set account_set
    WHERE account_set.code='BLD-TEST' AND account_set.schema_name='public' AND account_set.enabled=TRUE;
    INSERT INTO public.sys_user_role (user_id, role_id)
    SELECT app_user.id, role_row.id
    FROM public.sys_user app_user, public.sys_role role_row
    WHERE app_user.username=${sqlLiteral(runUsername)} AND role_row.code='ADMIN' AND role_row.enabled=TRUE;
    INSERT INTO public.sys_user_account_set (user_id, account_set_id, role_code, is_default, enabled)
    SELECT app_user.id, account_set.id, 'ADMIN', TRUE, TRUE
    FROM public.sys_user app_user, public.sys_account_set account_set
    WHERE app_user.username=${sqlLiteral(runUsername)}
      AND account_set.code='BLD-TEST' AND account_set.schema_name='public' AND account_set.enabled=TRUE;
    COMMIT;
  `);
  artifacts.identity.userId = psql(`SELECT id::text FROM public.sys_user WHERE username=${sqlLiteral(runUsername)}`);
  assertUuid(artifacts.identity.userId, "A95 run user id");
  const identity = dbJson(`
    SELECT jsonb_build_object(
      'users', (SELECT count(*) FROM public.sys_user WHERE id=${sqlLiteral(artifacts.identity.userId)}::uuid AND username=${sqlLiteral(runUsername)}),
      'roles', (SELECT count(*) FROM public.sys_user_role link JOIN public.sys_role role_row ON role_row.id=link.role_id WHERE link.user_id=${sqlLiteral(artifacts.identity.userId)}::uuid AND role_row.code='ADMIN' AND role_row.enabled=TRUE),
      'grants', (SELECT count(*) FROM public.sys_user_account_set grant_row JOIN public.sys_account_set account_set ON account_set.id=grant_row.account_set_id WHERE grant_row.user_id=${sqlLiteral(artifacts.identity.userId)}::uuid AND grant_row.role_code='ADMIN' AND grant_row.is_default=TRUE AND grant_row.enabled=TRUE AND account_set.code='BLD-TEST' AND account_set.schema_name='public'),
      'otherGrants', (SELECT count(*) FROM public.sys_user_account_set grant_row JOIN public.sys_account_set account_set ON account_set.id=grant_row.account_set_id WHERE grant_row.user_id=${sqlLiteral(artifacts.identity.userId)}::uuid AND account_set.code <> 'BLD-TEST')
    )::text
  `);
  assert(Number(identity.users) === 1 && Number(identity.roles) === 1 && Number(identity.grants) === 1 && Number(identity.otherGrants) === 0,
    "A95 run identity must have exactly one BLD-TEST ADMIN grant", identity);
}

function identityCleanupSnapshotExpression(userIds) {
  return `jsonb_build_object(
    'users', COALESCE((
      SELECT jsonb_agg(to_jsonb(app_user) ORDER BY app_user.id)
      FROM public.sys_user app_user
      WHERE ${runUserPredicate("app_user")}
    ), '[]'::jsonb),
    'roles', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('link', to_jsonb(user_role), 'role', to_jsonb(role_row)) ORDER BY user_role.user_id, user_role.role_id)
      FROM public.sys_user_role user_role
      JOIN public.sys_role role_row ON role_row.id=user_role.role_id
      WHERE user_role.user_id IN (${uuidIn(userIds)})
    ), '[]'::jsonb),
    'grants', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('grant', to_jsonb(user_grant), 'accountSet', to_jsonb(account_set)) ORDER BY user_grant.user_id, user_grant.account_set_id)
      FROM public.sys_user_account_set user_grant
      JOIN public.sys_account_set account_set ON account_set.id=user_grant.account_set_id
      WHERE user_grant.user_id IN (${uuidIn(userIds)})
    ), '[]'::jsonb),
    'sessionScopes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('scope', to_jsonb(session_scope), 'accountSet', to_jsonb(account_set)) ORDER BY session_scope.session_token)
      FROM public.sys_session_account_scope session_scope
      JOIN public.sys_account_set account_set ON account_set.id=session_scope.account_set_id
      WHERE session_scope.user_id IN (${uuidIn(userIds)})
    ), '[]'::jsonb),
    'logs', COALESCE((
      SELECT jsonb_agg(to_jsonb(operation_log) ORDER BY operation_log.id)
      FROM public.sys_operation_log operation_log
      WHERE ${runActorCandidatePredicate("operation_log")}
    ), '[]'::jsonb),
    'locks', COALESCE((
      SELECT jsonb_agg(to_jsonb(edit_lock) ORDER BY edit_lock.document_type, edit_lock.bill_no)
      FROM public.doc_edit_lock edit_lock
      WHERE edit_lock.holder_user_id IN (${uuidIn(userIds)})
         OR edit_lock.holder_username=${sqlLiteral(runUsername)}
    ), '[]'::jsonb)
  )`;
}

function cleanupRunIdentity() {
  const identityCleanup = evidence.cleanup.identity;
  identityCleanup.attempted = true;
  const discoveredUsers = dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', app_user.id::text) ORDER BY app_user.id), '[]'::jsonb)::text
    FROM public.sys_user app_user
    WHERE ${runUserPredicate("app_user")}
  `) ?? [];
  assert(discoveredUsers.length <= 1, "A95 identity cleanup refused ambiguous known-id-or-username matches", discoveredUsers);
  const expectedUserId = artifacts.identity.userId || discoveredUsers[0]?.id || "";
  const userIds = unique([expectedUserId, ...discoveredUsers.map((user) => user.id)]);
  for (const userId of userIds) assertUuid(userId, "A95 identity cleanup known user id");
  if (!artifacts.identity.userId && expectedUserId) artifacts.identity.userId = expectedUserId;

  const snapshotExpression = identityCleanupSnapshotExpression(userIds);
  const snapshot = dbJson(`SELECT (${snapshotExpression})::text`);
  assert(snapshot, "A95 identity cleanup could not capture the complete ownership snapshot");
  assert(snapshot.users.length === discoveredUsers.length, "A95 identity user set changed during snapshot discovery", snapshot.users);
  if (artifacts.identity.userId) assert(snapshot.users.length === 1, "A95 known identity must still exist exactly once", snapshot.users);
  for (const user of snapshot.users) {
    assert(
      user.id === expectedUserId
        && user.username === runUsername
        && user.display_name === runDisplayName
        && user.enabled === true
        && (!artifacts.accountSet?.id || user.default_account_set_id === artifacts.accountSet.id),
      "A95 identity cleanup refused changed full user snapshot fields",
      user
    );
  }
  assert(snapshot.roles.length === snapshot.users.length,
    "A95 identity cleanup requires exactly one role link for each discovered run user", snapshot.roles);
  for (const role of snapshot.roles) {
    assert(
      userIds.includes(role.link.user_id)
        && role.role.code === "ADMIN"
        && role.role.enabled === true,
      "A95 identity cleanup requires the sole enabled ADMIN role",
      role
    );
  }
  assert(snapshot.grants.length === snapshot.users.length,
    "A95 identity cleanup requires exactly one account-set grant for each discovered run user", snapshot.grants);
  for (const grant of snapshot.grants) {
    assert(
      userIds.includes(grant.grant.user_id)
        && grant.grant.account_set_id === grant.accountSet.id
        && grant.grant.role_code === "ADMIN"
        && grant.grant.is_default === true
        && grant.grant.enabled === true
        && grant.accountSet.code === "BLD-TEST"
        && grant.accountSet.schema_name === "public"
        && grant.accountSet.enabled === true
        && (!snapshot.users[0] || snapshot.users[0].default_account_set_id === grant.accountSet.id)
        && (!artifacts.accountSet?.id || artifacts.accountSet.id === grant.accountSet.id),
      "A95 identity cleanup requires the sole BLD-TEST/public ADMIN grant",
      grant
    );
  }
  for (const sessionScope of snapshot.sessionScopes) {
    assertUuid(sessionScope.scope.session_token, "A95 identity cleanup session-scope token");
    assertUuid(sessionScope.scope.scope_token, "A95 identity cleanup account-scope token");
    assert(
      userIds.length === 1
        && sessionScope.scope.user_id === expectedUserId
        && sessionScope.scope.account_set_id === sessionScope.accountSet.id
        && Number(sessionScope.scope.version) >= 0
        && sessionScope.accountSet.code === "BLD-TEST"
        && sessionScope.accountSet.schema_name === "public"
        && sessionScope.accountSet.enabled === true
        && (!snapshot.users[0] || snapshot.users[0].default_account_set_id === sessionScope.accountSet.id)
        && (!artifacts.accountSet?.id || artifacts.accountSet.id === sessionScope.accountSet.id),
      "A95 identity cleanup refused an unowned or mismatched persisted session scope",
      sessionScope
    );
  }
  for (const log of snapshot.logs) {
    assertUuid(log.id, "A95 identity cleanup operation log id");
    assert(
      userIds.length === 1
        && log.operated_by === expectedUserId
        && log.actor_username === runUsername,
      "A95 identity cleanup refused an ambiguous or mismatched operation-log actor",
      log
    );
  }
  for (const lock of snapshot.locks) {
    assert(
      userIds.length === 1
        && lock.holder_user_id === expectedUserId
        && lock.holder_username === runUsername,
      "A95 identity cleanup refused an ambiguous or mismatched edit-lock holder",
      lock
    );
  }
  const sessionTokens = snapshot.sessionScopes.map((sessionScope) => sessionScope.scope.session_token);
  const logIds = snapshot.logs.map((log) => log.id);
  identityCleanup.snapshotCounts = Object.fromEntries(
    Object.entries(snapshot).map(([key, rows]) => [key, rows.length])
  );

  psql(`
    BEGIN;
    SET LOCAL lock_timeout='10s';
    LOCK TABLE public.sys_user,
               public.sys_user_role,
               public.sys_role,
               public.sys_user_account_set,
               public.sys_account_set,
               public.sys_session_account_scope,
               public.sys_operation_log,
               public.doc_edit_lock
      IN SHARE ROW EXCLUSIVE MODE;
    DO $a95_identity_snapshot_guard$
    DECLARE
      actual_snapshot jsonb;
      expected_snapshot constant jsonb := ${sqlLiteral(JSON.stringify(snapshot))}::jsonb;
    BEGIN
      SELECT ${identityCleanupSnapshotExpression(userIds)} INTO actual_snapshot;
      IF actual_snapshot IS DISTINCT FROM expected_snapshot THEN
        RAISE EXCEPTION 'A95 identity cleanup refused: user/role/grant/session-scope/log/lock snapshots changed after discovery';
      END IF;
    END;
    $a95_identity_snapshot_guard$;
    DELETE FROM public.doc_edit_lock
    WHERE holder_user_id IN (${uuidIn(userIds)})
      AND holder_username=${sqlLiteral(runUsername)};
    DELETE FROM public.sys_operation_log
    WHERE id IN (${uuidIn(logIds)})
      AND ${runActorOwnedPredicate()};
    DELETE FROM public.sys_session_account_scope
    WHERE session_token IN (${uuidIn(sessionTokens)})
      AND user_id IN (${uuidIn(userIds)});
    DELETE FROM public.sys_user_account_set WHERE user_id IN (${uuidIn(userIds)});
    DELETE FROM public.sys_user_role WHERE user_id IN (${uuidIn(userIds)});
    DELETE FROM public.sys_user
    WHERE id IN (${uuidIn(userIds)})
      AND username=${sqlLiteral(runUsername)};
    COMMIT;
  `);
  const residueUserIds = `(SELECT residue_user.id FROM public.sys_user residue_user WHERE ${runUserPredicate("residue_user")})`;
  identityCleanup.residue = dbJson(`
    SELECT jsonb_build_object(
      'users', (SELECT count(*) FROM public.sys_user WHERE ${runUserPredicate()}),
      'roles', (SELECT count(*) FROM public.sys_user_role WHERE user_id IN (${uuidIn(userIds)}) OR user_id IN ${residueUserIds}),
      'grants', (SELECT count(*) FROM public.sys_user_account_set WHERE user_id IN (${uuidIn(userIds)}) OR user_id IN ${residueUserIds}),
      'sessionScopes', (SELECT count(*) FROM public.sys_session_account_scope WHERE session_token IN (${uuidIn(sessionTokens)}) OR user_id IN (${uuidIn(userIds)}) OR user_id IN ${residueUserIds}),
      'logs', (SELECT count(*) FROM public.sys_operation_log WHERE ${runActorCandidatePredicate()}),
      'locks', (SELECT count(*) FROM public.doc_edit_lock WHERE holder_user_id IN (${uuidIn(userIds)}) OR holder_user_id IN ${residueUserIds} OR holder_username=${sqlLiteral(runUsername)})
    )::text
  `);
  assert(Object.values(identityCleanup.residue).every((value) => Number(value) === 0),
    "A95 identity cleanup must leave zero known-id-or-username residue", identityCleanup.residue);
  identityCleanup.logIds = logIds;
  identityCleanup.passed = true;
}

async function request(pathname, options = {}) {
  const method = options.method ?? "GET";
  const response = await fetch(`${apiBase}${pathname}`, {
    method,
    headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { ok: response.ok, status: response.status, data, text };
}

async function requireApi(pathname, options = {}) {
  const expected = options.expected ?? [200, 201];
  const response = await request(pathname, options);
  if (!expected.includes(response.status)) {
    throw new Error(`${options.method ?? "GET"} ${pathname} expected ${expected.join("/")} but got ${response.status}: ${response.text}`);
  }
  return response.data;
}

async function anonymousHealthGate(phase) {
  const response = await anonymousFetch(`${apiBase}/api/system/health`);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  assert(response.status === 200, `A95 ${phase} anonymous gate requires backend health 200`, { status: response.status, data });
  assert(data?.testInventoryAdjustmentApi === true, `A95 ${phase} anonymous gate requires testInventoryAdjustmentApi=true`, data);
  return {
    anonymous: true,
    status: data.status,
    testInventoryAdjustmentApi: data.testInventoryAdjustmentApi,
    devBuildFingerprint: data.devBuildFingerprint
  };
}

async function controlledGate(phase, anonymousHealth) {
  const health = anonymousHealth ?? await anonymousHealthGate(phase);

  const session = await requireApi("/api/system/session", { method: "GET", expected: [200] });
  assert(session?.authenticated === true, `A95 ${phase} gate requires an authenticated session`, session);
  assert(session?.user?.username === runUsername, `A95 ${phase} gate requires the run-unique actor`, session?.user);
  assert(session?.tenant?.code === "BLD-TEST", `A95 ${phase} gate requires tenant BLD-TEST`, session?.tenant);
  assert(session?.tenant?.schemaName === "public", `A95 ${phase} gate requires public schema`, session?.tenant);

  const accountSet = dbJson(`
    SELECT row_to_json(account_row)::text
    FROM (
      SELECT id::text AS id, code, schema_name AS "schemaName"
      FROM public.sys_account_set
      WHERE code='BLD-TEST'
    ) account_row
  `);
  const product = dbJson(`
    SELECT row_to_json(product_row)::text
    FROM (
      SELECT id::text AS id, code
      FROM public.md_product
      WHERE code=${sqlLiteral(productCode)}
    ) product_row
  `);
  assert(accountSet?.id === session.tenant.id && accountSet.schemaName === "public", `A95 ${phase} gate database account set mismatch`, { accountSet, tenant: session.tenant });
  assert(product?.id, `A95 ${phase} gate requires product CP-001`, product);
  artifacts.accountSet = accountSet;
  artifacts.product = product;
  return {
    health,
    session: {
      authenticated: session.authenticated,
      tenantCode: session.tenant.code,
      schemaName: session.tenant.schemaName,
      accountSetId: session.tenant.id,
      username: session.user?.username
    }
  };
}

function generatedBillNo(row, label) {
  const billNo = String(row?.billNo ?? "");
  assert(billNo, `${label} did not return billNo`, row);
  return billNo;
}

function documentQuery(kind, billNo) {
  const definition = documentDefinitions[kind];
  return `
    SELECT jsonb_build_object(
      'id', header.id::text,
      'billNo', header.bill_no,
      'status', header.status,
      'remark', COALESCE(header.remark, ''),
      'lines', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', line.id::text,
          'lineNo', line.line_no,
          'productId', line.product_id::text,
          'warehouseId', line.warehouse_id::text
        ) ORDER BY line.line_no)
        FROM public.${definition.lineTable} line
        WHERE line.${definition.lineForeignKey}=header.id
      ), '[]'::jsonb)
    )::text
    FROM public.${definition.table} header
    WHERE header.bill_no=${sqlLiteral(billNo)}
  `;
}

function documentSnapshotExpression(kind, identity) {
  const definition = documentDefinitions[kind];
  const headerPredicates = [];
  if (identity?.id) headerPredicates.push(`header.id=${sqlLiteral(identity.id)}::uuid`);
  if (identity?.billNo) headerPredicates.push(`header.bill_no=${sqlLiteral(identity.billNo)}`);
  assert(headerPredicates.length > 0, `A95 ${kind} complete snapshot requires a recorded header identity`, identity);
  const headerScope = `(${headerPredicates.join(" OR ")})`;
  return `jsonb_build_object(
    'headers', COALESCE((
      SELECT jsonb_agg(to_jsonb(header) ORDER BY header.id)
      FROM public.${definition.table} header
      WHERE ${headerScope}
    ), '[]'::jsonb),
    'lines', COALESCE((
      SELECT jsonb_agg(to_jsonb(line) ORDER BY line.id)
      FROM public.${definition.lineTable} line
      WHERE line.${definition.lineForeignKey} IN (
        SELECT header.id
        FROM public.${definition.table} header
        WHERE ${headerScope}
      )
    ), '[]'::jsonb)
  )`;
}

function completeDocumentSnapshot(kind, identity) {
  return dbJson(`SELECT (${documentSnapshotExpression(kind, identity)})::text`);
}

function validateCompleteDocumentSnapshot(kind, snapshot, row, expectedStatus, expectedLineCount, label) {
  assert(snapshot?.headers?.length === 1, `A95 ${label} must have exactly one complete header snapshot`, snapshot);
  assert(snapshot?.lines?.length === expectedLineCount, `A95 ${label} complete line snapshot count mismatch`, snapshot);
  const [header] = snapshot.headers;
  assert(
    header.id === row.id
      && header.bill_no === row.billNo
      && header.status === row.status
      && (header.remark ?? "") === row.remark,
    `A95 ${label} complete header snapshot differs from the semantic document row`,
    { header, row }
  );
  assert(header.created_by === artifacts.identity.userId,
    `A95 ${label} header must be owned by the run-unique actor UUID`, header);
  if (expectedStatus) {
    assert(header.status === expectedStatus, `A95 ${label} status must be ${expectedStatus}`, header);
  }
  const semanticLines = new Map((row.lines ?? []).map((line) => [line.id, line]));
  for (const line of snapshot.lines) {
    const semanticLine = semanticLines.get(line.id);
    assert(
      semanticLine
        && Number(line.line_no) === Number(semanticLine.lineNo)
        && line.product_id === semanticLine.productId
        && line.warehouse_id === semanticLine.warehouseId,
      `A95 ${label} complete line snapshot differs from the semantic line set`,
      { line, semanticLines: row.lines }
    );
  }
  return snapshot;
}

function normalizedDocumentLines(kind, row, expectedLineCount, label) {
  assert(Array.isArray(row?.lines), `A95 ${label} must return a line array`, row);
  assert(row.lines.length === expectedLineCount, `A95 ${label} must have exactly ${expectedLineCount} line(s)`, row);
  return row.lines.map((line) => {
    assertUuid(line.id, `A95 ${label} line id`);
    assertUuid(line.productId, `A95 ${label} product id`);
    assertUuid(line.warehouseId, `A95 ${label} warehouse id`);
    assert(line.productId === artifacts.product.id, `A95 ${kind} line must reference the recorded product UUID`, line);
    assert(line.warehouseId === artifacts.warehouse.id, `A95 ${kind} line must reference the run-unique warehouse UUID`, line);
    assert(Number.isInteger(Number(line.lineNo)) && Number(line.lineNo) > 0, `A95 ${label} line number must be a positive integer`, line);
    return Object.freeze({
      id: line.id,
      lineNo: Number(line.lineNo),
      productId: line.productId,
      warehouseId: line.warehouseId
    });
  });
}

function recordDocumentVersion(kind, billNo, phase, expectedLineCount = 1, expectedStatus = undefined) {
  const row = dbJson(documentQuery(kind, billNo));
  assert(row, `A95 ${kind} document not found immediately after ${phase}`, billNo);
  assert(row?.id && row?.billNo, `A95 ${kind} record requires header UUID and bill number`, row);
  assertUuid(row.id, `A95 ${kind} ${phase} header id`);
  assert(row.billNo === billNo, `A95 ${kind} ${phase} bill number mismatch`, { expected: billNo, row });
  const definition = documentDefinitions[kind];
  assert(definition.allowedRemarks.includes(row.remark), `A95 ${kind} record has an unexpected remark`, row);
  const artifact = artifacts.documents[kind];
  if (artifact.id) assert(artifact.id === row.id, `A95 ${kind} header UUID changed`, { artifact, row });
  if (artifact.billNo) assert(artifact.billNo === row.billNo, `A95 ${kind} bill number changed`, { artifact, row });
  const currentLines = normalizedDocumentLines(kind, row, expectedLineCount, `${kind} ${phase}`);
  if (expectedStatus) assert(row.status === expectedStatus, `A95 ${kind} ${phase} status mismatch`, row);
  const completeSnapshot = validateCompleteDocumentSnapshot(
    kind,
    completeDocumentSnapshot(kind, { id: row.id, billNo: row.billNo }),
    row,
    expectedStatus,
    expectedLineCount,
    `${kind} ${phase}`
  );
  artifact.id = row.id;
  artifact.billNo = row.billNo;
  for (const line of currentLines) {
    pushUnique(artifact.lineIds, line.id);
  }
  artifact.currentLines = Object.freeze([...currentLines]);
  artifact.currentSnapshot = completeSnapshot;
  artifact.versions.push(Object.freeze({
    phase,
    headerId: row.id,
    billNo: row.billNo,
    status: row.status,
    remark: row.remark,
    lineCount: currentLines.length,
    lines: Object.freeze([...currentLines]),
    headerSnapshot: completeSnapshot.headers[0],
    lineSnapshots: completeSnapshot.lines
  }));
  return row;
}

function recordDocumentAbsence(kind, phase) {
  const artifact = artifacts.documents[kind];
  assert(artifact.id && artifact.billNo, `A95 ${kind} absence recording requires a complete artifact identity`, artifact);
  const snapshot = completeDocumentSnapshot(kind, artifact);
  assert(snapshot.headers.length === 0 && snapshot.lines.length === 0,
    `A95 ${kind} ${phase} expected the exact recorded header and lines to be absent`, snapshot);
  artifact.currentLines = Object.freeze([]);
  artifact.currentSnapshot = snapshot;
  artifact.versions.push(Object.freeze({
    phase,
    headerId: artifact.id,
    billNo: artifact.billNo,
    status: "ABSENT",
    remark: "",
    lineCount: 0,
    lines: Object.freeze([]),
    headerSnapshot: null,
    lineSnapshots: Object.freeze([])
  }));
  return snapshot;
}

function assertDocumentMatchesRecorded(kind, row, label) {
  const artifact = artifacts.documents[kind];
  const fixedVersion = artifact.versions.at(-1);
  assert(artifact.id && artifact.billNo, `A95 ${label} refused an unrecorded ${kind} header`, row);
  assert(fixedVersion, `A95 ${label} ${kind} has no fixed post-write version`, artifact);
  assert(artifact.currentSnapshot?.headers?.length === 1,
    `A95 ${label} ${kind} current complete snapshot must describe one existing header`, artifact.currentSnapshot);
  assert(row.id === artifact.id && row.billNo === artifact.billNo, `A95 ${label} ${kind} header identity changed`, { artifact, row });
  assert(
    fixedVersion.headerId === artifact.id
      && fixedVersion.billNo === artifact.billNo
      && fixedVersion.status === row.status
      && fixedVersion.remark === row.remark
      && fixedVersion.lineCount === artifact.currentLines.length,
    `A95 ${label} ${kind} differs from the fixed post-write header version`,
    { fixedVersion, artifact, row }
  );
  assert(
    fixedVersion.lines.every((fixedLine, index) => {
      const currentLine = artifact.currentLines[index];
      return currentLine
        && fixedLine.id === currentLine.id
        && fixedLine.lineNo === currentLine.lineNo
        && fixedLine.productId === currentLine.productId
        && fixedLine.warehouseId === currentLine.warehouseId;
    }),
    `A95 ${label} ${kind} currentLines differ from the immutable post-write version`,
    { fixedVersion, currentLines: artifact.currentLines }
  );
  const actualLines = normalizedDocumentLines(kind, row, artifact.currentLines.length, `${kind} ${label}`);
  const expectedById = new Map(artifact.currentLines.map((line) => [line.id, line]));
  for (const line of actualLines) {
    const expected = expectedById.get(line.id);
    assert(
      expected
        && line.lineNo === expected.lineNo
        && line.productId === expected.productId
        && line.warehouseId === expected.warehouseId,
      `A95 ${label} ${kind} line set differs from the fixed post-write version`,
      { expected: artifact.currentLines, actual: actualLines }
    );
  }
  const actualCompleteSnapshot = completeDocumentSnapshot(kind, artifact);
  assert(jsonEqual(actualCompleteSnapshot, artifact.currentSnapshot),
    `A95 ${label} ${kind} complete header/line snapshot changed`, {
      expected: artifact.currentSnapshot,
      actual: actualCompleteSnapshot
    });
  return row;
}

function recordedDocumentCandidates(kind, artifact) {
  const definition = documentDefinitions[kind];
  return dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', header.id::text,
      'billNo', header.bill_no,
      'status', header.status,
      'remark', COALESCE(header.remark, ''),
      'lines', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', line.id::text,
          'lineNo', line.line_no,
          'productId', line.product_id::text,
          'warehouseId', line.warehouse_id::text
        ) ORDER BY line.line_no, line.id)
        FROM public.${definition.lineTable} line
        WHERE line.${definition.lineForeignKey}=header.id
      ), '[]'::jsonb)
    ) ORDER BY header.id), '[]'::jsonb)::text
    FROM public.${definition.table} header
    WHERE header.id=${sqlLiteral(artifact.id)}::uuid
       OR header.bill_no=${sqlLiteral(artifact.billNo)}
  `) ?? [];
}

function assertRecordedDocumentBeforeMutation(kind, action) {
  const artifact = artifacts.documents[kind];
  assert(artifact.id && artifact.billNo && artifact.currentLines.length > 0,
    `A95 ${action} requires a fully recorded ${kind} artifact`, artifact);
  const candidates = recordedDocumentCandidates(kind, artifact);
  assert(candidates.length === 1,
    `A95 ${action} refused missing, replaced, or ambiguous ${kind} header UUID/bill number`,
    { artifact, candidates });
  return assertDocumentMatchesRecorded(kind, candidates[0], `before ${action}`);
}

function inventoryRowsAtWarehouse() {
  if (!artifacts.warehouse.id) return [];
  return dbJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(txn_row) ORDER BY txn_row."occurredAt", txn_row.id), '[]'::jsonb)::text
    FROM (
      SELECT txn.id::text AS id,
             txn.account_set_id::text AS "accountSetId",
             txn.txn_type AS "txnType",
             txn.product_id::text AS "productId",
             txn.warehouse_id::text AS "warehouseId",
             txn.qty_delta::text AS "qtyDelta",
             txn.source_bill_type AS "sourceBillType",
             txn.source_bill_id::text AS "sourceBillId",
             txn.source_bill_line_id::text AS "sourceBillLineId",
             txn.source_bill_no AS "sourceBillNo",
             txn.source_bill_date::text AS "sourceBillDate",
             txn.posting_action AS "postingAction",
             txn.qty_on_hand_after::text AS "qtyOnHandAfter",
             txn.trace_quality AS "traceQuality",
             txn.reversal_of_txn_id::text AS "reversalOfTxnId",
             txn.occurred_at::text AS "occurredAt"
      FROM public.inv_stock_txn txn
      WHERE txn.warehouse_id=${sqlLiteral(artifacts.warehouse.id)}::uuid
    ) txn_row
  `) ?? [];
}

function inventoryRowsForSource(sourceBillType, sourceBillId) {
  return inventoryRowsAtWarehouse().filter((row) =>
    row.sourceBillType === sourceBillType && row.sourceBillId === sourceBillId
  );
}

function fullTransactionSnapshots(transactionIds) {
  const ids = unique(transactionIds);
  return dbJson(`
    SELECT COALESCE(jsonb_object_agg(txn.id::text, to_jsonb(txn) ORDER BY txn.id), '{}'::jsonb)::text
    FROM public.inv_stock_txn txn
    WHERE txn.id IN (${uuidIn(ids)})
  `) ?? {};
}

function recordTransactionSnapshots(transactionIds, label) {
  const ids = unique(transactionIds);
  for (const txnId of ids) assertUuid(txnId, `A95 ${label} transaction id`);
  const snapshots = fullTransactionSnapshots(ids);
  assert(Object.keys(snapshots).length === ids.length && ids.every((txnId) => snapshots[txnId]),
    `A95 ${label} must capture one complete to_jsonb snapshot per transaction UUID`, { ids, snapshots });
  for (const txnId of ids) {
    const existing = artifacts.txnSnapshots[txnId];
    assert(!existing || jsonEqual(existing, snapshots[txnId]),
      `A95 ${label} refused to overwrite a changed transaction snapshot`, { txnId, existing, actual: snapshots[txnId] });
    artifacts.txnSnapshots[txnId] = snapshots[txnId];
  }
  return snapshots;
}

function assertStoredTransactionSnapshots(transactionIds, label) {
  const ids = unique(transactionIds);
  const actual = fullTransactionSnapshots(ids);
  const expected = Object.fromEntries(ids.map((txnId) => [txnId, artifacts.txnSnapshots[txnId]]));
  assert(ids.every((txnId) => expected[txnId]) && jsonEqual(actual, expected),
    `A95 ${label} transaction snapshots differ from the recorded complete rows`, { ids, expected, actual });
  return actual;
}

function recordExpectedLineReplacementSnapshots(transactionIds, label) {
  const ids = unique(transactionIds);
  const actual = fullTransactionSnapshots(ids);
  for (const txnId of ids) {
    const previous = artifacts.txnSnapshots[txnId];
    assert(previous, `A95 ${label} requires a previously recorded transaction snapshot`, txnId);
    const expected = { ...previous, source_bill_line_id: null, trace_quality: "HEADER_ONLY" };
    assert(actual[txnId] && jsonEqual(actual[txnId], expected),
      `A95 ${label} transaction changed outside the two permitted trace fields`,
      { txnId, previous, expected, actual: actual[txnId] });
    artifacts.txnSnapshots[txnId] = actual[txnId];
  }
  return actual;
}

function recordTransactionPair(pair, label) {
  assertUuid(pair.forward.id, `A95 ${label} forward transaction id`);
  assertUuid(pair.reverse.id, `A95 ${label} reverse transaction id`);
  assert(!artifacts.txnPairs.some((entry) => entry.forwardId === pair.forward.id || entry.reverseId === pair.reverse.id),
    `A95 ${label} transaction pair UUIDs were already recorded`, { pair, pairs: artifacts.txnPairs });
  artifacts.txnPairs.push(Object.freeze({
    label,
    forwardId: pair.forward.id,
    reverseId: pair.reverse.id,
    sourceBillType: pair.forward.sourceBillType,
    sourceBillId: pair.forward.sourceBillId,
    forwardTxnType: pair.forward.txnType,
    reverseTxnType: pair.reverse.txnType,
    forwardAction: pair.forward.postingAction,
    reverseAction: pair.reverse.postingAction
  }));
}

function receivableBillNo(direction) {
  const outNo = artifacts.documents.out.billNo;
  assert(outNo, "A95 receivable ownership requires the recorded sales-out bill number");
  return direction === "forward" ? `YS-${outNo}` : `YS-CX-${outNo}`;
}

function completeReceivableRows() {
  const outNo = artifacts.documents.out.billNo;
  const recordedIds = Object.keys(artifacts.receivableSnapshots);
  const recordedBillNos = Object.values(artifacts.receivableSnapshots).map((row) => row.bill_no);
  if (!outNo && recordedIds.length === 0) return [];
  return dbJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(receivable) ORDER BY receivable.id), '[]'::jsonb)::text
    FROM public.ar_receivable receivable
    WHERE ${outNo ? `receivable.source_bill_no=${sqlLiteral(outNo)}` : "FALSE"}
       OR receivable.id IN (${uuidIn(recordedIds)})
       OR receivable.bill_no IN (${textIn(recordedBillNos)})
  `) ?? [];
}

function validateOwnedReceivable(row, direction, label) {
  const outHeader = artifacts.documents.out.currentSnapshot?.headers?.[0];
  assert(outHeader, `A95 ${label} requires the complete current sales-out header snapshot`);
  const expectedBillNo = receivableBillNo(direction);
  const expectedAmount = Number(outHeader.total_amount) * (direction === "forward" ? 1 : -1);
  assertUuid(row.id, `A95 ${label} receivable id`);
  assert(
    row.bill_no === expectedBillNo
      && row.source_bill_no === artifacts.documents.out.billNo
      && row.customer_id === outHeader.customer_id
      && row.bill_date === outHeader.bill_date
      && row.currency === outHeader.currency
      && Number(row.amount) === expectedAmount
      && Number(row.received_amount) === 0
      && Number(row.return_offset_amount) === 0
      && row.status === "OPEN",
    `A95 ${label} refused an unowned, settled, offset, or semantically changed receivable`,
    { direction, expectedBillNo, expectedAmount, outHeader, row }
  );
  return row;
}

function assertReceivableScope(label) {
  const actualRows = completeReceivableRows();
  const actual = Object.fromEntries(actualRows.map((row) => [row.id, row]));
  const expected = artifacts.receivableSnapshots;
  assert(
    actualRows.length === Object.keys(actual).length
      && jsonEqual(actual, expected),
    `A95 ${label} receivable UUID set or complete snapshots differ from the recorded owned set`,
    { expected, actual }
  );
  for (const row of actualRows) {
    const direction = row.bill_no === receivableBillNo("forward") ? "forward"
      : row.bill_no === receivableBillNo("reverse") ? "reverse"
        : "unknown";
    assert(direction !== "unknown", `A95 ${label} refused an unexpected receivable bill number`, row);
    validateOwnedReceivable(row, direction, label);
  }
  return actualRows;
}

function recordReceivableSnapshot(direction, label) {
  const expectedBillNo = receivableBillNo(direction);
  const existing = Object.values(artifacts.receivableSnapshots).find((row) => row.bill_no === expectedBillNo);
  const rows = dbJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(receivable) ORDER BY receivable.id), '[]'::jsonb)::text
    FROM public.ar_receivable receivable
    WHERE receivable.bill_no=${sqlLiteral(expectedBillNo)}
       ${existing ? `OR receivable.id=${sqlLiteral(existing.id)}::uuid` : ""}
  `) ?? [];
  assert(rows.length === 1, `A95 ${label} must resolve exactly one receivable by expected bill number/recorded UUID`, {
    expectedBillNo,
    existing,
    rows
  });
  const [row] = rows;
  if (existing) assert(row.id === existing.id, `A95 ${label} receivable UUID changed`, { existing, row });
  validateOwnedReceivable(row, direction, label);
  artifacts.receivableSnapshots[row.id] = row;
  pushUnique(artifacts.receivableIds, row.id);
  assertReceivableScope(label);
  return row;
}

function assertCanonicalRow(row, expected, label) {
  assert(row, `${label} inventory trace is missing`, expected);
  const actual = {
    accountSetId: row.accountSetId,
    productId: row.productId,
    warehouseId: row.warehouseId,
    sourceBillType: row.sourceBillType,
    sourceBillId: row.sourceBillId,
    sourceBillLineId: row.sourceBillLineId,
    sourceBillNo: row.sourceBillNo,
    sourceBillDate: row.sourceBillDate,
    postingAction: row.postingAction,
    txnType: row.txnType,
    traceQuality: row.traceQuality
  };
  const completeExpected = {
    accountSetId: artifacts.accountSet.id,
    productId: artifacts.product.id,
    warehouseId: artifacts.warehouse.id,
    sourceBillDate: billDate,
    traceQuality: "EXACT",
    ...expected
  };
  assert(
    Object.entries(completeExpected).every(([key, value]) => actual[key] === value),
    `${label} inventory trace does not preserve canonical account/source/header/line/date/action identity`,
    { expected: completeExpected, actual, row }
  );
}

function assertCanonicalPair({ sourceBillType, sourceBillId, sourceBillLineId, sourceBillNo, forwardTxnType, reverseTxnType, forwardAction, reverseAction, label }) {
  const rows = inventoryRowsForSource(sourceBillType, sourceBillId);
  const lineRows = rows.filter((row) => row.sourceBillLineId === sourceBillLineId);
  const forwardRows = lineRows.filter((row) =>
    row.txnType === forwardTxnType
      && row.postingAction === forwardAction
      && row.traceQuality === "EXACT"
  );
  const reverseRows = lineRows.filter((row) =>
    row.txnType === reverseTxnType
      && row.postingAction === reverseAction
      && row.traceQuality === "EXACT"
  );
  assert(
    lineRows.length === 2 && forwardRows.length === 1 && reverseRows.length === 1,
    `${label} must contain exactly one forward and one reverse transaction for the recorded source/header/line`,
    { sourceBillType, sourceBillId, sourceBillLineId, lineRows }
  );
  const [forward] = forwardRows;
  const [reverse] = reverseRows;
  const expectedBase = { sourceBillType, sourceBillId, sourceBillLineId, sourceBillNo };
  assertCanonicalRow(forward, { ...expectedBase, txnType: forwardTxnType, postingAction: forwardAction }, `${label} forward`);
  assertCanonicalRow(reverse, { ...expectedBase, txnType: reverseTxnType, postingAction: reverseAction }, `${label} reverse`);
  assert(reverse.reversalOfTxnId === forward.id, `${label} reverse must point to the exact forward transaction UUID`, { forward, reverse });
  return { forward, reverse };
}

function captureSeedTrace() {
  const warehouseRows = inventoryRowsAtWarehouse();
  const rows = warehouseRows.filter((row) =>
    row.txnType === seedTxnType && row.sourceBillType === seedSourceBillType
  );
  assert(warehouseRows.length === 1 && rows.length === 1, "A95 minimum seed must be the only transaction in the run warehouse", warehouseRows);
  const [seed] = rows;
  assert(seed.accountSetId === artifacts.accountSet.id, "A95 seed account-set UUID mismatch", seed);
  assert(seed.productId === artifacts.product.id && seed.warehouseId === artifacts.warehouse.id, "A95 seed product/warehouse UUID mismatch", seed);
  assert(seed.sourceBillNo === seedSourceBillType && seed.sourceBillDate, "A95 seed source number/date must be recorded", seed);
  assert(seed.postingAction === "AUDIT" && seed.traceQuality === "TEST", "A95 seed must stay an explicit TEST adjustment", seed);
  artifacts.seed.sourceHeaderId = seed.sourceBillId;
  artifacts.seed.sourceLineId = seed.sourceBillLineId;
  pushUnique(artifacts.seed.txnIds, seed.id);
  pushUnique(artifacts.txnIds, seed.id);
  recordTransactionSnapshots([seed.id], "seed");
  return seed;
}

async function createUniqueWarehouseAndSeed() {
  assert(
    dbNumber(`SELECT count(*) FROM public.md_warehouse WHERE code=${sqlLiteral(warehouseCode)}`) === 0,
    "A95 run-unique warehouse code must not pre-exist"
  );
  const created = await requireApi("/api/master-data/warehouse", {
    method: "POST",
    expected: [201],
    body: {
      code: warehouseCode,
      name: warehouseName,
      warehouseType: "普通仓",
      stockPolicy: "不允许负库存",
      status: "启用",
      remark: fixturePrefix
    }
  });
  assertUuid(created?.id, "A95 warehouse POST response id");
  artifacts.warehouse.id = created.id;
  await requireApi(`/api/master-data/warehouse/${encodeURIComponent(warehouseCode)}/audit`, { method: "POST" });
  const warehouseRows = dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', id::text,
      'code', code,
      'name', name,
      'remark', COALESCE(remark, ''),
      'auditStatus', audit_status,
      'enabled', enabled
    ) ORDER BY id), '[]'::jsonb)::text
    FROM public.md_warehouse
    WHERE id=${sqlLiteral(artifacts.warehouse.id)}::uuid
       OR code=${sqlLiteral(warehouseCode)}
  `) ?? [];
  assert(warehouseRows.length === 1, "A95 warehouse API UUID/code identity must resolve exactly once", warehouseRows);
  const [warehouse] = warehouseRows;
  assert(warehouse?.id === created?.id, "A95 warehouse API/DB UUID mismatch", { created, warehouse });
  assert(warehouse.code === warehouseCode && warehouse.name === warehouseName, "A95 warehouse API/DB identity fields mismatch", warehouse);
  assert(warehouse.auditStatus === "AUDITED" && warehouse.enabled === true && warehouse.remark === fixturePrefix, "A95 run-unique warehouse must be audited, enabled, and tagged", warehouse);

  const adjustment = await requireApi("/api/inventory/adjustments", {
    method: "POST",
    expected: [201],
    body: {
      productCode,
      warehouseCode,
      qtyDelta: qty,
      txnType: seedTxnType,
      sourceBillType: seedSourceBillType
    }
  });
  const seedTrace = captureSeedTrace();
  const balance = dbJson(`
    SELECT jsonb_build_object(
      'id', balance.id::text,
      'accountSetId', balance.account_set_id::text,
      'productId', balance.product_id::text,
      'warehouseId', balance.warehouse_id::text,
      'onHand', balance.qty_on_hand::text,
      'available', balance.qty_available::text,
      'reserved', balance.qty_reserved::text
    )::text
    FROM public.inv_stock_balance balance
    WHERE balance.account_set_id=${sqlLiteral(artifacts.accountSet.id)}::uuid
      AND balance.product_id=${sqlLiteral(artifacts.product.id)}::uuid
      AND balance.warehouse_id=${sqlLiteral(artifacts.warehouse.id)}::uuid
  `);
  assert(balance && Number(balance.onHand) === qty && Number(balance.available) === qty && Number(balance.reserved) === 0, "A95 seed must be the minimum quantity required by the flow", balance);
  pushUnique(artifacts.balanceIds, balance.id);
  return { warehouse, adjustment, seedTrace, balance };
}

function salesLine(lineRemark, source = {}) {
  return {
    productCode,
    warehouseCode,
    qty,
    unitPrice: 86,
    taxRate: 13,
    lineRemark,
    ...source
  };
}

function orderPayload(billNo, remark) {
  return {
    ...(billNo ? { billNo } : {}),
    customerCode: "KH-001",
    billDate,
    department: "销售部",
    ownerName: "本地管理员",
    remark,
    lines: [salesLine(remark)]
  };
}

function noticePayload(orderNo) {
  return {
    sourceOrderNo: orderNo,
    customerCode: "KH-001",
    billDate,
    department: "销售部",
    ownerName: "本地管理员",
    remark: `${fixturePrefix}-notice`,
    lines: [salesLine(`${fixturePrefix}-notice-line`, { sourceOrderNo: orderNo, sourceLineNo: 1 })]
  };
}

function outPayload(noticeNo, billNo = "") {
  return {
    ...(billNo ? { billNo } : {}),
    sourceOrderNo: noticeNo,
    customerCode: "KH-001",
    billDate,
    department: "销售部",
    ownerName: "本地管理员",
    remark: billNo ? `${fixturePrefix}-out-edited` : `${fixturePrefix}-out-initial`,
    lines: [salesLine(
      billNo ? `${fixturePrefix}-out-edited-line` : `${fixturePrefix}-out-initial-line`,
      {
        sourceOrderNo: noticeNo,
        sourceLineNo: 1,
        sourceDeliveryNoticeNo: noticeNo,
        sourceDeliveryLineNo: 1
      }
    )]
  };
}

async function verifyReverseBackToEditableDraft() {
  const orderDraft = await requireApi("/api/sales-orders/draft", {
    method: "POST",
    expected: [201],
    body: orderPayload("", `${fixturePrefix}-order-initial`)
  });
  const orderNo = generatedBillNo(orderDraft, "A95 sales order");
  const initialOrder = recordDocumentVersion("order", orderNo, "create", 1, "DRAFT");
  const auditedOrder = await requireApi(`/api/sales-orders/${encodeURIComponent(orderNo)}/audit`, { method: "POST" });
  recordDocumentVersion("order", orderNo, "audit", 1, "AUDITED");
  const reversedOrder = await requireApi(`/api/sales-orders/${encodeURIComponent(orderNo)}/reverse`, { method: "POST" });
  recordDocumentVersion("order", orderNo, "reverse", 1, "DRAFT");
  const orderAfterReverse = await requireApi(`/api/sales-orders/${encodeURIComponent(orderNo)}`, { method: "GET" });
  assert(auditedOrder.status === "AUDITED" && reversedOrder.status === "DRAFT", "A95 sales order audit/reverse statuses mismatch", { auditedOrder, reversedOrder });
  assert(orderAfterReverse.order.status === "DRAFT", "A95 reversed sales order must be an editable draft", orderAfterReverse);

  await requireApi("/api/sales-orders/draft", {
    method: "POST",
    expected: [201],
    body: orderPayload(orderNo, `${fixturePrefix}-order-edited`)
  });
  const editedOrder = recordDocumentVersion("order", orderNo, "update-after-reverse", 1, "DRAFT");
  assert(editedOrder.remark === `${fixturePrefix}-order-edited`, "A95 edited sales order remark must persist", editedOrder);
  const reauditedOrder = await requireApi(`/api/sales-orders/${encodeURIComponent(orderNo)}/audit`, { method: "POST" });
  recordDocumentVersion("order", orderNo, "re-audit", 1, "AUDITED");
  assert(reauditedOrder.status === "AUDITED", "A95 edited sales order must re-audit", reauditedOrder);

  const noticeDraft = await requireApi("/api/delivery-notices/draft", {
    method: "POST",
    expected: [201],
    body: noticePayload(orderNo)
  });
  const noticeNo = generatedBillNo(noticeDraft, "A95 delivery notice");
  const notice = recordDocumentVersion("notice", noticeNo, "create", 1, "DRAFT");
  await requireApi(`/api/delivery-notices/${encodeURIComponent(noticeNo)}/audit`, { method: "POST" });
  recordDocumentVersion("notice", noticeNo, "audit", 1, "AUDITED");
  const noticeRows = inventoryRowsForSource("DELIVERY_NOTICE", notice.id);
  const noticeLineRows = noticeRows.filter((row) => row.sourceBillLineId === notice.lines[0].id);
  assert(noticeLineRows.length === 1, "A95 delivery notice audit must create exactly one transaction for the recorded line", noticeLineRows);
  const [noticeReserve] = noticeLineRows;
  assertCanonicalRow(noticeReserve, {
    sourceBillType: "DELIVERY_NOTICE",
    sourceBillId: notice.id,
    sourceBillLineId: notice.lines[0].id,
    sourceBillNo: noticeNo,
    txnType: "DELIVERY_NOTICE_RESERVE",
    postingAction: "RESERVE"
  }, "A95 delivery notice reserve");
  assert(noticeReserve.reversalOfTxnId === null, "A95 forward reservation must not point to a reversal", noticeReserve);
  pushUnique(artifacts.txnIds, noticeReserve.id);
  recordTransactionSnapshots([noticeReserve.id], "delivery notice reserve");

  const outDraft = await requireApi("/api/sales-outs/draft", {
    method: "POST",
    expected: [201],
    body: outPayload(noticeNo)
  });
  const outNo = generatedBillNo(outDraft, "A95 sales out");
  const initialOut = recordDocumentVersion("out", outNo, "create", 1, "DRAFT");
  const initialLineId = initialOut.lines[0].id;
  const auditedOut = await requireApi(`/api/sales-outs/${encodeURIComponent(outNo)}/audit`, { method: "POST" });
  recordDocumentVersion("out", outNo, "audit", 1, "AUDITED");
  recordDocumentVersion("order", orderNo, "source-progress-after-initial-out-audit", 1, "AUDITED");
  recordReceivableSnapshot("forward", "initial sales-out audit");
  const reversedOut = await requireApi(`/api/sales-outs/${encodeURIComponent(outNo)}/reverse`, { method: "POST" });
  recordDocumentVersion("out", outNo, "reverse", 1, "DRAFT");
  recordDocumentVersion("order", orderNo, "source-progress-after-initial-out-reverse", 1, "AUDITED");
  recordReceivableSnapshot("reverse", "initial sales-out reverse");
  const initialPair = assertCanonicalPair({
    sourceBillType: "SALES_OUT",
    sourceBillId: initialOut.id,
    sourceBillLineId: initialLineId,
    sourceBillNo: outNo,
    forwardTxnType: "SALES_OUT",
    reverseTxnType: "SALES_OUT_REVERSE",
    forwardAction: "AUDIT",
    reverseAction: "REVERSE",
    label: "A95 first sales-out lifecycle"
  });
  pushUnique(artifacts.txnIds, initialPair.forward.id, initialPair.reverse.id);
  recordTransactionPair(initialPair, "initial sales-out lifecycle");
  recordTransactionSnapshots([initialPair.forward.id, initialPair.reverse.id], "initial sales-out pair");
  assert(auditedOut.status === "AUDITED" && reversedOut.status === "DRAFT", "A95 sales out audit/reverse statuses mismatch", { auditedOut, reversedOut });

  const outAfterReverse = await requireApi(`/api/sales-outs/${encodeURIComponent(outNo)}`, { method: "GET" });
  assert(outAfterReverse.document.status === "DRAFT", "A95 reversed sales out must be an editable draft", outAfterReverse);
  await requireApi("/api/sales-outs/draft", {
    method: "POST",
    expected: [201],
    body: outPayload(noticeNo, outNo)
  });
  const editedOut = recordDocumentVersion("out", outNo, "update-after-reverse", 1, "DRAFT");
  const editedLineId = editedOut.lines[0].id;
  assert(editedLineId !== initialLineId, "A95 re-save must replace the sales-out line UUID", { initialLineId, editedLineId });
  assert(editedOut.remark === `${fixturePrefix}-out-edited`, "A95 edited sales out remark must persist", editedOut);

  const downgradedRows = inventoryRowsForSource("SALES_OUT", editedOut.id).filter((row) =>
    [initialPair.forward.id, initialPair.reverse.id].includes(row.id)
  );
  assert(
    downgradedRows.length === 2
      && downgradedRows.every((row) => row.traceQuality === "HEADER_ONLY" && row.sourceBillLineId === null),
    "A95 replaced lines must preserve immutable history as HEADER_ONLY without retargeting",
    downgradedRows
  );
  recordExpectedLineReplacementSnapshots(
    [initialPair.forward.id, initialPair.reverse.id],
    "line-replacement downgraded sales-out pair"
  );

  const reauditedOut = await requireApi(`/api/sales-outs/${encodeURIComponent(outNo)}/audit`, { method: "POST" });
  recordDocumentVersion("out", outNo, "re-audit", 1, "AUDITED");
  recordDocumentVersion("order", orderNo, "source-progress-after-out-re-audit", 1, "AUDITED");
  recordReceivableSnapshot("forward", "re-audited sales-out");
  assert(reauditedOut.status === "AUDITED", "A95 edited sales out must re-audit", reauditedOut);
  const reauditedRows = inventoryRowsForSource("SALES_OUT", editedOut.id);
  const reauditedLineRows = reauditedRows.filter((row) => row.sourceBillLineId === editedLineId);
  assert(reauditedLineRows.length === 1, "A95 re-audit must create exactly one transaction for the fixed edited line", reauditedLineRows);
  const [reauditedTrace] = reauditedLineRows;
  assertCanonicalRow(reauditedTrace, {
    sourceBillType: "SALES_OUT",
    sourceBillId: editedOut.id,
    sourceBillLineId: editedLineId,
    sourceBillNo: outNo,
    txnType: "SALES_OUT",
    postingAction: "AUDIT"
  }, "A95 re-audited sales out");
  assert(reauditedTrace.reversalOfTxnId === null, "A95 re-audit forward trace must not point to a reversal", reauditedTrace);
  pushUnique(artifacts.txnIds, reauditedTrace.id);
  recordTransactionSnapshots([reauditedTrace.id], "re-audited sales-out forward");

  return {
    order: {
      headerId: initialOrder.id,
      lineIds: artifacts.documents.order.lineIds,
      billNo: orderNo,
      statuses: ["AUDITED", reversedOrder.status, editedOrder.status, reauditedOrder.status]
    },
    notice: {
      headerId: notice.id,
      lineIds: artifacts.documents.notice.lineIds,
      billNo: noticeNo,
      reserveTxnId: noticeReserve.id
    },
    out: {
      headerId: initialOut.id,
      lineIds: artifacts.documents.out.lineIds,
      billNo: outNo,
      statuses: ["AUDITED", reversedOut.status, editedOut.status, reauditedOut.status],
      firstPair: { forwardTxnId: initialPair.forward.id, reverseTxnId: initialPair.reverse.id },
      reauditedTxnId: reauditedTrace.id
    }
  };
}

async function verifyWorkbenchBlankNumbering() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const screenshots = [];
  try {
    await page.goto(frontendUrl, { waitUntil: "networkidle" });
    await loginAsAdmin(page, runPassword, "BLD-TEST", runUsername);

    await page.locator(".quick-entry", { hasText: "销售订单" }).first().click();
    await page.getByTestId("tab-sales-order-form").waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const input = document.querySelector('[data-testid="sales-bill-no"]');
      return input instanceof HTMLInputElement && input.value === "";
    });
    const salesOrderBillNo = await page.getByTestId("sales-bill-no").inputValue();
    const salesOrderShot = `a95-workbench-sales-order-numbering-${batch}-${runToken}.png`;
    await page.screenshot({ path: path.join(screenshotDir, salesOrderShot), fullPage: true });
    screenshots.push(`verification/playwright/${salesOrderShot}`);

    await page.getByTestId("tab-home").click();
    await page.locator(".quick-entry", { hasText: "销售出库单" }).first().click();
    await page.getByTestId("tab-sales-out-form").waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const input = document.querySelector('[data-testid="sales-out-bill-no"]');
      return input instanceof HTMLInputElement && input.value === "";
    });
    const salesOutBillNo = await page.getByTestId("sales-out-bill-no").inputValue();
    const salesOutShot = `a95-workbench-sales-out-numbering-${batch}-${runToken}.png`;
    await page.screenshot({ path: path.join(screenshotDir, salesOutShot), fullPage: true });
    screenshots.push(`verification/playwright/${salesOutShot}`);

    return { salesOrderBillNo, salesOutBillNo, screenshots };
  } finally {
    await browser.close();
  }
}

function rowsForWarehouse(kind) {
  if (!artifacts.warehouse.id) return [];
  const definition = documentDefinitions[kind];
  return dbJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(document_row) ORDER BY document_row."billNo"), '[]'::jsonb)::text
    FROM (
      SELECT header.id::text AS id,
             header.bill_no AS "billNo",
             header.status,
             COALESCE(header.remark, '') AS remark,
             jsonb_agg(jsonb_build_object(
               'id', line.id::text,
               'lineNo', line.line_no,
               'productId', line.product_id::text,
               'warehouseId', line.warehouse_id::text
             ) ORDER BY line.line_no) AS lines
      FROM public.${definition.table} header
      JOIN public.${definition.lineTable} line ON line.${definition.lineForeignKey}=header.id
      WHERE EXISTS (
        SELECT 1
        FROM public.${definition.lineTable} scoped_line
        WHERE scoped_line.${definition.lineForeignKey}=header.id
          AND scoped_line.warehouse_id=${sqlLiteral(artifacts.warehouse.id)}::uuid
      )
      GROUP BY header.id, header.bill_no, header.status, header.remark
    ) document_row
  `) ?? [];
}

function ownedHeaderLineState(kind, artifact) {
  if (!artifact.id) return { header: null, lines: [] };
  const definition = documentDefinitions[kind];
  return dbJson(`
    SELECT jsonb_build_object(
      'header', (
        SELECT jsonb_build_object(
          'id', header.id::text,
          'billNo', header.bill_no,
          'remark', COALESCE(header.remark, '')
        )
        FROM public.${definition.table} header
        WHERE header.id=${sqlLiteral(artifact.id)}::uuid
      ),
      'lines', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', line.id::text,
          'lineNo', line.line_no,
          'productId', line.product_id::text,
          'warehouseId', line.warehouse_id::text
        ) ORDER BY line.line_no, line.id)
        FROM public.${definition.lineTable} line
        WHERE line.${definition.lineForeignKey}=${sqlLiteral(artifact.id)}::uuid
      ), '[]'::jsonb)
    )::text
  `);
}

function assertOwnedHeaderLineSets() {
  const evidence = {};
  for (const [kind, artifact] of Object.entries(artifacts.documents)) {
    const state = ownedHeaderLineState(kind, artifact);
    evidence[kind] = state;
    if (!state.header) {
      assert(state.lines.length === 0, `A95 ${kind} absent header must not retain lines`, state);
      continue;
    }
    assert(state.header.billNo === artifact.billNo, `A95 ${kind} header bill number changed before cleanup`, { artifact, state });
    assert(documentDefinitions[kind].allowedRemarks.includes(state.header.remark), `A95 ${kind} header remark left the owned fixture scope`, state);
    const expectedById = new Map(artifact.currentLines.map((line) => [line.id, line]));
    assert(state.lines.length === expectedById.size, `A95 ${kind} header has an unrecorded or missing line before cleanup`, {
      expected: artifact.currentLines,
      actual: state.lines
    });
    for (const line of state.lines) {
      const expected = expectedById.get(line.id);
      assert(
        expected
          && Number(line.lineNo) === expected.lineNo
          && line.productId === expected.productId
          && line.warehouseId === expected.warehouseId
          && line.productId === artifacts.product.id
          && line.warehouseId === artifacts.warehouse.id,
        `A95 ${kind} header line set is not exactly the recorded UUID/product/warehouse set`,
        { expected: artifact.currentLines, actual: state.lines, line }
      );
    }
  }
  return evidence;
}

function lockedDocumentLineGuardSql(kind, artifact) {
  if (!artifact.id) return "";
  const fixedVersion = artifact.versions.at(-1);
  assert(fixedVersion?.headerId === artifact.id && fixedVersion.billNo === artifact.billNo,
    `A95 ${kind} locked cleanup requires the fixed header version`, artifact);
  assert(artifact.currentSnapshot, `A95 ${kind} locked cleanup requires a complete current snapshot`, artifact);
  return `
    IF (${documentSnapshotExpression(kind, artifact)})
         IS DISTINCT FROM ${sqlLiteral(JSON.stringify(artifact.currentSnapshot))}::jsonb THEN
      RAISE EXCEPTION 'A95 cleanup refused: ${kind} complete header/line snapshot differs from the last proven lifecycle version';
    END IF;
  `;
}

function captureRunScope() {
  const warehouseRows = dbJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(warehouse) ORDER BY warehouse.id), '[]'::jsonb)::text
    FROM public.md_warehouse warehouse
    WHERE ${artifacts.warehouse.id ? `warehouse.id=${sqlLiteral(artifacts.warehouse.id)}::uuid OR ` : ""}warehouse.code=${sqlLiteral(warehouseCode)}
  `) ?? [];
  if (!artifacts.warehouse.id) {
    assert(warehouseRows.length === 0, "A95 cleanup refused to adopt a warehouse without the POST response UUID", warehouseRows);
    return { warehouse: null, transactions: [], balances: [], receivables: [], logs: [] };
  }
  assert(warehouseRows.length <= 1, "A95 cleanup refused ambiguous warehouse UUID/code matches", warehouseRows);
  if (warehouseRows.length === 0) return { warehouse: null, transactions: [], balances: [], receivables: [], logs: [] };
  const [warehouse] = warehouseRows;
  assert(
    artifacts.warehouse.id === warehouse.id
      && warehouse.code === warehouseCode
      && (warehouse.remark ?? "") === fixturePrefix
      && warehouse.name === warehouseName,
    "A95 cleanup refused because the trusted warehouse identity fields changed",
    { artifact: artifacts.warehouse, warehouse }
  );
  artifacts.warehouse.snapshot = warehouse;

  for (const kind of Object.keys(documentDefinitions)) {
    const artifact = artifacts.documents[kind];
    const rows = rowsForWarehouse(kind);
    assert(rows.length <= 1, `A95 cleanup refused because unique warehouse has multiple ${kind} headers`, rows);
    if (rows.length === 1) assertDocumentMatchesRecorded(kind, rows[0], "cleanup capture");
    if (artifact.id) {
      const actualCompleteSnapshot = completeDocumentSnapshot(kind, artifact);
      assert(jsonEqual(actualCompleteSnapshot, artifact.currentSnapshot),
        `A95 cleanup refused because the ${kind} complete header/line snapshot changed`, {
          expected: artifact.currentSnapshot,
          actual: actualCompleteSnapshot
        });
    }
  }

  const transactions = inventoryRowsAtWarehouse();
  const actualTxnIds = unique(transactions.map((row) => row.id));
  const expectedTxnIds = unique(artifacts.txnIds);
  for (const txnId of [...actualTxnIds, ...expectedTxnIds]) assertUuid(txnId, "A95 cleanup transaction id");
  assert(
    actualTxnIds.length === transactions.length
      && actualTxnIds.length === expectedTxnIds.length
      && actualTxnIds.every((txnId) => expectedTxnIds.includes(txnId)),
    "A95 cleanup refused because the warehouse transaction UUID set differs from the scenario-recorded set",
    { expectedTxnIds, actualTxnIds, transactions }
  );
  const recordedSnapshotIds = Object.keys(artifacts.txnSnapshots);
  assert(
    recordedSnapshotIds.length === expectedTxnIds.length
      && expectedTxnIds.every((txnId) => recordedSnapshotIds.includes(txnId)),
    "A95 cleanup refused because recorded transaction UUIDs lack an exact complete-row snapshot set",
    { expectedTxnIds, recordedSnapshotIds }
  );
  assertStoredTransactionSnapshots(expectedTxnIds, "cleanup capture");
  for (const pair of artifacts.txnPairs) {
    const forward = transactions.find((row) => row.id === pair.forwardId);
    const reverse = transactions.find((row) => row.id === pair.reverseId);
    assert(
      forward
        && reverse
        && reverse.reversalOfTxnId === forward.id
        && forward.sourceBillType === pair.sourceBillType
        && reverse.sourceBillType === pair.sourceBillType
        && forward.sourceBillId === pair.sourceBillId
        && reverse.sourceBillId === pair.sourceBillId
        && forward.txnType === pair.forwardTxnType
        && reverse.txnType === pair.reverseTxnType
        && forward.postingAction === pair.forwardAction
        && reverse.postingAction === pair.reverseAction,
      "A95 cleanup refused because a recorded forward/reverse pair changed",
      { pair, forward, reverse }
    );
  }
  for (const row of transactions) {
    assert(row.accountSetId === artifacts.accountSet.id, "A95 cleanup refused: foreign account-set inventory transaction in unique warehouse", row);
    assert(row.productId === artifacts.product.id, "A95 cleanup refused: foreign product inventory transaction in unique warehouse", row);
    const seedOwned = row.sourceBillType === seedSourceBillType
      && row.txnType === seedTxnType
      && row.traceQuality === "TEST";
    const noticeOwned = row.sourceBillType === "DELIVERY_NOTICE"
      && row.sourceBillId === artifacts.documents.notice.id
      && row.sourceBillNo === artifacts.documents.notice.billNo
      && ["DELIVERY_NOTICE_RESERVE", "DELIVERY_NOTICE_RESERVE_REVERSE"].includes(row.txnType);
    const outOwned = row.sourceBillType === "SALES_OUT"
      && row.sourceBillId === artifacts.documents.out.id
      && row.sourceBillNo === artifacts.documents.out.billNo
      && ["SALES_OUT", "SALES_OUT_REVERSE"].includes(row.txnType);
    assert(seedOwned || noticeOwned || outOwned, "A95 cleanup refused: transaction is outside the recorded run scope", row);
    if (seedOwned) {
      assert(artifacts.seed.sourceHeaderId === row.sourceBillId && artifacts.seed.sourceLineId === row.sourceBillLineId, "A95 cleanup refused: seed source UUID changed", row);
      assert(artifacts.seed.txnIds.length === 1 && artifacts.seed.txnIds[0] === row.id,
        "A95 cleanup refused: seed transaction UUID is not the scenario-recorded UUID", row);
    }
  }

  const balances = dbJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(balance) ORDER BY balance.id), '[]'::jsonb)::text
    FROM public.inv_stock_balance balance
    WHERE balance.warehouse_id=${sqlLiteral(warehouse.id)}::uuid
  `) ?? [];
  assert(balances.length <= 1, "A95 cleanup refused: unique warehouse has multiple inventory balances", balances);
  const actualBalanceIds = unique(balances.map((balance) => balance.id)).sort();
  const expectedBalanceIds = unique(artifacts.balanceIds).sort();
  for (const balanceId of [...actualBalanceIds, ...expectedBalanceIds]) assertUuid(balanceId, "A95 cleanup balance id");
  assert(
    actualBalanceIds.length === balances.length
      && jsonEqual(actualBalanceIds, expectedBalanceIds),
    "A95 cleanup refused because the balance UUID set differs from the scenario-recorded set",
    { expectedBalanceIds, actualBalanceIds, balances }
  );
  for (const balance of balances) {
    assert(
      balance.account_set_id === artifacts.accountSet.id
        && balance.product_id === artifacts.product.id
        && balance.warehouse_id === warehouse.id,
      "A95 cleanup refused: foreign balance in unique warehouse",
      balance
    );
  }
  artifacts.balanceSnapshots = Object.fromEntries(balances.map((balance) => [balance.id, balance]));

  const receivables = assertReceivableScope("cleanup capture");

  const targetIds = unique([
    warehouse.id,
    ...Object.values(artifacts.documents).map((document) => document.id)
  ]);
  const targetNos = unique([
    warehouseCode,
    ...Object.values(artifacts.documents).map((document) => document.billNo)
  ]);
  const logs = dbJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(operation_log) ORDER BY operation_log.id), '[]'::jsonb)::text
    FROM public.sys_operation_log operation_log
    WHERE (
        operation_log.target_id IN (${uuidIn(targetIds)})
        OR operation_log.target_no IN (${textIn(targetNos)})
        OR operation_log.id IN (${uuidIn(artifacts.endpointFailureLogIds)})
        OR operation_log.id IN (${uuidIn(Object.keys(artifacts.operationLogSnapshots))})
      )
      AND ${runActorCandidatePredicate("operation_log")}
  `) ?? [];
  for (const log of logs) {
    assert(log.actor_username === runUsername && log.operated_by === artifacts.identity.userId,
      "A95 cleanup refused a candidate target log without exact run-actor UUID/username ownership", log);
    const existing = artifacts.operationLogSnapshots[log.id];
    assert(!existing || jsonEqual(existing, log),
      "A95 cleanup refused a changed previously recorded operation-log snapshot", { existing, actual: log });
    artifacts.operationLogSnapshots[log.id] = log;
  }
  pushUnique(artifacts.operationLogIds, ...logs.map((row) => row.id));

  const documentNos = unique(Object.values(artifacts.documents).map((document) => document.billNo));
  const editLocks = dbJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(edit_lock) ORDER BY edit_lock.document_type, edit_lock.bill_no), '[]'::jsonb)::text
    FROM public.doc_edit_lock edit_lock
    WHERE edit_lock.bill_no IN (${textIn(documentNos)})
      AND edit_lock.document_type IN ('salesOrder', 'deliveryNotice', 'salesOut')
  `) ?? [];
  for (const editLock of editLocks) {
    assert(
      editLock.holder_user_id === artifacts.identity.userId
        && editLock.holder_username === runUsername,
      "A95 cleanup refused an edit lock not held by the run-unique actor",
      editLock
    );
  }
  artifacts.editLockSnapshots = editLocks;

  return { warehouse, transactions, balances, receivables, logs, editLocks };
}

function endpointFailureLogs(targetNo) {
  return dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', id::text,
      'operatedBy', operated_by::text,
      'actionCode', action_code,
      'targetType', target_type,
      'targetId', target_id::text,
      'targetNo', target_no,
      'actorType', actor_type,
      'actorUsername', actor_username,
      'accountSetCode', account_set_code,
      'success', success,
      'failureReason', failure_reason
    ) ORDER BY operated_at, id), '[]'::jsonb)::text
    FROM public.sys_operation_log
    WHERE action_code='WRITE_FAILED'
      AND target_type='http_endpoint'
      AND target_id IS NULL
      AND target_no=${sqlLiteral(targetNo)}
      AND actor_type='USER'
      AND actor_username=${sqlLiteral(runUsername)}
      AND ${runActorCandidatePredicate()}
      AND account_set_code='BLD-TEST'
      AND success=FALSE
  `) ?? [];
}

function captureNewEndpointFailureLog(targetNo, beforeIds, response) {
  const after = endpointFailureLogs(targetNo);
  const created = after.filter((row) => !beforeIds.has(row.id));
  assert(created.length === 1, "A95 expected exactly one new endpoint failure log UUID", {
    targetNo,
    beforeCount: beforeIds.size,
    afterCount: after.length,
    created
  });
  const [row] = created;
  const responseReason = String(response.data?.reason ?? response.data?.message ?? "");
  assert(
    row.actionCode === "WRITE_FAILED"
      && row.targetType === "http_endpoint"
      && row.targetId === null
      && row.targetNo === targetNo
      && row.actorType === "USER"
      && row.actorUsername === runUsername
      && (!artifacts.identity.userId || row.operatedBy === artifacts.identity.userId)
      && row.accountSetCode === "BLD-TEST"
      && row.success === false
      && row.failureReason === responseReason,
    "A95 endpoint failure log must exactly match this run's rejected request",
    { targetNo, responseReason, row }
  );
  pushUnique(artifacts.endpointFailureLogIds, row.id);
  pushUnique(artifacts.operationLogIds, row.id);
  return row;
}

function proveRecoveryReverse(kind) {
  const artifact = artifacts.documents[kind];
  if (kind === "order") return { kind, transactionIds: [] };
  assert(artifact.currentLines.length === 1, `A95 ${kind} recovery reverse requires exactly one fixed line`, artifact);
  const sourceBillLineId = artifact.currentLines[0].id;
  const previouslyRecordedTxnIds = new Set(artifacts.txnIds);
  const pair = kind === "out"
    ? assertCanonicalPair({
        sourceBillType: "SALES_OUT",
        sourceBillId: artifact.id,
        sourceBillLineId,
        sourceBillNo: artifact.billNo,
        forwardTxnType: "SALES_OUT",
        reverseTxnType: "SALES_OUT_REVERSE",
        forwardAction: "AUDIT",
        reverseAction: "REVERSE",
        label: "A95 API recovery sales-out lifecycle"
      })
    : assertCanonicalPair({
        sourceBillType: "DELIVERY_NOTICE",
        sourceBillId: artifact.id,
        sourceBillLineId,
        sourceBillNo: artifact.billNo,
        forwardTxnType: "DELIVERY_NOTICE_RESERVE",
        reverseTxnType: "DELIVERY_NOTICE_RESERVE_REVERSE",
        forwardAction: "RESERVE",
        reverseAction: "RELEASE",
        label: "A95 API recovery delivery-notice lifecycle"
      });
  assert(
    previouslyRecordedTxnIds.has(pair.forward.id) && !previouslyRecordedTxnIds.has(pair.reverse.id),
    `A95 ${kind} recovery must link one previously recorded forward UUID to one newly proven reverse UUID`,
    { previouslyRecordedTxnIds: [...previouslyRecordedTxnIds], pair }
  );
  assertStoredTransactionSnapshots([pair.forward.id], `${kind} recovery forward`);
  recordTransactionPair(pair, `${kind} API recovery lifecycle`);
  pushUnique(artifacts.txnIds, pair.reverse.id);
  recordTransactionSnapshots([pair.reverse.id], `${kind} API recovery reverse`);
  return { kind, transactionIds: [pair.forward.id, pair.reverse.id], pair };
}

async function recoverDocument(kind) {
  const artifact = artifacts.documents[kind];
  if (!artifact.id && !artifact.billNo) return { kind, state: "not-created" };
  assert(artifact.id && artifact.billNo, `A95 API recovery refused a partially recorded ${kind} artifact`, artifact);
  assertRecordedDocumentBeforeMutation(kind, "API recovery inspection");
  const definition = documentDefinitions[kind];
  const detailPath = `/api/${definition.endpoint}/${encodeURIComponent(artifact.billNo)}`;
  let detail = await request(detailPath, { method: "GET" });
  assert(detail.status === 200, `A95 API recovery could not read ${kind}`, detail);
  let status = detail.data?.[definition.detailKey]?.status;
  const actions = [];
  if (status === "AUDITED") {
    assertRecordedDocumentBeforeMutation(kind, "API recovery reverse");
    const reverse = await request(`${detailPath}/reverse`, { method: "POST" });
    assert(reverse.status === 200, `A95 API recovery could not reverse ${kind}`, reverse);
    recordDocumentVersion(kind, artifact.billNo, "api-recovery-reverse", 1, "DRAFT");
    if (kind === "out") {
      if (artifacts.documents.order.id) {
        recordDocumentVersion("order", artifacts.documents.order.billNo, "source-progress-after-api-recovery-out-reverse", 1, "AUDITED");
      }
      recordReceivableSnapshot("reverse", "API recovery sales-out reverse");
    }
    const trace = proveRecoveryReverse(kind);
    actions.push({ action: "reverse", status: reverse.status, trace });
    status = reverse.data?.status ?? "DRAFT";
  }
  if (status === "DRAFT") {
    const endpointTargetNo = `DELETE /api/${definition.endpoint}/{billNo}`;
    const endpointLogIdsBefore = new Set(endpointFailureLogs(endpointTargetNo).map((row) => row.id));
    assertRecordedDocumentBeforeMutation(kind, "API recovery delete");
    artifact.deleteAttempted = true;
    const deletion = await request(detailPath, { method: "DELETE" });
    if (deletion.status === 200) {
      recordDocumentAbsence(kind, "api-recovery-delete");
      actions.push({ action: "delete", status: 200 });
      return { kind, billNo: artifact.billNo, state: "deleted", actions };
    }
    const endpointFailureLog = captureNewEndpointFailureLog(endpointTargetNo, endpointLogIdsBefore, deletion);
    assert(deletion.status === 409 && deletion.text.includes("库存过账历史"), `A95 API recovery ${kind} delete returned an unexpected result`, deletion);
    recordDocumentVersion(kind, artifact.billNo, "api-recovery-delete-rejected", 1, "DRAFT");
    actions.push({ action: "delete", status: 409, reason: "库存过账历史", endpointFailureLogId: endpointFailureLog.id });
    return { kind, billNo: artifact.billNo, state: "trace-retained", actions };
  }
  artifact.cleanupDeletionForbidden = `unknown-retained-status:${String(status)}`;
  throw new Error(`A95 API recovery refused unknown retained ${kind} status: ${String(status)}`);
}

async function apiRecovery() {
  // Browser acceptance logs in with the same run-unique admin account, which intentionally
  // rotates the API session. Re-establish BLD-TEST before the cleanup gate.
  const cleanupHealth = await anonymousHealthGate("cleanup");
  await installApiSession(apiBase, runUsername, runPassword, "BLD-TEST");
  evidence.preflight.cleanup = await controlledGate("cleanup", cleanupHealth);
  captureRunScope();

  const outRecovery = await recoverDocument("out");
  evidence.cleanup.apiRecovery.push(outRecovery);
  evidence.cleanup.canonicalTraceBeforeDelete = outRecovery.actions
    ?.find((action) => action.action === "reverse")?.trace?.pair ?? null;

  if (["deleted", "not-created"].includes(outRecovery.state)) {
    const noticeRecovery = await recoverDocument("notice");
    evidence.cleanup.apiRecovery.push(noticeRecovery);
    if (["deleted", "not-created"].includes(noticeRecovery.state)) {
      evidence.cleanup.apiRecovery.push(await recoverDocument("order"));
    } else {
      evidence.cleanup.apiRecovery.push({ kind: "order", state: "skipped-because-notice-retained" });
    }
  } else {
    evidence.cleanup.apiRecovery.push({ kind: "notice", state: "skipped-because-out-retained" });
    evidence.cleanup.apiRecovery.push({ kind: "order", state: "skipped-because-out-retained" });
  }
  return captureRunScope();
}

function directCleanup() {
  assert(controlledWriteAuthorized, "A95 direct cleanup is forbidden without the initial controlled write gate");
  const forbiddenDocuments = Object.entries(artifacts.documents)
    .filter(([, artifact]) => artifact.cleanupDeletionForbidden)
    .map(([kind, artifact]) => ({ kind, reason: artifact.cleanupDeletionForbidden }));
  assert(forbiddenDocuments.length === 0,
    "A95 direct cleanup is forbidden after an unknown retained document state", forbiddenDocuments);
  const scope = captureRunScope();
  if (!scope.warehouse) {
    evidence.cleanup.directDelete = { skipped: true, reason: "warehouse already absent" };
    return;
  }
  const headerLineSets = assertOwnedHeaderLineSets();

  const warehouseId = artifacts.warehouse.id;
  const order = artifacts.documents.order;
  const notice = artifacts.documents.notice;
  const out = artifacts.documents.out;
  const documentIds = unique([order.id, notice.id, out.id]);
  const documentNos = unique([order.billNo, notice.billNo, out.billNo]);
  const targetNos = unique([warehouseCode, ...documentNos]);
  const targetIds = unique([warehouseId, ...documentIds]);
  const endpointFailureLogIds = unique(artifacts.endpointFailureLogIds);
  const lineIds = unique([
    ...order.lineIds,
    ...notice.lineIds,
    ...out.lineIds
  ]);
  const expectedWarehouseSnapshots = artifacts.warehouse.snapshot
    ? { [warehouseId]: artifacts.warehouse.snapshot }
    : {};
  assert(
    Object.keys(expectedWarehouseSnapshots).length === 1
      && jsonEqual(scope.warehouse, artifacts.warehouse.snapshot),
    "A95 locked cleanup requires the complete captured warehouse snapshot",
    { warehouseId, scopeWarehouse: scope.warehouse, expectedWarehouseSnapshots }
  );
  const expectedBalanceIds = Object.keys(artifacts.balanceSnapshots).sort();
  assert(jsonEqual(expectedBalanceIds, unique(artifacts.balanceIds).sort()),
    "A95 locked cleanup balance UUID list must exactly match the complete snapshot map", {
      expectedBalanceIds,
      balanceIds: artifacts.balanceIds
    });
  const expectedBalanceSnapshots = Object.fromEntries(
    expectedBalanceIds.map((balanceId) => [balanceId, artifacts.balanceSnapshots[balanceId]])
  );
  const expectedTxnIds = unique(artifacts.txnIds).sort();
  const expectedTxnSnapshots = Object.fromEntries(
    expectedTxnIds.map((txnId) => [txnId, artifacts.txnSnapshots[txnId]])
  );
  assert(expectedTxnIds.every((txnId) => expectedTxnSnapshots[txnId]),
    "A95 locked cleanup requires one complete recorded snapshot per transaction UUID", { expectedTxnIds, expectedTxnSnapshots });
  const expectedReceivableIds = Object.keys(artifacts.receivableSnapshots).sort();
  assert(jsonEqual(expectedReceivableIds, unique(artifacts.receivableIds).sort()),
    "A95 locked cleanup receivable UUID list must exactly match the complete snapshot map", {
      expectedReceivableIds,
      receivableIds: artifacts.receivableIds
    });
  const expectedReceivableSnapshots = Object.fromEntries(
    expectedReceivableIds.map((receivableId) => [receivableId, artifacts.receivableSnapshots[receivableId]])
  );
  const expectedReceivableBillNos = Object.values(expectedReceivableSnapshots).map((row) => row.bill_no);
  const expectedOperationLogIds = Object.keys(artifacts.operationLogSnapshots).sort();
  assert(expectedOperationLogIds.every((logId) => artifacts.operationLogIds.includes(logId))
      && artifacts.operationLogIds.every((logId) => expectedOperationLogIds.includes(logId)),
    "A95 locked cleanup operation-log UUID list must exactly match the complete snapshot map", {
      expectedOperationLogIds,
      operationLogIds: artifacts.operationLogIds
    });
  const expectedOperationLogSnapshots = Object.fromEntries(
    expectedOperationLogIds.map((logId) => [logId, artifacts.operationLogSnapshots[logId]])
  );
  const expectedEditLocks = artifacts.editLockSnapshots;
  const editLockDeletePredicate = expectedEditLocks.length
    ? expectedEditLocks.map((editLock) => `(
        edit_lock.document_type=${sqlLiteral(editLock.document_type)}
        AND edit_lock.bill_no=${sqlLiteral(editLock.bill_no)}
        AND edit_lock.holder_user_id=${sqlLiteral(editLock.holder_user_id)}::uuid
        AND edit_lock.holder_username=${sqlLiteral(editLock.holder_username)}
      )`).join(" OR ")
    : "FALSE";
  const lockedTxnPairGuards = artifacts.txnPairs.map((pair, index) => `
      IF NOT EXISTS (
        SELECT 1
        FROM public.inv_stock_txn forward_txn
        JOIN public.inv_stock_txn reverse_txn ON reverse_txn.reversal_of_txn_id=forward_txn.id
        WHERE forward_txn.id=${sqlLiteral(pair.forwardId)}::uuid
          AND reverse_txn.id=${sqlLiteral(pair.reverseId)}::uuid
          AND forward_txn.warehouse_id=locked_warehouse_id
          AND reverse_txn.warehouse_id=locked_warehouse_id
          AND forward_txn.source_bill_type=${sqlLiteral(pair.sourceBillType)}
          AND reverse_txn.source_bill_type=${sqlLiteral(pair.sourceBillType)}
          AND forward_txn.source_bill_id=${sqlLiteral(pair.sourceBillId)}::uuid
          AND reverse_txn.source_bill_id=${sqlLiteral(pair.sourceBillId)}::uuid
          AND forward_txn.txn_type=${sqlLiteral(pair.forwardTxnType)}
          AND reverse_txn.txn_type=${sqlLiteral(pair.reverseTxnType)}
          AND forward_txn.posting_action=${sqlLiteral(pair.forwardAction)}
          AND reverse_txn.posting_action=${sqlLiteral(pair.reverseAction)}
      ) THEN
        RAISE EXCEPTION 'A95 cleanup refused: recorded forward/reverse transaction pair ${index + 1} changed';
      END IF;
  `).join("\n");

  psql(`
    BEGIN;
    SET LOCAL lock_timeout='10s';
    LOCK TABLE public.md_warehouse,
               public.inv_stock_balance,
               public.inv_stock_txn,
               public.sales_order,
               public.sales_order_line,
               public.delivery_notice,
               public.delivery_notice_line,
               public.sales_out,
               public.sales_out_line,
               public.ar_receivable,
               public.sys_operation_log,
               public.doc_edit_lock
      IN SHARE ROW EXCLUSIVE MODE;

    DO $a95_cleanup_guard$
    DECLARE
      locked_warehouse_id uuid;
      actual_warehouse_snapshots jsonb;
      actual_balance_ids jsonb;
      actual_balance_snapshots jsonb;
      actual_txn_ids jsonb;
      actual_txn_snapshots jsonb;
      actual_receivable_snapshots jsonb;
      actual_operation_log_snapshots jsonb;
      actual_edit_lock_snapshots jsonb;
    BEGIN
      SELECT COALESCE(jsonb_object_agg(warehouse.id::text, to_jsonb(warehouse) ORDER BY warehouse.id), '{}'::jsonb)
      INTO actual_warehouse_snapshots
      FROM public.md_warehouse warehouse
      WHERE warehouse.id=${sqlLiteral(warehouseId)}::uuid
         OR warehouse.code=${sqlLiteral(warehouseCode)};
      IF actual_warehouse_snapshots IS DISTINCT FROM ${sqlLiteral(JSON.stringify(expectedWarehouseSnapshots))}::jsonb THEN
        RAISE EXCEPTION 'A95 cleanup refused: locked warehouse UUID set or complete snapshot changed';
      END IF;
      SELECT warehouse.id INTO locked_warehouse_id
      FROM public.md_warehouse warehouse
      WHERE warehouse.id=${sqlLiteral(warehouseId)}::uuid
      FOR UPDATE;
      IF locked_warehouse_id IS NULL OR locked_warehouse_id <> ${sqlLiteral(warehouseId)}::uuid THEN
        RAISE EXCEPTION 'A95 cleanup refused: locked warehouse identity mismatch';
      END IF;
      ${lockedDocumentLineGuardSql("order", order)}
      ${lockedDocumentLineGuardSql("notice", notice)}
      ${lockedDocumentLineGuardSql("out", out)}
      SELECT COALESCE(jsonb_agg(txn.id::text ORDER BY txn.id), '[]'::jsonb)
      INTO actual_txn_ids
      FROM public.inv_stock_txn txn
      WHERE txn.warehouse_id=locked_warehouse_id;
      IF actual_txn_ids IS DISTINCT FROM ${sqlLiteral(JSON.stringify(expectedTxnIds))}::jsonb THEN
        RAISE EXCEPTION 'A95 cleanup refused: locked inventory transaction UUID set differs from recorded set';
      END IF;
      SELECT COALESCE(jsonb_object_agg(txn.id::text, to_jsonb(txn) ORDER BY txn.id), '{}'::jsonb)
      INTO actual_txn_snapshots
      FROM public.inv_stock_txn txn
      WHERE txn.warehouse_id=locked_warehouse_id;
      IF actual_txn_snapshots IS DISTINCT FROM ${sqlLiteral(JSON.stringify(expectedTxnSnapshots))}::jsonb THEN
        RAISE EXCEPTION 'A95 cleanup refused: locked complete inventory transaction snapshots changed';
      END IF;
      ${lockedTxnPairGuards}
      SELECT COALESCE(jsonb_agg(balance.id::text ORDER BY balance.id), '[]'::jsonb)
      INTO actual_balance_ids
      FROM public.inv_stock_balance balance
      WHERE balance.warehouse_id=locked_warehouse_id;
      IF actual_balance_ids IS DISTINCT FROM ${sqlLiteral(JSON.stringify(expectedBalanceIds))}::jsonb THEN
        RAISE EXCEPTION 'A95 cleanup refused: locked inventory balance UUID set differs from recorded set';
      END IF;
      SELECT COALESCE(jsonb_object_agg(balance.id::text, to_jsonb(balance) ORDER BY balance.id), '{}'::jsonb)
      INTO actual_balance_snapshots
      FROM public.inv_stock_balance balance
      WHERE balance.warehouse_id=locked_warehouse_id;
      IF actual_balance_snapshots IS DISTINCT FROM ${sqlLiteral(JSON.stringify(expectedBalanceSnapshots))}::jsonb THEN
        RAISE EXCEPTION 'A95 cleanup refused: locked complete inventory balance snapshots changed';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM (
          SELECT line.id FROM public.sales_order_line line WHERE line.warehouse_id=locked_warehouse_id
          UNION ALL
          SELECT line.id FROM public.delivery_notice_line line WHERE line.warehouse_id=locked_warehouse_id
          UNION ALL
          SELECT line.id FROM public.sales_out_line line WHERE line.warehouse_id=locked_warehouse_id
        ) scoped_line
        WHERE ${notRecorded("scoped_line.id", lineIds)}
      ) THEN
        RAISE EXCEPTION 'A95 cleanup refused: unrecorded business line in unique warehouse';
      END IF;
      SELECT COALESCE(jsonb_object_agg(receivable.id::text, to_jsonb(receivable) ORDER BY receivable.id), '{}'::jsonb)
      INTO actual_receivable_snapshots
      FROM public.ar_receivable receivable
      WHERE receivable.source_bill_no=${sqlLiteral(out.billNo)}
         OR receivable.id IN (${uuidIn(expectedReceivableIds)})
         OR receivable.bill_no IN (${textIn(expectedReceivableBillNos)});
      IF actual_receivable_snapshots IS DISTINCT FROM ${sqlLiteral(JSON.stringify(expectedReceivableSnapshots))}::jsonb THEN
        RAISE EXCEPTION 'A95 cleanup refused: receivable UUID set or complete owned snapshots changed';
      END IF;
      SELECT COALESCE(jsonb_object_agg(operation_log.id::text, to_jsonb(operation_log) ORDER BY operation_log.id), '{}'::jsonb)
      INTO actual_operation_log_snapshots
      FROM public.sys_operation_log operation_log
      WHERE (
          operation_log.target_id IN (${uuidIn(targetIds)})
          OR operation_log.target_no IN (${textIn(targetNos)})
          OR operation_log.id IN (${uuidIn(endpointFailureLogIds)})
          OR operation_log.id IN (${uuidIn(expectedOperationLogIds)})
        )
        AND ${runActorCandidatePredicate("operation_log")};
      IF actual_operation_log_snapshots IS DISTINCT FROM ${sqlLiteral(JSON.stringify(expectedOperationLogSnapshots))}::jsonb THEN
        RAISE EXCEPTION 'A95 cleanup refused: candidate operation-log set, fields, or exact actor ownership changed';
      END IF;
      SELECT COALESCE(jsonb_agg(to_jsonb(edit_lock) ORDER BY edit_lock.document_type, edit_lock.bill_no), '[]'::jsonb)
      INTO actual_edit_lock_snapshots
      FROM public.doc_edit_lock edit_lock
      WHERE edit_lock.bill_no IN (${textIn(documentNos)})
        AND edit_lock.document_type IN ('salesOrder', 'deliveryNotice', 'salesOut');
      IF actual_edit_lock_snapshots IS DISTINCT FROM ${sqlLiteral(JSON.stringify(expectedEditLocks))}::jsonb THEN
        RAISE EXCEPTION 'A95 cleanup refused: edit-lock set, fields, or run-unique holder changed';
      END IF;
    END;
    $a95_cleanup_guard$;

    DELETE FROM public.doc_edit_lock edit_lock
    WHERE ${editLockDeletePredicate};
    DELETE FROM public.sys_operation_log
    WHERE id IN (${uuidIn(artifacts.operationLogIds)})
      AND ${runActorOwnedPredicate()}
      AND (
        target_id IN (${uuidIn(targetIds)})
        OR target_no IN (${textIn(targetNos)})
        OR id IN (${uuidIn(endpointFailureLogIds)})
      );
    DELETE FROM public.ar_receivable
    WHERE id IN (${uuidIn(expectedReceivableIds)});
    DELETE FROM public.inv_stock_txn
    WHERE id IN (${uuidIn(artifacts.txnIds)})
      AND warehouse_id=${sqlLiteral(warehouseId)}::uuid;
    DELETE FROM public.sales_out_line
    WHERE bill_id IN (${uuidIn([out.id])})
      AND id IN (${uuidIn(out.lineIds)});
    DELETE FROM public.sales_out
    WHERE id IN (${uuidIn([out.id])})
      AND bill_no IN (${textIn([out.billNo])});
    DELETE FROM public.delivery_notice_line
    WHERE bill_id IN (${uuidIn([notice.id])})
      AND id IN (${uuidIn(notice.lineIds)});
    DELETE FROM public.delivery_notice
    WHERE id IN (${uuidIn([notice.id])})
      AND bill_no IN (${textIn([notice.billNo])});
    DELETE FROM public.sales_order_line
    WHERE order_id IN (${uuidIn([order.id])})
      AND id IN (${uuidIn(order.lineIds)});
    DELETE FROM public.sales_order
    WHERE id IN (${uuidIn([order.id])})
      AND bill_no IN (${textIn([order.billNo])});
    DELETE FROM public.inv_stock_balance
    WHERE id IN (${uuidIn(expectedBalanceIds)})
      AND warehouse_id=${sqlLiteral(warehouseId)}::uuid;
    DELETE FROM public.md_warehouse
    WHERE id=${sqlLiteral(warehouseId)}::uuid
      AND code=${sqlLiteral(warehouseCode)}
      AND name=${sqlLiteral(warehouseName)}
      AND COALESCE(remark, '')=${sqlLiteral(fixturePrefix)};
    COMMIT;
  `);

  evidence.cleanup.directDelete = {
    warehouseId,
    headerLineSets,
    transactionIds: [...artifacts.txnIds],
    balanceIds: [...artifacts.balanceIds],
    documentIds,
    lineIds,
    receivableIds: [...artifacts.receivableIds],
    endpointFailureLogIds: [...artifacts.endpointFailureLogIds],
    operationLogIds: [...artifacts.operationLogIds]
  };
}

function residueCounts() {
  const warehouseId = artifacts.warehouse.id;
  const documentIds = unique(Object.values(artifacts.documents).map((document) => document.id));
  const documentNos = unique(Object.values(artifacts.documents).map((document) => document.billNo));
  const targetIds = unique([warehouseId, ...documentIds]);
  const targetNos = unique([warehouseCode, ...documentNos]);
  return dbJson(`
    SELECT jsonb_build_object(
      'warehouse', (SELECT count(*) FROM public.md_warehouse WHERE code=${sqlLiteral(warehouseCode)} OR id IN (${uuidIn([warehouseId])})),
      'balances', (SELECT count(*) FROM public.inv_stock_balance WHERE warehouse_id IN (${uuidIn([warehouseId])})),
      'transactions', (SELECT count(*) FROM public.inv_stock_txn WHERE warehouse_id IN (${uuidIn([warehouseId])}) OR id IN (${uuidIn(artifacts.txnIds)})),
      'orderHeaders', (SELECT count(*) FROM public.sales_order WHERE id IN (${uuidIn([artifacts.documents.order.id])}) OR bill_no IN (${textIn([artifacts.documents.order.billNo])})),
      'orderLines', (SELECT count(*) FROM public.sales_order_line WHERE order_id IN (${uuidIn([artifacts.documents.order.id])})),
      'noticeHeaders', (SELECT count(*) FROM public.delivery_notice WHERE id IN (${uuidIn([artifacts.documents.notice.id])}) OR bill_no IN (${textIn([artifacts.documents.notice.billNo])})),
      'noticeLines', (SELECT count(*) FROM public.delivery_notice_line WHERE bill_id IN (${uuidIn([artifacts.documents.notice.id])})),
      'outHeaders', (SELECT count(*) FROM public.sales_out WHERE id IN (${uuidIn([artifacts.documents.out.id])}) OR bill_no IN (${textIn([artifacts.documents.out.billNo])})),
      'outLines', (SELECT count(*) FROM public.sales_out_line WHERE bill_id IN (${uuidIn([artifacts.documents.out.id])})),
      'receivables', (SELECT count(*) FROM public.ar_receivable WHERE id IN (${uuidIn(artifacts.receivableIds)}) OR source_bill_no IN (${textIn([artifacts.documents.out.billNo])})),
      'operationLogs', (SELECT count(*) FROM public.sys_operation_log WHERE id IN (${uuidIn(artifacts.operationLogIds)}) OR ((target_id IN (${uuidIn(targetIds)}) OR target_no IN (${textIn(targetNos)})) AND ${runActorCandidatePredicate()})),
      'documentLocks', (SELECT count(*) FROM public.doc_edit_lock WHERE bill_no IN (${textIn(documentNos)}))
    )::text
  `);
}

async function cleanup() {
  evidence.cleanup.attempted = true;
  const failures = [];
  const recordFailure = (phase, error) => {
    failures.push({ phase, error });
  };
  try {
    await apiRecovery();
  } catch (error) {
    recordFailure("api recovery", error);
  }
  if (controlledWriteAuthorized) {
    try {
      directCleanup();
    } catch (error) {
      recordFailure("guarded direct cleanup", error);
    }
  } else {
    evidence.cleanup.directDelete = { skipped: true, reason: "trusted-write-scope-not-established" };
  }
  try {
    evidence.cleanup.residue = residueCounts();
    const residueTotal = Object.values(evidence.cleanup.residue ?? {}).reduce((sum, value) => sum + Number(value), 0);
    assert(residueTotal === 0, "A95 cleanup must leave zero run-specific residue", evidence.cleanup.residue);
  } catch (error) {
    recordFailure("residue assertion", error);
  }
  if (identityWriteAttempted) {
    try {
      cleanupRunIdentity();
    } catch (error) {
      recordFailure("identity cleanup", error);
    }
  } else {
    evidence.cleanup.identity = { attempted: false, passed: true, skipped: "identity-not-created", residue: null };
  }
  evidence.cleanup.errors = failures.map(({ phase, error }) => ({
    phase,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : ""
  }));
  if (failures.length > 0) {
    const apiRecoveryFailure = failures.find(({ phase }) => phase === "api recovery");
    const primary = apiRecoveryFailure?.error ?? failures[0].error;
    if (primary instanceof Error) {
      primary.a95CleanupFailures = evidence.cleanup.errors;
      throw primary;
    }
    const aggregate = new Error(`A95 cleanup failed after all phases: ${JSON.stringify(evidence.cleanup.errors)}`);
    aggregate.cause = primary;
    throw aggregate;
  }
}

async function main() {
  await mkdir(screenshotDir, { recursive: true });
  await mkdir(path.dirname(resultPath), { recursive: true });
  const writeHealth = await anonymousHealthGate("write");
  createRunIdentity();
  await installApiSession(apiBase, runUsername, runPassword, "BLD-TEST");
  evidence.preflight.write = await controlledGate("write", writeHealth);
  controlledWriteAuthorized = true;
  evidence.seed = await createUniqueWarehouseAndSeed();
  evidence.lifecycle = await verifyReverseBackToEditableDraft();
  evidence.workbench = await verifyWorkbenchBlankNumbering();
}

let failure = null;
let hasFailure = false;
try {
  await main();
} catch (error) {
  hasFailure = true;
  failure = error;
  evidence.failure = {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : ""
  };
} finally {
  try {
    await cleanup();
  } catch (cleanupError) {
    if (!hasFailure) {
      hasFailure = true;
      failure = cleanupError;
      evidence.failure = {
        message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        stack: cleanupError instanceof Error ? cleanupError.stack : ""
      };
    } else {
      evidence.failure.cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    }
  }
  evidence.ok = !hasFailure;
  evidence.completedAt = new Date().toISOString();
  try {
    await mkdir(path.dirname(resultPath), { recursive: true });
    await writeFile(resultPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  } catch (evidenceWriteError) {
    evidence.ok = false;
    const writeFailure = {
      message: evidenceWriteError instanceof Error ? evidenceWriteError.message : String(evidenceWriteError),
      stack: evidenceWriteError instanceof Error ? evidenceWriteError.stack : ""
    };
    if (!hasFailure) {
      hasFailure = true;
      failure = evidenceWriteError;
      evidence.failure = writeFailure;
    } else {
      evidence.failure ??= {
        message: failure instanceof Error ? failure.message : String(failure),
        stack: failure instanceof Error ? failure.stack : ""
      };
      evidence.failure.evidenceWrite = writeFailure;
    }
  }
}

if (hasFailure) throw failure;

console.log(JSON.stringify({
  ok: true,
  resultPath,
  runId,
  warehouseCode,
  lifecycle: evidence.lifecycle,
  workbench: evidence.workbench,
  cleanup: evidence.cleanup.residue
}, null, 2));
