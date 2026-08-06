#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmodSync, closeSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

import {
  initializeRegressionDetachedSpawnLedger,
  readRegressionDetachedSpawnLedger
} from "./helpers/regression-detached-spawn-ledger.mjs";
import {
  captureRegressionDockerOwnershipSync,
  cleanupRegressionDockerLeaseIntents,
  encodeRegressionDockerWatchdogAck,
  readRegressionDockerWatchdogAck,
  regressionDockerExecutable,
  regressionDockerHostArgument,
  scavengeRegressionDockerClosedReceipts
} from "./helpers/regression-docker-lease.mjs";
import {
  captureRegressionExecutionBaselineSync,
  createRegressionExecutionBaselineCapability
} from "./helpers/regression-execution-integrity.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const guardPath = path.join(rootDir, "scripts/helpers/regression-child-process-guard.mjs");
const watchdogPath = path.join(rootDir, "scripts/helpers/regression-docker-lease-watchdog.mjs");
const secretDir = mkdtempSync(path.join(tmpdir(), "a174-docker-lease-contract-"));
chmodSync(secretDir, 0o700);
const runId = "9".repeat(32);
const executionBaseline = captureRegressionExecutionBaselineSync({ rootDir });
const dockerOwnership = captureRegressionDockerOwnershipSync({ execFileSync });

try {
  await scavengeRegressionDockerClosedReceipts({ ownership: dockerOwnership });
  const compatibility = await runCompatibilityScenario();
  const crash = await runCrashOwnershipScenario();
  const redisCrash = await runRedisCrashOwnershipScenario();
  console.log(JSON.stringify({
    ok: true,
    localEndpointPinned: compatibility.localEndpointPinned,
    parserMatrixRejected: compatibility.parserMatrixRejected,
    psqlCanonicalized: compatibility.psqlCanonicalized,
    dockerWatchdogSigned: true,
    dockerWatchdogErrorsRedacted: compatibility.ackErrorsRedacted,
    nonzeroDockerRemainedPending: compatibility.nonzeroDockerRemainedPending,
    postgresActivityClosedAfterHostSigkill: crash.activityClosed,
    postgresLockClosedAfterHostSigkill: crash.lockClosed,
    redisBlockingClientClosedAfterHostSigkill: redisCrash.clientClosed,
    unsealedCrashEvidenceRetained: crash.sealed === false && redisCrash.sealed === false,
    closedReceiptsScavenged: true
  }));
} finally {
  try {
    await scavengeRegressionDockerClosedReceipts({ ownership: dockerOwnership });
  } finally {
    rmSync(secretDir, { recursive: true, force: true });
  }
}

async function runCompatibilityScenario() {
  const index = 1;
  const token = "8".repeat(32);
  const source = String.raw`
    import { pathToFileURL } from "node:url";
    const guard = await import(pathToFileURL(process.argv[1]).href);
    guard.assertRegressionChildProcessGuardInstalled(process.env.JDY_REGRESSION_CHILD_GUARD_TOKEN);
    const { execFileSync } = await import("node:child_process");
    const rejected = [];
    const reject = (name, argv) => {
      let blocked = false;
      try { execFileSync("docker", argv, { encoding: "utf8" }); } catch (error) {
        blocked = /guard rejected/.test(String(error?.message || error));
      }
      if (!blocked) throw new Error(name + " bypassed Docker policy");
      rejected.push(name);
    };
    reject("wrong-container", ["exec", "other-postgres", "psql", "-U", "jdy", "-d", "jdy_erp", "-c", "SELECT 1"]);
    reject("reversed-pair", ["exec", "jdy-erp-redis", "psql", "-U", "jdy", "-d", "jdy_erp", "-c", "SELECT 1"]);
    reject("privileged", ["exec", "--privileged", "jdy-erp-postgres", "psql", "-U", "jdy", "-d", "jdy_erp", "-c", "SELECT 1"]);
    reject("arbitrary-env", ["exec", "-e", "LD_PRELOAD=/tmp/x", "jdy-erp-postgres", "psql", "-U", "jdy", "-d", "jdy_erp", "-c", "SELECT 1"]);
    reject("conflicting-on-error", ["exec", "jdy-erp-postgres", "psql", "-v", "ON_ERROR_STOP=0", "-U", "jdy", "-d", "jdy_erp", "-c", "SELECT 1"]);
    reject("psql-shell-meta", ["exec", "jdy-erp-postgres", "psql", "-U", "jdy", "-d", "jdy_erp", "-c", "SELECT 1;\n\\! id"]);
    reject("arbitrary-redis-eval", ["exec", "jdy-erp-redis", "redis-cli", "EVAL", "while true do end", "0"]);
    let invalidOptionsBlocked = false;
    try {
      execFileSync("docker", [
        "exec", "jdy-erp-postgres", "psql", "-U", "jdy", "-d", "jdy_erp", "-tA", "-c", "SELECT 1"
      ], { encoding: "utf8", shell: true });
    } catch (error) {
      invalidOptionsBlocked = /guard rejected/.test(String(error?.message || error));
    }
    if (!invalidOptionsBlocked) throw new Error("invalid Docker spawn options bypassed the guard");
    const filesystem = await import("node:fs");
    const http = await import("node:http");
    const net = await import("node:net");
    let ackCapabilityClosed = false;
    try { filesystem.fstatSync(7); } catch { ackCapabilityClosed = true; }
    if (!ackCapabilityClosed) throw new Error("watchdog acknowledgement capability reached the manifest");
    for (const connect of [
      () => http.request({ socketPath: process.env.HOME + "/.docker/run/docker.sock", path: "/_ping" }),
      () => net.connect(process.env.HOME + "/.docker/run/docker.sock")
    ]) {
      let blocked = false;
      try { connect(); } catch (error) { blocked = /guard rejected/.test(String(error?.message || error)); }
      if (!blocked) throw new Error("direct Docker socket transport bypassed the guard");
    }
    const selected = execFileSync("docker", [
      "exec", "jdy-erp-postgres", "psql", "-U", "jdy", "-d", "jdy_erp", "-tA", "-c", "SELECT 1"
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        DOCKER_HOST: "tcp://127.0.0.1:1",
        DOCKER_CONTEXT: "forbidden-remote",
        DOCKER_CONFIG: "/tmp/forbidden-docker-config"
      }
    }).trim();
    if (selected !== "1") throw new Error("canonical local psql probe failed: " + selected);
    let nonzeroDockerPending = false;
    try {
      execFileSync("docker", [
        "exec", "jdy-erp-postgres", "psql", "-U", "jdy", "-d", "jdy_erp", "-tA", "-c", "SELECT 1/0"
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      nonzeroDockerPending = Number.isInteger(error?.status) && error.status !== 0 && error?.signal == null;
    }
    if (!nonzeroDockerPending) throw new Error("nonzero Docker lease probe did not fail canonically");
    guard.sealRegressionDetachedSpawnLedger();
    console.log(JSON.stringify({ selected, rejected, invalidOptionsBlocked, ackCapabilityClosed, directSocketBlocked: true, nonzeroDockerPending }));
  `;
  const scenario = await spawnGuardedSource({ index, token, source });
  const [line] = scenario.stdout.trim().split(/\r?\n/).filter(Boolean).slice(-1);
  const report = JSON.parse(line);
  assert.equal(report.selected, "1");
  assert.equal(report.rejected.length, 7);
  assert.equal(report.invalidOptionsBlocked, true);
  assert.equal(report.ackCapabilityClosed, true);
  assert.equal(report.directSocketBlocked, true);
  assert.equal(report.nonzeroDockerPending, true);
  const closed = readRegressionDetachedSpawnLedger({
    secretDir,
    reference: scenario.ledger.reference,
    expectedParentPid: scenario.pid,
    requireClosed: true
  });
  assert.equal(closed.sealed, true);
  assert.equal(closed.dockerIntents.length, 2);
  assert.equal(closed.completedDockerIntentIds.length, 1,
    "a nonzero host Docker status must remain pending for independent lease cleanup");
  readRegressionDockerWatchdogAck({
    payload: scenario.dockerAck,
    ledgerFile: scenario.ledger.reference.file,
    runId,
    guardToken: token,
    expectedIntentIds: closed.dockerIntents.map(({ id }) => id),
    expectedCompletedIds: closed.completedDockerIntentIds,
    requireSealed: true
  });
  const idempotentCleanup = await cleanupRegressionDockerLeaseIntents({
    intents: closed.dockerIntents,
    runId,
    guardToken: token
  });
  assert.equal(idempotentCleanup.ok, true,
    "durable CLOSED receipts must make repeated Docker cleanup idempotent");
  assert.equal(idempotentCleanup.cleaned.length, closed.dockerIntents.length);
  const forgedToken = "6".repeat(32);
  const forgedError = `lease-error-${closed.dockerIntents[0].id}`;
  const forgedAck = JSON.parse(scenario.dockerAck.trim());
  forgedAck.guardToken = forgedToken;
  forgedAck.ok = false;
  forgedAck.errors = [forgedError];
  let sanitizedError = "";
  try {
    readRegressionDockerWatchdogAck({
      payload: encodeRegressionDockerWatchdogAck(forgedAck),
      ledgerFile: scenario.ledger.reference.file,
      runId,
      guardToken: token,
      expectedIntentIds: closed.dockerIntents.map(({ id }) => id),
      expectedCompletedIds: closed.completedDockerIntentIds,
      requireSealed: true
    });
  } catch (error) {
    sanitizedError = error instanceof Error ? error.message : String(error);
  }
  assert.match(sanitizedError, /did not prove exact lease closure/);
  assert.equal(sanitizedError.includes(forgedToken), false);
  assert.equal(sanitizedError.includes(closed.dockerIntents[0].id), false);
  assert.equal(sanitizedError.includes(forgedError), false);
  unlinkSync(scenario.ledger.path);
  return {
    localEndpointPinned: true,
    parserMatrixRejected: true,
    psqlCanonicalized: true,
    ackErrorsRedacted: true,
    nonzeroDockerRemainedPending: true
  };
}

async function runCrashOwnershipScenario() {
  const index = 2;
  const token = "7".repeat(32);
  const applicationName = `a172_lock_${String(Date.now()).slice(-10)}`;
  const advisoryKey = Number(String(Date.now()).slice(-9));
  const source = String.raw`
    import { pathToFileURL } from "node:url";
    const guard = await import(pathToFileURL(process.argv[1]).href);
    guard.assertRegressionChildProcessGuardInstalled(process.env.JDY_REGRESSION_CHILD_GUARD_TOKEN);
    const { execFileSync, spawn } = await import("node:child_process");
    const applicationName = process.argv[2];
    const advisoryKey = process.argv[3];
    const holder = spawn("docker", [
      "exec", "-e", "PGAPPNAME=" + applicationName, "jdy-erp-postgres",
      "psql", "-U", "jdy", "-d", "jdy_erp", "-tA", "-c",
      "SELECT pg_advisory_lock(" + advisoryKey + "); SELECT pg_sleep(300)"
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const count = execFileSync("docker", [
        "exec", "jdy-erp-postgres", "psql", "-U", "jdy", "-d", "jdy_erp", "-tA", "-c",
        "SELECT count(*) FROM pg_stat_activity WHERE application_name='" + applicationName + "' AND wait_event='PgSleep'"
      ], { encoding: "utf8" }).trim();
      if (count === "1") { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!ready) throw new Error("Docker lease crash probe never acquired its lock");
    console.log(JSON.stringify({ ready, holderPid: holder.pid, applicationName }));
    await new Promise(() => {});
  `;
  const ledger = initializeRegressionDetachedSpawnLedger({
    secretDir,
    index,
    runId,
    childScript: "scripts/a172-purchase-planning-concurrency-regression.mjs",
    guardToken: token
  });
  let direct;
  try {
    direct = spawn(process.execPath, [
      "--no-addons", "--input-type=module", "--eval", source,
      guardPath, applicationName, String(advisoryKey)
    ], guardedSpawnOptions({ ledger, token }));
  } finally {
    closeLedgerCapabilities(ledger);
  }
  const dockerAckPromise = collectDockerAck(direct);
  let stderr = "";
  direct.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const reader = createInterface({ input: direct.stdout });
  const [line] = await Promise.race([
    once(reader, "line"),
    sleep(10_000, undefined, { ref: false }).then(() => { throw new Error(`Docker crash probe timed out: ${stderr}`); })
  ]);
  const report = JSON.parse(line);
  assert.equal(report.ready, true);
  assert.equal(sqlScalar(`SELECT count(*) FROM pg_stat_activity WHERE application_name='${applicationName}'`), "1");
  assert.equal(sqlScalar(`SELECT count(*) FROM pg_locks lock JOIN pg_stat_activity activity ON activity.pid=lock.pid WHERE activity.application_name='${applicationName}' AND lock.locktype='advisory' AND lock.granted`), "1");

  const exit = once(direct, "exit");
  direct.stdio[6].destroy();
  direct.stdio[9].destroy();
  if (process.platform !== "win32") process.kill(-direct.pid, "SIGKILL");
  else direct.kill("SIGKILL");
  await exit;
  const dockerAck = await dockerAckPromise;
  const observed = readRegressionDetachedSpawnLedger({
    secretDir,
    reference: ledger.reference,
    expectedParentPid: direct.pid,
    requireClosed: false
  });
  assert.equal(observed.sealed, false);
  readRegressionDockerWatchdogAck({
    payload: dockerAck,
    ledgerFile: ledger.reference.file,
    runId,
    guardToken: token,
    expectedIntentIds: observed.dockerIntents.map(({ id }) => id),
    expectedCompletedIds: observed.completedDockerIntentIds,
    requireSealed: false
  });
  for (const member of observed.members) await waitUntilGone(member.pid, 3_000);
  await waitForSqlZero(`SELECT count(*) FROM pg_stat_activity WHERE application_name='${applicationName}'`, 5_000);
  await waitForSqlZero(`SELECT count(*) FROM pg_locks lock JOIN pg_stat_activity activity ON activity.pid=lock.pid WHERE activity.application_name='${applicationName}' AND lock.locktype='advisory' AND lock.granted`, 5_000);
  unlinkSync(ledger.path);
  return { activityClosed: true, lockClosed: true, sealed: observed.sealed };
}

async function runRedisCrashOwnershipScenario() {
  const index = 3;
  const token = "6".repeat(32);
  const blockingKey = `jdy:regression:docker-lease:${randomBytes(16).toString("hex")}`;
  assert.equal(redisBlockingClientCount(), 0, "Redis crash probe requires no pre-existing BLPOP client");
  const source = String.raw`
    import { pathToFileURL } from "node:url";
    const guard = await import(pathToFileURL(process.argv[1]).href);
    guard.assertRegressionChildProcessGuardInstalled(process.env.JDY_REGRESSION_CHILD_GUARD_TOKEN);
    const { spawn } = await import("node:child_process");
    const holder = spawn("docker", [
      "exec", "jdy-erp-redis", "redis-cli", "-n", "0", "--raw", "BLPOP", process.argv[2], "300"
    ], { stdio: ["ignore", "pipe", "pipe"] });
    console.log(JSON.stringify({ holderPid: holder.pid }));
    await new Promise(() => {});
  `;
  const ledger = initializeRegressionDetachedSpawnLedger({
    secretDir,
    index,
    runId,
    childScript: "scripts/a172-purchase-planning-concurrency-regression.mjs",
    guardToken: token
  });
  let direct;
  try {
    direct = spawn(process.execPath, [
      "--no-addons", "--input-type=module", "--eval", source,
      guardPath, blockingKey
    ], guardedSpawnOptions({ ledger, token }));
  } finally {
    closeLedgerCapabilities(ledger);
  }
  const dockerAckPromise = collectDockerAck(direct);
  let stderr = "";
  direct.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const reader = createInterface({ input: direct.stdout });
  await Promise.race([
    once(reader, "line"),
    sleep(10_000, undefined, { ref: false }).then(() => { throw new Error(`Redis crash probe timed out: ${stderr}`); })
  ]);
  await waitForRedisBlockingClientCount(1, 5_000);

  const exit = once(direct, "exit");
  direct.stdio[6].destroy();
  direct.stdio[9].destroy();
  if (process.platform !== "win32") process.kill(-direct.pid, "SIGKILL");
  else direct.kill("SIGKILL");
  await exit;
  const dockerAck = await dockerAckPromise;
  const observed = readRegressionDetachedSpawnLedger({
    secretDir,
    reference: ledger.reference,
    expectedParentPid: direct.pid,
    requireClosed: false
  });
  assert.equal(observed.sealed, false);
  readRegressionDockerWatchdogAck({
    payload: dockerAck,
    ledgerFile: ledger.reference.file,
    runId,
    guardToken: token,
    expectedIntentIds: observed.dockerIntents.map(({ id }) => id),
    expectedCompletedIds: observed.completedDockerIntentIds,
    requireSealed: false
  });
  for (const member of observed.members) await waitUntilGone(member.pid, 3_000);
  await waitForRedisBlockingClientCount(0, 5_000);
  unlinkSync(ledger.path);
  return { clientClosed: true, sealed: observed.sealed };
}

async function spawnGuardedSource({ index, token, source }) {
  const ledger = initializeRegressionDetachedSpawnLedger({
    secretDir,
    index,
    runId,
    childScript: "scripts/a10-entry-efficiency-regression.mjs",
    guardToken: token
  });
  let child;
  try {
    child = spawn(process.execPath, [
      "--no-addons", "--input-type=module", "--eval", source, guardPath
    ], guardedSpawnOptions({ ledger, token }));
  } finally {
    closeLedgerCapabilities(ledger);
  }
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const dockerAckPromise = collectDockerAck(child);
  await once(child, "exit");
  child.stdio[6].destroy();
  child.stdio[9].destroy();
  const dockerAck = await dockerAckPromise;
  assert.equal(child.exitCode, 0, stderr);
  return { ledger, pid: child.pid, stdout, stderr, dockerAck };
}

function guardedSpawnOptions({ ledger, token }) {
  const executionCapability = createRegressionExecutionBaselineCapability({
    secretDir,
    baseline: executionBaseline,
    rootDir
  });
  ledger.executionDescriptor = executionCapability.descriptor;
  return {
    cwd: rootDir,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      JDY_REGRESSION_CHILD_GUARD_TOKEN: token,
      JDY_REGRESSION_SECRET_REPORT_FD: "3",
      JDY_REGRESSION_DETACHED_SPAWN_LEDGER_FD: "4",
      JDY_REGRESSION_DETACHED_SPAWN_SIGNING_KEY_FD: "5",
      JDY_REGRESSION_DETACHED_SPAWN_LEDGER_PATH: ledger.path,
      JDY_REGRESSION_DETACHED_SPAWN_LEDGER_REFERENCE: JSON.stringify(ledger.reference),
      JDY_REGRESSION_DOCKER_WATCHDOG_PATH: watchdogPath,
      JDY_REGRESSION_DOCKER_WATCHDOG_ACK_FD: "7",
      JDY_REGRESSION_EXECUTION_BASELINE_FD: "8",
      JDY_REGRESSION_DOCKER_WATCHDOG_OWNER_FD: "9",
      DOCKER_HOST: "tcp://127.0.0.1:1",
      DOCKER_CONTEXT: "forbidden-remote"
    },
    stdio: [
      "ignore", "pipe", "pipe", "pipe",
      ledger.descriptor, ledger.signingKeyDescriptor,
      "pipe", "pipe", executionCapability.descriptor, "pipe"
    ]
  };
}

function closeLedgerCapabilities(ledger) {
  for (const field of ["descriptor", "signingKeyDescriptor", "executionDescriptor"]) {
    if (Number.isInteger(ledger[field]) && ledger[field] >= 0) {
      closeSync(ledger[field]);
      ledger[field] = -1;
    }
  }
}

function sqlScalar(statement) {
  return execFileSync(regressionDockerExecutable, [
    "--host", regressionDockerHostArgument,
    "exec", "jdy-erp-postgres", "/usr/bin/psql", "-X", "-v", "ON_ERROR_STOP=1",
    "-U", "jdy", "-d", "jdy_erp", "-tA", "-c", statement
  ], { encoding: "utf8" }).trim();
}

function redisBlockingClientCount() {
  const output = execFileSync(regressionDockerExecutable, [
    "--host", regressionDockerHostArgument,
    "exec", "jdy-erp-redis", "/usr/local/bin/redis-cli", "-n", "0", "--raw", "CLIENT", "LIST"
  ], { encoding: "utf8" });
  return output.split(/\r?\n/).filter((line) => /(?:^| )cmd=blpop(?: |$)/.test(line)).length;
}

async function waitForRedisBlockingClientCount(expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (redisBlockingClientCount() === expected) return;
    await sleep(25);
  }
  throw new Error(`Docker lease cleanup left ${redisBlockingClientCount()} Redis BLPOP clients; expected ${expected}`);
}

async function waitForSqlZero(statement, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (sqlScalar(statement) === "0") return;
    await sleep(25);
  }
  throw new Error(`Docker lease cleanup did not close SQL state: ${statement}`);
}

function collectDockerAck(child, timeoutMs = 30_000) {
  if (child.__dockerAckPromise) return child.__dockerAckPromise;
  child.__dockerAckPromise = new Promise((resolve, reject) => {
    let payload = "";
    const timer = setTimeout(() => reject(new Error("Docker lease watchdog acknowledgement timed out")), timeoutMs);
    child.stdio[7].on("data", (chunk) => {
      payload += chunk.toString();
      if (Buffer.byteLength(payload) > 1024 * 1024) reject(new Error("Docker lease watchdog acknowledgement is oversized"));
    });
    child.stdio[7].once("error", reject);
    child.stdio[7].once("close", () => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
  return child.__dockerAckPromise;
}

async function waitUntilGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      if (error?.code !== "EPERM") throw error;
    }
    await sleep(20);
  }
  throw new Error(`Docker lease watchdog process ${pid} survived cleanup`);
}
