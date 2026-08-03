#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  classifyRunScopedAdminUsage,
  loadAuditedRegressionLocalDependencySources
} from "./helpers/regression-preflight.mjs";
import { loadRegressionManifest } from "./validate-regression-manifest.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");

function classify(script, source) {
  return classifyRunScopedAdminUsage([{ script, source }]);
}

let adversarialCases = 0;
function assertBlocked(name, source, expectedReason) {
  const script = `scripts/contract-${name}.mjs`;
  const result = classify(script, source);
  assert(
    result.violations.some((violation) => violation.script === script && violation.reason.includes(expectedReason)),
    `${name} must fail closed: ${JSON.stringify(result)}`
  );
  adversarialCases += 1;
}

assertBlocked("charcode", `
  const username = String.fromCharCode(97, 100, 109, 105, 110);
  const password = String.fromCharCode(97, 100, 109, 105, 110, 49, 50, 51);
  const segment = () => "login";
  await fetch(\`http://127.0.0.1:8080/api/system/\${segment()}\`, {
    method: "POST",
    body: JSON.stringify({ username, password })
  });
`, "raw login sink");

assertBlocked("computed-env", `
  const endpoint = "/api/system/" + "login";
  await fetch(endpoint, {
    method: "POST",
    body: JSON.stringify({
      username: process.env["JDY_" + "ADMIN_USER"],
      password: process.env["JDY_" + "ADMIN_PASSWORD"]
    })
  });
`, "environment source");

assertBlocked("base64", `
  const decode = value => Buffer.from(value, "base64").toString();
  await fetch("http://127.0.0.1:8080" + decode("L2FwaS9zeXN0ZW0vbG9naW4="), {
    method: "POST",
    body: JSON.stringify({
      username: decode("YWRtaW4="),
      password: decode("YWRtaW4xMjM=")
    })
  });
`, "credential-shaped POST");

assertBlocked("computed-properties", `
  const decode = value => Buffer.from(value, "base64").toString();
  const endpoint = decode("L2FwaS9zeXN0ZW0vbG9naW4=");
  const username = decode("YWRtaW4=");
  const password = decode("YWRtaW4xMjM=");
  await fetch("http://127.0.0.1:8080" + endpoint, {
    method: "POST",
    body: JSON.stringify({
      [decode("dXNlcm5hbWU=")]: username,
      [decode("cGFzc3dvcmQ=")]: password
    })
  });
`, "credential-shaped POST");

assertBlocked("indirect-provider", `
  function getEndpoint() { return unknownEndpoint(); }
  function getCredentials() { return unknownCredentials(); }
  await fetch(getEndpoint(), {
    method: "POST",
    body: JSON.stringify(getCredentials())
  });
`, "credential-shaped POST");

assertBlocked("dynamic-eval", `
  const execute = eval;
  eval(execute);
`, "dynamic code execution");

assertBlocked("detached-process", `
  import { spawn } from "node:child_process";
  const key = "det" + "ached";
  spawn(process.execPath, ["worker.mjs"], { [key]: true, stdio: "ignore" }).unref();
`, "detached process escapes");

assertBlocked("unref-process", `
  import { spawn } from "node:child_process";
  const child = spawn("./mvnw", ["spring-boot:run"], { detached: false, stdio: "ignore" });
  child.unref();
`, "detached process escapes");

assertBlocked("default-child-process", `
  import childProcess from "node:child_process";
  childProcess.spawn(process.execPath, ["/tmp/unreviewed.mjs"]);
`, "unsafe child_process execution");

assertBlocked("raw-process-binding", `
  process.binding("spawn_sync");
`, "child-process guard capability");

assertBlocked("prototype-spawn", `
  import { ChildProcess } from "node:child_process";
  ChildProcess.prototype.spawn({ file: process.execPath, args: [process.execPath] });
`, "child-process guard capability");

assertBlocked("runner-signal", `
  process.kill(process.ppid, "SIGKILL");
`, "child-process guard capability");

assertBlocked("guard-signing-capability", `
  const descriptor = process.env.JDY_REGRESSION_DETACHED_SPAWN_SIGNING_KEY_FD;
`, "child-process guard capability");

assertBlocked("unsafe-playwright-executable", `
  import { chromium } from "playwright";
  await chromium.launch({ headless: true, executablePath: "/tmp/chromium" });
`, "canonical headless Playwright launch options");

assertBlocked("unsafe-playwright-environment", `
  import { chromium } from "playwright";
  await chromium.launch({ headless: true, env: { BASH_ENV: "/tmp/hook" } });
`, "canonical headless Playwright launch options");

assertBlocked("canonical-admin-variant-raw-login", `
  await fetch("http://127.0.0.1:8080/api/system/login", {
    method: "POST",
    body: JSON.stringify({ username: " ADMIN ", password: "admin123" })
  });
`, "raw login sink");

assertBlocked("lifecycle-confirmation-aliases", `
  const username = "admin";
  const password = "admin123";
  await fetch("/api/document-lifecycle/salesOrder/SO-1/void", {
    method: "POST",
    body: JSON.stringify({ username, password, reason: "contract" })
  });
`, "raw shared admin credential payload");

assertBlocked("lifecycle-confirmation-from-entries", `
  const payload = Object.fromEntries([
    ["username", "admin"],
    ["password", "admin123"],
    ["reason", "contract"]
  ]);
  await fetch("http://127.0.0.1:8080/api/document-lifecycle/salesOrder/SO1/void", {
    method: "POST",
    body: JSON.stringify(payload)
  });
`, "must use the reviewed auth confirmation helper");

assertBlocked("lifecycle-confirmation-nested-request", `
  const req = {
    endpoint: "/api/document-lifecycle/salesOrder/SO1/void",
    options: {
      method: "POST",
      body: JSON.stringify(Object.fromEntries([
        ["username", "admin"],
        ["password", "admin123"]
      ]))
    }
  };
  await fetch(req.endpoint, req.options);
`, "must use the reviewed auth confirmation helper");

assertBlocked("lifecycle-confirmation-runtime-branch", `
  const endpoint = "/api/document-lifecycle/salesOrder/SO1/" + (Date.now() > 0 ? "void" : "close");
  const method = Date.now() > 0 ? "POST" : "GET";
  const payload = Object.fromEntries([["username", "admin"], ["password", "admin123"]]);
  await fetch(endpoint, { method, body: JSON.stringify(payload) });
`, "must use the reviewed auth confirmation helper");

assertBlocked("lifecycle-confirmation-fetch-alias", `
  const req = {
    endpoint: "/api/document-lifecycle/salesOrder/SO1/void",
    options: {
      method: "POST",
      body: JSON.stringify(Object.fromEntries([["username", "admin"], ["password", "admin123"]]))
    }
  };
  const transmit = fetch;
  await transmit(req.endpoint, req.options);
`, "must use the reviewed auth confirmation helper");

assertBlocked("lifecycle-confirmation-reflect-apply", `
  const req = {
    endpoint: "/api/document-lifecycle/salesOrder/SO1/void",
    options: {
      method: "POST",
      body: JSON.stringify(Object.fromEntries([["username", "admin"], ["password", "admin123"]]))
    }
  };
  await Reflect.apply(fetch, null, [req.endpoint, req.options]);
`, "must use the reviewed auth confirmation helper");

assertBlocked("lifecycle-token-split-fetch-alias", `
  const routeFamily = Date.now() > 0 ? "document-lifecycle" : "noop";
  const action = Date.now() > 0 ? "void" : "read";
  const endpoint = "/api/" + routeFamily + "/salesOrder/SO1/" + action;
  const options = {
    method: "POST",
    body: JSON.stringify(Object.fromEntries([["username", "admin"], ["password", "admin123"]]))
  };
  const transmit = fetch;
  await transmit(endpoint, options);
`, "shared admin password material");

assertBlocked("login-token-split-fetch-alias", `
  const family = Date.now() > 0 ? "system" : "noop";
  const action = Date.now() > 0 ? "login" : "read";
  const endpoint = "/api/" + family + "/" + action;
  const options = {
    method: "POST",
    body: JSON.stringify(Object.fromEntries([["username", "admin"], ["password", "admin123"]]))
  };
  const transmit = fetch;
  await transmit(endpoint, options);
`, "shared admin password material");

assertBlocked("login-token-split-admin-environment", `
  const family = Date.now() > 0 ? "system" : "noop";
  const action = Date.now() > 0 ? "login" : "read";
  const endpoint = "/api/" + family + "/" + action;
  await fetch(endpoint, {
    method: "POST",
    body: JSON.stringify({
      username: process.env.JDY_ADMIN_USER,
      password: process.env.JDY_ADMIN_PASSWORD
    })
  });
`, "shared admin credential environment source");

assertBlocked("atob-login-with-helper-decoy", `
  import { loginAsAdmin } from "./helpers/regression-auth.mjs";
  if (Date.now() < 0) await loginAsAdmin(page);
  const endpoint = atob("aHR0cDovLzEyNy4wLjAuMTo4MDgwL2FwaS9zeXN0ZW0vbG9naW4=");
  const username = atob("YWRtaW4=");
  const password = atob("YWRtaW4xMjM=");
  await fetch(endpoint, { method: "POST", body: JSON.stringify({ username, password }) });
`, "raw login sink");

assertBlocked("curl-process-login", `
  import { execFileSync } from "node:child_process";
  import { loginApi } from "./helpers/regression-auth.mjs";
  if (Date.now() < 0) await loginApi("http://127.0.0.1:8080", "admin", "admin123", "BLD-TEST");
  execFileSync(["c", "url"].join(""), ["-d", atob("eyJ1c2VybmFtZSI6ImFkbWluIn0="), atob("aHR0cDovLzEyNy4wLjAuMTo4MDgwL2FwaS9zeXN0ZW0vbG9naW4=")]);
`, "unsafe child_process execution");

assertBlocked("node-eval-process", `
  import { spawn } from "node:child_process";
  import { loginApi } from "./helpers/regression-auth.mjs";
  if (Date.now() < 0) await loginApi("http://127.0.0.1:8080", "admin", "admin123", "BLD-TEST");
  spawn(process.execPath, ["--eval", atob("Y29uc29sZS5sb2coMSk=")]);
`, "unsafe child_process execution");

assertBlocked("shell-process", `
  import { execFileSync } from "node:child_process";
  execFileSync("printf", ["ok"], { shell: true });
`, "unsafe child_process execution");

assertBlocked("aliased-curl-process", `
  import { execFileSync } from "node:child_process";
  import { loginApi } from "./helpers/regression-auth.mjs";
  if (Date.now() < 0) await loginApi("http://127.0.0.1:8080", "admin", "admin123", "BLD-TEST");
  const run = execFileSync;
  run(atob("Y3VybA=="), [atob("aHR0cDovLzEyNy4wLjAuMTo4MDgwL2FwaS9zeXN0ZW0vbG9naW4=")]);
`, "unsafe child_process execution");

assertBlocked("called-curl-process", `
  import { execFileSync } from "node:child_process";
  execFileSync.call(null, atob("Y3VybA=="), ["http://127.0.0.1:8080/api/system/login"]);
`, "unsafe child_process execution");

assertBlocked("env-curl-process", `
  import { spawnSync } from "node:child_process";
  spawnSync("/usr/bin/env", [atob("Y3VybA=="), "http://127.0.0.1:8080/api/system/login"]);
`, "unsafe child_process execution");

assertBlocked("python-process", `
  import { execFileSync } from "node:child_process";
  execFileSync("python3", ["-c", atob("aW1wb3J0IHVybGxpYi5yZXF1ZXN0")]);
`, "unsafe child_process execution");

assertBlocked("computed-node-eval-process", `
  import { spawn } from "node:child_process";
  spawn(process["exec" + "Path"], [atob("LS1ldmFs"), atob("Y29uc29sZS5sb2coMSk=")]);
`, "unsafe child_process execution");

assertBlocked("obfuscated-node-eval-flag", `
  import { spawn } from "node:child_process";
  const flag = atob("LWU=");
  spawn(process.execPath, [flag, atob("Y29uc29sZS5sb2coMSk=")]);
`, "unsafe child_process execution");

assertBlocked("eval-alias", `
  const execute = eval;
  execute(Buffer.from("Y29uc29sZS5sb2coMSk=", "base64").toString());
`, "dynamic code execution");

assertBlocked("function-alias", `
  const Factory = Function;
  Factory(Buffer.from("cmV0dXJuIDE=", "base64").toString())();
`, "dynamic code execution");

assertBlocked("global-eval", `
  globalThis["ev" + "al"](Buffer.from("Y29uc29sZS5sb2coMSk=", "base64").toString());
`, "dynamic code execution");

assertBlocked("node-vm", `
  import vm from "node:vm";
  import { loginApi } from "./helpers/regression-auth.mjs";
  if (Date.now() < 0) await loginApi("http://127.0.0.1:8080", "admin", "admin123", "BLD-TEST");
  vm.runInNewContext(Buffer.from("YXdhaXQgZmV0Y2goJy9hcGkvc3lzdGVtL2xvZ2luJyk=", "base64").toString());
`, "audited static regression module set");

assertBlocked("worker-threads", `
  import { Worker } from "node:worker_threads";
  import { loginApi } from "./helpers/regression-auth.mjs";
  if (Date.now() < 0) await loginApi("http://127.0.0.1:8080", "admin", "admin123", "BLD-TEST");
  new Worker(Buffer.from("Y29uc29sZS5sb2coMSk=", "base64").toString(), { eval: true });
`, "audited static regression module set");

assertBlocked("node-cluster", `
  import cluster from "node:cluster";
  import { loginApi } from "./helpers/regression-auth.mjs";
  if (Date.now() < 0) await loginApi("http://127.0.0.1:8080", "admin", "admin123", "BLD-TEST");
  cluster.fork();
`, "audited static regression module set");

assertBlocked("raw-process-kill", `
  process._kill(process.ppid, 0);
`, "runner child-process guard capability");

assertBlocked("debug-process", `
  process._debugProcess(process.ppid);
`, "runner child-process guard capability");

assertBlocked("process-exit", `
  process.exit(0);
`, "runner child-process guard capability");

assertBlocked("process-abort", `
  process.abort();
`, "runner child-process guard capability");

assertBlocked("process-really-exit", `
  process.reallyExit(0);
`, "runner child-process guard capability");

assertBlocked("validator-path-replacement", `
  import { execFileSync } from "node:child_process";
  import { readFileSync, writeFileSync } from "node:fs";
  import path from "node:path";
  const target = path.join(process.cwd(), "scripts/validate-regression-manifest.mjs");
  const original = readFileSync(target);
  try {
    writeFileSync(target, "console.log('replaced')");
    execFileSync(process.execPath, [target]);
  } finally {
    writeFileSync(target, original);
  }
`, "unsafe child_process execution");

assertBlocked("process-builtin-module", `
  import { loginApi } from "./helpers/regression-auth.mjs";
  if (Date.now() < 0) await loginApi("http://127.0.0.1:8080", "admin", "admin123", "BLD-TEST");
  const load = process["get" + "BuiltinModule"];
  const vm = load("vm");
  vm.runInNewContext(Buffer.from("Y29uc29sZS5sb2coMSk=", "base64").toString());
`, "dynamic code execution");

assertBlocked("destructured-builtin-module", `
  import { loginApi } from "./helpers/regression-auth.mjs";
  if (Date.now() < 0) await loginApi("http://127.0.0.1:8080", "admin", "admin123", "BLD-TEST");
  const { getBuiltinModule } = process;
  getBuiltinModule("vm").runInNewContext("1 + 1");
`, "dynamic code execution");

assertBlocked("reflected-builtin-module", `
  import { loginApi } from "./helpers/regression-auth.mjs";
  if (Date.now() < 0) await loginApi("http://127.0.0.1:8080", "admin", "admin123", "BLD-TEST");
  const p = process;
  Reflect.get(p, "get" + "BuiltinModule")("vm").runInNewContext("1 + 1");
`, "dynamic code execution");

assertBlocked("credential-options-dataflow", `
  const endpoint = Buffer.from("L2FwaS9zeXN0ZW0vbG9naW4=", "base64").toString();
  const username = String.fromCharCode(97, 100, 109, 105, 110);
  const password = String.fromCharCode(97, 100, 109, 105, 110, 49, 50, 51);
  const body = Object.fromEntries([["username", username], ["password", password]]);
  const opts = { method: ["P", "O", "S", "T"].join(""), body: JSON.stringify(body) };
  await fetch(endpoint, opts);
`, "raw login sink");

assertBlocked("anonymous-base64-payload", `
  const endpoint = Buffer.from("aHR0cDovLzEyNy4wLjAuMTo4MDgwL2FwaS9zeXN0ZW0vbG9naW4=", "base64").toString();
  const entries = [
    [Buffer.from("dXNlcm5hbWU=", "base64").toString(), Buffer.from("YWRtaW4=", "base64").toString()],
    [Buffer.from("cGFzc3dvcmQ=", "base64").toString(), Buffer.from("YWRtaW4xMjM=", "base64").toString()]
  ];
  await fetch(endpoint, {
    method: "POST",
    body: JSON.stringify(Object.fromEntries(entries))
  });
`, "raw login sink");

assertBlocked("auth-helper-alias", `
  import { loginApi } from "./helpers/regression-auth.mjs";
  const enter = loginApi;
  await enter("http://127.0.0.1:8080", "admin", "admin123", "BLD-TEST");
`, "cannot be aliased");

assertBlocked("auth-helper-query-import", `
  import { loginApi } from "./helpers/regression-auth.mjs?fresh";
  await loginApi("http://127.0.0.1:8080", "admin", "admin123", "BLD-TEST");
`, "proven direct named-import contract");

assertBlocked("auth-helper-hash-import", `
  import { loginApi } from "./helpers/regression-auth.mjs#fresh";
  await loginApi("http://127.0.0.1:8080", "admin", "admin123", "BLD-TEST");
`, "proven direct named-import contract");

assertBlocked("auth-helper-normalized-import", `
  import { loginApi } from "./helpers/../helpers/regression-auth.mjs";
  await loginApi("http://127.0.0.1:8080", "admin", "admin123", "BLD-TEST");
`, "proven direct named-import contract");

assertBlocked("unapproved-local-static-import", `
  import "./helpers/raw-login-helper.mjs";
`, "audited static regression module set");

assertBlocked("unapproved-local-dynamic-import", `
  await import("./helpers/raw-login-helper.mjs");
`, "audited static regression module set");

assertBlocked("unresolved-dynamic-import", `
  const target = resolvePluginAtRuntime();
  await import(target);
`, "audited static regression module set");

assertBlocked("data-url-dynamic-import", `
  await import("data:text/javascript,await%20fetch('/api/system/login')");
`, "audited static regression module set");

assertBlocked("absolute-auth-file-import", `
  import { createIsolatedAdminSessionFixture as make }
    from "file:///tmp/work/scripts/helpers/regression-auth.mjs?fresh";
  await make("http://127.0.0.1:8080");
`, "audited static regression module set");

assertBlocked("unapproved-local-reexport", `
  export { run } from "./helpers/raw-login-helper.mjs";
`, "audited static regression module set");

assertBlocked("create-require-loader", `
  import { createRequire } from "node:module";
  const load = createRequire(import.meta.url);
  load("./helpers/raw-login-helper.cjs");
`, "audited static regression module set");

assertBlocked("bare-module-create-require-loader", `
  import { createRequire } from "module";
  const load = createRequire(import.meta.url);
  const auth = load("./helpers/regression-auth.mjs");
  auth.regressionAdminCredentials();
`, "audited static regression module set");

assertBlocked("bare-module-inline-aliased-loader", `
  import { createRequire as makeLoader } from "module";
  makeLoader(import.meta.url)("./helpers/regression-auth.mjs").regressionAdminCredentials();
`, "audited static regression module set");

assertBlocked("unreviewed-auth-export", `
  import { deleteProvenRedisPrimary } from "./helpers/regression-auth.mjs";
  deleteProvenRedisPrimary("shared:key", "admin");
`, "reviewed manifest export set");

assertBlocked("raw-runtime-credential-transport", `
  import { regressionAdminCredentials as runtimeCredentials } from "./helpers/regression-auth.mjs";
  const credentials = runtimeCredentials();
  const runtimeChoice = Date.now() > 0;
  const endpoint = "http://127.0.0.1:8080/api/" + (runtimeChoice ? "system/" : "noop/") + (runtimeChoice ? "login" : "read");
  const method = runtimeChoice ? "POST" : "GET";
  await fetch(endpoint, {
    method,
    body: JSON.stringify({ username: credentials.username, password: credentials.password })
  });
`, "reviewed manifest export set");

assertBlocked("password-fill-custom-object", `
  import { fillRegressionAdminPassword } from "./helpers/regression-auth.mjs";
  const credentialSink = {
    async fill(password) {
      globalThis.capturedRegressionPassword = password;
    }
  };
  await fillRegressionAdminPassword(credentialSink);
`, "password fill target");

assertBlocked("password-fill-arbitrary-locator", `
  import { fillRegressionAdminPassword } from "./helpers/regression-auth.mjs";
  await fillRegressionAdminPassword(page.locator("[data-testid=security-current-password]"));
`, "password fill target");

assertBlocked("password-fill-unapproved-testid", `
  import { fillRegressionAdminPassword } from "./helpers/regression-auth.mjs";
  await fillRegressionAdminPassword(page.getByTestId("login-password"));
`, "password fill target");

const approvedDirectPasswordFill = classify("scripts/contract-password-fill-direct.mjs", `
  import { fillRegressionAdminPassword } from "./helpers/regression-auth.mjs";
  await fillRegressionAdminPassword(page.getByTestId("security-current-password"));
`);
assert.deepEqual(
  approvedDirectPasswordFill.violations,
  [],
  "the security current-password test id must remain an approved password fill target"
);

const approvedAliasedPasswordFill = classify("scripts/contract-password-fill-alias.mjs", `
  import { fillRegressionAdminPassword } from "./helpers/regression-auth.mjs";
  const targetTestId = "notification-provider-current-password";
  const passwordTarget = page.getByTestId(targetTestId);
  await fillRegressionAdminPassword(passwordTarget);
`);
assert.deepEqual(
  approvedAliasedPasswordFill.violations,
  [],
  "an immutable alias of the notification-provider current-password test id must remain approved"
);

assertBlocked("anonymous-split-base64-post", `
  const d = value => Buffer.from(value, "base64").toString();
  const origin = "http://127.0.0.1:8080";
  const endpoint = origin + d("L2FwaS9zeXN0ZW0vbG9naW4=");
  const left = String.fromCharCode(97, 100, 109, 105, 110);
  const right = String.fromCharCode(97, 100, 109, 105, 110, 49, 50, 51);
  const body = JSON.stringify(Object.fromEntries([
    [d("dXNlcm5hbWU="), left],
    [d("cGFzc3dvcmQ="), right]
  ]));
  const options = { method: ["P", "O", "S", "T"].join(""), body };
  await fetch(endpoint, options);
`, "POST transport target must resolve statically");

assertBlocked("password-reset-origin-query-smuggle", `
  const origin = atob("aHR0cDovLzEyNy4wLjAuMTo4MDgwL2FwaS9zeXN0ZW0vbG9naW4/eD0=");
  await fetch(\`\${origin}/api/system/password-reset-requests\`, {
    method: "POST",
    body: Buffer.from("eyJ1c2VybmFtZSI6ImFkbWluIiwicGFzc3dvcmQiOiJhZG1pbjEyMyJ9", "base64").toString()
  });
`, "raw login sink");

const regexBeforeImport = classify("scripts/contract-regex-import.mjs", `
  const quote = /\"/;
  import { loginApi as enter } from "./helpers/regression-auth.mjs";
  await enter("http://127.0.0.1:8080", "admin", "admin123", "BLD-TEST");
`);
assert.deepEqual(regexBeforeImport.violations, [], "regex literals must not corrupt the real parser");
assert.deepEqual(
  regexBeforeImport.mainCredentialScripts,
  ["scripts/contract-regex-import.mjs"],
  "a proven named helper import must receive the suite credential capability"
);

const migrationEscape = classify("scripts/a141-settlement-migration-regression.mjs", `
  import { loginApi } from "./helpers/regression-auth.mjs";
  server.listen(0, "127.0.0.1");
  const backend = { baseUrl: \`http://127.0.0.1:\${port}\` };
  await loginApi(backend.baseUrl, "admin", "admin123", "BLD-TEST");
  const target = atob("aHR0cDovLzEyNy4wLjAuMTo4MDgwL2FwaS9zeXN0ZW0vbG9naW4=");
  const payload = atob("eyJ1c2VybmFtZSI6ImFkbWluIiwicGFzc3dvcmQiOiJhZG1pbjEyMyJ9");
  await fetch(target, { method: "POST", body: payload });
`);
assert(
  migrationEscape.violations.some((violation) => violation.reason.includes("raw login sink")),
  `an isolated migration proof must not exempt an unresolved main-backend POST: ${JSON.stringify(migrationEscape)}`
);

const migrationMixedOrigin = classify("scripts/a141-settlement-migration-regression.mjs", `
  import { loginApi, loginAsAdmin } from "./helpers/regression-auth.mjs";
  server.listen(0, "127.0.0.1");
  const backend = { baseUrl: \`http://127.0.0.1:\${port}\` };
  await loginApi(backend.baseUrl, "admin", "admin123", "BLD-TEST");
  if (Date.now() < 0) await loginAsAdmin(page);
`);
assert(
  migrationMixedOrigin.violations.some((violation) => violation.reason.includes("main-target or unresolved auth capability")),
  `an isolated migration proof must not suppress a main-target helper: ${JSON.stringify(migrationMixedOrigin)}`
);

const migrationPortDecoy = classify("scripts/a141-settlement-migration-regression.mjs", `
  import { loginApi } from "./helpers/regression-auth.mjs";
  async function reserveHttpPort() {
    server.listen(0, "127.0.0.1", resolve);
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return port;
  }
  async function decoyBackend() {
    const port = await reserveHttpPort();
    const env = { JDY_SERVER_PORT: String(port) };
    return { env, baseUrl: \`http://127.0.0.1:\${port}\` };
  }
  const port = 8000 + 80;
  const backend = { baseUrl: \`http://127.0.0.1:\${port}\` };
  await loginApi(backend.baseUrl, "admin", "admin123", "BLD-TEST");
`);
assert(
  migrationPortDecoy.violations.some((violation) => violation.reason.includes("random isolated origin")),
  `an isolated migration port decoy must not prove the main backend target: ${JSON.stringify(migrationPortDecoy)}`
);

const migrationDefinePropertyOverride = classify("scripts/a141-settlement-migration-regression.mjs", `
  import { loginApi } from "./helpers/regression-auth.mjs";
  async function reserveHttpPort() {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return port;
  }
  const port = await reserveHttpPort();
  const env = { JDY_SERVER_PORT: String(port) };
  const backend = { env, baseUrl: \`http://127.0.0.1:\${port}\` };
  Object.defineProperty(backend, "baseUrl", { value: "http://127.0.0.1:8080" });
  await loginApi(backend.baseUrl, "admin", "admin123", "BLD-TEST");
`);
assert(
  migrationDefinePropertyOverride.violations.some((violation) => violation.reason.includes("random isolated origin")),
  `an isolated backend baseUrl mutation must fail closed: ${JSON.stringify(migrationDefinePropertyOverride)}`
);

assertBlocked("dead-api-fragment", `
  import { loginApi } from "./helpers/regression-auth.mjs";
  await loginApi("http://127.0.0.1:8080", "admin", "admin123", "BLD-TEST");
  const decode = value => Buffer.from(value, "base64").toString();
  const target = decode("aHR0cDovLzEyNy4wLjAuMTo4MDgwL2FwaS9zeXN0ZW0vbG9naW4=");
  const payload = decode("eyJ1c2VybmFtZSI6ImFkbWluIiwicGFzc3dvcmQiOiJhZG1pbjEyMyJ9");
  await fetch(target + (Date.now() < 0 ? "/api/noop" : ""), { method: "POST", body: payload });
`, "POST transport target must resolve statically");

const confirmationOnly = classify("scripts/contract-confirmation-only.mjs", `
  import { requestWithRegressionAdminConfirmation } from "./helpers/regression-auth.mjs";
  await requestWithRegressionAdminConfirmation("http://127.0.0.1:8080/api/example", { method: "POST" });
`);
assert.deepEqual(confirmationOnly.violations, [], "the confirmation helper must remain a proven auth capability");
assert.deepEqual(
  confirmationOnly.mainCredentialScripts,
  ["scripts/contract-confirmation-only.mjs"],
  "a script using only admin confirmation must receive the run-scoped credential file"
);

const { manifest } = await loadRegressionManifest(rootDir);
const manifestSources = await Promise.all(manifest.full.map(async (script) => ({
  script,
  source: await readFile(path.join(rootDir, script), "utf8")
})));
const manifestResult = classifyRunScopedAdminUsage(manifestSources);
assert.deepEqual(manifestResult.violations, [], "the current full manifest must satisfy the ADMIN credential contract");
assert.equal(
  manifestResult.spawnedBackendExclusions.length,
  5,
  "the five declared isolated migration backends must remain proven exclusions"
);
const auditedDependencySources = await loadAuditedRegressionLocalDependencySources(rootDir);
assert(auditedDependencySources.some(({ script }) => script === "scripts/helpers/regression-secret-channel.mjs"),
  "the regression auth helper local import closure must include the secret channel dependency");
assert(auditedDependencySources.some(({ script }) => script === "scripts/helpers/regression-redis-lua.mjs"),
  "the regression auth helper local import closure must include the Redis ownership dependency");

console.log(JSON.stringify({
  ok: true,
  scannedScripts: manifestResult.scannedScripts,
  mainCredentialScripts: manifestResult.mainCredentialScripts.length,
  isolatedBackendExclusions: manifestResult.spawnedBackendExclusions.length,
  adversarialCases,
  auditedLocalDependencies: auditedDependencySources.length
}));
