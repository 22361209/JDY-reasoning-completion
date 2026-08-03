#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, chmod, link, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  deserializeRegressionArtifactBaseline,
  persistRegressionArtifactBaseline,
  purgeChangedRegressionArtifacts,
  readPersistedRegressionArtifactBaseline,
  readPersistedRegressionArtifactBaselineSync,
  scanChangedRegressionArtifactsForSecrets,
  serializeRegressionArtifactBaseline,
  snapshotRegressionArtifacts
} from "./helpers/regression-artifact-safety.mjs";

const workspaceRoot = path.resolve(import.meta.dirname, "..");
const verificationRoot = path.join(workspaceRoot, "verification");
await mkdir(verificationRoot, { recursive: true });
const contractRoot = await mkdtemp(path.join(verificationRoot, ".a174-artifact-contract-"));
const externalRoot = await mkdtemp(path.join(tmpdir(), "a174-artifact-target-"));
const refusalWorkspace = await mkdtemp(path.join(tmpdir(), "a174-artifact-refusal-"));
const baselineLockRoot = await mkdtemp(path.join(tmpdir(), "a174-artifact-baseline-lock-"));

try {
  const emptyBaseline = await snapshotRegressionArtifacts(contractRoot);
  const roundTripDirectory = path.join(contractRoot, "round-trip-dir");
  const roundTripFile = path.join(roundTripDirectory, "baseline.txt");
  await mkdir(roundTripDirectory);
  await writeFile(roundTripFile, "baseline\n");
  const roundTripBaseline = await snapshotRegressionArtifacts(contractRoot);
  const serializedBaseline = serializeRegressionArtifactBaseline(roundTripBaseline);
  const deserializedBaseline = deserializeRegressionArtifactBaseline(serializedBaseline);
  assert.deepEqual(serializeRegressionArtifactBaseline(deserializedBaseline), serializedBaseline,
    "artifact baseline serialization must preserve files and directories deterministically");
  const baselineReference = await persistRegressionArtifactBaseline({
    lockDir: baselineLockRoot,
    serialized: serializedBaseline,
    runId: "a".repeat(32)
  });
  const persistedBaseline = await readPersistedRegressionArtifactBaseline({
    lockDir: baselineLockRoot,
    reference: baselineReference
  });
  assert.deepEqual(serializeRegressionArtifactBaseline(persistedBaseline), serializedBaseline);
  assert.deepEqual(
    serializeRegressionArtifactBaseline(readPersistedRegressionArtifactBaselineSync({
      lockDir: baselineLockRoot,
      reference: baselineReference
    })),
    serializedBaseline
  );
  const externalBaselineLink = path.join(externalRoot, "artifact-baseline-hardlink.json");
  await link(path.join(baselineLockRoot, "artifact-baseline.json"), externalBaselineLink);
  await assert.rejects(
    readPersistedRegressionArtifactBaseline({
      lockDir: baselineLockRoot,
      reference: baselineReference
    }),
    /missing or unsafe/,
    "stale recovery must reject a multiply-linked persisted baseline"
  );
  assert.throws(() => readPersistedRegressionArtifactBaselineSync({
    lockDir: baselineLockRoot,
    reference: baselineReference
  }), /missing or unsafe/,
  "atomic release must reject a multiply-linked persisted baseline");
  await unlink(externalBaselineLink);
  assert.throws(() => deserializeRegressionArtifactBaseline({
    ...serializedBaseline,
    entries: [{ relative: "../escape", kind: "directory" }]
  }), /unsafe relative path/);
  assert.throws(() => deserializeRegressionArtifactBaseline({
    ...serializedBaseline,
    entries: [
      { relative: "duplicate", kind: "directory" },
      { relative: "duplicate", kind: "directory" }
    ]
  }), /duplicate path/);
  assert.throws(() => deserializeRegressionArtifactBaseline({
    ...serializedBaseline,
    entries: [{ relative: "extra", kind: "directory", extra: true }]
  }), /unexpected shape/);
  assert.throws(() => deserializeRegressionArtifactBaseline({
    ...serializedBaseline,
    root: { device: "1", inode: "2" }
  }), /root identity is invalid/);
  await rm(roundTripDirectory, { recursive: true, force: true });

  const mutableLogs = path.join(contractRoot, "logs");
  const mutableLog = path.join(mutableLogs, "backend-dev-live.log");
  await mkdir(mutableLogs);
  await writeFile(mutableLog, "service start\n");
  const serviceLogBaseline = await snapshotRegressionArtifacts(contractRoot);
  assert.equal(serviceLogBaseline.has("logs"), false,
    "service-owned log directories must not enter a suite artifact baseline");
  await writeFile(mutableLog, "service start\nrequest handled\n");
  const serviceLogPurge = await purgeChangedRegressionArtifacts({
    root: contractRoot,
    workspaceRoot,
    baseline: serviceLogBaseline
  });
  assert.equal(serviceLogPurge.residueFree, true,
    "normal dev-service log appends must not retain a stale suite lock");
  assert.equal(await readFile(mutableLog, "utf8"), "service start\nrequest handled\n");
  await rm(mutableLogs, { recursive: true, force: true });

  const swappedRoot = path.join(contractRoot, "root-swap");
  const parkedRoot = path.join(contractRoot, "root-swap.parked");
  const externalSentinel = path.join(externalRoot, "must-survive-root-swap.txt");
  await mkdir(swappedRoot);
  await writeFile(externalSentinel, "outside artifact root\n");
  const swappedRootBaseline = await snapshotRegressionArtifacts(swappedRoot);
  await rename(swappedRoot, parkedRoot);
  await symlink(externalRoot, swappedRoot);
  await assert.rejects(
    purgeChangedRegressionArtifacts({
      root: swappedRoot,
      workspaceRoot,
      baseline: swappedRootBaseline
    }),
    /artifact root.*(?:owned regular directory|identity changed)/,
    "artifact purge must reject a symlink replacement of the captured root"
  );
  assert.equal(await readFile(externalSentinel, "utf8"), "outside artifact root\n",
    "artifact purge must never follow a replaced root into an external directory");
  await unlink(swappedRoot);
  await rename(parkedRoot, swappedRoot);
  await rm(swappedRoot, { recursive: true, force: true });

  const deletedBaselinePath = path.join(contractRoot, "deleted-baseline.txt");
  await writeFile(deletedBaselinePath, "must not disappear\n");
  const deletionBaseline = await snapshotRegressionArtifacts(contractRoot);
  await unlink(deletedBaselinePath);
  const deletionResult = await purgeChangedRegressionArtifacts({
    root: contractRoot,
    workspaceRoot,
    baseline: deletionBaseline
  });
  assert.equal(deletionResult.residueFree, false,
    "deleting a pre-existing artifact must retain the suite lock");
  assert.deepEqual(deletionResult.residueFiles, ["deleted-baseline.txt"]);
  assert.equal(deletionResult.cleanupErrors[0]?.file, "deleted-baseline.txt");

  const directoryBaseline = await snapshotRegressionArtifacts(contractRoot);
  const generatedDirectory = path.join(contractRoot, "generated-empty-directory");
  await mkdir(generatedDirectory);
  const purgedDirectory = await purgeChangedRegressionArtifacts({
    root: contractRoot,
    workspaceRoot,
    baseline: directoryBaseline
  });
  assert.deepEqual(purgedDirectory.purgedFiles, ["generated-empty-directory"],
    "a generated empty directory must be purged as regression residue");
  assert.equal(purgedDirectory.residueFree, true);
  await assert.rejects(lstat(generatedDirectory));

  const safePath = path.join(contractRoot, "safe.txt");
  const leakedPath = path.join(contractRoot, "leaked.txt");
  const leakedSecret = "SESSION=artifact-contract-cookie-0001";
  await writeFile(safePath, "safe generated evidence\n");
  await writeFile(leakedPath, `${leakedSecret}\n`);

  const remediated = await scanChangedRegressionArtifactsForSecrets({
    root: contractRoot,
    workspaceRoot,
    baseline: emptyBaseline,
    password: leakedSecret
  });
  assert.equal(remediated.ok, false, "a generated secret exposure must fail the gate");
  assert.equal(remediated.residueFree, true, "a detected generated secret must be removed before return");
  assert.deepEqual(remediated.remediatedFiles, ["leaked.txt"]);
  await assert.rejects(access(leakedPath), "the exposed generated file must no longer exist");

  const purged = await purgeChangedRegressionArtifacts({
    root: contractRoot,
    workspaceRoot,
    baseline: emptyBaseline
  });
  assert.deepEqual(purged.purgedFiles, ["safe.txt"], "incomplete sidecar cleanup must purge every changed generated artifact");
  assert.deepEqual(purged.cleanupErrors, []);
  assert.equal(purged.residueFree, true);
  await assert.rejects(access(safePath), "the changed generated artifact must no longer exist");

  const digestPath = path.join(contractRoot, "digest.txt");
  const digestSecret = "SESSION=artifact-digest-cookie-0002";
  await writeFile(digestPath, "x".repeat(Buffer.byteLength(digestSecret)));
  const digestBaseline = await snapshotRegressionArtifacts(contractRoot);
  const before = await stat(digestPath);
  await writeFile(digestPath, digestSecret);
  await utimes(digestPath, before.atime, before.mtime);
  const digestScan = await scanChangedRegressionArtifactsForSecrets({
    root: contractRoot,
    workspaceRoot,
    baseline: digestBaseline,
    password: digestSecret
  });
  assert.equal(digestScan.ok, false, "same-size and restored-mtime content drift must still be scanned");
  assert.equal(digestScan.residueFree, false,
    "a modified pre-existing artifact must retain the suite lock instead of being destructively deleted");
  assert.equal(await readFile(digestPath, "utf8"), digestSecret);
  assert(digestScan.cleanupErrors.some(({ file }) => file === "digest.txt"));
  await unlink(digestPath);

  const hardlinkSecretPath = path.join(externalRoot, "external-hardlink-secret.txt");
  const hardlinkPath = path.join(contractRoot, "secret-hardlink.txt");
  const hardlinkSecret = "SESSION=artifact-hardlink-cookie-0003";
  await writeFile(hardlinkSecretPath, hardlinkSecret);
  const hardlinkBaseline = await snapshotRegressionArtifacts(contractRoot);
  await link(hardlinkSecretPath, hardlinkPath);
  const hardlinkScan = await scanChangedRegressionArtifactsForSecrets({
    root: contractRoot,
    workspaceRoot,
    baseline: hardlinkBaseline,
    password: hardlinkSecret
  });
  assert.equal(hardlinkScan.ok, false, "a multiply-linked artifact must fail the gate");
  assert.equal(hardlinkScan.residueFree, false,
    "unlinking one pathname cannot prove removal of an externally linked secret inode");
  assert(hardlinkScan.cleanupErrors.some(({ file }) => file === "secret-hardlink.txt"));
  assert.equal(await readFile(hardlinkSecretPath, "utf8"), hardlinkSecret,
    "artifact cleanup must never claim that an external hardlink was remediated");
  await unlink(hardlinkPath);

  const baselineHardlinkPath = path.join(contractRoot, "baseline-hardlink.txt");
  await link(hardlinkSecretPath, baselineHardlinkPath);
  await assert.rejects(
    snapshotRegressionArtifacts(contractRoot),
    /multiply-linked or unsafe file/,
    "a pre-existing hardlink must make the artifact baseline fail closed"
  );
  await unlink(baselineHardlinkPath);

  const externalSecretPath = path.join(externalRoot, "external-secret.txt");
  const symlinkPath = path.join(contractRoot, "secret-link.txt");
  const symlinkSecret = "SESSION=artifact-symlink-cookie-0003";
  await writeFile(externalSecretPath, symlinkSecret);
  const symlinkBaseline = await snapshotRegressionArtifacts(contractRoot);
  await symlink(externalSecretPath, symlinkPath);
  const symlinkScan = await scanChangedRegressionArtifactsForSecrets({
    root: contractRoot,
    workspaceRoot,
    baseline: symlinkBaseline,
    password: symlinkSecret
  });
  assert.equal(symlinkScan.ok, false, "a generated symlink must fail the artifact gate without being followed");
  assert.equal(symlinkScan.residueFree, true);
  assert.deepEqual(symlinkScan.remediatedFiles, ["secret-link.txt"]);
  await assert.rejects(access(symlinkPath));
  assert.equal(await readFile(externalSecretPath, "utf8"), symlinkSecret,
    "artifact remediation must unlink only the symlink and never follow its target");

  const danglingPath = path.join(contractRoot, "dangling-link.txt");
  const danglingBaseline = await snapshotRegressionArtifacts(contractRoot);
  await symlink(path.join(externalRoot, "missing-target.txt"), danglingPath);
  const danglingScan = await scanChangedRegressionArtifactsForSecrets({
    root: contractRoot,
    workspaceRoot,
    baseline: danglingBaseline,
    password: ""
  });
  assert.equal(danglingScan.ok, false, "a dangling generated symlink must fail closed instead of raising ENOENT");
  assert.equal(danglingScan.residueFree, true);
  assert.deepEqual(danglingScan.remediatedFiles, ["dangling-link.txt"]);
  await assert.rejects(lstat(danglingPath), "the dangling symlink itself must be removed");

  const fifoPath = path.join(contractRoot, "blocking-pipe");
  const fifoBaseline = await snapshotRegressionArtifacts(contractRoot);
  execFileSync("/usr/bin/mkfifo", [fifoPath]);
  const fifoScan = await scanChangedRegressionArtifactsForSecrets({
    root: contractRoot,
    workspaceRoot,
    baseline: fifoBaseline,
    password: ""
  });
  assert.equal(fifoScan.ok, false, "a generated FIFO must be removed without opening or reading it");
  assert.equal(fifoScan.residueFree, true);
  assert.deepEqual(fifoScan.remediatedFiles, ["blocking-pipe"]);
  await assert.rejects(access(fifoPath));

  execFileSync("git", ["init", "-q", refusalWorkspace]);
  const refusalRoot = path.join(refusalWorkspace, "verification");
  await mkdir(refusalRoot, { recursive: true });
  await writeFile(path.join(refusalWorkspace, ".gitignore"), "verification/*\n!verification/.gitkeep\n");
  const refusalBaseline = await snapshotRegressionArtifacts(refusalRoot);
  const refusedPath = path.join(refusalRoot, ".gitkeep");
  const laterSecretPath = path.join(refusalRoot, "z-secret.txt");
  await writeFile(refusedPath, "must remain\n");
  await writeFile(laterSecretPath, "SESSION=artifact-later-cookie-0004\n");
  const bestEffortPurge = await purgeChangedRegressionArtifacts({
    root: refusalRoot,
    workspaceRoot: refusalWorkspace,
    baseline: refusalBaseline
  });
  assert.deepEqual(bestEffortPurge.purgedFiles, ["z-secret.txt"],
    "a refused non-ignored entry must not stop cleanup of later ignored artifacts");
  assert.equal(bestEffortPurge.cleanupErrors.length, 1);
  assert.equal(bestEffortPurge.cleanupErrors[0].file, ".gitkeep");
  assert.equal(bestEffortPurge.residueFree, false);
  assert.deepEqual(bestEffortPurge.residueFiles, [".gitkeep"]);
  assert.equal(await readFile(refusedPath, "utf8"), "must remain\n");
  await assert.rejects(lstat(laterSecretPath), "the safe ignored secret must be removed despite a refused peer");

  const unreadableBaseline = await snapshotRegressionArtifacts(contractRoot);
  const unreadablePath = path.join(contractRoot, "a-unreadable.txt");
  const secretAfterUnreadablePath = path.join(contractRoot, "z-after-unreadable.txt");
  await writeFile(unreadablePath, "classification must fail closed\n");
  await chmod(unreadablePath, 0o000);
  await writeFile(secretAfterUnreadablePath, "SESSION=artifact-after-unreadable-0005\n");
  const unreadableScan = await scanChangedRegressionArtifactsForSecrets({
    root: contractRoot,
    workspaceRoot,
    baseline: unreadableBaseline,
    password: "SESSION=artifact-after-unreadable-0005"
  });
  assert.equal(unreadableScan.ok, false, "an unreadable changed artifact must fail the gate");
  assert.equal(unreadableScan.residueFree, true,
    "an unreadable peer must not stop remediation of itself or later ignored secrets");
  assert(unreadableScan.classificationErrors.length >= 1);
  await assert.rejects(lstat(unreadablePath));
  await assert.rejects(lstat(secretAfterUnreadablePath));

  const blockedDirectoryBaseline = await snapshotRegressionArtifacts(contractRoot);
  const blockedDirectoryPath = path.join(contractRoot, "000-blocked");
  const blockedDirectorySecret = path.join(blockedDirectoryPath, "hidden-secret.txt");
  const secretAfterBlockedDirectoryPath = path.join(contractRoot, "z-after-blocked-directory.txt");
  await mkdir(blockedDirectoryPath);
  await writeFile(blockedDirectorySecret, "SESSION=artifact-hidden-cookie-0006\n");
  await chmod(blockedDirectoryPath, 0o000);
  await writeFile(secretAfterBlockedDirectoryPath, "SESSION=artifact-after-directory-0007\n");
  const blockedDirectoryScan = await scanChangedRegressionArtifactsForSecrets({
    root: contractRoot,
    workspaceRoot,
    baseline: blockedDirectoryBaseline,
    password: "SESSION=artifact-after-directory-0007"
  });
  assert.equal(blockedDirectoryScan.ok, false, "an unreadable changed directory must fail the gate");
  assert(blockedDirectoryScan.residueFiles.includes("000-blocked"),
    "the scanner must report an unreadable directory it refuses to delete");
  await assert.rejects(lstat(secretAfterBlockedDirectoryPath),
    "an unreadable directory must not stop cleanup of later ignored secrets");
  await chmod(blockedDirectoryPath, 0o700);

  console.log(JSON.stringify({
    ok: true,
    remediatedSecretArtifacts: remediated.remediatedFiles.length
      + digestScan.remediatedFiles.length
      + symlinkScan.remediatedFiles.length
      + danglingScan.remediatedFiles.length
      + fifoScan.remediatedFiles.length,
    purgedOnIncompleteSidecar: purged.purgedFiles.length,
    bestEffortCleanupVerified: true,
    classificationFailureCleanupVerified: true,
    unreadableDirectoryContinuationVerified: true,
    hardlinkContainmentVerified: true,
    digestBaselineVerified: true,
    persistedBaselineRoundTripVerified: true,
    rootIdentityEscapeBlocked: true,
    baselineDeletionFailClosedVerified: true,
    emptyDirectoryResidueVerified: true
  }));
} finally {
  await rm(contractRoot, { recursive: true, force: true });
  await rm(externalRoot, { recursive: true, force: true });
  await rm(refusalWorkspace, { recursive: true, force: true });
  await rm(baselineLockRoot, { recursive: true, force: true });
}
