#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, closeSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  initializeRegressionDetachedSpawnLedger,
  readRegressionDetachedSpawnLedger,
  removeRegressionDetachedSpawnLedger
} from "./helpers/regression-detached-spawn-ledger.mjs";
import { readRegressionDockerWatchdogAck } from "./helpers/regression-docker-lease.mjs";
import {
  captureRegressionExecutionBaselineSync,
  createRegressionExecutionBaselineCapability
} from "./helpers/regression-execution-integrity.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const guardPath = path.join(rootDir, "scripts/helpers/regression-child-process-guard.mjs");
const probePath = path.join(rootDir, "scripts/helpers/regression-child-guard-probe.mjs");
const guardSource = readFileSync(guardPath, "utf8");
assert.doesNotMatch(guardSource, /\btrustedProcessKill\b/,
  "watchdog initialization cleanup must not call a removed signal primitive");
assert.match(guardSource,
  /catch \(error\) \{[\s\S]{0,300}?trustedProcessRawKill\(-child\.pid, trustedSignalNumberByName\.SIGKILL\)/,
  "watchdog initialization failure must close its detached process group through the captured raw primitive");
assert.match(guardSource,
  /const identity = detachedProcessIdentity\([\s\S]{0,500}?type: "spawned"[\s\S]{0,500}?assertDockerWatchdogReady/,
  "the detached watchdog identity must be durable before readiness can fail");
assert.match(guardSource,
  /if \(!child\?\.pid\) \{[\s\S]{0,220}?type: "failed"/,
  "a spawned watchdog must retain signed ownership evidence on initialization failure");
assert.match(guardSource, /const maximumDockerIntents = 1_024;/,
  "the guarded Docker lease cap must cover the bounded A43 cleanup envelope");
const token = "a".repeat(32);
const runId = "b".repeat(32);
const secretDir = mkdtempSync(path.join(tmpdir(), "jdy-child-guard-contract-"));
chmodSync(secretDir, 0o700);
writeFileSync(path.join(secretDir, "owner.json"), "{}\n", { mode: 0o600 });
const executionBaseline = captureRegressionExecutionBaselineSync({ rootDir });
const executionCapability = createRegressionExecutionBaselineCapability({
  secretDir,
  baseline: executionBaseline,
  rootDir
});
const detachedLedger = initializeRegressionDetachedSpawnLedger({
  secretDir,
  index: 1,
  runId,
  childScript: "scripts/a10-entry-efficiency-regression.mjs",
  guardToken: token
});
const source = `
  import { createRequire } from "node:module";
  import { pathToFileURL } from "node:url";
  const guard = await import(pathToFileURL(process.argv[1]).href);
  let bootstrapGuardToken = process.env.JDY_REGRESSION_CHILD_GUARD_TOKEN;
  guard.assertRegressionChildProcessGuardInstalled(bootstrapGuardToken);
  const globalGuardCapabilityHidden = Object.getOwnPropertySymbols(globalThis).every((symbol) => {
    const state = globalThis[symbol];
    return !state || typeof state !== "object" || !Object.values(state).includes(bootstrapGuardToken);
  });
  bootstrapGuardToken = "";
  if (!globalGuardCapabilityHidden) throw new Error("guard token remained visible through global symbol state");
  const { spawn } = await import("node:child_process");
  const require = createRequire(import.meta.url);
  const childProcess = require("node:child_process");
  const pathModule = require("node:path");
  let arrayPrimordialFrozen = false;
  try { Array.prototype.push = () => 0; } catch { arrayPrimordialFrozen = true; }
  if (!arrayPrimordialFrozen) throw new Error("Array primordials remained mutable after guard installation");
  let proxyArgvBlocked = false;
  try {
    childProcess.spawnSync(process.execPath, new Proxy([process.argv[2]], {}), { stdio: "ignore" });
  } catch (error) {
    proxyArgvBlocked = /not a plain array/.test(String(error?.message || error));
  }
  if (!proxyArgvBlocked) throw new Error("Proxy argv bypassed the immutable invocation snapshot");
  let proxyOptionsBlocked = false;
  try {
    childProcess.spawnSync(process.execPath, [process.argv[2]], new Proxy({ stdio: "ignore" }, {}));
  } catch (error) {
    proxyOptionsBlocked = /not a plain object/.test(String(error?.message || error));
  }
  if (!proxyOptionsBlocked) throw new Error("Proxy options bypassed the immutable invocation snapshot");
  const { Worker: NamedWorker } = await import("node:worker_threads");
  let namedWorkerBlocked = false;
  try { new NamedWorker("process.exit(0)", { eval: true }); } catch (error) {
    namedWorkerBlocked = /worker threads are forbidden/.test(String(error?.message || error));
  }
  let requiredWorkerBlocked = false;
  try { new (require("node:worker_threads").Worker)("process.exit(0)", { eval: true }); } catch (error) {
    requiredWorkerBlocked = /worker threads are forbidden/.test(String(error?.message || error));
  }
  if (!namedWorkerBlocked || !requiredWorkerBlocked) {
    throw new Error("worker_threads bypassed the guarded isolate boundary");
  }
  const originalPathResolve = pathModule.resolve;
  const originalSetHas = Set.prototype.has;
  let primordialBypassBlocked = false;
  let primordialBypassError = "";
  try {
    pathModule.resolve = () => process.argv[2];
    Set.prototype.has = () => true;
    spawn(process.execPath, [process.argv[1]], { stdio: "ignore" });
  } catch (error) {
    primordialBypassError = String(error?.message || error);
    primordialBypassBlocked = /unapproved executable/.test(primordialBypassError);
  } finally {
    pathModule.resolve = originalPathResolve;
    Set.prototype.has = originalSetHas;
  }
  if (!primordialBypassBlocked) {
    throw new Error("mutable primordials bypassed the executable allowlist: " + primordialBypassError);
  }
  let parentSignalBlocked = false;
  try { process.kill(process.ppid, 0); } catch { parentSignalBlocked = true; }
  if (!parentSignalBlocked) throw new Error("manifest could signal the regression runner");
  let wrappersImmutable = false;
  try { childProcess.spawn = () => {}; } catch { wrappersImmutable = true; }
  if (!wrappersImmutable || childProcess.spawn !== spawn) throw new Error("guard wrappers are mutable");
  const filesystem = require("node:fs");
  let suiteLockRelocationBlocked = false;
  try { filesystem.renameSync(process.argv[3], process.argv[3] + ".escaped"); } catch (error) {
    suiteLockRelocationBlocked = /cannot mutate/.test(String(error?.message || error));
  }
  if (!suiteLockRelocationBlocked) throw new Error("manifest could relocate the suite lock container");
  let suiteLockRemovalBlocked = false;
  try { await filesystem.promises.rm(process.argv[3], { recursive: true, force: true }); } catch (error) {
    suiteLockRemovalBlocked = /cannot mutate/.test(String(error?.message || error));
  }
  if (!suiteLockRemovalBlocked) throw new Error("manifest could delete the suite lock container");
  let suiteLockOwnerRemovalBlocked = false;
  try { filesystem.unlinkSync(pathModule.join(process.argv[3], "owner.json")); } catch (error) {
    suiteLockOwnerRemovalBlocked = /cannot mutate/.test(String(error?.message || error));
  }
  if (!suiteLockOwnerRemovalBlocked) throw new Error("manifest could delete the suite lock owner");
  let suiteLockPermissionMutationBlocked = false;
  try { filesystem.chmodSync(process.argv[3], 0); } catch (error) {
    suiteLockPermissionMutationBlocked = /cannot mutate/.test(String(error?.message || error));
  }
  if (!suiteLockPermissionMutationBlocked) throw new Error("manifest could change suite lock permissions");
  let suiteLockOwnerWriteBlocked = false;
  try { await filesystem.promises.writeFile(pathModule.join(process.argv[3], "owner.json"), "{}\\n"); } catch (error) {
    suiteLockOwnerWriteBlocked = /cannot mutate/.test(String(error?.message || error));
  }
  if (!suiteLockOwnerWriteBlocked) throw new Error("manifest could overwrite the suite lock owner");
  let proxyFilesystemPathBlocked = false;
  try { filesystem.rmSync(new Proxy({}, {}), { recursive: true, force: true }); } catch (error) {
    proxyFilesystemPathBlocked = /immutable string/.test(String(error?.message || error));
  }
  if (!proxyFilesystemPathBlocked) throw new Error("Proxy filesystem path bypassed the suite lock boundary");
  const http = require("node:http");
  let proxyNetworkOptionsBlocked = false;
  try { http.request(new Proxy({ socketPath: process.env.HOME + "/.docker/run/docker.sock" }, {})); } catch (error) {
    proxyNetworkOptionsBlocked = /cannot be a Proxy/.test(String(error?.message || error));
  }
  if (!proxyNetworkOptionsBlocked) throw new Error("Proxy network options bypassed the transport boundary");
  let accessorNetworkOptionsBlocked = false;
  const accessorOptions = {};
  Object.defineProperty(accessorOptions, "socketPath", {
    enumerable: true,
    get() { return process.env.HOME + "/.docker/run/docker.sock"; }
  });
  try { http.request(accessorOptions); } catch (error) {
    accessorNetworkOptionsBlocked = /accessor or hidden property/.test(String(error?.message || error));
  }
  if (!accessorNetworkOptionsBlocked) throw new Error("accessor network options bypassed the transport boundary");
  let signingCapabilityClosed = false;
  try { filesystem.fstatSync(5); } catch { signingCapabilityClosed = true; }
  if (!signingCapabilityClosed || process.env.JDY_REGRESSION_DETACHED_SPAWN_SIGNING_KEY_FD) {
    throw new Error("detached ledger signing capability remained visible to the manifest");
  }
  let watchdogAckCapabilityClosed = false;
  try { filesystem.fstatSync(7); } catch { watchdogAckCapabilityClosed = true; }
  if (!watchdogAckCapabilityClosed || process.env.JDY_REGRESSION_DOCKER_WATCHDOG_ACK_FD) {
    throw new Error("Docker watchdog acknowledgement capability remained visible to the manifest");
  }
  let executionCapabilityClosed = false;
  try { filesystem.fstatSync(8); } catch { executionCapabilityClosed = true; }
  if (!executionCapabilityClosed || process.env.JDY_REGRESSION_EXECUTION_BASELINE_FD) {
    throw new Error("tracked execution baseline capability remained visible to the manifest");
  }
  // Check capability closure before opening a socket: POSIX may reuse a closed
  // descriptor number for the network connection created by native fetch.
  const localHealth = await fetch("http://127.0.0.1:8080/actuator/health");
  if (!localHealth.ok) throw new Error("guarded native fetch could not reach the local health endpoint");
  const {
    abort: namedProcessAbort,
    exit: namedProcessExit,
    kill: namedProcessKill,
    reallyExit: namedProcessReallyExit
  } = await import("node:process");
  let namedParentSignalBlocked = false;
  try { namedProcessKill(process.ppid, 0); } catch { namedParentSignalBlocked = true; }
  if (!namedParentSignalBlocked) throw new Error("node:process named kill bypassed the guard");
  let rawParentSignalBlocked = false;
  try { process._kill(process.ppid, 0); } catch { rawParentSignalBlocked = true; }
  if (!rawParentSignalBlocked) throw new Error("process._kill bypassed the guard");
  let debugParentSignalBlocked = false;
  try { process._debugProcess(process.ppid); } catch { debugParentSignalBlocked = true; }
  if (!debugParentSignalBlocked) throw new Error("process._debugProcess bypassed the guard");
  let selfTerminationBlocked = true;
  for (const terminate of [
    () => process.exit(0),
    () => process.abort(),
    () => process.reallyExit(0),
    () => namedProcessExit(0),
    () => namedProcessAbort(),
    () => namedProcessReallyExit(0)
  ]) {
    let blocked = false;
    try { terminate(); } catch { blocked = true; }
    selfTerminationBlocked &&= blocked;
  }
  if (!selfTerminationBlocked) throw new Error("manifest self-termination bypassed the guard");
  let rawBindingBlocked = false;
  try { process.binding("spawn_sync"); } catch { rawBindingBlocked = true; }
  if (!rawBindingBlocked) throw new Error("raw spawn binding was not blocked");
  let detachedBlocked = false;
  try {
    spawn(process.execPath, [process.argv[2]], { detached: true, stdio: "ignore" });
  } catch (error) {
    detachedBlocked = /detached process creation is forbidden/.test(String(error?.message || error));
  }
  if (!detachedBlocked) throw new Error("detached child was not blocked");
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  let rawProcessCommandBlocked = false;
  try {
    childProcess.spawnSync("ps", [
      "-ww", "-axo", "pid=,ppid=,pgid=,state=,lstart=,command="
    ], { encoding: "utf8" });
  } catch (error) {
    rawProcessCommandBlocked = /unapproved executable/.test(String(error?.message || error));
  }
  if (!rawProcessCommandBlocked) throw new Error("manifest could read raw host process command arguments");
  let forgedStackCommandBlocked = false;
  try {
    const forged = Function("spawnSync",
      'return spawnSync("ps", ["-ww", "-axo", "pid=,ppid=,state=,lstart=,command="], { encoding: "utf8" });\\n'
      + '//# sourceURL=/tmp/scripts/helpers/regression-process-tree.mjs');
    forged(childProcess.spawnSync);
  } catch (error) {
    forgedStackCommandBlocked = /unapproved executable/.test(String(error?.message || error));
  }
  if (!forgedStackCommandBlocked) throw new Error("forged helper stack could read raw host process command arguments");
  const processRows = String(childProcess.spawnSync("ps", [
    "-ww", "-axo", "pid=,ppid=,pgid=,state=,lstart=,comm="
  ], { encoding: "utf8" }).stdout || "");
  const chromiumRows = processRows.split(/\\r?\\n/).filter((line) => line.includes("chrome-headless-shell"));
  const chromiumOwnedByOuterGroup = chromiumRows.length > 0 && chromiumRows.every((line) => {
    const match = line.match(/^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+/);
    return Number(match?.[3]) === process.pid;
  });
  if (!chromiumOwnedByOuterGroup) throw new Error("Chromium escaped the owned outer process group");
  const page = await browser.newPage();
  await page.goto("data:text/html,<title>guard-contract</title>");
  if (await page.title() !== "guard-contract") throw new Error("Playwright launch probe failed");
  await browser.close();
  const syncProbe = childProcess.spawnSync(process.execPath, [process.argv[2]], {
    env: {
      ...process.env,
      NODE_OPTIONS: "--eval=process.exit(91)",
      LD_PRELOAD: "/tmp/forbidden",
      BASH_ENV: "/tmp/forbidden",
      JAVA_HOME: "/tmp/forbidden",
      JAVA_TOOL_OPTIONS: "-javaagent:/tmp/forbidden.jar",
      JDK_JAVA_OPTIONS: "-javaagent:/tmp/forbidden.jar",
      MAVEN_OPTS: "-Dmaven.ext.class.path=/tmp/forbidden.jar"
    },
    stdio: "ignore"
  });
  if (syncProbe.status !== 0) throw new Error("spawnSync guard probe failed");
  childProcess.execFileSync(process.execPath, [process.argv[2]], {
    env: { ...process.env, NODE_PATH: "/tmp/forbidden" },
    stdio: "ignore"
  });
  const nested = spawn(process.execPath, [process.argv[2]], {
    env: {
      PATH: process.env.PATH,
      JDY_REGRESSION_CHILD_GUARD_PROBE_DELAY_MS: "3000"
    },
    stdio: "ignore"
  });
  let forgedChildHandleSignalBlocked = false;
  try { process.kill(nested.pid, 0, { pid: nested.pid }); } catch {
    forgedChildHandleSignalBlocked = true;
  }
  if (!forgedChildHandleSignalBlocked) {
    throw new Error("a forged child handle could authorize process signalling");
  }
  let approvedChildHandleSignalAllowed = true;
  let approvedChildHandleSignalError = "";
  try { process.kill(nested.pid, 0, nested); } catch (error) {
    approvedChildHandleSignalAllowed = false;
    approvedChildHandleSignalError = String(error?.message || error);
  }
  if (!approvedChildHandleSignalAllowed) {
    throw new Error("the approved child handle could not authorize its live descendant: "
      + approvedChildHandleSignalError);
  }
  const reparentedRoot = spawn(process.execPath, [process.argv[2]], {
    env: {
      PATH: process.env.PATH,
      JDY_REGRESSION_CHILD_GUARD_PROBE_DELAY_MS: "600",
      JDY_REGRESSION_CHILD_GUARD_PROBE_REPARENT: "1"
    },
    stdio: ["ignore", "pipe", "ignore"]
  });
  const reparentedPid = await new Promise((resolve, reject) => {
    let output = "";
    reparentedRoot.stdout.on("data", (chunk) => {
      output += String(chunk);
      const parsed = Number(output.trim());
      if (Number.isInteger(parsed) && parsed > 1) resolve(parsed);
    });
    reparentedRoot.once("error", reject);
  });
  process.kill(reparentedPid, 0, reparentedRoot);
  await new Promise((resolve, reject) => {
    reparentedRoot.once("exit", resolve);
    reparentedRoot.once("error", reject);
  });
  let reparentedSignalAllowed = true;
  try { process.kill(reparentedPid, "SIGTERM", reparentedRoot); } catch {
    reparentedSignalAllowed = false;
  }
  if (!reparentedSignalAllowed) {
    throw new Error("a previously proven reparented descendant could not be closed");
  }
  console.log(JSON.stringify({
    detachedBlocked,
    playwrightLaunchCompatible: true,
    wrappersImmutable,
    signingCapabilityClosed,
    watchdogAckCapabilityClosed,
    executionCapabilityClosed,
    rawBindingBlocked,
    primordialBypassBlocked,
    parentSignalBlocked,
    namedParentSignalBlocked,
    rawParentSignalBlocked,
    debugParentSignalBlocked,
    selfTerminationBlocked,
    chromiumOwnedByOuterGroup,
    rawProcessCommandBlocked,
    forgedStackCommandBlocked,
    globalGuardCapabilityHidden,
    suiteLockRelocationBlocked,
    suiteLockRemovalBlocked,
    suiteLockOwnerRemovalBlocked,
    suiteLockPermissionMutationBlocked,
    suiteLockOwnerWriteBlocked,
    proxyFilesystemPathBlocked,
    proxyNetworkOptionsBlocked,
    accessorNetworkOptionsBlocked,
    localFetchAllowed: true,
    forgedChildHandleSignalBlocked,
    approvedChildHandleSignalAllowed,
    arrayPrimordialFrozen,
    proxyArgvBlocked,
    proxyOptionsBlocked,
    namedWorkerBlocked,
    requiredWorkerBlocked,
    reparentedSignalAllowed,
    nestedPid: nested.pid,
    nestedStartedAt: Date.now()
  }));
  process.exitCode = 0;
`;
let direct;
try {
  direct = spawn(process.execPath, [
  "--no-addons",
  "--input-type=module",
  "--eval",
  source,
  guardPath,
  probePath,
  secretDir
], {
  cwd: rootDir,
  detached: process.platform !== "win32",
  env: {
    ...process.env,
    JDY_REGRESSION_CHILD_GUARD_TOKEN: token,
    JDY_REGRESSION_SECRET_REPORT_FD: "3",
    JDY_REGRESSION_DETACHED_SPAWN_LEDGER_FD: "4",
    JDY_REGRESSION_DETACHED_SPAWN_SIGNING_KEY_FD: "5",
    JDY_REGRESSION_DETACHED_SPAWN_LEDGER_PATH: detachedLedger.path,
    JDY_REGRESSION_DETACHED_SPAWN_LEDGER_REFERENCE: JSON.stringify(detachedLedger.reference),
    JDY_REGRESSION_DOCKER_WATCHDOG_PATH: path.join(rootDir, "scripts/helpers/regression-docker-lease-watchdog.mjs"),
    JDY_REGRESSION_DOCKER_WATCHDOG_ACK_FD: "7",
    JDY_REGRESSION_EXECUTION_BASELINE_FD: "8"
  },
  stdio: [
    "ignore",
    "pipe",
    "pipe",
    "pipe",
    detachedLedger.descriptor,
    detachedLedger.signingKeyDescriptor,
    "pipe",
    "pipe",
    executionCapability.descriptor
  ]
  });
} finally {
  closeSync(detachedLedger.descriptor);
  detachedLedger.descriptor = -1;
  closeSync(detachedLedger.signingKeyDescriptor);
  detachedLedger.signingKeyDescriptor = -1;
  closeSync(executionCapability.descriptor);
  executionCapability.descriptor = -1;
}

let stdout = "";
let stderr = "";
let directExitedAt = 0;
let descriptorClosedAt = 0;
direct.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
direct.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
direct.on("exit", () => { directExitedAt = Date.now(); });
direct.stdio[3].on("close", () => { descriptorClosedAt = Date.now(); });
const dockerAckPromise = collectDockerAck(direct);

try {
  const timeout = sleep(12_000, undefined, { ref: false }).then(() => {
    throw new Error("guard contract timed out");
  });
  await Promise.race([
    Promise.all([once(direct, "exit"), once(direct.stdio[3], "close")]),
    timeout
  ]);
  direct.stdio[6].destroy();
  const dockerAck = await dockerAckPromise;
  assert.equal(direct.exitCode, 0, stderr);
  const report = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(report.detachedBlocked, true);
  assert.equal(report.playwrightLaunchCompatible, true);
  assert.equal(report.wrappersImmutable, true);
  assert.equal(report.signingCapabilityClosed, true);
  assert.equal(report.watchdogAckCapabilityClosed, true);
  assert.equal(report.executionCapabilityClosed, true);
  assert.equal(report.rawBindingBlocked, true);
  assert.equal(report.primordialBypassBlocked, true);
  assert.equal(report.parentSignalBlocked, true);
  assert.equal(report.namedParentSignalBlocked, true);
  assert.equal(report.rawParentSignalBlocked, true);
  assert.equal(report.debugParentSignalBlocked, true);
  assert.equal(report.selfTerminationBlocked, true);
  assert.equal(report.chromiumOwnedByOuterGroup, true);
  assert.equal(report.rawProcessCommandBlocked, true);
  assert.equal(report.forgedStackCommandBlocked, true);
  assert.equal(report.globalGuardCapabilityHidden, true);
  assert.equal(report.suiteLockRelocationBlocked, true);
  assert.equal(report.suiteLockRemovalBlocked, true);
  assert.equal(report.suiteLockOwnerRemovalBlocked, true);
  assert.equal(report.suiteLockPermissionMutationBlocked, true);
  assert.equal(report.suiteLockOwnerWriteBlocked, true);
  assert.equal(report.proxyFilesystemPathBlocked, true);
  assert.equal(report.proxyNetworkOptionsBlocked, true);
  assert.equal(report.accessorNetworkOptionsBlocked, true);
  assert.equal(report.localFetchAllowed, true);
  assert.equal(report.forgedChildHandleSignalBlocked, true);
  assert.equal(report.approvedChildHandleSignalAllowed, true);
  assert.equal(report.arrayPrimordialFrozen, true);
  assert.equal(report.proxyArgvBlocked, true);
  assert.equal(report.proxyOptionsBlocked, true);
  assert.equal(report.namedWorkerBlocked, true);
  assert.equal(report.requiredWorkerBlocked, true);
  assert.equal(report.reparentedSignalAllowed, true);
  assert(Number.isInteger(report.nestedPid) && report.nestedPid > 1);
  assert(descriptorClosedAt > 0 && directExitedAt > 0,
    "the inherited control descriptor and direct child must both reach kernel closure");
  assert(directExitedAt - Number(report.nestedStartedAt) >= 300,
    "the guarded bootstrap must remain alive until its approved nested child exits");
  const ledger = readRegressionDetachedSpawnLedger({
    secretDir,
    reference: detachedLedger.reference,
    expectedParentPid: direct.pid,
    requireClosed: true
  });
  assert.equal(ledger.pendingIntentIds.length, 0);
  assert.equal(ledger.members.length, 1,
    "only the signed Docker lease watchdog may detach from the owned outer process group");
  assert.deepEqual(ledger.dockerIntents, []);
  assert.equal(ledger.sealed, true);
  readRegressionDockerWatchdogAck({
    payload: dockerAck,
    ledgerFile: detachedLedger.reference.file,
    runId,
    guardToken: token,
    expectedIntentIds: [],
    expectedCompletedIds: [],
    requireSealed: true
  });
  console.log(JSON.stringify({
    ok: true,
    detachedSpawnBlocked: true,
    trustedPlaywrightLaunchCompatible: true,
    explicitEnvironmentPreserved: true,
    nestedControlDescriptorInherited: true,
    detachedSpawnLedgerClosed: true,
    descriptorRetentionMs: Math.max(0, descriptorClosedAt - directExitedAt)
  }));
} finally {
  if (process.platform !== "win32" && Number.isInteger(direct.pid)) {
    try {
      process.kill(-direct.pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  } else if (direct.exitCode === null) {
    direct.kill("SIGKILL");
  }
  try {
    if (direct?.pid && existsSync(detachedLedger.path)) {
      try {
        removeRegressionDetachedSpawnLedger({
          secretDir,
          reference: detachedLedger.reference,
          expectedParentPid: direct.pid
        });
      } catch { /* Preserve the contract failure; the exact temp root is removed below. */ }
    }
  } finally {
    rmSync(secretDir, { recursive: true, force: true });
  }
}

function collectDockerAck(child) {
  return new Promise((resolve, reject) => {
    let payload = "";
    const timer = setTimeout(() => reject(new Error("Docker watchdog acknowledgement timed out")), 30_000);
    child.stdio[7].on("data", (chunk) => { payload += chunk.toString(); });
    child.stdio[7].once("error", reject);
    child.stdio[7].once("close", () => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}
