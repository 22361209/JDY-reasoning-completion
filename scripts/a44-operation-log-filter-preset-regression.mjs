import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const normalResultPath = path.join(verificationDir, "a44-operation-log-filter-preset-regression.json");
const faultResultPath = path.join(verificationDir, "a44-operation-log-filter-preset-fault.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const listKey = "operation-log-list";
const failurePoint = String(process.env.A44_FAIL_AT ?? "").trim();
const runId = `A44-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomBytes(6).toString("hex")}`;
const presetName = `${runId}-筛选预设`;
const keyword = `${runId}-NO-BUSINESS-WRITE`;
const logDate = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
const expectedQuery = {
  keyword,
  module: "SALES",
  action: "RED_REVERSE",
  operator: "本地管理员",
  targetType: "sales_out",
  actorType: "",
  scope: "current",
  dateFrom: logDate,
  dateTo: logDate
};
const expectedColumnFilters = {
  status: { operator: "等于", value: "成功" }
};
const expectedListSearch = {
  keyword,
  page: "1",
  pageSize: "200",
  view: "header",
  module: "SALES",
  action: "RED_REVERSE",
  operator: "本地管理员",
  targetType: "sales_out",
  scope: "current",
  dateFrom: logDate,
  dateTo: logDate
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

await mkdir(screenshotDir, { recursive: true });

const evidence = {
  taskId: "A44",
  runId,
  generatedAt: new Date().toISOString(),
  status: "RUNNING",
  ok: false,
  faultInjection: failurePoint || null,
  fixture: {
    presetName,
    keyword,
    allowedMutationRequests: 0,
    businessWrites: 0,
    inventoryAdjustmentRequests: 0
  },
  checks: [],
  requests: {
    presetLoad: null,
    presetSave: null,
    presetReload: null,
    appliedListQuery: null
  },
  preset: {
    idHash: "",
    persisted: false,
    applied: false
  },
  screenshots: [],
  cleanup: {
    attempted: false,
    presetRemaining: null,
    localStorageCleared: false,
    capturedSessionAuthenticatedAfterRelease: null,
    sessionAuthenticatedAfterLogout: null,
    redisCapturedKeys: 0,
    redisCapturedMembers: 0,
    redisRemaining: null,
    cleanupRedisCapturedKeys: 0,
    cleanupRedisCapturedMembers: 0,
    cleanupRedisRemaining: null,
    unexpectedScreenshotRemaining: null,
    browserClosed: false,
    errors: []
  },
  failure: null
};

let browser = null;
let page = null;
let sessionCookie = null;
let sessionCookieHeader = "";
let redisAtLogin = { keys: [], members: [] };
let cleanupSessionCookie = null;
let cleanupSessionCookieHeader = "";
let cleanupRedisAtLogin = { keys: [], members: [] };
let presetId = "";
let saveDispatched = false;
let saveResponseObserved = false;
let screenshotAbsolutePath = "";
let primaryError = null;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  evidence.checks.push(message);
}

function recordApiRequest(method, pathname) {
  const normalizedMethod = String(method).toUpperCase();
  if (pathname === "/api/inventory/adjustments") {
    evidence.fixture.inventoryAdjustmentRequests += 1;
  }
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(normalizedMethod)) return;
  const allowedMutation = (normalizedMethod === "POST" && pathname === "/api/system/login")
    || (normalizedMethod === "POST" && pathname === "/api/system/logout")
    || (normalizedMethod === "POST" && pathname === `/api/list-presets/${listKey}`)
    || (normalizedMethod === "DELETE"
      && uuidPattern.test(presetId)
      && pathname === `/api/list-presets/${listKey}/${presetId}`);
  if (allowedMutation) {
    evidence.fixture.allowedMutationRequests += 1;
    return;
  }
  evidence.fixture.businessWrites += 1;
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeObject(value) {
  if (Array.isArray(value)) return value.map(normalizeObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, normalizeObject(item)])
  );
}

function sameObject(left, right) {
  return same(normalizeObject(left), normalizeObject(right));
}

function redisCommand(...args) {
  try {
    return execFileSync(
      "docker",
      ["exec", "jdy-erp-redis", "redis-cli", "-n", "0", "--raw", ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    ).trim();
  } catch {
    throw new Error(`A44 Redis command failed: ${String(args[0] ?? "UNKNOWN").toUpperCase()}`);
  }
}

function redisScan(pattern) {
  const raw = redisCommand("--scan", "--pattern", pattern);
  return raw ? [...new Set(raw.split(/\r?\n/).filter(Boolean))].sort() : [];
}

function decodeSessionMarker(value, encoding) {
  try {
    const decoded = Buffer.from(value, encoding).toString("utf8");
    return /^[0-9a-f-]{32,36}$/i.test(decoded) ? decoded : "";
  } catch {
    return "";
  }
}

function sessionMarkers(cookie) {
  const markers = [cookie.value];
  if (cookie.name === "SESSION") {
    markers.push(decodeSessionMarker(cookie.value, "base64"), decodeSessionMarker(cookie.value, "base64url"));
  }
  return [...new Set(markers.filter(Boolean))];
}

function redisSessionSnapshot(cookie) {
  const markers = sessionMarkers(cookie);
  const keys = [];
  for (const key of redisScan("spring:session:sessions:*")) {
    if (/^spring:session:sessions:expires:/.test(key)) continue;
    const sessionId = key.slice("spring:session:sessions:".length);
    if (!markers.some((marker) => sessionId === marker || key.endsWith(marker))) continue;
    assert(redisCommand("TYPE", key) === "hash", "A44 captured Redis session key must be a hash");
    const payload = redisCommand("HGETALL", key);
    assert(payload.includes("admin"), "A44 captured Redis session must bind the admin login");
    keys.push(key);
    const expiresKey = `spring:session:sessions:expires:${sessionId}`;
    if (redisCommand("EXISTS", expiresKey) === "1") keys.push(expiresKey);
  }
  const sessionIds = keys
    .map((key) => key.match(/^spring:session:sessions:(?!expires:)(.+)$/)?.[1] ?? "")
    .filter(Boolean);
  const members = [];
  for (const key of redisScan("spring:session:expirations:*")) {
    for (const member of redisCommand("SMEMBERS", key).split(/\r?\n/).filter(Boolean)) {
      if (sessionIds.some((sessionId) => member.includes(sessionId))) members.push({ key, member });
    }
  }
  return {
    keys: [...new Set(keys)].sort(),
    members: members.sort((left, right) => `${left.key}:${left.member}`.localeCompare(`${right.key}:${right.member}`))
  };
}

function verifyRedisReleased(snapshot) {
  const remainingKeys = snapshot.keys.filter((key) => redisCommand("EXISTS", key) !== "0");
  const remainingMembers = snapshot.members.filter(({ key, member }) => redisCommand("SISMEMBER", key, member) !== "0");
  return { remainingKeys, remainingMembers, total: remainingKeys.length + remainingMembers.length };
}

async function responseJson(response, label) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} must return JSON status=${response.status()}`);
  }
}

function isApiResponse(response, pathname, method = "GET") {
  const url = new URL(response.url());
  return url.pathname === pathname && response.request().method() === method;
}

async function waitForOperationLogEntry(pageInstance, trigger) {
  const presetPromise = pageInstance.waitForResponse((response) =>
    isApiResponse(response, `/api/list-presets/${listKey}`) && response.status() === 200
  );
  const listPromise = pageInstance.waitForResponse((response) =>
    isApiResponse(response, `/api/lists/${listKey}`) && response.status() === 200
  );
  await trigger();
  const [presetResponse, listResponse] = await Promise.all([presetPromise, listPromise]);
  const presets = await responseJson(presetResponse, "A44 preset load");
  assert(Array.isArray(presets), "A44 preset load must return an array");
  await pageInstance.getByTestId(`tab-${listKey}`).waitFor({ state: "visible" });
  await pageInstance.waitForFunction(() =>
    Boolean(document.querySelector('[data-testid="operation-log-preset-select"]'))
  );
  await pageInstance.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return { presets, listStatus: listResponse.status() };
}

async function ensureOperationLogFilters(pageInstance) {
  const moduleFilter = pageInstance.getByTestId("operation-log-module");
  if (await moduleFilter.isVisible({ timeout: 500 }).catch(() => false)) return;
  await pageInstance.getByTestId("list-toggle-filter").click();
  await moduleFilter.waitFor({ state: "visible" });
}

async function captureSessionCookie() {
  const cookies = await page.context().cookies(apiBase);
  const matches = cookies.filter((cookie) => ["SESSION", "JSESSIONID"].includes(cookie.name));
  assert(matches.length === 1, "A44 browser login must create exactly one session cookie");
  sessionCookie = { name: matches[0].name, value: matches[0].value };
  sessionCookieHeader = `${sessionCookie.name}=${sessionCookie.value}`;
  redisAtLogin = redisSessionSnapshot(sessionCookie);
  evidence.cleanup.redisCapturedKeys = redisAtLogin.keys.length;
  evidence.cleanup.redisCapturedMembers = redisAtLogin.members.length;
}

async function cookieRequest(cookieHeader, pathname, options = {}) {
  recordApiRequest(options.method ?? "GET", pathname);
  const headers = new Headers(options.headers);
  headers.set("Cookie", cookieHeader);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(10_000)
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { invalidJson: true };
  }
  return { status: response.status, ok: response.ok, data };
}

async function capturedSessionRequest(pathname, options = {}) {
  return cookieRequest(sessionCookieHeader, pathname, options);
}

async function cleanupSessionRequest(pathname, options = {}) {
  return cookieRequest(cleanupSessionCookieHeader, pathname, options);
}

async function openCleanupSession() {
  if (cleanupSessionCookieHeader) return;
  recordApiRequest("POST", "/api/system/login");
  const response = await fetch(`${apiBase}/api/system/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123", accountSetCode: "BLD-TEST" }),
    signal: AbortSignal.timeout(10_000)
  });
  const text = await response.text();
  assert(response.ok, `A44 cleanup login must succeed status=${response.status}: ${text}`);
  const setCookie = response.headers.get("set-cookie") ?? "";
  cleanupSessionCookieHeader = setCookie.split(";")[0];
  const separator = cleanupSessionCookieHeader.indexOf("=");
  assert(separator > 0, "A44 cleanup login must return one valid session cookie");
  cleanupSessionCookie = {
    name: cleanupSessionCookieHeader.slice(0, separator),
    value: cleanupSessionCookieHeader.slice(separator + 1)
  };
  cleanupRedisAtLogin = redisSessionSnapshot(cleanupSessionCookie);
  evidence.cleanup.cleanupRedisCapturedKeys = cleanupRedisAtLogin.keys.length;
  evidence.cleanup.cleanupRedisCapturedMembers = cleanupRedisAtLogin.members.length;
  const session = await cleanupSessionRequest("/api/system/session");
  assert(
    session.status === 200
      && session.data?.authenticated === true
      && session.data?.user?.username === "admin"
      && session.data?.user?.roleCode === "ADMIN"
      && session.data?.tenant?.code === "BLD-TEST"
      && session.data?.tenant?.schemaName === "public",
    `A44 cleanup session must bind ADMIN in BLD-TEST/public: ${JSON.stringify(session)}`
  );
}

function assertPresetPayload(preset, label) {
  assert(preset?.name === presetName, `${label} must bind the exact preset name`);
  assert(preset?.roleCode === "ADMIN" && preset?.userName === "admin", `${label} must bind the exact current-user scope`);
  assert(preset?.shared === true && preset?.isDefault === false, `${label} must bind the shared non-default contract`);
  assert(preset?.readOnly === false, `${label} must remain writable`);
  assert(sameObject(preset?.query, expectedQuery), `${label} must bind the exact query snapshot`);
  assert(sameObject(preset?.columnFilters, expectedColumnFilters), `${label} must bind the exact column-filter snapshot`);
}

async function reconcileAndDeletePreset() {
  if (!saveDispatched) {
    evidence.cleanup.presetRemaining = 0;
    return;
  }
  await openCleanupSession();
  const before = await cleanupSessionRequest(`/api/list-presets/${listKey}`);
  assert(before.ok && Array.isArray(before.data), `A44 cleanup must read visible presets with a fresh session: ${JSON.stringify(before)}`);
  const matches = before.data.filter((preset) => preset.name === presetName);
  if (matches.length === 0) {
    assert(!saveResponseObserved, "A44 observed a successful save response but could not find its exact preset during cleanup");
    evidence.cleanup.presetRemaining = 0;
    return;
  }
  assert(matches.length === 1, "A44 cleanup refuses ambiguous same-name presets");
  const [match] = matches;
  assertPresetPayload(match, "A44 cleanup reconciliation");
  if (presetId) assert(match.id === presetId, "A44 cleanup preset UUID must match the captured save response");
  presetId = String(match.id ?? "");
  assert(uuidPattern.test(presetId), "A44 cleanup requires one exact preset UUID");
  const deleted = await cleanupSessionRequest(`/api/list-presets/${listKey}/${encodeURIComponent(presetId)}`, { method: "DELETE" });
  assert(deleted.ok && deleted.data?.deleted === 1, "A44 cleanup must delete exactly one captured preset row");
  const after = await cleanupSessionRequest(`/api/list-presets/${listKey}`);
  assert(after.ok && Array.isArray(after.data), "A44 cleanup must verify the final preset list");
  evidence.cleanup.presetRemaining = after.data.filter((preset) => preset.name === presetName || preset.id === presetId).length;
  assert(evidence.cleanup.presetRemaining === 0, "A44 preset residue must be zero");
}

async function releaseCapturedSession() {
  if (!sessionCookieHeader) {
    evidence.cleanup.capturedSessionAuthenticatedAfterRelease = false;
    evidence.cleanup.redisRemaining = 0;
    return;
  }
  if (!cleanupSessionCookieHeader) {
    const logout = await capturedSessionRequest("/api/system/logout", { method: "POST" });
    assert(logout.ok, "A44 captured browser session logout must succeed when no cleanup replacement exists");
  }
  const session = await capturedSessionRequest("/api/system/session");
  assert(session.status === 200, "A44 old session probe must return the public session envelope");
  evidence.cleanup.capturedSessionAuthenticatedAfterRelease = Boolean(session.data?.authenticated);
  assert(evidence.cleanup.capturedSessionAuthenticatedAfterRelease === false, "A44 captured browser session must be unauthenticated after release or replacement");
  const redisAfter = verifyRedisReleased(redisAtLogin);
  evidence.cleanup.redisRemaining = redisAfter.total;
  assert(redisAfter.total === 0, "A44 captured Redis session keys and expiration members must be released");
}

async function logoutCleanupSession() {
  if (!cleanupSessionCookieHeader) {
    evidence.cleanup.sessionAuthenticatedAfterLogout = false;
    evidence.cleanup.cleanupRedisRemaining = 0;
    return;
  }
  const logout = await cleanupSessionRequest("/api/system/logout", { method: "POST" });
  assert(logout.ok, "A44 fresh cleanup session logout must succeed");
  const session = await cleanupSessionRequest("/api/system/session");
  assert(session.status === 200, "A44 cleanup session probe must return the public session envelope");
  evidence.cleanup.sessionAuthenticatedAfterLogout = Boolean(session.data?.authenticated);
  assert(evidence.cleanup.sessionAuthenticatedAfterLogout === false, "A44 cleanup session must be unauthenticated after logout");
  const redisAfter = verifyRedisReleased(cleanupRedisAtLogin);
  evidence.cleanup.cleanupRedisRemaining = redisAfter.total;
  assert(redisAfter.total === 0, "A44 cleanup Redis session keys and expiration members must be released");
}

async function clearLocalStorage() {
  if (!page || page.isClosed()) {
    evidence.cleanup.localStorageCleared = true;
    return;
  }
  await page.evaluate(() => localStorage.removeItem("jdy:operation-log-filter-presets"));
  evidence.cleanup.localStorageCleared = await page.evaluate(() => localStorage.getItem("jdy:operation-log-filter-presets") === null);
  assert(evidence.cleanup.localStorageCleared, "A44 operation-log preset localStorage must be cleared");
}

async function runAcceptance() {
  assert(["", "after-preset-save"].includes(failurePoint), "A44_FAIL_AT only supports after-preset-save");
  const health = await fetch(`${apiBase}/api/system/health`, { signal: AbortSignal.timeout(5_000) });
  const healthBody = await health.json();
  assert(health.ok && healthBody?.status === "UP", "A44 requires the current backend health endpoint");
  assert(typeof healthBody?.testInventoryAdjustmentApi === "boolean", "A44 health must expose the inventory-adjustment boundary state");

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) recordApiRequest(request.method(), url.pathname);
  });
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await captureSessionCookie();
  await page.evaluate(() => localStorage.removeItem("jdy:operation-log-filter-presets"));

  const initial = await waitForOperationLogEntry(page, async () => {
    await page.getByTestId("module-系统设置").hover();
    await page.getByTestId(`query-${listKey}`).click();
  });
  evidence.requests.presetLoad = { status: 200, count: initial.presets.length };
  assert(initial.listStatus === 200, "A44 initial operation-log list request must return 200");
  await ensureOperationLogFilters(page);

  await page.getByTestId("list-keyword").fill(keyword);
  await page.getByTestId("operation-log-module").selectOption(expectedQuery.module);
  await page.getByTestId("operation-log-action").selectOption(expectedQuery.action);
  await page.getByTestId("operation-log-operator").fill(expectedQuery.operator);
  await page.getByTestId("operation-log-target-type").selectOption(expectedQuery.targetType);
  await page.getByTestId("list-date-range").click();
  await page.getByTestId("list-date-from").fill(logDate);
  await page.getByTestId("list-date-to").fill(logDate);
  await page.getByTestId("list-date-range-apply").click();
  await page.getByTestId("column-filter-status").click();
  await page.getByTestId("column-filter-input").fill("成功");
  await page.getByTestId("column-filter-ok").click();
  await page.getByTestId("operation-log-preset-name").fill(presetName);
  assert(await page.getByTestId("list-keyword").inputValue() === keyword, "A44 must retain the run-unique keyword after preset load settles");

  const saveResponsePromise = page.waitForResponse((response) =>
    isApiResponse(response, `/api/list-presets/${listKey}`, "POST")
  );
  saveDispatched = true;
  await page.getByTestId("operation-log-preset-save").click();
  const saveResponse = await saveResponsePromise;
  assert(saveResponse.status() === 200, "A44 UI preset save must return 200");
  const requestPayload = JSON.parse(saveResponse.request().postData() || "{}");
  assert(requestPayload.name === presetName && requestPayload.shared === true && requestPayload.isDefault === false,
    "A44 UI save request must bind the exact name/shared/default contract");
  assert(sameObject(requestPayload.query, expectedQuery), "A44 UI save request must bind the exact settled query snapshot");
  assert(sameObject(requestPayload.columnFilters, expectedColumnFilters), "A44 UI save request must bind the exact column filters");
  const savedPreset = await responseJson(saveResponse, "A44 preset save");
  saveResponseObserved = true;
  assertPresetPayload(savedPreset, "A44 save response");
  presetId = String(savedPreset.id ?? "");
  assert(uuidPattern.test(presetId), "A44 save response must return one exact preset UUID");
  evidence.preset.idHash = sha256(presetId);
  evidence.preset.persisted = true;
  evidence.requests.presetSave = { status: 200, requestQuery: expectedQuery, responseIdHash: evidence.preset.idHash };
  await page.getByTestId("operation-log-preset-message").getByText("预设已保存").waitFor({ state: "visible" });

  if (failurePoint === "after-preset-save") {
    const injected = new Error("A44_FAIL_AT=after-preset-save injected failure");
    injected.code = "A44_EXPECTED_AFTER_PRESET_SAVE";
    throw injected;
  }

  await page.evaluate(() => localStorage.removeItem("jdy:operation-log-filter-presets"));
  await page.reload({ waitUntil: "networkidle" });
  const reloaded = await waitForOperationLogEntry(page, async () => {
    await page.getByTestId("module-系统设置").hover();
    await page.getByTestId(`query-${listKey}`).click();
  });
  const reloadedMatches = reloaded.presets.filter((preset) => preset.id === presetId || preset.name === presetName);
  assert(reloadedMatches.length === 1, "A44 backend reload must return exactly the saved preset");
  assertPresetPayload(reloadedMatches[0], "A44 backend reload");
  evidence.requests.presetReload = { status: 200, matches: 1 };
  await ensureOperationLogFilters(page);
  await page.getByTestId("operation-log-preset-select").selectOption(presetId);

  const filteredListResponsePromise = page.waitForResponse((response) => {
    if (!isApiResponse(response, `/api/lists/${listKey}`) || response.status() !== 200) return false;
    return new URL(response.url()).searchParams.get("keyword") === keyword;
  });
  await page.getByTestId("operation-log-preset-apply").click();
  const filteredListResponse = await filteredListResponsePromise;
  await page.getByTestId("operation-log-preset-message").getByText("预设已应用").waitFor({ state: "visible" });
  await page.waitForFunction((expected) => {
    const value = (testId) => document.querySelector(`[data-testid="${testId}"]`)?.value ?? "";
    return value("list-keyword") === expected.keyword
      && value("operation-log-module") === expected.module
      && value("operation-log-action") === expected.action
      && value("operation-log-operator") === expected.operator
      && value("operation-log-target-type") === expected.targetType;
  }, expectedQuery);
  assert(await page.getByTestId("column-filter-status").evaluate((node) => node.className.includes("active")),
    "A44 applied preset must restore the active status column filter");
  assert((await page.getByTestId("list-active-date-range").innerText()).trim() === `${logDate} 至 ${logDate}`,
    "A44 applied preset must restore the exact date range");

  const appliedUrl = new URL(filteredListResponse.url());
  for (const [key, value] of Object.entries(expectedListSearch)) {
    assert(appliedUrl.searchParams.get(key) === value, `A44 applied list request must bind ${key}`);
  }
  assert(sameObject(JSON.parse(appliedUrl.searchParams.get("columnFilters") || "{}"), expectedColumnFilters),
    "A44 applied list request must bind the exact column filters");
  evidence.requests.appliedListQuery = { status: 200, query: expectedListSearch, columnFilters: expectedColumnFilters };
  evidence.preset.applied = true;

  const screenshotName = `a44-operation-log-filter-preset-${runId}.png`;
  screenshotAbsolutePath = path.join(screenshotDir, screenshotName);
  await page.screenshot({ path: screenshotAbsolutePath, fullPage: true });
  assert(existsSync(screenshotAbsolutePath), "A44 normal acceptance screenshot must exist");
  evidence.screenshots.push(`verification/playwright/${screenshotName}`);
}

try {
  await runAcceptance();
} catch (error) {
  primaryError = error;
  evidence.failure = {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    code: error?.code ?? ""
  };
} finally {
  evidence.cleanup.attempted = true;
  try {
    await reconcileAndDeletePreset();
  } catch (error) {
    evidence.cleanup.errors.push({ label: "preset", error: error instanceof Error ? error.message : String(error) });
  }
  try {
    await clearLocalStorage();
  } catch (error) {
    evidence.cleanup.errors.push({ label: "localStorage", error: error instanceof Error ? error.message : String(error) });
  }
  try {
    await releaseCapturedSession();
  } catch (error) {
    evidence.cleanup.errors.push({ label: "captured session/redis", error: error instanceof Error ? error.message : String(error) });
  }
  try {
    await logoutCleanupSession();
  } catch (error) {
    evidence.cleanup.errors.push({ label: "cleanup session/redis", error: error instanceof Error ? error.message : String(error) });
  }
  try {
    if (browser) await browser.close();
    browser = null;
    evidence.cleanup.browserClosed = true;
  } catch (error) {
    evidence.cleanup.errors.push({ label: "browser", error: error instanceof Error ? error.message : String(error) });
  }
  if (primaryError && screenshotAbsolutePath) {
    try {
      await unlink(screenshotAbsolutePath);
    } catch (error) {
      if (error?.code !== "ENOENT") evidence.cleanup.errors.push({ label: "failed screenshot", error: error.message });
    }
  }
  evidence.cleanup.unexpectedScreenshotRemaining = screenshotAbsolutePath && primaryError && existsSync(screenshotAbsolutePath) ? 1 : 0;
}

const cleanupPassed = evidence.cleanup.errors.length === 0
  && evidence.cleanup.presetRemaining === 0
  && evidence.cleanup.localStorageCleared === true
  && evidence.cleanup.capturedSessionAuthenticatedAfterRelease === false
  && evidence.cleanup.sessionAuthenticatedAfterLogout === false
  && evidence.cleanup.redisRemaining === 0
  && evidence.cleanup.cleanupRedisRemaining === 0
  && evidence.cleanup.unexpectedScreenshotRemaining === 0
  && evidence.cleanup.browserClosed === true;
const expectedFault = failurePoint === "after-preset-save"
  && primaryError?.code === "A44_EXPECTED_AFTER_PRESET_SAVE"
  && saveResponseObserved
  && evidence.fixture.allowedMutationRequests === 5
  && evidence.fixture.businessWrites === 0
  && evidence.fixture.inventoryAdjustmentRequests === 0
  && cleanupPassed;
const normalPassed = !primaryError
  && failurePoint === ""
  && evidence.preset.persisted
  && evidence.preset.applied
  && evidence.fixture.allowedMutationRequests === 5
  && evidence.fixture.businessWrites === 0
  && evidence.fixture.inventoryAdjustmentRequests === 0
  && cleanupPassed;

evidence.status = normalPassed ? "PASS" : expectedFault ? "EXPECTED_FAILURE" : "FAIL";
evidence.ok = normalPassed || expectedFault;
evidence.completedAt = new Date().toISOString();
const resultPath = normalPassed ? normalResultPath : expectedFault ? faultResultPath : path.join(verificationDir, `a44-operation-log-filter-preset-failed-${process.pid}.json`);
await writeFile(resultPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

if (normalPassed) {
  console.log(`A44 operation-log filter preset regression PASS (${evidence.checks.length} assertions, zero business writes, residue=0)`);
  console.log(`evidence: ${path.relative(rootDir, resultPath)}`);
} else if (expectedFault) {
  process.exitCode = 1;
  console.error("A44 fault injection EXPECTED_FAILURE: preset save observed and all owned residue is zero");
  console.error(`evidence: ${path.relative(rootDir, resultPath)}`);
} else {
  process.exitCode = 1;
  console.error(`A44 operation-log filter preset regression FAIL: ${primaryError?.message || evidence.cleanup.errors.map((row) => row.error).join("; ") || "acceptance incomplete"}`);
  console.error(`evidence: ${path.relative(rootDir, resultPath)}`);
}
