#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  initializeRegressionDetachedSpawnLedger,
  inspectUnreferencedRegressionDetachedSpawnLedger,
  readRegressionDetachedSpawnLedger,
  removeRegressionDetachedSpawnLedger,
  removeUnpublishedRegressionDetachedSpawnCapability
} from "./helpers/regression-detached-spawn-ledger.mjs";
import { readRegressionDockerWatchdogAck } from "./helpers/regression-docker-lease.mjs";
import {
  captureRegressionExecutionBaselineSync,
  createRegressionExecutionBaselineCapability
} from "./helpers/regression-execution-integrity.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const guardPath = path.join(rootDir, "scripts/helpers/regression-child-process-guard.mjs");
const secretDir = mkdtempSync(path.join(tmpdir(), "a174-detached-ledger-contract-"));
chmodSync(secretDir, 0o700);
const runId = "1".repeat(32);
const childScript = "scripts/a10-entry-efficiency-regression.mjs";
const executionBaseline = captureRegressionExecutionBaselineSync({ rootDir });

function closeCapability(capability) {
  for (const field of ["descriptor", "signingKeyDescriptor"]) {
    if (Number.isInteger(capability?.[field]) && capability[field] >= 0) {
      closeSync(capability[field]);
      capability[field] = -1;
    }
  }
}

async function createSealedLedger(index) {
  const guardToken = String(index).repeat(32).slice(0, 32);
  const capability = initializeRegressionDetachedSpawnLedger({
    secretDir,
    index,
    runId,
    childScript,
    guardToken
  });
  const executionCapability = createRegressionExecutionBaselineCapability({
    secretDir,
    baseline: executionBaseline,
    rootDir
  });
  const source = `
    import { pathToFileURL } from "node:url";
    const guard = await import(pathToFileURL(process.argv[1]).href);
    guard.assertRegressionChildProcessGuardInstalled(process.env.JDY_REGRESSION_CHILD_GUARD_TOKEN);
    guard.sealRegressionDetachedSpawnLedger();
  `;
  let child;
  try {
    child = spawn(process.execPath, ["--no-addons", "--input-type=module", "--eval", source, guardPath], {
      cwd: rootDir,
      env: {
        ...process.env,
        JDY_REGRESSION_CHILD_GUARD_TOKEN: guardToken,
        JDY_REGRESSION_SECRET_REPORT_FD: "3",
        JDY_REGRESSION_DETACHED_SPAWN_LEDGER_FD: "4",
        JDY_REGRESSION_DETACHED_SPAWN_SIGNING_KEY_FD: "5",
        JDY_REGRESSION_DETACHED_SPAWN_LEDGER_PATH: capability.path,
        JDY_REGRESSION_DETACHED_SPAWN_LEDGER_REFERENCE: JSON.stringify(capability.reference),
        JDY_REGRESSION_DOCKER_WATCHDOG_PATH: path.join(rootDir, "scripts/helpers/regression-docker-lease-watchdog.mjs"),
        JDY_REGRESSION_DOCKER_WATCHDOG_ACK_FD: "7",
        JDY_REGRESSION_EXECUTION_BASELINE_FD: "8"
      },
      stdio: [
        "ignore", "ignore", "pipe", "pipe",
        capability.descriptor, capability.signingKeyDescriptor,
        "pipe", "pipe", executionCapability.descriptor
      ]
    });
  } finally {
    closeCapability(capability);
    closeCapability(executionCapability);
  }
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const dockerAckPromise = collectDockerAck(child);
  await once(child, "exit");
  assert.equal(child.exitCode, 0, stderr);
  child.stdio[6].destroy();
  const dockerAck = await dockerAckPromise;
  capability.expectedParentPid = child.pid;
  readRegressionDockerWatchdogAck({
    payload: dockerAck,
    ledgerFile: capability.reference.file,
    runId,
    guardToken,
    expectedIntentIds: [],
    expectedCompletedIds: [],
    requireSealed: true
  });
  return capability;
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

function readOwnedLedger(capability, options = {}) {
  return readRegressionDetachedSpawnLedger({
    secretDir,
    reference: capability.reference,
    expectedParentPid: capability.expectedParentPid,
    ...options
  });
}

function restoreLedger(file, content) {
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
}

try {
  const sealed = await createSealedLedger(1);
  const sealedRead = readOwnedLedger(sealed, {
    requireClosed: true
  });
  assert.equal(sealedRead.sealed, true);
  assert.equal(sealedRead.headerOnly, false);
  assert.equal(sealedRead.members.length, 1);
  assert.deepEqual(sealedRead.dockerIntents, []);
  const original = readFileSync(sealed.path);

  const lines = original.toString("utf8").trimEnd().split("\n");
  assert.equal(lines.length, 4,
    "an empty owned-group ledger must contain header, watchdog intent/member, and seal");
  restoreLedger(sealed.path, `${lines.slice(0, -1).join("\n")}\n`);
  assert.throws(() => readOwnedLedger(sealed, {
    requireClosed: true
  }), /unclosed spawn intent/, "tail truncation must remove the required seal");

  restoreLedger(sealed.path, original);
  const forgedSeal = JSON.parse(lines.at(-1));
  forgedSeal.signature = `${forgedSeal.signature[0] === "A" ? "B" : "A"}${forgedSeal.signature.slice(1)}`;
  restoreLedger(sealed.path, `${lines.slice(0, -1).join("\n")}\n${JSON.stringify(forgedSeal)}\n`);
  assert.throws(() => readOwnedLedger(sealed, {
    requireClosed: true
  }), /signature is invalid/, "a forged seal must never close the ledger");

  restoreLedger(sealed.path, original);
  appendFileSync(sealed.path, "{}\n");
  assert.throws(() => readOwnedLedger(sealed, {
    requireClosed: true
  }), /record after its seal|record sequence is invalid/,
  "records after the signed seal must be rejected");

  restoreLedger(sealed.path, original);
  appendFileSync(sealed.path, "{");
  assert.throws(() => readOwnedLedger(sealed, {
    requireClosed: true
  }), /unclosed spawn intent/, "a partial tail must fail closed");

  restoreLedger(sealed.path, original);
  const hardlink = path.join(secretDir, "ledger-hardlink");
  linkSync(sealed.path, hardlink);
  assert.throws(() => readOwnedLedger(sealed, {
    requireClosed: true
  }), /not one private owned file/);
  unlinkSync(hardlink);

  const backup = `${sealed.path}.owned-backup`;
  renameSync(sealed.path, backup);
  symlinkSync(backup, sealed.path);
  assert.throws(() => readOwnedLedger(sealed, {
    requireClosed: true
  }), /not one private owned file/);
  unlinkSync(sealed.path);
  renameSync(backup, sealed.path);

  appendFileSync(sealed.path, Buffer.alloc(1024 * 1024, 0x20));
  assert.throws(() => readOwnedLedger(sealed, {
    requireClosed: true
  }), /identity or size changed/);
  restoreLedger(sealed.path, original);

  const headerOnly = initializeRegressionDetachedSpawnLedger({
    secretDir,
    index: 2,
    runId,
    childScript,
    guardToken: "2".repeat(32)
  });
  closeCapability(headerOnly);
  const recoveredHeader = inspectUnreferencedRegressionDetachedSpawnLedger({
    secretDir,
    file: headerOnly.reference.file,
    runId,
    requireClosed: true
  });
  assert.equal(recoveredHeader.headerOnly, true,
    "an unpublished start-gated child ledger may be recovered from its signed header alone");
  unlinkSync(headerOnly.path);

  const provisionalFile = ".003.detached-processes.jsonl.0123456789abcdef.tmp";
  writeFileSync(path.join(secretDir, provisionalFile), "partial", { mode: 0o600, flag: "wx" });
  removeUnpublishedRegressionDetachedSpawnCapability({ secretDir, file: provisionalFile });
  assert.equal(existsSync(path.join(secretDir, provisionalFile)), false);

  removeRegressionDetachedSpawnLedger({
    secretDir,
    reference: sealed.reference,
    expectedParentPid: sealed.expectedParentPid
  });
  assert.equal(existsSync(sealed.path), false);
  console.log(JSON.stringify({
    ok: true,
    signedSealVerified: true,
    tailTruncationRejected: true,
    forgedSealRejected: true,
    postSealAppendRejected: true,
    partialTailRejected: true,
    inodeSafetyVerified: true,
    unpublishedHeaderRecovered: true,
    provisionalCapabilityRecovered: true
  }));
} finally {
  rmSync(secretDir, { recursive: true, force: true });
}
