import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loginApi } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const resultPath = path.join(verificationDir, "a118-outsourcing-chain-regression.json");
const apiBase = "http://127.0.0.1:8080";
const nativeFetch = globalThis.fetch.bind(globalThis);
const runId = randomUUID();
const runToken = runId.replaceAll("-", "").slice(0, 12).toUpperCase();
const fixtureKey = `A118-${runToken}`;
const bomCode = `BOM-${fixtureKey}`;
const productCode = `CP-${fixtureKey}`;
const componentCode = `PJ-${fixtureKey}`;
const productNameCode = `PN-${productCode}`;
const componentNameCode = `PN-${componentCode}`;
const productName = `A118 委外母件 ${runToken}`;
const componentName = `A118 委外子件 ${runToken}`;
const supplierCode = "GYS-001";
const stockSource = `A118:${runToken}`;
const runUsername = `a118_${runToken.toLowerCase()}_admin`;
const runDisplayName = `A118 ${runToken} admin`;
const runPassword = `A118-${runToken}-Admin1!`;
const planDeliveryDate = "2026-07-15";
const faultPhase = process.env.A118_FAULT_PHASE ?? "";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const jSessionIdPattern = /^[0-9a-f]{32}$/i;
const redisGlobControlPattern = /[*?\[\]\\]/;
const startedAtMs = Date.now();

const expectedProducts = Object.freeze({
  [productCode]: {
    name: productName,
    category: "成品总成",
    unit: "只",
    defaultWarehouseCode: "CK-001",
    defaultSupplierCode: null,
    isPurchase: false,
    isSale: true,
    isInventory: true,
    isProduce: true,
    isSubcontract: true,
    purchasePrice: null,
    subcontractPrice: 12.5
  },
  [componentCode]: {
    name: componentName,
    category: "零配件",
    unit: "件",
    defaultWarehouseCode: "CK-002",
    defaultSupplierCode: supplierCode,
    isPurchase: true,
    isSale: false,
    isInventory: true,
    isProduce: false,
    isSubcontract: false,
    purchasePrice: 3.2,
    subcontractPrice: null
  }
});

const expectedProductNames = Object.freeze({
  [productNameCode]: { name: productName },
  [componentNameCode]: { name: componentName }
});

const allowedFailureRoutes = new Set([
  "POST /api/master-data/{type}",
  "POST /api/master-data/{type}/{code}/audit",
  "POST /api/inventory/adjustments",
  "POST /api/production/boms",
  "POST /api/production/boms/{code}/audit",
  "POST /api/outsourcing/work-orders/draft",
  "POST /api/outsourcing/work-orders/{billNo}/audit",
  "POST /api/outsourcing/work-orders/{billNo}/reverse",
  "POST /api/outsourcing/work-orders/{billNo}/push-issue",
  "POST /api/outsourcing/work-orders/{billNo}/push-receipt",
  "POST /api/outsourcing/issues/{billNo}/audit",
  "POST /api/outsourcing/issues/{billNo}/reverse",
  "POST /api/outsourcing/receipts/{billNo}/audit",
  "POST /api/outsourcing/receipts/{billNo}/reverse",
  "POST /api/outsourcing/receipts/{billNo}/push-return",
  "POST /api/outsourcing/receipts/{billNo}/push-scrap",
  "POST /api/outsourcing/returns/{billNo}/audit",
  "POST /api/outsourcing/returns/{billNo}/reverse",
  "POST /api/outsourcing/scraps/{billNo}/audit",
  "POST /api/outsourcing/scraps/{billNo}/reverse",
  "POST /api/system/logout"
]);

const documentDefinitions = Object.freeze({
  workOrder: {
    headerTable: "outsourcing_work_order",
    lineTable: "outsourcing_work_order_line",
    lineForeignKey: "work_order_id"
  },
  issue: {
    headerTable: "outsourcing_material_issue",
    lineTable: "outsourcing_material_issue_line",
    lineForeignKey: "issue_id"
  },
  receipt: {
    headerTable: "outsourcing_receipt",
    lineTable: "outsourcing_receipt_line",
    lineForeignKey: "receipt_id"
  },
  return: {
    headerTable: "outsourcing_return",
    lineTable: "outsourcing_return_line",
    lineForeignKey: "return_id"
  },
  scrap: {
    headerTable: "outsourcing_scrap",
    lineTable: "outsourcing_scrap_line",
    lineForeignKey: "scrap_id"
  }
});

const artifacts = {
  businessDate: "",
  accountSet: null,
  adminRole: null,
  warehouses: {},
  supplier: null,
  identity: { userId: "", grantId: "", roleId: "" },
  session: {
    cookie: "",
    token: "",
    scopeSnapshot: null,
    redisBeforeLogout: null,
    redisBacked: false,
    redisObserved: { ownedKeyCount: 0, expirationMemberCount: 0 },
    logoutStatus: null,
    postLogoutAuthenticated: null
  },
  ids: {
    productNames: new Set(),
    products: new Set(),
    boms: new Set(),
    bomLines: new Set(),
    workOrders: new Set(),
    workOrderLines: new Set(),
    workOrderComponents: new Set(),
    issues: new Set(),
    issueLines: new Set(),
    receipts: new Set(),
    receiptLines: new Set(),
    returns: new Set(),
    returnLines: new Set(),
    scraps: new Set(),
    scrapLines: new Set(),
    transactions: new Set(),
    balances: new Set(),
    logs: new Set()
  },
  bills: {
    workOrder: "",
    issue: "",
    receipt: "",
    return: "",
    scrap: ""
  },
  productNameWrites: {
    [productNameCode]: { attempted: false, accepted: false, audited: false, rejected409: false, preflightCollision: false },
    [componentNameCode]: { attempted: false, accepted: false, audited: false, rejected409: false, preflightCollision: false }
  },
  productWrites: {
    [productCode]: { attempted: false, accepted: false, rejected409: false, preflightCollision: false },
    [componentCode]: { attempted: false, accepted: false, rejected409: false, preflightCollision: false }
  }
};

const result = {
  ok: false,
  runId,
  runToken,
  fixtureKey,
  productCode,
  componentCode,
  productNameCode,
  componentNameCode,
  bomCode,
  workOrderNo: null,
  environment: {},
  checks: {},
  artifacts: {},
  cleanup: {
    attempted: false,
    logout: null,
    redis: null,
    snapshotCounts: null,
    residue: null,
    errors: []
  },
  failure: null
};

let identityWriteAttempted = false;
let primaryError = null;

await mkdir(verificationDir, { recursive: true });

function assert(condition, message, details = undefined) {
  if (!condition) {
    throw new Error(details === undefined ? message : `${message}: ${JSON.stringify(details)}`);
  }
}

function assertUuid(value, label) {
  assert(uuidPattern.test(String(value ?? "")), `${label} must be a UUID`, value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
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

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))].sort();
}

function uuidArray(values) {
  const normalized = unique(values).filter((value) => uuidPattern.test(value));
  return normalized.length
    ? `ARRAY[${normalized.map((value) => `${sqlLiteral(value)}::uuid`).join(", ")}]::uuid[]`
    : "ARRAY[]::uuid[]";
}

function textArray(values) {
  const normalized = unique(values);
  return normalized.length
    ? `ARRAY[${normalized.map(sqlLiteral).join(", ")}]::text[]`
    : "ARRAY[]::text[]";
}

function psql(sql) {
  return execFileSync("docker", [
    "exec", "jdy-erp-postgres", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-qAt",
    "-U", "jdy", "-d", "jdy_erp", "-c", sql
  ], { encoding: "utf8" }).trim();
}

function dbJson(sql) {
  const raw = psql(sql);
  if (!raw || raw === "null") return null;
  return JSON.parse(raw);
}

function dbNumber(sql) {
  return Number(psql(sql) || "0");
}

function redisCommand(...args) {
  return execFileSync(
    "docker",
    ["exec", "jdy-erp-redis", "redis-cli", "-n", "0", "--raw", ...args],
    { encoding: "utf8" }
  ).trim();
}

function redisScan(pattern) {
  const raw = redisCommand("--scan", "--pattern", pattern);
  return raw ? unique(raw.split(/\r?\n/).filter(Boolean)) : [];
}

function parseSessionCookie() {
  const raw = String(artifacts.session.cookie ?? "");
  if (!raw) return null;
  const match = /^(SESSION|JSESSIONID)=([^;]+)$/.exec(raw);
  assert(match, "A118 session cookie must contain one exact SESSION or JSESSIONID name/value pair", raw.split("=")[0]);
  return { name: match[1], value: match[2] };
}

function isRedisScanSafeMarker(value) {
  return /^[\x21-\x7e]+$/.test(value) && !redisGlobControlPattern.test(value);
}

function decodeSessionMarker(value, encoding) {
  const encodedPattern = encoding === "base64"
    ? /^[A-Za-z0-9+/]+={0,2}$/
    : /^[A-Za-z0-9_-]+={0,2}$/;
  if (!encodedPattern.test(value) || value.replace(/=+$/, "").length % 4 === 1) return "";
  const decoded = Buffer.from(value, encoding).toString("utf8");
  if (!(uuidPattern.test(decoded) || jSessionIdPattern.test(decoded))) return "";
  return isRedisScanSafeMarker(decoded) ? decoded : "";
}

function sessionIdMarkers() {
  const cookie = parseSessionCookie();
  const cookieMarkers = [];
  if (cookie?.name === "JSESSIONID") {
    assert(jSessionIdPattern.test(cookie.value),
      "A118 JSESSIONID must be one exact raw 32-hex identifier", cookie.name);
    cookieMarkers.push(cookie.value);
  } else if (cookie?.name === "SESSION") {
    assert(isRedisScanSafeMarker(cookie.value),
      "A118 SESSION cookie value must be safe for an exact Redis scan marker", cookie.name);
    cookieMarkers.push(
      cookie.value,
      decodeSessionMarker(cookie.value, "base64"),
      decodeSessionMarker(cookie.value, "base64url")
    );
  }
  const markers = unique([...cookieMarkers, artifacts.session.token, runUsername]);
  assert(markers.every(isRedisScanSafeMarker),
    "A118 Redis session markers must not contain glob controls or non-printable characters");
  return markers;
}

function redisSessionSnapshot() {
  const markers = sessionIdMarkers();
  const ownedKeys = new Set();
  for (const marker of markers) {
    for (const key of redisScan(`spring:session:*${marker}*`)) ownedKeys.add(key);
  }
  if (ownedKeys.size === 0) {
    for (const key of redisScan("spring:session:sessions:*")) {
      if (!/^spring:session:sessions:(?!expires:).+/.test(key) || redisCommand("TYPE", key) !== "hash") continue;
      const serialized = redisCommand("HGETALL", key);
      if (![runUsername, artifacts.session.token].some((marker) => marker && serialized.includes(marker))) continue;
      ownedKeys.add(key);
      const sessionId = key.slice("spring:session:sessions:".length);
      markers.push(sessionId);
      const expiresKey = `spring:session:sessions:expires:${sessionId}`;
      if (redisCommand("EXISTS", expiresKey) === "1") ownedKeys.add(expiresKey);
    }
  }
  const exactMarkers = unique(markers);
  const sharedMembers = [];
  for (const key of redisScan("spring:session:expirations:*")) {
    const raw = redisCommand("SMEMBERS", key);
    const members = raw ? raw.split(/\r?\n/).filter(Boolean) : [];
    for (const member of members) {
      if (exactMarkers.some((marker) => marker && member.includes(marker))) {
        sharedMembers.push({ key, member });
      }
    }
  }
  return {
    markers: exactMarkers,
    ownedKeys: [...ownedKeys].sort().map((key) => ({ key, type: redisCommand("TYPE", key) })),
    sharedMembers: sharedMembers.sort((left, right) => `${left.key}:${left.member}`.localeCompare(`${right.key}:${right.member}`))
  };
}

function cleanupRedisSession() {
  const before = redisSessionSnapshot();
  const captured = artifacts.session.redisBeforeLogout ?? { ownedKeys: [], sharedMembers: [] };
  const capturedKeys = new Map(captured.ownedKeys.map((entry) => [entry.key, entry.type]));
  const capturedMembers = new Set(captured.sharedMembers.map((entry) => `${entry.key}\0${entry.member}`));
  for (const entry of before.ownedKeys) {
    assert(before.markers.some((marker) => marker && entry.key.includes(marker))
      && capturedKeys.get(entry.key) === entry.type,
    "A118 Redis cleanup refused a key not captured from the dedicated session", entry);
    redisCommand("DEL", entry.key);
  }
  for (const entry of before.sharedMembers) {
    assert(entry.key.startsWith("spring:session:expirations:")
      && before.markers.some((marker) => marker && entry.member.includes(marker))
      && capturedMembers.has(`${entry.key}\0${entry.member}`),
    "A118 Redis cleanup refused an unowned expiration member", entry);
    redisCommand("SREM", entry.key, entry.member);
  }
  const after = redisSessionSnapshot();
  assert(after.ownedKeys.length === 0 && after.sharedMembers.length === 0,
    "A118 Redis session cleanup must leave zero owned residue", after);
  return { before, after };
}

async function http(pathname, options = {}, cookie = artifacts.session.cookie, { retryTransientTransport = false } = {}) {
  const method = options.method ?? "GET";
  const headers = new Headers(options.headers ?? {});
  if (cookie) headers.set("Cookie", cookie);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  let lastTransportError = null;
  const attempts = retryTransientTransport ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await nativeFetch(`${apiBase}${pathname}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      });
      // A socket reset can surface while consuming the body rather than while
      // opening the request.  Keep the opt-in retry boundary around the whole
      // cleanup request so the caller never treats an unread response as a
      // successful logout/session check.
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { text };
      }
      if (method !== "GET" && artifacts.identity.userId) captureActorLogIds();
      return { ok: response.ok, status: response.status, data, text };
    } catch (error) {
      lastTransportError = error;
      // This opt-in path is used only by the idempotent logout and the
      // following unauthenticated session read.  Never apply it to business
      // writes, whose server-side outcome could be ambiguous after a socket
      // loss.  Native fetch may surface the same transport failure while
      // opening the request or consuming its body and does not guarantee a
      // stable error subclass across Node releases.
      if (!retryTransientTransport || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastTransportError ?? new Error(`A118 ${method} ${pathname} did not produce a response after retry`);
}

async function requireJson(pathname, options = {}, expected = [200, 201]) {
  const response = await http(pathname, options);
  if (!expected.includes(response.status)) {
    throw new Error(`${options.method ?? "GET"} ${pathname} failed ${response.status}: ${response.text}`);
  }
  return response.data ?? {};
}

function recordUuid(setName, value, label) {
  assertUuid(value, label);
  artifacts.ids[setName].add(String(value));
  return String(value);
}

function rowsJson(table, predicate, orderBy = "id") {
  return dbJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY ${orderBy}), '[]'::jsonb)::text
    FROM public.${table} row_value
    WHERE ${predicate}
  `) ?? [];
}

function captureActorLogIds() {
  if (!artifacts.identity.userId) return [];
  const rows = rowsJson(
    "sys_operation_log",
    `row_value.operated_by=${sqlLiteral(artifacts.identity.userId)}::uuid
      AND row_value.actor_type='USER'
      AND row_value.actor_username=${sqlLiteral(runUsername)}
      AND row_value.actor_display_name=${sqlLiteral(runDisplayName)}
      AND row_value.operated_at >= to_timestamp(${Math.floor((startedAtMs - 5_000) / 1000)})`,
    "row_value.operated_at, row_value.id"
  );
  for (const row of rows) recordUuid("logs", row.id, "A118 write-time operation-log id");
  return rows;
}

async function assertLocalHealthAndPrepareRoute() {
  assert(new URL(apiBase).hostname === "127.0.0.1", "A118 may only write through the local API");
  const health = await http("/api/system/health", {}, "");
  assert(health.status === 200 && health.data?.status === "UP", "A118 local health must be UP", health.data);
  assert(health.data?.testInventoryAdjustmentApi === true,
    "A118 requires the controlled test-only inventory adjustment capability", health.data);

  const route = dbJson(`
    SELECT jsonb_build_object(
      'accountSet', to_jsonb(account_set),
      'adminRole', to_jsonb(admin_role),
      'warehouseOne', to_jsonb(warehouse_one),
      'warehouseTwo', to_jsonb(warehouse_two),
      'supplier', to_jsonb(supplier),
      'businessDate', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date::text
    )::text
    FROM public.sys_account_set account_set
    CROSS JOIN public.sys_role admin_role
    CROSS JOIN public.md_warehouse warehouse_one
    CROSS JOIN public.md_warehouse warehouse_two
    CROSS JOIN public.md_supplier supplier
    WHERE account_set.code='BLD-TEST'
      AND admin_role.code='ADMIN'
      AND warehouse_one.code='CK-001'
      AND warehouse_two.code='CK-002'
      AND supplier.code=${sqlLiteral(supplierCode)}
  `);
  assert(route?.accountSet?.code === "BLD-TEST"
    && route.accountSet.schema_name === "public"
    && route.accountSet.enabled === true
    && route.adminRole?.code === "ADMIN"
    && route.adminRole.enabled === true
    && route.warehouseOne?.enabled === true
    && route.warehouseOne.audit_status === "AUDITED"
    && route.warehouseTwo?.enabled === true
    && route.warehouseTwo.audit_status === "AUDITED"
    && route.supplier?.enabled === true
    && route.supplier.audit_status === "AUDITED",
  "A118 route requires enabled BLD-TEST/public, ADMIN, CK-001, CK-002 and GYS-001", route);
  for (const [label, value] of [
    ["account set", route.accountSet.id],
    ["ADMIN role", route.adminRole.id],
    ["CK-001", route.warehouseOne.id],
    ["CK-002", route.warehouseTwo.id],
    [supplierCode, route.supplier.id]
  ]) assertUuid(value, `A118 ${label} id`);
  artifacts.accountSet = route.accountSet;
  artifacts.adminRole = route.adminRole;
  artifacts.warehouses = { "CK-001": route.warehouseOne, "CK-002": route.warehouseTwo };
  artifacts.supplier = route.supplier;
  artifacts.businessDate = route.businessDate;
  result.environment.health = health.data;
  result.environment.accountSet = {
    id: route.accountSet.id,
    code: route.accountSet.code,
    schemaName: route.accountSet.schema_name
  };
  result.environment.businessDate = route.businessDate;
}

function createRunIdentity() {
  assert(artifacts.accountSet && artifacts.adminRole, "A118 route must be prepared before identity creation");
  assert(dbNumber(`SELECT count(*) FROM public.sys_user WHERE username=${sqlLiteral(runUsername)}`) === 0,
    "A118 create-only run username must not pre-exist", runUsername);
  identityWriteAttempted = true;
  const created = dbJson(`
    WITH created_user AS (
      INSERT INTO public.sys_user (
        username, display_name, password_hash, enabled, default_account_set_id
      ) VALUES (
        ${sqlLiteral(runUsername)}, ${sqlLiteral(runDisplayName)}, ${sqlLiteral(`{noop}${runPassword}`)},
        TRUE, ${sqlLiteral(artifacts.accountSet.id)}::uuid
      ) RETURNING id
    ), created_role_link AS (
      INSERT INTO public.sys_user_role (user_id, role_id)
      SELECT id, ${sqlLiteral(artifacts.adminRole.id)}::uuid FROM created_user
      RETURNING user_id, role_id
    ), created_grant AS (
      INSERT INTO public.sys_user_account_set (
        user_id, account_set_id, role_code, is_default, enabled
      )
      SELECT id, ${sqlLiteral(artifacts.accountSet.id)}::uuid, 'ADMIN', TRUE, TRUE
      FROM created_user
      RETURNING id, user_id
    )
    SELECT jsonb_build_object(
      'userId', created_user.id::text,
      'grantId', created_grant.id::text,
      'roleId', created_role_link.role_id::text
    )::text
    FROM created_user
    JOIN created_role_link ON created_role_link.user_id=created_user.id
    JOIN created_grant ON created_grant.user_id=created_user.id
  `);
  assertUuid(created?.userId, "A118 run user id");
  assertUuid(created?.grantId, "A118 run grant id");
  assert(created?.roleId === artifacts.adminRole.id, "A118 run role link must target the prepared ADMIN UUID", created);
  artifacts.identity = created;
}

async function establishRunSession() {
  artifacts.session.cookie = await loginApi(apiBase, runUsername, runPassword, "BLD-TEST");
  assert(/^(?:SESSION|JSESSIONID)=[^;]+$/.test(artifacts.session.cookie),
    "A118 login must return one non-empty SESSION or JSESSIONID cookie", artifacts.session.cookie.split("=")[0]);
  captureActorLogIds();
  artifacts.session.redisBeforeLogout = redisSessionSnapshot();
  artifacts.session.redisBacked = artifacts.session.redisBeforeLogout.ownedKeys.length > 0
    || artifacts.session.redisBeforeLogout.sharedMembers.length > 0;
  artifacts.session.redisObserved = {
    ownedKeyCount: artifacts.session.redisBeforeLogout.ownedKeys.length,
    expirationMemberCount: artifacts.session.redisBeforeLogout.sharedMembers.length
  };
  result.environment.redisSession = {
    redisBacked: artifacts.session.redisBacked,
    observed: { ...artifacts.session.redisObserved }
  };
  const session = await requireJson("/api/system/session");
  assert(session?.authenticated === true
    && session.user?.username === runUsername
    && session.user?.name === runDisplayName
    && session.user?.roleCode === "ADMIN"
    && session.user?.role === "系统管理员"
    && session.tenant?.id === artifacts.accountSet.id
    && session.tenant?.code === "BLD-TEST"
    && session.tenant?.schemaName === "public",
  "A118 dedicated session must bind the exact run actor and BLD-TEST/public", session);
  const scopes = rowsJson(
    "sys_session_account_scope",
    `row_value.user_id=${sqlLiteral(artifacts.identity.userId)}::uuid`,
    "row_value.session_token"
  );
  assert(scopes.length === 1
    && scopes[0].user_id === artifacts.identity.userId
    && scopes[0].account_set_id === artifacts.accountSet.id,
  "A118 login must create one exact persisted account scope", scopes);
  assertUuid(scopes[0].session_token, "A118 session token");
  assertUuid(scopes[0].scope_token, "A118 scope token");
  artifacts.session.token = scopes[0].session_token;
  artifacts.session.scopeSnapshot = scopes[0];
  result.environment.actor = { id: artifacts.identity.userId, username: runUsername };
}

async function createProductNameCreateOnly(code, name) {
  const write = artifacts.productNameWrites[code];
  const preflight = rowsJson(
    "md_product_name",
    `row_value.code=${sqlLiteral(code)} OR row_value.name=${sqlLiteral(name)}`
  );
  if (preflight.length > 0) {
    write.preflightCollision = true;
    throw new Error(`A118 create-only product name ${code}/${name} must not pre-exist; the collision is unowned and will not be changed`);
  }
  write.attempted = true;
  const response = await http("/api/master-data/productName", {
    method: "POST",
    body: { code, name, remark: fixtureKey, status: "启用" }
  });
  if (response.status === 409) {
    write.rejected409 = true;
    throw new Error(`A118 create-only product name ${code}/${name} rejected 409; existing data is not owned and will not be overwritten`);
  }
  assert(response.status === 201, `A118 create-only product name ${code}/${name} should return 201`, response);
  const productNameId = recordUuid("productNames", response.data?.id, `A118 created product name ${code}`);
  write.accepted = true;
  write.productNameId = productNameId;
  const audited = await requireJson(`/api/master-data/productName/${encodeURIComponent(code)}/audit`, { method: "POST" });
  assert(audited?.id === productNameId
    && audited?.code === code
    && audited?.name === name
    && audited?.auditStatus === "已审核"
    && audited?.status === "启用"
    && Number(audited?.version) === 1,
  `A118 audited product name ${code} must retain the response-owned UUID and become enabled/audited`, audited);
  write.audited = true;
  return productNameId;
}

async function createProductCreateOnly(code, payload) {
  const write = artifacts.productWrites[code];
  const preflight = rowsJson("md_product", `row_value.code=${sqlLiteral(code)}`);
  if (preflight.length > 0) {
    write.preflightCollision = true;
    throw new Error(`A118 create-only product ${code} must not pre-exist; the collision is unowned and will not be changed`);
  }
  write.attempted = true;
  const response = await http("/api/master-data/product", { method: "POST", body: { code, ...payload } });
  if (response.status === 409) {
    write.rejected409 = true;
    throw new Error(`A118 create-only product ${code} rejected 409; existing data is not owned and will not be overwritten`);
  }
  assert(response.status === 201, `A118 create-only product ${code} should return 201`, response);
  const productId = recordUuid("products", response.data?.id, `A118 created product ${code}`);
  write.accepted = true;
  write.productId = productId;
  const audited = await requireJson(`/api/master-data/product/${encodeURIComponent(code)}/audit`, { method: "POST" });
  assert(audited?.id === productId, `A118 audited product ${code} must retain the response-owned UUID`, audited);
  return productId;
}

async function createMasterDataFixtures() {
  assert(productCode !== componentCode, "A118 parent/component run codes must be distinct");
  assert(productNameCode !== componentNameCode && productName !== componentName,
    "A118 parent/component product-name run fixtures must be distinct");
  const parentProductNameId = await createProductNameCreateOnly(productNameCode, productName);
  const componentProductNameId = await createProductNameCreateOnly(componentNameCode, componentName);
  assert(parentProductNameId !== componentProductNameId && artifacts.ids.productNames.size === 2,
    "A118 must create exactly one parent product name and one component product name by response UUID",
    { parentProductNameId, componentProductNameId });
  const parentProductId = await createProductCreateOnly(productCode, {
    name: productName,
    category: "成品总成",
    unit: "只",
    spec: fixtureKey,
    remark: fixtureKey,
    defaultWarehouseCode: "CK-001",
    isSale: "true",
    isInventory: "true",
    isProduce: "true",
    isSubcontract: "true",
    subcontractPrice: "12.50",
    taxRate: "13",
    status: "启用"
  });
  const componentProductId = await createProductCreateOnly(componentCode, {
    name: componentName,
    category: "零配件",
    unit: "件",
    spec: fixtureKey,
    remark: fixtureKey,
    defaultWarehouseCode: "CK-002",
    defaultSupplierCode: supplierCode,
    isPurchase: "true",
    isInventory: "true",
    isProduce: "false",
    purchasePrice: "3.20",
    taxRate: "13",
    status: "启用"
  });
  assert(parentProductId !== componentProductId && artifacts.ids.products.size === 2,
    "A118 must create exactly one parent product and one component product by response UUID",
    { parentProductId, componentProductId });
}

function captureRelatedIds(setName, table, foreignKey, headerId) {
  const rows = rowsJson(table, `row_value.${foreignKey}=${sqlLiteral(headerId)}::uuid`);
  for (const row of rows) recordUuid(setName, row.id, `A118 ${table} row id`);
  return rows;
}

function captureDocument(kind, response) {
  const definition = documentDefinitions[kind];
  const setName = `${kind}s`;
  const lineSetName = `${kind}Lines`;
  const headerId = recordUuid(setName, response?.id, `A118 ${kind} header id`);
  assert(String(response?.billNo ?? ""), `A118 ${kind} response must expose billNo`, response);
  artifacts.bills[kind] = String(response.billNo);
  if (kind === "workOrder") result.workOrderNo = artifacts.bills.workOrder;
  const lines = captureRelatedIds(lineSetName, definition.lineTable, definition.lineForeignKey, headerId);
  assert(lines.length === 1, `A118 ${kind} must create exactly one line`, lines);
  if (kind === "workOrder") {
    const components = captureRelatedIds("workOrderComponents", "outsourcing_work_order_component", "work_order_id", headerId);
    assert(components.length === 1, "A118 work order must create exactly one component", components);
  }
  return headerId;
}

function captureInventoryFacts() {
  const productIds = [...artifacts.ids.products];
  if (productIds.length === 0) return [];
  const rows = rowsJson(
    "inv_stock_txn",
    `row_value.account_set_id=${sqlLiteral(artifacts.accountSet.id)}::uuid AND row_value.product_id=ANY(${uuidArray(productIds)})`,
    "row_value.occurred_at, row_value.id"
  );
  for (const row of rows) recordUuid("transactions", row.id, "A118 inventory transaction id");
  const balances = rowsJson(
    "inv_stock_balance",
    `row_value.account_set_id=${sqlLiteral(artifacts.accountSet.id)}::uuid AND row_value.product_id=ANY(${uuidArray(productIds)})`
  );
  for (const row of balances) recordUuid("balances", row.id, "A118 inventory balance id");
  return rows;
}

async function seedStock() {
  await requireJson("/api/inventory/adjustments", {
    method: "POST",
    body: {
      productCode: componentCode,
      warehouseCode: "CK-002",
      qtyDelta: 50,
      txnType: "A118_OUTSOURCING_CHAIN_SEED",
      sourceBillType: stockSource
    }
  }, [201]);
  const rows = captureInventoryFacts().filter((row) => row.source_bill_type === stockSource);
  assert(rows.length === 1 && rows[0].trace_quality === "TEST" && Number(rows[0].qty_delta) === 50,
    "A118 seed must create one exact test-only inventory fact", rows);
}

async function listRow(listKey, billNo) {
  const resultRows = await requireJson(`/api/lists/${listKey}?keyword=${encodeURIComponent(billNo)}&pageSize=200`);
  return resultRows.rows.find((row) => row.billNo === billNo);
}

async function runFlow() {
  await createMasterDataFixtures();
  if (faultPhase === "after-products") throw new Error("A118 injected failure after isolated products");
  await seedStock();
  if (faultPhase === "after-seed") throw new Error("A118 injected failure after test-only seed");

  assert(dbNumber(`SELECT count(*) FROM public.prod_bom WHERE code=${sqlLiteral(bomCode)} OR product_id=${sqlLiteral(artifacts.productWrites[productCode].productId)}::uuid`) === 0,
    "A118 isolated BOM code/product must have no pre-existing version before create");

  const bomDraft = await requireJson("/api/production/boms", {
    method: "POST",
    body: {
      code: bomCode,
      productCode,
      qty: 1,
      bomCategory: "委外加工",
      remark: fixtureKey,
      lines: [{ materialCode: componentCode, qty: 2 }]
    }
  }, [201]);
  const bomId = recordUuid("boms", bomDraft.id, "A118 BOM response id");
  const bomLines = captureRelatedIds("bomLines", "prod_bom_line", "bom_id", bomId);
  assert(bomLines.length === 1, "A118 BOM must create one exact line", bomLines);
  const bom = await requireJson(`/api/production/boms/${encodeURIComponent(bomCode)}/audit`, { method: "POST" });
  assert(bom.id === bomId && bom.productCode === productCode,
    "A118 unique parent BOM audit must retain the response-owned BOM UUID without version-switch confirmation", bom);

  assert(dbNumber(`SELECT count(*) FROM public.outsourcing_work_order WHERE remark=${sqlLiteral(fixtureKey)}`) === 0,
    "A118 isolated outsourcing work-order marker must not pre-exist before create");

  const workOrder = await requireJson("/api/outsourcing/work-orders/draft", {
    method: "POST",
    body: {
      supplierCode,
      productCode,
      qty: 3,
      planDeliveryDate,
      remark: fixtureKey
    }
  }, [201]);
  captureDocument("workOrder", workOrder);
  const generatedWorkOrderNo = artifacts.bills.workOrder;
  assert(workOrder.billNo === generatedWorkOrderNo && generatedWorkOrderNo.startsWith("WWJG"),
    "outsourcing work order must use the system-generated bill number returned by the 201 response", workOrder);
  assert(workOrder.status === "DRAFT", "saved outsourcing work order should be draft before audit");
  assert(workOrder.components?.length === 1 && Number(workOrder.components[0].qty) === 6,
    "outsourcing work order should expand one BOM child with required qty 6", workOrder.components);
  const draftWorkOrderDetail = await requireJson(`/api/outsourcing/work-orders/${encodeURIComponent(generatedWorkOrderNo)}`);
  assert(draftWorkOrderDetail.lines?.length === 1 && draftWorkOrderDetail.components?.length === 1,
    "work order detail should include one parent line and one component line", draftWorkOrderDetail);
  assert(draftWorkOrderDetail.components[0].productCode === componentCode,
    "work order detail component should use the isolated BOM child", draftWorkOrderDetail.components[0]);

  await requireJson(`/api/outsourcing/work-orders/${encodeURIComponent(generatedWorkOrderNo)}/audit`, { method: "POST" });
  const issueSources = await requireJson("/api/outsourcing/work-orders/sources?target=issue");
  assert(issueSources.some((row) => row.billNo === generatedWorkOrderNo && Number(row.remainingQty) === 6),
    "audited work order should be selectable for issue with remaining component qty");
  const issue = await requireJson(`/api/outsourcing/work-orders/${encodeURIComponent(generatedWorkOrderNo)}/push-issue`, { method: "POST" }, [201]);
  captureDocument("issue", issue);
  assert(String(issue.billNo).startsWith("WWFL"), "work order should push to outsourcing material issue");
  const issueDetail = await requireJson(`/api/outsourcing/issues/${encodeURIComponent(issue.billNo)}`);
  assert(issueDetail.lines?.length === 1
    && issueDetail.lines[0].productCode === componentCode
    && Number(issueDetail.lines[0].qty) === 6,
  "outsourcing issue should contain the isolated BOM component qty 6", issueDetail.lines);
  await requireJson(`/api/outsourcing/issues/${encodeURIComponent(issue.billNo)}/audit`, { method: "POST" });
  captureInventoryFacts();
  const issueSourcesAfterAudit = await requireJson("/api/outsourcing/work-orders/sources?target=issue");
  assert(!issueSourcesAfterAudit.some((row) => row.billNo === generatedWorkOrderNo),
    "fully issued work order should no longer be selectable for issue");

  const receiptSources = await requireJson("/api/outsourcing/work-orders/sources?target=receipt");
  assert(receiptSources.some((row) => row.billNo === generatedWorkOrderNo && Number(row.remainingQty) === 3),
    "audited work order should be selectable for receipt with remaining parent qty");
  const receipt = await requireJson(`/api/outsourcing/work-orders/${encodeURIComponent(generatedWorkOrderNo)}/push-receipt`, {
    method: "POST",
    body: { qty: 3 }
  }, [201]);
  captureDocument("receipt", receipt);
  assert(String(receipt.billNo).startsWith("WWRK"), "work order should push to outsourcing product receipt");
  const receiptDetail = await requireJson(`/api/outsourcing/receipts/${encodeURIComponent(receipt.billNo)}`);
  assert(receiptDetail.lines?.length === 1 && Number(receiptDetail.lines[0].qty) === 3,
    "receipt detail should include requested qty 3", receiptDetail.lines);
  await requireJson(`/api/outsourcing/receipts/${encodeURIComponent(receipt.billNo)}/audit`, { method: "POST" });
  captureInventoryFacts();
  const adjustmentSources = await requireJson("/api/outsourcing/receipts/sources?target=return");
  assert(adjustmentSources.some((row) => row.billNo === receipt.billNo && Number(row.remainingQty) === 3),
    "audited receipt should be selectable for return/scrap with remaining qty");

  const returnBill = await requireJson(`/api/outsourcing/receipts/${encodeURIComponent(receipt.billNo)}/push-return`, {
    method: "POST",
    body: { qty: 1 }
  }, [201]);
  captureDocument("return", returnBill);
  assert(String(returnBill.billNo).startsWith("WWTH"), "receipt should push to outsourcing product return");
  const returnDetail = await requireJson(`/api/outsourcing/returns/${encodeURIComponent(returnBill.billNo)}`);
  assert(returnDetail.lines?.length === 1 && Number(returnDetail.lines[0].qty) === 1,
    "return detail should include selected qty 1", returnDetail.lines);
  await requireJson(`/api/outsourcing/returns/${encodeURIComponent(returnBill.billNo)}/audit`, { method: "POST" });
  captureInventoryFacts();

  const scrap = await requireJson(`/api/outsourcing/receipts/${encodeURIComponent(receipt.billNo)}/push-scrap`, {
    method: "POST",
    body: { qty: 1 }
  }, [201]);
  captureDocument("scrap", scrap);
  assert(String(scrap.billNo).startsWith("WWBF"), "receipt should push to outsourcing product scrap");
  const scrapDetail = await requireJson(`/api/outsourcing/scraps/${encodeURIComponent(scrap.billNo)}`);
  assert(scrapDetail.lines?.length === 1 && Number(scrapDetail.lines[0].qty) === 1,
    "scrap detail should include selected qty 1", scrapDetail.lines);
  await requireJson(`/api/outsourcing/scraps/${encodeURIComponent(scrap.billNo)}/audit`, { method: "POST" });
  captureInventoryFacts();

  const workOrderRow = await listRow("outsourcing-work-order-list", generatedWorkOrderNo);
  const issueRow = await listRow("outsourcing-issue-list", issue.billNo);
  const receiptRow = await listRow("outsourcing-receipt-list", receipt.billNo);
  const returnRow = await listRow("outsourcing-return-list", returnBill.billNo);
  const scrapRow = await listRow("outsourcing-scrap-list", scrap.billNo);
  assert([workOrderRow, issueRow, receiptRow, returnRow, scrapRow].every((row) => row?.status === "已审核"),
    "all outsourcing list rows should show audited status", { workOrderRow, issueRow, receiptRow, returnRow, scrapRow });

  await requireJson(`/api/outsourcing/scraps/${encodeURIComponent(scrap.billNo)}/reverse`, { method: "POST" });
  await requireJson(`/api/outsourcing/returns/${encodeURIComponent(returnBill.billNo)}/reverse`, { method: "POST" });
  const parentReverseBoundary = await http(`/api/outsourcing/receipts/${encodeURIComponent(receipt.billNo)}/reverse`, { method: "POST" });
  assert(parentReverseBoundary.status === 409,
    "A118 must make the current missing DRAFT child-cleanup boundary explicit before parent reverse", parentReverseBoundary);
  const finalTransactions = captureInventoryFacts();

  const reversedRows = {
    workOrder: await listRow("outsourcing-work-order-list", generatedWorkOrderNo),
    issue: await listRow("outsourcing-issue-list", issue.billNo),
    receipt: await listRow("outsourcing-receipt-list", receipt.billNo),
    return: await listRow("outsourcing-return-list", returnBill.billNo),
    scrap: await listRow("outsourcing-scrap-list", scrap.billNo)
  };
  assert(reversedRows.workOrder?.status === "已审核"
    && reversedRows.issue?.status === "已审核"
    && reversedRows.receipt?.status === "已审核"
    && reversedRows.return?.status === "草稿"
    && reversedRows.scrap?.status === "草稿",
  "A118 must use the unified reverse-to-DRAFT wording and retain audited ancestors at the current cleanup boundary", reversedRows);

  result.checks = {
    bomExpandedQty: Number(workOrder.components[0].qty) === 6,
    isolatedProductCodes: productCode !== "CP-001" && componentCode !== "PJ-014",
    issueUsesBomComponent: issueDetail.lines[0].productCode === componentCode,
    sourceRemainingGuard: !issueSourcesAfterAudit.some((row) => row.billNo === generatedWorkOrderNo),
    reverseToDraftStatus: reversedRows.return.status === "草稿" && reversedRows.scrap.status === "草稿",
    parentReverseBoundary: {
      status: parentReverseBoundary.status,
      reason: "委外单据当前没有 DRAFT 删除/作废动作，DRAFT 子单仍阻断父单反审核",
      auditedAncestors: [generatedWorkOrderNo, issue.billNo, receipt.billNo],
      draftLeaves: [returnBill.billNo, scrap.billNo]
    },
    inventoryFactsCaptured: finalTransactions.length === artifacts.ids.transactions.size
  };
}

function aggregateSql(tableExpression, alias, predicate, orderBy) {
  return `COALESCE((
    SELECT jsonb_agg(to_jsonb(${alias}) ORDER BY ${orderBy})
    FROM ${tableExpression} ${alias}
    WHERE ${predicate}
  ), '[]'::jsonb)`;
}

function allDocumentIds() {
  return unique([
    ...artifacts.ids.workOrders,
    ...artifacts.ids.issues,
    ...artifacts.ids.receipts,
    ...artifacts.ids.returns,
    ...artifacts.ids.scraps
  ]);
}

function allTargetIds() {
  return unique([
    artifacts.identity.userId,
    ...artifacts.ids.productNames,
    ...artifacts.ids.products,
    ...artifacts.ids.boms,
    ...allDocumentIds()
  ]);
}

function allBillNos() {
  return unique(Object.values(artifacts.bills));
}

function allTargetNos() {
  return unique([
    runUsername,
    productNameCode,
    componentNameCode,
    productCode,
    componentCode,
    bomCode,
    ...allBillNos()
  ]);
}

function cleanupSnapshotExpression() {
  const userIds = uuidArray([artifacts.identity.userId]);
  const productNameIds = uuidArray([...artifacts.ids.productNames]);
  const productNameCodes = textArray([productNameCode, componentNameCode]);
  const productNameValues = textArray([productName, componentName]);
  const acceptedProductNameValues = textArray(Object.entries(artifacts.productNameWrites)
    .filter(([, write]) => write.accepted)
    .map(([code]) => expectedProductNames[code].name));
  const productIds = uuidArray([...artifacts.ids.products]);
  const productCodes = textArray([productCode, componentCode]);
  const bomIds = uuidArray([...artifacts.ids.boms]);
  const workOrderIds = uuidArray([...artifacts.ids.workOrders]);
  const issueIds = uuidArray([...artifacts.ids.issues]);
  const receiptIds = uuidArray([...artifacts.ids.receipts]);
  const returnIds = uuidArray([...artifacts.ids.returns]);
  const scrapIds = uuidArray([...artifacts.ids.scraps]);
  const targetIds = uuidArray(allTargetIds());
  const targetNos = textArray(allTargetNos());
  const billNos = textArray(allBillNos());
  const sessionTokens = uuidArray([artifacts.session.token]);
  const bomCandidates = `SELECT id FROM public.prod_bom WHERE id=ANY(${bomIds}) OR code=${sqlLiteral(bomCode)}`;
  const workOrderCandidates = `SELECT id FROM public.outsourcing_work_order WHERE id=ANY(${workOrderIds}) OR (${artifacts.bills.workOrder ? `bill_no=${sqlLiteral(artifacts.bills.workOrder)} OR ` : ""}remark=${sqlLiteral(fixtureKey)})`;
  const issueCandidates = `SELECT id FROM public.outsourcing_material_issue WHERE id=ANY(${issueIds}) OR source_work_order_id IN (${workOrderCandidates})`;
  const receiptCandidates = `SELECT id FROM public.outsourcing_receipt WHERE id=ANY(${receiptIds}) OR source_work_order_id IN (${workOrderCandidates})`;
  const returnCandidates = `SELECT id FROM public.outsourcing_return WHERE id=ANY(${returnIds}) OR source_receipt_id IN (${receiptCandidates})`;
  const scrapCandidates = `SELECT id FROM public.outsourcing_scrap WHERE id=ANY(${scrapIds}) OR source_receipt_id IN (${receiptCandidates})`;
  return `jsonb_build_object(
    'accountSets', ${aggregateSql(
      "public.sys_account_set", "account_set",
      `account_set.id=${sqlLiteral(artifacts.accountSet?.id)}::uuid OR account_set.code='BLD-TEST'`,
      "account_set.id"
    )},
    'adminRoles', ${aggregateSql(
      "public.sys_role", "admin_role",
      `admin_role.id=${sqlLiteral(artifacts.adminRole?.id)}::uuid OR admin_role.code='ADMIN'`,
      "admin_role.id"
    )},
    'warehouses', ${aggregateSql(
      "public.md_warehouse", "warehouse_row",
      `warehouse_row.id=ANY(${uuidArray(Object.values(artifacts.warehouses).map((row) => row?.id))}) OR warehouse_row.code=ANY(${textArray(["CK-001", "CK-002"])})`,
      "warehouse_row.id"
    )},
    'suppliers', ${aggregateSql(
      "public.md_supplier", "supplier_row",
      `supplier_row.id=${sqlLiteral(artifacts.supplier?.id)}::uuid OR supplier_row.code=${sqlLiteral(supplierCode)}`,
      "supplier_row.id"
    )},
    'users', ${aggregateSql(
      "public.sys_user", "app_user",
      `app_user.id=ANY(${userIds}) OR app_user.username=${sqlLiteral(runUsername)}`,
      "app_user.id"
    )},
    'roleLinks', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('link', to_jsonb(user_role), 'role', to_jsonb(role_row)) ORDER BY user_role.user_id, user_role.role_id)
      FROM public.sys_user_role user_role
      JOIN public.sys_role role_row ON role_row.id=user_role.role_id
      WHERE user_role.user_id=ANY(${userIds})
         OR user_role.user_id IN (SELECT id FROM public.sys_user WHERE username=${sqlLiteral(runUsername)})
    ), '[]'::jsonb),
    'grants', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('grant', to_jsonb(user_grant), 'accountSet', to_jsonb(account_set)) ORDER BY user_grant.id)
      FROM public.sys_user_account_set user_grant
      JOIN public.sys_account_set account_set ON account_set.id=user_grant.account_set_id
      WHERE user_grant.user_id=ANY(${userIds})
         OR user_grant.user_id IN (SELECT id FROM public.sys_user WHERE username=${sqlLiteral(runUsername)})
    ), '[]'::jsonb),
    'sessionScopes', ${aggregateSql(
      "public.sys_session_account_scope", "session_scope",
      `session_scope.user_id=ANY(${userIds}) OR session_scope.session_token=ANY(${sessionTokens})`,
      "session_scope.session_token"
    )},
    'productNames', ${aggregateSql(
      "public.md_product_name", "product_name_row",
      `product_name_row.id=ANY(${productNameIds}) OR product_name_row.code=ANY(${productNameCodes}) OR product_name_row.name=ANY(${productNameValues})`,
      "product_name_row.id"
    )},
    'products', ${aggregateSql(
      "public.md_product", "product_row",
      `product_row.id=ANY(${productIds}) OR product_row.code=ANY(${productCodes}) OR product_row.name=ANY(${acceptedProductNameValues})`,
      "product_row.id"
    )},
    'boms', ${aggregateSql(
      "public.prod_bom", "bom_row",
      `bom_row.id=ANY(${bomIds}) OR bom_row.code=${sqlLiteral(bomCode)} OR bom_row.product_id=ANY(${productIds})`,
      "bom_row.id"
    )},
    'bomLines', ${aggregateSql(
      "public.prod_bom_line", "bom_line",
      `bom_line.id=ANY(${uuidArray([...artifacts.ids.bomLines])}) OR bom_line.bom_id IN (${bomCandidates})`,
      "bom_line.id"
    )},
    'workOrders', ${aggregateSql(
      "public.outsourcing_work_order", "work_order",
      `work_order.id=ANY(${workOrderIds}) OR (${artifacts.bills.workOrder ? `work_order.bill_no=${sqlLiteral(artifacts.bills.workOrder)} OR ` : ""}work_order.remark=${sqlLiteral(fixtureKey)})`,
      "work_order.id"
    )},
    'workOrderLines', ${aggregateSql(
      "public.outsourcing_work_order_line", "work_order_line",
      `work_order_line.id=ANY(${uuidArray([...artifacts.ids.workOrderLines])}) OR work_order_line.work_order_id IN (${workOrderCandidates})`,
      "work_order_line.id"
    )},
    'workOrderComponents', ${aggregateSql(
      "public.outsourcing_work_order_component", "work_order_component",
      `work_order_component.id=ANY(${uuidArray([...artifacts.ids.workOrderComponents])}) OR work_order_component.work_order_id IN (${workOrderCandidates})`,
      "work_order_component.id"
    )},
    'issues', ${aggregateSql(
      "public.outsourcing_material_issue", "issue_row",
      `issue_row.id=ANY(${issueIds}) OR issue_row.source_work_order_id=ANY(${workOrderIds})`,
      "issue_row.id"
    )},
    'issueLines', ${aggregateSql(
      "public.outsourcing_material_issue_line", "issue_line",
      `issue_line.id=ANY(${uuidArray([...artifacts.ids.issueLines])}) OR issue_line.issue_id IN (${issueCandidates})`,
      "issue_line.id"
    )},
    'receipts', ${aggregateSql(
      "public.outsourcing_receipt", "receipt_row",
      `receipt_row.id=ANY(${receiptIds}) OR receipt_row.source_work_order_id=ANY(${workOrderIds})`,
      "receipt_row.id"
    )},
    'receiptLines', ${aggregateSql(
      "public.outsourcing_receipt_line", "receipt_line",
      `receipt_line.id=ANY(${uuidArray([...artifacts.ids.receiptLines])}) OR receipt_line.receipt_id IN (${receiptCandidates})`,
      "receipt_line.id"
    )},
    'returns', ${aggregateSql(
      "public.outsourcing_return", "return_row",
      `return_row.id=ANY(${returnIds}) OR return_row.source_receipt_id=ANY(${receiptIds})`,
      "return_row.id"
    )},
    'returnLines', ${aggregateSql(
      "public.outsourcing_return_line", "return_line",
      `return_line.id=ANY(${uuidArray([...artifacts.ids.returnLines])}) OR return_line.return_id IN (${returnCandidates})`,
      "return_line.id"
    )},
    'scraps', ${aggregateSql(
      "public.outsourcing_scrap", "scrap_row",
      `scrap_row.id=ANY(${scrapIds}) OR scrap_row.source_receipt_id=ANY(${receiptIds})`,
      "scrap_row.id"
    )},
    'scrapLines', ${aggregateSql(
      "public.outsourcing_scrap_line", "scrap_line",
      `scrap_line.id=ANY(${uuidArray([...artifacts.ids.scrapLines])}) OR scrap_line.scrap_id IN (${scrapCandidates})`,
      "scrap_line.id"
    )},
    'transactions', ${aggregateSql(
      "public.inv_stock_txn", "stock_txn",
      `stock_txn.id=ANY(${uuidArray([...artifacts.ids.transactions])}) OR stock_txn.product_id=ANY(${productIds})`,
      "stock_txn.occurred_at, stock_txn.id"
    )},
    'balances', ${aggregateSql(
      "public.inv_stock_balance", "stock_balance",
      `stock_balance.id=ANY(${uuidArray([...artifacts.ids.balances])}) OR stock_balance.product_id=ANY(${productIds})`,
      "stock_balance.id"
    )},
    'logs', ${aggregateSql(
      "public.sys_operation_log", "operation_log",
      `(operation_log.operated_by=ANY(${userIds}) AND operation_log.actor_username=${sqlLiteral(runUsername)})
       OR operation_log.target_id=ANY(${targetIds}) OR operation_log.target_no=ANY(${targetNos})`,
      "operation_log.id"
    )},
    'locks', ${aggregateSql(
      "public.doc_edit_lock", "edit_lock",
      `(edit_lock.holder_user_id=ANY(${userIds}) AND edit_lock.holder_username=${sqlLiteral(runUsername)})
       OR edit_lock.bill_no=ANY(${billNos})`,
      "edit_lock.document_type, edit_lock.bill_no"
    )}
  )`;
}

function validateIdentityState(state) {
  assert(state.accountSets.length === 1 && jsonEqual(state.accountSets[0], artifacts.accountSet),
    "A118 cleanup requires the complete unchanged BLD-TEST/public account-set snapshot", state.accountSets);
  assert(state.adminRoles.length === 1 && jsonEqual(state.adminRoles[0], artifacts.adminRole),
    "A118 cleanup requires the complete unchanged ADMIN role snapshot", state.adminRoles);
  const expectedWarehouses = Object.values(artifacts.warehouses).sort((left, right) => String(left.id).localeCompare(String(right.id)));
  assert(jsonEqual(state.warehouses, expectedWarehouses),
    "A118 cleanup requires complete unchanged CK-001/CK-002 snapshots", state.warehouses);
  assert(state.suppliers.length === 1 && jsonEqual(state.suppliers[0], artifacts.supplier),
    "A118 cleanup requires the complete unchanged GYS-001 snapshot", state.suppliers);
  assert(state.users.length === 1, "A118 cleanup requires exactly one dedicated run user", state.users);
  const user = state.users[0];
  assert(user.id === artifacts.identity.userId
    && user.username === runUsername
    && user.display_name === runDisplayName
    && user.password_hash === `{noop}${runPassword}`
    && user.enabled === true
    && user.default_account_set_id === artifacts.accountSet.id
    && (user.active_session_token === null || user.active_session_token === artifacts.session.token),
  "A118 cleanup refused a changed or ambiguous run user snapshot", user);
  assert(state.roleLinks.length === 1
    && state.roleLinks[0].link.user_id === user.id
    && state.roleLinks[0].link.role_id === artifacts.adminRole.id
    && jsonEqual(state.roleLinks[0].role, artifacts.adminRole),
  "A118 cleanup requires one complete unchanged ADMIN role link", state.roleLinks);
  assert(state.grants.length === 1
    && state.grants[0].grant.id === artifacts.identity.grantId
    && state.grants[0].grant.user_id === user.id
    && state.grants[0].grant.account_set_id === artifacts.accountSet.id
    && state.grants[0].grant.role_code === "ADMIN"
    && state.grants[0].grant.is_default === true
    && state.grants[0].grant.enabled === true
    && jsonEqual(state.grants[0].accountSet, artifacts.accountSet),
  "A118 cleanup requires one complete unchanged BLD-TEST ADMIN grant", state.grants);
  assert(state.sessionScopes.length <= 1, "A118 cleanup refused multiple persisted scopes for the run actor", state.sessionScopes);
  for (const scope of state.sessionScopes) {
    assert(artifacts.session.scopeSnapshot
      && jsonEqual(scope, artifacts.session.scopeSnapshot)
      && scope.user_id === user.id
      && scope.account_set_id === artifacts.accountSet.id,
    "A118 cleanup refused a changed or unowned session scope", scope);
  }
}

function ownedProductNameSemantic(productNameRow, code, expected, write) {
  const draft = productNameRow.audit_status === "DRAFT" && Number(productNameRow.version) === 0;
  const audited = productNameRow.audit_status === "AUDITED" && Number(productNameRow.version) === 1;
  return productNameRow.code === code
    && productNameRow.name === expected.name
    && productNameRow.remark === fixtureKey
    && productNameRow.enabled === true
    && (write.audited ? audited : (draft || audited))
    && Date.parse(productNameRow.created_at) >= startedAtMs - 5_000
    && Date.parse(productNameRow.updated_at) >= Date.parse(productNameRow.created_at);
}

function validateProductNames(state) {
  const expectedEntries = Object.entries(expectedProductNames);
  assert(state.productNames.length <= 4,
    "A118 cleanup refused more than the run code/name product-name candidates", state.productNames);
  for (const [code, expected] of expectedEntries) {
    assert(state.productNames.filter((row) => row.code === code).length <= 1,
      `A118 cleanup refused duplicate product-name code ${code}`, state.productNames);
    assert(state.productNames.filter((row) => row.name === expected.name).length <= 1,
      `A118 cleanup refused duplicate product-name value ${expected.name}`, state.productNames);
  }
  for (const productNameRow of state.productNames) {
    const matches = expectedEntries.filter(([code, expected]) => (
      productNameRow.code === code || productNameRow.name === expected.name
    ));
    assert(matches.length === 1,
      "A118 cleanup found an ambiguous product-name candidate outside one exact run fixture", productNameRow);
    const [code, expected] = matches[0];
    const write = artifacts.productNameWrites[code];
    if (!artifacts.ids.productNames.has(productNameRow.id)) {
      if (write.rejected409 || write.preflightCollision) continue;
      assert(false,
        "A118 cleanup refuses a response-loss product-name UUID; the candidate is preserved for manual review",
        { productNameRow, write });
    }
    assert(write.accepted
      && write.productNameId === productNameRow.id
      && ownedProductNameSemantic(productNameRow, code, expected, write),
    "A118 cleanup refused a changed response-owned product-name semantic snapshot", productNameRow);
  }
  for (const productNameId of artifacts.ids.productNames) {
    assert(state.productNames.some((row) => row.id === productNameId),
      "A118 cleanup is missing a response-owned product-name UUID", productNameId);
  }
}

function ownedProductSemantic(product, expected) {
  const expectedSupplierId = expected.defaultSupplierCode ? artifacts.supplier.id : null;
  return product.name === expected.name
    && product.spec === fixtureKey
    && product.remark === fixtureKey
    && product.category === expected.category
    && product.unit === expected.unit
    && product.default_warehouse_code === expected.defaultWarehouseCode
    && product.default_warehouse_id === artifacts.warehouses[expected.defaultWarehouseCode].id
    && product.default_supplier_code === expected.defaultSupplierCode
    && product.default_supplier_id === expectedSupplierId
    && product.sale_unit === expected.unit
    && product.purchase_unit === expected.unit
    && product.bom_unit === expected.unit
    && product.issue_method === "按单领料"
    && product.is_purchase === expected.isPurchase
    && product.is_sale === expected.isSale
    && product.is_inventory === expected.isInventory
    && product.is_produce === expected.isProduce
    && product.is_subcontract === expected.isSubcontract
    && Number(product.tax_rate) === 13
    && (expected.purchasePrice === null ? product.purchase_price === null : Number(product.purchase_price) === expected.purchasePrice)
    && (expected.subcontractPrice === null ? product.subcontract_price === null : Number(product.subcontract_price) === expected.subcontractPrice)
    && product.enabled === true
    && ["DRAFT", "AUDITED"].includes(product.audit_status)
    && Date.parse(product.created_at) >= startedAtMs - 5_000;
}

function validateProductsAndBom(state) {
  const acceptedProductNameValues = new Set(Object.entries(artifacts.productNameWrites)
    .filter(([, write]) => write.accepted)
    .map(([code]) => expectedProductNames[code].name));
  assert(state.products.length <= 2, "A118 cleanup refused more than the two run-code product candidates", state.products);
  for (const code of [productCode, componentCode]) {
    assert(state.products.filter((row) => row.code === code).length <= 1,
      `A118 cleanup refused duplicate product code ${code}`, state.products);
  }
  for (const product of state.products) {
    const expected = expectedProducts[product.code];
    assert(expected, "A118 cleanup found a product outside the two run-unique codes", product);
    const write = artifacts.productWrites[product.code];
    if (!artifacts.ids.products.has(product.id)) {
      if (write.rejected409 || write.preflightCollision) {
        assert(!acceptedProductNameValues.has(product.name),
          "A118 cleanup refuses to delete an accepted product name consumed by a collision-owned product",
          { product, write });
        continue;
      }
      assert(false,
        "A118 cleanup refuses response-loss product ownership; unknown UUID is preserved for manual review", product);
    }
    assert(write.accepted && write.productId === product.id && ownedProductSemantic(product, expected),
      "A118 cleanup refused a changed response-owned product semantic snapshot", product);
  }
  for (const productId of artifacts.ids.products) {
    assert(state.products.some((row) => row.id === productId),
      "A118 cleanup is missing a response-owned product UUID", productId);
  }

  assert(state.boms.length <= 1, "A118 cleanup refused multiple BOM candidates", state.boms);
  const parentId = artifacts.productWrites[productCode].productId;
  for (const bom of state.boms) {
    const exactRunBom = bom.code === bomCode
      && bom.product_id === parentId
      && Number(bom.qty) === 1
      && bom.enabled === true
      && Number(bom.version_no) === 1
      && bom.bom_category === "委外加工"
      && bom.remark === fixtureKey
      && ["DRAFT", "AUDITED"].includes(bom.audit_status)
      && bom.is_current === (bom.audit_status === "AUDITED")
      && bom.updated_by === artifacts.identity.userId
      && Date.parse(bom.created_at) >= startedAtMs - 5_000;
    if (!artifacts.ids.boms.has(bom.id)) {
      if (!exactRunBom) {
        assert(!artifacts.ids.products.has(bom.product_id),
          "A118 cleanup refused an unowned BOM referencing a response-owned fixture product", bom);
        continue;
      }
      assert(false,
        "A118 cleanup refuses response-loss BOM ownership; unknown UUID is preserved for manual review", bom);
    }
    assert(exactRunBom, "A118 cleanup refused a changed response-owned BOM semantic snapshot", bom);
  }
  for (const bomId of artifacts.ids.boms) {
    assert(state.boms.some((row) => row.id === bomId), "A118 cleanup is missing a response-owned BOM UUID", bomId);
  }

  const ownedBomIds = new Set(state.boms.filter((row) => artifacts.ids.boms.has(row.id)).map((row) => row.id));
  const ownedBomLines = state.bomLines.filter((line) => ownedBomIds.has(line.bom_id));
  assert(ownedBomLines.length === ownedBomIds.size,
    "A118 cleanup requires exactly one line for each owned BOM", ownedBomLines);
  for (const line of ownedBomLines) {
    assert(artifacts.ids.bomLines.has(line.id),
      "A118 cleanup refuses an owned-BOM line whose UUID was not captured during the write", line);
    assert(line.material_id === artifacts.productWrites[componentCode].productId
      && Number(line.line_no) === 1
      && Number(line.qty) === 2
      && Number(line.product_qty) === 1
      && Number(line.material_qty) === 2
      && Number(line.unit_qty) === 2
      && line.issue_method === "按单领料"
      && line.issue_warehouse_id === artifacts.warehouses["CK-002"].id
      && line.issue_warehouse_code === "CK-002"
      && Number(line.fixed_loss_qty) === 0
      && Number(line.loss_rate) === 0
      && line.child_bom_id === null,
    "A118 cleanup refused a changed owned BOM-line semantic snapshot", line);
  }
  for (const lineId of artifacts.ids.bomLines) {
    assert(state.bomLines.some((row) => row.id === lineId && ownedBomIds.has(row.bom_id)),
      "A118 cleanup is missing an owned BOM-line UUID", lineId);
  }
}

function validDocumentHeaderBase(row) {
  return row.supplier_id === artifacts.supplier.id
    && row.supplier_code_snapshot === supplierCode
    && row.supplier_name_snapshot === artifacts.supplier.name
    && row.bill_date === artifacts.businessDate
    && ["DRAFT", "AUDITED"].includes(row.status)
    && ((row.status === "DRAFT" && [0, 2].includes(Number(row.version)))
      || (row.status === "AUDITED" && Number(row.version) === 1))
    && Date.parse(row.created_at) >= startedAtMs - 5_000;
}

function claimDocumentHeader(kind, rows, exactSemantic) {
  const setName = `${kind}s`;
  assert(rows.length <= 1, `A118 cleanup refused multiple ${kind} header candidates`, rows);
  for (const row of rows) {
    const exact = exactSemantic(row);
    if (!artifacts.ids[setName].has(row.id)) {
      const suspectedResponseLoss = exact || (kind === "workOrder" && row.remark === fixtureKey);
      assert(!suspectedResponseLoss && artifacts.ids[setName].size === 0,
        `A118 cleanup refuses response-loss ${kind} ownership; unknown UUID is preserved`, row);
      return null;
    }
    assert(exact && artifacts.bills[kind] === row.bill_no,
      `A118 cleanup refused a changed response-owned ${kind} header`, row);
    return row;
  }
  for (const id of artifacts.ids[setName]) {
    assert(false, `A118 cleanup is missing response-owned ${kind} header ${id}`);
  }
  return null;
}

function ownedLines(rows, parentKey, parentId, setName, label) {
  if (!parentId) {
    assert([...artifacts.ids[setName]].every((id) => rows.some((row) => row.id === id)),
      `A118 cleanup is missing a captured ${label} without a captured parent`, [...artifacts.ids[setName]]);
    return [];
  }
  const owned = rows.filter((row) => row[parentKey] === parentId);
  assert(owned.length === 1, `A118 cleanup requires one exact ${label}`, owned);
  assert(artifacts.ids[setName].has(owned[0].id),
    `A118 cleanup refuses ${label} whose UUID was not captured during the write`, owned[0]);
  for (const id of artifacts.ids[setName]) {
    assert(rows.some((row) => row.id === id && row[parentKey] === parentId),
      `A118 cleanup is missing captured ${label} ${id}`);
  }
  return owned;
}

function validateDocuments(state) {
  const parentId = artifacts.productWrites[productCode].productId;
  const componentId = artifacts.productWrites[componentCode].productId;
  const bomId = [...artifacts.ids.boms][0];

  const workOrder = claimDocumentHeader("workOrder", state.workOrders, (row) => validDocumentHeaderBase(row)
    && row.bill_no === artifacts.bills.workOrder
    && row.remark === fixtureKey
    && row.source_completion_id === null
    && row.source_bill_no === null);
  const workOrderLines = ownedLines(
    state.workOrderLines, "work_order_id", workOrder?.id, "workOrderLines", "work-order parent line"
  );
  const workOrderComponents = ownedLines(
    state.workOrderComponents, "work_order_id", workOrder?.id, "workOrderComponents", "work-order component"
  );
  if (workOrder) {
    const line = workOrderLines[0];
    assert(line.line_no === 1
      && line.product_id === parentId
      && line.product_code_snapshot === productCode
      && line.product_name_snapshot === productName
      && line.product_spec_snapshot === fixtureKey
      && line.product_unit_snapshot === expectedProducts[productCode].unit
      && line.bom_id === bomId
      && line.bom_code_snapshot === bomCode
      && Number(line.bom_version_no) === 1
      && line.warehouse_id === artifacts.warehouses["CK-001"].id
      && line.warehouse_code_snapshot === "CK-001"
      && Number(line.qty) === 3
      && Number(line.issued_qty) === 0
      && [0, 3].includes(Number(line.received_qty))
      && line.plan_delivery_date === planDeliveryDate,
    "A118 cleanup refused a changed work-order parent-line semantic snapshot", line);
    const component = workOrderComponents[0];
    assert(component.line_no === 1
      && component.source_bom_line_id === [...artifacts.ids.bomLines][0]
      && component.product_id === componentId
      && component.product_code_snapshot === componentCode
      && component.product_name_snapshot === componentName
      && component.product_spec_snapshot === fixtureKey
      && component.product_unit_snapshot === expectedProducts[componentCode].unit
      && component.warehouse_id === artifacts.warehouses["CK-002"].id
      && component.warehouse_code_snapshot === "CK-002"
      && Number(component.unit_qty) === 2
      && Number(component.required_qty) === 6
      && [0, 6].includes(Number(component.issued_qty)),
    "A118 cleanup refused a changed work-order component semantic snapshot", component);
  }

  const issue = claimDocumentHeader("issue", state.issues, (row) => validDocumentHeaderBase(row)
    && workOrder
    && row.bill_no.startsWith("WWFL")
    && row.source_work_order_id === workOrder.id
    && row.source_work_order_no === workOrder.bill_no);
  const issueLines = ownedLines(state.issueLines, "issue_id", issue?.id, "issueLines", "outsourcing issue line");
  if (issue) {
    const line = issueLines[0];
    assert(line.line_no === 1
      && line.source_component_id === workOrderComponents[0].id
      && line.product_id === componentId
      && line.product_code_snapshot === componentCode
      && line.product_name_snapshot === componentName
      && line.product_spec_snapshot === fixtureKey
      && line.product_unit_snapshot === expectedProducts[componentCode].unit
      && line.warehouse_id === artifacts.warehouses["CK-002"].id
      && line.warehouse_code_snapshot === "CK-002"
      && Number(line.qty) === 6,
    "A118 cleanup refused a changed outsourcing issue-line semantic snapshot", line);
  }

  const receipt = claimDocumentHeader("receipt", state.receipts, (row) => validDocumentHeaderBase(row)
    && workOrder
    && row.bill_no.startsWith("WWRK")
    && row.source_work_order_id === workOrder.id
    && row.source_work_order_no === workOrder.bill_no);
  const receiptLines = ownedLines(state.receiptLines, "receipt_id", receipt?.id, "receiptLines", "outsourcing receipt line");
  if (receipt) {
    const line = receiptLines[0];
    assert(line.line_no === 1
      && line.source_work_order_line_id === workOrderLines[0].id
      && line.product_id === parentId
      && line.product_code_snapshot === productCode
      && line.product_name_snapshot === productName
      && line.product_spec_snapshot === fixtureKey
      && line.product_unit_snapshot === expectedProducts[productCode].unit
      && line.warehouse_id === artifacts.warehouses["CK-001"].id
      && line.warehouse_code_snapshot === "CK-001"
      && Number(line.qty) === 3
      && [0, 1].includes(Number(line.returned_qty))
      && [0, 1].includes(Number(line.scrapped_qty)),
    "A118 cleanup refused a changed outsourcing receipt-line semantic snapshot", line);
  }

  const returnHeader = claimDocumentHeader("return", state.returns, (row) => validDocumentHeaderBase(row)
    && receipt
    && row.bill_no.startsWith("WWTH")
    && row.source_receipt_id === receipt.id
    && row.source_receipt_no === receipt.bill_no);
  const returnLines = ownedLines(state.returnLines, "return_id", returnHeader?.id, "returnLines", "outsourcing return line");
  if (returnHeader) {
    const line = returnLines[0];
    assert(line.line_no === 1
      && line.source_receipt_line_id === receiptLines[0].id
      && line.product_id === parentId
      && line.product_code_snapshot === productCode
      && line.product_name_snapshot === productName
      && line.product_spec_snapshot === fixtureKey
      && line.product_unit_snapshot === expectedProducts[productCode].unit
      && line.warehouse_id === artifacts.warehouses["CK-001"].id
      && line.warehouse_code_snapshot === "CK-001"
      && Number(line.qty) === 1,
    "A118 cleanup refused a changed outsourcing return-line semantic snapshot", line);
  }

  const scrap = claimDocumentHeader("scrap", state.scraps, (row) => validDocumentHeaderBase(row)
    && receipt
    && row.bill_no.startsWith("WWBF")
    && row.source_receipt_id === receipt.id
    && row.source_receipt_no === receipt.bill_no);
  const scrapLines = ownedLines(state.scrapLines, "scrap_id", scrap?.id, "scrapLines", "outsourcing scrap line");
  if (scrap) {
    const line = scrapLines[0];
    assert(line.line_no === 1
      && line.source_receipt_line_id === receiptLines[0].id
      && line.product_id === parentId
      && line.product_code_snapshot === productCode
      && line.product_name_snapshot === productName
      && line.product_spec_snapshot === fixtureKey
      && line.product_unit_snapshot === expectedProducts[productCode].unit
      && line.warehouse_id === artifacts.warehouses["CK-001"].id
      && line.warehouse_code_snapshot === "CK-001"
      && Number(line.qty) === 1,
    "A118 cleanup refused a changed outsourcing scrap-line semantic snapshot", line);
  }
  if (workOrder) {
    assert(Number(workOrderComponents[0].issued_qty) === (issue?.status === "AUDITED" ? 6 : 0),
      "A118 work-order issued counter must match the exact issue lifecycle", { component: workOrderComponents[0], issue });
    assert(Number(workOrderLines[0].received_qty) === (receipt?.status === "AUDITED" ? 3 : 0),
      "A118 work-order received counter must match the exact receipt lifecycle", { line: workOrderLines[0], receipt });
  }
  if (receipt) {
    assert(Number(receiptLines[0].returned_qty) === (returnHeader?.status === "AUDITED" ? 1 : 0)
      && Number(receiptLines[0].scrapped_qty) === (scrap?.status === "AUDITED" ? 1 : 0),
    "A118 receipt adjustment counters must match the exact return/scrap lifecycle",
    { line: receiptLines[0], returnHeader, scrap });
  }
}

function formalInventorySpecs(state) {
  const byId = (rows, ids) => rows.find((row) => ids.has(row.id));
  return [
    {
      label: "issue",
      header: byId(state.issues, artifacts.ids.issues),
      line: byId(state.issueLines, artifacts.ids.issueLines),
      productId: artifacts.productWrites[componentCode].productId,
      warehouseId: artifacts.warehouses["CK-002"].id,
      qty: 6,
      auditDelta: -6,
      sourceBillType: "OUTSOURCING_MATERIAL_ISSUE",
      auditTxnType: "OUTSOURCING_ISSUE",
      reverseTxnType: "OUTSOURCING_ISSUE_REVERSE"
    },
    {
      label: "receipt",
      header: byId(state.receipts, artifacts.ids.receipts),
      line: byId(state.receiptLines, artifacts.ids.receiptLines),
      productId: artifacts.productWrites[productCode].productId,
      warehouseId: artifacts.warehouses["CK-001"].id,
      qty: 3,
      auditDelta: 3,
      sourceBillType: "OUTSOURCING_RECEIPT",
      auditTxnType: "OUTSOURCING_RECEIPT",
      reverseTxnType: "OUTSOURCING_RECEIPT_REVERSE"
    },
    {
      label: "return",
      header: byId(state.returns, artifacts.ids.returns),
      line: byId(state.returnLines, artifacts.ids.returnLines),
      productId: artifacts.productWrites[productCode].productId,
      warehouseId: artifacts.warehouses["CK-001"].id,
      qty: 1,
      auditDelta: -1,
      sourceBillType: "OUTSOURCING_RETURN",
      auditTxnType: "OUTSOURCING_RETURN",
      reverseTxnType: "OUTSOURCING_RETURN_REVERSE"
    },
    {
      label: "scrap",
      header: byId(state.scraps, artifacts.ids.scraps),
      line: byId(state.scrapLines, artifacts.ids.scrapLines),
      productId: artifacts.productWrites[productCode].productId,
      warehouseId: artifacts.warehouses["CK-001"].id,
      qty: 1,
      auditDelta: -1,
      sourceBillType: "OUTSOURCING_SCRAP",
      auditTxnType: "OUTSOURCING_SCRAP",
      reverseTxnType: "OUTSOURCING_SCRAP_REVERSE"
    }
  ];
}

function validateInventory(state) {
  const specs = formalInventorySpecs(state);
  const seedRows = [];
  const formalRowsByLabel = new Map(specs.map((spec) => [spec.label, []]));
  for (const txn of state.transactions) {
    assertUuid(txn.id, "A118 cleanup inventory transaction id");
    assert(txn.account_set_id === artifacts.accountSet.id,
      "A118 cleanup refused a transaction outside BLD-TEST", txn);
    if (txn.source_bill_type === stockSource) {
      assert(txn.txn_type === "A118_OUTSOURCING_CHAIN_SEED"
        && txn.product_id === artifacts.productWrites[componentCode].productId
        && txn.warehouse_id === artifacts.warehouses["CK-002"].id
        && Number(txn.qty_delta) === 50
        && txn.source_bill_no === stockSource
        && txn.source_bill_date === artifacts.businessDate
        && txn.posting_action === "AUDIT"
        && txn.trace_quality === "TEST"
        && txn.reversal_of_txn_id === null
        && txn.unit_cost === null
        && Number(txn.amount) === 0
        && Number(txn.qty_on_hand_after) >= 0
        && uuidPattern.test(String(txn.source_bill_id))
        && uuidPattern.test(String(txn.source_bill_line_id)),
      "A118 cleanup refused a changed test-only seed transaction", txn);
      seedRows.push(txn);
      assert(artifacts.ids.transactions.has(txn.id),
        "A118 cleanup refuses a seed transaction UUID not captured after the write", txn);
      continue;
    }
    const spec = specs.find((candidate) => candidate.sourceBillType === txn.source_bill_type);
    assert(spec?.header && spec.line, "A118 cleanup found an inventory fact outside the owned document closure", txn);
    const isAudit = txn.txn_type === spec.auditTxnType
      && txn.posting_action === "AUDIT"
      && Number(txn.qty_delta) === spec.auditDelta
      && txn.reversal_of_txn_id === null;
    const isReverse = txn.txn_type === spec.reverseTxnType
      && txn.posting_action === "REVERSE"
      && Number(txn.qty_delta) === -spec.auditDelta
      && uuidPattern.test(String(txn.reversal_of_txn_id));
    assert(txn.product_id === spec.productId
      && txn.warehouse_id === spec.warehouseId
      && txn.source_bill_id === spec.header.id
      && txn.source_bill_line_id === spec.line.id
      && txn.source_bill_no === spec.header.bill_no
      && txn.source_bill_date === spec.header.bill_date
      && txn.trace_quality === "EXACT"
      && txn.unit_cost === null
      && Number(txn.amount) === 0
      && Number(txn.qty_on_hand_after) >= 0
      && (isAudit || isReverse),
    `A118 cleanup refused a changed ${spec.label} formal inventory fact`, txn);
    formalRowsByLabel.get(spec.label).push(txn);
    assert(artifacts.ids.transactions.has(txn.id),
      `A118 cleanup refuses a ${spec.label} transaction UUID not captured after the write`, txn);
  }
  assert(seedRows.length <= 1, "A118 cleanup refused duplicate seed inventory facts", seedRows);
  for (const spec of specs) {
    const rows = formalRowsByLabel.get(spec.label);
    if (!spec.header) {
      assert(rows.length === 0, `A118 cleanup found ${spec.label} facts without an owned document`, rows);
      continue;
    }
    const auditRows = rows.filter((row) => row.posting_action === "AUDIT");
    const reverseRows = rows.filter((row) => row.posting_action === "REVERSE");
    const version = Number(spec.header.version);
    const expectedCount = version === 0 ? 0 : version === 1 ? 1 : 2;
    assert(rows.length === expectedCount
      && auditRows.length === (expectedCount === 0 ? 0 : 1)
      && reverseRows.length === (expectedCount === 2 ? 1 : 0),
    `A118 cleanup refused an incomplete or duplicate ${spec.label} posting set`, rows);
    if (reverseRows.length === 1) {
      assert(reverseRows[0].reversal_of_txn_id === auditRows[0].id,
        `A118 ${spec.label} reverse fact must pair to the exact audit fact`, rows);
    }
  }
  for (const id of artifacts.ids.transactions) {
    assert(state.transactions.some((row) => row.id === id),
      "A118 cleanup is missing a captured inventory transaction UUID", id);
  }

  assert(state.balances.length <= 2, "A118 cleanup refused more than two fixture balances", state.balances);
  const txnGroups = new Map();
  for (const txn of state.transactions) {
    const key = `${txn.product_id}:${txn.warehouse_id}`;
    const current = txnGroups.get(key) ?? 0;
    txnGroups.set(key, current + Number(txn.qty_delta));
  }
  for (const balance of state.balances) {
    const key = `${balance.product_id}:${balance.warehouse_id}`;
    const expectedQty = txnGroups.get(key);
    const expectedWarehouseId = balance.product_id === artifacts.productWrites[componentCode].productId
      ? artifacts.warehouses["CK-002"].id
      : balance.product_id === artifacts.productWrites[productCode].productId
        ? artifacts.warehouses["CK-001"].id
        : null;
    assert(expectedQty !== undefined
      && expectedWarehouseId === balance.warehouse_id
      && balance.account_set_id === artifacts.accountSet.id
      && Number(balance.qty_on_hand) === expectedQty
      && Number(balance.qty_available) === expectedQty
      && Number(balance.qty_reserved) === 0
      && expectedQty >= 0,
    "A118 cleanup refused a changed or foreign fixture inventory balance", balance);
    assert(artifacts.ids.balances.has(balance.id),
      "A118 cleanup refuses an inventory balance UUID not captured after the write", balance);
  }
  assert(state.balances.length === txnGroups.size,
    "A118 cleanup requires one balance for every fixture product/warehouse posting group", { balances: state.balances, txnGroups: [...txnGroups] });
  for (const id of artifacts.ids.balances) {
    assert(state.balances.some((row) => row.id === id),
      "A118 cleanup is missing a captured inventory balance UUID", id);
  }
}

function operationLogSpecs() {
  const specs = [
    { module: "PRODUCTION", action: "SAVE_BOM", targetType: "prod_bom", idSet: "boms", billKind: "bom", before: null, after: { auditStatus: "DRAFT" } },
    { module: "PRODUCTION", action: "AUDIT_BOM", targetType: "prod_bom", idSet: "boms", billKind: "bom", before: { auditStatus: "DRAFT" }, after: { auditStatus: "AUDITED" } },
    { module: "OUTSOURCING", action: "SAVE_WORK_ORDER_DRAFT", targetType: "outsourcing_work_order", idSet: "workOrders", billKind: "workOrder", before: null, after: { status: "DRAFT" } },
    { module: "OUTSOURCING", action: "AUDIT_WORK_ORDER", targetType: "outsourcing_work_order", idSet: "workOrders", billKind: "workOrder", before: { status: "DRAFT" }, after: { status: "AUDITED" } },
    { module: "OUTSOURCING", action: "REVERSE_WORK_ORDER", targetType: "outsourcing_work_order", idSet: "workOrders", billKind: "workOrder", before: { status: "AUDITED" }, after: { status: "DRAFT" } },
    { module: "OUTSOURCING", action: "PUSH_ISSUE", targetType: "outsourcing_material_issue", idSet: "issues", billKind: "issue", before: null, after: { status: "DRAFT" } },
    { module: "OUTSOURCING", action: "AUDIT_ISSUE", targetType: "outsourcing_material_issue", idSet: "issues", billKind: "issue", before: { status: "DRAFT" }, after: { status: "AUDITED" } },
    { module: "OUTSOURCING", action: "REVERSE_ISSUE", targetType: "outsourcing_material_issue", idSet: "issues", billKind: "issue", before: { status: "AUDITED" }, after: { status: "DRAFT" } },
    { module: "OUTSOURCING", action: "PUSH_RECEIPT", targetType: "outsourcing_receipt", idSet: "receipts", billKind: "receipt", before: null, after: { status: "DRAFT" } },
    { module: "OUTSOURCING", action: "AUDIT_RECEIPT", targetType: "outsourcing_receipt", idSet: "receipts", billKind: "receipt", before: { status: "DRAFT" }, after: { status: "AUDITED" } },
    { module: "OUTSOURCING", action: "REVERSE_RECEIPT", targetType: "outsourcing_receipt", idSet: "receipts", billKind: "receipt", before: { status: "AUDITED" }, after: { status: "DRAFT" } },
    { module: "OUTSOURCING", action: "PUSH_RETURN", targetType: "outsourcing_return", idSet: "returns", billKind: "return", before: null, after: { status: "DRAFT" } },
    { module: "OUTSOURCING", action: "AUDIT_RETURN", targetType: "outsourcing_return", idSet: "returns", billKind: "return", before: { status: "DRAFT" }, after: { status: "AUDITED" } },
    { module: "OUTSOURCING", action: "REVERSE_RETURN", targetType: "outsourcing_return", idSet: "returns", billKind: "return", before: { status: "AUDITED" }, after: { status: "DRAFT" } },
    { module: "OUTSOURCING", action: "PUSH_SCRAP", targetType: "outsourcing_scrap", idSet: "scraps", billKind: "scrap", before: null, after: { status: "DRAFT" } },
    { module: "OUTSOURCING", action: "AUDIT_SCRAP", targetType: "outsourcing_scrap", idSet: "scraps", billKind: "scrap", before: { status: "DRAFT" }, after: { status: "AUDITED" } },
    { module: "OUTSOURCING", action: "REVERSE_SCRAP", targetType: "outsourcing_scrap", idSet: "scraps", billKind: "scrap", before: { status: "AUDITED" }, after: { status: "DRAFT" } }
  ];
  const documentSpecs = specs.map((spec) => ({
    ...spec,
    targetIds: artifacts.ids[spec.idSet],
    targetNo: spec.billKind === "bom" ? bomCode : artifacts.bills[spec.billKind]
  }));
  const productNameMasterDataSpecs = [productNameCode, componentNameCode].flatMap((code) => {
    const productNameId = artifacts.productNameWrites[code].productNameId;
    return [
      { module: "MASTER_DATA", action: "CREATE_MASTER_DATA", targetType: "md_product_name", targetIds: new Set([productNameId]), targetNo: code, before: null, after: { auditStatus: "DRAFT", enabled: true }, reason: "fields=code,name,remark,status; version=0" },
      { module: "MASTER_DATA", action: "AUDIT_MASTER_DATA", targetType: "md_product_name", targetIds: new Set([productNameId]), targetNo: code, before: { auditStatus: "DRAFT", enabled: true }, after: { auditStatus: "AUDITED", enabled: true }, reason: "version=0->1" }
    ];
  });
  const masterDataSpecs = [productCode, componentCode].flatMap((code) => {
    const productId = artifacts.productWrites[code].productId;
    const createReason = code === productCode
      ? "fields=category,code,defaultWarehouseCode,isInventory,isProduce,isSale,isSubcontract,name,remark,spec,status,subcontractPrice,taxRate,unit; version=0"
      : "fields=category,code,defaultSupplierCode,defaultWarehouseCode,isInventory,isProduce,isPurchase,name,purchasePrice,remark,spec,status,taxRate,unit; version=0";
    return [
      { module: "MASTER_DATA", action: "CREATE_MASTER_DATA", targetType: "md_product", targetIds: new Set([productId]), targetNo: code, before: null, after: { auditStatus: "DRAFT", enabled: true }, reason: createReason },
      { module: "MASTER_DATA", action: "AUDIT_MASTER_DATA", targetType: "md_product", targetIds: new Set([productId]), targetNo: code, before: { auditStatus: "DRAFT", enabled: true }, after: { auditStatus: "AUDITED", enabled: true }, reason: "version=0->1" }
    ];
  });
  return [...documentSpecs, ...productNameMasterDataSpecs, ...masterDataSpecs];
}

function validateLogsAndLocks(state) {
  const specs = operationLogSpecs();
  const counts = new Map();
  for (const log of state.logs) {
    assertUuid(log.id, "A118 cleanup operation-log id");
    assert(log.actor_type === "USER"
      && log.operated_by === artifacts.identity.userId
      && log.actor_username === runUsername
      && log.actor_display_name === runDisplayName
      && Date.parse(log.operated_at) >= startedAtMs - 5_000,
    "A118 cleanup refused an operation log outside the dedicated run actor", log);
    if (log.module_code === "SYSTEM" && log.action_code === "LOGIN" && log.target_type === "sys_user") {
      assert(log.success === true
        && log.failure_reason === null
        && log.target_id === artifacts.identity.userId
        && log.target_no === ""
        && log.account_set_id === null
        && log.account_set_code === "platform"
        && log.account_set_name === "平台"
        && log.before_state === null
        && log.after_state === null,
      "A118 cleanup refused a changed dedicated login log", log);
      counts.set("SYSTEM|LOGIN", (counts.get("SYSTEM|LOGIN") ?? 0) + 1);
    } else if (log.module_code === "SECURITY" && log.action_code === "WRITE_FAILED" && log.target_type === "http_endpoint") {
      assert(log.success === false
        && typeof log.failure_reason === "string" && log.failure_reason.trim().length > 0
        && log.target_id === null
        && allowedFailureRoutes.has(log.target_no)
        && log.account_set_id === artifacts.accountSet.id
        && log.account_set_code === "BLD-TEST"
        && log.account_set_name === artifacts.accountSet.name
        && log.before_state === null
        && log.after_state === null,
      "A118 cleanup refused a write-failure log outside the exact run routes/scope", log);
    } else {
      const spec = specs.find((candidate) => candidate.module === log.module_code
        && candidate.action === log.action_code
        && candidate.targetType === log.target_type
        && candidate.targetIds.has(log.target_id)
        && candidate.targetNo === log.target_no);
      assert(spec
        && log.success === true
        && log.failure_reason === (spec.reason ?? null)
        && spec.targetIds.has(log.target_id)
        && log.target_no === spec.targetNo
        && log.account_set_id === artifacts.accountSet.id
        && log.account_set_code === "BLD-TEST"
        && log.account_set_name === artifacts.accountSet.name
        && jsonEqual(log.before_state, spec.before)
        && jsonEqual(log.after_state, spec.after),
      "A118 cleanup refused an operation log outside the exact business action/target/scope contract", log);
      const key = `${spec.module}|${spec.action}|${log.target_id}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    assert(artifacts.ids.logs.has(log.id),
      "A118 cleanup refuses an operation-log UUID not captured at write response time", log);
  }
  assert((counts.get("SYSTEM|LOGIN") ?? 0) <= 1,
    "A118 cleanup refused duplicate dedicated login logs", state.logs);
  for (const [key, count] of counts) {
    assert(count <= 1, `A118 cleanup refused duplicate operation-log action ${key}`, count);
  }
  for (const id of artifacts.ids.logs) {
    assert(state.logs.some((row) => row.id === id),
      "A118 cleanup is missing a captured operation-log UUID", id);
  }

  assert(state.locks.length === 0,
    "A118 outsourcing routes do not support document locks; any candidate lock is unowned and cleanup must fail closed", state.locks);
}

function validateCleanupState(state) {
  const requiredArrays = [
    "accountSets", "adminRoles", "warehouses", "suppliers", "users", "roleLinks", "grants", "sessionScopes",
    "productNames", "products", "boms", "bomLines", "workOrders", "workOrderLines", "workOrderComponents",
    "issues", "issueLines", "receipts", "receiptLines", "returns", "returnLines", "scraps", "scrapLines",
    "transactions", "balances", "logs", "locks"
  ];
  assert(state && requiredArrays.every((key) => Array.isArray(state[key])),
    "A118 cleanup snapshot is incomplete", state);
  validateIdentityState(state);
  validateProductNames(state);
  validateProductsAndBom(state);
  validateDocuments(state);
  validateInventory(state);
  validateLogsAndLocks(state);
}

function readCleanupSnapshot() {
  return dbJson(`SELECT (${cleanupSnapshotExpression()})::text`);
}

function discoverCleanupState() {
  let state = readCleanupSnapshot();
  validateCleanupState(state);
  state = readCleanupSnapshot();
  validateCleanupState(state);
  const stable = readCleanupSnapshot();
  assert(jsonEqual(stable, state), "A118 cleanup snapshot changed during ownership discovery", { state, stable });
  result.cleanup.snapshotCounts = Object.fromEntries(Object.entries(state)
    .filter(([, value]) => Array.isArray(value))
    .map(([key, value]) => [key, value.length]));
  return state;
}

function lockKeyPredicate(alias, locks) {
  if (locks.length === 0) return "FALSE";
  return locks.map((row) => `(${alias}.document_type=${sqlLiteral(row.document_type)} AND ${alias}.bill_no=${sqlLiteral(row.bill_no)})`).join(" OR ");
}

function scopeKeyPredicate(alias, scopes) {
  if (scopes.length === 0) return "FALSE";
  return scopes.map((row) => `(${alias}.session_token=${sqlLiteral(row.session_token)}::uuid AND ${alias}.user_id=${sqlLiteral(row.user_id)}::uuid)`).join(" OR ");
}

async function closeRunSession() {
  if (!artifacts.session.cookie) {
    const redis = redisSessionSnapshot();
    result.cleanup.logout = {
      skipped: true,
      reason: "session cookie was not captured"
    };
    result.cleanup.redis = { before: redis, after: redis };
    assert(redis.ownedKeys.length === 0 && redis.sharedMembers.length === 0,
      "A118 refuses to claim a response-loss Redis session; unknown session residue is preserved", redis);
    return;
  }
  // Logout is idempotent: once the first request has invalidated the session, a
  // duplicate call is a no-op that still returns { ok: true }. Limit the retry to
  // this cleanup action and its following read; business writes must never be
  // retried after an ambiguous transport loss.
  const logout = await http(
    "/api/system/logout",
    { method: "POST" },
    artifacts.session.cookie,
    { retryTransientTransport: true }
  );
  artifacts.session.logoutStatus = logout.status;
  result.cleanup.logout = { skipped: false, status: logout.status, body: logout.data };
  const redis = cleanupRedisSession();
  result.cleanup.redis = redis;
  const sessionAfter = await http(
    "/api/system/session",
    {},
    artifacts.session.cookie,
    { retryTransientTransport: true }
  );
  artifacts.session.postLogoutAuthenticated = sessionAfter.data?.authenticated === true;
  result.cleanup.logout.postLogoutStatus = sessionAfter.status;
  result.cleanup.logout.postLogoutAuthenticated = artifacts.session.postLogoutAuthenticated;
  assert(logout.status === 200 && logout.data?.ok === true,
    "A118 dedicated logout endpoint must succeed", logout);
  assert(sessionAfter.status === 401 || sessionAfter.data?.authenticated === false,
    "A118 logged-out cookie must not remain authenticated", sessionAfter);
  const sessionTokenPredicate = uuidPattern.test(String(artifacts.session.token ?? ""))
    ? ` OR session_token=${sqlLiteral(artifacts.session.token)}::uuid`
    : "";
  assert(dbNumber(`SELECT count(*) FROM public.sys_session_account_scope WHERE user_id=${sqlLiteral(artifacts.identity.userId)}::uuid${sessionTokenPredicate}`) === 0,
    "A118 logout must remove the persisted dedicated account scope");
}

function cleanupFixtures() {
  result.cleanup.attempted = true;
  const state = discoverCleanupState();
  const productNameIds = [...artifacts.ids.productNames];
  const productNameCodes = Object.entries(artifacts.productNameWrites)
    .filter(([, write]) => write.accepted)
    .map(([code]) => code);
  const productNames = productNameCodes.map((code) => expectedProductNames[code].name);
  const productIds = [...artifacts.ids.products];
  const productCodes = Object.entries(artifacts.productWrites)
    .filter(([, write]) => write.accepted)
    .map(([code]) => code);
  const bomIds = [...artifacts.ids.boms];
  const bomLineIds = [...artifacts.ids.bomLines];
  const workOrderIds = [...artifacts.ids.workOrders];
  const workOrderLineIds = [...artifacts.ids.workOrderLines];
  const workOrderComponentIds = [...artifacts.ids.workOrderComponents];
  const issueIds = [...artifacts.ids.issues];
  const issueLineIds = [...artifacts.ids.issueLines];
  const receiptIds = [...artifacts.ids.receipts];
  const receiptLineIds = [...artifacts.ids.receiptLines];
  const returnIds = [...artifacts.ids.returns];
  const returnLineIds = [...artifacts.ids.returnLines];
  const scrapIds = [...artifacts.ids.scraps];
  const scrapLineIds = [...artifacts.ids.scrapLines];
  const transactionIds = [...artifacts.ids.transactions];
  const balanceIds = [...artifacts.ids.balances];
  const logIds = [...artifacts.ids.logs];
  const documentIds = allDocumentIds();
  const targetIds = allTargetIds();
  const targetNos = allTargetNos();
  const billNos = allBillNos();
  const scopeTokens = unique([artifacts.session.token, ...state.sessionScopes.map((row) => row.session_token)]);
  const hasOwnedBom = bomIds.length > 0;
  const hasOwnedWorkOrder = workOrderIds.length > 0;
  const hasOwnedSeed = state.transactions.some((row) => row.source_bill_type === stockSource);

  psql(`
    BEGIN;
    SET LOCAL lock_timeout='5s';
    SET LOCAL statement_timeout='30s';
    LOCK TABLE public.sys_account_set, public.sys_role, public.sys_user, public.sys_user_role,
      public.sys_user_account_set, public.sys_session_account_scope, public.md_supplier,
      public.md_warehouse, public.md_product_name, public.md_product, public.prod_bom, public.prod_bom_line,
      public.outsourcing_work_order, public.outsourcing_work_order_line, public.outsourcing_work_order_component,
      public.outsourcing_material_issue, public.outsourcing_material_issue_line,
      public.outsourcing_receipt, public.outsourcing_receipt_line,
      public.outsourcing_return, public.outsourcing_return_line,
      public.outsourcing_scrap, public.outsourcing_scrap_line,
      public.inv_stock_txn, public.inv_stock_balance, public.sys_operation_log, public.doc_edit_lock
      IN SHARE ROW EXCLUSIVE MODE;
    DO $a118_cleanup$
    DECLARE
      actual jsonb;
    BEGIN
      IF (SELECT count(*) FROM public.sys_account_set
          WHERE id=${sqlLiteral(artifacts.accountSet.id)}::uuid AND code='BLD-TEST' AND schema_name='public') <> 1 THEN
        RAISE EXCEPTION 'A118 cleanup refused: BLD-TEST/public route changed';
      END IF;
      SELECT (${cleanupSnapshotExpression()}) INTO actual;
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(state))}::jsonb THEN
        RAISE EXCEPTION 'A118 cleanup refused: complete ownership snapshot changed';
      END IF;

      DELETE FROM public.doc_edit_lock lock_row WHERE ${lockKeyPredicate("lock_row", state.locks)};
      DELETE FROM public.sys_operation_log WHERE id=ANY(${uuidArray(logIds)});
      DELETE FROM public.inv_stock_txn WHERE id=ANY(${uuidArray(transactionIds)});
      DELETE FROM public.outsourcing_return_line WHERE id=ANY(${uuidArray(returnLineIds)});
      DELETE FROM public.outsourcing_scrap_line WHERE id=ANY(${uuidArray(scrapLineIds)});
      DELETE FROM public.outsourcing_return WHERE id=ANY(${uuidArray(returnIds)});
      DELETE FROM public.outsourcing_scrap WHERE id=ANY(${uuidArray(scrapIds)});
      DELETE FROM public.outsourcing_receipt_line WHERE id=ANY(${uuidArray(receiptLineIds)});
      DELETE FROM public.outsourcing_receipt WHERE id=ANY(${uuidArray(receiptIds)});
      DELETE FROM public.outsourcing_material_issue_line WHERE id=ANY(${uuidArray(issueLineIds)});
      DELETE FROM public.outsourcing_material_issue WHERE id=ANY(${uuidArray(issueIds)});
      DELETE FROM public.outsourcing_work_order_component WHERE id=ANY(${uuidArray(workOrderComponentIds)});
      DELETE FROM public.outsourcing_work_order_line WHERE id=ANY(${uuidArray(workOrderLineIds)});
      DELETE FROM public.outsourcing_work_order WHERE id=ANY(${uuidArray(workOrderIds)});
      DELETE FROM public.prod_bom_line WHERE id=ANY(${uuidArray(bomLineIds)});
      DELETE FROM public.prod_bom WHERE id=ANY(${uuidArray(bomIds)});
      DELETE FROM public.inv_stock_balance WHERE id=ANY(${uuidArray(balanceIds)});
      DELETE FROM public.md_product WHERE id=ANY(${uuidArray(productIds)});
      DELETE FROM public.md_product_name WHERE id=ANY(${uuidArray(productNameIds)});
      DELETE FROM public.sys_session_account_scope scope_row WHERE ${scopeKeyPredicate("scope_row", state.sessionScopes)};
      DELETE FROM public.sys_user_account_set
      WHERE id=${sqlLiteral(artifacts.identity.grantId)}::uuid AND user_id=${sqlLiteral(artifacts.identity.userId)}::uuid;
      DELETE FROM public.sys_user_role
      WHERE user_id=${sqlLiteral(artifacts.identity.userId)}::uuid AND role_id=${sqlLiteral(artifacts.adminRole.id)}::uuid;
      DELETE FROM public.sys_user
      WHERE id=${sqlLiteral(artifacts.identity.userId)}::uuid AND username=${sqlLiteral(runUsername)};

      IF EXISTS (SELECT 1 FROM public.md_product_name WHERE id=ANY(${uuidArray(productNameIds)}) OR code=ANY(${textArray(productNameCodes)}) OR name=ANY(${textArray(productNames)}))
         OR EXISTS (SELECT 1 FROM public.md_product WHERE id=ANY(${uuidArray(productIds)}) OR code=ANY(${textArray(productCodes)}) OR name=ANY(${textArray(productNames)}))
         OR EXISTS (SELECT 1 FROM public.prod_bom WHERE id=ANY(${uuidArray(bomIds)}) OR (${hasOwnedBom ? `code=${sqlLiteral(bomCode)}` : "FALSE"}))
         OR EXISTS (SELECT 1 FROM public.prod_bom_line WHERE id=ANY(${uuidArray(bomLineIds)}) OR bom_id=ANY(${uuidArray(bomIds)}))
         OR EXISTS (SELECT 1 FROM public.outsourcing_work_order WHERE id=ANY(${uuidArray(workOrderIds)}) OR (${hasOwnedWorkOrder ? `bill_no=${sqlLiteral(artifacts.bills.workOrder)} OR remark=${sqlLiteral(fixtureKey)}` : "FALSE"}))
         OR EXISTS (SELECT 1 FROM public.outsourcing_work_order_line WHERE id=ANY(${uuidArray(workOrderLineIds)}) OR work_order_id=ANY(${uuidArray(workOrderIds)}))
         OR EXISTS (SELECT 1 FROM public.outsourcing_work_order_component WHERE id=ANY(${uuidArray(workOrderComponentIds)}) OR work_order_id=ANY(${uuidArray(workOrderIds)}))
         OR EXISTS (SELECT 1 FROM public.outsourcing_material_issue WHERE id=ANY(${uuidArray(issueIds)}) OR source_work_order_id=ANY(${uuidArray(workOrderIds)}))
         OR EXISTS (SELECT 1 FROM public.outsourcing_material_issue_line WHERE id=ANY(${uuidArray(issueLineIds)}) OR issue_id=ANY(${uuidArray(issueIds)}))
         OR EXISTS (SELECT 1 FROM public.outsourcing_receipt WHERE id=ANY(${uuidArray(receiptIds)}) OR source_work_order_id=ANY(${uuidArray(workOrderIds)}))
         OR EXISTS (SELECT 1 FROM public.outsourcing_receipt_line WHERE id=ANY(${uuidArray(receiptLineIds)}) OR receipt_id=ANY(${uuidArray(receiptIds)}))
         OR EXISTS (SELECT 1 FROM public.outsourcing_return WHERE id=ANY(${uuidArray(returnIds)}) OR source_receipt_id=ANY(${uuidArray(receiptIds)}))
         OR EXISTS (SELECT 1 FROM public.outsourcing_return_line WHERE id=ANY(${uuidArray(returnLineIds)}) OR return_id=ANY(${uuidArray(returnIds)}))
         OR EXISTS (SELECT 1 FROM public.outsourcing_scrap WHERE id=ANY(${uuidArray(scrapIds)}) OR source_receipt_id=ANY(${uuidArray(receiptIds)}))
         OR EXISTS (SELECT 1 FROM public.outsourcing_scrap_line WHERE id=ANY(${uuidArray(scrapLineIds)}) OR scrap_id=ANY(${uuidArray(scrapIds)}))
         OR EXISTS (SELECT 1 FROM public.inv_stock_txn WHERE id=ANY(${uuidArray(transactionIds)}) OR product_id=ANY(${uuidArray(productIds)}) OR source_bill_id=ANY(${uuidArray(documentIds)}) OR (${hasOwnedSeed ? `source_bill_type=${sqlLiteral(stockSource)}` : "FALSE"}))
         OR EXISTS (SELECT 1 FROM public.inv_stock_balance WHERE id=ANY(${uuidArray(balanceIds)}) OR product_id=ANY(${uuidArray(productIds)}))
         OR EXISTS (SELECT 1 FROM public.sys_operation_log WHERE id=ANY(${uuidArray(logIds)}) OR operated_by=${sqlLiteral(artifacts.identity.userId)}::uuid OR actor_username=${sqlLiteral(runUsername)} OR target_id=ANY(${uuidArray(targetIds)}) OR target_no=ANY(${textArray(targetNos)}))
         OR EXISTS (SELECT 1 FROM public.doc_edit_lock WHERE holder_user_id=${sqlLiteral(artifacts.identity.userId)}::uuid OR holder_username=${sqlLiteral(runUsername)} OR bill_no=ANY(${textArray(billNos)}))
         OR EXISTS (SELECT 1 FROM public.sys_session_account_scope WHERE user_id=${sqlLiteral(artifacts.identity.userId)}::uuid OR session_token=ANY(${uuidArray(scopeTokens)}))
         OR EXISTS (SELECT 1 FROM public.sys_user_account_set WHERE user_id=${sqlLiteral(artifacts.identity.userId)}::uuid OR id=${sqlLiteral(artifacts.identity.grantId)}::uuid)
         OR EXISTS (SELECT 1 FROM public.sys_user_role WHERE user_id=${sqlLiteral(artifacts.identity.userId)}::uuid)
         OR EXISTS (SELECT 1 FROM public.sys_user WHERE id=${sqlLiteral(artifacts.identity.userId)}::uuid OR username=${sqlLiteral(runUsername)}) THEN
        RAISE EXCEPTION 'A118 cleanup closure is not zero';
      END IF;
      IF (SELECT to_jsonb(account_set) FROM public.sys_account_set account_set
          WHERE account_set.id=${sqlLiteral(artifacts.accountSet.id)}::uuid) IS DISTINCT FROM ${sqlLiteral(JSON.stringify(artifacts.accountSet))}::jsonb THEN
        RAISE EXCEPTION 'A118 cleanup changed the BLD-TEST account-set snapshot';
      END IF;
    END;
    $a118_cleanup$;
    COMMIT;
  `);

  const residue = {
    productNames: dbNumber(`SELECT count(*) FROM public.md_product_name WHERE id=ANY(${uuidArray(productNameIds)}) OR code=ANY(${textArray(productNameCodes)}) OR name=ANY(${textArray(productNames)})`),
    products: dbNumber(`SELECT count(*) FROM public.md_product WHERE id=ANY(${uuidArray(productIds)}) OR code=ANY(${textArray(productCodes)}) OR name=ANY(${textArray(productNames)})`),
    boms: dbNumber(`SELECT count(*) FROM public.prod_bom WHERE id=ANY(${uuidArray(bomIds)}) OR (${hasOwnedBom ? `code=${sqlLiteral(bomCode)}` : "FALSE"})`),
    documents: dbNumber(`SELECT
      (SELECT count(*) FROM public.outsourcing_work_order WHERE id=ANY(${uuidArray(workOrderIds)}))
      + (SELECT count(*) FROM public.outsourcing_material_issue WHERE id=ANY(${uuidArray(issueIds)}))
      + (SELECT count(*) FROM public.outsourcing_receipt WHERE id=ANY(${uuidArray(receiptIds)}))
      + (SELECT count(*) FROM public.outsourcing_return WHERE id=ANY(${uuidArray(returnIds)}))
      + (SELECT count(*) FROM public.outsourcing_scrap WHERE id=ANY(${uuidArray(scrapIds)}))`),
    documentLines: dbNumber(`SELECT
      (SELECT count(*) FROM public.outsourcing_work_order_line WHERE id=ANY(${uuidArray(workOrderLineIds)}))
      + (SELECT count(*) FROM public.outsourcing_work_order_component WHERE id=ANY(${uuidArray(workOrderComponentIds)}))
      + (SELECT count(*) FROM public.outsourcing_material_issue_line WHERE id=ANY(${uuidArray(issueLineIds)}))
      + (SELECT count(*) FROM public.outsourcing_receipt_line WHERE id=ANY(${uuidArray(receiptLineIds)}))
      + (SELECT count(*) FROM public.outsourcing_return_line WHERE id=ANY(${uuidArray(returnLineIds)}))
      + (SELECT count(*) FROM public.outsourcing_scrap_line WHERE id=ANY(${uuidArray(scrapLineIds)}))`),
    transactions: dbNumber(`SELECT count(*) FROM public.inv_stock_txn WHERE id=ANY(${uuidArray(transactionIds)}) OR product_id=ANY(${uuidArray(productIds)})`),
    balances: dbNumber(`SELECT count(*) FROM public.inv_stock_balance WHERE id=ANY(${uuidArray(balanceIds)}) OR product_id=ANY(${uuidArray(productIds)})`),
    logs: dbNumber(`SELECT count(*) FROM public.sys_operation_log WHERE id=ANY(${uuidArray(logIds)}) OR operated_by=${sqlLiteral(artifacts.identity.userId)}::uuid OR actor_username=${sqlLiteral(runUsername)}`),
    locks: dbNumber(`SELECT count(*) FROM public.doc_edit_lock WHERE holder_user_id=${sqlLiteral(artifacts.identity.userId)}::uuid OR holder_username=${sqlLiteral(runUsername)} OR bill_no=ANY(${textArray(billNos)})`),
    sessionScopes: dbNumber(`SELECT count(*) FROM public.sys_session_account_scope WHERE user_id=${sqlLiteral(artifacts.identity.userId)}::uuid OR session_token=ANY(${uuidArray(scopeTokens)})`),
    userRoles: dbNumber(`SELECT count(*) FROM public.sys_user_role WHERE user_id=${sqlLiteral(artifacts.identity.userId)}::uuid`),
    userGrants: dbNumber(`SELECT count(*) FROM public.sys_user_account_set WHERE user_id=${sqlLiteral(artifacts.identity.userId)}::uuid OR id=${sqlLiteral(artifacts.identity.grantId)}::uuid`),
    users: dbNumber(`SELECT count(*) FROM public.sys_user WHERE id=${sqlLiteral(artifacts.identity.userId)}::uuid OR username=${sqlLiteral(runUsername)}`)
  };
  result.cleanup.residue = residue;
  assert(Object.values(residue).every((value) => value === 0),
    "A118 cleanup must leave zero database residue", residue);
  const redisResidue = redisSessionSnapshot();
  assert(redisResidue.ownedKeys.length === 0 && redisResidue.sharedMembers.length === 0,
    "A118 cleanup must leave zero Redis session residue", redisResidue);
}

function artifactSummary() {
  return {
    actor: { id: artifacts.identity.userId, username: runUsername, grantId: artifacts.identity.grantId },
    productNameWrites: Object.fromEntries(Object.entries(artifacts.productNameWrites).map(([code, write]) => [code, { ...write }])),
    productWrites: Object.fromEntries(Object.entries(artifacts.productWrites).map(([code, write]) => [code, { ...write }])),
    ids: Object.fromEntries(Object.entries(artifacts.ids).map(([key, values]) => [key, [...values].sort()])),
    bills: { ...artifacts.bills },
    session: {
      established: Boolean(artifacts.session.cookie),
      redisBacked: artifacts.session.redisBacked,
      redisObserved: { ...artifacts.session.redisObserved },
      logoutStatus: artifacts.session.logoutStatus,
      postLogoutAuthenticated: artifacts.session.postLogoutAuthenticated
    }
  };
}

assert(["", "after-identity", "after-products", "after-seed"].includes(faultPhase),
  "A118_FAULT_PHASE must be empty, after-identity, after-products or after-seed", faultPhase);

try {
  await assertLocalHealthAndPrepareRoute();
  result.environment.faultPhase = faultPhase || null;
  createRunIdentity();
  if (faultPhase === "after-identity") throw new Error("A118 injected failure after dedicated identity");
  await establishRunSession();
  await runFlow();
} catch (error) {
  primaryError = error;
  result.failure = error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { message: String(error) };
} finally {
  if (identityWriteAttempted) {
    try {
      await closeRunSession();
    } catch (error) {
      result.cleanup.errors.push(`session cleanup: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      cleanupFixtures();
    } catch (error) {
      result.cleanup.errors.push(`database cleanup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  result.artifacts = artifactSummary();
  result.ok = primaryError === null
    && result.cleanup.attempted
    && result.cleanup.errors.length === 0
    && result.cleanup.residue !== null
    && Object.values(result.cleanup.residue).every((value) => value === 0);
  await writeFile(resultPath, JSON.stringify(result, null, 2));
}

if (primaryError || result.cleanup.errors.length > 0) {
  throw new Error(
    `A118 outsourcing-chain regression failed: ${primaryError?.message ?? "scenario passed"}; cleanup: ${result.cleanup.errors.join(" | ") || "ok"}`,
    { cause: primaryError ?? undefined }
  );
}

console.log(JSON.stringify(result, null, 2));
