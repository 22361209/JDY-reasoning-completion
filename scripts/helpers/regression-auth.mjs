import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  lstatSync,
  closeSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync
} from "node:fs";
import path from "node:path";
import { encodeRegressionSecretFrame } from "./regression-secret-channel.mjs";
import {
  regressionRedisDeleteOwnedPrimaryLua,
  regressionRedisValueDigestLua
} from "./regression-redis-lua.mjs";
import {
  appendRegressionFixturePrepared,
  appendRegressionFixtureState,
  openRegressionFixtureLedgerWriter,
  readRegressionFixtureLedger
} from "./regression-fixture-ledger.mjs";

const nativeFetch = globalThis.fetch.bind(globalThis);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mainApiBase = "http://127.0.0.1:8080";
const mainFrontendBase = "http://127.0.0.1:5173";
const regressionRequestFencePath = "/api/system/regression-request-fence";
const redisUsernameAttribute = "sessionAttr:jdy.username";
const runtimeCredentialFileEnvironment = "JDY_REGRESSION_ADMIN_CREDENTIAL_FILE";
const runtimeCredentialIdentityEnvironment = "JDY_REGRESSION_ADMIN_CREDENTIAL_IDENTITY";
const runtimeRunIdEnvironment = "JDY_REGRESSION_RUN_ID";
const runtimeSecretReportFdEnvironment = "JDY_REGRESSION_SECRET_REPORT_FD";
const isolatedBackendOnlyEnvironment = "JDY_REGRESSION_ISOLATED_BACKEND_ONLY";
const fixtureOwnershipVersion = "JDY_REGRESSION_FIXTURE_V1";
const fixtureTombstonePasswordHash = `{noop}${fixtureOwnershipVersion}_DISABLED`;
const redisInvariantCaptureRaceCode = "REGRESSION_REDIS_INVARIANT_CAPTURE_RACE";
let cachedRuntimeCredentials;
let cachedRuntimeFixtureLedgerWriter = null;
const isolatedBackendOnly = (() => {
  const value = String(process.env[isolatedBackendOnlyEnvironment] ?? "");
  delete process.env[isolatedBackendOnlyEnvironment];
  if (!value) return false;
  if (value !== "1") throw new Error("isolated regression backend marker is invalid");
  return true;
})();
const runtimeSecretReportFd = (() => {
  const raw = String(process.env[runtimeSecretReportFdEnvironment] ?? "");
  delete process.env[runtimeSecretReportFdEnvironment];
  if (!raw) return -1;
  if (raw !== "3") throw new Error("regression secret report descriptor is invalid");
  return 3;
})();
const standardRoleCodes = new Map([
  ["系统管理员", "ADMIN"],
  ["仓库员", "WAREHOUSE"],
  ["财务员", "FINANCE"]
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sortedUnique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function reportSensitiveValue(value) {
  if (runtimeSecretReportFd < 0) return;
  const frame = encodeRegressionSecretFrame(value);
  if (!frame) return;
  try {
    writeSync(runtimeSecretReportFd, frame);
  } catch {
    throw new Error("regression secret report channel is unavailable");
  }
}

function reportSensitiveCookie(cookie) {
  const parsed = parseSessionCookie(cookie);
  reportSensitiveValue(cookie);
  reportSensitiveValue(parsed.value);
  for (const candidate of decodedCookieCandidates(parsed.value)) reportSensitiveValue(candidate);
}

function assertPrivateRegularFile(filePath, label) {
  let metadata;
  try {
    metadata = lstatSync(filePath);
  } catch {
    throw new Error(`${label} is unavailable`);
  }
  if (!metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || (metadata.mode & 0o077) !== 0) {
    throw new Error(`${label} must be a private regular file`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`${label} has an unexpected owner`);
  }
  return metadata;
}

function parseRuntimeCredentialIdentity(raw) {
  const match = /^(\d+):(\d+)$/.exec(String(raw || ""));
  if (!match) throw new Error("regression run-scoped ADMIN credential inode identity is invalid");
  return { device: match[1], inode: match[2] };
}

function wipeRuntimeCredentialFileDescriptor(descriptor) {
  try {
    ftruncateSync(descriptor, 0);
    fsyncSync(descriptor);
  } catch {
    throw new Error("regression run-scoped ADMIN credential inode could not be erased");
  }
}

function unlinkOpenedRuntimeCredential(credentialPath, metadata) {
  let current;
  try {
    current = lstatSync(credentialPath);
  } catch {
    throw new Error("regression run-scoped ADMIN credential path changed before consumption");
  }
  if (!current.isFile()
    || current.isSymbolicLink()
    || current.dev !== metadata.dev
    || current.ino !== metadata.ino) {
    throw new Error("regression run-scoped ADMIN credential path changed before consumption");
  }
  try {
    unlinkSync(credentialPath);
  } catch {
    throw new Error("regression run-scoped ADMIN credential file could not be consumed atomically");
  }
}

function consumeRuntimeCredentialFile(credentialPath, expectedIdentity) {
  let descriptor = -1;
  try {
    descriptor = openSync(
      credentialPath,
      fsConstants.O_RDWR | fsConstants.O_NOFOLLOW
    );
    const before = fstatSync(descriptor);
    if (!before.isFile()
      || before.isSymbolicLink()
      || (before.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && before.uid !== process.getuid())) {
      throw new Error("regression run-scoped ADMIN credential file must be a private regular file");
    }
    if (String(before.dev) !== expectedIdentity.device || String(before.ino) !== expectedIdentity.inode) {
      throw new Error("regression run-scoped ADMIN credential inode identity changed");
    }
    if (before.nlink !== 1) {
      wipeRuntimeCredentialFileDescriptor(descriptor);
      unlinkOpenedRuntimeCredential(credentialPath, before);
      throw new Error("regression run-scoped ADMIN credential inode acquired an external hardlink");
    }
    unlinkOpenedRuntimeCredential(credentialPath, before);
    const after = fstatSync(descriptor);
    if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 0) {
      wipeRuntimeCredentialFileDescriptor(descriptor);
      throw new Error("regression run-scoped ADMIN credential inode remained externally linked");
    }
    return readFileSync(descriptor, "utf8");
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new Error("regression run-scoped ADMIN credential file must not be a symlink");
    }
    throw error;
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
  }
}

async function reportPlaywrightSessionCookies(page) {
  const cookies = await page.context().cookies();
  for (const cookie of cookies) {
    if (cookie.name === "SESSION" && cookie.value) reportSensitiveCookie(`SESSION=${cookie.value}`);
  }
}

function canonicalOrigin(value, label, { allowPath = false } = {}) {
  let parsed;
  try {
    parsed = new URL(String(value ?? ""));
  } catch {
    throw new Error(`${label} must be one canonical local HTTP URL`);
  }
  if (parsed.protocol !== "http:"
    || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash) {
    throw new Error(`${label} must be one credential-free canonical local HTTP URL`);
  }
  if (!allowPath && !["", "/"].includes(parsed.pathname)) {
    throw new Error(`${label} must not contain a path`);
  }
  return parsed.origin;
}

function readRuntimeCredentials() {
  if (cachedRuntimeCredentials !== undefined) return cachedRuntimeCredentials;
  const runId = String(process.env[runtimeRunIdEnvironment] ?? "");
  const credentialPath = String(process.env[runtimeCredentialFileEnvironment] ?? "");
  const credentialIdentity = String(process.env[runtimeCredentialIdentityEnvironment] ?? "");
  if (!runId && !credentialPath && !credentialIdentity) {
    cachedRuntimeCredentials = null;
    return cachedRuntimeCredentials;
  }
  if (!runId || !credentialPath || !credentialIdentity) {
    throw new Error("regression run-scoped ADMIN metadata is incomplete");
  }
  const rawCredential = consumeRuntimeCredentialFile(
    credentialPath,
    parseRuntimeCredentialIdentity(credentialIdentity)
  );
  let parsed;
  try {
    parsed = JSON.parse(rawCredential);
  } catch {
    throw new Error("regression run-scoped ADMIN credential file is invalid");
  }
  delete process.env[runtimeCredentialFileEnvironment];
  delete process.env[runtimeCredentialIdentityEnvironment];
  delete process.env[runtimeRunIdEnvironment];
  const username = String(parsed?.username ?? "");
  const password = String(parsed?.password ?? "");
  const userId = String(parsed?.userId ?? "");
  const fixtureLedgerReference = parsed?.fixtureLedgerReference;
  const fixtureLedgerSigningPrivateKey = String(parsed?.fixtureLedgerSigningPrivateKey ?? "");
  const requestFenceControlToken = String(parsed?.requestFenceControlToken ?? "");
  const credentialKeys = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? Object.keys(parsed).sort().join(",")
    : "";
  if (parsed?.runId !== runId
    || credentialKeys !== "apiBase,fixtureLedgerReference,fixtureLedgerSigningPrivateKey,frontendBase,password,requestFenceControlToken,runId,userId,username"
    || !/^r_full_[0-9a-f]{12,48}$/.test(username)
    || !uuidPattern.test(userId)
    || password.length < 20
    || parsed?.apiBase !== mainApiBase
    || parsed?.frontendBase !== mainFrontendBase
    || !fixtureLedgerReference
    || fixtureLedgerReference.runId !== runId
    || !/^(?:parent|\d{3})\.fixtures\.jsonl$/.test(String(fixtureLedgerReference.file || ""))
    || fixtureLedgerSigningPrivateKey.length < 40
    || !/^[0-9a-f]{32}$/.test(requestFenceControlToken)) {
    throw new Error("regression run-scoped ADMIN credential ownership metadata does not match this run");
  }
  const fixtureLedgerSecretDir = path.dirname(credentialPath);
  cachedRuntimeFixtureLedgerWriter = openRegressionFixtureLedgerWriter({
    secretDir: fixtureLedgerSecretDir,
    reference: fixtureLedgerReference,
    signingPrivateKey: fixtureLedgerSigningPrivateKey
  });
  readRegressionFixtureLedger({
    secretDir: fixtureLedgerSecretDir,
    reference: fixtureLedgerReference,
    requireSealed: false
  });
  cachedRuntimeCredentials = Object.freeze({
    username,
    password,
    userId,
    runId,
    requestFenceControlToken
  });
  return cachedRuntimeCredentials;
}

// ESM imports are evaluated before any script body. Consume and remove the
// capability path now so browsers, Maven, and other descendants cannot inherit it.
readRuntimeCredentials();

export function regressionAdminCredentials() {
  const runtime = readRuntimeCredentials();
  return runtime
    ? { username: runtime.username, password: runtime.password }
    : { username: "admin", password: "admin123" };
}

export function regressionAdminIdentity() {
  const runtime = readRuntimeCredentials();
  return runtime
    ? { username: runtime.username, userId: runtime.userId, mode: "run-scoped" }
    : { username: "admin", userId: "", mode: "standalone-default" };
}

export async function manageRegressionRequestFence(
  targetApiBase,
  identity,
  action,
  explicitControlCapability = ""
) {
  const origin = canonicalOrigin(targetApiBase, "regression request fence API");
  assert(origin === mainApiBase, "regression request fence refuses a non-main API origin");
  const username = String(identity?.username ?? "");
  const userId = String(identity?.userId ?? "");
  const generation = Number(identity?.generation);
  assert(/^r_[a-z0-9_]{1,58}_[0-9a-f]{12,32}$/.test(username),
    "regression request fence requires an owned fixture username");
  assert(uuidPattern.test(userId), "regression request fence requires an owned fixture user id");
  assert(Number.isSafeInteger(generation) && generation >= 0,
    "regression request fence requires an owned fixture generation");
  assert(["OPEN", "CLOSE_AND_DRAIN"].includes(action), "regression request fence action is invalid");
  const controlCapability = String(
    explicitControlCapability || readRuntimeCredentials()?.requestFenceControlToken || ""
  );
  assert(/^[0-9a-f]{32}$/.test(controlCapability),
    "regression request fence control capability is unavailable");
  // Both operations are idempotent for one fixture generation: OPEN returns the
  // existing open entry, while CLOSE_AND_DRAIN continues draining the same one.
  // A locally reset TCP connection can therefore be retried once without ever
  // broadening ownership or masking an HTTP authorization/state failure.
  let response;
  let unavailableError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      response = await nativeFetch(`${origin}${regressionRequestFencePath}`, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          "X-JDY-Regression-Fence-Capability": controlCapability
        },
        body: JSON.stringify({ action, userId, username, generation }),
        signal: AbortSignal.timeout(action === "CLOSE_AND_DRAIN" ? 35_000 : 10_000)
      });
      unavailableError = null;
      break;
    } catch (error) {
      unavailableError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (unavailableError || !response) {
    throw new Error(`regression request fence ${action} is unavailable after 2 attempts: ${unavailableError instanceof Error ? unavailableError.message : String(unavailableError)}`);
  }
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`regression request fence ${action} returned invalid JSON`);
  }
  if (!response.ok) {
    // The control endpoint never echoes the capability. Preserve its bounded
    // public reason so preflight failures distinguish owner-schema, ownership,
    // and authorization defects without leaking the run-scoped token.
    const reason = String(body?.message || body?.error || "").replace(/[^\p{L}\p{N}\s:_.-]/gu, " ").trim().slice(0, 240);
    throw new Error(`regression request fence ${action} failed with status ${response.status}${reason ? `: ${reason}` : ""}`);
  }
  const expectedState = action === "OPEN" ? "OPEN" : "CLOSED";
  if (body?.state !== expectedState || Number(body?.activeCount) !== 0) {
    throw new Error(`regression request fence ${action} returned an incomplete drain state`);
  }
  return { state: body.state, activeCount: Number(body.activeCount) };
}

export async function fillRegressionAdminPassword(locator) {
  assert(locator && typeof locator.fill === "function",
    "regression ADMIN password target must provide a Playwright-compatible fill operation");
  await locator.fill(regressionAdminCredentials().password);
}

function effectiveLoginCredentials(targetKind, target, username, password) {
  const runtime = readRuntimeCredentials();
  const normalizedUsername = String(username ?? "").trim();
  const isSharedAdmin = normalizedUsername.toLowerCase() === "admin";
  if (!runtime || (!isSharedAdmin && normalizedUsername !== runtime.username)) return { username, password };
  const expectedOrigin = targetKind === "frontend" ? mainFrontendBase : mainApiBase;
  const actualOrigin = canonicalOrigin(target, `regression ${targetKind} login target`, {
    allowPath: targetKind === "frontend"
  });
  if (actualOrigin !== expectedOrigin) {
    throw new Error(`regression ${targetKind} login refuses a non-main origin while suite credentials are active`);
  }
  return {
    username: runtime.username,
    password: isSharedAdmin && password === "admin123" ? runtime.password : password
  };
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlTextArray(values) {
  return `ARRAY[${values.map(sqlLiteral).join(",")}]::text[]`;
}

function sqlIdentifier(value) {
  const identifier = String(value ?? "");
  assert(/^[a-z][a-z0-9_]{0,62}$/.test(identifier), "isolated regression route contains an unsafe tenant schema");
  return `"${identifier}"`;
}

function runPsql(sql, label) {
  const postgresUser = process.env.JDY_POSTGRES_USER || process.env.JDY_DATABASE_USER || "jdy";
  const postgresDatabase = process.env.JDY_POSTGRES_DATABASE || "jdy_erp";
  try {
    return execFileSync(
      "docker",
      [
        "exec", process.env.JDY_POSTGRES_CONTAINER || "jdy-erp-postgres",
        "psql", "-X", "-v", "ON_ERROR_STOP=1", "-qAt", "-U", postgresUser, "-d", postgresDatabase,
        "-c", sql
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    ).trim();
  } catch {
    throw new Error(`${label} failed`);
  }
}

function dbJson(sql, label) {
  const raw = runPsql(sql, label);
  if (!raw || raw === "null") return null;
  try {
    return JSON.parse(raw.split(/\r?\n/).at(-1));
  } catch {
    throw new Error(`${label} returned invalid metadata`);
  }
}

function dbNumber(sql, label) {
  const raw = runPsql(sql, label);
  const value = Number(raw.split(/\r?\n/).at(-1) || "0");
  if (!Number.isFinite(value)) throw new Error(`${label} returned invalid metadata`);
  return value;
}

const mainRegressionRedisContainer = "jdy-erp-redis";
const mainRegressionRedisDatabase = 0;

export function resolveRegressionRedisTarget(environment = process.env) {
  assert(environment && typeof environment === "object" && !Array.isArray(environment),
    "regression Redis environment is invalid");
  const container = String(environment.JDY_REDIS_CONTAINER || mainRegressionRedisContainer);
  const databaseText = String(environment.JDY_REDIS_DB || "0");
  assert(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container),
    "regression Redis container selector is invalid");
  assert(/^(?:0|[1-9][0-9]{0,3})$/.test(databaseText),
    "regression Redis database selector is invalid");
  return { container, database: Number(databaseText) };
}

export function assertMainRegressionRedisTarget(environment = process.env) {
  const target = resolveRegressionRedisTarget(environment);
  assert(target.container === mainRegressionRedisContainer
    && target.database === mainRegressionRedisDatabase,
  `full regression Redis target must be ${mainRegressionRedisContainer} DB ${mainRegressionRedisDatabase}`);
  return target;
}

function redisCommand(...args) {
  const target = resolveRegressionRedisTarget();
  try {
    return execFileSync(
      "docker",
      [
        "exec", target.container,
        "redis-cli", "-n", String(target.database), "--raw", ...args
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    ).trim();
  } catch {
    const command = /^[A-Z]+$/i.test(String(args[0] ?? "")) ? String(args[0]).toUpperCase() : "UNKNOWN";
    throw new Error(`regression Redis command failed: ${command}`);
  }
}

function redisCommandBuffer(...args) {
  const target = resolveRegressionRedisTarget();
  try {
    const output = execFileSync(
      "docker",
      [
        "exec", target.container,
        "redis-cli", "-n", String(target.database), "--raw", ...args
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let end = output.length;
    if (end > 0 && output[end - 1] === 0x0a) end -= 1;
    if (end > 0 && output[end - 1] === 0x0d) end -= 1;
    return output.subarray(0, end);
  } catch {
    const command = /^[A-Z]+$/i.test(String(args[0] ?? "")) ? String(args[0]).toUpperCase() : "UNKNOWN";
    throw new Error(`regression Redis command failed: ${command}`);
  }
}

function redisScan(pattern) {
  const raw = redisCommand("--scan", "--pattern", pattern);
  return raw ? sortedUnique(raw.split(/\r?\n/).filter(Boolean)) : [];
}

function parseSessionCookie(cookieHeader) {
  const match = /^(SESSION)=([^;]+)$/.exec(String(cookieHeader ?? ""));
  if (!match) throw new Error("regression login must return the Redis-backed SESSION cookie");
  return { name: match[1], value: match[2] };
}

function decodedCookieCandidates(value) {
  const inputs = [String(value ?? "")];
  try {
    inputs.push(decodeURIComponent(value));
  } catch {
    // The raw value remains authoritative when percent-decoding is invalid.
  }
  const candidates = [...inputs];
  for (const input of inputs) {
    for (const encoding of ["base64", "base64url"]) {
      try {
        const decoded = Buffer.from(input, encoding).toString("utf8");
        if (/^[0-9a-f-]{32,36}$/i.test(decoded)) candidates.push(decoded);
      } catch {
        // Some SESSION serializers use an opaque, non-base64 cookie value.
      }
    }
  }
  return sortedUnique(candidates);
}

function serializedUsernameCandidates(username) {
  const raw = Buffer.from(username, "utf8");
  assert(raw.length < 65_536, "regression Redis username is too long");
  return [
    raw,
    Buffer.from(JSON.stringify(username), "utf8"),
    Buffer.concat([Buffer.from([0xac, 0xed, 0x00, 0x05, 0x74, raw.length >> 8, raw.length & 0xff]), raw])
  ];
}

function redisHashBelongsToUsername(key, username) {
  const actual = redisCommandBuffer("HGET", key, redisUsernameAttribute);
  return serializedUsernameCandidates(username).some((candidate) => actual.equals(candidate));
}

export function deleteProvenRedisPrimary(key, username) {
  const ownerDigests = serializedUsernameCandidates(username)
    .map((candidate) => createHash("sha1").update(candidate).digest("hex"));
  const result = Number(redisCommand(
    "EVAL",
    regressionRedisDeleteOwnedPrimaryLua,
    "1",
    key,
    ...ownerDigests
  ));
  assert(result >= 0, "regression Redis primary session ownership changed before atomic deletion");
  return result;
}

function synchronousPause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function redisPrimarySessionKeys() {
  return redisScan("*:sessions:*").flatMap((key) => {
    const match = /^(.*:sessions:)([^:]+)$/.exec(key);
    if (!match || redisCommand("TYPE", key) !== "hash") return [];
    return [{ key, prefix: match[1], sessionId: match[2], namespace: match[1].slice(0, -"sessions:".length) }];
  });
}

function redisValueDigest(key) {
  const digest = redisCommand("EVAL", regressionRedisValueDigestLua, "1", key);
  if (!/^[0-9a-f]{40}$/.test(digest)) {
    throw Object.assign(
      new Error("regression shared user Redis value disappeared during invariant capture"),
      { code: redisInvariantCaptureRaceCode }
    );
  }
  return sha256(digest);
}

function redisExpirationMembers(primaryHashes) {
  const members = [];
  const sessionsByNamespace = new Map();
  for (const row of primaryHashes) {
    const sessionIds = sessionsByNamespace.get(row.namespace) || [];
    sessionIds.push(row.sessionId);
    sessionsByNamespace.set(row.namespace, sessionIds);
  }
  for (const [namespace, sessionIds] of sessionsByNamespace) {
    for (const key of redisScan(`${namespace}expirations:*`)) {
    for (const member of redisCommand("SMEMBERS", key).split(/\r?\n/).filter(Boolean)) {
      if (sessionIds.some((sessionId) => member.includes(sessionId))) members.push({ key, member });
    }
    }
  }
  return members.sort((left, right) => `${left.key}:${left.member}`.localeCompare(`${right.key}:${right.member}`));
}

function redisOwnedByUsername(username) {
  const primaryHashes = redisPrimarySessionKeys().filter(({ key }) => redisHashBelongsToUsername(key, username));
  const keys = new Set();
  for (const { key, prefix, sessionId } of primaryHashes) {
    keys.add(key);
    const expiresKey = `${prefix}expires:${sessionId}`;
    if (redisCommand("EXISTS", expiresKey) === "1") keys.add(expiresKey);
  }
  return {
    primaryHashes,
    keys: [...keys].sort(),
    members: redisExpirationMembers(primaryHashes)
  };
}

export function captureRedisSessionForCookie(cookieHeader, expectedUsername) {
  const cookie = parseSessionCookie(cookieHeader);
  const candidates = decodedCookieCandidates(cookie.value);
  const matches = [];
  for (const { key, prefix, sessionId, namespace } of redisPrimarySessionKeys()) {
    if (!candidates.includes(sessionId)) continue;
    if (!redisHashBelongsToUsername(key, expectedUsername)) continue;
    matches.push({ key, prefix, sessionId, namespace });
  }
  if (matches.length !== 1) {
    const error = new Error("regression cookie must bind exactly one Redis primary session hash");
    error.code = matches.length === 0 ? "REGRESSION_REDIS_SESSION_NOT_FOUND" : "REGRESSION_REDIS_SESSION_AMBIGUOUS";
    throw error;
  }
  const [match] = matches;
  const keys = [match.key];
  const expiresKey = `${match.prefix}expires:${match.sessionId}`;
  if (redisCommand("EXISTS", expiresKey) === "1") keys.push(expiresKey);
  return {
    cookieName: cookie.name,
    keys: sortedUnique(keys),
    members: redisExpirationMembers([match])
  };
}

export function verifyRedisSessionReleased(snapshot) {
  const remainingKeys = snapshot.keys.filter((key) => redisCommand("EXISTS", key) !== "0");
  const remainingMembers = snapshot.members.filter(({ key, member }) => redisCommand("SISMEMBER", key, member) !== "0");
  return { remainingKeys, remainingMembers, total: remainingKeys.length + remainingMembers.length };
}

function forceReleaseRedisSessions(username) {
  const initial = redisOwnedByUsername(username);
  const provenPrimaryKeys = new Set(initial.primaryHashes.map(({ key }) => key));
  const provenRelatedKeys = new Set(initial.keys.filter((key) => !provenPrimaryKeys.has(key)));
  const provenMembers = new Map(initial.members.map(({ key, member }) => [`${key}\u0000${member}`, { key, member }]));
  const deleteProvenState = () => {
    for (const key of provenPrimaryKeys) {
      deleteProvenRedisPrimary(key, username);
    }
    for (const key of provenRelatedKeys) redisCommand("DEL", key);
    for (const { key, member } of provenMembers.values()) redisCommand("SREM", key, member);
  };
  deleteProvenState();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    synchronousPause(100);
    const newlyOwned = redisOwnedByUsername(username);
    for (const row of newlyOwned.primaryHashes) provenPrimaryKeys.add(row.key);
    for (const key of newlyOwned.keys) {
      if (!newlyOwned.primaryHashes.some((row) => row.key === key)) provenRelatedKeys.add(key);
    }
    for (const row of newlyOwned.members) provenMembers.set(`${row.key}\u0000${row.member}`, row);
    const exactKeyResidue = [...provenPrimaryKeys, ...provenRelatedKeys]
      .filter((key) => redisCommand("EXISTS", key) === "1");
    const exactMemberResidue = [...provenMembers.values()]
      .filter(({ key, member }) => redisCommand("SISMEMBER", key, member) !== "0");
    if (newlyOwned.primaryHashes.length === 0
      && newlyOwned.keys.length === 0
      && newlyOwned.members.length === 0
      && exactKeyResidue.length === 0
      && exactMemberResidue.length === 0) {
      return initial;
    }
    deleteProvenState();
  }
  throw new Error("regression Redis session state did not quiesce after exact atomic deletion");
}

function collectRedisSnapshotSecrets(snapshot, target) {
  if (!(target instanceof Set)) return;
  for (const row of snapshot?.primaryHashes || []) {
    target.add(row.key);
    target.add(row.sessionId);
  }
  for (const key of snapshot?.keys || []) target.add(key);
  for (const row of snapshot?.members || []) {
    target.add(row.key);
    target.add(row.member);
  }
}

export function retryRegressionRedisInvariantCapture(
  capture,
  { maximumAttempts = 3, pause = synchronousPause } = {}
) {
  assert(typeof capture === "function", "regression Redis invariant capture must be a function");
  assert(Number.isInteger(maximumAttempts) && maximumAttempts >= 1 && maximumAttempts <= 10,
    "regression Redis invariant retry count is invalid");
  assert(typeof pause === "function", "regression Redis invariant retry pause must be a function");
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      return capture();
    } catch (error) {
      if (error?.code !== redisInvariantCaptureRaceCode || attempt === maximumAttempts) throw error;
      pause(25);
    }
  }
  throw new Error("regression Redis invariant capture retry exhausted unexpectedly");
}

export function captureUserSessionInvariant(username = "admin") {
  return retryRegressionRedisInvariantCapture(() => captureUserSessionInvariantOnce(username));
}

function captureUserSessionInvariantOnce(username) {
  assert(/^[A-Za-z0-9_.@-]{1,80}$/.test(username), "regression session invariant username is invalid");
  const row = dbJson(`
    SELECT jsonb_build_object(
      'userId', user_row.id::text,
      'enabled', user_row.enabled,
      'passwordHash', user_row.password_hash,
      'failedLoginCount', user_row.failed_login_count,
      'lockedUntil', user_row.locked_until,
      'lastLoginAt', user_row.last_login_at,
      'defaultAccountSetId', user_row.default_account_set_id::text,
      'activeSessionToken', user_row.active_session_token,
      'activeSessionStartedAt', user_row.active_session_started_at,
      'lastSessionReplacedAt', user_row.last_session_replaced_at,
      'sessionGeneration', user_row.session_generation,
      'roles', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'userId', user_role.user_id::text,
          'roleId', role_row.id::text,
          'roleCode', role_row.code,
          'enabled', role_row.enabled
        ) ORDER BY role_row.id::text)
        FROM public.sys_user_role user_role
        JOIN public.sys_role role_row ON role_row.id=user_role.role_id
        WHERE user_role.user_id=user_row.id
      ), '[]'::jsonb),
      'grants', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'grantId', user_grant.id::text,
          'userId', user_grant.user_id::text,
          'accountSetId', account_set.id::text,
          'accountSetCode', account_set.code,
          'roleCode', user_grant.role_code,
          'isDefault', user_grant.is_default,
          'enabled', user_grant.enabled,
          'employeeCode', user_grant.employee_code,
          'version', user_grant.version,
          'createdAt', user_grant.created_at,
          'updatedAt', user_grant.updated_at
        ) ORDER BY account_set.id::text)
        FROM public.sys_user_account_set user_grant
        JOIN public.sys_account_set account_set ON account_set.id=user_grant.account_set_id
        WHERE user_grant.user_id=user_row.id
      ), '[]'::jsonb),
      'scopes', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'sessionToken', scope_row.session_token::text,
          'accountSetId', scope_row.account_set_id::text,
          'scopeToken', scope_row.scope_token::text,
          'version', scope_row.version,
          'createdAt', scope_row.created_at,
          'updatedAt', scope_row.updated_at
        ) ORDER BY scope_row.session_token::text)
        FROM public.sys_session_account_scope scope_row
        WHERE scope_row.user_id=user_row.id
      ), '[]'::jsonb)
    )::text
    FROM public.sys_user user_row
    WHERE user_row.username=${sqlLiteral(username)}
  `, "regression shared user session invariant");
  assert(row && uuidPattern.test(String(row.userId ?? "")), "regression shared user session invariant requires one persisted user");
  const redis = redisOwnedByUsername(username);
  const digestNullable = (value) => value == null ? null : sha256(String(value));
  const expiryForKey = (key) => {
    const expiresAtEpochMs = Number(redisCommand("PEXPIRETIME", key));
    if (!Number.isInteger(expiresAtEpochMs) || expiresAtEpochMs < -1) {
      throw Object.assign(
        new Error("regression shared user Redis key disappeared during invariant capture"),
        { code: redisInvariantCaptureRaceCode }
      );
    }
    return expiresAtEpochMs === -1 ? null : expiresAtEpochMs;
  };
  const primaryBySessionId = new Map(redis.primaryHashes.map((row) => [row.sessionId, row]));
  const primaryKeySet = new Set(redis.primaryHashes.map(({ key }) => key));
  const relatedKeys = redis.keys
    .filter((key) => !primaryKeySet.has(key))
    .map((key) => {
      const owner = [...primaryBySessionId.values()].find(({ prefix, sessionId }) => (
        key === `${prefix}expires:${sessionId}`
      ));
      return {
        keyDigest: sha256(key),
        primaryKeyDigest: owner ? sha256(owner.key) : null,
        contentDigest: redisValueDigest(key),
        expiresAtEpochMs: expiryForKey(key)
      };
    })
    .sort((left, right) => left.keyDigest.localeCompare(right.keyDigest));
  const primarySessions = redis.primaryHashes.map((owner) => ({
    keyDigest: sha256(owner.key),
    sessionIdDigest: sha256(owner.sessionId),
    contentDigest: redisValueDigest(owner.key),
    expiresAtEpochMs: expiryForKey(owner.key),
    expiryBoundarySource: "primary-key"
  })).sort((left, right) => left.keyDigest.localeCompare(right.keyDigest));
  const expirationMembers = redis.members.map(({ key, member }) => {
    const owner = [...primaryBySessionId.entries()].find(([sessionId]) => member.includes(sessionId))?.[1];
    assert(owner, "regression shared user Redis expiration member has no proven primary owner");
    const primary = primarySessions.find((entry) => entry.keyDigest === sha256(owner.key));
    assert(primary, "regression shared user Redis expiration member primary digest is unavailable");
    const expiresKey = `${owner.prefix}expires:${owner.sessionId}`;
    const expiresEntry = relatedKeys.find((entry) => entry.keyDigest === sha256(expiresKey));
    const expirationBucket = Number(key.match(/expirations:(\d+)$/)?.[1]);
    const logicalExpiresAtEpochMs = resolveRegressionSessionLogicalExpiry({
      primaryExpiresAtEpochMs: primary.expiresAtEpochMs,
      expiresKeyExpiresAtEpochMs: expiresEntry?.expiresAtEpochMs,
      expirationBucketEpochMs: expirationBucket
    });
    assert(Number.isInteger(logicalExpiresAtEpochMs) && logicalExpiresAtEpochMs > 0,
      "regression shared user Redis expiration member has no logical expiry boundary");
    return {
      memberDigest: sha256(`${key}\u0000${member}`),
      primaryKeyDigest: primary.keyDigest,
      logicalExpiresAtEpochMs
    };
  }).sort((left, right) => left.memberDigest.localeCompare(right.memberDigest));
  const redisTime = redisCommand("TIME").split(/\r?\n/).map(Number);
  assert(redisTime.length >= 2 && Number.isInteger(redisTime[0]) && Number.isInteger(redisTime[1]),
    "regression shared user Redis clock is unavailable");
  const capturedAtEpochMs = redisTime[0] * 1000 + Math.floor(redisTime[1] / 1000);
  return {
    database: {
      userIdDigest: sha256(String(row.userId)),
      enabled: row.enabled === true,
      passwordHashDigest: digestNullable(row.passwordHash),
      failedLoginCount: Number(row.failedLoginCount),
      lockedUntilDigest: digestNullable(row.lockedUntil),
      lastLoginAtDigest: digestNullable(row.lastLoginAt),
      defaultAccountSetIdDigest: digestNullable(row.defaultAccountSetId),
      activeSessionTokenDigest: digestNullable(row.activeSessionToken),
      activeSessionStartedAtDigest: digestNullable(row.activeSessionStartedAt),
      lastSessionReplacedAtDigest: digestNullable(row.lastSessionReplacedAt),
      sessionGeneration: Number(row.sessionGeneration),
      roleCount: Array.isArray(row.roles) ? row.roles.length : -1,
      roleDigest: sha256(JSON.stringify(Array.isArray(row.roles) ? row.roles : [])),
      grantCount: Array.isArray(row.grants) ? row.grants.length : -1,
      grantDigest: sha256(JSON.stringify(Array.isArray(row.grants) ? row.grants : [])),
      scopeCount: Array.isArray(row.scopes) ? row.scopes.length : -1,
      scopeDigest: sha256(JSON.stringify(Array.isArray(row.scopes) ? row.scopes : []))
    },
    redis: {
      target: resolveRegressionRedisTarget(),
      capturedAtEpochMs,
      primarySessions,
      relatedKeys,
      expirationMembers
    }
  };
}

export function resolveRegressionSessionLogicalExpiry({
  primaryExpiresAtEpochMs,
  expiresKeyExpiresAtEpochMs,
  expirationBucketEpochMs
}) {
  const logicalExpiresAtEpochMs = [
    expiresKeyExpiresAtEpochMs,
    expirationBucketEpochMs,
    primaryExpiresAtEpochMs
  ].find((candidate) => Number.isInteger(candidate) && candidate > 0);
  assert(Number.isInteger(logicalExpiresAtEpochMs) && logicalExpiresAtEpochMs > 0,
    "regression shared user Redis primary session has no logical expiry boundary");
  return logicalExpiresAtEpochMs;
}

function exactSessionExpectation(expectedRole, accountSetCode, expectations = {}) {
  return {
    roleCode: expectations.expectedRoleCode ?? standardRoleCodes.get(expectedRole) ?? "",
    schemaName: expectations.expectedSchemaName ?? (accountSetCode === "BLD-TEST" ? "public" : "")
  };
}

function sessionMatches(session, { username, expectedRole, accountSetCode, roleCode, schemaName }) {
  return Boolean(
    session?.authenticated
    && session?.user?.username === username
    && (!expectedRole || session?.user?.role === expectedRole)
    && (!roleCode || session?.user?.roleCode === roleCode)
    && (!accountSetCode || session?.tenant?.code === accountSetCode)
    && (!schemaName || session?.tenant?.schemaName === schemaName)
  );
}

export async function loginAs(
  page,
  username = "admin",
  password = "admin123",
  expectedRole = "",
  accountSetCode = "BLD-TEST",
  expectations = {}
) {
  ({ username, password } = effectiveLoginCredentials("frontend", page.url(), username, password));
  const exact = exactSessionExpectation(expectedRole, accountSetCode, expectations);
  let loginPage = page.getByTestId("login-page");
  let visible = await loginPage.isVisible({ timeout: 1500 }).catch(() => false);
  if (!visible) {
    const active = await page.evaluate(async (expected) => {
      try {
        const response = await fetch("/api/system/session");
        if (!response.ok) return false;
        const session = await response.json();
        return Boolean(
          session?.authenticated
          && session?.user?.username === expected.username
          && (!expected.expectedRole || session?.user?.role === expected.expectedRole)
          && (!expected.roleCode || session?.user?.roleCode === expected.roleCode)
          && (!expected.accountSetCode || session?.tenant?.code === expected.accountSetCode)
          && (!expected.schemaName || session?.tenant?.schemaName === expected.schemaName)
        );
      } catch {
        return false;
      }
    }, { username, expectedRole, accountSetCode, ...exact }).catch(() => false);
    if (active) {
      await reportPlaywrightSessionCookies(page);
      return;
    }
    await page.context().clearCookies();
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    }).catch(() => {});
    await page.reload({ waitUntil: "domcontentloaded" });
    loginPage = page.getByTestId("login-page");
    visible = await loginPage.isVisible({ timeout: 5000 }).catch(() => false);
  }
  if (!visible) throw new Error("login page did not appear for stale session recovery");
  const usernameInput = page.getByTestId("login-username");
  if (await usernameInput.isVisible({ timeout: 1000 }).catch(() => false)) await usernameInput.fill(username);
  const accountSetSelect = page.getByTestId("login-account-set");
  if (await accountSetSelect.isVisible({ timeout: 1000 }).catch(() => false)) await accountSetSelect.selectOption(accountSetCode);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await page.getByTestId("content-area").waitFor({ state: "visible", timeout: 10000 });
  if (expectedRole) {
    await page.getByTestId("session-user-role").filter({ hasText: expectedRole }).waitFor({ state: "visible", timeout: 10000 });
  }
  const session = await page.evaluate(async () => {
    const response = await fetch("/api/system/session");
    return { status: response.status, body: await response.json() };
  });
  if (session.status !== 200 || !sessionMatches(session.body, { username, expectedRole, accountSetCode, ...exact })) {
    throw new Error(`formal login session mismatch: ${JSON.stringify({
      status: session.status,
      authenticated: session.body?.authenticated,
      username: session.body?.user?.username,
      role: session.body?.user?.role,
      roleCode: session.body?.user?.roleCode,
      accountSetCode: session.body?.tenant?.code,
      schemaName: session.body?.tenant?.schemaName
    })}`);
  }
  await reportPlaywrightSessionCookies(page);
}

export async function loginAsAdmin(page, password = "admin123", accountSetCode = "BLD-TEST", username = "admin") {
  await loginAs(page, username, password, "系统管理员", accountSetCode, {
    expectedRoleCode: "ADMIN",
    expectedSchemaName: accountSetCode === "BLD-TEST" ? "public" : ""
  });
}

export async function openAccountMenu(page) {
  const accountMenu = page.getByTestId("session-account-menu");
  if (await accountMenu.isVisible({ timeout: 1000 }).catch(() => false)) {
    const expanded = await accountMenu.evaluate((node) => node.parentElement?.hasAttribute("open") ?? false).catch(() => false);
    if (!expanded) await accountMenu.click();
    return;
  }
  const userName = page.getByTestId("session-user-name");
  if (await userName.isVisible({ timeout: 1000 }).catch(() => false)) {
    await userName.click();
    return;
  }
  throw new Error("account menu trigger not visible");
}

export async function logout(page) {
  const logoutButton = page.getByTestId("session-logout");
  if (!(await logoutButton.isVisible({ timeout: 500 }).catch(() => false))) await openAccountMenu(page);
  const logoutResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/system/logout" && response.request().method() === "POST";
  }, { timeout: 10000 });
  await page.getByTestId("session-logout").click();
  const response = await logoutResponse;
  if (!response.ok()) throw new Error(`browser logout failed ${response.status()}`);
  await page.getByTestId("login-page").waitFor({ state: "visible", timeout: 10000 });
  const session = await page.evaluate(async () => {
    const probe = await fetch("/api/system/session");
    return { status: probe.status, body: await probe.json() };
  });
  if (session.status !== 200 || session.body?.authenticated === true) {
    throw new Error(`browser logout left an authenticated server session: ${JSON.stringify({
      status: session.status,
      authenticated: session.body?.authenticated
    })}`);
  }
}

export async function openPasswordChange(page) {
  const passwordButton = page.getByTestId("session-password-change");
  if (!(await passwordButton.isVisible({ timeout: 500 }).catch(() => false))) await openAccountMenu(page);
  await page.getByTestId("session-password-change").click();
}

export async function loginApi(apiBase, username = "admin", password = "admin123", accountSetCode = "BLD-TEST") {
  const origin = canonicalOrigin(apiBase, "regression API login target");
  if (isolatedBackendOnly) {
    const target = new URL(origin);
    if (!target.port || ["8080", "5173"].includes(target.port)) {
      throw new Error("isolated regression login refuses the main backend and frontend ports");
    }
  }
  ({ username, password } = effectiveLoginCredentials("api", origin, username, password));
  const response = await nativeFetch(`${origin}/api/system/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, accountSetCode })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`api login failed ${response.status}: ${text}`);
  }
  const sessionCookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
  reportSensitiveCookie(sessionCookie);
  return sessionCookie;
}

export async function requestWithRegressionAdminConfirmation(
  apiBase,
  pathname,
  { sessionCookie = "", reason = "", invalidPassword = false, body = {} } = {}
) {
  const origin = canonicalOrigin(apiBase, "regression ADMIN confirmation target");
  const runtime = readRuntimeCredentials();
  if (runtime && origin !== mainApiBase) {
    throw new Error("regression ADMIN confirmation refuses a non-main origin while suite credentials are active");
  }
  assert(/^\/api\/document-lifecycle\/[A-Za-z0-9_/%.-]+\/void$/.test(String(pathname ?? "")),
    "regression ADMIN confirmation only supports one document lifecycle void endpoint");
  const credentials = regressionAdminCredentials();
  const response = await nativeFetch(`${origin}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sessionCookie ? { Cookie: sessionCookie } : {})
    },
    body: JSON.stringify({
      ...body,
      username: credentials.username,
      password: invalidPassword ? `${credentials.password}-wrong` : credentials.password,
      reason
    }),
    signal: AbortSignal.timeout(10000)
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { ok: response.ok, status: response.status, data, text };
}

export async function postPublicPasswordResetRequest(
  apiBase,
  { username = "", contactNote = "", forwardedFor = "" } = {}
) {
  const origin = canonicalOrigin(apiBase, "public password-reset regression target");
  const headers = new Headers({ "Content-Type": "application/json" });
  if (forwardedFor) headers.set("X-Forwarded-For", forwardedFor);
  return nativeFetch(`${origin}/api/system/password-reset-requests`, {
    method: "POST",
    headers,
    body: JSON.stringify({ username, contactNote }),
    signal: AbortSignal.timeout(5_000)
  });
}

export async function logoutApiSession(apiBase, sessionCookie) {
  const origin = canonicalOrigin(apiBase, "regression API logout target");
  if (readRuntimeCredentials() && origin !== mainApiBase) {
    throw new Error("regression API logout refuses a non-main origin while suite credentials are active");
  }
  const logoutResponse = await nativeFetch(`${origin}/api/system/logout`, {
    method: "POST",
    headers: { Cookie: sessionCookie },
    signal: AbortSignal.timeout(10000)
  });
  if (!logoutResponse.ok) throw new Error(`api logout failed ${logoutResponse.status}`);
  const probe = await nativeFetch(`${origin}/api/system/session`, {
    headers: { Cookie: sessionCookie },
    signal: AbortSignal.timeout(10000)
  });
  const text = await probe.text();
  let session;
  try {
    session = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("api logout session probe returned invalid JSON");
  }
  if (!probe.ok || session?.authenticated === true) {
    throw new Error(`api logout left an authenticated server session status=${probe.status}`);
  }
  return { authenticated: false };
}

export async function installApiSessionInBrowser(
  context,
  apiBase,
  username = "admin",
  password = "admin123",
  accountSetCode = "BLD-TEST",
  options = {}
) {
  const origin = canonicalOrigin(apiBase, "regression browser session target");
  const sessionCookie = await loginApi(origin, username, password, accountSetCode);
  options.onSessionCookie?.(sessionCookie);
  const parsed = parseSessionCookie(sessionCookie);
  await context.addCookies([{
    name: parsed.name,
    value: parsed.value,
    url: `${origin}/`
  }]);
  return sessionCookie;
}

export async function installApiSession(
  apiBase,
  username = "admin",
  password = "admin123",
  accountSetCode = "BLD-TEST",
  options = {}
) {
  const origin = canonicalOrigin(apiBase, "regression API session target");
  let sessionCookie = await loginApi(origin, username, password, accountSetCode);
  options.onSessionCookie?.(sessionCookie);
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init = {}) => {
    const rawUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    let target;
    try {
      target = new URL(rawUrl, `${origin}/`);
    } catch {
      return originalFetch(input, init);
    }
    if (target.origin !== origin || target.pathname === "/api/system/login") return originalFetch(input, init);
    const headers = new Headers(init.headers ?? (typeof input === "string" ? undefined : input.headers));
    const callerProvidedCookie = headers.has("Cookie");
    if (!callerProvidedCookie) headers.set("Cookie", sessionCookie);
    const response = await originalFetch(input, { ...init, headers });
    if (response.status !== 401 || callerProvidedCookie) return response;
    sessionCookie = await loginApi(origin, username, password, accountSetCode);
    options.onSessionCookie?.(sessionCookie);
    const retryHeaders = new Headers(init.headers ?? (typeof input === "string" ? undefined : input.headers));
    retryHeaders.set("Cookie", sessionCookie);
    return originalFetch(input, { ...init, headers: retryHeaders });
  };
  return sessionCookie;
}

function verifyFixtureRoute(accountSetCodes) {
  const route = dbJson(`
    SELECT jsonb_build_object(
      'roleId', admin_role.id::text,
      'roleEnabled', admin_role.enabled,
      'accountSets', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', account_set.id::text,
          'code', account_set.code,
          'schemaName', account_set.schema_name,
          'enabled', account_set.enabled
        ) ORDER BY account_set.code)
        FROM public.sys_account_set account_set
        WHERE account_set.code=ANY(${sqlTextArray(accountSetCodes)})
      ), '[]'::jsonb)
    )::text
    FROM public.sys_role admin_role
    WHERE admin_role.code='ADMIN'
  `, "isolated regression route lookup");
  assert(uuidPattern.test(String(route?.roleId ?? "")) && route?.roleEnabled === true,
    "isolated regression route requires one enabled ADMIN role");
  assert(Array.isArray(route.accountSets) && route.accountSets.length === accountSetCodes.length,
    "isolated regression route could not resolve every requested account set");
  const actualCodes = route.accountSets.map((row) => row.code).sort();
  assert(JSON.stringify(actualCodes) === JSON.stringify([...accountSetCodes].sort()),
    "isolated regression route resolved unexpected account sets");
  for (const row of route.accountSets) {
    assert(uuidPattern.test(String(row.id ?? "")) && row.enabled === true,
      "isolated regression route requires enabled account sets");
    assert(/^[a-z][a-z0-9_]{0,62}$/.test(String(row.schemaName ?? "")),
      "isolated regression route contains an unsafe tenant schema");
  }
  return route;
}

function discoverOperationLogSchemas() {
  const rows = dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'schemaName', schema_row.schema_name,
      'hasActorType', schema_row.has_actor_type,
      'hasActorUsername', schema_row.has_actor_username,
      'hasOperatedBy', schema_row.has_operated_by
    ) ORDER BY schema_row.schema_name), '[]'::jsonb)::text
    FROM (
      SELECT namespace.nspname AS schema_name,
             bool_or(attribute.attname='actor_type') AS has_actor_type,
             bool_or(attribute.attname='actor_username') AS has_actor_username,
             bool_or(attribute.attname='operated_by') AS has_operated_by
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      LEFT JOIN pg_attribute attribute
        ON attribute.attrelid=relation.oid
       AND attribute.attnum>0
       AND NOT attribute.attisdropped
       AND attribute.attname IN ('actor_type', 'actor_username', 'operated_by')
      WHERE relation.relname='sys_operation_log'
        AND relation.relkind IN ('r', 'p')
        AND namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
        AND namespace.nspname<>'information_schema'
      GROUP BY namespace.nspname
    ) schema_row
  `, "isolated regression operation-log schema discovery");
  assert(Array.isArray(rows), "isolated regression operation-log schema discovery returned invalid metadata");
  for (const row of rows) sqlIdentifier(row.schemaName);
  return rows;
}

function operationLogResidue({ schemas, username, userId }) {
  assert(uuidPattern.test(String(userId ?? "")), "isolated regression operation-log cleanup requires a fixture user id");
  let exact = 0;
  let inconsistent = 0;
  for (const schema of schemas) {
    if (!schema.hasOperatedBy) {
      throw new Error(`isolated regression operation-log schema ${schema.schemaName} lacks operated_by`);
    }
    if (schema.hasActorType && schema.hasActorUsername) {
      const counts = dbJson(`
        SELECT jsonb_build_object(
          'exact', count(*) FILTER (WHERE actor_type='USER' AND operated_by=${sqlLiteral(userId)}::uuid AND actor_username=${sqlLiteral(username)}),
          'inconsistent', count(*) FILTER (
            WHERE (operated_by=${sqlLiteral(userId)}::uuid OR actor_username=${sqlLiteral(username)})
              AND (
                actor_type IS DISTINCT FROM 'USER'
                OR operated_by IS DISTINCT FROM ${sqlLiteral(userId)}::uuid
                OR actor_username IS DISTINCT FROM ${sqlLiteral(username)}
              )
          )
        )::text
        FROM ${sqlIdentifier(schema.schemaName)}.sys_operation_log
      `, "isolated regression operation-log residue verification");
      exact += Number(counts?.exact || 0);
      inconsistent += Number(counts?.inconsistent || 0);
    } else {
      inconsistent += dbNumber(`
        SELECT count(*) FROM ${sqlIdentifier(schema.schemaName)}.sys_operation_log
        WHERE operated_by=${sqlLiteral(userId)}::uuid
      `, "isolated regression legacy operation-log residue verification");
    }
  }
  return { exact, inconsistent };
}

function deleteFixtureOperationLogs({ username, userId, injectFailure = false }) {
  if (injectFailure) throw new Error("isolated regression injected operation-log cleanup failure");
  let lastSchemaFingerprint = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const schemas = discoverOperationLogSchemas();
    const fingerprint = JSON.stringify(schemas);
    const statements = schemas.map((schema) => {
      const table = `${sqlIdentifier(schema.schemaName)}.sys_operation_log`;
      if (schema.hasActorType && schema.hasActorUsername && schema.hasOperatedBy) {
        return `
          LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE;
          DO $fixture_log_guard$
          BEGIN
            IF EXISTS (
              SELECT 1 FROM ${table}
              WHERE (operated_by=${sqlLiteral(userId)}::uuid OR actor_username=${sqlLiteral(username)})
                AND (
                  actor_type IS DISTINCT FROM 'USER'
                  OR operated_by IS DISTINCT FROM ${sqlLiteral(userId)}::uuid
                  OR actor_username IS DISTINCT FROM ${sqlLiteral(username)}
                )
            ) THEN
              RAISE EXCEPTION 'isolated regression actor provenance mismatch in ${schema.schemaName}';
            END IF;
          END $fixture_log_guard$;
          DELETE FROM ${table}
          WHERE actor_type='USER'
            AND operated_by=${sqlLiteral(userId)}::uuid
            AND actor_username=${sqlLiteral(username)};
        `;
      }
      if (!schema.hasOperatedBy) {
        throw new Error(`isolated regression operation-log schema ${schema.schemaName} lacks operated_by`);
      }
      return `
        LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE;
        DO $fixture_legacy_log_guard$
        BEGIN
          IF EXISTS (SELECT 1 FROM ${table} WHERE operated_by=${sqlLiteral(userId)}::uuid) THEN
            RAISE EXCEPTION 'isolated regression cannot prove actor provenance in legacy schema ${schema.schemaName}';
          END IF;
        END $fixture_legacy_log_guard$;
      `;
    });
    runPsql(`BEGIN; ${statements.join("\n")} COMMIT;`, "isolated regression operation-log cleanup");
    const afterSchemas = discoverOperationLogSchemas();
    const residue = operationLogResidue({ schemas: afterSchemas, username, userId });
    if (residue.inconsistent !== 0) throw new Error("isolated regression operation-log provenance residue is inconsistent");
    const afterFingerprint = JSON.stringify(afterSchemas);
    const stable = residue.exact === 0 && fingerprint === afterFingerprint;
    if (stable && lastSchemaFingerprint === fingerprint) {
      return { schemaCount: afterSchemas.length, exactResidue: 0, inconsistentResidue: 0 };
    }
    lastSchemaFingerprint = stable ? afterFingerprint : "";
  }
  throw new Error("isolated regression operation-log schemas did not stabilize with zero residue");
}

function resolveFixtureIdentity({
  username,
  userId = "",
  displayName = "",
  requireTombstone = false,
  allowMetadataDrift = false
}) {
  assert(/^r_[a-z0-9_]{1,58}_[0-9a-f]{12,32}$/.test(username), "isolated regression identity username is outside the owned namespace");
  const rows = dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'userId', id::text,
      'username', username,
      'displayName', display_name,
      'passwordHash', password_hash,
      'enabled', enabled,
      'sessionGeneration', session_generation,
      'createdBy', created_by::text,
      'updatedBy', updated_by::text,
      'activeSessionToken', active_session_token,
      'activeSessionStartedAt', active_session_started_at
    ) ORDER BY id::text), '[]'::jsonb)::text
    FROM public.sys_user
    WHERE username=${sqlLiteral(username)}
      ${userId ? `OR id=${sqlLiteral(userId)}::uuid` : ""}
  `, "isolated regression identity ownership lookup");
  assert(Array.isArray(rows), "isolated regression identity ownership lookup returned invalid metadata");
  if (rows.length === 0) return null;
  assert(rows.length === 1, "isolated regression identity username and ledger id resolve different users");
  const [row] = rows;
  assert(uuidPattern.test(String(row.userId ?? "")), "isolated regression identity ownership mismatch");
  const ownershipMatches = row.createdBy === row.userId && row.updatedBy === row.userId;
  if (!allowMetadataDrift) {
    assert(ownershipMatches, "isolated regression identity ownership sentinel mismatch");
  }
  const metadataMatches = row.username === username
    && (!userId || row.userId === userId)
    && (!displayName || row.displayName === displayName);
  if (!allowMetadataDrift) {
    assert(metadataMatches, "isolated regression identity id, username, or run marker drifted");
  }
  if (requireTombstone) {
    assert(row.passwordHash === fixtureTombstonePasswordHash && row.enabled === false,
      "isolated regression reusable identity is missing the disabled tombstone marker");
  }
  return { ...row, metadataMatches, ownershipMatches };
}

function adoptLegacySuiteTombstone({ username, displayName }) {
  assert(username === "r_full_000000000000000000000000",
    "legacy regression tombstone adoption is restricted to the suite principal");
  const legacy = dbJson(`
    SELECT jsonb_build_object(
      'userId', id::text,
      'displayName', display_name,
      'passwordHash', password_hash,
      'enabled', enabled,
      'createdBy', created_by::text,
      'updatedBy', updated_by::text
    )::text
    FROM public.sys_user
    WHERE username=${sqlLiteral(username)}
  `, "legacy regression tombstone lookup");
  if (!legacy || (legacy.createdBy === legacy.userId && legacy.updatedBy === legacy.userId)) return false;
  const hasLegacySignature = uuidPattern.test(String(legacy.userId ?? ""))
    && legacy.displayName === displayName
    && legacy.enabled === false
    && legacy.createdBy == null
    && legacy.updatedBy == null
    && /^\{noop\}disabled-[A-Za-z0-9_-]{32}$/.test(String(legacy.passwordHash ?? ""));
  if (!hasLegacySignature) return false;
  const state = fixtureIdentityState({ username, userId: legacy.userId });
  const redis = redisOwnedByUsername(username);
  const logs = operationLogResidue({ schemas: discoverOperationLogSchemas(), username, userId: legacy.userId });
  assert(Number(state?.userCount) === 1
    && Number(state?.enabledCount) === 0
    && Number(state?.activeSessionCount) === 0
    && Number(state?.roleCount) === 0
    && Number(state?.grantCount) === 0
    && Number(state?.scopeCount) === 0
    && redis.primaryHashes.length === 0
    && redis.keys.length === 0
    && redis.members.length === 0
    && logs.exact === 0
    && logs.inconsistent === 0,
  "legacy regression tombstone is not in the exact closed state");
  runPsql(`
    UPDATE public.sys_user
    SET password_hash=${sqlLiteral(fixtureTombstonePasswordHash)},
        created_by=id,
        updated_by=id,
        failed_login_count=0,
        locked_until=NULL,
        updated_at=now(),
        version=version + 1
    WHERE id=${sqlLiteral(legacy.userId)}::uuid
      AND username=${sqlLiteral(username)}
      AND display_name=${sqlLiteral(displayName)}
      AND enabled=FALSE
      AND password_hash=${sqlLiteral(legacy.passwordHash)}
      AND created_by IS NULL
      AND updated_by IS NULL
  `, "legacy regression tombstone adoption");
  resolveFixtureIdentity({
    username,
    userId: legacy.userId,
    displayName,
    requireTombstone: true
  });
  return true;
}

function hardDisableFixtureIdentity({ username, userId, displayName }) {
  const owned = resolveFixtureIdentity({
    username,
    userId,
    displayName,
    allowMetadataDrift: true
  });
  if (!owned) return { exists: false, userId };
  const resolvedUserId = owned.userId;
  runPsql(`
    BEGIN;
    SELECT id FROM public.sys_user
    WHERE id=${sqlLiteral(resolvedUserId)}::uuid
    FOR UPDATE;
    UPDATE public.sys_user
    SET enabled=FALSE,
        password_hash=${sqlLiteral(fixtureTombstonePasswordHash)},
        active_session_token=NULL,
        active_session_started_at=NULL,
        created_by=id,
        updated_by=id,
        session_generation=session_generation + 1,
        updated_at=now(),
        version=version + 1
    WHERE id=${sqlLiteral(resolvedUserId)}::uuid;
    COMMIT;
  `, "isolated regression identity hard fence");
  const state = fixtureIdentityState({ username, userId: resolvedUserId });
  assert(Number(state?.userCount) === 1
    && Number(state?.usernameMatchCount) === 1
    && Number(state?.enabledCount) === 0
    && Number(state?.activeSessionCount) === 0
    && Number(state?.ownedTombstoneCount) === 1,
  "isolated regression identity hard disable is incomplete");
  return {
    exists: true,
    userId: resolvedUserId,
    actualUsername: owned.username,
    metadataMatches: owned.metadataMatches,
    ownershipMatches: owned.ownershipMatches,
    state
  };
}

function quarantineFixtureIdentity({ username, userId, displayName }) {
  const hardDisabled = hardDisableFixtureIdentity({ username, userId, displayName });
  if (!hardDisabled.exists) return hardDisabled;
  const resolvedUserId = hardDisabled.userId;
  runPsql(`
    BEGIN;
    DELETE FROM public.sys_session_account_scope WHERE user_id=${sqlLiteral(resolvedUserId)}::uuid;
    DELETE FROM public.sys_user_account_set WHERE user_id=${sqlLiteral(resolvedUserId)}::uuid;
    DELETE FROM public.sys_user_role WHERE user_id=${sqlLiteral(resolvedUserId)}::uuid;
    COMMIT;
  `, "isolated regression identity grant revocation");
  const state = fixtureIdentityState({ username, userId: resolvedUserId });
  assert(state.userCount === 1 && state.enabledCount === 0 && state.activeSessionCount === 0
    && state.roleCount === 0 && state.grantCount === 0 && state.scopeCount === 0,
  "isolated regression identity quarantine is incomplete");
  return {
    ...hardDisabled,
    userId: resolvedUserId,
    state
  };
}

function fixtureIdentityState({ username, userId }) {
  return dbJson(`
    SELECT jsonb_build_object(
      'userCount', (SELECT count(*) FROM public.sys_user WHERE id=${sqlLiteral(userId)}::uuid),
      'usernameMatchCount', (SELECT count(*) FROM public.sys_user WHERE id=${sqlLiteral(userId)}::uuid AND username=${sqlLiteral(username)}),
      'enabledCount', (SELECT count(*) FROM public.sys_user WHERE id=${sqlLiteral(userId)}::uuid AND enabled=TRUE),
      'activeSessionCount', (SELECT count(*) FROM public.sys_user WHERE id=${sqlLiteral(userId)}::uuid AND (active_session_token IS NOT NULL OR active_session_started_at IS NOT NULL)),
      'ownedTombstoneCount', (
        SELECT count(*) FROM public.sys_user
        WHERE id=${sqlLiteral(userId)}::uuid
          AND username=${sqlLiteral(username)}
          AND enabled=FALSE
          AND password_hash=${sqlLiteral(fixtureTombstonePasswordHash)}
          AND created_by=id
          AND updated_by=id
      ),
      'roleCount', (SELECT count(*) FROM public.sys_user_role WHERE user_id=${sqlLiteral(userId)}::uuid),
      'grantCount', (SELECT count(*) FROM public.sys_user_account_set WHERE user_id=${sqlLiteral(userId)}::uuid),
      'scopeCount', (SELECT count(*) FROM public.sys_session_account_scope WHERE user_id=${sqlLiteral(userId)}::uuid)
    )::text
  `, "isolated regression identity state verification");
}

function deleteFixtureIdentity({ username, userId, displayName, injectFailure = false }) {
  if (injectFailure) throw new Error("isolated regression injected identity deletion failure");
  runPsql(`
    BEGIN;
    DELETE FROM public.sys_user
    WHERE id=${sqlLiteral(userId)}::uuid
      AND username=${sqlLiteral(username)}
      AND display_name=${sqlLiteral(displayName)}
      AND enabled=FALSE
      AND active_session_token IS NULL
      AND active_session_started_at IS NULL;
    COMMIT;
  `, "isolated regression identity cleanup");
  assert(dbNumber(`SELECT count(*) FROM public.sys_user WHERE id=${sqlLiteral(userId)}::uuid`, "isolated regression identity deletion verification") === 0,
    "isolated regression identity deletion did not remove the owned user");
}

function cleanupFixtureClosure({
  username,
  userId,
  displayName,
  allowForcedRedisRelease = false,
  retainQuarantinedIdentity = false,
  initialErrors = [],
  faults = {},
  sensitiveValues = null
}) {
  const errors = [...initialErrors];
  let resolvedUserId = userId;
  let quarantined = false;
  let identityAbsent = false;
  let redisCleared = false;
  let operationLogsCleared = false;
  let identityDeleted = false;
  let forcedRedisSessionCount = 0;
  let operationLogSchemaCount = 0;
  const redisUsernames = new Set([username]);
  try {
    if (faults.quarantine) throw new Error("isolated regression injected quarantine failure");
    const quarantine = quarantineFixtureIdentity({ username, userId, displayName });
    resolvedUserId = quarantine.userId || resolvedUserId;
    quarantined = quarantine.exists;
    identityAbsent = !quarantine.exists;
    if (quarantine.actualUsername) redisUsernames.add(quarantine.actualUsername);
    if (quarantine.metadataMatches === false) {
      errors.push("isolated regression identity metadata drifted before cleanup");
    }
    if (quarantine.ownershipMatches === false) {
      errors.push("isolated regression identity ownership sentinel drifted before cleanup");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    if (faults.redis) throw new Error("isolated regression injected Redis cleanup failure");
    for (const redisUsername of redisUsernames) {
      const released = forceReleaseRedisSessions(redisUsername);
      collectRedisSnapshotSecrets(released, sensitiveValues);
      forcedRedisSessionCount += released.primaryHashes.length;
    }
    if (!allowForcedRedisRelease && forcedRedisSessionCount > 0) {
      errors.push("isolated regression cleanup required forced Redis release");
    }
    for (const redisUsername of redisUsernames) {
      const first = redisOwnedByUsername(redisUsername);
      const second = redisOwnedByUsername(redisUsername);
      if (first.primaryHashes.length || first.keys.length || first.members.length
        || second.primaryHashes.length || second.keys.length || second.members.length) {
        throw new Error("isolated regression Redis residue is not zero");
      }
    }
    redisCleared = true;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (resolvedUserId && uuidPattern.test(resolvedUserId) && (quarantined || identityAbsent)) {
    try {
      const operationLogResult = deleteFixtureOperationLogs({
        username,
        userId: resolvedUserId,
        injectFailure: faults.operationLog === true
      });
      operationLogSchemaCount = operationLogResult.schemaCount;
      operationLogsCleared = true;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    if (identityAbsent) {
      identityDeleted = true;
    } else if (retainQuarantinedIdentity && redisCleared && operationLogsCleared) {
      identityDeleted = false;
    } else if (redisCleared && operationLogsCleared) {
      try {
        deleteFixtureIdentity({
          username,
          userId: resolvedUserId,
          displayName,
          injectFailure: faults.identityDelete === true
        });
        identityDeleted = true;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  } else if (!resolvedUserId) {
    identityDeleted = true;
    operationLogsCleared = true;
  } else if (!quarantined) {
    const missing = resolveFixtureIdentity({ username, userId: resolvedUserId, displayName });
    identityDeleted = missing === null;
  }

  let retainedDisabled = false;
  if (!identityDeleted && resolvedUserId && uuidPattern.test(resolvedUserId)) {
    try {
      resolveFixtureIdentity({
        username,
        userId: resolvedUserId,
        displayName,
        requireTombstone: true
      });
      const state = fixtureIdentityState({ username, userId: resolvedUserId });
      retainedDisabled = Number(state?.userCount) === 1
        && Number(state?.enabledCount) === 0
        && Number(state?.activeSessionCount) === 0
        && Number(state?.ownedTombstoneCount) === 1
        && Number(state?.roleCount) === 0
        && Number(state?.grantCount) === 0
        && Number(state?.scopeCount) === 0
        && redisCleared;
      if (!retainedDisabled) errors.push("isolated regression retained identity is not safely quarantined");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const runtimeAccessCleaned = redisCleared && operationLogsCleared && (identityDeleted || retainedDisabled);
  if (!identityDeleted && retainedDisabled && !retainQuarantinedIdentity) {
    errors.push("isolated regression identity retained in disabled quarantine");
  }
  const result = {
    mode: retainQuarantinedIdentity ? "suite-tombstone-admin" : "run-unique-admin",
    cleaned: errors.length === 0 && identityDeleted && redisCleared && operationLogsCleared,
    runtimeAccessCleaned,
    closed: errors.length === 0 && runtimeAccessCleaned,
    principalDeleted: identityDeleted,
    retainedDisabled,
    reusableTombstone: retainQuarantinedIdentity && retainedDisabled,
    forcedRedisSessionCount,
    operationLogSchemaCount
  };
  if (errors.length > 0 || !result.closed) {
    const error = new Error(sortedUnique(errors.length ? errors : ["isolated regression cleanup did not reach zero residue"]).join("; "));
    error.cleanup = result;
    throw error;
  }
  return result;
}

export function recoverIsolatedAdminSessionFixture({
  username,
  userId = "",
  displayName = "本地管理员",
  retainQuarantinedIdentity = false,
  allowIdentityNeverCreated = false,
  allowLegacySuiteTombstoneAdoption = false
}) {
  if (allowLegacySuiteTombstoneAdoption) adoptLegacySuiteTombstone({ username, displayName });
  const owned = resolveFixtureIdentity({
    username,
    userId,
    displayName,
    allowMetadataDrift: uuidPattern.test(userId)
  });
  if (!owned) {
    const released = forceReleaseRedisSessions(username);
    const residue = redisOwnedByUsername(username);
    if (residue.primaryHashes.length || residue.keys.length || residue.members.length) {
      throw new Error("stale regression identity recovery left Redis residue");
    }
    let operationLogSchemaCount = 0;
    if (userId) {
      assert(uuidPattern.test(userId), "stale regression identity recovery requires a valid ledger user id");
      operationLogSchemaCount = deleteFixtureOperationLogs({ username, userId }).schemaCount;
    } else if (!allowIdentityNeverCreated) {
      throw new Error("stale regression identity recovery cannot prove that an absent identity was never created");
    }
    return {
      mode: "run-unique-admin",
      cleaned: true,
      closed: true,
      absent: true,
      forcedRedisSessionCount: released.primaryHashes.length,
      operationLogSchemaCount
    };
  }
  return cleanupFixtureClosure({
    username,
    userId: owned.userId,
    displayName,
    allowForcedRedisRelease: true,
    retainQuarantinedIdentity
  });
}

export async function closeAndRecoverRegressionFixtureLedger(
  targetApiBase,
  { secretDir, reference, writer = null },
  expectedRunId,
  controlCapability = ""
) {
  assert(reference?.runId === expectedRunId,
    "regression fixture ledger run ownership does not match");
  const ledger = readRegressionFixtureLedger({
    secretDir,
    reference,
    requireSealed: false
  });
  const distinctByIdentity = new Map();
  for (const entry of ledger.entries) {
    const key = `${entry.username}\u0000${entry.userId}`;
    const previous = distinctByIdentity.get(key);
    if (!previous || entry.generation > previous.generation) distinctByIdentity.set(key, entry);
  }
  const distinctEntries = [...distinctByIdentity.values()];

  const closeErrors = [];
  for (const entry of distinctEntries) {
    const owned = resolveFixtureIdentity({
      username: entry.username,
      userId: entry.userId,
      displayName: entry.displayName,
      allowMetadataDrift: true
    });
    if (!owned) continue;
    if (owned.metadataMatches !== true || owned.ownershipMatches !== true) {
      closeErrors.push(`${entry.username}: fixture ownership metadata drifted before request drain`);
      continue;
    }
    const currentGeneration = Number(owned.sessionGeneration);
    if (!Number.isSafeInteger(currentGeneration) || currentGeneration < 0) {
      closeErrors.push(`${entry.username}: fixture database generation is invalid`);
      continue;
    }
    if (currentGeneration > entry.generation && owned.enabled === true) {
      closeErrors.push(`${entry.username}: enabled newer fixture generation is not owned by this ledger`);
      continue;
    }
    if (currentGeneration < entry.generation) {
      if (owned.enabled === true) {
        closeErrors.push(`${entry.username}: enabled fixture generation precedes its prepared activation`);
      }
      continue;
    }
    if (currentGeneration > entry.generation && entry.state === "CLOSED") {
      continue;
    }
    try {
      await manageRegressionRequestFence(
        targetApiBase,
        entry,
        "CLOSE_AND_DRAIN",
        controlCapability
      );
    } catch (error) {
      let hardDisableError = "";
      try {
        const hardDisabled = hardDisableFixtureIdentity(entry);
        if (!hardDisabled.exists
          || hardDisabled.metadataMatches !== true
          || hardDisabled.ownershipMatches !== true) {
          hardDisableError = "owned fixture could not be hard-disabled";
        } else {
          for (const candidate of ledger.entries) {
            if (candidate.username === entry.username
              && candidate.userId === entry.userId
              && candidate.state === "PREPARED") {
              if (writer) appendRegressionFixtureState(writer, candidate.registrationId, "HARD_DISABLED");
              candidate.state = "HARD_DISABLED";
            }
          }
        }
      } catch (hardDisableFailure) {
        hardDisableError = hardDisableFailure instanceof Error ? hardDisableFailure.message : String(hardDisableFailure);
      }
      closeErrors.push([
        `${entry.username}: ${error instanceof Error ? error.message : String(error)}`,
        hardDisableError
      ].filter(Boolean).join("; "));
    }
  }
  if (closeErrors.length > 0) {
    const error = new Error(`regression auxiliary fixture drain failed: ${sortedUnique(closeErrors).join("; ")}`);
    error.cleanup = {
      closed: false,
      runtimeAccessCleaned: false,
      ledgerFile: reference.file,
      registeredCount: ledger.entries.length
    };
    throw error;
  }

  const results = [];
  for (const entry of distinctEntries) {
    const result = recoverIsolatedAdminSessionFixture({
      username: entry.username,
      userId: entry.userId,
      displayName: entry.displayName,
      retainQuarantinedIdentity: entry.retainQuarantinedIdentity,
      allowIdentityNeverCreated: true
    });
    assert(result.closed === true, "regression auxiliary fixture recovery did not close");
    results.push({
      registrationId: entry.registrationId,
      username: entry.username,
      userId: entry.userId,
      generation: entry.generation,
      ...result
    });
    for (const candidate of ledger.entries) {
      if (candidate.username === entry.username
        && candidate.userId === entry.userId
        && candidate.state === "PREPARED") {
        if (writer) appendRegressionFixtureState(writer, candidate.registrationId, "CLOSED");
        candidate.state = "CLOSED";
      }
    }
  }
  return {
    closed: true,
    registeredCount: ledger.entries.length,
    identityCount: distinctEntries.length,
    results
  };
}

export function createIsolatedAdminSessionFixture(apiBase, options = {}) {
  apiBase = canonicalOrigin(apiBase, "isolated regression fixture API target");
  if (readRuntimeCredentials() && apiBase !== mainApiBase) {
    throw new Error("isolated regression fixture refuses a non-main origin while suite credentials are active");
  }
  const label = String(options.label || "suite").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 18) || "suite";
  const accountSetCodes = sortedUnique(options.accountSetCodes?.length ? options.accountSetCodes : ["BLD-TEST"]);
  const defaultAccountSetCode = options.defaultAccountSetCode || accountSetCodes[0];
  assert(accountSetCodes.includes(defaultAccountSetCode), "isolated regression default account set must be granted");
  const route = verifyFixtureRoute(accountSetCodes);
  const defaultAccountSet = route.accountSets.find((row) => row.code === defaultAccountSetCode);
  const username = String(options.username || `r_${label}_${randomBytes(8).toString("hex")}`).slice(0, 80);
  assert(/^r_[a-z0-9_]{1,58}_[0-9a-f]{12,32}$/.test(username), "isolated regression username is outside the owned namespace");
  const password = `R!${randomBytes(18).toString("base64url")}a1`;
  const displayName = String(options.displayName || `隔离回归管理员 ${label}`).slice(0, 120);
  const runtimeCredentials = readRuntimeCredentials();
  const fixtureLedgerWriter = options.fixtureLedgerWriter || cachedRuntimeFixtureLedgerWriter;
  const fixtureLedgerRunId = String(options.fixtureLedgerRunId || runtimeCredentials?.runId || "");
  const requestFenceControlToken = String(
    options.requestFenceControlToken || runtimeCredentials?.requestFenceControlToken || ""
  );
  const autoManageRequestFence = options.autoManageRequestFence === true
    || (options.autoManageRequestFence !== false && Boolean(runtimeCredentials));
  assert(Boolean(fixtureLedgerWriter) === Boolean(fixtureLedgerRunId),
    "isolated regression fixture ledger metadata is incomplete");
  assert(!autoManageRequestFence || /^[0-9a-f]{32}$/.test(requestFenceControlToken),
    "isolated regression request fence control capability is incomplete");
  let userId = "";
  let requestFenceGeneration = -1;
  let fixtureRegistrationId = "";
  const sensitiveValues = new Set([password]);
  reportSensitiveValue(password);
  try {
    const ownedBeforeAdoption = options.adoptLegacySuiteTombstone === true
      ? null
      : resolveFixtureIdentity({
          username,
          displayName,
          requireTombstone: options.reuseQuarantinedIdentity === true
        });
    const legacyCandidate = options.adoptLegacySuiteTombstone === true
      ? dbJson(`
          SELECT jsonb_build_object(
            'userId', id::text,
            'sessionGeneration', session_generation
          )::text
          FROM public.sys_user
          WHERE username=${sqlLiteral(username)}
        `, "legacy regression tombstone reservation lookup")
      : null;
    userId = String(ownedBeforeAdoption?.userId || legacyCandidate?.userId || randomUUID());
    const previousGeneration = Number(ownedBeforeAdoption?.sessionGeneration ?? legacyCandidate?.sessionGeneration ?? -1);
    requestFenceGeneration = previousGeneration >= 0 ? previousGeneration + 1 : 0;
    assert(uuidPattern.test(userId), "isolated regression fixture reservation requires a valid user id");
    fixtureRegistrationId = fixtureLedgerWriter ? appendRegressionFixturePrepared(fixtureLedgerWriter, {
      registrationId: randomBytes(16).toString("hex"),
      username,
      userId,
      displayName,
      generation: requestFenceGeneration,
      retainQuarantinedIdentity: options.retainQuarantinedIdentity === true,
    }) : "";
    if (options.adoptLegacySuiteTombstone === true) {
      adoptLegacySuiteTombstone({ username, displayName });
    }
    const existing = resolveFixtureIdentity({
      username,
      displayName,
      requireTombstone: options.reuseQuarantinedIdentity === true
    });
    assert(!existing || existing.userId === userId,
      "isolated regression fixture reservation does not match the owned identity");
    if (existing) {
      assert(options.reuseQuarantinedIdentity === true, "isolated regression username collision");
      // The preflight fixture closes a Redis-backed session immediately before
      // the suite reopens this retained tombstone. Redis/session invalidation
      // can become visible a short moment after the SQL tombstone transition;
      // retry only the exact read-only closed-state observation and never
      // weaken any of its zero-residue requirements.
      let state = null;
      let redis = null;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        state = fixtureIdentityState({ username, userId: existing.userId });
        redis = redisOwnedByUsername(username);
        const closed = Number(state?.userCount) === 1
          && Number(state?.enabledCount) === 0
          && Number(state?.activeSessionCount) === 0
          && Number(state?.roleCount) === 0
          && Number(state?.grantCount) === 0
          && Number(state?.scopeCount) === 0
          && redis.primaryHashes.length === 0
          && redis.keys.length === 0
          && redis.members.length === 0;
        if (closed || attempt === 9) break;
        synchronousPause(250);
      }
      const closedState = {
        userCount: Number(state?.userCount),
        enabledCount: Number(state?.enabledCount),
        activeSessionCount: Number(state?.activeSessionCount),
        roleCount: Number(state?.roleCount),
        grantCount: Number(state?.grantCount),
        scopeCount: Number(state?.scopeCount),
        redisPrimaryHashCount: redis.primaryHashes.length,
        redisKeyCount: redis.keys.length,
        redisMemberCount: redis.members.length
      };
      assert(closedState.userCount === 1
        && closedState.enabledCount === 0
        && closedState.activeSessionCount === 0
        && closedState.roleCount === 0
        && closedState.grantCount === 0
        && closedState.scopeCount === 0
        && closedState.redisPrimaryHashCount === 0
        && closedState.redisKeyCount === 0
        && closedState.redisMemberCount === 0,
      `isolated regression reusable identity is not in a closed quarantine state: ${JSON.stringify(closedState)}`);
    }
    const created = dbJson(existing ? `
      WITH created_user AS (
        UPDATE public.sys_user
        SET password_hash=${sqlLiteral(`{noop}${password}`)},
            enabled=TRUE,
            failed_login_count=0,
            locked_until=NULL,
            active_session_token=NULL,
            active_session_started_at=NULL,
            default_account_set_id=${sqlLiteral(defaultAccountSet.id)}::uuid,
            session_generation=session_generation + 1,
            created_by=id,
            updated_by=id,
            updated_at=now(),
            version=version + 1
        WHERE id=${sqlLiteral(existing.userId)}::uuid
          AND username=${sqlLiteral(username)}
          AND display_name=${sqlLiteral(displayName)}
          AND enabled=FALSE
        RETURNING id, session_generation
      ), created_role AS (
        INSERT INTO public.sys_user_role (user_id, role_id)
        SELECT id, ${sqlLiteral(route.roleId)}::uuid FROM created_user
        RETURNING user_id
      ), created_grants AS (
        INSERT INTO public.sys_user_account_set (user_id, account_set_id, role_code, is_default, enabled)
        SELECT created_user.id, account_set.id, 'ADMIN', account_set.code=${sqlLiteral(defaultAccountSetCode)}, TRUE
        FROM created_user
        CROSS JOIN public.sys_account_set account_set
        WHERE account_set.code=ANY(${sqlTextArray(accountSetCodes)})
        RETURNING user_id
      )
      SELECT jsonb_build_object(
        'userId', created_user.id::text,
        'sessionGeneration', created_user.session_generation,
        'roleLinks', (SELECT count(*) FROM created_role),
        'grants', (SELECT count(*) FROM created_grants)
      )::text
      FROM created_user
    ` : `
      WITH created_user AS (
        INSERT INTO public.sys_user (
          id, username, display_name, password_hash, enabled, default_account_set_id, created_by, updated_by
        )
        VALUES (
          ${sqlLiteral(userId)}::uuid, ${sqlLiteral(username)}, ${sqlLiteral(displayName)}, ${sqlLiteral(`{noop}${password}`)}, TRUE,
          ${sqlLiteral(defaultAccountSet.id)}::uuid, ${sqlLiteral(userId)}::uuid, ${sqlLiteral(userId)}::uuid
        )
        RETURNING id, session_generation
      ), created_role AS (
        INSERT INTO public.sys_user_role (user_id, role_id)
        SELECT id, ${sqlLiteral(route.roleId)}::uuid FROM created_user
        RETURNING user_id
      ), created_grants AS (
        INSERT INTO public.sys_user_account_set (user_id, account_set_id, role_code, is_default, enabled)
        SELECT created_user.id, account_set.id, 'ADMIN', account_set.code=${sqlLiteral(defaultAccountSetCode)}, TRUE
        FROM created_user
        CROSS JOIN public.sys_account_set account_set
        WHERE account_set.code=ANY(${sqlTextArray(accountSetCodes)})
        RETURNING user_id
      )
      SELECT jsonb_build_object(
        'userId', created_user.id::text,
        'sessionGeneration', created_user.session_generation,
        'roleLinks', (SELECT count(*) FROM created_role),
        'grants', (SELECT count(*) FROM created_grants)
      )::text
      FROM created_user
    `, existing ? "isolated regression identity reuse" : "isolated regression identity creation");
    assert(String(created?.userId ?? "") === userId
      && Number(created?.sessionGeneration) === requestFenceGeneration
      && Number(created?.roleLinks) === 1
      && Number(created?.grants) === accountSetCodes.length,
      "isolated regression identity creation returned an incomplete closure");
  } catch (error) {
    try {
      const recovery = recoverIsolatedAdminSessionFixture({
        username,
        userId,
        displayName,
        retainQuarantinedIdentity: options.retainQuarantinedIdentity === true,
        allowIdentityNeverCreated: true
      });
      if (recovery.closed) {
        if (fixtureLedgerWriter && fixtureRegistrationId) {
          appendRegressionFixtureState(fixtureLedgerWriter, fixtureRegistrationId, "CLOSED");
        }
      }
    } catch {
      throw new Error("isolated regression identity creation failed and emergency cleanup could not be verified");
    }
    throw new Error(`isolated regression identity creation failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const cookies = new Set();
  const releasedCookies = new Set();
  let cleaned = false;
  let requestFenceOpened = false;
  let requestFenceClosed = false;
  let cleanupFaultPending = Boolean(options.testOnlyCleanupFault);

  function accountSet(accountSetCode) {
    const row = route.accountSets.find((item) => item.code === accountSetCode);
    if (!row) throw new Error("isolated regression identity was not granted the requested account set");
    return row;
  }

  function trackCookie(cookie) {
    const parsed = parseSessionCookie(cookie);
    reportSensitiveCookie(cookie);
    cookies.add(cookie);
    sensitiveValues.add(cookie);
    sensitiveValues.add(parsed.value);
    for (const candidate of decodedCookieCandidates(parsed.value)) sensitiveValues.add(candidate);
  }

  async function login(accountSetCode = defaultAccountSetCode) {
    await ensureRequestFenceOpen();
    const expectedAccountSet = accountSet(accountSetCode);
    const cookie = await loginApi(apiBase, username, password, accountSetCode);
    trackCookie(cookie);
    const response = await nativeFetch(`${apiBase}/api/system/session`, {
      headers: { Cookie: cookie },
      signal: AbortSignal.timeout(10000)
    });
    const text = await response.text();
    let session;
    try {
      session = text ? JSON.parse(text) : {};
    } catch {
      throw new Error("isolated regression session returned invalid JSON");
    }
    if (!response.ok || !sessionMatches(session, {
      username,
      expectedRole: "系统管理员",
      roleCode: "ADMIN",
      accountSetCode,
      schemaName: expectedAccountSet.schemaName
    })) {
      throw new Error(`isolated regression session boundary mismatch: ${JSON.stringify({
        status: response.status,
        authenticated: session?.authenticated,
        roleCode: session?.user?.roleCode,
        accountSetCode: session?.tenant?.code,
        schemaName: session?.tenant?.schemaName
      })}`);
    }
    return cookie;
  }

  async function openRequestFence() {
    assert(!cleaned, "isolated regression request fence cannot reopen a cleaned identity");
    if (requestFenceOpened && !requestFenceClosed) {
      return { state: "OPEN", activeCount: 0 };
    }
    const snapshot = await manageRegressionRequestFence(
      apiBase,
      { username, userId, generation: requestFenceGeneration },
      "OPEN",
      requestFenceControlToken
    );
    requestFenceOpened = true;
    requestFenceClosed = false;
    return snapshot;
  }

  async function ensureRequestFenceOpen() {
    if (!autoManageRequestFence || requestFenceOpened) return;
    await openRequestFence();
  }

  async function closeAndDrainRequestFence() {
    if (!requestFenceOpened || requestFenceClosed) {
      return { state: requestFenceClosed ? "CLOSED" : "UNMANAGED", activeCount: 0 };
    }
    const snapshot = await manageRegressionRequestFence(
      apiBase,
      { username, userId, generation: requestFenceGeneration },
      "CLOSE_AND_DRAIN",
      requestFenceControlToken
    );
    requestFenceClosed = true;
    return snapshot;
  }

  async function installInBrowser(context, accountSetCode = defaultAccountSetCode) {
    await ensureRequestFenceOpen();
    return installApiSessionInBrowser(context, apiBase, username, password, accountSetCode, { onSessionCookie: trackCookie });
  }

  async function installForApi(accountSetCode = defaultAccountSetCode) {
    await ensureRequestFenceOpen();
    accountSet(accountSetCode);
    return installApiSession(apiBase, username, password, accountSetCode, { onSessionCookie: trackCookie });
  }

  async function logout(cookie) {
    if (!cookie || releasedCookies.has(cookie)) return;
    let snapshot = null;
    try {
      snapshot = captureRedisSessionForCookie(cookie, username);
    } catch (error) {
      if (error?.code !== "REGRESSION_REDIS_SESSION_NOT_FOUND") throw error;
    }
    await logoutApiSession(apiBase, cookie);
    if (snapshot) {
      const released = verifyRedisSessionReleased(snapshot);
      if (released.total !== 0) throw new Error("isolated regression logout left Redis session residue");
    }
    releasedCookies.add(cookie);
  }

  async function confirmReleased(cookie, snapshot) {
    if (!cookie || releasedCookies.has(cookie)) return;
    assert(cookies.has(cookie), "isolated regression release confirmation requires a tracked cookie");
    const response = await nativeFetch(`${apiBase}/api/system/session`, {
      headers: { Cookie: cookie },
      signal: AbortSignal.timeout(10000)
    });
    const text = await response.text();
    let session;
    try {
      session = text ? JSON.parse(text) : {};
    } catch {
      throw new Error("isolated regression release probe returned invalid JSON");
    }
    if (!response.ok || session?.authenticated === true) {
      throw new Error(`isolated regression release probe remained authenticated status=${response.status}`);
    }
    const released = verifyRedisSessionReleased(snapshot);
    if (released.total !== 0) throw new Error("isolated regression release confirmation found Redis residue");
    releasedCookies.add(cookie);
  }

  async function cleanup(cleanupOptions = {}) {
    if (cleaned) return { mode: "run-unique-admin", cleaned: true, retainedDisabled: false };
    const errors = [];
    if (requestFenceOpened && !requestFenceClosed) {
      try {
        await closeAndDrainRequestFence();
      } catch (error) {
        const fenceError = error instanceof Error ? error.message : String(error);
        let hardDisabled = false;
        let hardDisableError = "";
        try {
          const quarantine = hardDisableFixtureIdentity({ username, userId, displayName });
          const state = fixtureIdentityState({ username, userId });
          hardDisabled = quarantine.exists
            && quarantine.metadataMatches === true
            && quarantine.ownershipMatches === true
            && Number(state?.userCount) === 1
            && Number(state?.enabledCount) === 0
            && Number(state?.activeSessionCount) === 0
            && Number(state?.ownedTombstoneCount) === 1;
          if (!hardDisabled) hardDisableError = "request-fence failure hard-disable did not close runtime authentication";
          else if (fixtureLedgerWriter && fixtureRegistrationId) {
            appendRegressionFixtureState(fixtureLedgerWriter, fixtureRegistrationId, "HARD_DISABLED");
          }
        } catch (quarantineFailure) {
          hardDisableError = quarantineFailure instanceof Error ? quarantineFailure.message : String(quarantineFailure);
        }
        const failure = new Error(sortedUnique([
          fenceError,
          hardDisableError
        ].filter(Boolean)).join("; "));
        failure.cleanup = {
          mode: options.retainQuarantinedIdentity === true ? "suite-tombstone-admin" : "run-unique-admin",
          cleaned: false,
          runtimeAccessCleaned: false,
          closed: false,
          principalDeleted: false,
          retainedDisabled: hardDisabled,
          hardDisabled,
          reusableTombstone: false,
          requestFenceClosed: false,
          forcedRedisSessionCount: 0,
          operationLogSchemaCount: 0
        };
        throw failure;
      }
    }
    if (!requestFenceOpened) {
      for (const cookie of cookies) {
        if (releasedCookies.has(cookie)) continue;
        try {
          await logout(cookie);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    let faults = {};
    if (cleanupFaultPending) {
      assert(process.env.JDY_REGRESSION_ALLOW_CLEANUP_FAULTS === "1",
        "isolated regression cleanup fault injection requires an explicit test marker");
      faults = {
        operationLog: options.testOnlyCleanupFault === "operation-log",
        redis: options.testOnlyCleanupFault === "redis",
        identityDelete: options.testOnlyCleanupFault === "identity-delete",
        quarantine: options.testOnlyCleanupFault === "quarantine"
      };
      cleanupFaultPending = false;
    }
    const result = cleanupFixtureClosure({
      username,
      userId,
      displayName,
      allowForcedRedisRelease: cleanupOptions.allowForcedRedisRelease === true || options.allowForcedRedisRelease === true,
      retainQuarantinedIdentity: options.retainQuarantinedIdentity === true,
      initialErrors: errors,
      faults,
      sensitiveValues
    });
    cleaned = result.closed;
    if (result.closed) {
      if (fixtureLedgerWriter && fixtureRegistrationId) {
        appendRegressionFixtureState(fixtureLedgerWriter, fixtureRegistrationId, "CLOSED");
      }
    }
    return result;
  }

  return {
    username,
    password,
    userId,
    requestFenceGeneration,
    defaultAccountSetCode,
    accountSets: route.accountSets.map(({ code, schemaName }) => ({ code, schemaName })),
    trackCookie,
    login,
    installInBrowser,
    installForApi,
    logout,
    confirmReleased,
    sensitiveArtifactValues: () => [...sensitiveValues],
    openRequestFence,
    closeAndDrainRequestFence,
    cleanup
  };
}
