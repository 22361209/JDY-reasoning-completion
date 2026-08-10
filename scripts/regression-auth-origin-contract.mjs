#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { publishRegressionCredentialCapability } from "./helpers/regression-credential-capability.mjs";
import { initializeRegressionFixtureLedger } from "./helpers/regression-fixture-ledger.mjs";

const originalFetch = globalThis.fetch;
const secretDir = await mkdtemp(path.join(tmpdir(), "jdy-regression-origin-contract-"));
const runId = randomBytes(16).toString("hex");
const credentialPath = path.join(secretDir, "001.json");
const username = `r_full_${randomBytes(12).toString("hex")}`;
const password = `R!${randomBytes(18).toString("base64url")}a1`;
const userId = randomUUID();
const calls = [];
const requestFenceCalls = [];
let fenceOpenAttempts = 0;
let requestFenceResponder = async (request) => {
  if (request.action === "OPEN") {
    fenceOpenAttempts += 1;
    if (fenceOpenAttempts === 1) throw new TypeError("simulated transient local connection reset");
  }
  return new Response(JSON.stringify({
    state: request.action === "OPEN" ? "OPEN" : "CLOSED",
    activeCount: 0
  }), { status: 200 });
};

try {
  const fixtureLedger = initializeRegressionFixtureLedger({ secretDir, name: "001", runId });
  const credentialIdentity = await publishRegressionCredentialCapability({
    credentialPath,
    credential: {
    runId,
    username,
    password,
    userId,
    apiBase: "http://127.0.0.1:8080",
      frontendBase: "http://127.0.0.1:5173",
      requestFenceControlToken: "f".repeat(32),
      fixtureLedgerReference: fixtureLedger.reference,
      fixtureLedgerSigningPrivateKey: fixtureLedger.signingPrivateKey
    }
  });
  process.env.JDY_REGRESSION_RUN_ID = runId;
  process.env.JDY_REGRESSION_ADMIN_CREDENTIAL_FILE = credentialPath;
  process.env.JDY_REGRESSION_ADMIN_CREDENTIAL_IDENTITY = `${credentialIdentity.device}:${credentialIdentity.inode}`;
  delete process.env.JDY_REGRESSION_SECRET_REPORT_FD;

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const headers = new Headers(init.headers ?? (typeof input === "string" ? undefined : input.headers));
    calls.push({ url, method: init.method || "GET", cookie: headers.get("Cookie"), body: init.body || "" });
    if (new URL(url).pathname === "/api/system/login") {
      return new Response("{}", {
        status: 200,
        headers: { "Set-Cookie": "SESSION=origin-contract-cookie-0001; Path=/; HttpOnly" }
      });
    }
    if (new URL(url).pathname === "/api/system/regression-request-fence") {
      const request = JSON.parse(String(init.body || "{}"));
      requestFenceCalls.push({
        request,
        capability: headers.get("X-JDY-Regression-Fence-Capability")
      });
      return requestFenceResponder(request);
    }
    return new Response("{}", { status: 200 });
  };

  const auth = await import(`./helpers/regression-auth.mjs?origin-contract=${runId}`);
  await auth.installApiSession("http://127.0.0.1:8080", "admin", "admin123", "BLD-TEST");
  const loginCall = calls.find((call) => new URL(call.url).pathname === "/api/system/login");
  assert(loginCall, "the origin contract must perform one main API login");
  assert.deepEqual(JSON.parse(loginCall.body), { username, password, accountSetCode: "BLD-TEST" });
  await auth.loginApi("http://127.0.0.1:8080", " ADMIN ", "admin123", "BLD-TEST");
  const canonicalizedLoginCall = calls.filter((call) => new URL(call.url).pathname === "/api/system/login").at(-1);
  assert.deepEqual(JSON.parse(canonicalizedLoginCall.body), { username, password, accountSetCode: "BLD-TEST" },
    "trimmed case variants of the shared administrator must map to the run-scoped identity");

  const fence = await auth.manageRegressionRequestFence(
    "http://127.0.0.1:8080",
    { username, userId, generation: 0 },
    "OPEN",
    "f".repeat(32)
  );
  assert.deepEqual(fence, { state: "OPEN", activeCount: 0 });
  assert.equal(fenceOpenAttempts, 2,
    "a transient request-fence transport failure must retry exactly once for the same generation");

  const controlCapability = "f".repeat(32);
  const pendingGeneration = () => new Response(JSON.stringify({
    message: "回归测试身份请求门代际尚未生效"
  }), { status: 409 });
  const closedFence = () => new Response(JSON.stringify({ state: "CLOSED", activeCount: 0 }), { status: 200 });
  const entry = { username, userId, generation: 0, state: "PREPARED" };
  const disabledNewerIdentity = {
    metadataMatches: true,
    ownershipMatches: true,
    enabled: false,
    sessionGeneration: 1
  };
  const closeLedgerFence = (candidateEntry = entry, owned = disabledNewerIdentity) =>
    auth.closeRegressionFixtureRequestFenceForLedger(
      "http://127.0.0.1:8080",
      candidateEntry,
      owned,
      controlCapability
    );
  const requestGenerations = () => requestFenceCalls.map(({ request }) => request.generation);

  requestFenceCalls.length = 0;
  requestFenceResponder = async (request) => request.generation === 0 ? pendingGeneration() : closedFence();
  assert.deepEqual(
    await closeLedgerFence({ ...entry, state: "HARD_DISABLED" }),
    { state: "CLOSED", activeCount: 0 },
    "a precisely owned disabled fixture must re-prove the current generation after the ledger generation is rejected"
  );
  assert.deepEqual(requestGenerations(), [0, 1]);
  assert(requestFenceCalls.every(({ request }) => request.action === "CLOSE_AND_DRAIN"
    && request.username === username
    && request.userId === userId));
  assert(requestFenceCalls.every(({ capability }) => capability === controlCapability),
    "generation recovery must retain the same control capability");

  requestFenceCalls.length = 0;
  requestFenceResponder = async () => closedFence();
  assert.deepEqual(await closeLedgerFence(), { state: "CLOSED", activeCount: 0 });
  assert.deepEqual(requestGenerations(), [0],
    "a historical generation accepted by a recovery capability must not be advanced");

  async function assertNoCrossGeneration(label, {
    candidateEntry = entry,
    owned = disabledNewerIdentity,
    responder,
    expectedGenerations
  }) {
    requestFenceCalls.length = 0;
    requestFenceResponder = responder;
    await assert.rejects(closeLedgerFence(candidateEntry, owned), undefined, label);
    assert.deepEqual(requestGenerations(), expectedGenerations, label);
  }

  await assertNoCrossGeneration("an enabled identity must not retry its current generation", {
    owned: { ...disabledNewerIdentity, enabled: true },
    responder: async () => pendingGeneration(),
    expectedGenerations: [0]
  });
  await assertNoCrossGeneration("an equal generation must not retry", {
    owned: { ...disabledNewerIdentity, sessionGeneration: 0 },
    responder: async () => pendingGeneration(),
    expectedGenerations: [0]
  });
  await assertNoCrossGeneration("an earlier database generation must not retry", {
    candidateEntry: { ...entry, generation: 1 },
    owned: { ...disabledNewerIdentity, sessionGeneration: 0 },
    responder: async () => pendingGeneration(),
    expectedGenerations: [1]
  });
  await assertNoCrossGeneration("metadata drift must fail before a request", {
    owned: { ...disabledNewerIdentity, metadataMatches: false },
    responder: async () => pendingGeneration(),
    expectedGenerations: []
  });
  await assertNoCrossGeneration("ownership drift must fail before a request", {
    owned: { ...disabledNewerIdentity, ownershipMatches: false },
    responder: async () => pendingGeneration(),
    expectedGenerations: []
  });
  await assertNoCrossGeneration("a forbidden response must not advance generation", {
    responder: async () => new Response(JSON.stringify({ message: "fixture control forbidden" }), { status: 403 }),
    expectedGenerations: [0]
  });
  await assertNoCrossGeneration("a stale-generation response must not advance generation", {
    responder: async () => new Response(JSON.stringify({ message: "回归测试身份请求门代际已失效" }), { status: 409 }),
    expectedGenerations: [0]
  });
  await assertNoCrossGeneration("an old-request response must not advance generation", {
    responder: async () => new Response(JSON.stringify({ message: "回归测试身份尚有旧代际请求" }), { status: 409 }),
    expectedGenerations: [0]
  });
  await assertNoCrossGeneration("a transport failure may retry only the same generation", {
    responder: async () => { throw new TypeError("simulated transport failure"); },
    expectedGenerations: [0, 0]
  });
  await assertNoCrossGeneration("invalid JSON must not advance generation", {
    responder: async () => new Response("not-json", { status: 409 }),
    expectedGenerations: [0]
  });
  await assertNoCrossGeneration("an incomplete drain must not advance generation", {
    responder: async () => new Response(JSON.stringify({ state: "CLOSED", activeCount: 1 }), { status: 200 }),
    expectedGenerations: [0]
  });

  requestFenceCalls.length = 0;
  requestFenceResponder = async (request) => request.generation === 0
    ? pendingGeneration()
    : new Response(JSON.stringify({ message: `${"x".repeat(209)}${controlCapability}` }), { status: 503 });
  let boundedRecoveryError;
  try {
    await closeLedgerFence({ ...entry, state: "HARD_DISABLED" });
  } catch (error) {
    boundedRecoveryError = error;
  }
  assert(boundedRecoveryError instanceof AggregateError,
    "a failed current-generation retry must preserve both bounded failures");
  assert.deepEqual(requestGenerations(), [0, 1]);
  assert.match(boundedRecoveryError.message, /status 409/);
  assert.match(boundedRecoveryError.message, /status 503/);
  assert.equal(boundedRecoveryError.message.includes(controlCapability), false);
  assert.equal(boundedRecoveryError.message.includes(controlCapability.slice(0, 31)), false,
    "capability redaction must happen before bounded reason truncation");
  assert.equal(JSON.stringify(boundedRecoveryError).includes(controlCapability), false);
  assert.equal(JSON.stringify(boundedRecoveryError).includes(controlCapability.slice(0, 31)), false);
  assert(boundedRecoveryError.errors.every((error) => !error.message.includes(controlCapability)
    && !error.message.includes(controlCapability.slice(0, 31))),
    "generation recovery diagnostics must never expose the control capability");

  await globalThis.fetch("http://127.0.0.1:8080/api/owned");
  await globalThis.fetch("http://127.0.0.1:8080@attacker.example/collect");
  const ownedCall = calls.find((call) => call.url === "http://127.0.0.1:8080/api/owned");
  const attackerCall = calls.find((call) => call.url.includes("attacker.example"));
  assert.equal(ownedCall?.cookie, "SESSION=origin-contract-cookie-0001");
  assert.equal(attackerCall?.cookie, null, "prefix-confusion origins must never receive the suite cookie");

  const callsBeforeRejectedLogout = calls.length;
  await assert.rejects(
    auth.logoutApiSession("http://127.0.0.1:9090", "SESSION=origin-contract-cookie-0001"),
    /non-main origin/
  );
  await assert.rejects(
    auth.logoutApiSession("http://127.0.0.1:8080/path", "SESSION=origin-contract-cookie-0001"),
    /must not contain a path/
  );
  await assert.rejects(
    auth.logoutApiSession("http://user@127.0.0.1:8080", "SESSION=origin-contract-cookie-0001"),
    /credential-free canonical local HTTP URL/
  );
  assert.equal(calls.length, callsBeforeRejectedLogout, "rejected logout targets must not reach fetch");

  const helperPath = path.resolve(import.meta.dirname, "helpers/regression-auth.mjs");
  const isolatedProbe = execFileSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `
      import { pathToFileURL } from "node:url";
      globalThis.fetch = async () => new Response("{}", {
        status: 200,
        headers: { "Set-Cookie": "SESSION=isolated-origin-cookie-0001; Path=/" }
      });
      const auth = await import(pathToFileURL(process.argv[1]).href + "?isolated-origin-contract");
      let rejected = "";
      try {
        await auth.loginApi("http://127.0.0.1:8080", "admin", "admin123", "BLD-TEST");
      } catch (error) {
        rejected = error instanceof Error ? error.message : String(error);
      }
      if (!rejected.includes("refuses the main backend")) throw new Error("isolated main origin was not rejected");
      const cookie = await auth.loginApi("http://127.0.0.1:49123", "admin", "admin123", "BLD-TEST");
      if (cookie !== "SESSION=isolated-origin-cookie-0001") throw new Error("isolated random origin was rejected");
      if (process.env.JDY_REGRESSION_ISOLATED_BACKEND_ONLY) throw new Error("isolated marker leaked to descendants");
      process.stdout.write(JSON.stringify({ rejected: true, randomOriginAllowed: true }));
    `,
    helperPath
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      JDY_REGRESSION_ISOLATED_BACKEND_ONLY: "1",
      JDY_REGRESSION_SECRET_REPORT_FD: ""
    }
  });
  assert.deepEqual(JSON.parse(isolatedProbe), { rejected: true, randomOriginAllowed: true });

  console.log(JSON.stringify({
    ok: true,
    exactOriginCookieRouting: true,
    runtimeNonMainLogoutRejected: true,
    canonicalOriginRejected: true,
    isolatedMainOriginRejected: true,
    requestFenceTransientTransportRetry: true,
    requestFenceGenerationRecoveryBounded: true
  }));
} finally {
  globalThis.fetch = originalFetch;
  delete process.env.JDY_REGRESSION_RUN_ID;
  delete process.env.JDY_REGRESSION_ADMIN_CREDENTIAL_FILE;
  delete process.env.JDY_REGRESSION_ADMIN_CREDENTIAL_IDENTITY;
  delete process.env.JDY_REGRESSION_SECRET_REPORT_FD;
  await rm(secretDir, { recursive: true, force: true });
}
