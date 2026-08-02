import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const nativeFetch = globalThis.fetch.bind(globalThis);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const redisSessionPrefix = "spring:session:sessions:";
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
        "exec", "-i", process.env.JDY_POSTGRES_CONTAINER || "jdy-erp-postgres",
        "psql", "-X", "-v", "ON_ERROR_STOP=1", "-qAt", "-U", postgresUser, "-d", postgresDatabase
      ],
      { encoding: "utf8", input: sql, stdio: ["pipe", "pipe", "pipe"] }
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

function redisCommand(...args) {
  try {
    return execFileSync(
      "docker",
      [
        "exec", process.env.JDY_REDIS_CONTAINER || "jdy-erp-redis",
        "redis-cli", "-n", process.env.JDY_REDIS_DB || "0", "--raw", ...args
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    ).trim();
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

function redisExpirationMembers(sessionIds) {
  const members = [];
  for (const key of redisScan("spring:session:expirations:*")) {
    for (const member of redisCommand("SMEMBERS", key).split(/\r?\n/).filter(Boolean)) {
      if (sessionIds.some((sessionId) => member.includes(sessionId))) members.push({ key, member });
    }
  }
  return members.sort((left, right) => `${left.key}:${left.member}`.localeCompare(`${right.key}:${right.member}`));
}

function redisOwnedByUsername(username) {
  const primaryHashes = [];
  const keys = new Set();
  for (const key of redisScan(`${redisSessionPrefix}*`)) {
    if (key.startsWith(`${redisSessionPrefix}expires:`) || redisCommand("TYPE", key) !== "hash") continue;
    const payload = redisCommand("HGETALL", key);
    if (!payload.includes(username)) continue;
    primaryHashes.push({ key, payload });
    keys.add(key);
    const sessionId = key.slice(redisSessionPrefix.length);
    const expiresKey = `${redisSessionPrefix}expires:${sessionId}`;
    if (redisCommand("EXISTS", expiresKey) === "1") keys.add(expiresKey);
  }
  const sessionIds = primaryHashes.map(({ key }) => key.slice(redisSessionPrefix.length));
  return {
    primaryHashes,
    keys: [...keys].sort(),
    members: redisExpirationMembers(sessionIds)
  };
}

export function captureRedisSessionForCookie(cookieHeader, expectedUsername) {
  const cookie = parseSessionCookie(cookieHeader);
  const candidates = decodedCookieCandidates(cookie.value);
  const matches = [];
  for (const key of redisScan(`${redisSessionPrefix}*`)) {
    if (key.startsWith(`${redisSessionPrefix}expires:`) || redisCommand("TYPE", key) !== "hash") continue;
    const sessionId = key.slice(redisSessionPrefix.length);
    if (!candidates.includes(sessionId)) continue;
    const payload = redisCommand("HGETALL", key);
    if (!payload.includes(expectedUsername)) continue;
    matches.push({ key, payload, sessionId });
  }
  if (matches.length !== 1) {
    const error = new Error("regression cookie must bind exactly one Redis primary session hash");
    error.code = matches.length === 0 ? "REGRESSION_REDIS_SESSION_NOT_FOUND" : "REGRESSION_REDIS_SESSION_AMBIGUOUS";
    throw error;
  }
  const [match] = matches;
  const keys = [match.key];
  const expiresKey = `${redisSessionPrefix}expires:${match.sessionId}`;
  if (redisCommand("EXISTS", expiresKey) === "1") keys.push(expiresKey);
  return {
    cookieName: cookie.name,
    keys: sortedUnique(keys),
    members: redisExpirationMembers([match.sessionId])
  };
}

export function verifyRedisSessionReleased(snapshot) {
  const remainingKeys = snapshot.keys.filter((key) => redisCommand("EXISTS", key) !== "0");
  const remainingMembers = snapshot.members.filter(({ key, member }) => redisCommand("SISMEMBER", key, member) !== "0");
  return { remainingKeys, remainingMembers, total: remainingKeys.length + remainingMembers.length };
}

function forceReleaseRedisSessions(username) {
  const snapshot = redisOwnedByUsername(username);
  for (const key of snapshot.keys) redisCommand("DEL", key);
  for (const { key, member } of snapshot.members) redisCommand("SREM", key, member);
  return snapshot;
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
    if (active) return;
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
  const response = await nativeFetch(`${apiBase}/api/system/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, accountSetCode })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`api login failed ${response.status}: ${text}`);
  }
  const sessionCookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
  parseSessionCookie(sessionCookie);
  return sessionCookie;
}

export async function logoutApiSession(apiBase, sessionCookie) {
  const logoutResponse = await nativeFetch(`${apiBase}/api/system/logout`, {
    method: "POST",
    headers: { Cookie: sessionCookie },
    signal: AbortSignal.timeout(10000)
  });
  if (!logoutResponse.ok) throw new Error(`api logout failed ${logoutResponse.status}`);
  const probe = await nativeFetch(`${apiBase}/api/system/session`, {
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
  const sessionCookie = await loginApi(apiBase, username, password, accountSetCode);
  options.onSessionCookie?.(sessionCookie);
  const parsed = parseSessionCookie(sessionCookie);
  await context.addCookies([{
    name: parsed.name,
    value: parsed.value,
    url: "http://127.0.0.1/"
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
  let sessionCookie = await loginApi(apiBase, username, password, accountSetCode);
  options.onSessionCookie?.(sessionCookie);
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith(apiBase) || url.includes("/api/system/login")) return originalFetch(input, init);
    const headers = new Headers(init.headers ?? (typeof input === "string" ? undefined : input.headers));
    const callerProvidedCookie = headers.has("Cookie");
    if (!callerProvidedCookie) headers.set("Cookie", sessionCookie);
    const response = await originalFetch(input, { ...init, headers });
    if (response.status !== 401 || callerProvidedCookie) return response;
    sessionCookie = await loginApi(apiBase, username, password, accountSetCode);
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

function fixtureOperationLogCount({ schemaNames, username, userId }) {
  assert(uuidPattern.test(String(userId ?? "")), "isolated regression operation-log cleanup requires a fixture user id");
  const actorPredicate = `actor_username=${sqlLiteral(username)} OR operated_by=${sqlLiteral(userId)}::uuid`;
  return dbNumber(`
    SELECT COALESCE(sum(row_count), 0)
    FROM (
      ${schemaNames.map((schemaName) => `
        SELECT count(*)::bigint AS row_count
        FROM ${sqlIdentifier(schemaName)}.sys_operation_log
        WHERE ${actorPredicate}
      `).join("\nUNION ALL\n")}
    ) fixture_operation_logs
  `, "isolated regression operation-log residue verification");
}

function deleteFixtureOperationLogs({ schemaNames, username, userId }) {
  assert(uuidPattern.test(String(userId ?? "")), "isolated regression operation-log cleanup requires a fixture user id");
  const actorPredicate = `actor_username=${sqlLiteral(username)} OR operated_by=${sqlLiteral(userId)}::uuid`;
  runPsql(`
    BEGIN;
    ${schemaNames.map((schemaName) => `
      DELETE FROM ${sqlIdentifier(schemaName)}.sys_operation_log
      WHERE ${actorPredicate};
    `).join("\n")}
    COMMIT;
  `, "isolated regression operation-log cleanup");
  assert(
    fixtureOperationLogCount({ schemaNames, username, userId }) === 0,
    "isolated regression operation-log residue is not zero"
  );
}

function deleteFixtureIdentity({ username, password, userId = "" }) {
  const idPredicate = userId ? `id=${sqlLiteral(userId)}::uuid` : `username=${sqlLiteral(username)}`;
  runPsql(`
    BEGIN;
    DO $fixture_cleanup$
    DECLARE fixture_user public.sys_user%ROWTYPE;
    BEGIN
      SELECT * INTO fixture_user FROM public.sys_user WHERE ${idPredicate};
      IF FOUND AND (fixture_user.username<>${sqlLiteral(username)} OR fixture_user.password_hash<>${sqlLiteral(`{noop}${password}`)}) THEN
        RAISE EXCEPTION 'isolated regression identity ownership mismatch';
      END IF;
    END $fixture_cleanup$;
    DELETE FROM public.sys_operation_log
    WHERE target_id=${userId ? `${sqlLiteral(userId)}::uuid` : `(SELECT id FROM public.sys_user WHERE username=${sqlLiteral(username)})`}
      AND target_type='sys_user'
      AND action_code IN ('LOGIN', 'LOGIN_REPLACED');
    DELETE FROM public.sys_session_account_scope WHERE user_id IN (
      SELECT id FROM public.sys_user WHERE username=${sqlLiteral(username)}
    );
    DELETE FROM public.sys_user_account_set WHERE user_id IN (
      SELECT id FROM public.sys_user WHERE username=${sqlLiteral(username)}
    );
    DELETE FROM public.sys_user_role WHERE user_id IN (
      SELECT id FROM public.sys_user WHERE username=${sqlLiteral(username)}
    );
    DELETE FROM public.sys_user
    WHERE username=${sqlLiteral(username)} AND password_hash=${sqlLiteral(`{noop}${password}`)};
    COMMIT;
  `, "isolated regression identity cleanup");
}

export function createIsolatedAdminSessionFixture(apiBase, options = {}) {
  const label = String(options.label || "suite").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 18) || "suite";
  const accountSetCodes = sortedUnique(options.accountSetCodes?.length ? options.accountSetCodes : ["BLD-TEST"]);
  const defaultAccountSetCode = options.defaultAccountSetCode || accountSetCodes[0];
  assert(accountSetCodes.includes(defaultAccountSetCode), "isolated regression default account set must be granted");
  const route = verifyFixtureRoute(accountSetCodes);
  const operationLogSchemas = sortedUnique(route.accountSets.map((row) => row.schemaName));
  const defaultAccountSet = route.accountSets.find((row) => row.code === defaultAccountSetCode);
  const username = `r_${label}_${randomBytes(8).toString("hex")}`.slice(0, 80);
  const password = `R!${randomBytes(18).toString("base64url")}a1`;
  const displayName = String(options.displayName || `隔离回归管理员 ${label}`).slice(0, 120);
  let userId = "";
  try {
    assert(dbNumber(`SELECT count(*) FROM public.sys_user WHERE username=${sqlLiteral(username)}`, "isolated regression collision check") === 0,
      "isolated regression username collision");
    const created = dbJson(`
      WITH created_user AS (
        INSERT INTO public.sys_user (username, display_name, password_hash, enabled, default_account_set_id)
        VALUES (
          ${sqlLiteral(username)}, ${sqlLiteral(displayName)}, ${sqlLiteral(`{noop}${password}`)}, TRUE,
          ${sqlLiteral(defaultAccountSet.id)}::uuid
        )
        RETURNING id
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
        'roleLinks', (SELECT count(*) FROM created_role),
        'grants', (SELECT count(*) FROM created_grants)
      )::text
      FROM created_user
    `, "isolated regression identity creation");
    userId = String(created?.userId ?? "");
    assert(uuidPattern.test(userId) && Number(created?.roleLinks) === 1 && Number(created?.grants) === accountSetCodes.length,
      "isolated regression identity creation returned an incomplete closure");
  } catch (error) {
    try {
      deleteFixtureIdentity({ username, password, userId });
    } catch {
      throw new Error("isolated regression identity creation failed and emergency cleanup could not be verified");
    }
    throw new Error(`isolated regression identity creation failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const cookies = new Set();
  const releasedCookies = new Set();
  let cleaned = false;

  function accountSet(accountSetCode) {
    const row = route.accountSets.find((item) => item.code === accountSetCode);
    if (!row) throw new Error("isolated regression identity was not granted the requested account set");
    return row;
  }

  function trackCookie(cookie) {
    parseSessionCookie(cookie);
    cookies.add(cookie);
  }

  async function login(accountSetCode = defaultAccountSetCode) {
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

  async function installInBrowser(context, accountSetCode = defaultAccountSetCode) {
    return installApiSessionInBrowser(context, apiBase, username, password, accountSetCode, { onSessionCookie: trackCookie });
  }

  async function installForApi(accountSetCode = defaultAccountSetCode) {
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

  async function cleanup() {
    if (cleaned) return { mode: "run-unique-admin", cleaned: true };
    const errors = [];
    for (const cookie of cookies) {
      if (releasedCookies.has(cookie)) continue;
      try {
        await logout(cookie);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    try {
      const redisBeforeForce = forceReleaseRedisSessions(username);
      if (redisBeforeForce.keys.length > 0 || redisBeforeForce.members.length > 0) {
        errors.push("isolated regression cleanup required forced Redis release");
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    let operationLogsCleared = false;
    try {
      const scopeCount = dbNumber(
        `SELECT count(*) FROM public.sys_session_account_scope WHERE user_id=${sqlLiteral(userId)}::uuid`,
        "isolated regression scope verification"
      );
      if (scopeCount > 0) errors.push("isolated regression cleanup found persisted session scopes after logout");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    try {
      deleteFixtureOperationLogs({ schemaNames: operationLogSchemas, username, userId });
      operationLogsCleared = true;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    if (operationLogsCleared) {
      try {
        deleteFixtureIdentity({ username, password, userId });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    } else {
      errors.push("isolated regression identity retained because actor-owned operation logs were not cleared");
    }
    try {
      const residue = dbNumber(`
        SELECT
          (SELECT count(*) FROM public.sys_user WHERE id=${sqlLiteral(userId)}::uuid)
          + (SELECT count(*) FROM public.sys_user_role WHERE user_id=${sqlLiteral(userId)}::uuid)
          + (SELECT count(*) FROM public.sys_user_account_set WHERE user_id=${sqlLiteral(userId)}::uuid)
          + (SELECT count(*) FROM public.sys_session_account_scope WHERE user_id=${sqlLiteral(userId)}::uuid)
      `, "isolated regression identity residue verification");
      if (residue !== 0) errors.push("isolated regression identity residue is not zero");
      if (fixtureOperationLogCount({ schemaNames: operationLogSchemas, username, userId }) !== 0) {
        errors.push("isolated regression operation-log residue is not zero");
      }
      const redisAfter = redisOwnedByUsername(username);
      if (redisAfter.keys.length > 0 || redisAfter.members.length > 0) errors.push("isolated regression Redis residue is not zero");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    cleaned = errors.length === 0;
    if (!cleaned) throw new Error(sortedUnique(errors).join("; "));
    return { mode: "run-unique-admin", cleaned: true };
  }

  return {
    username,
    password,
    userId,
    defaultAccountSetCode,
    accountSets: route.accountSets.map(({ code, schemaName }) => ({ code, schemaName })),
    trackCookie,
    login,
    installInBrowser,
    installForApi,
    logout,
    confirmReleased,
    cleanup
  };
}
