#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertRegressionExecutionBaselineSync,
  captureRegressionExecutionBaselineSync,
  consumeRegressionExecutionBaselineCapabilitySync,
  createRegressionExecutionBaselineCapability,
  persistRegressionExecutionBaselineSync,
  readPersistedRegressionExecutionBaselineSync
} from "./helpers/regression-execution-integrity.mjs";

const contractRoot = mkdtempSync(path.join(tmpdir(), "a174-execution-integrity-contract-"));
const workspace = path.join(contractRoot, "workspace");
mkdirSync(workspace, { mode: 0o700 });
const lockDir = path.join(contractRoot, "lock");
const secretDir = path.join(lockDir, "private");
const scriptPath = path.join(workspace, "script.mjs");
const helperPath = path.join(workspace, "helper.mjs");
const fsmonitorHook = path.join(contractRoot, "fsmonitor-hook.sh");
const fsmonitorMarker = path.join(contractRoot, "fsmonitor-invoked");

try {
  writeFileSync(scriptPath, "export const value = 1;\n", { mode: 0o644 });
  writeFileSync(helperPath, "export const helper = true;\n", { mode: 0o644 });
  git(["init", "-q"]);
  git(["add", "--", "script.mjs", "helper.mjs"]);
  git([
    "-c", "user.name=A174 Contract",
    "-c", "user.email=a174@example.invalid",
    "commit", "-qm", "baseline"
  ]);
  writeFileSync(fsmonitorHook, `#!/bin/sh\n: > ${JSON.stringify(fsmonitorMarker)}\n`, { mode: 0o700 });
  git(["config", "core.fsmonitor", fsmonitorHook]);
  assert.throws(
    () => captureRegressionExecutionBaselineSync({ rootDir: workspace, strictClean: true }),
    /executable setting: core\.fsmonitor/
  );
  assert.equal(exists(fsmonitorMarker), false,
    "execution integrity must reject local fsmonitor before Git can execute it");
  git(["config", "--unset", "core.fsmonitor"]);

  const baseline = captureRegressionExecutionBaselineSync({
    rootDir: workspace,
    strictClean: true
  });
  assert.equal(baseline.entries.length, 2);
  assertRegressionExecutionBaselineSync({ rootDir: workspace, baseline });
  const untrackedScriptsDir = path.join(workspace, "scripts");
  mkdirSync(untrackedScriptsDir, { mode: 0o700 });
  writeFileSync(path.join(untrackedScriptsDir, "untracked-regression.mjs"), "export default true;\n");
  assert.throws(
    () => assertRegressionExecutionBaselineSync({ rootDir: workspace, baseline }),
    /execution source is not tracked/
  );
  rmSync(untrackedScriptsDir, { recursive: true, force: true });
  assertRegressionExecutionBaselineSync({ rootDir: workspace, baseline });

  mkdirSync(lockDir, { mode: 0o700 });
  mkdirSync(secretDir, { mode: 0o700 });
  chmodSync(lockDir, 0o700);
  chmodSync(secretDir, 0o700);
  const reference = persistRegressionExecutionBaselineSync({
    lockDir,
    baseline,
    runId: "a".repeat(32),
    rootDir: workspace
  });
  const persisted = readPersistedRegressionExecutionBaselineSync({
    lockDir,
    reference,
    rootDir: workspace,
    expectedRunId: "a".repeat(32)
  });
  assert.equal(persisted.rootDigest, baseline.rootDigest);
  assert.equal(reference.runId, "a".repeat(32));
  assert.throws(
    () => readPersistedRegressionExecutionBaselineSync({
      lockDir,
      reference,
      rootDir: workspace,
      expectedRunId: "b".repeat(32)
    }),
    /reference is invalid/
  );

  const capability = createRegressionExecutionBaselineCapability({
    secretDir,
    baseline,
    rootDir: workspace
  });
  try {
    const consumed = consumeRegressionExecutionBaselineCapabilitySync(
      capability.descriptor,
      workspace
    );
    assert.equal(consumed.rootDigest, baseline.rootDigest);
  } finally {
    closeSync(capability.descriptor);
  }

  writeFileSync(scriptPath, "export const value = 2;\n");
  assert.throws(
    () => assertRegressionExecutionBaselineSync({ rootDir: workspace, baseline }),
    /tracked execution file drifted/
  );
  writeFileSync(scriptPath, "export const value = 1;\n");
  assertRegressionExecutionBaselineSync({ rootDir: workspace, baseline });

  const backupPath = path.join(workspace, "script.backup");
  renameSync(scriptPath, backupPath);
  linkSync(backupPath, scriptPath);
  assert.throws(
    () => assertRegressionExecutionBaselineSync({ rootDir: workspace, baseline }),
    /not one owned regular inode|drifted/
  );
  unlinkSync(scriptPath);
  renameSync(backupPath, scriptPath);
  assertRegressionExecutionBaselineSync({ rootDir: workspace, baseline });

  const extraPath = path.join(workspace, "extra.mjs");
  writeFileSync(extraPath, "export const extra = true;\n");
  assert.throws(
    () => captureRegressionExecutionBaselineSync({ rootDir: workspace, strictClean: true }),
    /requires one clean/
  );
  git(["add", "--", "extra.mjs"]);
  assert.throws(
    () => assertRegressionExecutionBaselineSync({ rootDir: workspace, baseline }),
    /roster changed/
  );

  console.log(JSON.stringify({
    ok: true,
    strictCleanCaptured: true,
    localFsmonitorRejectedBeforeExecution: true,
    untrackedExecutionSourceRejected: true,
    persistedBaselineVerified: true,
    persistedRunOwnershipVerified: true,
    unlinkedCapabilityConsumed: true,
    contentDriftRejected: true,
    hardlinkReplacementRejected: true,
    rosterDriftRejected: true
  }));
} finally {
  rmSync(contractRoot, { recursive: true, force: true });
}

function git(args) {
  return execFileSync("/usr/bin/git", ["-C", workspace, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function exists(file) {
  try {
    return Boolean(execFileSync("/usr/bin/test", ["-e", file], { stdio: "ignore" }) ?? true);
  } catch {
    return false;
  }
}
