import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  assertMainRegressionRedisTarget,
  captureUserSessionInvariant,
  createIsolatedAdminSessionFixture
} from "./regression-auth.mjs";

const execFileAsync = promisify(execFile);
const requireFromFrontendPackage = createRequire(path.resolve(import.meta.dirname, "../../frontend/package.json"));
const ts = requireFromFrontendPackage("typescript");
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
const spawnedBackendAdminLiteralScripts = new Set([
  "scripts/a141-settlement-migration-regression.mjs",
  "scripts/a142-sales-return-migration-regression.mjs",
  "scripts/a143-master-data-import-migration-regression.mjs",
  "scripts/a147-inventory-source-trace-migration-regression.mjs",
  "scripts/a151-material-scrap-migration-regression.mjs"
]);
const regressionAuthModulePath = "./helpers/regression-auth.mjs";
// This helper exposes only the fixed master-data fixture route family. Its
// generic pathname argument is deliberately audited by its own route prefix,
// rather than being mistaken for a raw credential POST sink.
const approvedDynamicPostTransportModules = new Set([
  "scripts/helpers/master-data-actions.mjs"
]);
const prohibitedDynamicExecutionModules = new Set([
  "cluster",
  "module",
  "vm",
  "worker_threads",
  "inspector",
  "repl"
]);
const isProhibitedDynamicExecutionModule = (specifier) => (
  prohibitedDynamicExecutionModules.has(String(specifier || "").replace(/^node:/, ""))
);
const approvedRegressionLocalModulePaths = new Set([
  "frontend/node_modules/typescript/lib/typescript.js",
  "scripts/helpers/current-migration-head.mjs",
  "scripts/helpers/document-actions.mjs",
  "scripts/helpers/entry-table-actions.mjs",
  "scripts/helpers/master-data-actions.mjs",
  "scripts/helpers/regression-auth.mjs",
  "scripts/helpers/regression-fixture-ledger.mjs",
  "scripts/helpers/regression-process-tree.mjs",
  "scripts/helpers/regression-redis-lua.mjs",
  "scripts/helpers/regression-secret-channel.mjs",
  "scripts/helpers/report-import-graph.mjs",
  "scripts/helpers/sales-delivery-notice-flow.mjs",
  "scripts/helpers/sales-pages.mjs",
  "scripts/validate-regression-manifest.mjs"
]);
const auditedRegressionLocalDependencyPaths = [...approvedRegressionLocalModulePaths]
  .filter((modulePath) => ![
    "frontend/node_modules/typescript/lib/typescript.js",
    "scripts/helpers/regression-auth.mjs"
  ].includes(modulePath));

export async function loadAuditedRegressionLocalDependencySources(rootDir) {
  const queue = [...new Set([
    "scripts/helpers/regression-auth.mjs",
    ...auditedRegressionLocalDependencyPaths
  ])];
  const visited = new Set();
  const auditedSources = [];
  while (queue.length > 0) {
    const script = queue.shift();
    if (visited.has(script) || script === "frontend/node_modules/typescript/lib/typescript.js") continue;
    visited.add(script);
    const source = await readFile(path.join(rootDir, script), "utf8");
    for (const dependency of staticRegressionLocalDependencies(script, source)) {
      if (!approvedRegressionLocalModulePaths.has(dependency)) {
        throw new Error(`Regression helper dependency is outside the audited local module set: ${script} -> ${dependency}`);
      }
      if (!visited.has(dependency)) queue.push(dependency);
    }
    if (script !== "scripts/helpers/regression-auth.mjs") auditedSources.push({ script, source });
  }
  return auditedSources.sort((left, right) => left.script.localeCompare(right.script));
}
const regressionAuthContractExports = new Set([
  "loginAs",
  "loginAsAdmin",
  "loginApi",
  "installApiSession",
  "installApiSessionInBrowser",
  "regressionAdminIdentity",
  "fillRegressionAdminPassword",
  "requestWithRegressionAdminConfirmation",
  "createIsolatedAdminSessionFixture"
]);
const regressionAuthAllowedManifestExports = new Set([
  ...regressionAuthContractExports,
  "captureRedisSessionForCookie",
  "logout",
  "logoutApiSession",
  "openPasswordChange",
  "postPublicPasswordResetRequest",
  "verifyRedisSessionReleased"
]);
const regressionAuthPasswordArgumentIndex = new Map([
  ["loginAs", 2],
  ["loginAsAdmin", 1],
  ["loginApi", 2],
  ["installApiSession", 2],
  ["installApiSessionInBrowser", 3]
]);
const runScopedAdminViolationPatterns = [
  ["raw login form uses the shared admin username", /login-username[\s\S]{0,180}?\.fill\(\s*["']admin["']\s*\)/i],
  ["local login wrapper receives shared admin credentials", /(?:async\s+)?function\s+loginAs(?:Admin)?\b[\s\S]{0,1200}?login-username[\s\S]{0,400}?\bloginAs(?:Admin)?\([^\n]{0,160}["']admin["']\s*,\s*["']admin123["']/i],
  ["security confirmation uses the shared admin password", /(?:current-password|currentPassword)[\s\S]{0,180}?(?:\.fill\(\s*["']admin123["']|:\s*["']admin123["'])/i],
  ["lifecycle confirmation targets the shared admin identity", /username\s*:\s*["']admin["'][\s\S]{0,180}?password\s*:\s*["'](?:admin123|bad(?:-password)?|bad)["']/i],
  ["session assertion is hard-coded to the shared admin", /session[^\n]{0,180}(?:user[^\n]{0,60})?username[^\n]{0,60}===?\s*["']admin["']/i],
  ["document lock assertion is hard-coded to the shared admin", /holder_username\s*===?\s*["']admin["']/i],
  ["operation actor is hard-coded to the shared admin", /actorUsername\s*=\s*["']admin["']|assertUserActor\([^\n]{0,220}["']admin["']|actor(?:_row)?\.username\s*=\s*["']admin["']/i],
  ["operation operator is hard-coded to the shared admin", /operator_username[^\n]{0,160}["']admin["']/i],
  ["run actor lookup is hard-coded to the shared admin", /const\s+adminUserId\s*=\s*sqlScalar\([^\n]{0,180}username\s*=\s*["']admin["']/i]
];

export function classifyRunScopedAdminUsage(sources) {
  const violations = [];
  const provenSpawnedBackendExclusions = [];
  const mainCredentialScripts = [];
  for (const { script, source } of sources) {
    const analysis = analyzeAdminCredentialSource(script, source);
    if (analysis.parseDiagnostics.length > 0) {
      violations.push({ script, reason: `JavaScript parser rejected the manifest source: ${analysis.parseDiagnostics[0]}` });
      continue;
    }
    const importedAuthLocals = analysis.importedAuthLocals;
    if (analysis.authModuleReferenceCount !== analysis.provenAuthModuleReferenceCount) {
      violations.push({ script, reason: "auth helper imports must use the proven direct named-import contract" });
    }
    if (analysis.unprovenAuthReferenceCount > 0) {
      violations.push({ script, reason: "auth helper contract exports cannot be aliased, stored, or passed as callbacks" });
    }
    if (analysis.unapprovedAuthExportCount > 0) {
      violations.push({ script, reason: "auth helper imports must use the reviewed manifest export set" });
    }
    if (analysis.unapprovedPasswordFillTargetCount > 0) {
      violations.push({ script, reason: "regression admin password fill target must be an approved current-password field" });
    }
    if (analysis.rawSharedAdminCredentialObjectCount > 0) {
      violations.push({ script, reason: "raw shared admin credential payload must use the reviewed auth confirmation helper" });
    }
    if (analysis.unapprovedSharedAdminPasswordMaterialCount > 0) {
      violations.push({
        script,
        reason: "shared admin password material must be passed directly to a reviewed auth helper"
      });
    }
    const calledAuthExports = analysis.calledAuthExports;
    const authCallSites = analysis.authCallSites;
    const hasStaticAuthImport = importedAuthLocals.size > 0;
    const hasAuthContractCall = [...calledAuthExports].some((name) => regressionAuthContractExports.has(name));
    const stringCandidates = analysis.constantStrings;
    const hasRawLoginSink = stringCandidates.some((value) => value.includes("/api/system/login"))
      || (stringCandidates.includes("login-username") && stringCandidates.includes("login-password"));
    const hasAdminCandidate = stringCandidates.some((value) => value.trim().toLowerCase() === "admin");
    const hasAdminPasswordCandidate = stringCandidates.includes("admin123");
    const hasSensitiveLifecycleRouteCandidate = stringCandidates.some((value) => (
      value.includes("/api/document-lifecycle/")
      && (value.includes("/void") || stringCandidates.includes("void"))
    ));
    const credentialEnvironmentReads = analysis.environmentReads
      .filter((name) => /(?:ADMIN|LOGIN|PASSWORD|PASSWD|CREDENTIAL|SECRET|TOKEN)/i.test(name));
    const sharedAdminEnvironmentReads = credentialEnvironmentReads
      .filter((name) => /(?:ADMIN|LOGIN|REGRESSION.*CREDENTIAL)/i.test(name));
    if (sharedAdminEnvironmentReads.length > 0) {
      violations.push({
        script,
        reason: "shared admin credential environment source must only be read by the reviewed auth helper"
      });
    }
    if ((analysis.rawSensitiveConfirmationTransportCount > 0 || hasSensitiveLifecycleRouteCandidate)
      && hasAdminCandidate
      && hasAdminPasswordCandidate) {
      violations.push({
        script,
        reason: "raw shared-admin lifecycle confirmation must use the reviewed auth confirmation helper"
      });
    }
    if ((analysis.rawSensitiveConfirmationTransportCount > 0 || hasSensitiveLifecycleRouteCandidate)
      && credentialEnvironmentReads.length > 0) {
      violations.push({
        script,
        reason: "raw lifecycle confirmation cannot read an unproven credential environment source"
      });
    }
    if (hasRawLoginSink && hasAdminCandidate && hasAdminPasswordCandidate) {
      violations.push({ script, reason: "raw login sink can reach shared admin literal credentials" });
    }
    if (hasRawLoginSink && credentialEnvironmentReads.length > 0) {
      violations.push({ script, reason: "raw login sink reads an unproven credential environment source" });
    }
    if (hasRawLoginSink && calledAuthExports.has("regressionAdminCredentials")) {
      violations.push({ script, reason: "raw login sink cannot receive the run-scoped ADMIN credential value" });
    }
    if (hasRawLoginSink && !hasAuthContractCall) {
      violations.push({ script, reason: "raw login sink is not routed through the static auth helper contract" });
    }
    if (analysis.unprovenCredentialTransportCount > 0) {
      violations.push({ script, reason: "credential-shaped POST uses an unresolved transport target outside the auth helper" });
    }
    if (analysis.unresolvedPostTransportCount > 0) {
      if (!approvedDynamicPostTransportModules.has(script)) {
      violations.push({ script, reason: "POST transport target must resolve statically outside the auth helper" });
      }
    }
    if (analysis.dynamicCodeExecutionCount > 0) {
      violations.push({ script, reason: "manifest regression scripts cannot use dynamic code execution or runtime module loaders" });
    }
    if (analysis.detachedProcessEscapeCount > 0) {
      violations.push({ script, reason: "manifest regression scripts cannot create detached process escapes" });
    }
    if (analysis.unsafeChildProcessExecutionCount > 0) {
      violations.push({ script, reason: "manifest regression scripts cannot use unsafe child_process execution" });
    }
    if (analysis.unsafePlaywrightLaunchCount > 0) {
      violations.push({ script, reason: "manifest regression scripts must use the canonical headless Playwright launch options" });
    }
    if (analysis.unapprovedLocalModuleReferenceCount > 0) {
      violations.push({ script, reason: "local module dependencies must use the audited static regression module set" });
    }
    let isolated = false;
    if (spawnedBackendAdminLiteralScripts.has(script)) {
      const isolatedAdminTargets = [...source.matchAll(/\bloginApi\(\s*([^,\n]+)\s*,\s*["']admin["']\s*,\s*["']admin123["']/g)]
        .map((match) => match[1].trim());
      isolated = analysis.isolatedBackendPortBindingProven
        && isolatedAdminTargets.length > 0
        && isolatedAdminTargets.every((target) => /^(?:backend|spawnedBackend)\.baseUrl$/.test(target))
        && !/(?:127\.0\.0\.1|localhost):(?:8080|5173)/.test(source);
      const mixedOriginAuthCalls = authCallSites.filter((callSite) => (
        regressionAuthContractExports.has(callSite.exportedName)
        && !(callSite.exportedName === "loginApi"
          && /^(?:backend|spawnedBackend)\.baseUrl$/.test(callSite.argumentTexts[0] || "")
          && callSite.argumentStrings[1] === "admin"
          && callSite.argumentStrings[2] === "admin123")
      ));
      if (mixedOriginAuthCalls.length > 0) {
        isolated = false;
        violations.push({
          script,
          reason: "spawned-backend exclusion cannot contain main-target or unresolved auth capability calls"
        });
      }
      if (!isolated) {
        violations.push({ script, reason: "spawned-backend admin exclusion no longer proves a random isolated origin" });
      } else {
        provenSpawnedBackendExclusions.push(script);
      }
    }
    if (!isolated && hasStaticAuthImport && hasAuthContractCall) mainCredentialScripts.push(script);
    if (!isolated
      && /["']admin["']\s*,\s*["']admin123["']/.test(source)
      && !hasStaticAuthImport) {
      violations.push({ script, reason: "shared admin literal credentials are not routed through the static auth helper" });
    }
    if (!isolated
      && /username\s*:\s*["']admin["'][\s\S]{0,240}?password\s*:\s*["']admin123["']/.test(source)
      && !hasStaticAuthImport) {
      violations.push({ script, reason: "raw shared admin login payload bypasses the static auth helper" });
    }
    const sourceWithoutComments = stripJavaScriptCommentsWithParser(source);
    if (sourceWithoutComments.includes("JDY_REGRESSION_CHILD_GUARD_TOKEN")
      || sourceWithoutComments.includes("JDY_REGRESSION_DETACHED_SPAWN_LEDGER_FD")
      || sourceWithoutComments.includes("JDY_REGRESSION_DETACHED_SPAWN_SIGNING_KEY_FD")
      || sourceWithoutComments.includes("JDY_REGRESSION_PARENT_WATCHDOG_FD")
      || (script !== "scripts/helpers/regression-process-tree.mjs"
        && /\bprocess\s*\.\s*(?:kill|_kill|_debugProcess|_debugEnd|exit|abort|reallyExit)\s*\(/.test(sourceWithoutComments))
      || /\bprocess\s*\.\s*(?:binding|_linkedBinding|dlopen)\s*\(/.test(sourceWithoutComments)
      || /\bChildProcess\s*\.\s*prototype\s*\.\s*spawn\b/.test(sourceWithoutComments)
      || /\bprocess\s*\.\s*stdin\s*\.\s*(?:removeAllListeners|removeListener|destroy)\b/.test(sourceWithoutComments)
      || /(?:\/dev\/fd|\/proc\/self\/fd)(?:\/|\\x2f|%2f)/i.test(sourceWithoutComments)) {
      violations.push({
        script,
        reason: "manifest scripts cannot inspect or replace the runner child-process guard capability"
      });
    }
    for (const [reason, pattern] of runScopedAdminViolationPatterns) {
      if (pattern.test(sourceWithoutComments)) violations.push({ script, reason });
    }
  }
  return {
    scannedScripts: sources.length,
    spawnedBackendExclusions: provenSpawnedBackendExclusions.sort(),
    mainCredentialScripts: mainCredentialScripts.sort(),
    violations
  };
}

function analyzeAdminCredentialSource(script, source) {
  const sourceFile = ts.createSourceFile(script, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const parseDiagnostics = (sourceFile.parseDiagnostics || []).map((diagnostic) => (
    ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")
  ));
  const constInitializers = new Map();
  const constantFunctions = new Map();
  const ambiguousNames = new Set();
  const registerUnique = (target, name, value) => {
    if (!name || ambiguousNames.has(name)) return;
    if (target.has(name)) {
      target.delete(name);
      ambiguousNames.add(name);
      return;
    }
    target.set(name, value);
  };
  const collectDeclarations = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && (node.parent?.flags & ts.NodeFlags.Const) !== 0) {
      registerUnique(constInitializers, node.name.text, node.initializer);
      if ((ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
        && node.initializer.parameters.length === 0) {
        const returned = functionReturnExpression(node.initializer);
        if (returned) registerUnique(constantFunctions, node.name.text, returned);
      }
    } else if (ts.isFunctionDeclaration(node) && node.name && node.parameters.length === 0) {
      const returned = functionReturnExpression(node);
      if (returned) registerUnique(constantFunctions, node.name.text, returned);
    }
    ts.forEachChild(node, collectDeclarations);
  };
  collectDeclarations(sourceFile);

  const evaluateNumber = (node, stack = new Set()) => {
    const expression = unwrapExpression(node);
    if (!expression) return null;
    if (ts.isNumericLiteral(expression)) {
      const parsed = Number(expression.text);
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (ts.isPrefixUnaryExpression(expression)) {
      const value = evaluateNumber(expression.operand, stack);
      if (value == null) return null;
      if (expression.operator === ts.SyntaxKind.MinusToken) return -value;
      if (expression.operator === ts.SyntaxKind.PlusToken) return value;
    }
    if (ts.isIdentifier(expression) && constInitializers.has(expression.text) && !stack.has(expression.text)) {
      return evaluateNumber(constInitializers.get(expression.text), new Set([...stack, expression.text]));
    }
    return null;
  };
  const evaluateString = (node, stack = new Set()) => {
    const expression = unwrapExpression(node);
    if (!expression) return null;
    if (ts.isStringLiteralLike(expression)) return expression.text;
    if (ts.isTemplateExpression(expression)) {
      let value = expression.head.text;
      for (const span of expression.templateSpans) {
        const interpolation = evaluateString(span.expression, stack);
        if (interpolation == null) return null;
        value += interpolation + span.literal.text;
      }
      return value;
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = evaluateString(expression.left, stack);
      const right = evaluateString(expression.right, stack);
      return left == null || right == null ? null : left + right;
    }
    if (ts.isIdentifier(expression)) {
      if (stack.has(expression.text)) return null;
      if (constInitializers.has(expression.text)) {
        return evaluateString(constInitializers.get(expression.text), new Set([...stack, expression.text]));
      }
      return null;
    }
    if (ts.isCallExpression(expression)) {
      if (ts.isIdentifier(expression.expression)
        && expression.expression.text === "atob"
        && expression.arguments.length === 1) {
        const input = evaluateString(expression.arguments[0], stack);
        if (input != null && input.length <= 16_384 && /^[A-Za-z0-9+/_=-]*$/.test(input)) {
          try {
            return Buffer.from(input, "base64").toString("latin1");
          } catch {
            return null;
          }
        }
      }
      if (ts.isIdentifier(expression.expression)
        && expression.arguments.length === 0
        && constantFunctions.has(expression.expression.text)
        && !stack.has(expression.expression.text)) {
        return evaluateString(
          constantFunctions.get(expression.expression.text),
          new Set([...stack, expression.expression.text])
        );
      }
      if (ts.isPropertyAccessExpression(expression.expression)) {
        const owner = expression.expression.expression;
        const method = expression.expression.name.text;
        if (method === "toString"
          && ts.isCallExpression(owner)
          && ts.isPropertyAccessExpression(owner.expression)
          && ts.isIdentifier(owner.expression.expression)
          && owner.expression.expression.text === "Buffer"
          && owner.expression.name.text === "from"
          && owner.arguments.length >= 1
          && owner.arguments.length <= 2
          && expression.arguments.length <= 1) {
          const input = evaluateString(owner.arguments[0], stack);
          const inputEncoding = owner.arguments.length === 2
            ? evaluateString(owner.arguments[1], stack)
            : "utf8";
          const outputEncoding = expression.arguments.length === 1
            ? evaluateString(expression.arguments[0], stack)
            : "utf8";
          if (input != null
            && input.length <= 16_384
            && ["utf8", "base64", "base64url", "hex"].includes(String(inputEncoding || "").toLowerCase())
            && ["utf8", "utf-8"].includes(String(outputEncoding || "").toLowerCase())) {
            try {
              return Buffer.from(input, String(inputEncoding).toLowerCase()).toString("utf8");
            } catch {
              return null;
            }
          }
        }
        if (ts.isIdentifier(owner) && owner.text === "String"
          && ["fromCharCode", "fromCodePoint"].includes(method)) {
          const values = expression.arguments.map((argument) => evaluateNumber(argument, stack));
          if (values.every((value) => Number.isInteger(value) && value >= 0)) {
            try {
              return method === "fromCharCode" ? String.fromCharCode(...values) : String.fromCodePoint(...values);
            } catch {
              return null;
            }
          }
        }
        if (method === "join" && ts.isArrayLiteralExpression(owner) && expression.arguments.length <= 1) {
          const separator = expression.arguments.length === 0 ? "," : evaluateString(expression.arguments[0], stack);
          const parts = owner.elements.map((element) => evaluateString(element, stack));
          return separator != null && parts.every((part) => part != null) ? parts.join(separator) : null;
        }
      }
    }
    return null;
  };
  const resolveConstExpression = (node, stack = new Set()) => {
    if (!node) return null;
    const expression = unwrapExpression(node);
    if (ts.isIdentifier(expression)
      && constInitializers.has(expression.text)
      && !stack.has(expression.text)) {
      return resolveConstExpression(constInitializers.get(expression.text), new Set([...stack, expression.text]));
    }
    return expression;
  };
  const resolvesDynamicExecutor = (node, stack = new Set()) => {
    const expression = unwrapExpression(node);
    if (!expression) return false;
    if (ts.isIdentifier(expression)) {
      if (["eval", "Function"].includes(expression.text)) return true;
      if (constInitializers.has(expression.text) && !stack.has(expression.text)) {
        return resolvesDynamicExecutor(
          constInitializers.get(expression.text),
          new Set([...stack, expression.text])
        );
      }
      return false;
    }
    if (ts.isPropertyAccessExpression(expression)) {
      // `Function.call.bind(...)` captures the already-existing primordial
      // call method; it does not construct or execute source text. Keep the
      // direct `Function.call(...)` case rejected below.
      if (expression.name.text === "bind"
        && ts.isPropertyAccessExpression(expression.expression)
        && ts.isIdentifier(expression.expression.expression)
        && expression.expression.expression.text === "Function"
        && expression.expression.name.text === "call") {
        return false;
      }
      if (["call", "apply", "bind"].includes(expression.name.text)) {
        return resolvesDynamicExecutor(expression.expression, stack);
      }
      return ts.isIdentifier(expression.expression)
        && ["globalThis", "window", "global"].includes(expression.expression.text)
        && ["eval", "Function"].includes(expression.name.text);
    }
    if (ts.isElementAccessExpression(expression)) {
      return ts.isIdentifier(expression.expression)
        && ["globalThis", "window", "global"].includes(expression.expression.text)
        && ["eval", "Function"].includes(String(evaluateString(expression.argumentExpression) || ""));
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      return resolvesDynamicExecutor(expression.right, stack);
    }
    if (ts.isCallExpression(expression)) {
      return resolvesDynamicExecutor(expression.expression, stack);
    }
    return false;
  };
  const resolvesProcessBuiltinModuleLoader = (node, stack = new Set()) => {
    const expression = unwrapExpression(node);
    if (!expression) return false;
    if (ts.isIdentifier(expression)) {
      if (constInitializers.has(expression.text) && !stack.has(expression.text)) {
        return resolvesProcessBuiltinModuleLoader(
          constInitializers.get(expression.text),
          new Set([...stack, expression.text])
        );
      }
      return false;
    }
    if (ts.isPropertyAccessExpression(expression)) {
      if (["call", "apply", "bind"].includes(expression.name.text)) {
        return resolvesProcessBuiltinModuleLoader(expression.expression, stack);
      }
      return ts.isIdentifier(expression.expression)
        && expression.expression.text === "process"
        && expression.name.text === "getBuiltinModule";
    }
    if (ts.isElementAccessExpression(expression)) {
      return ts.isIdentifier(expression.expression)
        && expression.expression.text === "process"
        && evaluateString(expression.argumentExpression) === "getBuiltinModule";
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      return resolvesProcessBuiltinModuleLoader(expression.right, stack);
    }
    return false;
  };
  const isProcessExecPath = (node) => {
    const expression = unwrapExpression(node);
    if (ts.isPropertyAccessExpression(expression)) {
      return ts.isIdentifier(expression.expression)
        && expression.expression.text === "process"
        && expression.name.text === "execPath";
    }
    return ts.isElementAccessExpression(expression)
      && ts.isIdentifier(expression.expression)
      && expression.expression.text === "process"
      && evaluateString(expression.argumentExpression) === "execPath";
  };
  const dockerInvocationIsProven = (argvNode) => {
    const argv = resolveConstExpression(argvNode);
    if (!argv || !ts.isArrayLiteralExpression(argv)) return false;
    const elements = [...argv.elements];
    if (evaluateString(elements[0]) !== "exec") return false;
    let index = 1;
    while (evaluateString(elements[index]) === "-i") index += 1;
    while (evaluateString(elements[index]) === "-e") index += 2;
    if (!elements[index] || ts.isSpreadElement(elements[index])) return false;
    index += 1;
    return new Set(["psql", "pg_dump", "createdb", "dropdb", "redis-cli"])
      .has(evaluateString(elements[index]));
  };
  const childProcessInvocationIsProven = (exportedName, call) => {
    if (!["execFile", "execFileSync", "spawn", "spawnSync"].includes(exportedName)) return false;
    const executableNode = resolveConstExpression(call.arguments[0] || null);
    const argvNode = resolveConstExpression(call.arguments[1] || null);
    if (isProcessExecPath(executableNode)) {
      return false;
    }
    const executable = evaluateString(executableNode);
    if (executable === "docker") return dockerInvocationIsProven(call.arguments[1]);
    if (executable === "./scripts/backend-test.sh") {
      return /-migration-regression\.mjs$/.test(script)
        && ["execFileSync", "spawnSync"].includes(exportedName)
        && call.arguments.length >= 2;
    }
    if (executable === "./mvnw") {
      if (exportedName !== "spawn" || !argvNode || !ts.isArrayLiteralExpression(argvNode)) return false;
      const first = evaluateString(argvNode.elements[0]);
      const last = evaluateString(argvNode.elements[argvNode.elements.length - 1]);
      const second = unwrapExpression(argvNode.elements[1]);
      return (argvNode.elements.length === 1 && first === "spring-boot:run")
        || (script === "scripts/a119-full-isolation-regression.mjs"
          && argvNode.elements.length === 3
          && first === "-q"
          && ts.isTemplateExpression(second)
          && second.head.text === "-Dtest="
          && last === "test");
    }
    if (executable === "/usr/bin/unzip") {
      return script === "scripts/a143-master-data-import-regression.mjs"
        && exportedName === "execFileSync"
        && argvNode
        && ts.isArrayLiteralExpression(argvNode)
        && ["-Z1", "-p"].includes(evaluateString(argvNode.elements[0]));
    }
    if (executable === "git") {
      return script === "scripts/a153-6e-closure-regression.mjs" && exportedName === "execFileSync";
    }
    if (executable === "ps") {
      if (script !== "scripts/helpers/regression-process-tree.mjs"
        || exportedName !== "execFileSync"
        || !argvNode
        || !ts.isArrayLiteralExpression(argvNode)) {
        return false;
      }
      const argv = argvNode.elements.map((element) => evaluateString(element));
      return JSON.stringify(argv) === JSON.stringify([
        "-ww", "-axo", "pid=,ppid=,state=,lstart=,comm="
      ]);
    }
    return false;
  };

  const importedAuthLocals = new Map();
  const importedChildProcessLocals = new Map();
  const importedPlaywrightChromiumLocals = new Set();
  const calledAuthExports = new Set();
  const authCallSites = [];
  const constantStrings = new Set();
  const environmentReads = new Set();
  let unprovenCredentialTransportCount = 0;
  let unresolvedPostTransportCount = 0;
  let dynamicCodeExecutionCount = 0;
  let detachedProcessEscapeCount = 0;
  let unsafeChildProcessExecutionCount = 0;
  let unsafePlaywrightLaunchCount = 0;
  let authModuleReferenceCount = 0;
  let provenAuthModuleReferenceCount = 0;
  let unprovenAuthReferenceCount = 0;
  let unapprovedAuthExportCount = 0;
  let unapprovedPasswordFillTargetCount = 0;
  let rawSharedAdminCredentialObjectCount = 0;
  let rawSensitiveConfirmationTransportCount = 0;
  let unapprovedSharedAdminPasswordMaterialCount = 0;
  let unapprovedLocalModuleReferenceCount = 0;
  const isolatedPortProof = {
    randomListenCount: 0,
    addressDeclarationCount: 0,
    addressPortDeclarationCount: 0,
    reservedPortDeclarationCount: 0,
    backendPortEnvironmentCount: 0,
    loopbackBaseUrlCount: 0,
    returnPortCount: 0,
    invalidPortBindingCount: 0
  };
  const approvedPasswordFillTestIds = new Set([
    "security-current-password",
    "notification-provider-current-password"
  ]);
  const passwordFillTargetIsProven = (call) => {
    if (call.arguments.length !== 1) return false;
    const target = resolveConstExpression(call.arguments[0]);
    if (!target
      || !ts.isCallExpression(target)
      || target.arguments.length !== 1
      || !ts.isPropertyAccessExpression(target.expression)
      || !ts.isIdentifier(target.expression.expression)
      || target.expression.expression.text !== "page"
      || target.expression.name.text !== "getByTestId") {
      return false;
    }
    return approvedPasswordFillTestIds.has(evaluateString(target.arguments[0]));
  };
  const sharedAdminPasswordMaterialIsProven = (node) => {
    let current = node;
    while (current?.parent) {
      const parent = current.parent;
      if (ts.isCallExpression(parent)) {
        if (!ts.isIdentifier(parent.expression)) return false;
        const exportedName = importedAuthLocals.get(parent.expression.text);
        const passwordArgumentIndex = regressionAuthPasswordArgumentIndex.get(exportedName);
        return passwordArgumentIndex != null
          && parent.arguments[passwordArgumentIndex] === current
          && evaluateString(current) === "admin123";
      }
      current = parent;
    }
    return false;
  };
  const sharedAdminCredentialObjectIsPresent = (object) => {
    if (!ts.isObjectLiteralExpression(object)) return false;
    let username = null;
    let hasPassword = false;
    for (const property of object.properties) {
      if (ts.isPropertyAssignment(property)) {
        const name = ts.isComputedPropertyName(property.name)
          ? evaluateString(property.name.expression)
          : propertyName(property.name);
        if (name === "username") username = evaluateString(property.initializer);
        if (name === "password") hasPassword = true;
      } else if (ts.isShorthandPropertyAssignment(property)) {
        if (property.name.text === "username") username = evaluateString(property.name);
        if (property.name.text === "password") hasPassword = true;
      }
    }
    return username === "admin" && hasPassword;
  };
  const resolveLocalModulePath = (specifier) => {
    if (typeof specifier !== "string" || !specifier.startsWith(".")) return null;
    const pathOnly = specifier.split(/[?#]/, 1)[0];
    const normalizedScript = String(script).replaceAll("\\", "/");
    return path.posix.normalize(path.posix.join(path.posix.dirname(normalizedScript), pathOnly));
  };
  const resolvesRegressionAuthModule = (specifier) => {
    return resolveLocalModulePath(specifier) === "scripts/helpers/regression-auth.mjs";
  };
  const collectAuthImports = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const localModulePath = resolveLocalModulePath(specifier);
      if (isProhibitedDynamicExecutionModule(specifier)
        || specifier.includes("?")
        || specifier.includes("#")
        || /^(?:\/|file:|data:|https?:)/i.test(specifier)
        || (localModulePath && !approvedRegressionLocalModulePaths.has(localModulePath))) {
        unapprovedLocalModuleReferenceCount += 1;
      }
      if (resolvesRegressionAuthModule(specifier)) {
        authModuleReferenceCount += 1;
      }
      if (ts.isImportDeclaration(node) && specifier === regressionAuthModulePath) {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          provenAuthModuleReferenceCount += 1;
          for (const element of bindings.elements) {
            const exportedName = element.propertyName?.text || element.name.text;
            importedAuthLocals.set(element.name.text, exportedName);
            if (!regressionAuthAllowedManifestExports.has(exportedName)) {
              unapprovedAuthExportCount += 1;
            }
          }
        }
      }
      if (ts.isImportDeclaration(node) && ["node:child_process", "child_process"].includes(specifier)) {
        const bindings = node.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) {
          unsafeChildProcessExecutionCount += 1;
        } else {
          for (const element of bindings.elements) {
            importedChildProcessLocals.set(
              element.name.text,
              element.propertyName?.text || element.name.text
            );
          }
        }
      }
      if (ts.isImportDeclaration(node) && specifier === "playwright") {
        const bindings = node.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) {
          unsafePlaywrightLaunchCount += 1;
        } else {
          for (const element of bindings.elements) {
            if ((element.propertyName?.text || element.name.text) === "chromium") {
              importedPlaywrightChromiumLocals.add(element.name.text);
            }
          }
        }
      }
    } else if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      && node.arguments.length >= 0) {
      const specifier = node.arguments.length === 1 ? evaluateString(node.arguments[0]) : null;
      unapprovedLocalModuleReferenceCount += 1;
      if (resolvesRegressionAuthModule(specifier)) authModuleReferenceCount += 1;
    }
    ts.forEachChild(node, collectAuthImports);
  };
  collectAuthImports(sourceFile);
  const playwrightLaunchIsProven = (call) => {
    if (call.arguments.length !== 1) return false;
    const options = resolveConstExpression(call.arguments[0]);
    if (!options || !ts.isObjectLiteralExpression(options)) return false;
    const properties = new Map();
    for (const property of options.properties) {
      if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)) return false;
      const name = propertyName(property.name);
      if (!name || properties.has(name)) return false;
      properties.set(name, property.initializer);
    }
    if (properties.get("headless")?.kind !== ts.SyntaxKind.TrueKeyword) return false;
    if ([...properties.keys()].some((name) => !["headless", "args"].includes(name))) return false;
    if (!properties.has("args")) return properties.size === 1;
    const launchArguments = resolveConstExpression(properties.get("args"));
    return script === "scripts/a140-employee-financial-account-regression.mjs"
      && properties.size === 2
      && launchArguments
      && ts.isArrayLiteralExpression(launchArguments)
      && launchArguments.elements.length === 1
      && evaluateString(launchArguments.elements[0]) === "--disable-gpu";
  };
  const inspect = (node) => {
    const evaluated = evaluateString(node);
    if (evaluated != null) constantStrings.add(evaluated);
    if (evaluated === "admin123" && !sharedAdminPasswordMaterialIsProven(node)) {
      unapprovedSharedAdminPasswordMaterialCount += 1;
    }
    if ((ts.isIdentifier(node) && node.text === "getBuiltinModule")
      || evaluated === "getBuiltinModule") {
      dynamicCodeExecutionCount += 1;
    }
    if (ts.isCallExpression(node)
      && ((ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === "process"
        && ["binding", "_linkedBinding", "dlopen"].includes(node.expression.name.text))
        || (ts.isElementAccessExpression(node.expression)
          && ts.isIdentifier(node.expression.expression)
          && node.expression.expression.text === "process"
          && ["binding", "_linkedBinding", "dlopen"].includes(String(evaluateString(node.expression.argumentExpression) || ""))))) {
      dynamicCodeExecutionCount += 1;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const exported = importedAuthLocals.get(node.expression.text);
      if (exported) {
        calledAuthExports.add(exported);
        if (exported === "fillRegressionAdminPassword" && !passwordFillTargetIsProven(node)) {
          unapprovedPasswordFillTargetCount += 1;
        }
        authCallSites.push({
          exportedName: exported,
          argumentTexts: node.arguments.map((argument) => argument.getText(sourceFile)),
          argumentStrings: node.arguments.map((argument) => evaluateString(argument))
        });
      }
    }
    if (ts.isIdentifier(node) && importedAuthLocals.has(node.text)) {
      const directCall = ts.isCallExpression(node.parent) && node.parent.expression === node;
      const importBinding = ts.isImportSpecifier(node.parent);
      if (!directCall && !importBinding) unprovenAuthReferenceCount += 1;
    }
    if (ts.isIdentifier(node) && importedChildProcessLocals.has(node.text)) {
      const directCall = ts.isCallExpression(node.parent) && node.parent.expression === node;
      const importBinding = ts.isImportSpecifier(node.parent);
      if (!directCall && !importBinding) unsafeChildProcessExecutionCount += 1;
    }
    if (ts.isIdentifier(node) && importedPlaywrightChromiumLocals.has(node.text)) {
      const importBinding = ts.isImportSpecifier(node.parent);
      const launchReceiver = ts.isPropertyAccessExpression(node.parent)
        && node.parent.expression === node
        && node.parent.name.text === "launch"
        && ts.isCallExpression(node.parent.parent)
        && node.parent.parent.expression === node.parent;
      if (!importBinding && !launchReceiver) unsafePlaywrightLaunchCount += 1;
    }
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && importedPlaywrightChromiumLocals.has(node.expression.expression.text)
      && (node.expression.name.text !== "launch" || !playwrightLaunchIsProven(node))) {
      unsafePlaywrightLaunchCount += 1;
    }
    if (ts.isObjectLiteralExpression(node) && sharedAdminCredentialObjectIsPresent(node)) {
      rawSharedAdminCredentialObjectCount += 1;
    }
    if (isRawSensitiveConfirmationTransport(node, importedAuthLocals, evaluateString)) {
      rawSensitiveConfirmationTransportCount += 1;
    }
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === "server"
      && node.expression.name.text === "listen"
      && evaluateNumber(node.arguments[0]) === 0
      && evaluateString(node.arguments[1]) === "127.0.0.1") {
      isolatedPortProof.randomListenCount += 1;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const declarationName = node.name.text;
      const initializerText = node.initializer.getText(sourceFile).replace(/\s+/g, "");
      if (declarationName === "address" && initializerText === "server.address()") {
        isolatedPortProof.addressDeclarationCount += 1;
      }
      if (declarationName === "port") {
        if (/^typeofaddress===["']object["']&&address\?address\.port:0$/.test(initializerText)) {
          isolatedPortProof.addressPortDeclarationCount += 1;
        } else if (initializerText === "awaitreserveHttpPort()") {
          isolatedPortProof.reservedPortDeclarationCount += 1;
        } else {
          isolatedPortProof.invalidPortBindingCount += 1;
        }
      }
    }
    if (ts.isPropertyAssignment(node)) {
      const staticName = ts.isComputedPropertyName(node.name)
        ? evaluateString(node.name.expression)
        : propertyName(node.name);
      const initializerText = node.initializer.getText(sourceFile).replace(/\s+/g, "");
      if (staticName === "JDY_SERVER_PORT" && initializerText === "String(port)") {
        isolatedPortProof.backendPortEnvironmentCount += 1;
      }
      if (staticName === "baseUrl" && initializerText === "`http://127.0.0.1:${port}`") {
        isolatedPortProof.loopbackBaseUrlCount += 1;
      }
    }
    if (ts.isReturnStatement(node) && node.expression) {
      const returned = unwrapExpression(node.expression);
      if (returned && ts.isIdentifier(returned) && returned.text === "port") {
        isolatedPortProof.returnPortCount += 1;
      }
    }
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const left = unwrapExpression(node.left);
      if ((ts.isIdentifier(left) && left.text === "port")
        || (ts.isPropertyAccessExpression(left) && left.name.text === "baseUrl")) {
        isolatedPortProof.invalidPortBindingCount += 1;
      }
    }
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && ["Object", "Reflect"].includes(node.expression.expression.text)
      && ["assign", "defineProperty", "defineProperties", "set"].includes(node.expression.name.text)) {
      const targetText = node.arguments[0]?.getText(sourceFile).replace(/\s+/g, "") || "";
      const propertyText = node.arguments[1] ? evaluateString(node.arguments[1]) : null;
      if (/^(?:backend|spawnedBackend)$/.test(targetText)
        && (propertyText === "baseUrl"
          || node.arguments.slice(1).some((argument) => argument.getText(sourceFile).includes("baseUrl")))) {
        isolatedPortProof.invalidPortBindingCount += 1;
      }
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && ts.isIdentifier(unwrapExpression(node.operand))
      && unwrapExpression(node.operand).text === "port") {
      isolatedPortProof.invalidPortBindingCount += 1;
    }
    const environmentName = environmentReadName(node, evaluateString);
    if (environmentName) environmentReads.add(environmentName);
    if (isUnprovenCredentialTransport(node, evaluateString, resolveConstExpression, constInitializers)) {
      unprovenCredentialTransportCount += 1;
    }
    if (isUnresolvedPostTransport(node, evaluateString, resolveConstExpression)) {
      unresolvedPostTransportCount += 1;
    }
    if ((ts.isCallExpression(node) || ts.isNewExpression(node))
      && (resolvesDynamicExecutor(node.expression)
        || resolvesProcessBuiltinModuleLoader(node.expression))) {
      dynamicCodeExecutionCount += 1;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const childProcessExport = importedChildProcessLocals.get(node.expression.text);
      if (childProcessExport) {
        if (!childProcessInvocationIsProven(childProcessExport, node)) {
          unsafeChildProcessExecutionCount += 1;
        }
        for (const argument of node.arguments) {
          const options = resolveConstExpression(argument);
          if (!options || !ts.isObjectLiteralExpression(options)) continue;
          for (const property of options.properties) {
            if (ts.isPropertyAssignment(property)
              && propertyName(property.name) === "shell"
              && property.initializer.kind !== ts.SyntaxKind.FalseKeyword) {
              unsafeChildProcessExecutionCount += 1;
            }
          }
        }
      }
    }
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "unref") {
      const receiver = resolveConstExpression(node.expression.expression);
      if (receiver
        && ts.isCallExpression(receiver)
        && ts.isIdentifier(receiver.expression)
        && importedChildProcessLocals.has(receiver.expression.text)) {
        detachedProcessEscapeCount += 1;
      }
    }
    if (ts.isPropertyAssignment(node)) {
      const staticName = ts.isComputedPropertyName(node.name)
        ? evaluateString(node.name.expression)
        : propertyName(node.name);
      if (staticName === "detached" && node.initializer.kind !== ts.SyntaxKind.FalseKeyword) {
        detachedProcessEscapeCount += 1;
      }
    }
    ts.forEachChild(node, inspect);
  };
  inspect(sourceFile);
  const isolatedBackendPortBindingProven = isolatedPortProof.randomListenCount === 1
    && isolatedPortProof.addressDeclarationCount === 1
    && isolatedPortProof.addressPortDeclarationCount === 1
    && isolatedPortProof.reservedPortDeclarationCount === 1
    && isolatedPortProof.backendPortEnvironmentCount === 1
    && isolatedPortProof.loopbackBaseUrlCount === 1
    && isolatedPortProof.returnPortCount === 1
    && isolatedPortProof.invalidPortBindingCount === 0;
  return {
    parseDiagnostics,
    importedAuthLocals,
    calledAuthExports,
    authCallSites,
    constantStrings: [...constantStrings],
    environmentReads: [...environmentReads],
    unprovenCredentialTransportCount,
    unresolvedPostTransportCount,
    dynamicCodeExecutionCount,
    detachedProcessEscapeCount,
    unsafeChildProcessExecutionCount,
    unsafePlaywrightLaunchCount,
    authModuleReferenceCount,
    provenAuthModuleReferenceCount,
    unprovenAuthReferenceCount,
    unapprovedAuthExportCount,
    unapprovedPasswordFillTargetCount,
    rawSharedAdminCredentialObjectCount,
    rawSensitiveConfirmationTransportCount,
    unapprovedSharedAdminPasswordMaterialCount,
    unapprovedLocalModuleReferenceCount,
    isolatedBackendPortBindingProven
  };
}

function isUnresolvedPostTransport(node, evaluateString, resolveConstExpression) {
  if (!ts.isCallExpression(node)) return false;
  let endpoint = null;
  let method = "";
  if (ts.isIdentifier(node.expression) && node.expression.text === "fetch") {
    endpoint = resolveConstExpression(node.arguments[0] || null);
    const options = resolveConstExpression(node.arguments[1] || null);
    if (options && ts.isObjectLiteralExpression(options)) {
      for (const property of options.properties) {
        if (ts.isPropertyAssignment(property) && propertyName(property.name) === "method") {
          method = String(evaluateString(property.initializer) || "").toUpperCase();
        }
      }
    }
  } else if (ts.isPropertyAccessExpression(node.expression)
    && ["post", "request"].includes(node.expression.name.text)) {
    endpoint = resolveConstExpression(node.arguments[0] || null);
    method = node.expression.name.text === "post" ? "POST" : "";
  }
  return Boolean(endpoint)
    && method === "POST"
    && evaluateString(endpoint) == null;
}

function isRawSensitiveConfirmationTransport(node, importedAuthLocals, evaluateString) {
  if (!ts.isCallExpression(node)) return false;
  if (ts.isIdentifier(node.expression)
    && importedAuthLocals.get(node.expression.text) === "requestWithRegressionAdminConfirmation") {
    return false;
  }
  return node.arguments.some((argument) => {
    const target = evaluateString(argument);
    if (typeof target !== "string") return false;
    const lifecycleTarget = /^https?:\/\/[^/]+\/api\/document-lifecycle\//.test(target)
      || /^\/api\/document-lifecycle\//.test(target);
    return lifecycleTarget && /\/void(?:$|[?#])/.test(target);
  });
}

function isUnprovenCredentialTransport(node, evaluateString, resolveConstExpression, constInitializers) {
  if (!ts.isCallExpression(node)) return false;
  let endpoint = null;
  let payload = null;
  let method = "";
  if (ts.isIdentifier(node.expression) && node.expression.text === "fetch") {
    endpoint = resolveConstExpression(node.arguments[0] || null);
    const options = resolveConstExpression(node.arguments[1] || null);
    if (options && ts.isObjectLiteralExpression(options)) {
      for (const property of options.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const name = propertyName(property.name);
        if (name === "method") method = String(evaluateString(property.initializer) || "").toUpperCase();
        if (name === "body") payload = resolveConstExpression(property.initializer);
      }
    }
  } else if (ts.isPropertyAccessExpression(node.expression)
    && ["post", "request"].includes(node.expression.name.text)) {
    endpoint = resolveConstExpression(node.arguments[0] || null);
    payload = resolveConstExpression(node.arguments[1] || null);
    method = node.expression.name.text === "post" ? "POST" : "";
  }
  if (!endpoint || method !== "POST" || evaluateString(endpoint) != null) return false;
  const words = new Set();
  let hasComputedProperty = false;
  const collectWords = (candidate, stack = new Set()) => {
    if (!candidate) return;
    const evaluated = evaluateString(candidate);
    if (evaluated != null) words.add(evaluated);
    if (ts.isIdentifier(candidate)) words.add(candidate.text);
    if (ts.isIdentifier(candidate)
      && constInitializers.has(candidate.text)
      && !stack.has(candidate.text)) {
      collectWords(constInitializers.get(candidate.text), new Set([...stack, candidate.text]));
    }
    if (ts.isPropertyAccessExpression(candidate)) words.add(candidate.name.text);
    if (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) {
      words.add(propertyName(candidate.name));
      if (ts.isComputedPropertyName(candidate.name)) hasComputedProperty = true;
    }
    ts.forEachChild(candidate, (child) => collectWords(child, stack));
  };
  collectWords(endpoint);
  if (payload) collectWords(payload);
  const normalized = [...words].map((word) => String(word || "").toLowerCase());
  const hasUsername = normalized.some((word) => /(?:^|_)(?:user(?:name)?|login)(?:$|_)/.test(word)
    || word.includes("username"));
  const hasPassword = normalized.some((word) => word.includes("password") || word.includes("passwd"));
  const hasCredentialProvider = normalized.some((word) => /credential|loginpayload|authpayload/.test(word));
  return hasComputedProperty || (hasUsername && hasPassword) || hasCredentialProvider;
}

function propertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return "";
}

function functionReturnExpression(node) {
  if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) return node.body;
  if (!node.body || !ts.isBlock(node.body)) return null;
  const statements = node.body.statements.filter((statement) => !ts.isEmptyStatement(statement));
  return statements.length === 1 && ts.isReturnStatement(statements[0]) ? statements[0].expression || null : null;
}

function unwrapExpression(node) {
  let current = node;
  while (current && (ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || (typeof ts.isSatisfiesExpression === "function" && ts.isSatisfiesExpression(current)))) {
    current = current.expression;
  }
  return current;
}

function environmentReadName(node, evaluateString) {
  if (ts.isPropertyAccessExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === "process"
    && node.expression.name.text === "env") {
    return node.name.text;
  }
  if (ts.isElementAccessExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === "process"
    && node.expression.name.text === "env") {
    return evaluateString(node.argumentExpression);
  }
  return null;
}

function stripJavaScriptCommentsWithParser(source) {
  const output = [...source];
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (![ts.SyntaxKind.SingleLineCommentTrivia, ts.SyntaxKind.MultiLineCommentTrivia].includes(token)) continue;
    for (let index = scanner.getTokenPos(); index < scanner.getTextPos(); index += 1) {
      if (output[index] !== "\n" && output[index] !== "\r") output[index] = " ";
    }
  }
  return output.join("");
}

function staticRegressionLocalDependencies(script, source) {
  const sourceFile = ts.createSourceFile(script, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if ((sourceFile.parseDiagnostics || []).length > 0) {
    throw new Error(`Audited regression helper cannot be parsed: ${script}`);
  }
  const dependencies = new Set();
  const resolve = (specifier) => {
    if (!specifier.startsWith(".")) return;
    if (specifier.includes("?") || specifier.includes("#")) {
      throw new Error(`Audited regression helper dependency cannot use query/hash aliases: ${script}`);
    }
    dependencies.add(path.posix.normalize(path.posix.join(path.posix.dirname(script), specifier)));
  };
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)) {
      resolve(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const argument = node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])
        ? node.arguments[0].text
        : "";
      if (!argument || argument.startsWith(".")) {
        throw new Error(`Audited regression helper cannot use runtime local module loading: ${script}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...dependencies].sort();
}

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

export async function runRegressionPreflight({ rootDir, tier, scripts, adminFixtureOptions = {} }) {
  const redisTarget = assertMainRegressionRedisTarget();
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
  const adminCredentialContract = classifyRunScopedAdminUsage(sources);
  if (adminCredentialContract.violations.length > 0) {
    throw new Error(`Full regression contains shared-admin usages outside the run-scoped contract: ${JSON.stringify(adminCredentialContract.violations)}`);
  }
  const auditedDependencySources = await loadAuditedRegressionLocalDependencySources(rootDir);
  const auditedDependencyContract = classifyRunScopedAdminUsage(auditedDependencySources);
  if (auditedDependencyContract.violations.length > 0) {
    throw new Error(`Audited regression helper dependency left the ADMIN credential contract: ${JSON.stringify(auditedDependencyContract.violations)}`);
  }
  adminCredentialContract.auditedLocalDependencies = auditedDependencyContract.scannedScripts;

  const directHealth = await requireDrainedRegressionHealth(
    `${apiBase}/api/system/health`,
    "direct backend health"
  );
  if (directHealth.testInventoryAdjustmentApi !== true) {
    throw new Error("Regression backend must expose the controlled BLD-TEST inventory fixture capability");
  }
  if (directHealth.regressionSharedAdminLoginGuard !== true) {
    throw new Error("Regression backend must prove the main shared-admin login guard is active for this suite lock");
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
    if (frontendHealth.regressionSharedAdminLoginGuard !== true) {
      throw new Error("Frontend proxy backend does not expose the active shared-admin login guard");
    }
    if (Number(frontendHealth.regressionSharedAdminLoginActiveCount) !== 0) {
      throw new Error("Frontend proxy backend did not preserve the drained shared-admin login boundary");
    }
  }

  const sharedBaseline = await readSharedRegressionBaseline(adminFixtureOptions);
  const sharedAdminSessionInvariant = captureUserSessionInvariant("admin");
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
    sharedAdminLoginGuard: true,
    tenant: sharedBaseline.tenant,
    user: {
      mode: adminFixtureOptions.retainQuarantinedIdentity === true ? "suite-tombstone-admin" : "run-unique-admin",
      roleCode: sharedBaseline.user.roleCode,
      fixtureUserId: sharedBaseline.fixtureUserId,
      fixtureRequestFenceGeneration: sharedBaseline.fixtureRequestFenceGeneration
    },
    fixtureControl: adminFixtureOptions.fixtureLedgerWriter
      ? {
          fixtureLedgerWriter: adminFixtureOptions.fixtureLedgerWriter,
          fixtureLedgerRunId: adminFixtureOptions.fixtureLedgerRunId,
          autoManageRequestFence: true
        }
      : null,
    sessionIsolation: sharedBaseline.sessionIsolation,
    requiredAdminPermissions: sharedBaseline.permissionCatalogCodes,
    permissionCatalogCodes: sharedBaseline.permissionCatalogCodes,
    adminPermissionCodes: sharedBaseline.adminPermissionCodes,
    sessionPermissionCodes: sharedBaseline.sessionPermissionCodes,
    rolePermissionMatrix: sharedBaseline.rolePermissionMatrix,
    securitySettings: sharedBaseline.securitySettings,
    redisTarget,
    sharedAdminSessionInvariant,
    adminCredentialContract,
    roleMutationScripts,
    directSqlRoleMutationScripts,
    securityMutationScripts,
    sharedStateMutationScripts,
    cleanWorktree
  };
}

export async function assertSharedRegressionBaseline(preflight, label = "postflight") {
  const current = await readSharedRegressionBaseline(preflight.fixtureControl || {});
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
  try {
    await assertSharedAdminSessionInvariant(preflight, label);
  } catch (error) {
    changes.sharedAdminSession = error instanceof Error ? error.message : String(error);
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

export async function assertSharedAdminSessionInvariant(preflight, label = "shared admin invariant") {
  const before = preflight.sharedAdminSessionInvariant;
  const redisTarget = assertMainRegressionRedisTarget();
  if (!sameJson(preflight.redisTarget, redisTarget)
    || !sameJson(before?.redis?.target, redisTarget)) {
    throw new Error(`${label} Redis target selector changed or was not bound by preflight`);
  }
  const current = captureUserSessionInvariant("admin");
  if (!sameJson(current.redis?.target, redisTarget)) {
    throw new Error(`${label} Redis invariant was captured from the wrong target`);
  }
  if (!before || !sameJson(before.database, current.database)) {
    throw new Error(`${label} detected shared admin database-session drift or concurrent interference`);
  }
  const observedAtEpochMs = Number(current.redis?.capturedAtEpochMs);
  const primaryEvolution = assertRedisDigestEvolution({
    before: before.redis?.primarySessions,
    current: current.redis?.primarySessions,
    digestField: "keyDigest",
    expiryField: "expiresAtEpochMs",
    observedAtEpochMs,
    label: `${label} primary Redis session`
  });
  const relatedKeyEvolution = assertRedisDigestEvolution({
    before: before.redis?.relatedKeys,
    current: current.redis?.relatedKeys,
    digestField: "keyDigest",
    expiryField: "expiresAtEpochMs",
    observedAtEpochMs,
    label: `${label} related Redis key`
  });
  const expirationMemberEvolution = assertRedisDigestEvolution({
    before: before.redis?.expirationMembers,
    current: current.redis?.expirationMembers,
    digestField: "memberDigest",
    expiryField: "logicalExpiresAtEpochMs",
    observedAtEpochMs,
    label: `${label} Redis expiration member`
  });
  return {
    checkedAt: new Date().toISOString(),
    database: current.database,
    redis: current.redis,
    naturallyExpiredRedisSessions: primaryEvolution.expired,
    naturallyExpiredRelatedKeys: relatedKeyEvolution.expired,
    naturallyExpiredExpirationMembers: expirationMemberEvolution.expired
  };
}

export function assertRedisDigestEvolution({
  before,
  current,
  digestField,
  expiryField,
  observedAtEpochMs,
  label
}) {
  if (!Array.isArray(before) || !Array.isArray(current) || !Number.isFinite(observedAtEpochMs)) {
    throw new Error(`${label} invariant metadata is incomplete`);
  }
  const baseline = new Map(before.map((entry) => [entry?.[digestField], entry]));
  const currentDigests = new Set(current.map((entry) => entry?.[digestField]));
  if (baseline.has(undefined) || currentDigests.has(undefined)
    || baseline.size !== before.length || currentDigests.size !== current.length) {
    throw new Error(`${label} invariant metadata is ambiguous`);
  }
  const added = [...currentDigests].filter((digest) => !baseline.has(digest));
  if (added.length > 0) {
    throw new Error(`${label} detected added state or concurrent interference`);
  }
  const earlyMissing = [];
  const changed = [];
  let expired = 0;
  for (const [digest, entry] of baseline) {
    if (currentDigests.has(digest)) {
      const currentEntry = current.find((candidate) => candidate?.[digestField] === digest);
      if (entry?.contentDigest !== undefined && currentEntry?.contentDigest !== entry.contentDigest) {
        changed.push(digest);
      }
      const beforeExpiry = entry?.[expiryField];
      const currentExpiry = currentEntry?.[expiryField];
      const bothFinite = Number.isFinite(beforeExpiry) && Number.isFinite(currentExpiry);
      if ((beforeExpiry == null) !== (currentExpiry == null)
        || (bothFinite && Number(beforeExpiry) !== Number(currentExpiry))) {
        changed.push(digest);
      }
      continue;
    }
    const expiresAtEpochMs = entry?.[expiryField];
    if (!Number.isFinite(expiresAtEpochMs) || observedAtEpochMs < Number(expiresAtEpochMs)) {
      earlyMissing.push(digest);
    } else {
      expired += 1;
    }
  }
  if (earlyMissing.length > 0) {
    throw new Error(`${label} disappeared before its captured expiry boundary`);
  }
  if (changed.length > 0) {
    throw new Error(`${label} content or expiry boundary changed`);
  }
  return { expired };
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

async function readSharedRegressionBaseline(adminFixtureOptions = {}) {
  const fixture = createIsolatedAdminSessionFixture(apiBase, { label: "preflight", ...adminFixtureOptions });
  let baseline = null;
  let primaryError = null;
  try {
    if (adminFixtureOptions.fixtureLedgerWriter) {
      await fixture.openRequestFence();
    }
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
  return {
    ...baseline,
    fixtureUserId: fixture.userId,
    fixtureRequestFenceGeneration: fixture.requestFenceGeneration,
    sessionIsolation: {
      mode: adminFixtureOptions.retainQuarantinedIdentity === true ? "suite-tombstone-admin" : "run-unique-admin",
      cleanupVerified: true
    }
  };
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

async function requireDrainedRegressionHealth(url, label) {
  const deadline = Date.now() + 30_000;
  while (true) {
    const health = await requireJson(url, {}, label);
    if (health.regressionSharedAdminLoginGuard !== true) {
      throw new Error("Regression backend must prove the main shared-admin login guard is active for this suite lock");
    }
    const activeCount = Number(health.regressionSharedAdminLoginActiveCount);
    if (!Number.isSafeInteger(activeCount) || activeCount < 0) {
      throw new Error("Regression backend health returned an invalid shared-admin login drain count");
    }
    if (activeCount === 0) return health;
    if (Date.now() >= deadline) {
      throw new Error(`Regression shared-admin login drain timed out with ${activeCount} active request(s)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
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
