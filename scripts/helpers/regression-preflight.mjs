import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createIsolatedAdminSessionFixture } from "./regression-auth.mjs";

const execFileAsync = promisify(execFile);
const apiBase = "http://127.0.0.1:8080";
const frontendBase = "http://127.0.0.1:5173";
const accountSetCode = "BLD-TEST";
const accountSetSchema = "public";
const declaredDirectSqlRoleMutators = new Set([
  "scripts/a140-employee-financial-account-regression.mjs",
  "scripts/a141-formal-settlement-regression.mjs",
  "scripts/a142-sales-return-regression.mjs"
]);
const directSqlRoleMutationPattern = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(?:public\.)?sys_(?:role|permission)\b/i;

export function classifySharedStateMutationScripts(sources) {
  const apiRoleMutationScripts = sources
    .filter(({ source }) => source.includes("/api/system/roles/") && source.includes("/permissions"))
    .map(({ script }) => script);
  const directSqlRoleMutationScripts = sources
    .filter(({ source }) => directSqlRoleMutationPattern.test(source))
    .map(({ script }) => script);
  const missingDeclarations = sources
    .filter(({ script, source }) => declaredDirectSqlRoleMutators.has(script) && !directSqlRoleMutationPattern.test(source))
    .map(({ script }) => script);
  if (missingDeclarations.length > 0) {
    throw new Error(`Declared direct SQL role mutators no longer match the fail-closed detector: ${missingDeclarations.join(", ")}`);
  }
  const roleMutationScripts = [...new Set([...apiRoleMutationScripts, ...directSqlRoleMutationScripts])].sort();
  const securityMutationScripts = sources
    .filter(({ source }) => source.includes("/api/system/security-settings"))
    .map(({ script }) => script)
    .sort();
  return {
    roleMutationScripts,
    directSqlRoleMutationScripts: [...new Set(directSqlRoleMutationScripts)].sort(),
    securityMutationScripts,
    sharedStateMutationScripts: [...new Set([...roleMutationScripts, ...securityMutationScripts])].sort()
  };
}

export async function runRegressionPreflight({ rootDir, tier, scripts }) {
  let cleanWorktree = null;
  if (tier === "full") {
    await assertWorktreeClean(rootDir, "Full regression preflight");
    cleanWorktree = true;
  }

  const sources = await Promise.all(scripts.map(async (script) => ({
    script,
    source: await readFile(path.join(rootDir, script), "utf8")
  })));
  const frontendRequired = sources.some(({ source }) => source.includes("playwright") || source.includes("127.0.0.1:5173"));
  const {
    roleMutationScripts,
    directSqlRoleMutationScripts,
    securityMutationScripts,
    sharedStateMutationScripts
  } = classifySharedStateMutationScripts(sources);

  const directHealth = await requireJson(`${apiBase}/api/system/health`, {}, "direct backend health");
  if (directHealth.testInventoryAdjustmentApi !== true) {
    throw new Error("Regression backend must expose the controlled BLD-TEST inventory fixture capability");
  }
  const directFingerprint = normalizedFingerprint(directHealth.devBuildFingerprint);
  if (!directFingerprint) {
    throw new Error("Regression backend health is missing devBuildFingerprint; restart it with scripts/dev-up.sh");
  }
  const expectedFingerprint = await workspaceBackendFingerprint(rootDir);
  if (directFingerprint !== expectedFingerprint) {
    throw new Error(`Regression backend was not built from the current workspace: running=${directFingerprint}, expected=${expectedFingerprint}`);
  }

  let frontendHealth = null;
  let frontendProcessCwd = null;
  let frontendProxyTarget = null;
  if (frontendRequired) {
    const frontendProcess = await assertFrontendProcessWorkspace(rootDir);
    frontendProcessCwd = frontendProcess.cwd;
    frontendProxyTarget = await resolveFrontendProxyTarget(rootDir, frontendProcess.pid);
    if (frontendProxyTarget !== apiBase) {
      throw new Error(`Frontend proxy target must be the direct regression API: frontend=${frontendProxyTarget}, api=${apiBase}`);
    }
    frontendHealth = await requireJson(`${frontendBase}/api/system/health`, {}, "frontend proxy health");
    const frontendFingerprint = normalizedFingerprint(frontendHealth.devBuildFingerprint);
    if (!frontendFingerprint || frontendFingerprint !== directFingerprint) {
      throw new Error(`Frontend proxy is not connected to the verified regression backend: frontend=${frontendFingerprint || "<empty>"}, api=${directFingerprint}`);
    }
    if (frontendHealth.testInventoryAdjustmentApi !== true) {
      throw new Error("Frontend proxy backend does not expose the controlled BLD-TEST inventory fixture capability");
    }
  }

  const sharedBaseline = await readSharedRegressionBaseline();
  assertCompleteAdminPermissions(sharedBaseline);
  if (sharedBaseline.securitySettings.repeatedLoginPolicy !== "SINGLE_ACTIVE") {
    throw new Error(`Regression requires repeatedLoginPolicy=SINGLE_ACTIVE, got ${sharedBaseline.securitySettings.repeatedLoginPolicy}`);
  }

  return {
    checkedAt: new Date().toISOString(),
    workspaceRoot: rootDir,
    tier,
    apiBase,
    frontendBase: frontendRequired ? frontendBase : null,
    frontendProcessCwd,
    frontendProxyTarget,
    frontendRequired,
    expectedBuildFingerprint: expectedFingerprint,
    directBuildFingerprint: directFingerprint,
    frontendBuildFingerprint: frontendHealth ? normalizedFingerprint(frontendHealth.devBuildFingerprint) : null,
    inventoryFixtureCapability: true,
    tenant: sharedBaseline.tenant,
    user: { mode: "run-unique-admin", roleCode: sharedBaseline.user.roleCode },
    sessionIsolation: sharedBaseline.sessionIsolation,
    requiredAdminPermissions: sharedBaseline.permissionCatalogCodes,
    permissionCatalogCodes: sharedBaseline.permissionCatalogCodes,
    adminPermissionCodes: sharedBaseline.adminPermissionCodes,
    sessionPermissionCodes: sharedBaseline.sessionPermissionCodes,
    rolePermissionMatrix: sharedBaseline.rolePermissionMatrix,
    securitySettings: sharedBaseline.securitySettings,
    roleMutationScripts,
    directSqlRoleMutationScripts,
    securityMutationScripts,
    sharedStateMutationScripts,
    cleanWorktree
  };
}

export async function assertSharedRegressionBaseline(preflight, label = "postflight") {
  const current = await readSharedRegressionBaseline();
  const changes = {};
  if (!sameJson(current.permissionCatalogCodes, preflight.permissionCatalogCodes)) {
    changes.permissionCatalog = setDiff(preflight.permissionCatalogCodes, current.permissionCatalogCodes);
  }
  if (!sameJson(current.adminPermissionCodes, preflight.adminPermissionCodes)) {
    changes.adminPermissions = setDiff(preflight.adminPermissionCodes, current.adminPermissionCodes);
  }
  if (!sameJson(current.sessionPermissionCodes, preflight.sessionPermissionCodes)) {
    changes.sessionPermissions = setDiff(preflight.sessionPermissionCodes, current.sessionPermissionCodes);
  }
  if (!sameJson(current.rolePermissionMatrix, preflight.rolePermissionMatrix)) {
    changes.rolePermissionMatrix = permissionMatrixDiff(preflight.rolePermissionMatrix, current.rolePermissionMatrix);
  }
  if (!sameJson(current.securitySettings, preflight.securitySettings)) {
    changes.securitySettings = { before: preflight.securitySettings, after: current.securitySettings };
  }
  if (Object.keys(changes).length > 0) {
    throw new Error(`${label} changed the shared BLD-TEST regression baseline: ${JSON.stringify(changes)}`);
  }
  return {
    checkedAt: new Date().toISOString(),
    rolePermissionMatrix: current.rolePermissionMatrix,
    securitySettings: current.securitySettings
  };
}

export async function assertRegressionPostflight(preflight, label = "suite postflight") {
  const errors = [];
  let sharedState = null;
  try {
    sharedState = await assertSharedRegressionBaseline(preflight, label);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  let cleanWorktree = null;
  if (preflight.cleanWorktree === true) {
    try {
      await assertWorktreeClean(preflight.workspaceRoot, `${label} worktree`);
      cleanWorktree = true;
    } catch (error) {
      cleanWorktree = false;
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
  return { ...sharedState, cleanWorktree };
}

async function readSharedRegressionBaseline() {
  const fixture = createIsolatedAdminSessionFixture(apiBase, { label: "preflight" });
  let baseline = null;
  let primaryError = null;
  try {
    const cookie = await fixture.login(accountSetCode);
    const headers = { Cookie: cookie };
    const session = await requireJson(`${apiBase}/api/system/session`, { headers }, "regression session");
    if (session.authenticated !== true
      || session.tenant?.code !== accountSetCode
      || session.tenant?.schemaName !== accountSetSchema
      || session.user?.username !== fixture.username
      || session.user?.roleCode !== "ADMIN") {
      throw new Error(`Regression session is outside the exact isolated BLD-TEST/public ADMIN boundary: ${JSON.stringify({
        authenticated: session.authenticated,
        tenantCode: session.tenant?.code,
        schemaName: session.tenant?.schemaName,
        roleCode: session.user?.roleCode
      })}`);
    }
    const matrix = await requireJson(`${apiBase}/api/system/role-permissions`, { headers }, "role permission matrix");
    const admin = matrix.roles?.find((role) => role.code === "ADMIN");
    if (!admin || admin.enabled !== true || !Array.isArray(admin.permissionCodes) || !Array.isArray(matrix.permissions)) {
      throw new Error("Regression preflight could not resolve the ADMIN permission matrix");
    }
    const securitySettings = normalizeSecuritySettings(
      await requireJson(`${apiBase}/api/system/security-settings`, { headers }, "security settings")
    );
    baseline = {
      tenant: { code: session.tenant.code, schemaName: session.tenant.schemaName },
      user: { roleCode: session.user.roleCode },
      permissionCatalogCodes: sortedUnique(matrix.permissions.map((permission) => permission.permissionCode)),
      adminPermissionCodes: sortedUnique(admin.permissionCodes),
      sessionPermissionCodes: sortedUnique(session.user.permissionCodes || []),
      rolePermissionMatrix: Object.fromEntries(
        [...matrix.roles]
          .sort((left, right) => String(left.code).localeCompare(String(right.code)))
          .map((role) => [String(role.code), {
            enabled: role.enabled === true,
            permissionCodes: sortedUnique(role.permissionCodes || [])
          }])
      ),
      securitySettings
    };
  } catch (error) {
    primaryError = error;
  }
  let cleanupError = null;
  try {
    await fixture.cleanup();
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError && cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      `Regression preflight baseline failed: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}; cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  return { ...baseline, sessionIsolation: { mode: "run-unique-admin", cleanupVerified: true } };
}

async function requireJson(url, options, label) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(5000) });
  } catch (error) {
    throw new Error(`${label} is unavailable at ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} failed ${response.status}: ${text}`);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function workspaceBackendFingerprint(rootDir) {
  const helperPath = path.join(rootDir, "scripts/dev-process-identity.sh");
  const backendDir = path.join(rootDir, "backend");
  const { stdout } = await execFileAsync("bash", [
    "-lc",
    'source "$1"; jdy_backend_build_fingerprint "$2" "$3"',
    "a173-regression-preflight",
    helperPath,
    rootDir,
    backendDir
  ]);
  const fingerprint = normalizedFingerprint(stdout);
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error(`Could not calculate the current workspace backend fingerprint: ${JSON.stringify(fingerprint)}`);
  }
  return fingerprint;
}

async function assertFrontendProcessWorkspace(rootDir) {
  let pidOutput;
  try {
    ({ stdout: pidOutput } = await execFileAsync("lsof", ["-tiTCP:5173", "-sTCP:LISTEN"]));
  } catch (error) {
    throw new Error(`Could not resolve the frontend listener on 5173: ${error instanceof Error ? error.message : String(error)}`);
  }
  const pids = pidOutput.trim().split(/\s+/).filter(Boolean);
  if (pids.length !== 1 || !/^\d+$/.test(pids[0])) {
    throw new Error(`Expected exactly one frontend listener on 5173, found ${JSON.stringify(pids)}`);
  }
  const { stdout: cwdOutput } = await execFileAsync("lsof", ["-a", "-p", pids[0], "-d", "cwd", "-Fn"]);
  const cwd = cwdOutput.split("\n").find((line) => line.startsWith("n"))?.slice(1).trim();
  if (!cwd) {
    throw new Error(`Could not resolve cwd for frontend listener pid ${pids[0]}`);
  }
  const [actual, expected] = await Promise.all([realpath(cwd), realpath(path.join(rootDir, "frontend"))]);
  if (actual !== expected && !actual.startsWith(`${expected}${path.sep}`)) {
    throw new Error(`Frontend listener does not belong to the current workspace: running=${actual}, expected=${expected}`);
  }
  return { cwd: actual, pid: pids[0] };
}

async function resolveFrontendProxyTarget(rootDir, pid) {
  const frontendDir = path.join(rootDir, "frontend");
  const { stdout: processDescription } = await execFileAsync("ps", ["eww", "-p", String(pid), "-o", "command="]);
  if (!processDescription.trim()) {
    throw new Error(`Could not inspect frontend listener pid ${pid}`);
  }
  const mode = processDescription.match(/(?:^|\s)--mode(?:=|\s+)([^\s]+)/)?.[1] || "development";
  const apiEnvironmentValues = [...processDescription.matchAll(/(?:^|\s)JDY_API_BASE=([^\s]+)/g)]
    .map((match) => match[1]);
  const uniqueApiEnvironmentValues = [...new Set(apiEnvironmentValues)];
  if (uniqueApiEnvironmentValues.length > 1) {
    throw new Error(`Frontend listener exposes ambiguous JDY_API_BASE values on pid ${pid}`);
  }

  const requireFromFrontend = createRequire(path.join(frontendDir, "package.json"));
  const viteEntry = requireFromFrontend.resolve("vite");
  const { loadConfigFromFile } = await import(pathToFileURL(viteEntry).href);
  const originalCwd = process.cwd();
  const hadApiBase = Object.hasOwn(process.env, "JDY_API_BASE");
  const originalApiBase = process.env.JDY_API_BASE;
  let loaded;
  try {
    process.chdir(frontendDir);
    if (uniqueApiEnvironmentValues.length === 1) {
      process.env.JDY_API_BASE = uniqueApiEnvironmentValues[0];
    } else {
      delete process.env.JDY_API_BASE;
    }
    loaded = await loadConfigFromFile(
      { command: "serve", mode },
      path.join(frontendDir, "vite.config.ts")
    );
  } finally {
    process.chdir(originalCwd);
    if (hadApiBase) process.env.JDY_API_BASE = originalApiBase;
    else delete process.env.JDY_API_BASE;
  }
  const proxyEntry = loaded?.config?.server?.proxy?.["/api"];
  const target = typeof proxyEntry === "string" ? proxyEntry : proxyEntry?.target;
  return normalizeHttpBase(target, "frontend /api proxy target");
}

function normalizedFingerprint(value) {
  return typeof value === "string" ? value.trim() : "";
}

function permissionMatrixDiff(before, after) {
  const roles = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return Object.fromEntries(roles.flatMap((role) => {
    const beforeRole = before[role] || { enabled: null, permissionCodes: [] };
    const afterRole = after[role] || { enabled: null, permissionCodes: [] };
    const beforeCodes = beforeRole.permissionCodes;
    const afterCodes = afterRole.permissionCodes;
    const missing = beforeCodes.filter((code) => !afterCodes.includes(code));
    const added = afterCodes.filter((code) => !beforeCodes.includes(code));
    const enabledChanged = beforeRole.enabled !== afterRole.enabled;
    return missing.length || added.length || enabledChanged
      ? [[role, { beforeEnabled: beforeRole.enabled, afterEnabled: afterRole.enabled, missing, added }]]
      : [];
  }));
}

async function assertWorktreeClean(rootDir, label) {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: rootDir });
  if (stdout.trim()) {
    throw new Error(`${label} requires a clean candidate worktree`);
  }
}

function assertCompleteAdminPermissions(baseline) {
  const grantDiff = setDiff(baseline.permissionCatalogCodes, baseline.adminPermissionCodes);
  const sessionDiff = setDiff(baseline.permissionCatalogCodes, baseline.sessionPermissionCodes);
  if (grantDiff.missing.length || grantDiff.added.length) {
    throw new Error(`BLD-TEST ADMIN grants must exactly match the enabled permission catalog: ${JSON.stringify(grantDiff)}`);
  }
  if (sessionDiff.missing.length || sessionDiff.added.length) {
    throw new Error(`BLD-TEST ADMIN effective session permissions must exactly match the enabled permission catalog: ${JSON.stringify(sessionDiff)}`);
  }
}

function normalizeSecuritySettings(settings) {
  const normalized = {
    repeatedLoginPolicy: String(settings?.repeatedLoginPolicy || ""),
    sessionTimeoutMinutes: Number(settings?.sessionTimeoutMinutes),
    sessionTimeoutSeconds: Number(settings?.sessionTimeoutSeconds),
    passwordPolicy: {
      minLength: Number(settings?.passwordPolicy?.minLength),
      requireUppercase: settings?.passwordPolicy?.requireUppercase === true,
      requireLowercase: settings?.passwordPolicy?.requireLowercase === true,
      requireDigit: settings?.passwordPolicy?.requireDigit === true,
      requireSymbol: settings?.passwordPolicy?.requireSymbol === true
    }
  };
  if (!["SINGLE_ACTIVE", "ALLOW_CONCURRENT"].includes(normalized.repeatedLoginPolicy)
    || !Number.isInteger(normalized.sessionTimeoutMinutes)
    || normalized.sessionTimeoutMinutes <= 0
    || normalized.sessionTimeoutSeconds !== normalized.sessionTimeoutMinutes * 60
    || !Number.isInteger(normalized.passwordPolicy.minLength)
    || normalized.passwordPolicy.minLength <= 0) {
    throw new Error(`Security settings baseline is invalid: ${JSON.stringify(normalized)}`);
  }
  return normalized;
}

function normalizeHttpBase(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is missing`);
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (parsed.protocol !== "http:" || parsed.username || parsed.password || !["", "/"].includes(parsed.pathname) || parsed.search || parsed.hash) {
    throw new Error(`${label} must be one credential-free local HTTP origin`);
  }
  return parsed.origin;
}

function sortedUnique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))].sort();
}

function setDiff(before, after) {
  return {
    missing: before.filter((value) => !after.includes(value)),
    added: after.filter((value) => !before.includes(value))
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
