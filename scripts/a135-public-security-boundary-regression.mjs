import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { open, readFile, mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";

import { chromium } from "playwright";
import { loginApi, logout, postPublicPasswordResetRequest } from "./helpers/regression-auth.mjs";
import {
  registerRegressionProcessTree,
  regressionProcessTreeIsAlive,
  signalRegressionProcessTree
} from "./helpers/regression-process-tree.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const passwordResetIsolationDir = path.join(verificationDir, "a135-password-reset-isolation");
const resultPath = path.join(verificationDir, "a135-public-security-boundary-regression.json");
const apiBase = "http://127.0.0.1:8080";
const frontendUrl = "http://127.0.0.1:5173/";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const viewport = { width: 1366, height: 768 };
const expectedPasswordResetResponse = Object.freeze({
  ok: true,
  message: "已提交找回申请，请联系管理员完成身份核验和密码重置。"
});
const passwordResetProfileGuardMessage = "非 local/test/regression 环境不得放宽密码找回 Redis 门禁";
const passwordResetRedisUnavailableWarning = "密码找回 Redis 限流不可用，本次申请已 fail-closed 且未持久化";
const publicLoginScreenshot = `a135-public-login-${batch}.png`;
const warehouseMenuScreenshot = `a135-warehouse-authorized-account-sets-${batch}.png`;
const forbiddenPublicKeys = new Set([
  "accountingPeriod",
  "attachmentPrefix",
  "businessPeriod",
  "current",
  "databaseName",
  "enabled",
  "environment",
  "id",
  "initialized",
  "period",
  "redisKeyPrefix",
  "schemaName",
  "security",
  "tenant"
]);
const forbiddenPublicValueFragments = ["account-sets/", "jdy_erp", "public", "tenant_"];

await mkdir(screenshotDir, { recursive: true });
await mkdir(passwordResetIsolationDir, { recursive: true });

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  ok: false,
  requests: [],
  anonymous: {},
  authenticated: {},
  management: {},
  passwordReset: {},
  browser: {
    viewport,
    consoleMessages: [],
    failedResponses: [],
    screenshots: [
      `verification/playwright/${publicLoginScreenshot}`,
      `verification/playwright/${warehouseMenuScreenshot}`
    ]
  },
  cleanup: {
    apiSessions: {},
    browserSession: null,
    errors: []
  },
  intentionalSideEffects: {
    loginAuditRetained: true,
    sessionLifecycleUpdatesRetained: true,
    loginAttempts: ["ADMIN API", "WAREHOUSE API", "FINANCE API", "WAREHOUSE browser"],
    note: "The script creates no business fixture. It logs out every session but retains normal successful-login audit rows and login/logout session version updates as required by the A135 contract."
  }
};

const apiCookies = new Map();
let browser = null;
let page = null;
let browserLogoutCompleted = false;
let primaryError = null;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function errorText(error) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function assertExactKeys(value, expectedKeys, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = sorted(Object.keys(value));
  const expected = sorted(expectedKeys);
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} keys should be ${expected.join(",")}, got ${actual.join(",")}`);
}

function assertExactCodes(payload, expectedCodes, label) {
  const codes = sorted((payload?.accountSets ?? []).map((accountSet) => String(accountSet.code ?? "")));
  const expected = sorted(expectedCodes);
  assert(JSON.stringify(codes) === JSON.stringify(expected), `${label} codes should be ${expected.join(",")}, got ${codes.join(",")}`);
  return codes;
}

function publicLeaks(value, location = "$") {
  const leaks = [];
  if (Array.isArray(value)) {
    value.forEach((entry, index) => leaks.push(...publicLeaks(entry, `${location}[${index}]`)));
    return leaks;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenPublicKeys.has(key)) {
        leaks.push(`${location}.${key}`);
      }
      leaks.push(...publicLeaks(child, `${location}.${key}`));
    }
    return leaks;
  }
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    for (const fragment of forbiddenPublicValueFragments) {
      if (normalized.includes(fragment)) {
        leaks.push(`${location} contains ${fragment}`);
      }
    }
  }
  return leaks;
}

function assertPublicSession(payload, label) {
  assertExactKeys(payload, ["authenticated"], label);
  assert(payload.authenticated === false, `${label}.authenticated must be false`);
}

function assertPublicAccountSets(payload, label) {
  assertExactKeys(payload, ["accountSets"], label);
  assert(Array.isArray(payload.accountSets) && payload.accountSets.length > 0, `${label}.accountSets must be a non-empty array`);
  for (const [index, accountSet] of payload.accountSets.entries()) {
    assertExactKeys(accountSet, ["code", "name"], `${label}.accountSets[${index}]`);
    assert(typeof accountSet.code === "string" && accountSet.code.length > 0, `${label}.accountSets[${index}].code must be non-empty`);
    assert(typeof accountSet.name === "string" && accountSet.name.length > 0, `${label}.accountSets[${index}].name must be non-empty`);
  }
  const leaks = publicLeaks(payload);
  assert(leaks.length === 0, `${label} leaked forbidden routing data: ${leaks.join("; ")}`);
  return payload.accountSets.map((accountSet) => accountSet.code);
}

async function request(cookie, pathname, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (cookie) {
    headers.set("Cookie", cookie);
  }
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "GET",
    headers,
    signal: AbortSignal.timeout(5_000)
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
  return { status: response.status, data, text };
}

function expectStatus(label, response, expectedStatus) {
  result.requests.push({ label, expectedStatus, actualStatus: response.status });
  assert(response.status === expectedStatus, `${label} should be ${expectedStatus}, got ${response.status}: ${response.text}`);
}

function accountSetCodes(payload) {
  return sorted((payload?.accountSets ?? []).map((accountSet) => String(accountSet.code ?? "")));
}

function assertAuthenticatedAccountSets(payload, label) {
  assertExactKeys(payload, ["accountSets", "current"], label);
  assert(Array.isArray(payload.accountSets) && payload.accountSets.length > 0, `${label}.accountSets must be non-empty`);
  assert(payload.current?.code === "BLD-TEST", `${label}.current must be BLD-TEST`);
  const bldTest = payload.accountSets.find((accountSet) => accountSet.code === "BLD-TEST");
  assert(bldTest, `${label} must contain BLD-TEST`);
  for (const field of ["databaseName", "schemaName", "attachmentPrefix", "redisKeyPrefix", "environment", "initialized"]) {
    assert(Object.hasOwn(bldTest, field), `${label} authenticated BLD-TEST must retain ${field}`);
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
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
        WHERE row_value.module_code = 'SYSTEM'
          AND row_value.action_code = 'PASSWORD_RESET_REQUEST'
      ),
      'resetOutbox', (
        SELECT md5(COALESCE(string_agg(to_jsonb(row_value)::text, E'\\n' ORDER BY row_value.id::text), ''))
        FROM public.sys_notification_outbox row_value
        WHERE row_value.source_type = 'sys_password_reset_request'
      )
    )::text
  `);
}

function fixtureState(userPrefix) {
  return sqlJson(`
    SELECT jsonb_build_object(
      'users', (
        SELECT count(*) FROM public.sys_user WHERE username LIKE ${sqlLiteral(`${userPrefix}%`)}
      ),
      'roles', (
        SELECT count(*)
        FROM public.sys_user_role user_role
        JOIN public.sys_user app_user ON app_user.id = user_role.user_id
        WHERE app_user.username LIKE ${sqlLiteral(`${userPrefix}%`)}
      ),
      'grants', (
        SELECT count(*)
        FROM public.sys_user_account_set account_grant
        JOIN public.sys_user app_user ON app_user.id = account_grant.user_id
        WHERE app_user.username LIKE ${sqlLiteral(`${userPrefix}%`)}
      ),
      'requests', (
        SELECT count(*) FROM public.sys_password_reset_request WHERE username LIKE ${sqlLiteral(`${userPrefix}%`)}
      ),
      'pending', (
        SELECT count(*) FROM public.sys_password_reset_request
        WHERE username LIKE ${sqlLiteral(`${userPrefix}%`)} AND status = 'PENDING'
      ),
      'done', (
        SELECT count(*) FROM public.sys_password_reset_request
        WHERE username LIKE ${sqlLiteral(`${userPrefix}%`)} AND status = 'DONE'
      ),
      'requestLogs', (
        SELECT count(*)
        FROM public.sys_operation_log operation_log
        WHERE operation_log.module_code = 'SYSTEM'
          AND operation_log.action_code = 'PASSWORD_RESET_REQUEST'
          AND operation_log.target_id IN (
            SELECT id FROM public.sys_user WHERE username LIKE ${sqlLiteral(`${userPrefix}%`)}
          )
      ),
      'outbox', (
        SELECT count(*)
        FROM public.sys_notification_outbox notification
        WHERE notification.source_type = 'sys_password_reset_request'
          AND notification.source_id IN (
            SELECT id FROM public.sys_password_reset_request WHERE username LIKE ${sqlLiteral(`${userPrefix}%`)}
          )
      )
    )::text
  `);
}

function fixtureRequestRow(username) {
  return sqlJson(`
    SELECT to_jsonb(request_row)::text
    FROM public.sys_password_reset_request request_row
    WHERE request_row.username = ${sqlLiteral(username)}
    ORDER BY request_row.requested_at, request_row.id
    LIMIT 1
  `);
}

function createPasswordResetUsers(userPrefix, count) {
  assert(fixtureState(userPrefix).users === 0, `password-reset fixture users already exist for ${userPrefix}`);
  sqlScalar(`
    BEGIN;
    INSERT INTO public.sys_user (username, display_name, password_hash, enabled, default_account_set_id)
    SELECT ${sqlLiteral(userPrefix)} || lpad(series_no::text, 2, '0'),
           'A135 Password Reset ' || lpad(series_no::text, 2, '0'),
           '{noop}A135-reset-only',
           TRUE,
           account_set.id
    FROM generate_series(1, ${count}) series_no
    CROSS JOIN LATERAL (
      SELECT id FROM public.sys_account_set WHERE code = 'BLD-TEST' AND enabled = TRUE LIMIT 1
    ) account_set;

    INSERT INTO public.sys_user_role (user_id, role_id)
    SELECT app_user.id, role_row.id
    FROM public.sys_user app_user
    JOIN public.sys_role role_row ON role_row.code = 'WAREHOUSE' AND role_row.enabled = TRUE
    WHERE app_user.username LIKE ${sqlLiteral(`${userPrefix}%`)};

    INSERT INTO public.sys_user_account_set (user_id, account_set_id, role_code, is_default, enabled)
    SELECT app_user.id, account_set.id, 'WAREHOUSE', TRUE, TRUE
    FROM public.sys_user app_user
    JOIN public.sys_account_set account_set ON account_set.code = 'BLD-TEST' AND account_set.enabled = TRUE
    WHERE app_user.username LIKE ${sqlLiteral(`${userPrefix}%`)};
    COMMIT;
  `);
  const created = fixtureState(userPrefix);
  assert(created.users === count && created.roles === count && created.grants === count, `expected ${count} complete password-reset users, got ${JSON.stringify(created)}`);
  return created;
}

function markFixtureRequestDone(username) {
  const updated = Number(sqlScalar(`
    WITH changed AS (
      UPDATE public.sys_password_reset_request
      SET status = 'DONE',
          handled_at = now(),
          handle_note = 'A135 database cooldown probe',
          version = version + 1
      WHERE username = ${sqlLiteral(username)}
        AND status = 'PENDING'
      RETURNING id
    )
    SELECT count(*) FROM changed
  `));
  assert(updated === 1, `expected one PENDING request for ${username} to become DONE, got ${updated}`);
}

function sqlLikeAny(columnName, prefixes) {
  return `(${prefixes.map((prefix) => `${columnName} LIKE ${sqlLiteral(`${prefix}%`)}`).join(" OR ")})`;
}

function cleanupPasswordResetFixtures(userPrefixes) {
  const userMatch = sqlLikeAny("username", userPrefixes);
  sqlScalar(`
    BEGIN;
    CREATE TEMP TABLE a135_cleanup_users ON COMMIT DROP AS
    SELECT id FROM public.sys_user WHERE ${userMatch};

    CREATE TEMP TABLE a135_cleanup_requests ON COMMIT DROP AS
    SELECT id FROM public.sys_password_reset_request WHERE ${userMatch};

    CREATE TEMP TABLE a135_cleanup_outbox ON COMMIT DROP AS
    SELECT id
    FROM public.sys_notification_outbox
    WHERE source_type = 'sys_password_reset_request'
      AND source_id IN (SELECT id FROM a135_cleanup_requests);

    DELETE FROM public.sys_operation_log
    WHERE (
         module_code = 'SYSTEM'
         AND action_code = 'PASSWORD_RESET_REQUEST'
         AND target_type = 'sys_user'
         AND target_id IN (SELECT id FROM a135_cleanup_users)
       )
       OR (
         module_code = 'SYSTEM'
         AND action_code = 'PASSWORD_RESET_REQUEST'
         AND target_type = 'sys_user'
         AND failure_reason IN (SELECT '申请编号 ' || id::text FROM a135_cleanup_requests)
       )
       OR (
         module_code = 'SYSTEM'
         AND target_type = 'sys_notification_outbox'
         AND action_code IN ('AUTO_RETRY_NOTIFICATION', 'RESEND_NOTIFICATION', 'SYNC_NOTIFICATION_RECEIPT')
         AND target_id IN (SELECT id FROM a135_cleanup_outbox)
       )
       OR (
         module_code = 'SYSTEM'
         AND action_code = 'SEND_PASSWORD_RESET_NOTICE'
         AND target_type = 'sys_notification_outbox'
         AND target_id IS NULL
         AND (${userPrefixes.map((prefix) => `POSITION(${sqlLiteral(prefix)} IN COALESCE(failure_reason, '')) > 0`).join(" OR ")})
       );

    DELETE FROM public.sys_notification_outbox WHERE id IN (SELECT id FROM a135_cleanup_outbox);
    DELETE FROM public.sys_password_reset_request WHERE id IN (SELECT id FROM a135_cleanup_requests);
    DELETE FROM public.sys_user_account_set WHERE user_id IN (SELECT id FROM a135_cleanup_users);
    DELETE FROM public.sys_user_role WHERE user_id IN (SELECT id FROM a135_cleanup_users);
    DELETE FROM public.sys_user WHERE id IN (SELECT id FROM a135_cleanup_users);
    COMMIT;
  `);
}

function redisCommand(...argumentsList) {
  return execFileSync(
    "docker",
    ["exec", "jdy-erp-redis", "redis-cli", "-n", "0", "--raw", ...argumentsList],
    { encoding: "utf8" }
  ).trim();
}

function redisKeys(prefix) {
  const raw = redisCommand("--scan", "--pattern", `${prefix}:*`);
  return raw ? sorted(raw.split(/\r?\n/).filter(Boolean)) : [];
}

function redisSnapshot(prefix) {
  const keys = redisKeys(prefix);
  return {
    keys,
    values: Object.fromEntries(keys.map((key) => [key, Number(redisCommand("GET", key))])),
    ttlMs: Object.fromEntries(keys.map((key) => [key, Number(redisCommand("PTTL", key))]))
  };
}

function clearRedisPrefix(prefix) {
  const keys = redisKeys(prefix);
  for (let index = 0; index < keys.length; index += 100) {
    redisCommand("DEL", ...keys.slice(index, index + 100));
  }
  assert(redisKeys(prefix).length === 0, `Redis prefix ${prefix} was not fully cleared`);
  return keys.length;
}

function sha256(value) {
  return createHash("sha256").update(String(value).trim()).digest("hex");
}

function redisRateKeys(prefix, source, username) {
  return {
    global: `${prefix}:global`,
    source: `${prefix}:source:${sha256(source)}`,
    account: `${prefix}:account:${sha256(username)}`
  };
}

function assertTtl(ttlMs, maximumMs, label) {
  assert(Number.isInteger(ttlMs) && ttlMs > 0 && ttlMs <= maximumMs, `${label} TTL must be within 1..${maximumMs}, got ${ttlMs}`);
}

function assertRedisKeysContainNoPlaintext(keys, plaintextValues, label) {
  for (const key of keys) {
    const normalizedKey = key.toLowerCase();
    for (const plaintext of plaintextValues) {
      const normalizedPlaintext = String(plaintext).trim().toLowerCase();
      if (normalizedPlaintext) {
        assert(!normalizedKey.includes(normalizedPlaintext), `${label} Redis key leaked plaintext ${plaintext}: ${key}`);
      }
    }
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${sorted(Object.keys(value)).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function postPasswordReset(baseUrl, username, contactNote, forwardedFor = "") {
  let response;
  try {
    response = await postPublicPasswordResetRequest(baseUrl, {
      username,
      contactNote,
      forwardedFor
    });
  } catch (error) {
    const reason = error instanceof Error && error.cause instanceof Error
      ? `${error.name}: ${error.message}; cause=${error.cause.name}: ${error.cause.message}`
      : error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new Error(`password-reset transport failed for isolated origin ${baseUrl}: ${reason}`, { cause: error });
  }
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { text };
  }
  return {
    status: response.status,
    data,
    text,
    retryAfter: response.headers.get("retry-after")
  };
}

async function postAlreadyRateLimitedPasswordReset(baseUrl, username, contactNote, label) {
  try {
    return await postPasswordReset(baseUrl, username, contactNote);
  } catch (firstError) {
    // The caller establishes the global limiter at its hard cap before this
    // request. It is therefore a no-write rejection whether the first socket
    // reset happened before or after the server observed it; one fresh
    // connection is safe and distinguishes an idle pooled-connection reset
    // from a limiter contract failure without retrying accepted submissions.
    try {
      return await postPasswordReset(baseUrl, username, contactNote);
    } catch (retryError) {
      throw new AggregateError([firstError, retryError], `${label} transport failed before and after the safe capped-request retry`);
    }
  }
}

function assertUniformPasswordResetResponse(response, label) {
  assert(response.status === 200, `${label} should return HTTP 200, got ${response.status}: ${response.text}`);
  assert(response.retryAfter == null, `${label} must not return Retry-After`);
  assertExactKeys(response.data, ["message", "ok"], `${label} body`);
  assert(
    canonicalJson(response.data) === canonicalJson(expectedPasswordResetResponse),
    `${label} body must exactly match the fixed public response: ${JSON.stringify(response.data)}`
  );
  for (const forbiddenKey of ["accepted", "matched", "retryAfter"]) {
    assert(!Object.hasOwn(response.data, forbiddenKey), `${label} must not expose ${forbiddenKey}`);
  }
}

async function reserveHttpPort() {
  const server = http.createServer((_request, response) => response.end());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  assert(port > 0, "failed to reserve an HTTP port");
  return port;
}

async function tailFile(filePath, maximumLength = 8000) {
  try {
    const content = await readFile(filePath, "utf8");
    return content.slice(-maximumLength);
  } catch {
    return "";
  }
}

async function waitForBackend(processInfo) {
  for (let attempt = 1; attempt <= 180; attempt += 1) {
    if (processInfo.spawnError) {
      throw processInfo.spawnError;
    }
    if (processInfo.child.exitCode != null) {
      throw new Error(`${processInfo.name} exited before health check:\n${await tailFile(processInfo.logPath)}`);
    }
    try {
      const response = await fetch(`${processInfo.baseUrl}/api/system/health`, {
        signal: AbortSignal.timeout(1_000)
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Backend compilation and startup are still in progress.
    }
    await sleep(500);
  }
  throw new Error(`${processInfo.name} did not become healthy:\n${await tailFile(processInfo.logPath)}`);
}

async function spawnIsolatedBackend({
  name,
  profile = "",
  redisPrefix,
  globalMax,
  sourceMax,
  accountMax = 1,
  maxPending = 50,
  passwordResetRedisPort = 6379,
  useDefaultLimits = false,
  processRegistry
}) {
  assert(Array.isArray(processRegistry), `${name} requires a detached-process registry`);
  const port = await reserveHttpPort();
  const logPath = path.join(passwordResetIsolationDir, `${name}-${batch}.log`);
  const logFile = await open(logPath, "w");
  const env = {
    ...process.env,
    JAVA_HOME: process.env.JAVA_HOME || "/opt/homebrew/opt/openjdk@21",
    JDY_SERVER_PORT: String(port),
    JDY_DB_URL: "jdbc:postgresql://127.0.0.1:5432/jdy_erp",
    JDY_DB_USERNAME: "jdy",
    JDY_DB_PASSWORD: "jdy_dev",
    JDY_REDIS_HOST: "127.0.0.1",
    JDY_REDIS_PORT: "6379"
  };
  for (const environmentName of Object.keys(env)) {
    if (environmentName.startsWith("JDY_PASSWORD_RESET_")) {
      delete env[environmentName];
    }
  }
  Object.assign(env, {
    JDY_PASSWORD_RESET_REDIS_KEY_PREFIX: redisPrefix,
    JDY_PASSWORD_RESET_REDIS_CONNECT_TIMEOUT: "200ms",
    JDY_PASSWORD_RESET_REDIS_READ_TIMEOUT: "200ms",
    JDY_PASSWORD_RESET_CLEANUP_FIXED_DELAY_MS: "3600000",
    JDY_PASSWORD_RESET_CLEANUP_INITIAL_DELAY_MS: "3600000"
  });
  if (!useDefaultLimits) {
    assert(Number.isInteger(globalMax) && globalMax > 0, `${name} requires an explicit positive globalMax`);
    assert(Number.isInteger(sourceMax) && sourceMax > 0, `${name} requires an explicit positive sourceMax`);
    Object.assign(env, {
      // The global-boundary probe deliberately performs 101 isolated HTTP
      // requests.  Keep its test bucket alive for the full probe so it tests
      // the configured count boundary rather than incidental wall-clock
      // expiry; production defaults remain unchanged.
      JDY_PASSWORD_RESET_GLOBAL_WINDOW: "10m",
      JDY_PASSWORD_RESET_GLOBAL_MAX_ATTEMPTS: String(globalMax),
      JDY_PASSWORD_RESET_SOURCE_WINDOW: "10m",
      JDY_PASSWORD_RESET_SOURCE_MAX_ATTEMPTS: String(sourceMax),
      JDY_PASSWORD_RESET_ACCOUNT_COOLDOWN: "15m",
      JDY_PASSWORD_RESET_ACCOUNT_MAX_ATTEMPTS: String(accountMax),
      JDY_PASSWORD_RESET_MAX_PENDING: String(maxPending),
      JDY_PASSWORD_RESET_PENDING_EXPIRY: "72h",
      JDY_PASSWORD_RESET_HISTORY_RETENTION: "90d",
      JDY_PASSWORD_RESET_CLEANUP_BATCH_SIZE: "500"
    });
  }
  if (profile) {
    env.SPRING_PROFILES_ACTIVE = profile;
  } else {
    delete env.SPRING_PROFILES_ACTIVE;
  }
  delete env.SPRING_PROFILES_DEFAULT;
  delete env.SPRING_PROFILES_INCLUDE;
  delete env.SPRING_APPLICATION_JSON;
  if (passwordResetRedisPort !== 6379) {
    env.SPRING_APPLICATION_JSON = JSON.stringify({
      jdy: {
        security: {
          "password-reset": {
            "redis-host": "127.0.0.1",
            "redis-port": passwordResetRedisPort
          }
        }
      }
    });
  }

  const child = spawn("./mvnw", ["spring-boot:run"], {
    cwd: path.join(rootDir, "backend"),
    env,
    detached: false,
    stdio: ["ignore", logFile.fd, logFile.fd]
  });
  const processInfo = {
    name,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    logPath,
    child,
    spawnError: null,
    stopped: false,
    forcedKill: false
  };
  processRegistry.push(processInfo);
  child.once("error", (error) => {
    processInfo.spawnError = error;
  });
  try {
    registerRegressionProcessTree(processInfo);
  } finally {
    await logFile.close();
  }
  return processInfo;
}

async function startIsolatedBackend(options) {
  const processInfo = await spawnIsolatedBackend(options);
  try {
    await waitForBackend(processInfo);
  } catch (error) {
    await stopIsolatedBackend(processInfo);
    throw error;
  }
  return processInfo;
}

async function waitForProfileGuardFailure(processInfo) {
  for (let attempt = 1; attempt <= 180; attempt += 1) {
    if (processInfo.spawnError) {
      throw processInfo.spawnError;
    }
    if (processInfo.child.exitCode != null) {
      const log = await readFile(processInfo.logPath, "utf8");
      assert(processInfo.child.exitCode !== 0, `${processInfo.name} profile-guard probe exited successfully instead of failing`);
      assert(log.includes(passwordResetProfileGuardMessage), `${processInfo.name} log does not contain the profile-guard rejection`);
      return {
        exitCode: processInfo.child.exitCode,
        healthReached: false,
        guardMessageFound: true
      };
    }
    if (processInfo.child.signalCode != null) {
      throw new Error(`${processInfo.name} profile-guard probe was terminated by ${processInfo.child.signalCode}`);
    }
    let healthResponse = null;
    try {
      healthResponse = await fetch(`${processInfo.baseUrl}/api/system/health`, {
        signal: AbortSignal.timeout(1_000)
      });
    } catch {
      // A profile-guard rejection must exit before the health endpoint is reachable.
    }
    assert(!healthResponse?.ok, `${processInfo.name} became healthy before the profile guard rejected startup`);
    await sleep(500);
  }
  throw new Error(`${processInfo.name} did not fail its profile guard in time:\n${await tailFile(processInfo.logPath)}`);
}

async function expectProfileGuardStartupFailure(options) {
  const processInfo = await spawnIsolatedBackend(options);
  try {
    const outcome = await waitForProfileGuardFailure(processInfo);
    return { processInfo, outcome };
  } catch (error) {
    await stopIsolatedBackend(processInfo);
    throw error;
  }
}

function processGroupIsAlive(processInfo) {
  return regressionProcessTreeIsAlive(processInfo);
}

async function waitForProcessGroupExit(processInfo, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupIsAlive(processInfo) && Date.now() < deadline) {
    await sleep(100);
  }
  return !processGroupIsAlive(processInfo);
}

async function stopIsolatedBackend(processInfo) {
  if (!processInfo || processInfo.stopped) {
    return;
  }
  if (processInfo.stopPromise) {
    return processInfo.stopPromise;
  }
  processInfo.stopPromise = (async () => {
    if (!Number.isInteger(processInfo.child.pid)) {
      processInfo.stopped = true;
      return;
    }
    if (!processGroupIsAlive(processInfo)) {
      processInfo.stopped = true;
      return;
    }
    try {
      signalRegressionProcessTree(processInfo, "SIGTERM");
    } catch (error) {
      if (error?.code === "ESRCH") {
        processInfo.stopped = true;
        return;
      }
      throw error;
    }
    if (!await waitForProcessGroupExit(processInfo, 8000)) {
      processInfo.forcedKill = true;
      try {
        signalRegressionProcessTree(processInfo, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") {
          throw error;
        }
      }
      await waitForProcessGroupExit(processInfo, 3000);
    }
    assert(!processGroupIsAlive(processInfo), `${processInfo.name} process group did not terminate`);
    processInfo.stopped = true;
  })();
  return processInfo.stopPromise;
}

async function startDisconnectingTcpServer() {
  const sockets = new Set();
  let connectionCount = 0;
  const server = net.createServer((socket) => {
    connectionCount += 1;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.destroy();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  assert(port > 0, "failed to start the disconnecting TCP server");
  let closePromise = null;
  return {
    port,
    get connectionCount() {
      return connectionCount;
    },
    close: async () => {
      if (!closePromise) {
        closePromise = (async () => {
          for (const socket of sockets) {
            socket.destroy();
          }
          if (server.listening) {
            await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
          }
        })();
      }
      return closePromise;
    }
  };
}

async function waitForLogLines(logPath, message) {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const log = await tailFile(logPath, 100_000);
    const lines = log.split(/\r?\n/).filter((line) => line.includes(message));
    if (lines.length > 0) {
      return lines;
    }
    await sleep(100);
  }
  return [];
}

async function runPasswordResetIsolation() {
  const token = randomBytes(6).toString("hex");
  const userPrefix = `a135pr${token}`;
  const sourceUsernamePrefix = `a135src${token}`;
  const globalUsernamePrefix = `a135global${token}`;
  const cleanupUsernamePrefixes = [userPrefix, sourceUsernamePrefix, globalUsernamePrefix];
  const fixtureUsers = Array.from({ length: 52 }, (_value, index) => `${userPrefix}${String(index + 1).padStart(2, "0")}`);
  const sourcePrefix = `jdy:a135:{${token}-source}`;
  const mainPrefix = `jdy:a135:{${token}-main}`;
  const badRedisPrefix = `jdy:a135:{${token}-bad}`;
  const profileGuardScenarios = [
    { label: "default", profile: "", redisPrefix: `jdy:a135:{${token}-guard-default}` },
    { label: "production", profile: "production", redisPrefix: `jdy:a135:{${token}-guard-production}` },
    { label: "local-production", profile: "local,production", redisPrefix: `jdy:a135:{${token}-guard-local-production}` }
  ];
  const prefixes = [sourcePrefix, mainPrefix, badRedisPrefix, ...profileGuardScenarios.map((scenario) => scenario.redisPrefix)];
  const processes = [];
  let dummyServer = null;
  let failure = null;
  let responseCount = 0;
  let cleanupPromise = null;
  let signalBeingHandled = null;
  const isolation = {
    token,
    ok: false,
    source: {},
    global: {},
    badRedis: {},
    profileGuard: {
      expectedMessage: passwordResetProfileGuardMessage,
      probes: []
    },
    knownAccounts: {},
    responseContract: {},
    processes: [],
    cleanup: {
      redisKeysDeleted: {},
      errors: [],
      signalHandling: {
        graceful: ["SIGHUP", "SIGINT", "SIGTERM"],
        uncatchable: { SIGKILL: "cleanup cannot run; unique database and Redis prefixes remain discoverable for manual residue removal" }
      },
      exitLastResortKills: []
    }
  };
  result.passwordReset = isolation;
  const baselineFingerprint = passwordResetFingerprint();
  isolation.baselineFingerprint = baselineFingerprint;
  const baselinePendingCount = Number(sqlScalar("SELECT count(*) FROM public.sys_password_reset_request WHERE status = 'PENDING'"));
  assert(baselinePendingCount === 0, `password-reset isolation requires zero pre-existing PENDING rows, got ${baselinePendingCount}`);
  isolation.baselinePendingCount = baselinePendingCount;

  const verifyResponse = (response, label) => {
    assertUniformPasswordResetResponse(response, label);
    responseCount += 1;
  };

  const exitLastResort = () => {
    for (const processInfo of [...processes].reverse()) {
      if (!processGroupIsAlive(processInfo)) {
        continue;
      }
      try {
        signalRegressionProcessTree(processInfo, "SIGKILL");
        processInfo.forcedKill = true;
        isolation.cleanup.exitLastResortKills.push(processInfo.name);
      } catch (error) {
        if (error?.code !== "ESRCH") {
          isolation.cleanup.errors.push(`exit kill ${processInfo.name}: ${errorText(error)}`);
        }
      }
    }
  };

  const signalExitCodes = new Map([
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143]
  ]);
  const signalHandlers = new Map();
  const removeSignalHandlers = () => {
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
  };
  const removeLifecycleHandlers = () => {
    removeSignalHandlers();
    process.removeListener("exit", exitLastResort);
  };

  const cleanupIsolation = () => {
    if (cleanupPromise) {
      return cleanupPromise;
    }
    cleanupPromise = (async () => {
      for (const processInfo of [...processes].reverse()) {
        try {
          await stopIsolatedBackend(processInfo);
        } catch (error) {
          isolation.cleanup.errors.push(`stop ${processInfo.name}: ${errorText(error)}`);
        }
      }
      exitLastResort();
      if (dummyServer) {
        try {
          await dummyServer.close();
        } catch (error) {
          isolation.cleanup.errors.push(`close dummy Redis: ${errorText(error)}`);
        }
        dummyServer = null;
      }
      try {
        cleanupPasswordResetFixtures(cleanupUsernamePrefixes);
      } catch (error) {
        isolation.cleanup.errors.push(`database cleanup: ${errorText(error)}`);
      }
      for (const prefix of prefixes) {
        try {
          isolation.cleanup.redisKeysDeleted[prefix] = clearRedisPrefix(prefix);
        } catch (error) {
          isolation.cleanup.errors.push(`Redis cleanup ${prefix}: ${errorText(error)}`);
        }
      }
      try {
        const finalFixtureState = fixtureState(userPrefix);
        isolation.cleanup.fixtureResidue = finalFixtureState;
        assert(Object.values(finalFixtureState).every((value) => value === 0), `password-reset fixture residue remains: ${JSON.stringify(finalFixtureState)}`);
        const fixtureRequestResidue = Number(sqlScalar(`SELECT count(*) FROM public.sys_password_reset_request WHERE ${sqlLikeAny("username", cleanupUsernamePrefixes)}`));
        isolation.cleanup.fixtureRequestResidue = fixtureRequestResidue;
        assert(fixtureRequestResidue === 0, `password-reset unknown fixture requests remain: ${fixtureRequestResidue}`);
        const restoredFingerprint = passwordResetFingerprint();
        isolation.cleanup.restoredFingerprint = restoredFingerprint;
        assert(canonicalJson(restoredFingerprint) === canonicalJson(baselineFingerprint), `password-reset request/log/outbox fingerprint was not restored: before=${JSON.stringify(baselineFingerprint)} after=${JSON.stringify(restoredFingerprint)}`);
        isolation.cleanup.fingerprintRestored = true;
      } catch (error) {
        isolation.cleanup.errors.push(`restore verification: ${errorText(error)}`);
      }
      isolation.cleanup.forcedProcessKills = processes.filter((processInfo) => processInfo.forcedKill).map((processInfo) => processInfo.name);
    })();
    return cleanupPromise;
  };

  for (const [signal, exitCode] of signalExitCodes) {
    const handler = () => {
      if (signalBeingHandled) {
        return;
      }
      signalBeingHandled = signal;
      isolation.cleanup.receivedSignal = signal;
      process.exitCode = exitCode;
      void cleanupIsolation().finally(() => {
        removeSignalHandlers();
        process.exitCode = exitCode;
      });
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  process.on("exit", exitLastResort);

  try {
    for (const prefix of prefixes) {
      clearRedisPrefix(prefix);
    }
    assert(fixtureState(userPrefix).users === 0, `fixture prefix ${userPrefix} is not clean`);

    for (const scenario of profileGuardScenarios) {
      const { processInfo, outcome } = await expectProfileGuardStartupFailure({
        name: `profile-guard-${scenario.label}-${token}`,
        profile: scenario.profile,
        redisPrefix: scenario.redisPrefix,
        globalMax: 100,
        sourceMax: 1000,
        accountMax: 1,
        maxPending: 50,
        processRegistry: processes
      });
      const processResult = { name: processInfo.name, port: processInfo.port, log: path.relative(rootDir, processInfo.logPath) };
      isolation.processes.push(processResult);
      isolation.profileGuard.probes.push({
        label: scenario.label,
        profiles: scenario.profile || "<default>",
        sourceMaxAttempts: 1000,
        exitCode: outcome.exitCode,
        healthReached: outcome.healthReached,
        guardMessageFound: outcome.guardMessageFound,
        port: processInfo.port,
        log: processResult.log
      });
      await stopIsolatedBackend(processInfo);
    }
    assert(isolation.profileGuard.probes.length === 3, `expected three profile-guard startup failures, got ${isolation.profileGuard.probes.length}`);

    const sourceBackend = await startIsolatedBackend({
      name: `source-${token}`,
      redisPrefix: sourcePrefix,
      useDefaultLimits: true,
      processRegistry: processes
    });
    isolation.processes.push({ name: sourceBackend.name, port: sourceBackend.port, log: path.relative(rootDir, sourceBackend.logPath) });
    const sourceUnknowns = Array.from({ length: 11 }, (_value, index) => `${sourceUsernamePrefix}${String(index + 1).padStart(3, "0")}`);
    for (let index = 0; index < 10; index += 1) {
      const response = await postPasswordReset(
        sourceBackend.baseUrl,
        sourceUnknowns[index],
        `A135 source probe ${token} ${index + 1}`,
        `198.51.100.${index + 1}`
      );
      verifyResponse(response, `source request ${index + 1}`);
    }
    const sourceBeforeLimit = redisSnapshot(sourcePrefix);
    const sourceLimitResponse = await postPasswordReset(
      sourceBackend.baseUrl,
      sourceUnknowns[10],
      `A135 source probe ${token} 11`,
      "203.0.113.11"
    );
    verifyResponse(sourceLimitResponse, "source request 11");
    const sourceAfterLimit = redisSnapshot(sourcePrefix);
    const sourceKeys = redisRateKeys(sourcePrefix, "127.0.0.1", sourceUnknowns[0]);
    const sourceEleventhKeys = redisRateKeys(sourcePrefix, "127.0.0.1", sourceUnknowns[10]);
    assert(sourceBeforeLimit.values[sourceKeys.global] === 10 && sourceBeforeLimit.values[sourceKeys.source] === 10, `source counters should be 10 before rejection: ${JSON.stringify(sourceBeforeLimit.values)}`);
    assert(canonicalJson(sourceAfterLimit.values) === canonicalJson(sourceBeforeLimit.values), "the 11th source request must not increment any Redis counter");
    assert(!sourceAfterLimit.keys.includes(sourceEleventhKeys.account), "the 11th source request must not create its account key");
    const expectedSourceKeys = sorted([
      sourceKeys.global,
      sourceKeys.source,
      ...sourceUnknowns.slice(0, 10).map((username) => redisRateKeys(sourcePrefix, "127.0.0.1", username).account)
    ]);
    assert(canonicalJson(sourceAfterLimit.keys) === canonicalJson(expectedSourceKeys), `source Redis keys do not match the SHA-256 contract: ${JSON.stringify(sourceAfterLimit.keys)}`);
    assertTtl(sourceAfterLimit.ttlMs[sourceKeys.global], 60_000, "source global");
    assertTtl(sourceAfterLimit.ttlMs[sourceKeys.source], 600_000, "source address");
    for (const username of sourceUnknowns.slice(0, 10)) {
      assertTtl(sourceAfterLimit.ttlMs[redisRateKeys(sourcePrefix, "127.0.0.1", username).account], 900_000, `source account ${username}`);
    }
    assertRedisKeysContainNoPlaintext(
      sourceAfterLimit.keys,
      ["127.0.0.1", ...sourceUnknowns, ...sourceUnknowns.map((_username, index) => `198.51.100.${index + 1}`), "203.0.113.11", `A135 source probe ${token}`],
      "source limiter"
    );
    assert(canonicalJson(passwordResetFingerprint()) === canonicalJson(baselineFingerprint), "source limiting must not change password-reset request/log/outbox data");
    isolation.source = {
      requests: 11,
      applicationDefaultLimitsUsed: true,
      forwardedForVaried: true,
      globalCount: sourceAfterLimit.values[sourceKeys.global],
      sourceCount: sourceAfterLimit.values[sourceKeys.source],
      accountKeyCount: sourceAfterLimit.keys.filter((key) => key.includes(":account:")).length,
      rejectedAccountKeyCreated: sourceAfterLimit.keys.includes(sourceEleventhKeys.account),
      redisKeyCount: sourceAfterLimit.keys.length,
      ttlMs: sourceAfterLimit.ttlMs,
      databaseUnchanged: true
    };
    await stopIsolatedBackend(sourceBackend);
    isolation.cleanup.redisKeysDeleted.source = clearRedisPrefix(sourcePrefix);

    const mainBackend = await startIsolatedBackend({
      name: `main-${token}`,
      profile: "local",
      redisPrefix: mainPrefix,
      globalMax: 100,
      sourceMax: 1000,
      accountMax: 1,
      maxPending: 50,
      processRegistry: processes
    });
    isolation.processes.push({ name: mainBackend.name, port: mainBackend.port, log: path.relative(rootDir, mainBackend.logPath) });
    const globalUnknowns = Array.from({ length: 101 }, (_value, index) => `${globalUsernamePrefix}${String(index + 1).padStart(3, "0")}`);
    for (let index = 0; index < 100; index += 1) {
      const response = await postPasswordReset(mainBackend.baseUrl, globalUnknowns[index], `A135 global probe ${token} ${index + 1}`);
      verifyResponse(response, `global request ${index + 1}`);
    }
    const globalBeforeLimit = redisSnapshot(mainPrefix);
    const globalLimitResponse = await postAlreadyRateLimitedPasswordReset(
      mainBackend.baseUrl,
      globalUnknowns[100],
      `A135 global probe ${token} 101`,
      "global request 101"
    );
    verifyResponse(globalLimitResponse, "global request 101");
    const globalAfterLimit = redisSnapshot(mainPrefix);
    const globalKeys = redisRateKeys(mainPrefix, "127.0.0.1", globalUnknowns[0]);
    const globalRejectedAccountKey = redisRateKeys(mainPrefix, "127.0.0.1", globalUnknowns[100]).account;
    assert(globalBeforeLimit.values[globalKeys.global] === 100 && globalBeforeLimit.values[globalKeys.source] === 100, `global counters should be 100 before rejection: ${JSON.stringify(globalBeforeLimit.values)}`);
    assert(canonicalJson(globalAfterLimit.values) === canonicalJson(globalBeforeLimit.values), "the 101st global request must not increment any Redis counter");
    assert(!globalAfterLimit.keys.includes(globalRejectedAccountKey), "the 101st global request must not create its account key");
    assert(globalAfterLimit.keys.length === 102, `global limiter should contain global + source + 100 account keys, got ${globalAfterLimit.keys.length}`);
    assertRedisKeysContainNoPlaintext(globalAfterLimit.keys, ["127.0.0.1", ...globalUnknowns, `A135 global probe ${token}`], "global limiter");
    assert(canonicalJson(passwordResetFingerprint()) === canonicalJson(baselineFingerprint), "global limiting must not change password-reset request/log/outbox data");
    isolation.global = {
      requests: 101,
      globalCount: globalAfterLimit.values[globalKeys.global],
      sourceCount: globalAfterLimit.values[globalKeys.source],
      accountKeyCount: globalAfterLimit.keys.filter((key) => key.includes(":account:")).length,
      rejectedAccountKeyCreated: globalAfterLimit.keys.includes(globalRejectedAccountKey),
      databaseUnchanged: true
    };
    isolation.cleanup.redisKeysDeleted.mainUnknown = clearRedisPrefix(mainPrefix);

    isolation.fixtureUsers = createPasswordResetUsers(userPrefix, fixtureUsers.length);
    dummyServer = await startDisconnectingTcpServer();
    let badRedisBackend = null;
    try {
      badRedisBackend = await startIsolatedBackend({
        name: `bad-redis-${token}`,
        profile: "local",
        redisPrefix: badRedisPrefix,
        globalMax: 100,
        sourceMax: 1000,
        accountMax: 1,
        maxPending: 50,
        passwordResetRedisPort: dummyServer.port,
        processRegistry: processes
      });
      isolation.processes.push({ name: badRedisBackend.name, port: badRedisBackend.port, log: path.relative(rootDir, badRedisBackend.logPath) });
      const beforeBadRedis = passwordResetFingerprint();
      const badRedisContact = `A135 bad Redis ${token}`;
      const badRedisResponse = await postPasswordReset(badRedisBackend.baseUrl, fixtureUsers[51], badRedisContact);
      verifyResponse(badRedisResponse, "bad Redis request");
      const afterBadRedis = passwordResetFingerprint();
      assert(canonicalJson(afterBadRedis) === canonicalJson(beforeBadRedis), "bad Redis must fail closed without request/log/outbox writes");
      assert(dummyServer.connectionCount >= 1, "bad Redis probe must reach the disconnecting TCP server");
      const warningLines = await waitForLogLines(badRedisBackend.logPath, passwordResetRedisUnavailableWarning);
      assert(warningLines.length >= 1, "bad Redis probe must emit the exact fail-closed health warning");
      for (const warningLine of warningLines) {
        assert(warningLine.includes(" WARN "), `bad Redis health warning must be logged at WARN: ${warningLine}`);
        for (const sensitiveValue of [fixtureUsers[51], badRedisContact, "127.0.0.1"]) {
          assert(!warningLine.includes(sensitiveValue), `bad Redis health warning leaked ${sensitiveValue}: ${warningLine}`);
        }
      }
      isolation.badRedis = {
        status: badRedisResponse.status,
        dummyPort: dummyServer.port,
        disconnectingServerConnections: dummyServer.connectionCount,
        databaseUnchanged: true,
        warning: {
          exactMessage: passwordResetRedisUnavailableWarning,
          count: warningLines.length,
          severity: "WARN",
          sensitiveValuesAbsent: true
        }
      };
    } finally {
      const activeDummyServer = dummyServer;
      await stopIsolatedBackend(badRedisBackend);
      await activeDummyServer?.close();
      if (dummyServer === activeDummyServer) {
        dummyServer = null;
      }
    }

    const user1 = fixtureUsers[0];
    const firstContact = `A135 first contact ${token}`;
    const changedContact = `A135 changed contact ${token}`;
    const firstKnownResponse = await postPasswordReset(mainBackend.baseUrl, user1, firstContact);
    verifyResponse(firstKnownResponse, "known user first request");
    const firstKnownState = fixtureState(userPrefix);
    const firstKnownRow = fixtureRequestRow(user1);
    assert(firstKnownState.requests === 1 && firstKnownState.pending === 1 && firstKnownState.requestLogs === 1 && firstKnownState.outbox === 0, `known first request should create one PENDING and one log: ${JSON.stringify(firstKnownState)}`);
    assert(firstKnownRow?.contact_note === firstContact, `known first request must preserve contact note ${firstContact}`);

    const repeatedKnownResponse = await postPasswordReset(mainBackend.baseUrl, user1, changedContact);
    verifyResponse(repeatedKnownResponse, "known user repeated request");
    const repeatedKnownState = fixtureState(userPrefix);
    const repeatedKnownRow = fixtureRequestRow(user1);
    assert(canonicalJson(repeatedKnownState) === canonicalJson(firstKnownState), "repeated known request must not create request/log/outbox rows");
    assert(canonicalJson(repeatedKnownRow) === canonicalJson(firstKnownRow), "repeated known request must not modify the first request row");

    markFixtureRequestDone(user1);
    isolation.cleanup.redisKeysDeleted.beforeCooldown = clearRedisPrefix(mainPrefix);
    const beforeDatabaseCooldown = fixtureState(userPrefix);
    const beforeDatabaseCooldownRow = fixtureRequestRow(user1);
    const databaseCooldownResponse = await postPasswordReset(mainBackend.baseUrl, user1, `A135 database cooldown changed ${token}`);
    verifyResponse(databaseCooldownResponse, "known user database cooldown request");
    const afterDatabaseCooldown = fixtureState(userPrefix);
    const afterDatabaseCooldownRow = fixtureRequestRow(user1);
    assert(canonicalJson(afterDatabaseCooldown) === canonicalJson(beforeDatabaseCooldown), "database 15-minute cooldown must not create request/log/outbox rows");
    assert(canonicalJson(afterDatabaseCooldownRow) === canonicalJson(beforeDatabaseCooldownRow), "database 15-minute cooldown must not modify the DONE request");

    isolation.cleanup.redisKeysDeleted.beforePendingCap = clearRedisPrefix(mainPrefix);
    for (let index = 1; index <= 50; index += 1) {
      const response = await postPasswordReset(mainBackend.baseUrl, fixtureUsers[index], `A135 pending ${token} ${index + 1}`);
      verifyResponse(response, `pending request ${index + 1}`);
    }
    const pendingCapResponse = await postPasswordReset(mainBackend.baseUrl, fixtureUsers[51], `A135 pending cap ${token}`);
    verifyResponse(pendingCapResponse, "pending cap request 52");
    const finalFixtureState = fixtureState(userPrefix);
    assert(finalFixtureState.requests === 51, `fixture should contain user1 DONE + 50 PENDING rows, got ${JSON.stringify(finalFixtureState)}`);
    assert(finalFixtureState.done === 1 && finalFixtureState.pending === 50, `fixture statuses should be DONE=1/PENDING=50, got ${JSON.stringify(finalFixtureState)}`);
    assert(finalFixtureState.requestLogs === 51 && finalFixtureState.outbox === 0, `fixture should contain 51 request logs and zero outbox rows, got ${JSON.stringify(finalFixtureState)}`);
    assert(fixtureRequestRow(fixtureUsers[51]) == null, "user52 must have zero password-reset request rows at the pending cap");
    const finalMainRedis = redisSnapshot(mainPrefix);
    const finalMainKeys = redisRateKeys(mainPrefix, "127.0.0.1", fixtureUsers[51]);
    assert(finalMainRedis.values[finalMainKeys.global] === 51 && finalMainRedis.values[finalMainKeys.source] === 51, `final limiter counters should be 51 after 50 accepted + one cap-rejected request: ${JSON.stringify(finalMainRedis.values)}`);
    assert(finalMainRedis.values[finalMainKeys.account] === 1, "the pending-cap request must consume one account-rate key without writing the database");
    assert(finalMainRedis.keys.length === 53, `final limiter should contain global + source + 51 account keys, got ${finalMainRedis.keys.length}`);
    assertRedisKeysContainNoPlaintext(
      finalMainRedis.keys,
      ["127.0.0.1", ...fixtureUsers, firstContact, changedContact, `A135 database cooldown changed ${token}`, `A135 pending ${token}`, `A135 pending cap ${token}`],
      "known-account limiter"
    );
    assert(responseCount === 167, `password-reset isolation should compare 167 uniform responses, got ${responseCount}`);
    isolation.knownAccounts = {
      firstRequest: { contactNote: firstKnownRow.contact_note, state: firstKnownState },
      repeatPreservedFirstRow: true,
      databaseCooldownRejected: true,
      pendingCapRejectedUser: fixtureUsers[51],
      finalState: finalFixtureState,
      finalRedisKeyCount: finalMainRedis.keys.length,
      finalRedisGlobalCount: finalMainRedis.values[finalMainKeys.global],
      finalRedisSourceCount: finalMainRedis.values[finalMainKeys.source]
    };
    isolation.responseContract = {
      responsesCompared: responseCount,
      status: 200,
      body: expectedPasswordResetResponse,
      exactKeys: sorted(Object.keys(expectedPasswordResetResponse)),
      retryAfterAbsent: true,
      forbiddenExistenceKeysAbsent: true
    };
  } catch (error) {
    failure = error;
    isolation.error = errorText(error);
  } finally {
    try {
      await cleanupIsolation();
    } finally {
      removeLifecycleHandlers();
    }
  }

  isolation.ok = failure == null && isolation.cleanup.errors.length === 0;
  result.intentionalSideEffects.passwordResetFixturesRestored = isolation.cleanup.fingerprintRestored === true;
  result.intentionalSideEffects.passwordResetIsolationLogsRetained = isolation.processes.map((processInfo) => processInfo.log);
  if (!isolation.ok) {
    const messages = [failure ? errorText(failure) : "", ...isolation.cleanup.errors].filter(Boolean);
    throw new Error(messages.join("\n"));
  }
  return isolation;
}

try {
  result.passwordReset = await runPasswordResetIsolation();

  const anonymousSession = await request("", "/api/system/session");
  expectStatus("anonymous session", anonymousSession, 200);
  assertPublicSession(anonymousSession.data, "anonymous session");
  result.anonymous.session = anonymousSession.data;

  const anonymousAccountSets = await request("", "/api/system/account-sets");
  expectStatus("anonymous account sets", anonymousAccountSets, 200);
  const publicCodes = assertPublicAccountSets(anonymousAccountSets.data, "anonymous account sets");
  result.anonymous.accountSetCodes = sorted(publicCodes);

  const anonymousManage = await request("", "/api/system/account-sets/manage");
  expectStatus("anonymous account-set management", anonymousManage, 401);
  result.management.anonymousStatus = anonymousManage.status;

  for (const [role, username, password] of [
    ["ADMIN", "", ""],
    ["WAREHOUSE", "warehouse", "warehouse123"],
    ["FINANCE", "finance", "finance123"]
  ]) {
    const cookie = role === "ADMIN"
      ? await loginApi(apiBase)
      : await loginApi(apiBase, username, password, "BLD-TEST");
    apiCookies.set(role, cookie);
    const accountSetsResponse = await request(cookie, "/api/system/account-sets");
    expectStatus(`${role} account sets`, accountSetsResponse, 200);
    assertAuthenticatedAccountSets(accountSetsResponse.data, `${role} account sets`);
    result.authenticated[role] = {
      current: accountSetsResponse.data.current.code,
      accountSetCodes: accountSetCodes(accountSetsResponse.data)
    };
  }

  assert(result.anonymous.accountSetCodes.every((code) => result.authenticated.ADMIN.accountSetCodes.includes(code)), "ADMIN must retain every enabled public account-set choice");
  assertExactCodes({ accountSets: result.authenticated.WAREHOUSE.accountSetCodes.map((code) => ({ code })) }, ["BLD-TEST"], "WAREHOUSE authorized account sets");
  assertExactCodes({ accountSets: result.authenticated.FINANCE.accountSetCodes.map((code) => ({ code })) }, ["BLD-TEST"], "FINANCE authorized account sets");

  const adminManage = await request(apiCookies.get("ADMIN"), "/api/system/account-sets/manage");
  const warehouseManage = await request(apiCookies.get("WAREHOUSE"), "/api/system/account-sets/manage");
  expectStatus("ADMIN account-set management", adminManage, 200);
  expectStatus("WAREHOUSE account-set management", warehouseManage, 403);
  const managedBldTest = adminManage.data?.accountSets?.find((accountSet) => accountSet.code === "BLD-TEST");
  assert(managedBldTest?.schemaName === "public", "ADMIN management response must retain BLD-TEST schemaName=public");
  assert(Object.hasOwn(managedBldTest, "attachmentPrefix") && Object.hasOwn(managedBldTest, "redisKeyPrefix"), "ADMIN management response must retain attachment and Redis prefixes");
  result.management.adminStatus = adminManage.status;
  result.management.warehouseStatus = warehouseManage.status;
  result.management.adminAccountSetCodes = accountSetCodes(adminManage.data);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport });
  page = await context.newPage();
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) {
      result.browser.consoleMessages.push({
        type: message.type(),
        text: message.text(),
        location: message.location()
      });
    }
  });
  page.on("pageerror", (error) => {
    result.browser.consoleMessages.push({ type: "pageerror", text: error.message });
  });
  page.on("response", (response) => {
    if (!response.ok()) {
      result.browser.failedResponses.push({
        method: response.request().method(),
        resourceType: response.request().resourceType(),
        status: response.status(),
        url: response.url()
      });
    }
  });

  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await page.getByTestId("login-page").waitFor({ state: "visible" });
  await page.getByTestId("login-account-set").locator('option[value="BLD-TEST"]').waitFor({ state: "attached" });
  const loginOptions = await page.getByTestId("login-account-set").locator("option").evaluateAll((options) => options.map((option) => ({
    value: option.value,
    text: option.textContent?.trim() ?? ""
  })));
  assert(loginOptions.some((option) => option.value === "BLD-TEST"), "public login page must offer BLD-TEST");
  result.browser.publicLoginOptions = loginOptions;
  await page.screenshot({ path: path.join(screenshotDir, publicLoginScreenshot) });

  await page.getByTestId("login-username").fill("warehouse");
  await page.getByTestId("login-account-set").selectOption("BLD-TEST");
  await page.getByTestId("login-password").fill("warehouse123");
  const authorizedAccountSetsResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/system/account-sets" && response.request().method() === "GET";
  });
  await page.getByTestId("login-submit").click();
  const authorizedAccountSetsResponse = await authorizedAccountSetsResponsePromise;
  const authorizedAccountSetsPayload = await authorizedAccountSetsResponse.json();
  assertExactCodes(authorizedAccountSetsPayload, ["BLD-TEST"], "WAREHOUSE browser authorized account sets");
  await page.getByTestId("session-user-role").filter({ hasText: "仓库员" }).waitFor({ state: "visible" });

  await page.locator("details.tenant-switcher > summary").click();
  await page.getByTestId("tenant-switch-list").waitFor({ state: "visible" });
  const warehouseMenuRows = await page.getByTestId("tenant-switch-list").locator('button[data-testid^="tenant-switch-"]').evaluateAll((rows) => rows.map((row) => ({
    testId: row.getAttribute("data-testid") ?? "",
    text: row.textContent?.replace(/\s+/g, " ").trim() ?? ""
  })));
  assert(warehouseMenuRows.length === 1, `WAREHOUSE tenant menu should contain one row, got ${warehouseMenuRows.length}`);
  assert(warehouseMenuRows[0].testId === "tenant-switch-BLD-TEST", `WAREHOUSE tenant menu should contain only BLD-TEST, got ${warehouseMenuRows[0].testId}`);
  assert(!warehouseMenuRows.some((row) => row.testId.includes("A119") || row.text.includes("A119")), "WAREHOUSE tenant menu must not expose A119 account sets");
  result.browser.authorizedApiAccountSetCodes = accountSetCodes(authorizedAccountSetsPayload);
  result.browser.warehouseMenuRows = warehouseMenuRows;
  await page.screenshot({ path: path.join(screenshotDir, warehouseMenuScreenshot) });

  const postLogoutPublicResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/system/account-sets" && response.request().method() === "GET";
  });
  await logout(page);
  browserLogoutCompleted = true;
  const postLogoutPublicPayload = await (await postLogoutPublicResponsePromise).json();
  result.browser.postLogoutPublicAccountSetCodes = sorted(assertPublicAccountSets(postLogoutPublicPayload, "post-logout public account sets"));
  await page.waitForTimeout(100);

  assert(result.browser.consoleMessages.length === 0, `browser console should have no error/warning, got ${JSON.stringify(result.browser.consoleMessages)}`);
  assert(result.browser.failedResponses.length === 0, `browser should have no failed response, got ${JSON.stringify(result.browser.failedResponses)}`);
} catch (error) {
  primaryError = error;
  result.error = errorText(error);
} finally {
  for (const [role, cookie] of apiCookies.entries()) {
    try {
      const response = await request(cookie, "/api/system/logout", { method: "POST" });
      result.cleanup.apiSessions[role] = response.status;
      if (response.status !== 200) {
        result.cleanup.errors.push(`${role} API logout returned ${response.status}`);
      }
    } catch (error) {
      result.cleanup.errors.push(`${role} API logout failed: ${errorText(error)}`);
    }
  }
  if (page && !browserLogoutCompleted) {
    try {
      const status = await page.evaluate(async () => (
        await fetch("/api/system/logout", {
          method: "POST",
          signal: AbortSignal.timeout(5_000)
        })
      ).status);
      result.cleanup.browserSession = status;
      if (status !== 200) {
        result.cleanup.errors.push(`browser logout returned ${status}`);
      }
    } catch (error) {
      result.cleanup.errors.push(`browser logout failed: ${errorText(error)}`);
    }
  } else if (page) {
    result.cleanup.browserSession = 200;
  }
  if (browser) {
    await browser.close();
  }

  result.ok = primaryError == null && result.cleanup.errors.length === 0;
  if (!result.ok && !result.error) {
    result.error = result.cleanup.errors.join("; ");
  }
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}

if (primaryError) {
  throw primaryError;
}
if (result.cleanup.errors.length > 0) {
  throw new Error(result.cleanup.errors.join("; "));
}
