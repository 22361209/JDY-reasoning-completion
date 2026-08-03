import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { loginApi } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const nativeFetch = globalThis.fetch.bind(globalThis);
const runId = randomUUID();
const runToken = runId.replaceAll("-", "").slice(0, 12).toUpperCase();
const fixtureKey = `A43-${runToken}`;
const warehouseCode = `A43-W-${runToken}`;
const warehouseName = `A43操作日志隔离仓-${runToken}`;
const seedTxnType = `A43_SEED_IN_${runToken}`;
const seedSourceBillType = `A43:${runToken}`;
const runUsername = `a43_${runToken.toLowerCase()}_admin`;
const runDisplayName = `A43 ${runToken} admin`;
const runPassword = `A43-${runToken}-Admin1!`;
const operatorLabel = `${runDisplayName}（${runUsername}）`;
const productCode = "CP-001";
const customerCode = "KH-001";
const quantity = 2;
const unitPrice = 86;
const logDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
const billDate = logDate;
const faultPhase = process.env.A43_FAULT_PHASE ?? "";
const resultPath = path.join(
  verificationDir,
  faultPhase ? "a43-operation-log-export-regression-fault.json" : "a43-operation-log-export-regression.json"
);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const jSessionIdPattern = /^[0-9a-f]{32}$/i;
const redisGlobControlPattern = /[*?\[\]\\]/;
const sensitiveFieldNames = new Set([
  "cookie", "sessionCookie", "token", "sessionToken", "scopeToken",
  "session_token", "scope_token", "active_session_token"
]);
const sensitiveValues = new Map();
const operationLogFields = [
  "id", "operatedAt", "module", "action", "actorType", "actorUsername", "actorDisplayName", "operator",
  "accountSetId", "accountSetCode", "accountSetName", "targetType", "targetId", "targetNo", "status", "reason",
  "beforeState", "afterState"
];
const operationLogDbFields = [
  "id", "module_code", "action_code", "target_type", "target_id", "before_state", "after_state", "success",
  "failure_reason", "operated_by", "operated_at", "account_set_id", "account_set_code", "account_set_name",
  "actor_type", "actor_username", "actor_display_name", "target_no"
].sort();
const operationLogCsvColumns = [
  ["id", "日志ID"], ["operatedAt", "操作时间"], ["module", "模块"], ["action", "动作"],
  ["actorType", "主体类型"], ["actorUsername", "操作人账号"], ["actorDisplayName", "操作时姓名"],
  ["operator", "操作人"], ["accountSetId", "账套ID"], ["accountSetCode", "账套编码"],
  ["accountSetName", "账套名称"], ["targetType", "对象类型"], ["targetId", "对象ID"],
  ["targetNo", "业务单号"], ["status", "状态"], ["reason", "失败原因"],
  ["beforeState", "操作前状态"], ["afterState", "操作后状态"]
];

const artifacts = {
  accountSet: null,
  adminRole: null,
  product: null,
  identity: { userId: "", grantId: "", roleId: "" },
  session: {
    cookie: "",
    token: "",
    scopeSnapshot: null,
    redisAtLogin: null,
    redisBeforeLogout: null,
    logoutStatus: null,
    postLogoutAuthenticated: null
  },
  warehouse: { id: "", snapshot: null },
  documents: {
    order: { id: "", billNo: "", lineIds: [] },
    notice: { id: "", billNo: "", lineIds: [] },
    out: { id: "", billNo: "", lineIds: [] },
    red: { id: "", billNo: "", lineIds: [] }
  },
  inventoryTxnIds: [],
  balanceIds: [],
  receivableIds: [],
  operationLogIds: [],
  redReverseLogId: "",
  redOperationLogDbRow: null,
  expectedOperationLogRow: null,
  cleanupSnapshot: null,
  browser: null
};

const evidence = {
  ok: false,
  runId,
  runToken,
  fixtureKey,
  faultPhase: faultPhase || null,
  generatedAt: new Date().toISOString(),
  environment: {},
  fixture: {
    warehouseCode,
    productCode,
    customerCode,
    orderNo: null,
    noticeNo: null,
    salesOutNo: null,
    salesRedReverseBillNo: null
  },
  checks: {},
  snapshots: {},
  fault: { requested: faultPhase || null, reached: false, injected: false },
  cleanup: {
    attempted: false,
    browserClosed: false,
    logout: null,
    redis: null,
    deleted: null,
    residue: null,
    errors: [],
    removedFailureArtifacts: []
  },
  failure: null
};

let identityWriteAttempted = false;
let controlledWriteAuthorized = false;
let primaryError = null;
let notificationOutboxSourceSupported = false;

await mkdir(verificationDir, { recursive: true });
await mkdir(screenshotDir, { recursive: true });

function assert(condition, message, details = undefined) {
  if (!condition) {
    throw new Error(details === undefined ? redactSensitiveText(message) : `${redactSensitiveText(message)}: ${safeJson(details)}`);
  }
}

function errorText(error) {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

function assertUuid(value, label) {
  assert(uuidPattern.test(String(value ?? "")), `${label} must be a UUID`, value);
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))].sort();
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

function digest(value) {
  const text = typeof value === "string" ? value : JSON.stringify(canonicalJson(value));
  return createHash("sha256").update(text).digest("hex");
}

function secretSummary(value, type = "secret") {
  return { type, payloadHash: digest(String(value ?? "")) };
}

function registerSensitive(value, type = "secret") {
  const raw = String(value ?? "");
  if (raw) sensitiveValues.set(raw, secretSummary(raw, type));
  return value;
}

function redactSensitiveText(value) {
  let text = String(value ?? "");
  const registered = [...sensitiveValues.entries()].sort((left, right) => right[0].length - left[0].length);
  for (const [raw, summary] of registered) {
    text = text.replaceAll(raw, `<${summary.type}:${summary.payloadHash}>`);
  }
  text = text.replace(/\b(?:SESSION|JSESSIONID)=([^;\s]+)/g, (match) => `<cookie:${digest(match)}>`);
  text = text.replace(/spring:session:[^\s"',}\]]+/g, (match) => `<redis-key:${digest(match)}>`);
  return text;
}

function redisEntryEvidence(entry) {
  return {
    type: String(entry?.type ?? "unknown"),
    keyHash: digest(String(entry?.key ?? "")),
    payloadHash: digest(entry?.payload ?? entry?.member ?? "")
  };
}

function redisMarkerEvidence(markers) {
  const values = Array.isArray(markers) ? markers : [];
  return {
    count: values.length,
    entries: values.map((marker) => ({
      type: "marker",
      keyHash: digest(`marker:${String(marker)}`),
      payloadHash: digest(String(marker))
    }))
  };
}

function safeForPersistence(value, keyName = "") {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (sensitiveFieldNames.has(keyName)) return secretSummary(value, keyName === "cookie" ? "cookie" : "token");
    return redactSensitiveText(value);
  }
  if (Array.isArray(value)) return value.map((entry) => safeForPersistence(entry, keyName));
  if (typeof value === "object") {
    if (Array.isArray(value.markers) && Array.isArray(value.ownedKeys) && Array.isArray(value.sharedMembers)) {
      return redisEvidence(value);
    }
    if (Object.hasOwn(value, "key") && (Object.hasOwn(value, "payload") || Object.hasOwn(value, "member"))) {
      return redisEntryEvidence(value);
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, safeForPersistence(entry, key)]));
  }
  return redactSensitiveText(String(value));
}

function safeJson(value) {
  return JSON.stringify(safeForPersistence(value));
}

function safeStack(error) {
  return error instanceof Error ? redactSensitiveText(error.stack ?? "") : "";
}

function serializeEvidenceForPersistence() {
  const serialized = `${JSON.stringify(safeForPersistence(evidence), null, 2)}\n`;
  const leaked = [...sensitiveValues.keys()].filter((raw) => raw && serialized.includes(raw));
  assert(leaked.length === 0, "A43 refuses to persist raw session/Redis secrets", {
    count: leaked.length,
    entries: leaked.map((raw) => secretSummary(raw, "leak"))
  });
  return serialized;
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function uuidArray(values) {
  const normalized = unique(values);
  for (const value of normalized) assertUuid(value, "A43 SQL UUID array value");
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
  return execFileSync(
    "docker",
    ["exec", "jdy-erp-postgres", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-qAt", "-U", "jdy", "-d", "jdy_erp", "-c", sql],
    { encoding: "utf8" }
  ).trim();
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
  try {
    return execFileSync(
      "docker",
      ["exec", "jdy-erp-redis", "redis-cli", "-n", "0", "--raw", ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    ).trim();
  } catch {
    const commandType = /^[A-Z]+$/i.test(String(args[0] ?? "")) ? String(args[0]).toUpperCase() : "UNKNOWN";
    throw new Error(`A43 Redis command failed: ${commandType}`);
  }
}

function redisScan(pattern) {
  const raw = redisCommand("--scan", "--pattern", pattern);
  return raw ? unique(raw.split(/\r?\n/).filter(Boolean)) : [];
}

function parseSessionCookie() {
  registerSensitive(artifacts.session.cookie, "cookie");
  const match = /^(SESSION|JSESSIONID)=([^;]+)$/.exec(String(artifacts.session.cookie ?? ""));
  if (!artifacts.session.cookie) return null;
  assert(match, "A43 session cookie must be one exact SESSION or JSESSIONID pair", {
    type: "cookie",
    payloadHash: digest(artifacts.session.cookie)
  });
  registerSensitive(match[2], "cookie-value");
  return { name: match[1], value: match[2] };
}

function isRedisScanSafeMarker(value) {
  return /^[\x21-\x7e]+$/.test(String(value ?? "")) && !redisGlobControlPattern.test(String(value));
}

function decodeSessionMarker(value, encoding) {
  const encodedPattern = encoding === "base64" ? /^[A-Za-z0-9+/]+={0,2}$/ : /^[A-Za-z0-9_-]+={0,2}$/;
  if (!encodedPattern.test(value) || value.replace(/=+$/, "").length % 4 === 1) return "";
  const decoded = Buffer.from(value, encoding).toString("utf8");
  return (uuidPattern.test(decoded) || jSessionIdPattern.test(decoded)) && isRedisScanSafeMarker(decoded) ? decoded : "";
}

function sessionMarkers() {
  const cookie = parseSessionCookie();
  const markers = [runUsername, artifacts.session.token];
  if (cookie?.name === "JSESSIONID") {
    assert(jSessionIdPattern.test(cookie.value), "A43 JSESSIONID must be one exact 32-hex identifier", cookie.name);
    markers.push(cookie.value);
  } else if (cookie?.name === "SESSION") {
    assert(isRedisScanSafeMarker(cookie.value), "A43 SESSION cookie must be safe for exact Redis discovery", cookie.name);
    markers.push(cookie.value, decodeSessionMarker(cookie.value, "base64"), decodeSessionMarker(cookie.value, "base64url"));
  }
  const normalized = unique(markers);
  assert(normalized.every(isRedisScanSafeMarker), "A43 Redis markers must be printable and glob-safe", redisMarkerEvidence(normalized));
  return normalized;
}

function redisPayload(key, type) {
  let payload = "";
  if (type === "hash") payload = redisCommand("HGETALL", key);
  else if (type === "string") payload = redisCommand("GET", key);
  else if (type === "set") payload = unique(redisCommand("SMEMBERS", key).split(/\r?\n/).filter(Boolean));
  else if (type === "zset") payload = redisCommand("ZRANGE", key, "0", "-1", "WITHSCORES");
  else if (type === "list") payload = redisCommand("LRANGE", key, "0", "-1");
  registerSensitive(typeof payload === "string" ? payload : JSON.stringify(payload), "redis-payload");
  return payload;
}

function redisSessionSnapshot() {
  const markers = sessionMarkers();
  const ownedKeys = new Set();
  for (const marker of markers) {
    for (const key of redisScan(`spring:session:*${marker}*`)) ownedKeys.add(key);
  }
  for (const key of redisScan("spring:session:sessions:*")) {
    if (!/^spring:session:sessions:(?!expires:).+/.test(key) || redisCommand("TYPE", key) !== "hash") continue;
    const payload = redisCommand("HGETALL", key);
    if (!payload.includes(runUsername) && !(artifacts.session.token && payload.includes(artifacts.session.token))) continue;
    ownedKeys.add(key);
    const sessionId = key.slice("spring:session:sessions:".length);
    const expiresKey = `spring:session:sessions:expires:${sessionId}`;
    if (redisCommand("EXISTS", expiresKey) === "1") ownedKeys.add(expiresKey);
  }
  const keys = [...ownedKeys].sort().map((key) => {
    registerSensitive(key, "redis-key");
    const type = redisCommand("TYPE", key);
    return { key, type, payload: redisPayload(key, type) };
  });
  const discoveredSessionIds = keys
    .map((entry) => entry.key.match(/^spring:session:sessions:(?!expires:)(.+)$/)?.[1] ?? "")
    .filter(Boolean);
  const exactMarkers = unique([...markers, ...discoveredSessionIds]);
  const sharedMembers = [];
  for (const key of redisScan("spring:session:expirations:*")) {
    registerSensitive(key, "redis-key");
    const members = redisCommand("SMEMBERS", key).split(/\r?\n/).filter(Boolean);
    for (const member of members) {
      if (exactMarkers.some((marker) => marker && member.includes(marker))) {
        registerSensitive(member, "redis-payload");
        sharedMembers.push({ key, member });
      }
    }
  }
  return {
    markers: exactMarkers,
    ownedKeys: keys,
    sharedMembers: sharedMembers.sort((left, right) => `${left.key}:${left.member}`.localeCompare(`${right.key}:${right.member}`))
  };
}

function redisEvidence(snapshot) {
  if (!snapshot) return null;
  const entries = [
    ...snapshot.markers.map((marker) => ({
      type: "marker",
      keyHash: digest(`marker:${String(marker)}`),
      payloadHash: digest(String(marker))
    })),
    ...snapshot.ownedKeys.map(redisEntryEvidence),
    ...snapshot.sharedMembers.map((entry) => redisEntryEvidence({ ...entry, type: "expiration-member", payload: entry.member }))
  ].sort((left, right) => `${left.type}:${left.keyHash}:${left.payloadHash}`.localeCompare(`${right.type}:${right.keyHash}:${right.payloadHash}`));
  return {
    markerCount: snapshot.markers.length,
    ownedKeyCount: snapshot.ownedKeys.length,
    expirationMemberCount: snapshot.sharedMembers.length,
    entries
  };
}

function validateRedisBinding(snapshot, label) {
  if (snapshot.ownedKeys.length === 0 && snapshot.sharedMembers.length === 0) return;
  const cookie = parseSessionCookie();
  assert(cookie, `A43 ${label} Redis evidence requires the captured session cookie`);
  const sessionHashes = snapshot.ownedKeys.filter((entry) => /^spring:session:sessions:(?!expires:)/.test(entry.key) && entry.type === "hash");
  assert(sessionHashes.length === 1, `A43 ${label} must resolve exactly one Redis session hash`, redisEvidence(snapshot));
  const [sessionHash] = sessionHashes;
  const cookieCandidates = cookie.name === "JSESSIONID"
    ? [cookie.value]
    : unique([cookie.value, decodeSessionMarker(cookie.value, "base64"), decodeSessionMarker(cookie.value, "base64url")]);
  assert(cookieCandidates.some((candidate) => candidate && sessionHash.key.endsWith(candidate)),
    `A43 ${label} Redis session hash must be bound to the exact cookie`, {
      cookieName: cookie.name,
      entry: redisEntryEvidence(sessionHash)
    });
  assert(String(sessionHash.payload).includes(runUsername), `A43 ${label} Redis session hash must bind the run username`, redisEntryEvidence(sessionHash));
  if (artifacts.session.token) {
    assert(String(sessionHash.payload).includes(artifacts.session.token),
      `A43 ${label} Redis session hash must bind the persisted scope token`, redisEntryEvidence(sessionHash));
  }
}

function cleanupRedisSession() {
  const captured = artifacts.session.redisBeforeLogout ?? artifacts.session.redisAtLogin;
  const current = redisSessionSnapshot();
  if (!captured) {
    assert(current.ownedKeys.length === 0 && current.sharedMembers.length === 0,
      "A43 refuses to claim Redis session data without a captured ownership snapshot", redisEvidence(current));
    return { captured: null, before: current, after: current };
  }
  const capturedKeys = new Map(captured.ownedKeys.map((entry) => [entry.key, entry]));
  const capturedMembers = new Set(captured.sharedMembers.map((entry) => `${entry.key}\0${entry.member}`));
  for (const entry of current.ownedKeys) {
    const expected = capturedKeys.get(entry.key);
    assert(expected && expected.type === entry.type && jsonEqual(expected.payload, entry.payload),
      "A43 Redis cleanup refused a key whose exact captured payload changed or was never captured", redisEntryEvidence(entry));
  }
  for (const entry of current.sharedMembers) {
    assert(capturedMembers.has(`${entry.key}\0${entry.member}`),
      "A43 Redis cleanup refused an expiration member that was not exactly captured",
      redisEntryEvidence({ ...entry, type: "expiration-member", payload: entry.member }));
  }
  for (const entry of current.ownedKeys) redisCommand("DEL", entry.key);
  for (const entry of current.sharedMembers) redisCommand("SREM", entry.key, entry.member);
  const after = redisSessionSnapshot();
  assert(after.ownedKeys.length === 0 && after.sharedMembers.length === 0,
    "A43 Redis cleanup must leave zero dedicated-session residue", redisEvidence(after));
  return { captured, before: current, after };
}

async function http(pathname, options = {}, cookie = artifacts.session.cookie) {
  const headers = new Headers(options.headers ?? {});
  if (cookie) headers.set("Cookie", cookie);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await nativeFetch(`${apiBase}${pathname}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: response.ok, status: response.status, data, text, headers: response.headers };
}

async function requireJson(pathname, options = {}, expected = [200, 201]) {
  const response = await http(pathname, options);
  if (!expected.includes(response.status)) {
    const responseEvidence = response.data && typeof response.data === "object"
      ? safeJson(response.data)
      : redactSensitiveText(response.text);
    throw new Error(`${options.method ?? "GET"} ${pathname} expected ${expected.join("/")} but got ${response.status}: ${responseEvidence}`);
  }
  return response.data ?? {};
}

async function requireText(pathname, options = {}, expected = [200]) {
  const response = await http(pathname, options);
  if (!expected.includes(response.status)) {
    throw new Error(`${options.method ?? "GET"} ${pathname} expected ${expected.join("/")} but got ${response.status}: ${redactSensitiveText(response.text)}`);
  }
  return response.text;
}

function generatedIdentity(row, label) {
  assertUuid(row?.id, `${label} response id`);
  const billNo = String(row?.billNo ?? "");
  assert(billNo, `${label} response must contain the generated bill number`, row);
  return { id: String(row.id), billNo };
}

function rowsJson(table, predicate, orderBy = "row_value.id") {
  return dbJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY ${orderBy}), '[]'::jsonb)::text
    FROM public.${table} row_value
    WHERE ${predicate}
  `) ?? [];
}

function sessionScopeRows() {
  if (!artifacts.identity.userId) return [];
  return rowsJson(
    "sys_session_account_scope",
    `row_value.user_id=${sqlLiteral(artifacts.identity.userId)}::uuid`,
    "row_value.session_token"
  );
}

async function prepareRoute() {
  assert(new URL(apiBase).hostname === "127.0.0.1", "A43 may only write through the local API");
  assert(dbNumber(`
    SELECT count(*)
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='sys_outbox_event' AND column_name='aggregate_id'
  `) === 1, "A43 cleanup requires public.sys_outbox_event.aggregate_id");
  notificationOutboxSourceSupported = dbNumber(`
    SELECT count(*)
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='sys_notification_outbox' AND column_name='source_id'
  `) === 1;
  const health = await http("/api/system/health", {}, "");
  assert(health.status === 200 && health.data?.status === "UP", "A43 local backend health must be UP", health.data);
  assert(health.data?.testInventoryAdjustmentApi === true,
    "A43 requires the explicitly enabled test-only inventory adjustment fixture API", health.data);
  const route = dbJson(`
    SELECT jsonb_build_object(
      'accountSet', to_jsonb(account_set),
      'adminRole', to_jsonb(admin_role),
      'product', to_jsonb(product)
    )::text
    FROM public.sys_account_set account_set
    CROSS JOIN public.sys_role admin_role
    CROSS JOIN public.md_product product
    WHERE account_set.code='BLD-TEST'
      AND account_set.schema_name='public'
      AND account_set.enabled=TRUE
      AND admin_role.code='ADMIN'
      AND admin_role.enabled=TRUE
      AND product.code=${sqlLiteral(productCode)}
      AND product.enabled=TRUE
      AND product.audit_status='AUDITED'
  `);
  assert(route?.accountSet?.code === "BLD-TEST"
      && route.accountSet.schema_name === "public"
      && route.accountSet.enabled === true
      && route.adminRole?.code === "ADMIN"
      && route.adminRole.enabled === true
      && route.product?.code === productCode
      && route.product.enabled === true
      && route.product.audit_status === "AUDITED",
  "A43 requires exactly one enabled BLD-TEST/public route, ADMIN role, and audited CP-001", route);
  for (const [label, value] of [
    ["account set", route.accountSet.id],
    ["ADMIN role", route.adminRole.id],
    [productCode, route.product.id]
  ]) assertUuid(value, `A43 ${label} id`);
  assert(dbNumber(`SELECT count(*) FROM public.sys_user WHERE username=${sqlLiteral(runUsername)}`) === 0,
    "A43 run-unique username must not pre-exist", runUsername);
  assert(dbNumber(`SELECT count(*) FROM public.md_warehouse WHERE code=${sqlLiteral(warehouseCode)}`) === 0,
    "A43 run-unique warehouse code must not pre-exist", warehouseCode);
  artifacts.accountSet = route.accountSet;
  artifacts.adminRole = route.adminRole;
  artifacts.product = route.product;
  evidence.environment.health = health.data;
  evidence.environment.accountSet = {
    id: route.accountSet.id,
    code: route.accountSet.code,
    schemaName: route.accountSet.schema_name
  };
  evidence.environment.cleanupCoverage = {
    outboxAggregateId: true,
    notificationSourceId: notificationOutboxSourceSupported
  };
}

function createRunIdentity() {
  assert(artifacts.accountSet && artifacts.adminRole, "A43 route must be prepared before identity creation");
  identityWriteAttempted = true;
  const created = dbJson(`
    WITH created_user AS (
      INSERT INTO public.sys_user (username, display_name, password_hash, enabled, default_account_set_id)
      VALUES (
        ${sqlLiteral(runUsername)}, ${sqlLiteral(runDisplayName)}, ${sqlLiteral(`{noop}${runPassword}`)},
        TRUE, ${sqlLiteral(artifacts.accountSet.id)}::uuid
      )
      RETURNING id
    ), created_role AS (
      INSERT INTO public.sys_user_role (user_id, role_id)
      SELECT id, ${sqlLiteral(artifacts.adminRole.id)}::uuid FROM created_user
      RETURNING user_id, role_id
    ), created_grant AS (
      INSERT INTO public.sys_user_account_set (user_id, account_set_id, role_code, is_default, enabled)
      SELECT id, ${sqlLiteral(artifacts.accountSet.id)}::uuid, 'ADMIN', TRUE, TRUE FROM created_user
      RETURNING id, user_id
    )
    SELECT jsonb_build_object(
      'userId', created_user.id::text,
      'grantId', created_grant.id::text,
      'roleId', created_role.role_id::text
    )::text
    FROM created_user
    JOIN created_role ON created_role.user_id=created_user.id
    JOIN created_grant ON created_grant.user_id=created_user.id
  `);
  assertUuid(created?.userId, "A43 run user id");
  assertUuid(created?.grantId, "A43 run account-set grant id");
  assert(created?.roleId === artifacts.adminRole.id, "A43 run user role must be the prepared ADMIN role", created);
  artifacts.identity = created;
}

async function establishRunSession() {
  artifacts.session.cookie = await loginApi(apiBase, runUsername, runPassword, "BLD-TEST");
  parseSessionCookie();
  const session = await requireJson("/api/system/session", {}, [200]);
  assert(session?.authenticated === true
      && session.user?.username === runUsername
      && session.user?.name === runDisplayName
      && session.user?.roleCode === "ADMIN"
      && session.tenant?.id === artifacts.accountSet.id
      && session.tenant?.code === "BLD-TEST"
      && session.tenant?.schemaName === "public",
  "A43 dedicated session must bind the exact run actor and BLD-TEST/public route", session);
  const scopes = sessionScopeRows();
  assert(scopes.length === 1
      && scopes[0].user_id === artifacts.identity.userId
      && scopes[0].account_set_id === artifacts.accountSet.id,
  "A43 login must create exactly one persisted account scope for the run actor", scopes);
  registerSensitive(scopes[0]?.session_token, "session-token");
  registerSensitive(scopes[0]?.scope_token, "scope-token");
  assertUuid(scopes[0].session_token, "A43 persisted session token");
  assertUuid(scopes[0].scope_token, "A43 persisted account-scope token");
  artifacts.session.token = scopes[0].session_token;
  artifacts.session.scopeSnapshot = scopes[0];
  artifacts.session.redisAtLogin = redisSessionSnapshot();
  validateRedisBinding(artifacts.session.redisAtLogin, "login");
  evidence.environment.actor = { id: artifacts.identity.userId, username: runUsername };
  evidence.environment.session = {
    cookieName: parseSessionCookie().name,
    persistedScopeSha256: digest(artifacts.session.scopeSnapshot),
    redisBacked: artifacts.session.redisAtLogin.ownedKeys.length > 0 || artifacts.session.redisAtLogin.sharedMembers.length > 0,
    redisOwnedKeyCount: artifacts.session.redisAtLogin.ownedKeys.length,
    redisExpirationMemberCount: artifacts.session.redisAtLogin.sharedMembers.length
  };
}

function linePayload(source = {}) {
  return {
    productCode,
    warehouseCode,
    qty: quantity,
    unitPrice,
    taxRate: 13,
    lineRemark: `${fixtureKey}-line`,
    ...source
  };
}

async function createUniqueWarehouseAndSeed() {
  const createdWarehouse = await requireJson("/api/master-data/warehouse", {
    method: "POST",
    body: {
      code: warehouseCode,
      name: warehouseName,
      warehouseType: "普通仓",
      stockPolicy: "不允许负库存",
      status: "启用",
      remark: fixtureKey
    }
  }, [201]);
  assertUuid(createdWarehouse?.id, "A43 warehouse POST response id");
  artifacts.warehouse.id = String(createdWarehouse.id);
  const auditedWarehouse = await requireJson(`/api/master-data/warehouse/${encodeURIComponent(warehouseCode)}/audit`, {
    method: "POST"
  }, [200]);
  assert(auditedWarehouse?.id === artifacts.warehouse.id, "A43 warehouse audit must retain the response-owned UUID", auditedWarehouse);
  const warehouses = rowsJson(
    "md_warehouse",
    `row_value.id=${sqlLiteral(artifacts.warehouse.id)}::uuid OR row_value.code=${sqlLiteral(warehouseCode)}`
  );
  assert(warehouses.length === 1, "A43 warehouse UUID/code must resolve exactly once", warehouses);
  const [warehouse] = warehouses;
  assert(warehouse.id === artifacts.warehouse.id
      && warehouse.code === warehouseCode
      && warehouse.name === warehouseName
      && warehouse.remark === fixtureKey
      && warehouse.enabled === true
      && warehouse.audit_status === "AUDITED",
  "A43 warehouse full identity must remain response-owned, audited, enabled, and run-tagged", warehouse);
  artifacts.warehouse.snapshot = warehouse;

  const adjustment = await requireJson("/api/inventory/adjustments", {
    method: "POST",
    body: {
      productCode,
      warehouseCode,
      qtyDelta: quantity,
      txnType: seedTxnType,
      sourceBillType: seedSourceBillType
    }
  }, [201]);
  assertUuid(adjustment?.id, "A43 inventory adjustment balance response id");
  return { warehouse, adjustment };
}

async function createRedReverseChain() {
  const orderRow = await requireJson("/api/sales-orders/draft", {
    method: "POST",
    body: {
      customerCode,
      billDate,
      department: "销售部",
      ownerName: runDisplayName,
      remark: `${fixtureKey}-order`,
      lines: [linePayload()]
    }
  }, [201]);
  Object.assign(artifacts.documents.order, generatedIdentity(orderRow, "A43 sales order"));
  const orderAudit = await requireJson(`/api/sales-orders/${encodeURIComponent(artifacts.documents.order.billNo)}/audit`, {
    method: "POST"
  }, [200]);
  assert(orderAudit?.id === artifacts.documents.order.id && orderAudit?.status === "AUDITED",
    "A43 sales order audit must retain exact response identity", orderAudit);

  const noticeRow = await requireJson("/api/delivery-notices/draft", {
    method: "POST",
    body: {
      sourceOrderNo: artifacts.documents.order.billNo,
      customerCode,
      billDate,
      department: "销售部",
      ownerName: runDisplayName,
      remark: `${fixtureKey}-notice`,
      lines: [linePayload({
        sourceOrderNo: artifacts.documents.order.billNo,
        sourceLineNo: 1
      })]
    }
  }, [201]);
  Object.assign(artifacts.documents.notice, generatedIdentity(noticeRow, "A43 delivery notice"));
  const noticeAudit = await requireJson(`/api/delivery-notices/${encodeURIComponent(artifacts.documents.notice.billNo)}/audit`, {
    method: "POST"
  }, [200]);
  assert(noticeAudit?.id === artifacts.documents.notice.id && noticeAudit?.status === "AUDITED",
    "A43 delivery notice audit must retain exact response identity", noticeAudit);

  const outRow = await requireJson("/api/sales-outs/draft", {
    method: "POST",
    body: {
      sourceOrderNo: artifacts.documents.notice.billNo,
      customerCode,
      billDate,
      department: "销售部",
      ownerName: runDisplayName,
      remark: `${fixtureKey}-out`,
      lines: [linePayload({
        sourceOrderNo: artifacts.documents.notice.billNo,
        sourceLineNo: 1,
        sourceDeliveryNoticeNo: artifacts.documents.notice.billNo,
        sourceDeliveryLineNo: 1
      })]
    }
  }, [201]);
  Object.assign(artifacts.documents.out, generatedIdentity(outRow, "A43 sales out"));
  const outAudit = await requireJson(`/api/sales-outs/${encodeURIComponent(artifacts.documents.out.billNo)}/audit`, {
    method: "POST"
  }, [200]);
  assert(outAudit?.id === artifacts.documents.out.id && outAudit?.status === "AUDITED",
    "A43 sales-out audit must retain exact response identity", outAudit);

  const redRow = await requireJson(`/api/sales-outs/${encodeURIComponent(artifacts.documents.out.billNo)}/red-reverse`, {
    method: "POST",
    body: { billDate, ownerName: runDisplayName }
  }, [201]);
  Object.assign(artifacts.documents.red, generatedIdentity(redRow, "A43 sales-out red draft"));
  assert(redRow?.status === "DRAFT", "A43 red-reverse response must create one DRAFT red bill", redRow);
  const redAudit = await requireJson(`/api/sales-outs/${encodeURIComponent(artifacts.documents.red.billNo)}/audit`, {
    method: "POST"
  }, [200]);
  assert(redAudit?.id === artifacts.documents.red.id && redAudit?.status === "AUDITED",
    "A43 red-bill audit must retain exact response identity", redAudit);

  evidence.fixture.orderNo = artifacts.documents.order.billNo;
  evidence.fixture.noticeNo = artifacts.documents.notice.billNo;
  evidence.fixture.salesOutNo = artifacts.documents.out.billNo;
  evidence.fixture.salesRedReverseBillNo = artifacts.documents.red.billNo;
  return { orderAudit, noticeAudit, outAudit, redAudit };
}

function documentSnapshot() {
  const { order, notice, out, red } = artifacts.documents;
  return dbJson(`
    SELECT jsonb_build_object(
      'orderHeaders', COALESCE((
        SELECT jsonb_agg(to_jsonb(header) ORDER BY header.id)
        FROM public.sales_order header
        WHERE header.id = ANY(${uuidArray([order.id])}) OR header.bill_no = ANY(${textArray([order.billNo])})
      ), '[]'::jsonb),
      'orderLines', COALESCE((
        SELECT jsonb_agg(to_jsonb(line) ORDER BY line.id)
        FROM public.sales_order_line line
        WHERE line.order_id = ANY(${uuidArray([order.id])})
      ), '[]'::jsonb),
      'noticeHeaders', COALESCE((
        SELECT jsonb_agg(to_jsonb(header) ORDER BY header.id)
        FROM public.delivery_notice header
        WHERE header.id = ANY(${uuidArray([notice.id])}) OR header.bill_no = ANY(${textArray([notice.billNo])})
      ), '[]'::jsonb),
      'noticeLines', COALESCE((
        SELECT jsonb_agg(to_jsonb(line) ORDER BY line.id)
        FROM public.delivery_notice_line line
        WHERE line.bill_id = ANY(${uuidArray([notice.id])})
      ), '[]'::jsonb),
      'outHeaders', COALESCE((
        SELECT jsonb_agg(to_jsonb(header) ORDER BY header.id)
        FROM public.sales_out header
        WHERE header.id = ANY(${uuidArray([out.id, red.id])})
           OR header.bill_no = ANY(${textArray([out.billNo, red.billNo])})
      ), '[]'::jsonb),
      'outLines', COALESCE((
        SELECT jsonb_agg(to_jsonb(line) ORDER BY line.id)
        FROM public.sales_out_line line
        WHERE line.bill_id = ANY(${uuidArray([out.id, red.id])})
      ), '[]'::jsonb)
    )::text
  `);
}

function validateDocumentSnapshot(snapshot) {
  const { order, notice, out, red } = artifacts.documents;
  assert(snapshot?.orderHeaders?.length === 1 && snapshot.orderLines.length === 1,
    "A43 must capture exactly one response-owned sales order header and line", snapshot);
  assert(snapshot.noticeHeaders.length === 1 && snapshot.noticeLines.length === 1,
    "A43 must capture exactly one response-owned delivery notice header and line", snapshot);
  assert(snapshot.outHeaders.length === 2 && snapshot.outLines.length === 2,
    "A43 must capture exactly the response-owned original and red sales-out headers and lines", snapshot);
  const orderHeader = snapshot.orderHeaders[0];
  const noticeHeader = snapshot.noticeHeaders[0];
  const originalHeader = snapshot.outHeaders.find((row) => row.id === out.id);
  const redHeader = snapshot.outHeaders.find((row) => row.id === red.id);
  assert(orderHeader.id === order.id
      && orderHeader.bill_no === order.billNo
      && orderHeader.created_by === artifacts.identity.userId
      && orderHeader.remark === `${fixtureKey}-order`
      && orderHeader.status === "AUDITED",
  "A43 sales order complete snapshot differs from the recorded response identity", orderHeader);
  assert(noticeHeader.id === notice.id
      && noticeHeader.bill_no === notice.billNo
      && noticeHeader.created_by === artifacts.identity.userId
      && noticeHeader.remark === `${fixtureKey}-notice`
      && noticeHeader.status === "AUDITED",
  "A43 delivery notice complete snapshot differs from the recorded response identity", noticeHeader);
  assert(originalHeader
      && originalHeader.bill_no === out.billNo
      && originalHeader.created_by === artifacts.identity.userId
      && originalHeader.remark === `${fixtureKey}-out`
      && originalHeader.source_delivery_notice_id === notice.id
      && ["AUDITED", "RED_REVERSED"].includes(originalHeader.status),
  "A43 original sales-out complete snapshot differs from the recorded response/source identity", originalHeader);
  assert(redHeader
      && redHeader.bill_no === red.billNo
      && redHeader.red_source_bill_id === out.id
      && redHeader.status === "AUDITED",
  "A43 red sales-out complete snapshot differs from the exact response/source identity", redHeader);
  for (const [label, rows, expectedWarehouse, expectedProduct] of [
    ["order", snapshot.orderLines, artifacts.warehouse.id, artifacts.product.id],
    ["notice", snapshot.noticeLines, artifacts.warehouse.id, artifacts.product.id],
    ["out", snapshot.outLines, artifacts.warehouse.id, artifacts.product.id]
  ]) {
    assert(rows.every((row) => row.warehouse_id === expectedWarehouse && row.product_id === expectedProduct),
      `A43 ${label} lines must stay inside the run-unique warehouse/product scope`, rows);
  }
  assert(Number(snapshot.orderLines[0].qty) === quantity
      && Number(snapshot.noticeLines[0].qty) === quantity,
  "A43 order/notice quantity snapshots must remain positive and exact", snapshot);
  const originalLine = snapshot.outLines.find((row) => row.bill_id === out.id);
  const redLine = snapshot.outLines.find((row) => row.bill_id === red.id);
  assert(originalLine && redLine
      && Number(originalLine.qty) === quantity
      && Number(redLine.qty) === -quantity
      && redLine.line_remark === originalLine.line_remark,
  "A43 red line must be the exact negative copy of the original line", { originalLine, redLine });
  order.lineIds = snapshot.orderLines.map((row) => row.id);
  notice.lineIds = snapshot.noticeLines.map((row) => row.id);
  out.lineIds = [originalLine.id];
  red.lineIds = [redLine.id];
  [...order.lineIds, ...notice.lineIds, ...out.lineIds, ...red.lineIds].forEach((id) => assertUuid(id, "A43 captured line id"));
  return snapshot;
}

function inventorySnapshot() {
  return dbJson(`
    SELECT jsonb_build_object(
      'warehouse', COALESCE((
        SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
        FROM public.md_warehouse row_value
        WHERE row_value.id=${sqlLiteral(artifacts.warehouse.id)}::uuid
           OR row_value.code=${sqlLiteral(warehouseCode)}
      ), '[]'::jsonb),
      'balances', COALESCE((
        SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
        FROM public.inv_stock_balance row_value
        WHERE row_value.warehouse_id=${sqlLiteral(artifacts.warehouse.id)}::uuid
      ), '[]'::jsonb),
      'transactions', COALESCE((
        SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.occurred_at, row_value.id)
        FROM public.inv_stock_txn row_value
        WHERE row_value.warehouse_id=${sqlLiteral(artifacts.warehouse.id)}::uuid
      ), '[]'::jsonb)
    )::text
  `);
}

function validateInventorySnapshot(snapshot) {
  assert(snapshot?.warehouse?.length === 1 && jsonEqual(snapshot.warehouse[0], artifacts.warehouse.snapshot),
    "A43 warehouse complete snapshot must remain identical to the audited response-owned row", snapshot?.warehouse);
  assert(snapshot.balances.length === 1, "A43 run warehouse must own exactly one inventory balance", snapshot.balances);
  const [balance] = snapshot.balances;
  assert(balance.account_set_id === artifacts.accountSet.id
      && balance.product_id === artifacts.product.id
      && balance.warehouse_id === artifacts.warehouse.id
      && Number(balance.qty_on_hand) === quantity
      && Number(balance.qty_reserved) === quantity
      && Number(balance.qty_available) === 0,
  "A43 final balance must exactly reflect seed, reserve, out, and red-audit semantics", balance);
  const txns = snapshot.transactions;
  assert(txns.length === 4, "A43 unique warehouse must contain exactly seed/reserve/out/red transactions", txns);
  assert(new Set(txns.map((row) => row.id)).size === txns.length, "A43 inventory transaction UUIDs must be unique", txns);
  const documentSnapshotNow = documentSnapshot();
  const noticeLine = documentSnapshotNow.noticeLines[0];
  const outLine = documentSnapshotNow.outLines.find((row) => row.bill_id === artifacts.documents.out.id);
  const redLine = documentSnapshotNow.outLines.find((row) => row.bill_id === artifacts.documents.red.id);
  const expected = [
    {
      label: "seed",
      match: (row) => row.txn_type === seedTxnType
        && row.source_bill_type === seedSourceBillType
        && row.trace_quality === "TEST"
        && row.posting_action === "AUDIT"
        && Number(row.qty_delta) === quantity
    },
    {
      label: "delivery reserve",
      match: (row) => row.txn_type === "DELIVERY_NOTICE_RESERVE"
        && row.source_bill_type === "DELIVERY_NOTICE"
        && row.source_bill_id === artifacts.documents.notice.id
        && row.source_bill_line_id === noticeLine.id
        && row.source_bill_no === artifacts.documents.notice.billNo
        && row.trace_quality === "EXACT"
        && row.posting_action === "RESERVE"
        && Number(row.qty_delta) === 0
    },
    {
      label: "sales out",
      match: (row) => row.txn_type === "SALES_OUT"
        && row.source_bill_type === "SALES_OUT"
        && row.source_bill_id === artifacts.documents.out.id
        && row.source_bill_line_id === outLine.id
        && row.source_bill_no === artifacts.documents.out.billNo
        && row.trace_quality === "EXACT"
        && row.posting_action === "AUDIT"
        && Number(row.qty_delta) === -quantity
    },
    {
      label: "sales red audit",
      match: (row) => row.txn_type === "SALES_OUT_RED"
        && row.source_bill_type === "SALES_OUT"
        && row.source_bill_id === artifacts.documents.red.id
        && row.source_bill_line_id === redLine.id
        && row.source_bill_no === artifacts.documents.red.billNo
        && row.trace_quality === "EXACT"
        && row.posting_action === "RED_AUDIT"
        && Number(row.qty_delta) === quantity
    }
  ];
  for (const expectation of expected) {
    const matched = txns.filter(expectation.match);
    assert(matched.length === 1, `A43 must capture exactly one ${expectation.label} transaction`, { matched, txns });
  }
  assert(txns.every((row) => row.account_set_id === artifacts.accountSet.id
      && row.product_id === artifacts.product.id
      && row.warehouse_id === artifacts.warehouse.id),
  "A43 inventory transaction scope must be exact account-set/product/warehouse", txns);
  artifacts.inventoryTxnIds = txns.map((row) => row.id);
  artifacts.balanceIds = [balance.id];
  artifacts.inventoryTxnIds.forEach((id) => assertUuid(id, "A43 inventory transaction id"));
  artifacts.balanceIds.forEach((id) => assertUuid(id, "A43 inventory balance id"));
  return snapshot;
}

function receivableSnapshot() {
  const billNos = [artifacts.documents.out.billNo, artifacts.documents.red.billNo];
  return rowsJson(
    "ar_receivable",
    `row_value.source_bill_no = ANY(${textArray(billNos)}) OR row_value.id = ANY(${uuidArray(artifacts.receivableIds)})`
  );
}

function validateReceivableSnapshot(rows) {
  assert(rows.length === 2, "A43 audited original/red sales-outs must own exactly two receivable facts", rows);
  assert(new Set(rows.map((row) => row.id)).size === 2, "A43 receivable UUIDs must be unique", rows);
  const original = rows.find((row) => row.source_bill_no === artifacts.documents.out.billNo);
  const red = rows.find((row) => row.source_bill_no === artifacts.documents.red.billNo);
  assert(original && red
      && original.currency === "CNY"
      && red.currency === "CNY"
      && Number(original.amount) > 0
      && Number(red.amount) === -Number(original.amount)
      && Number(original.received_amount) === 0
      && Number(red.received_amount) === 0
      && Number(original.return_offset_amount) === 0
      && Number(red.return_offset_amount) === 0
      && original.status === "OPEN"
      && red.status === "OPEN",
  "A43 receivable facts must be exact unsettled positive/negative lifecycle pairs", { original, red });
  artifacts.receivableIds = rows.map((row) => row.id);
  artifacts.receivableIds.forEach((id) => assertUuid(id, "A43 receivable id"));
  return rows;
}

function runTargetIds() {
  return unique(Object.values(artifacts.documents).map((document) => document.id));
}

function runTargetNos() {
  return unique(Object.values(artifacts.documents).map((document) => document.billNo));
}

function operationLogSnapshot() {
  if (!artifacts.identity.userId) return [];
  return rowsJson(
    "sys_operation_log",
    `(row_value.operated_by=${sqlLiteral(artifacts.identity.userId)}::uuid
      OR row_value.actor_username=${sqlLiteral(runUsername)}
      OR row_value.target_id = ANY(${uuidArray(runTargetIds())})
      OR row_value.target_no = ANY(${textArray(runTargetNos())}))`,
    "row_value.operated_at, row_value.id"
  );
}

function formatBusinessTimestamp(value) {
  const date = new Date(value);
  assert(!Number.isNaN(date.getTime()), "A43 DB operation-log operated_at must be a valid timestamp", { type: typeof value });
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function expectedOperationLogRowFromDb(row) {
  assert(row && jsonEqual(Object.keys(row).sort(), operationLogDbFields),
    "A43 red operation-log DB proof must be one complete 18-column table row", {
      expectedColumns: operationLogDbFields,
      actualColumns: Object.keys(row ?? {}).sort()
    });
  assert(row.operated_by === artifacts.identity.userId
      && row.actor_type === "USER"
      && row.actor_username === runUsername
      && row.actor_display_name === runDisplayName
      && row.account_set_id === artifacts.accountSet.id
      && row.account_set_code === artifacts.accountSet.code
      && row.account_set_name === artifacts.accountSet.name
      && row.target_id === artifacts.documents.red.id
      && row.target_no === artifacts.documents.red.billNo
      && row.success === true,
  "A43 complete DB red operation-log row must match independently captured run identity/route/target", row);
  const actorUsername = row.actor_username ?? "";
  const actorDisplayName = row.actor_display_name ?? "";
  const operator = row.actor_type === "USER"
    ? (actorDisplayName ? `${actorDisplayName}（${actorUsername}）` : actorUsername)
    : ({ SYSTEM: "系统任务", ANONYMOUS: "未认证请求", HISTORICAL_UNKNOWN: "历史未知" }[row.actor_type] ?? "历史未知");
  return {
    id: row.id,
    operatedAt: formatBusinessTimestamp(row.operated_at),
    module: row.module_code,
    action: row.action_code,
    actorType: row.actor_type,
    actorUsername,
    actorDisplayName,
    operator,
    accountSetId: row.account_set_id ?? "",
    accountSetCode: row.account_set_code ?? "",
    accountSetName: row.account_set_name ?? "",
    targetType: row.target_type,
    targetId: row.target_id ?? "",
    targetNo: row.target_no ?? "",
    status: row.success ? "成功" : "失败",
    reason: row.failure_reason ?? "",
    beforeState: row.before_state ?? null,
    afterState: row.after_state ?? null
  };
}

function validateActorLogs(rows) {
  assert(rows.length > 0, "A43 run actor must own operation-log evidence", rows);
  assert(rows.every((row) => row.operated_by === artifacts.identity.userId
      && row.actor_type === "USER"
      && row.actor_username === runUsername
      && row.actor_display_name === runDisplayName),
  "A43 operation-log ownership must match exact run user UUID/username/display name", rows);
  const redLogs = rows.filter((row) => row.module_code === "SALES"
    && row.action_code === "RED_REVERSE"
    && row.target_type === "sales_out"
    && row.target_id === artifacts.documents.red.id
    && row.target_no === artifacts.documents.red.billNo
    && row.success === true);
  assert(redLogs.length === 1, "A43 must own exactly one successful RED_REVERSE log for the response-owned red bill", redLogs);
  artifacts.operationLogIds = rows.map((row) => row.id);
  artifacts.operationLogIds.forEach((id) => assertUuid(id, "A43 operation-log id"));
  artifacts.redReverseLogId = redLogs[0].id;
  artifacts.redOperationLogDbRow = redLogs[0];
  artifacts.expectedOperationLogRow = expectedOperationLogRowFromDb(redLogs[0]);
  return rows;
}

function lockSnapshot() {
  const bills = Object.values(artifacts.documents).map((document) => document.billNo);
  return rowsJson(
    "doc_edit_lock",
    `(row_value.holder_user_id=${sqlLiteral(artifacts.identity.userId)}::uuid
      OR row_value.holder_username=${sqlLiteral(runUsername)}
      OR row_value.bill_no = ANY(${textArray(bills)}))`,
    "row_value.document_type, row_value.bill_no"
  );
}

function validateLocks(rows) {
  assert(rows.every((row) => row.holder_user_id === artifacts.identity.userId && row.holder_username === runUsername),
    "A43 refuses any document lock not held by the run-unique actor", rows);
  return rows;
}

function outboxEventsExpression() {
  return `COALESCE((
    SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
    FROM public.sys_outbox_event row_value
    WHERE row_value.aggregate_id = ANY(${uuidArray(runTargetIds())})
  ), '[]'::jsonb)`;
}

function notificationOutboxExpression() {
  if (!notificationOutboxSourceSupported) return "'[]'::jsonb";
  return `COALESCE((
    SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
    FROM public.sys_notification_outbox row_value
    WHERE row_value.source_id = ANY(${uuidArray(runTargetIds())})
  ), '[]'::jsonb)`;
}

function auxiliarySnapshot() {
  const outLineIds = [...artifacts.documents.out.lineIds, ...artifacts.documents.red.lineIds];
  return dbJson(`
    SELECT jsonb_build_object(
      'receiptAllocations', COALESCE((
        SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
        FROM public.ar_receipt_allocation row_value
        WHERE row_value.receivable_id = ANY(${uuidArray(artifacts.receivableIds)})
      ), '[]'::jsonb),
      'returnAllocations', COALESCE((
        SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
        FROM public.sales_return_finance_allocation row_value
        WHERE row_value.receivable_id = ANY(${uuidArray(artifacts.receivableIds)})
      ), '[]'::jsonb),
      'legacyReceipts', COALESCE((
        SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
        FROM public.ar_receipt row_value
        WHERE row_value.legacy_receivable_id = ANY(${uuidArray(artifacts.receivableIds)})
      ), '[]'::jsonb),
      'salesReturnLines', COALESCE((
        SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
        FROM public.sales_return_line row_value
        WHERE row_value.source_out_line_id = ANY(${uuidArray(outLineIds)})
      ), '[]'::jsonb),
      'outboxEvents', ${outboxEventsExpression()},
      'notificationOutbox', ${notificationOutboxExpression()}
    )::text
  `);
}

function validateAuxiliary(snapshot) {
  assert(Object.values(snapshot ?? {}).every((rows) => Array.isArray(rows) && rows.length === 0),
    "A43 isolated chain refuses settlement, sales-return, outbox, or notification facts with unproven ownership", snapshot);
  return snapshot;
}

function foreignKeyReferenceCounts(targetTable, targetId) {
  const references = dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'table', constraint_row.conrelid::regclass::text,
      'column', attribute.attname,
      'constraint', constraint_row.conname
    ) ORDER BY constraint_row.conrelid::regclass::text, constraint_row.conname, attribute.attname), '[]'::jsonb)::text
    FROM pg_constraint constraint_row
    JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY key_column(attnum, ordinality) ON TRUE
    JOIN pg_attribute attribute
      ON attribute.attrelid=constraint_row.conrelid AND attribute.attnum=key_column.attnum
    WHERE constraint_row.contype='f'
      AND constraint_row.confrelid=${sqlLiteral(`public.${targetTable}`)}::regclass
  `) ?? [];
  return references.map((reference) => {
    assert(/^(?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*$/.test(reference.table), "A43 FK reference table must be a safe catalog identifier", reference);
    assert(/^[a-z_][a-z0-9_]*$/.test(reference.column), "A43 FK reference column must be a safe catalog identifier", reference);
    const table = reference.table.includes(".") ? reference.table : `public.${reference.table}`;
    return {
      ...reference,
      count: dbNumber(`SELECT count(*) FROM ${table} WHERE ${reference.column}=${sqlLiteral(targetId)}::uuid`)
    };
  });
}

function validateWarehouseReferences(counts) {
  const expected = new Map([
    ["public.inv_stock_balance.warehouse_id", 1],
    ["public.inv_stock_txn.warehouse_id", 4],
    ["public.sales_order_line.warehouse_id", 1],
    ["public.delivery_notice_line.warehouse_id", 1],
    ["public.sales_out_line.warehouse_id", 2]
  ]);
  for (const row of counts) {
    const table = row.table.includes(".") ? row.table : `public.${row.table}`;
    const key = `${table}.${row.column}`;
    assert(row.count === (expected.get(key) ?? 0), "A43 run warehouse has an unexpected FK reference count", { key, expected: expected.get(key) ?? 0, row });
  }
  for (const [key, count] of expected) {
    assert(counts.some((row) => `${row.table.includes(".") ? row.table : `public.${row.table}`}.${row.column}` === key && row.count === count),
      "A43 warehouse reference catalog is missing an expected fixture relation", { key, count, counts });
  }
  return counts;
}

function validateUserReferences(counts, expectedScopeCount) {
  const expected = new Map([
    ["public.sys_user_role.user_id", 1],
    ["public.sys_user_account_set.user_id", 1],
    ["public.sys_session_account_scope.user_id", expectedScopeCount],
    ["public.sales_order.created_by", 1],
    ["public.delivery_notice.created_by", 1],
    ["public.sales_out.created_by", 1]
  ]);
  for (const row of counts) {
    const table = row.table.includes(".") ? row.table : `public.${row.table}`;
    const key = `${table}.${row.column}`;
    assert(row.count === (expected.get(key) ?? 0), "A43 run user has an unexpected FK reference count", { key, expected: expected.get(key) ?? 0, row });
  }
  return counts;
}

function assertFixtureComplete() {
  assert(controlledWriteAuthorized, "A43 cleanup requires the exact controlled local write gate");
  assertUuid(artifacts.identity.userId, "A43 cleanup user id");
  assertUuid(artifacts.warehouse.id, "A43 cleanup warehouse id");
  for (const [kind, document] of Object.entries(artifacts.documents)) {
    assertUuid(document.id, `A43 cleanup ${kind} header id`);
    assert(document.billNo, `A43 cleanup ${kind} bill number must be captured from the response`, document);
  }
}

function validateCleanupIdentity(identity) {
  assert(identity?.users?.length === 1, "A43 cleanup must resolve exactly one response-owned run user", identity?.users);
  const [user] = identity.users;
  assert(user.id === artifacts.identity.userId
      && user.username === runUsername
      && user.display_name === runDisplayName
      && user.enabled === true
      && user.default_account_set_id === artifacts.accountSet.id
      && user.active_session_token === null,
  "A43 cleanup user snapshot must be the exact logged-out run identity", user);
  assert(identity.roles.length === 1
      && identity.roles[0].user_id === artifacts.identity.userId
      && identity.roles[0].role_id === artifacts.adminRole.id,
  "A43 cleanup must resolve exactly one ADMIN role link for the run identity", identity.roles);
  assert(identity.grants.length === 1
      && identity.grants[0].id === artifacts.identity.grantId
      && identity.grants[0].user_id === artifacts.identity.userId
      && identity.grants[0].account_set_id === artifacts.accountSet.id
      && identity.grants[0].role_code === "ADMIN"
      && identity.grants[0].is_default === true
      && identity.grants[0].enabled === true,
  "A43 cleanup must resolve exactly one BLD-TEST ADMIN grant for the run identity", identity.grants);
  assert(identity.sessionScopes.length === 0, "A43 cleanup identity must have zero persisted session scopes after logout", identity.sessionScopes);
  return identity;
}

function exportQuery(redBillNo, pageSize = "1000") {
  return new URLSearchParams({
    keyword: redBillNo,
    scope: "current",
    actorType: "USER",
    columnFilters: JSON.stringify({ status: { operator: "等于", value: "成功" } }),
    module: "SALES",
    action: "RED_REVERSE",
    operator: runUsername,
    targetType: "sales_out",
    dateFrom: logDate,
    dateTo: logDate,
    page: "1",
    pageSize
  });
}

function expectedFilterValues(redBillNo) {
  return {
    keyword: redBillNo,
    module: "SALES",
    action: "RED_REVERSE",
    scope: "current",
    actorType: "USER",
    operator: runUsername,
    targetType: "sales_out",
    dateFrom: logDate,
    dateTo: logDate,
    columnFilters: { status: { operator: "等于", value: "成功" } }
  };
}

function parseQuery(urlValue) {
  const url = new URL(urlValue);
  const params = Object.fromEntries(url.searchParams.entries());
  let columnFilters = null;
  try {
    columnFilters = JSON.parse(url.searchParams.get("columnFilters") || "{}");
  } catch (error) {
    throw new Error(`A43 request columnFilters is not valid JSON: ${errorText(error)}`);
  }
  return { url, params, columnFilters };
}

function assertExactOperationLogQuery(urlValue, redBillNo, label) {
  const parsed = parseQuery(urlValue);
  const expected = expectedFilterValues(redBillNo);
  for (const field of ["keyword", "module", "action", "scope", "actorType", "operator", "targetType", "dateFrom", "dateTo"]) {
    assert(parsed.url.searchParams.get(field) === expected[field],
      `${label} must preserve the exact ${field} filter`, { expected: expected[field], actual: parsed.url.searchParams.get(field), url: urlValue });
  }
  assert(jsonEqual(parsed.columnFilters, expected.columnFilters),
    `${label} must preserve the exact structured status column filter`, { expected: expected.columnFilters, actual: parsed.columnFilters, url: urlValue });
  return parsed;
}

function matchesExactOperationLogResponse(response, pathname, redBillNo) {
  if (response.request().method() !== "GET") return false;
  const url = new URL(response.url());
  if (url.pathname !== pathname) return false;
  try {
    assertExactOperationLogQuery(response.url(), redBillNo, `A43 ${pathname} candidate`);
    return true;
  } catch {
    return false;
  }
}

function parseCsvDocument(text) {
  const source = text.replace(/^\uFEFF/, "");
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n") {
      record.push(field.replace(/\r$/, ""));
      if (record.some((value) => value !== "")) records.push(record);
      record = [];
      field = "";
    } else field += char;
  }
  if (field || record.length) {
    record.push(field.replace(/\r$/, ""));
    records.push(record);
  }
  const [headers = [], ...rows] = records;
  return {
    headers,
    rows: rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])))
  };
}

function parseCsv(text) {
  return parseCsvDocument(text).rows;
}

function assertIncludes(label, text, expected) {
  assert(text.includes(expected), `${label} must include ${expected}`);
}

function assertOperationLogFields(actual, label) {
  const expected = artifacts.expectedOperationLogRow;
  assert(expected && operationLogFields.length === 18, "A43 canonical DB operation-log expectation must contain 18 export fields");
  assert(actual && typeof actual === "object", `${label} must be one operation-log row`, actual);
  for (const field of operationLogFields) {
    assert(Object.hasOwn(actual, field), `${label} must expose canonical field ${field}`, { field, actualFields: Object.keys(actual) });
    const matches = field === "beforeState" || field === "afterState"
      ? jsonEqual(actual[field], expected[field])
      : actual[field] === expected[field];
    assert(matches, `${label} canonical DB field ${field} mismatch`, {
      field,
      expected: expected[field],
      actual: actual[field]
    });
  }
  assert(actual.success === artifacts.redOperationLogDbRow.success,
    `${label} success flag must match the complete DB row`, {
      expected: artifacts.redOperationLogDbRow.success,
      actual: actual.success
    });
  return actual;
}

function expectedCsvValue(field) {
  const value = artifacts.expectedOperationLogRow[field];
  return value && typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
}

function assertOperationLogCsv(csv, label) {
  const document = parseCsvDocument(csv);
  const expectedHeaders = operationLogCsvColumns.map(([, header]) => header);
  assert(jsonEqual(document.headers, expectedHeaders), `${label} must expose exactly the canonical 18 CSV columns in order`, {
    expectedHeaders,
    actualHeaders: document.headers
  });
  assert(document.rows.length === 1, `${label} must contain exactly one DB-proven red-reverse row`, {
    rowCount: document.rows.length
  });
  const [row] = document.rows;
  for (const [field, header] of operationLogCsvColumns) {
    assert(String(row[header] ?? "") === expectedCsvValue(field), `${label} canonical DB field ${field} mismatch`, {
      field,
      header,
      expected: expectedCsvValue(field),
      actual: String(row[header] ?? "")
    });
  }
  return document;
}

function assertExactRedList(rows, label) {
  assert(Array.isArray(rows) && rows.length === 1, `${label} must return exactly one run-owned red-reverse row`, rows);
  const [row] = rows;
  return assertOperationLogFields(row, label);
}

async function ensureOperationLogFilters(page) {
  const moduleFilter = page.getByTestId("operation-log-module");
  if (await moduleFilter.isVisible({ timeout: 500 }).catch(() => false)) return;
  await page.getByTestId("list-toggle-filter").click();
  if (await moduleFilter.isVisible({ timeout: 500 }).catch(() => false)) return;
  await page.getByTestId("list-toggle-filter").click();
  await moduleFilter.waitFor({ state: "visible" });
}

async function assertRenderedOperationLogFields(page) {
  await page.getByTestId("column-settings").click();
  const dialog = page.getByTestId("column-settings-dialog");
  await dialog.waitFor({ state: "visible" });
  const checkboxes = dialog.locator('input[type="checkbox"]:not(:disabled)');
  const checkboxCount = await checkboxes.count();
  assert(checkboxCount === 16, "A43 operation-log UI must configure exactly 16 list columns", { checkboxCount });
  for (let index = 0; index < checkboxCount; index += 1) {
    const checkbox = checkboxes.nth(index);
    if (!await checkbox.isChecked()) await checkbox.check();
  }
  await page.getByTestId("column-settings-ok").click();
  await dialog.waitFor({ state: "hidden" });
  const table = page.getByTestId("vxe-list-table");
  await table.locator(".table-core-header-wrapper th").filter({ hasText: "日志ID" }).waitFor({ state: "visible" });
  const rendered = await table.evaluate((frame) => {
    const headers = [...frame.querySelectorAll(".table-core-header-wrapper thead th")]
      .map((cell) => (cell.querySelector(".column-header-title")?.textContent ?? "").trim());
    const row = frame.querySelector(".table-core-body-wrapper tbody tr");
    const cells = row ? [...row.querySelectorAll("td")].map((cell) => (cell.textContent ?? "").trim()) : [];
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
  });
  const expectedUiValues = {
    ...artifacts.expectedOperationLogRow,
    actorType: ({ USER: "用户", SYSTEM: "系统任务", ANONYMOUS: "未认证请求", HISTORICAL_UNKNOWN: "历史未知" })[
      artifacts.expectedOperationLogRow.actorType
    ] ?? artifacts.expectedOperationLogRow.actorType
  };
  const listColumns = operationLogCsvColumns.filter(([field]) => !["beforeState", "afterState"].includes(field));
  for (const [field, header] of listColumns) {
    assert(Object.hasOwn(rendered, header), `A43 rendered UI must expose column ${header}`, {
      field,
      renderedHeaders: Object.keys(rendered)
    });
    assert(rendered[header] === String(expectedUiValues[field] ?? ""), `A43 rendered UI field ${field} mismatch`, {
      field,
      header,
      expected: String(expectedUiValues[field] ?? ""),
      actual: rendered[header]
    });
  }
  await page.getByTestId("column-settings").click();
  await dialog.waitFor({ state: "visible" });
  await dialog.getByRole("button", { name: "恢复默认", exact: true }).click();
  await page.getByTestId("column-settings-ok").click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByTestId("vxe-list-table").getByText(artifacts.documents.red.billNo).waitFor({ state: "visible" });
  return {
    listFieldCount: listColumns.length,
    renderedRowSha256: digest(rendered)
  };
}

async function apiParityChecks() {
  const query = exportQuery(artifacts.documents.red.billNo);
  const listResult = await requireJson(`/api/lists/operation-log-list?${query.toString()}`, { method: "GET" }, [200]);
  assertExactRedList(listResult.rows, "A43 API list");
  const csv = await requireText(`/api/lists/operation-log-list/export.csv?${query.toString()}`, { method: "GET" }, [200]);
  assertIncludes("A43 API CSV header", csv, "日志ID,操作时间,模块,动作,主体类型,操作人账号,操作时姓名,操作人,账套ID,账套编码,账套名称,对象类型,对象ID,业务单号,状态,失败原因,操作前状态,操作后状态");
  assertIncludes("A43 API CSV red bill", csv, artifacts.documents.red.billNo);
  assertIncludes("A43 API CSV operator", csv, operatorLabel);
  assertOperationLogCsv(csv, "A43 API export");

  const mismatch = exportQuery(artifacts.documents.red.billNo);
  mismatch.set("targetType", "purchase_in");
  const mismatchCsv = await requireText(`/api/lists/operation-log-list/export.csv?${mismatch.toString()}`, { method: "GET" }, [200]);
  assert(parseCsv(mismatchCsv).length === 0 && !mismatchCsv.includes(artifacts.documents.red.billNo),
    "A43 mismatched targetType export must contain zero run-owned rows");
  return {
    request: Object.fromEntries(query.entries()),
    rowIds: listResult.rows.map((row) => row.id),
    canonicalFieldCount: operationLogFields.length,
    canonicalDbRowSha256: digest(artifacts.redOperationLogDbRow),
    canonicalExpectedRowSha256: digest(artifacts.expectedOperationLogRow),
    csvSha256: digest(csv),
    mismatchRowCount: parseCsv(mismatchCsv).length
  };
}

async function browserParityChecks() {
  const cookie = parseSessionCookie();
  assert(cookie, "A43 browser acceptance requires the exact dedicated session cookie");
  const browser = await chromium.launch({ headless: true });
  artifacts.browser = { browser, context: null, page: null, screenshots: [] };
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, acceptDownloads: true });
  artifacts.browser.context = context;
  await context.addCookies([{ name: cookie.name, value: cookie.value, url: frontendUrl }]);
  const page = await context.newPage();
  artifacts.browser.page = page;
  let downloadedCsv = "";
  let responseCsv = "";
  let downloadFileName = "";
  let uiListBody = null;
  let uiRequest = null;
  let exportRequest = null;
  let renderedUi = null;
  try {
    await page.goto(frontendUrl, { waitUntil: "networkidle" });
    await page.getByTestId("content-area").waitFor({ state: "visible", timeout: 10000 });
    const browserSession = await page.evaluate(async () => {
      const response = await fetch("/api/system/session");
      return { status: response.status, body: await response.json() };
    });
    assert(browserSession.status === 200
        && browserSession.body?.authenticated === true
        && browserSession.body?.user?.username === runUsername
        && browserSession.body?.tenant?.id === artifacts.accountSet.id
        && browserSession.body?.tenant?.code === "BLD-TEST"
        && browserSession.body?.tenant?.schemaName === "public",
    "A43 browser must reuse the exact dedicated API session and route", browserSession);

    await page.getByTestId("module-系统设置").hover();
    await page.getByTestId("query-operation-log-list").click();
    await page.getByTestId("tab-operation-log-list").waitFor({ state: "visible" });
    await ensureOperationLogFilters(page);
    await page.getByTestId("list-keyword").fill(artifacts.documents.red.billNo);
    await page.getByTestId("operation-log-module").selectOption("SALES");
    await page.getByTestId("operation-log-action").selectOption("RED_REVERSE");
    await page.getByTestId("operation-log-scope").selectOption("current");
    await page.getByTestId("operation-log-actor-type").selectOption("USER");
    await page.getByTestId("operation-log-operator").fill(runUsername);
    await page.getByTestId("operation-log-target-type").selectOption("sales_out");
    await page.getByTestId("list-date-range").click();
    await page.getByTestId("list-date-from").fill(logDate);
    await page.getByTestId("list-date-to").fill(logDate);
    await page.getByTestId("list-date-range-apply").click();
    await page.getByTestId("column-filter-status").click();
    await page.getByTestId("column-filter-dialog").getByRole("button", { name: "等于", exact: true }).click();
    await page.getByTestId("column-filter-input").fill("成功");
    const listResponsePromise = page.waitForResponse(
      (response) => matchesExactOperationLogResponse(response, "/api/lists/operation-log-list", artifacts.documents.red.billNo),
      { timeout: 10000 }
    );
    await page.getByTestId("column-filter-ok").click();
    const listResponse = await listResponsePromise;
    assert(listResponse.status() === 200, "A43 exact UI list response must return 200", listResponse.status());
    uiRequest = assertExactOperationLogQuery(listResponse.url(), artifacts.documents.red.billNo, "A43 UI list response");
    uiListBody = await listResponse.json();
    assertExactRedList(uiListBody.rows, "A43 UI response");
    const directUiList = await requireJson(`${uiRequest.url.pathname}?${uiRequest.url.searchParams.toString()}`, { method: "GET" }, [200]);
    assert(jsonEqual(directUiList, uiListBody), "A43 UI response must equal a direct API read with the exact same full query", {
      ui: uiListBody,
      direct: directUiList
    });
    assertExactRedList(directUiList.rows, "A43 direct same-query API list");
    await page.getByTestId("vxe-list-table").getByText(artifacts.documents.red.billNo).waitFor({ state: "visible" });
    renderedUi = await assertRenderedOperationLogFields(page);

    const detailPath = `/api/lists/operation-log-list/rows/${encodeURIComponent(artifacts.redReverseLogId)}`;
    const detailResponsePromise = page.waitForResponse((response) => {
      if (response.request().method() !== "GET") return false;
      const url = new URL(response.url());
      return url.pathname === detailPath && url.searchParams.get("scope") === "current";
    }, { timeout: 10000 });
    await page.getByTestId(`operation-log-open-detail-${artifacts.redReverseLogId}`).click();
    const detailResponse = await detailResponsePromise;
    assert(detailResponse.status() === 200, "A43 UI detail response must return 200", detailResponse.status());
    const detailBody = await detailResponse.json();
    assertOperationLogFields(detailBody, "A43 UI detail response");
    const drawer = page.getByTestId("operation-log-detail-drawer");
    await drawer.waitFor({ state: "visible" });
    await drawer.getByText(artifacts.expectedOperationLogRow.id, { exact: true }).waitFor({ state: "visible" });
    await drawer.getByText(artifacts.expectedOperationLogRow.operatedAt, { exact: true }).waitFor({ state: "visible" });
    await drawer.getByTestId("operation-log-detail-actor").getByText(operatorLabel, { exact: false }).waitFor({ state: "visible" });
    await drawer.getByTestId("operation-log-detail-actor-username").getByText(runUsername, { exact: true }).waitFor({ state: "visible" });
    await drawer.getByTestId("operation-log-detail-actor-display-name").getByText(runDisplayName, { exact: true }).waitFor({ state: "visible" });
    await drawer.getByTestId("operation-log-detail-account-set")
      .getByText(`${artifacts.expectedOperationLogRow.accountSetName}（${artifacts.expectedOperationLogRow.accountSetCode}）`, { exact: true })
      .waitFor({ state: "visible" });
    await drawer.getByTestId("operation-log-detail-target")
      .getByText(`${artifacts.expectedOperationLogRow.targetType} / ${artifacts.expectedOperationLogRow.targetNo}`, { exact: true })
      .waitFor({ state: "visible" });
    await drawer.getByText(artifacts.expectedOperationLogRow.status, { exact: true }).waitFor({ state: "visible" });
    await drawer.getByTestId("operation-log-detail-reason").getByText("-", { exact: true }).waitFor({ state: "visible" });
    await drawer.getByTestId("operation-log-detail-before-state")
      .getByText(JSON.stringify(artifacts.expectedOperationLogRow.beforeState, null, 2), { exact: true })
      .waitFor({ state: "visible" });
    await drawer.getByTestId("operation-log-detail-after-state")
      .getByText(JSON.stringify(artifacts.expectedOperationLogRow.afterState, null, 2), { exact: true })
      .waitFor({ state: "visible" });
    await page.getByTestId("operation-log-detail-close").click();
    await drawer.waitFor({ state: "hidden" });

    await page.getByTestId("list-more-actions").hover();
    const exportResponsePromise = page.waitForResponse(
      (response) => matchesExactOperationLogResponse(response, "/api/lists/operation-log-list/export.csv", artifacts.documents.red.billNo),
      { timeout: 10000 }
    );
    const [download, exportResponse] = await Promise.all([
      page.waitForEvent("download", { timeout: 10000 }),
      exportResponsePromise,
      page.getByTestId("list-export").click()
    ]);
    assert(exportResponse.status() === 200, "A43 exact UI export response must return 200", exportResponse.status());
    exportRequest = assertExactOperationLogQuery(exportResponse.url(), artifacts.documents.red.billNo, "A43 UI export response");
    downloadFileName = download.suggestedFilename();
    const downloadPath = await download.path();
    assert(downloadPath, "A43 browser download must expose its exact temporary file path");
    downloadedCsv = await readFile(downloadPath, "utf8");
    responseCsv = (await exportResponse.body()).toString("utf8");
    assert(digest(downloadedCsv) === digest(responseCsv),
      "A43 downloaded CSV bytes must equal the exact matched export response body", {
        downloadedSha256: digest(downloadedCsv),
        responseSha256: digest(responseCsv)
      });
    assertOperationLogCsv(downloadedCsv, "A43 UI downloaded export");
    assertExactRedList(uiListBody.rows, "A43 UI response before downloaded parity");
    assertIncludes("A43 downloaded CSV red bill", downloadedCsv, artifacts.documents.red.billNo);
    assertIncludes("A43 downloaded CSV target type", downloadedCsv, "sales_out");
    assertIncludes("A43 downloaded CSV operator", downloadedCsv, operatorLabel);
    await page.getByTestId("list-export-message").getByText("引出文件已生成").waitFor({ state: "visible" });
    const screenshotName = `a43-operation-log-export-${runToken}.png`;
    const screenshotPath = path.join(screenshotDir, screenshotName);
    artifacts.browser.screenshots.push(screenshotPath);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return {
      browserSession: {
        username: browserSession.body.user.username,
        accountSetId: browserSession.body.tenant.id,
        accountSetCode: browserSession.body.tenant.code,
        schemaName: browserSession.body.tenant.schemaName
      },
      listRequest: uiRequest.params,
      exportRequest: exportRequest.params,
      listRowIds: uiListBody.rows.map((row) => row.id),
      canonicalFieldCount: operationLogFields.length,
      renderedListFieldCount: renderedUi.listFieldCount,
      renderedRowSha256: renderedUi.renderedRowSha256,
      detailRowSha256: digest(detailBody),
      downloadFileName,
      downloadedCsvSha256: digest(downloadedCsv),
      responseCsvSha256: digest(responseCsv),
      screenshot: `verification/playwright/${screenshotName}`
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close();
    evidence.cleanup.browserClosed = true;
    artifacts.browser.browser = null;
    artifacts.browser.context = null;
    artifacts.browser.page = null;
  }
}

async function closeRunSession() {
  if (!artifacts.identity.userId) return;
  if (!artifacts.session.cookie) {
    const redis = redisSessionSnapshot();
    assert(redis.ownedKeys.length === 0 && redis.sharedMembers.length === 0,
      "A43 refuses to claim a response-loss Redis session without an exact cookie", redisEvidence(redis));
    evidence.cleanup.logout = { skipped: true, reason: "cookie-not-captured" };
    evidence.cleanup.redis = {
      captured: null,
      before: redisEvidence(redis),
      after: redisEvidence(redis)
    };
    return;
  }
  const scopes = sessionScopeRows();
  assert(scopes.length === 1 && jsonEqual(scopes[0], artifacts.session.scopeSnapshot),
    "A43 persisted session scope changed before logout", {
      expectedSha256: digest(artifacts.session.scopeSnapshot),
      actualSha256: digest(scopes)
    });
  artifacts.session.redisBeforeLogout = redisSessionSnapshot();
  validateRedisBinding(artifacts.session.redisBeforeLogout, "before logout");
  assert(unique(artifacts.session.redisAtLogin?.ownedKeys.map((entry) => entry.key) ?? [])
      .every((key) => artifacts.session.redisBeforeLogout.ownedKeys.some((entry) => entry.key === key)),
  "A43 pre-logout Redis key set must retain every login-captured owned key", {
    login: redisEvidence(artifacts.session.redisAtLogin),
    beforeLogout: redisEvidence(artifacts.session.redisBeforeLogout)
  });
  const logout = await http("/api/system/logout", { method: "POST" }, artifacts.session.cookie);
  artifacts.session.logoutStatus = logout.status;
  evidence.cleanup.logout = { status: logout.status, body: logout.data };
  const redisCleanup = cleanupRedisSession();
  evidence.cleanup.redis = {
    captured: redisEvidence(redisCleanup.captured),
    before: redisEvidence(redisCleanup.before),
    after: redisEvidence(redisCleanup.after)
  };
  const after = await http("/api/system/session", {}, artifacts.session.cookie);
  artifacts.session.postLogoutAuthenticated = after.data?.authenticated === true;
  evidence.cleanup.logout.postLogoutStatus = after.status;
  evidence.cleanup.logout.postLogoutAuthenticated = artifacts.session.postLogoutAuthenticated;
  assert(logout.status === 200 && logout.data?.ok === true, "A43 dedicated logout endpoint must succeed", logout);
  assert(after.status === 401 || after.data?.authenticated === false,
    "A43 logged-out cookie must no longer authenticate", after);
  assert(sessionScopeRows().length === 0, "A43 logout must remove the exact persisted account scope", sessionScopeRows());
}

function cleanupSnapshotExpression() {
  const { order, notice, out, red } = artifacts.documents;
  const billNos = [order.billNo, notice.billNo, out.billNo, red.billNo];
  return `jsonb_build_object(
    'identity', jsonb_build_object(
      'users', COALESCE((
        SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
        FROM public.sys_user row_value
        WHERE row_value.id=${sqlLiteral(artifacts.identity.userId)}::uuid OR row_value.username=${sqlLiteral(runUsername)}
      ), '[]'::jsonb),
      'roles', COALESCE((
        SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.user_id, row_value.role_id)
        FROM public.sys_user_role row_value
        WHERE row_value.user_id=${sqlLiteral(artifacts.identity.userId)}::uuid
      ), '[]'::jsonb),
      'grants', COALESCE((
        SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
        FROM public.sys_user_account_set row_value
        WHERE row_value.user_id=${sqlLiteral(artifacts.identity.userId)}::uuid
      ), '[]'::jsonb),
      'sessionScopes', COALESCE((
        SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.session_token)
        FROM public.sys_session_account_scope row_value
        WHERE row_value.user_id=${sqlLiteral(artifacts.identity.userId)}::uuid
      ), '[]'::jsonb)
    ),
    'warehouse', COALESCE((
      SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
      FROM public.md_warehouse row_value
      WHERE row_value.id=${sqlLiteral(artifacts.warehouse.id)}::uuid OR row_value.code=${sqlLiteral(warehouseCode)}
    ), '[]'::jsonb),
    'balances', COALESCE((
      SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
      FROM public.inv_stock_balance row_value
      WHERE row_value.warehouse_id=${sqlLiteral(artifacts.warehouse.id)}::uuid OR row_value.id = ANY(${uuidArray(artifacts.balanceIds)})
    ), '[]'::jsonb),
    'transactions', COALESCE((
      SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.occurred_at, row_value.id)
      FROM public.inv_stock_txn row_value
      WHERE row_value.warehouse_id=${sqlLiteral(artifacts.warehouse.id)}::uuid OR row_value.id = ANY(${uuidArray(artifacts.inventoryTxnIds)})
    ), '[]'::jsonb),
    'orderHeaders', COALESCE((
      SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
      FROM public.sales_order row_value
      WHERE row_value.id=${sqlLiteral(order.id)}::uuid OR row_value.bill_no=${sqlLiteral(order.billNo)}
    ), '[]'::jsonb),
    'orderLines', COALESCE((
      SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
      FROM public.sales_order_line row_value
      WHERE row_value.order_id=${sqlLiteral(order.id)}::uuid OR row_value.id = ANY(${uuidArray(order.lineIds)})
    ), '[]'::jsonb),
    'noticeHeaders', COALESCE((
      SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
      FROM public.delivery_notice row_value
      WHERE row_value.id=${sqlLiteral(notice.id)}::uuid OR row_value.bill_no=${sqlLiteral(notice.billNo)}
    ), '[]'::jsonb),
    'noticeLines', COALESCE((
      SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
      FROM public.delivery_notice_line row_value
      WHERE row_value.bill_id=${sqlLiteral(notice.id)}::uuid OR row_value.id = ANY(${uuidArray(notice.lineIds)})
    ), '[]'::jsonb),
    'outHeaders', COALESCE((
      SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
      FROM public.sales_out row_value
      WHERE row_value.id = ANY(${uuidArray([out.id, red.id])}) OR row_value.bill_no = ANY(${textArray([out.billNo, red.billNo])})
    ), '[]'::jsonb),
    'outLines', COALESCE((
      SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
      FROM public.sales_out_line row_value
      WHERE row_value.bill_id = ANY(${uuidArray([out.id, red.id])})
         OR row_value.id = ANY(${uuidArray([...out.lineIds, ...red.lineIds])})
    ), '[]'::jsonb),
    'receivables', COALESCE((
      SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
      FROM public.ar_receivable row_value
      WHERE row_value.id = ANY(${uuidArray(artifacts.receivableIds)})
         OR row_value.source_bill_no = ANY(${textArray([out.billNo, red.billNo])})
    ), '[]'::jsonb),
    'logs', COALESCE((
      SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.operated_at, row_value.id)
      FROM public.sys_operation_log row_value
      WHERE row_value.id = ANY(${uuidArray(artifacts.operationLogIds)})
         OR row_value.operated_by=${sqlLiteral(artifacts.identity.userId)}::uuid
         OR row_value.actor_username=${sqlLiteral(runUsername)}
         OR row_value.target_id = ANY(${uuidArray(runTargetIds())})
         OR row_value.target_no = ANY(${textArray(billNos)})
    ), '[]'::jsonb),
    'locks', COALESCE((
      SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.document_type, row_value.bill_no)
      FROM public.doc_edit_lock row_value
      WHERE row_value.holder_user_id=${sqlLiteral(artifacts.identity.userId)}::uuid
         OR row_value.holder_username=${sqlLiteral(runUsername)}
         OR row_value.bill_no = ANY(${textArray(billNos)})
    ), '[]'::jsonb),
    'auxiliary', jsonb_build_object(
      'receiptAllocations', COALESCE((
        SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
        FROM public.ar_receipt_allocation row_value
        WHERE row_value.receivable_id = ANY(${uuidArray(artifacts.receivableIds)})
      ), '[]'::jsonb),
      'returnAllocations', COALESCE((
        SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
        FROM public.sales_return_finance_allocation row_value
        WHERE row_value.receivable_id = ANY(${uuidArray(artifacts.receivableIds)})
      ), '[]'::jsonb),
      'legacyReceipts', COALESCE((
        SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
        FROM public.ar_receipt row_value
        WHERE row_value.legacy_receivable_id = ANY(${uuidArray(artifacts.receivableIds)})
      ), '[]'::jsonb),
      'salesReturnLines', COALESCE((
        SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
        FROM public.sales_return_line row_value
        WHERE row_value.source_out_line_id = ANY(${uuidArray([...out.lineIds, ...red.lineIds])})
      ), '[]'::jsonb),
      'outboxEvents', ${outboxEventsExpression()},
      'notificationOutbox', ${notificationOutboxExpression()}
    )
  )`;
}

function captureCleanupSnapshot() {
  assertFixtureComplete();
  const documents = validateDocumentSnapshot(documentSnapshot());
  const inventory = validateInventorySnapshot(inventorySnapshot());
  const receivables = validateReceivableSnapshot(receivableSnapshot());
  const logs = validateActorLogs(operationLogSnapshot());
  const locks = validateLocks(lockSnapshot());
  const auxiliary = validateAuxiliary(auxiliarySnapshot());
  const scopes = sessionScopeRows();
  assert(scopes.length === 0, "A43 cleanup snapshot requires the dedicated session to be logged out", scopes);
  const warehouseReferences = validateWarehouseReferences(foreignKeyReferenceCounts("md_warehouse", artifacts.warehouse.id));
  const userReferences = validateUserReferences(foreignKeyReferenceCounts("sys_user", artifacts.identity.userId), 0);
  const snapshot = dbJson(`SELECT (${cleanupSnapshotExpression()})::text`);
  assert(snapshot, "A43 cleanup requires one complete semantic snapshot");
  validateCleanupIdentity(snapshot.identity);
  assert(jsonEqual(snapshot.orderHeaders, documents.orderHeaders)
      && jsonEqual(snapshot.orderLines, documents.orderLines)
      && jsonEqual(snapshot.noticeHeaders, documents.noticeHeaders)
      && jsonEqual(snapshot.noticeLines, documents.noticeLines)
      && jsonEqual(snapshot.outHeaders, documents.outHeaders)
      && jsonEqual(snapshot.outLines, documents.outLines),
  "A43 cleanup document snapshot changed during ownership discovery", { snapshot, documents });
  assert(jsonEqual(snapshot.warehouse, inventory.warehouse)
      && jsonEqual(snapshot.balances, inventory.balances)
      && jsonEqual(snapshot.transactions, inventory.transactions),
  "A43 cleanup inventory snapshot changed during ownership discovery", { snapshot, inventory });
  assert(jsonEqual(snapshot.receivables, receivables)
      && jsonEqual(snapshot.logs, logs)
      && jsonEqual(snapshot.locks, locks)
      && jsonEqual(snapshot.auxiliary, auxiliary),
  "A43 cleanup downstream/log/lock snapshot changed during ownership discovery", { snapshot, receivables, logs, locks, auxiliary });
  const stable = dbJson(`SELECT (${cleanupSnapshotExpression()})::text`);
  assert(jsonEqual(stable, snapshot), "A43 complete semantic snapshot must remain stable before locked cleanup", { snapshot, stable });
  artifacts.cleanupSnapshot = snapshot;
  evidence.snapshots.cleanup = {
    sha256: digest(snapshot),
    counts: {
      ...Object.fromEntries(Object.entries(snapshot).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length])),
      auxiliary: Object.fromEntries(Object.entries(snapshot.auxiliary).map(([key, value]) => [key, value.length]))
    },
    warehouseReferences,
    userReferences
  };
  return snapshot;
}

function lockPredicate(locks) {
  if (locks.length === 0) return "FALSE";
  return locks.map((row) => `(
    row_value.document_type=${sqlLiteral(row.document_type)}
    AND row_value.bill_no=${sqlLiteral(row.bill_no)}
    AND row_value.holder_user_id=${sqlLiteral(row.holder_user_id)}::uuid
    AND row_value.holder_username=${sqlLiteral(row.holder_username)}
  )`).join(" OR ");
}

function directCleanup(snapshot) {
  assert(snapshot && jsonEqual(snapshot, artifacts.cleanupSnapshot), "A43 direct cleanup requires the stable complete semantic snapshot");
  const { order, notice, out, red } = artifacts.documents;
  const expected = {
    locks: snapshot.locks.length,
    logs: snapshot.logs.length,
    outboxEvents: snapshot.auxiliary.outboxEvents.length,
    notificationOutbox: snapshot.auxiliary.notificationOutbox.length,
    receivables: snapshot.receivables.length,
    transactions: snapshot.transactions.length,
    outLines: snapshot.outLines.length,
    redHeaders: 1,
    outHeaders: 1,
    noticeLines: snapshot.noticeLines.length,
    noticeHeaders: snapshot.noticeHeaders.length,
    orderLines: snapshot.orderLines.length,
    orderHeaders: snapshot.orderHeaders.length,
    balances: snapshot.balances.length,
    warehouses: snapshot.warehouse.length,
    sessionScopes: snapshot.identity.sessionScopes.length,
    grants: snapshot.identity.grants.length,
    roles: snapshot.identity.roles.length,
    users: snapshot.identity.users.length
  };
  psql(`
    BEGIN;
    SET LOCAL lock_timeout='10s';
    LOCK TABLE public.sys_user,
               public.sys_user_role,
               public.sys_user_account_set,
               public.sys_session_account_scope,
               public.md_warehouse,
               public.inv_stock_balance,
               public.inv_stock_txn,
               public.sales_order,
               public.sales_order_line,
               public.delivery_notice,
               public.delivery_notice_line,
               public.sales_out,
               public.sales_out_line,
               public.ar_receivable,
               public.ar_receipt,
               public.ar_receipt_allocation,
               public.sales_return_line,
               public.sales_return_finance_allocation,
               public.sys_outbox_event${notificationOutboxSourceSupported ? ",\n               public.sys_notification_outbox" : ""},
               public.sys_operation_log,
               public.doc_edit_lock
      IN SHARE ROW EXCLUSIVE MODE;
    DO $a43_cleanup$
    DECLARE
      actual_snapshot jsonb;
      affected integer;
    BEGIN
      SELECT ${cleanupSnapshotExpression()} INTO actual_snapshot;
      IF actual_snapshot IS DISTINCT FROM ${sqlLiteral(JSON.stringify(snapshot))}::jsonb THEN
        RAISE EXCEPTION 'A43 cleanup refused: complete locked semantic snapshot changed';
      END IF;

      DELETE FROM public.doc_edit_lock row_value WHERE ${lockPredicate(snapshot.locks)};
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected <> ${expected.locks} THEN RAISE EXCEPTION 'A43 cleanup rowcount mismatch: locks'; END IF;

      DELETE FROM public.sys_outbox_event row_value
      WHERE row_value.id = ANY(${uuidArray(snapshot.auxiliary.outboxEvents.map((row) => row.id))})
        AND row_value.aggregate_id = ANY(${uuidArray(runTargetIds())});
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected <> ${expected.outboxEvents} THEN RAISE EXCEPTION 'A43 cleanup rowcount mismatch: outbox events'; END IF;

      ${notificationOutboxSourceSupported ? `DELETE FROM public.sys_notification_outbox row_value
      WHERE row_value.id = ANY(${uuidArray(snapshot.auxiliary.notificationOutbox.map((row) => row.id))})
        AND row_value.source_id = ANY(${uuidArray(runTargetIds())});
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected <> ${expected.notificationOutbox} THEN RAISE EXCEPTION 'A43 cleanup rowcount mismatch: notification outbox'; END IF;` : `IF ${expected.notificationOutbox} <> 0 THEN
        RAISE EXCEPTION 'A43 cleanup rowcount mismatch: unsupported notification outbox must be zero';
      END IF;`}

      DELETE FROM public.sys_operation_log row_value
      WHERE row_value.id = ANY(${uuidArray(artifacts.operationLogIds)})
        AND row_value.operated_by=${sqlLiteral(artifacts.identity.userId)}::uuid
        AND row_value.actor_username=${sqlLiteral(runUsername)};
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected <> ${expected.logs} THEN RAISE EXCEPTION 'A43 cleanup rowcount mismatch: logs'; END IF;

      DELETE FROM public.ar_receivable row_value
      WHERE row_value.id = ANY(${uuidArray(artifacts.receivableIds)})
        AND row_value.source_bill_no = ANY(${textArray([out.billNo, red.billNo])});
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected <> ${expected.receivables} THEN RAISE EXCEPTION 'A43 cleanup rowcount mismatch: receivables'; END IF;

      DELETE FROM public.inv_stock_txn row_value
      WHERE row_value.id = ANY(${uuidArray(artifacts.inventoryTxnIds)})
        AND row_value.warehouse_id=${sqlLiteral(artifacts.warehouse.id)}::uuid;
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected <> ${expected.transactions} THEN RAISE EXCEPTION 'A43 cleanup rowcount mismatch: transactions'; END IF;

      DELETE FROM public.sales_out_line row_value
      WHERE row_value.id = ANY(${uuidArray([...out.lineIds, ...red.lineIds])})
        AND row_value.bill_id = ANY(${uuidArray([out.id, red.id])});
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected <> ${expected.outLines} THEN RAISE EXCEPTION 'A43 cleanup rowcount mismatch: sales-out lines'; END IF;

      DELETE FROM public.sales_out row_value
      WHERE row_value.id=${sqlLiteral(red.id)}::uuid
        AND row_value.bill_no=${sqlLiteral(red.billNo)}
        AND row_value.red_source_bill_id=${sqlLiteral(out.id)}::uuid;
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected <> ${expected.redHeaders} THEN RAISE EXCEPTION 'A43 cleanup rowcount mismatch: red header'; END IF;

      DELETE FROM public.sales_out row_value
      WHERE row_value.id=${sqlLiteral(out.id)}::uuid
        AND row_value.bill_no=${sqlLiteral(out.billNo)};
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected <> ${expected.outHeaders} THEN RAISE EXCEPTION 'A43 cleanup rowcount mismatch: original out header'; END IF;

      DELETE FROM public.delivery_notice_line row_value
      WHERE row_value.id = ANY(${uuidArray(notice.lineIds)})
        AND row_value.bill_id=${sqlLiteral(notice.id)}::uuid;
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected <> ${expected.noticeLines} THEN RAISE EXCEPTION 'A43 cleanup rowcount mismatch: notice lines'; END IF;

      DELETE FROM public.delivery_notice row_value
      WHERE row_value.id=${sqlLiteral(notice.id)}::uuid
        AND row_value.bill_no=${sqlLiteral(notice.billNo)};
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected <> ${expected.noticeHeaders} THEN RAISE EXCEPTION 'A43 cleanup rowcount mismatch: notice header'; END IF;

      DELETE FROM public.sales_order_line row_value
      WHERE row_value.id = ANY(${uuidArray(order.lineIds)})
        AND row_value.order_id=${sqlLiteral(order.id)}::uuid;
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected <> ${expected.orderLines} THEN RAISE EXCEPTION 'A43 cleanup rowcount mismatch: order lines'; END IF;

      DELETE FROM public.sales_order row_value
      WHERE row_value.id=${sqlLiteral(order.id)}::uuid
        AND row_value.bill_no=${sqlLiteral(order.billNo)};
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected <> ${expected.orderHeaders} THEN RAISE EXCEPTION 'A43 cleanup rowcount mismatch: order header'; END IF;

      DELETE FROM public.inv_stock_balance row_value
      WHERE row_value.id = ANY(${uuidArray(artifacts.balanceIds)})
        AND row_value.warehouse_id=${sqlLiteral(artifacts.warehouse.id)}::uuid;
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected <> ${expected.balances} THEN RAISE EXCEPTION 'A43 cleanup rowcount mismatch: balances'; END IF;

      DELETE FROM public.md_warehouse row_value
      WHERE row_value.id=${sqlLiteral(artifacts.warehouse.id)}::uuid
        AND row_value.code=${sqlLiteral(warehouseCode)}
        AND row_value.name=${sqlLiteral(warehouseName)}
        AND row_value.remark=${sqlLiteral(fixtureKey)};
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected <> ${expected.warehouses} THEN RAISE EXCEPTION 'A43 cleanup rowcount mismatch: warehouse'; END IF;

      DELETE FROM public.sys_session_account_scope row_value
      WHERE row_value.user_id=${sqlLiteral(artifacts.identity.userId)}::uuid
        AND row_value.session_token = ANY(${uuidArray(snapshot.identity.sessionScopes.map((row) => row.session_token))});
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected <> ${expected.sessionScopes} THEN RAISE EXCEPTION 'A43 cleanup rowcount mismatch: session scopes'; END IF;

      DELETE FROM public.sys_user_account_set row_value
      WHERE row_value.id = ANY(${uuidArray(snapshot.identity.grants.map((row) => row.id))})
        AND row_value.user_id=${sqlLiteral(artifacts.identity.userId)}::uuid;
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected <> ${expected.grants} THEN RAISE EXCEPTION 'A43 cleanup rowcount mismatch: user grants'; END IF;

      DELETE FROM public.sys_user_role row_value
      WHERE row_value.user_id=${sqlLiteral(artifacts.identity.userId)}::uuid
        AND row_value.role_id=${sqlLiteral(artifacts.adminRole.id)}::uuid;
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected <> ${expected.roles} THEN RAISE EXCEPTION 'A43 cleanup rowcount mismatch: user roles'; END IF;

      DELETE FROM public.sys_user row_value
      WHERE row_value.id=${sqlLiteral(artifacts.identity.userId)}::uuid
        AND row_value.username=${sqlLiteral(runUsername)};
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected <> ${expected.users} THEN RAISE EXCEPTION 'A43 cleanup rowcount mismatch: user'; END IF;
    END;
    $a43_cleanup$;
    COMMIT;
  `);
  evidence.cleanup.deleted = expected;
  return expected;
}

function residueCounts() {
  const { order, notice, out, red } = artifacts.documents;
  const bills = [order.billNo, notice.billNo, out.billNo, red.billNo];
  return dbJson(`
    SELECT jsonb_build_object(
      'users', (SELECT count(*) FROM public.sys_user WHERE id = ANY(${uuidArray([artifacts.identity.userId])}) OR username=${sqlLiteral(runUsername)}),
      'roles', (SELECT count(*) FROM public.sys_user_role WHERE user_id = ANY(${uuidArray([artifacts.identity.userId])})),
      'grants', (SELECT count(*) FROM public.sys_user_account_set WHERE user_id = ANY(${uuidArray([artifacts.identity.userId])})),
      'sessionScopes', (SELECT count(*) FROM public.sys_session_account_scope WHERE user_id = ANY(${uuidArray([artifacts.identity.userId])}) OR session_token = ANY(${uuidArray([artifacts.session.token])})),
      'warehouse', (SELECT count(*) FROM public.md_warehouse WHERE id = ANY(${uuidArray([artifacts.warehouse.id])}) OR code=${sqlLiteral(warehouseCode)}),
      'balances', (SELECT count(*) FROM public.inv_stock_balance WHERE warehouse_id = ANY(${uuidArray([artifacts.warehouse.id])}) OR id = ANY(${uuidArray(artifacts.balanceIds)})),
      'transactions', (SELECT count(*) FROM public.inv_stock_txn WHERE warehouse_id = ANY(${uuidArray([artifacts.warehouse.id])}) OR id = ANY(${uuidArray(artifacts.inventoryTxnIds)})),
      'orderHeaders', (SELECT count(*) FROM public.sales_order WHERE id = ANY(${uuidArray([order.id])}) OR bill_no = ANY(${textArray([order.billNo])})),
      'orderLines', (SELECT count(*) FROM public.sales_order_line WHERE order_id = ANY(${uuidArray([order.id])}) OR id = ANY(${uuidArray(order.lineIds)})),
      'noticeHeaders', (SELECT count(*) FROM public.delivery_notice WHERE id = ANY(${uuidArray([notice.id])}) OR bill_no = ANY(${textArray([notice.billNo])})),
      'noticeLines', (SELECT count(*) FROM public.delivery_notice_line WHERE bill_id = ANY(${uuidArray([notice.id])}) OR id = ANY(${uuidArray(notice.lineIds)})),
      'outHeaders', (SELECT count(*) FROM public.sales_out WHERE id = ANY(${uuidArray([out.id, red.id])}) OR bill_no = ANY(${textArray([out.billNo, red.billNo])})),
      'outLines', (SELECT count(*) FROM public.sales_out_line WHERE bill_id = ANY(${uuidArray([out.id, red.id])}) OR id = ANY(${uuidArray([...out.lineIds, ...red.lineIds])})),
      'receivables', (SELECT count(*) FROM public.ar_receivable WHERE id = ANY(${uuidArray(artifacts.receivableIds)}) OR source_bill_no = ANY(${textArray([out.billNo, red.billNo])})),
      'logs', (SELECT count(*) FROM public.sys_operation_log WHERE id = ANY(${uuidArray(artifacts.operationLogIds)}) OR operated_by = ANY(${uuidArray([artifacts.identity.userId])}) OR actor_username=${sqlLiteral(runUsername)} OR target_id = ANY(${uuidArray(runTargetIds())}) OR target_no = ANY(${textArray(bills)})),
      'outboxEvents', (SELECT count(*) FROM public.sys_outbox_event WHERE aggregate_id = ANY(${uuidArray(runTargetIds())})),
      'notificationOutbox', ${notificationOutboxSourceSupported
        ? `(SELECT count(*) FROM public.sys_notification_outbox WHERE source_id = ANY(${uuidArray(runTargetIds())}))`
        : "0"},
      'locks', (SELECT count(*) FROM public.doc_edit_lock WHERE holder_user_id = ANY(${uuidArray([artifacts.identity.userId])}) OR holder_username=${sqlLiteral(runUsername)} OR bill_no = ANY(${textArray(bills)}))
    )::text
  `);
}

async function cleanup() {
  evidence.cleanup.attempted = true;
  const failures = [];
  const recordFailure = (phase, error) => failures.push({ phase, message: errorText(error), stack: safeStack(error) });

  if (artifacts.browser?.browser) {
    try {
      await artifacts.browser.context?.close().catch(() => {});
      await artifacts.browser.browser.close();
      evidence.cleanup.browserClosed = true;
    } catch (error) {
      recordFailure("browser close", error);
    }
  } else if (!artifacts.browser || evidence.cleanup.browserClosed) {
    evidence.cleanup.browserClosed = true;
  }

  try {
    await closeRunSession();
  } catch (error) {
    recordFailure("session/Redis cleanup", error);
  }

  if (controlledWriteAuthorized && artifacts.warehouse.id && Object.values(artifacts.documents).every((document) => document.id && document.billNo)) {
    try {
      const snapshot = captureCleanupSnapshot();
      directCleanup(snapshot);
    } catch (error) {
      recordFailure("guarded business/identity cleanup", error);
    }
  } else if (identityWriteAttempted) {
    recordFailure("guarded business/identity cleanup", new Error(
      "A43 cleanup refused a partial or response-loss fixture: exact warehouse and four document response UUIDs are required"
    ));
  }

  try {
    evidence.cleanup.residue = residueCounts();
    const nonZero = Object.entries(evidence.cleanup.residue ?? {}).filter(([, value]) => Number(value) !== 0);
    assert(nonZero.length === 0, "A43 DB cleanup must leave zero run-specific residue", evidence.cleanup.residue);
    const redisResidue = redisSessionSnapshot();
    assert(redisResidue.ownedKeys.length === 0 && redisResidue.sharedMembers.length === 0,
      "A43 cleanup must leave zero Redis session residue", redisEvidence(redisResidue));
    evidence.cleanup.redisResidue = redisEvidence(redisResidue);
  } catch (error) {
    recordFailure("zero-residue verification", error);
  }

  if (failures.length > 0) {
    evidence.cleanup.errors = failures;
    throw new Error(`A43 cleanup failed: ${failures.map((failure) => `${failure.phase}: ${failure.message}`).join(" | ")}`);
  }
}

async function main() {
  assert(["", "after-red-audit"].includes(faultPhase),
    `A43_FAULT_PHASE only accepts after-red-audit, got ${JSON.stringify(faultPhase)}`);
  await prepareRoute();
  createRunIdentity();
  await establishRunSession();
  controlledWriteAuthorized = true;
  evidence.checks.seed = await createUniqueWarehouseAndSeed();
  evidence.checks.lifecycle = await createRedReverseChain();
  const documents = validateDocumentSnapshot(documentSnapshot());
  const inventory = validateInventorySnapshot(inventorySnapshot());
  const receivables = validateReceivableSnapshot(receivableSnapshot());
  const logs = validateActorLogs(operationLogSnapshot());
  evidence.snapshots.afterRedAudit = {
    documentsSha256: digest(documents),
    inventorySha256: digest(inventory),
    receivablesSha256: digest(receivables),
    operationLogsSha256: digest(logs),
    redOperationLogDbRowSha256: digest(artifacts.redOperationLogDbRow),
    canonicalExpectedRowSha256: digest(artifacts.expectedOperationLogRow),
    canonicalFieldCount: operationLogFields.length,
    redReverseLogId: artifacts.redReverseLogId
  };

  if (faultPhase === "after-red-audit") {
    evidence.fault.reached = true;
    evidence.fault.injected = true;
    throw new Error(`A43_FAULT_INJECTED_AFTER_RED_AUDIT:${runId}`);
  }

  evidence.checks.api = await apiParityChecks();
  evidence.checks.browser = await browserParityChecks();
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  primaryError = error;
  evidence.failure = { message: errorText(error), stack: safeStack(error) };
} finally {
  try {
    await cleanup();
  } catch (cleanupError) {
    if (!failed) {
      failed = true;
      primaryError = cleanupError;
      evidence.failure = { message: errorText(cleanupError), stack: safeStack(cleanupError) };
    } else {
      evidence.failure.cleanup = errorText(cleanupError);
    }
  }
  if (failed) {
    for (const filePath of artifacts.browser?.screenshots ?? []) {
      try {
        await unlink(filePath);
        evidence.cleanup.removedFailureArtifacts.push(path.relative(rootDir, filePath));
      } catch (error) {
        if (error?.code !== "ENOENT") evidence.cleanup.errors.push({ phase: "failure artifact cleanup", message: errorText(error) });
      }
    }
  }
  evidence.ok = !failed;
  evidence.completedAt = new Date().toISOString();
  await writeFile(resultPath, serializeEvidenceForPersistence(), "utf8");
}

if (failed) throw new Error(errorText(primaryError));

console.log(JSON.stringify({
  ok: true,
  resultPath: path.relative(rootDir, resultPath),
  runId,
  warehouseCode,
  orderNo: artifacts.documents.order.billNo,
  noticeNo: artifacts.documents.notice.billNo,
  salesOutNo: artifacts.documents.out.billNo,
  salesRedReverseBillNo: artifacts.documents.red.billNo,
  redReverseLogId: artifacts.redReverseLogId,
  api: evidence.checks.api,
  browser: evidence.checks.browser,
  cleanup: evidence.cleanup.residue
}, null, 2));
