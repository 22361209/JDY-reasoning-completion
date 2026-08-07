#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
import { readRegressionDockerWatchdogAck } from "./helpers/regression-docker-lease.mjs";
import {
  captureRegressionExecutionBaselineSync,
  createRegressionExecutionBaselineCapability
} from "./helpers/regression-execution-integrity.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const bootstrapPath = path.join(rootDir, "scripts/helpers/regression-child-bootstrap.mjs");
const probePath = path.join(rootDir, "scripts/helpers/regression-parent-death-probe.mjs");
const authPath = path.join(rootDir, "scripts/helpers/regression-auth.mjs");
const guardPath = path.join(rootDir, "scripts/helpers/regression-child-process-guard.mjs");
const parentWatchdogPath = path.join(rootDir, "scripts/helpers/regression-parent-watchdog.mjs");
const fixtureLedgerPath = path.join(rootDir, "scripts/helpers/regression-fixture-ledger.mjs");
const secretDir = mkdtempSync(path.join(tmpdir(), "a174-parent-death-contract-"));
chmodSync(secretDir, 0o700);
const runId = "e".repeat(32);
const executionBaseline = captureRegressionExecutionBaselineSync({ rootDir });

try {
  const pending = await runScenario({ index: 1, mode: "pending" });
  const completed = await runScenario({ index: 2, mode: "completed" });
  console.log(JSON.stringify({
    ok: true,
    parentEofKilledOwnedGroup: true,
    pendingImportMembersGone: pending.chromiumMembersGone,
    completedImportMembersGone: completed.chromiumMembersGone,
    unsealedPendingImportEvidence: pending.sealed === false,
    signedCompletedImportEvidence: completed.sealed === true,
    unexpectedExitRetainedLockEvidence: true
  }));
} finally {
  rmSync(secretDir, { recursive: true, force: true });
}

async function runScenario({ index, mode }) {
  const token = (index === 1 ? "d" : "f").repeat(32);
  const ledger = initializeRegressionDetachedSpawnLedger({
    secretDir,
    index,
    runId,
    childScript: "scripts/a10-entry-efficiency-regression.mjs",
    guardToken: token
  });
  const executionCapability = createRegressionExecutionBaselineCapability({
    secretDir,
    baseline: executionBaseline,
    rootDir
  });
  let direct;
  try {
    try {
      direct = spawn(process.execPath, ["--no-addons", bootstrapPath, probePath, authPath, guardPath, parentWatchdogPath, fixtureLedgerPath, mode], {
        cwd: rootDir,
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          JDY_REGRESSION_CHILD_GUARD_TOKEN: token,
          JDY_REGRESSION_SECRET_REPORT_FD: "3",
          JDY_REGRESSION_DETACHED_SPAWN_LEDGER_FD: "4",
          JDY_REGRESSION_DETACHED_SPAWN_SIGNING_KEY_FD: "5",
          JDY_REGRESSION_PARENT_WATCHDOG_FD: "6",
          JDY_REGRESSION_DETACHED_SPAWN_LEDGER_PATH: ledger.path,
          JDY_REGRESSION_DETACHED_SPAWN_LEDGER_REFERENCE: JSON.stringify(ledger.reference),
          JDY_REGRESSION_DOCKER_WATCHDOG_PATH: path.join(rootDir, "scripts/helpers/regression-docker-lease-watchdog.mjs"),
          JDY_REGRESSION_DOCKER_WATCHDOG_ACK_FD: "7",
          JDY_REGRESSION_EXECUTION_BASELINE_FD: "8",
          JDY_REGRESSION_DOCKER_WATCHDOG_OWNER_FD: "9"
        },
        stdio: [
          "pipe", "pipe", "pipe", "pipe",
          ledger.descriptor, ledger.signingKeyDescriptor,
          "pipe", "pipe", executionCapability.descriptor, "pipe"
        ]
      });
    } finally {
      closeSync(ledger.descriptor);
      ledger.descriptor = -1;
      closeSync(ledger.signingKeyDescriptor);
      ledger.signingKeyDescriptor = -1;
      closeSync(executionCapability.descriptor);
      executionCapability.descriptor = -1;
    }
    let stderr = "";
    direct.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const dockerAckPromise = collectDockerAck(direct);
    const reader = createInterface({ input: direct.stdout });
    direct.stdin.write("start\n");
    const [line] = await Promise.race([
      once(reader, "line"),
      sleep(8_000, undefined, { ref: false }).then(() => { throw new Error(`probe start timed out: ${stderr}`); })
    ]);
    const report = JSON.parse(line);
    assert.equal(report.ready, true);
    assert.equal(report.directPid, direct.pid);
    assert(report.chromiumPids.length > 0);
    if (mode === "completed") await waitForLedgerSeal(ledger.reference, direct.pid, 2_000);

    // Closing the sole parent control pipe is the observable kernel event produced
    // when the runner exits. The bootstrap must synchronously kill its entire PGID,
    // both before and after the imported manifest module resolves.
    const exit = once(direct, "exit");
    direct.stdin.destroy();
    direct.stdio[6].destroy();
    direct.stdio[9].destroy();
    await Promise.race([
      exit,
      sleep(4_000, undefined, { ref: false }).then(() => { throw new Error(`${mode} owned group survived parent EOF`); })
    ]);
    for (const pid of [report.directPid, ...report.chromiumPids]) {
      await waitUntilGone(pid, 2_000);
    }
    const dockerAck = await dockerAckPromise;
    const observedLedger = readRegressionDetachedSpawnLedger({
      secretDir,
      reference: ledger.reference,
      expectedParentPid: direct.pid,
      requireClosed: false
    });
    for (const member of observedLedger.members) await waitUntilGone(member.pid, 2_000);
    readRegressionDockerWatchdogAck({
      payload: dockerAck,
      ledgerFile: ledger.reference.file,
      runId,
      guardToken: token,
      expectedIntentIds: observedLedger.dockerIntents.map(({ id }) => id),
      expectedCompletedIds: observedLedger.completedDockerIntentIds,
      requireSealed: mode === "completed"
    });
    if (mode === "pending") {
      assert.throws(() => readRegressionDetachedSpawnLedger({
        secretDir,
        reference: ledger.reference,
        expectedParentPid: direct.pid,
        requireClosed: true
      }), /unclosed spawn intent/,
      "parent death before import completion must retain an unsealed fail-closed ledger");
      return { chromiumMembersGone: report.chromiumPids.length, sealed: false };
    }
    const closed = readRegressionDetachedSpawnLedger({
      secretDir,
      reference: ledger.reference,
      expectedParentPid: direct.pid,
      requireClosed: true
    });
    assert.equal(closed.sealed, true);
    return { chromiumMembersGone: report.chromiumPids.length, sealed: true };
  } finally {
    if (direct?.pid && process.platform !== "win32") {
      try { process.kill(-direct.pid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
    }
    try { unlinkSync(ledger.path); } catch (error) { if (error?.code !== "ENOENT") throw error; }
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

async function waitForLedgerSeal(reference, expectedParentPid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ledger = readRegressionDetachedSpawnLedger({
      secretDir,
      reference,
      expectedParentPid,
      requireClosed: false
    });
    if (ledger.sealed) return;
    await sleep(10);
  }
  throw new Error("completed import did not seal its detached process ledger");
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
    await sleep(25);
  }
  throw new Error(`owned process ${pid} survived bounded parent-death cleanup`);
}
