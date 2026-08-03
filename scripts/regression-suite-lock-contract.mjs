#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  acquireRegressionSuiteRecoveryClaim,
  readRegressionSuiteOwner,
  regressionSuiteOwnerIsPreIdentity,
  relocateRegressionSuiteLockForReleaseSync,
  relocateRecoveredRegressionSuiteLock,
  writeRegressionSuiteOwnerCas,
  writeRegressionSuiteOwnerFile
} from "./helpers/regression-suite-lock.mjs";

const root = await mkdtemp(path.join(tmpdir(), "a174-suite-lock-contract-"));
const fingerprintA = "a".repeat(64);
const fingerprintB = "b".repeat(64);
const fingerprintC = "c".repeat(64);

try {
  const concurrentLock = path.join(root, "concurrent.lock");
  await mkdir(concurrentLock, { mode: 0o700 });
  const staleOwner = owner({ runId: "1".repeat(32), pid: 901, fingerprint: fingerprintA });
  await writeRegressionSuiteOwnerFile(path.join(concurrentLock, "owner.json"), staleOwner);
  const fingerprints = new Map([[1001, fingerprintB], [1002, fingerprintC]]);
  const contenders = await Promise.allSettled([
    acquireRegressionSuiteRecoveryClaim({
      lockDir: concurrentLock,
      staleOwner,
      claimantPid: 1001,
      claimantFingerprint: fingerprintB,
      processIsAlive: (pid) => fingerprints.has(pid),
      processIdentityFingerprint: (pid) => fingerprints.get(pid)
    }),
    acquireRegressionSuiteRecoveryClaim({
      lockDir: concurrentLock,
      staleOwner,
      claimantPid: 1002,
      claimantFingerprint: fingerprintC,
      processIsAlive: (pid) => fingerprints.has(pid),
      processIdentityFingerprint: (pid) => fingerprints.get(pid)
    })
  ]);
  const winners = contenders.filter(({ status }) => status === "fulfilled");
  const losers = contenders.filter(({ status }) => status === "rejected");
  assert.equal(winners.length, 1, "exactly one concurrent stale recovery claimant must win");
  assert.equal(losers.length, 1);
  assert.match(String(losers[0].reason?.message), /another stale regression recovery is active/);

  const winningClaim = winners[0].value;
  const changedRevision = { ...staleOwner, ownerRevision: 1 };
  await writeRegressionSuiteOwnerFile(path.join(concurrentLock, "owner.json"), changedRevision);
  await assert.rejects(
    relocateRecoveredRegressionSuiteLock({ lockDir: concurrentLock, staleOwner, claim: winningClaim }),
    /ownership ledger changed/,
    "recovery commit must include the stale owner revision"
  );
  const changedSnapshot = { ...staleOwner, state: "tampered-without-revision" };
  await writeRegressionSuiteOwnerFile(path.join(concurrentLock, "owner.json"), changedSnapshot);
  await assert.rejects(
    relocateRecoveredRegressionSuiteLock({ lockDir: concurrentLock, staleOwner, claim: winningClaim }),
    /owner snapshot changed/,
    "recovery commit must compare the complete same-revision owner snapshot"
  );
  await writeRegressionSuiteOwnerFile(path.join(concurrentLock, "owner.json"), staleOwner);
  const recoveredConcurrent = await relocateRecoveredRegressionSuiteLock({
    lockDir: concurrentLock,
    staleOwner,
    claim: winningClaim
  });
  await mkdir(concurrentLock, { mode: 0o700 });
  const newOwner = owner({ runId: "2".repeat(32), pid: 902, fingerprint: fingerprintB });
  await writeRegressionSuiteOwnerFile(path.join(concurrentLock, "owner.json"), newOwner);
  await assert.rejects(
    acquireRegressionSuiteRecoveryClaim({
      lockDir: concurrentLock,
      staleOwner,
      claimantPid: 1001,
      claimantFingerprint: fingerprintB,
      processIsAlive: () => true,
      processIdentityFingerprint: () => fingerprintB
    }),
    /ownership ledger changed/,
    "a delayed old owner reader must be rejected before it publishes a claim in the new canonical lock"
  );
  assert.equal((await readdir(concurrentLock)).some((name) => name.startsWith("recovery.claim.")), false,
    "an ABA-rejected claimant must leave the new canonical lock untouched");
  const foreignClaimDir = path.join(concurrentLock, "recovery.claim.000001");
  await mkdir(foreignClaimDir, { mode: 0o700 });
  await writeFile(path.join(foreignClaimDir, "claim.json"), JSON.stringify(winningClaim), { mode: 0o600 });
  const replacementClaim = await acquireRegressionSuiteRecoveryClaim({
    lockDir: concurrentLock,
    staleOwner: newOwner,
    claimantPid: 1002,
    claimantFingerprint: fingerprintC,
    processIsAlive: (pid) => pid === winningClaim.pid,
    processIdentityFingerprint: () => winningClaim.parentProcessFingerprint
  });
  assert.deepEqual(replacementClaim.staleOwner.runId, newOwner.runId,
    "a claim published into the wrong owner generation must be quarantined, not allowed to block recovery");
  assert.equal((await readdir(concurrentLock)).some((name) => name === `recovery.foreign.${winningClaim.token}`), true);
  await assert.rejects(
    relocateRecoveredRegressionSuiteLock({ lockDir: concurrentLock, staleOwner, claim: winningClaim }),
    /ownership ledger changed/,
    "an old recovery handle must not rename a new canonical lock"
  );
  assert.equal((await readRegressionSuiteOwner(path.join(concurrentLock, "owner.json"))).runId, newOwner.runId);

  const takeoverLock = path.join(root, "takeover.lock");
  await mkdir(takeoverLock, { mode: 0o700 });
  const takeoverOwner = owner({ runId: "3".repeat(32), pid: 903, fingerprint: fingerprintA });
  await writeRegressionSuiteOwnerFile(path.join(takeoverLock, "owner.json"), takeoverOwner);
  const firstClaim = await acquireRegressionSuiteRecoveryClaim({
    lockDir: takeoverLock,
    staleOwner: takeoverOwner,
    claimantPid: 1003,
    claimantFingerprint: fingerprintB,
    processIsAlive: () => false,
    processIdentityFingerprint: () => fingerprintB
  });
  const secondClaim = await acquireRegressionSuiteRecoveryClaim({
    lockDir: takeoverLock,
    staleOwner: takeoverOwner,
    claimantPid: 1004,
    claimantFingerprint: fingerprintC,
    processIsAlive: () => false,
    processIdentityFingerprint: () => fingerprintC
  });
  assert.equal(secondClaim.epoch, firstClaim.epoch + 1, "a dead claimant must be superseded by a new epoch");
  await assert.rejects(
    relocateRecoveredRegressionSuiteLock({ lockDir: takeoverLock, staleOwner: takeoverOwner, claim: firstClaim }),
    /claim ownership changed/,
    "a superseded claim must not commit recovery"
  );
  const recoveredTakeover = await relocateRecoveredRegressionSuiteLock({
    lockDir: takeoverLock,
    staleOwner: takeoverOwner,
    claim: secondClaim
  });

  const casLock = path.join(root, "cas.lock");
  await mkdir(casLock, { mode: 0o700 });
  const casOwner = owner({ runId: "4".repeat(32), pid: 904, fingerprint: fingerprintA });
  const casOwnerPath = path.join(casLock, "owner.json");
  await writeRegressionSuiteOwnerFile(casOwnerPath, casOwner);
  await assert.rejects(
    writeRegressionSuiteOwnerCas({
      ownerPath: casOwnerPath,
      expectedOwner: casOwner,
      nextOwner: { ...casOwner, runId: "5".repeat(32), ownerRevision: 1 }
    }),
    /ownership ledger changed/,
    "CAS must reject immutable owner identity replacement"
  );
  const externalOwner = owner({ runId: "6".repeat(32), pid: 906, fingerprint: fingerprintC });
  await writeRegressionSuiteOwnerFile(casOwnerPath, externalOwner);
  await assert.rejects(
    writeRegressionSuiteOwnerCas({
      ownerPath: casOwnerPath,
      expectedOwner: casOwner,
      nextOwner: { ...casOwner, state: "running", ownerRevision: 1 }
    }),
    /ownership ledger changed/,
    "a stale CAS must not overwrite a replacement owner"
  );
  assert.deepEqual(JSON.parse(await readFile(casOwnerPath, "utf8")), externalOwner);
  await writeRegressionSuiteOwnerFile(casOwnerPath, { ...casOwner, state: "same-revision-tamper" });
  await assert.rejects(
    writeRegressionSuiteOwnerCas({
      ownerPath: casOwnerPath,
      expectedOwner: casOwner,
      nextOwner: { ...casOwner, state: "running", ownerRevision: 1 }
    }),
    /owner snapshot changed/,
    "CAS must reject a same-identity same-revision state mutation"
  );
  assert.equal((await readRegressionSuiteOwner(casOwnerPath)).state, "same-revision-tamper");

  const atomicCasOwner = owner({ runId: "7".repeat(32), pid: 907, fingerprint: fingerprintA });
  await writeRegressionSuiteOwnerFile(casOwnerPath, atomicCasOwner);
  const concurrentCas = await Promise.allSettled(Array.from({ length: 64 }, (_, index) => (
    writeRegressionSuiteOwnerCas({
      ownerPath: casOwnerPath,
      expectedOwner: atomicCasOwner,
      nextOwner: {
        ...atomicCasOwner,
        state: `concurrent-${index}`,
        ownerRevision: 1
      }
    })
  )));
  assert.equal(concurrentCas.filter(({ status }) => status === "fulfilled").length, 1,
    "exactly one same-revision owner CAS may commit");
  assert.equal(concurrentCas.filter(({ status }) => status === "rejected").length, 63,
    "all stale same-revision owner CAS attempts must fail");
  assert.equal((await readRegressionSuiteOwner(casOwnerPath)).ownerRevision, 1);

  const preIdentityBase = owner({
    runId: "8".repeat(32),
    pid: 908,
    fingerprint: fingerprintB,
    state: "creating",
    userId: "",
    requestFenceGeneration: -1,
    artifactBaseline: null
  });
  const persistedBaseline = {
    version: 2,
    file: "artifact-baseline.json",
    device: "1",
    inode: "2",
    sha256: "d".repeat(64),
    entryCount: 0
  };
  const persistedExecutionBaseline = {
    file: "execution-baseline.json",
    device: "3",
    inode: "4",
    size: 1,
    sha256: "e".repeat(64),
    rootDigest: "f".repeat(64),
    runId: "8".repeat(32)
  };
  for (const candidate of [
    { ...preIdentityBase, state: "creating" },
    {
      ...preIdentityBase,
      state: "baseline-ready",
      artifactBaseline: persistedBaseline,
      executionBaseline: persistedExecutionBaseline
    },
    {
      ...preIdentityBase,
      state: "preflight",
      artifactBaseline: persistedBaseline,
      executionBaseline: persistedExecutionBaseline
    },
    { ...preIdentityBase, state: "release-ready", artifactBaseline: null },
    { ...preIdentityBase, state: "release-ready", artifactBaseline: persistedBaseline }
  ]) {
    assert.equal(regressionSuiteOwnerIsPreIdentity(candidate), true,
      `${candidate.state} without an issued generation must be recoverable as pre-identity`);
  }
  for (const candidate of [
    { ...preIdentityBase, state: "fixture-created" },
    { ...preIdentityBase, state: "running" },
    { ...preIdentityBase, state: "release-ready", requestFenceGeneration: 0 },
    { ...preIdentityBase, state: "release-ready", userId: "fixture-user" }
  ]) {
    assert.equal(regressionSuiteOwnerIsPreIdentity(candidate), false,
      `${candidate.state} must not bypass request-fence recovery without exact pre-identity metadata`);
  }

  const runnerSource = await readFile(path.join(import.meta.dirname, "run-regression-tier.mjs"), "utf8");
  const executionCaptureIndex = runnerSource.indexOf("bootstrapExecutionBaseline = captureRegressionExecutionBaselineSync");
  const manifestImportIndex = runnerSource.indexOf('import("./validate-regression-manifest.mjs")');
  const manifestLoadIndex = runnerSource.indexOf("await loadRegressionManifest(rootDir)");
  const suiteLockIndex = runnerSource.indexOf("suiteLock = await acquireSuiteLock");
  const executionPersistenceIndex = runnerSource.indexOf("executionBaselineReference = persistRegressionExecutionBaselineSync");
  const baselineSnapshotIndex = runnerSource.indexOf("artifactBaseline = await snapshotRegressionArtifacts");
  const baselinePublicationIndex = runnerSource.indexOf('state: "baseline-ready"');
  const preflightIndex = runnerSource.indexOf("preflight = await runRegressionPreflight");
  const fixtureIndex = runnerSource.indexOf("suiteFixture = createIsolatedAdminSessionFixture");
  assert(executionCaptureIndex >= 0
    && executionCaptureIndex < manifestImportIndex
    && manifestImportIndex < manifestLoadIndex
    && executionCaptureIndex < suiteLockIndex
    && suiteLockIndex < baselineSnapshotIndex
    && suiteLockIndex < executionPersistenceIndex
    && executionPersistenceIndex < baselineSnapshotIndex
    && baselineSnapshotIndex < baselinePublicationIndex
    && baselinePublicationIndex < preflightIndex
    && preflightIndex < fixtureIndex,
  "tracked execution and artifact baselines must be published before preflight or fixture artifact production");
  assert.match(runnerSource,
    /state: "baseline-ready",\s*artifactBaseline: artifactBaselineReference,\s*executionBaseline: executionBaselineReference/,
    "the baseline-ready CAS must publish tracked execution and artifact references together");
  assert.match(runnerSource,
    /if \(!artifactBaselinePublished\) \{[\s\S]{0,900}?suiteLock\.releaseSync\(\)[\s\S]{0,900}?process\.exit/,
    "a pre-baseline failure must release privately without publishing the shared latest result");
  assert.match(runnerSource,
    /relocateRegressionSuiteLockForReleaseSync\([\s\S]{0,1800}?readPersistedRegressionArtifactBaselineSync/,
    "atomic release must revalidate the exact persisted artifact baseline inside its CAS callback");
  assert.match(runnerSource,
    /relocateRegressionSuiteLockForReleaseSync\([\s\S]{0,3000}?readPersistedRegressionExecutionBaselineSync\([\s\S]{0,600}?assertRegressionExecutionBaselineSync/,
    "atomic release must revalidate the persisted baseline and current tracked tree inside its CAS callback");
  assert.match(runnerSource,
    /function assertStaleRegressionExecutionBaseline[\s\S]{0,900}?readPersistedRegressionExecutionBaselineSync[\s\S]{0,500}?assertRegressionExecutionBaselineSync/,
    "stale recovery must retain the canonical lock unless its durable baseline still matches the current tree");
  assert.match(runnerSource,
    /cleanup\.closed && fixtureLedgerClosed && executionIntegrityComplete/,
    "preflight failure may release its lock only while tracked execution integrity remains complete");
  assert.match(runnerSource,
    /regressionDockerCleanupDeadlineMs\(ledger\.dockerIntents\.length\)/,
    "the watchdog ACK deadline must cover every durable Docker receipt it cleans");
  const finalGreenStateIndex = runnerSource.indexOf("summary.ok = verifiedOutcomeOk");
  const preparePublicationIndex = runnerSource.indexOf("const publication = await prepareLatestPublication(summaryText)", finalGreenStateIndex);
  const publicationCasIndex = runnerSource.indexOf("await suiteLock.update({ latestPublication: publication })", preparePublicationIndex);
  const committedReleaseIndex = runnerSource.indexOf("const release = suiteLock.releaseSync({", publicationCasIndex);
  const postReleaseWriteIndex = runnerSource.indexOf("await persistSummary();", committedReleaseIndex);
  assert(finalGreenStateIndex >= 0
    && finalGreenStateIndex < preparePublicationIndex
    && preparePublicationIndex < publicationCasIndex
    && publicationCasIndex < committedReleaseIndex
    && postReleaseWriteIndex < 0,
  "the green latest candidate must be registered under the canonical lock and never written after release");
  assert.match(runnerSource,
    /async function writeAtomicResult[\s\S]{0,500}?assertRegressionArtifactRootIdentitySync[\s\S]{0,500}?await writeFile[\s\S]{0,300}?assertRegressionArtifactRootIdentitySync[\s\S]{0,200}?await rename/,
    "shared latest publication must bind every write and rename to the captured artifact-root identity");
  assert.match(runnerSource,
    /await removeStaleRegressionSuiteProvisionalDirectories\(\)[\s\S]{0,1000}?regressionSuiteProvisionalPrefix[\s\S]{0,300}?parentProcessFingerprint/,
    "suite-lock acquisition must recover PID-and-fingerprint-named provisional directories");
  const staleChildRecoveryIndex = runnerSource.indexOf("await stopStaleChildGroup(staleOwner)");
  const staleLedgerRecoveryIndex = runnerSource.indexOf("fixtureLedgerRecovery = await recoverStaleFixtureLedgers(", staleChildRecoveryIndex);
  const staleFenceRecoveryIndex = runnerSource.indexOf("await closeStaleSuiteRequestFence(staleOwner, recoveryClaim.token)", staleLedgerRecoveryIndex);
  const staleIdentityRecoveryIndex = runnerSource.indexOf("recoverStaleSuiteIdentity(staleOwner)", staleFenceRecoveryIndex);
  const staleChildAggregateIndex = runnerSource.indexOf("if (executionRecoveryError", staleIdentityRecoveryIndex);
  assert(staleChildRecoveryIndex >= 0
    && staleChildRecoveryIndex < staleLedgerRecoveryIndex
    && staleLedgerRecoveryIndex < staleFenceRecoveryIndex
    && staleFenceRecoveryIndex < staleIdentityRecoveryIndex
    && staleIdentityRecoveryIndex < staleChildAggregateIndex,
  "stale process ambiguity must retain the lock only after request-fence and identity quarantine are attempted");
  const privateDirectoryIndex = runnerSource.indexOf("secretDir = path.join(suiteLock.lockDir, \"private\")");
  const parentLedgerInitializationIndex = runnerSource.indexOf("parentFixtureLedger = initializeRegressionFixtureLedger({");
  const privateOwnerPublicationIndex = runnerSource.indexOf('state: "preflight"');
  assert(baselinePublicationIndex < privateDirectoryIndex
    && privateDirectoryIndex < parentLedgerInitializationIndex
    && parentLedgerInitializationIndex < privateOwnerPublicationIndex
    && privateOwnerPublicationIndex < preflightIndex,
  "the nested private ledger must be initialized before owner publication and preflight");

  const releaseLock = path.join(root, "release.lock");
  await mkdir(releaseLock, { mode: 0o700 });
  const releaseOwner = owner({
    runId: "9".repeat(32),
    pid: 909,
    fingerprint: fingerprintC,
    state: "release-ready",
    userId: "",
    requestFenceGeneration: -1
  });
  await writeRegressionSuiteOwnerFile(path.join(releaseLock, "owner.json"), releaseOwner);
  await mkdir(path.join(releaseLock, "owner.update.lock"), { mode: 0o700 });
  assert.throws(() => relocateRegressionSuiteLockForReleaseSync({
    lockDir: releaseLock,
    expectedOwner: releaseOwner
  }), /CAS lock is active/);
  await rm(path.join(releaseLock, "owner.update.lock"), { recursive: true, force: true });
  await writeRegressionSuiteOwnerFile(path.join(releaseLock, "owner.json"), {
    ...releaseOwner,
    state: "same-revision-tamper"
  });
  assert.throws(() => relocateRegressionSuiteLockForReleaseSync({
    lockDir: releaseLock,
    expectedOwner: releaseOwner
  }), /ownership changed/);
  assert.equal(existsSync(releaseLock), true);
  await writeRegressionSuiteOwnerFile(path.join(releaseLock, "owner.json"), releaseOwner);
  const publicationEvents = [];
  const releasedLock = relocateRegressionSuiteLockForReleaseSync({
    lockDir: releaseLock,
    expectedOwner: releaseOwner,
    publishLatestSync: () => {
      assert.equal(existsSync(releaseLock), true,
        "latest publication must occur while the canonical suite lock still exists");
      publicationEvents.push("publish");
    },
    rollbackPublishedLatestSync: () => publicationEvents.push("rollback")
  });
  assert.deepEqual(publicationEvents, ["publish"],
    "a successful lock relocation must not roll back its already published latest result");
  await mkdir(releaseLock, { mode: 0o700 });
  await writeRegressionSuiteOwnerFile(path.join(releaseLock, "owner.json"), {
    ...releaseOwner,
    runId: "a".repeat(32)
  });
  await rm(releasedLock, { recursive: true, force: true });
  assert.equal(existsSync(path.join(releaseLock, "owner.json")), true,
    "cleanup of a relocated release container must not delete a new canonical lock");

  console.log(JSON.stringify({
    ok: true,
    concurrentSingleWinnerVerified: true,
    ownerRevisionFenceVerified: true,
    staleClaimTakeoverVerified: true,
    canonicalAbaProtectionVerified: true,
    foreignGenerationClaimQuarantined: true,
    immutableCasVerified: true,
    atomicCasSingleWinnerVerified: true,
    fullOwnerSnapshotVerified: true,
    atomicReleaseCasVerified: true,
    nestedPrivateOrderingVerified: true,
    preIdentityRecoveryStatesVerified: true,
    artifactBaselineOrderingVerified: true,
    releaseBeforeGreenPublicationVerified: true,
    provisionalRecoveryVerified: true
  }));

  await rm(recoveredConcurrent, { recursive: true, force: true });
  await rm(recoveredTakeover, { recursive: true, force: true });
} finally {
  await rm(root, { recursive: true, force: true });
}

function owner({
  runId,
  pid,
  fingerprint,
  state = "running",
  userId = "fixture-user",
  requestFenceGeneration = 1,
  artifactBaseline = null,
  executionBaseline = null
}) {
  return {
    runId,
    tier: "full",
    username: "r_full_000000000000000000000000",
    pid,
    state,
    userId,
    requestFenceGeneration,
    secretDir: "",
    childPid: 0,
    childScript: "",
    childProcessFingerprint: "",
    childProcessGuardToken: "",
    childDetachedSpawnLedger: null,
    childProcessLedger: [],
    artifactBaseline,
    executionBaseline,
    parentProcessFingerprint: fingerprint,
    acquiredAt: "2026-08-03T00:00:00.000Z",
    ownerRevision: 0
  };
}
