import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertRegressionExecutionBaselineSync,
  captureRegressionExecutionBaselineSync,
  createRegressionExecutionBaselineCapability,
  persistRegressionExecutionBaselineSync,
  readPersistedRegressionExecutionBaselineSync
} from "./helpers/regression-execution-integrity.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const args = process.argv.slice(2);
const continueOnFailure = args.includes("--continue-on-failure") || args.includes("--continue");
const listOnly = args.includes("--list");
const requestedTier = args.find((arg) => !arg.startsWith("--")) ?? "smoke";
const tier = requestedTier.endsWith(":continue") ? requestedTier.slice(0, -":continue".length) : requestedTier;
const shouldContinue = continueOnFailure || requestedTier.endsWith(":continue");
const resultTier = shouldContinue && tier === "full" ? "full-continue" : tier;
// Child exit can precede kernel EOF on an already-proven private descriptor
// while the operating system drains its final close notification. Keep this
// bounded; an actually retained descriptor still fails the suite closed.
const childDescriptorCloseGraceMs = 10_000;
const bootstrapExecutionBaseline = captureRegressionExecutionBaselineSync({
  rootDir,
  strictClean: tier === "full"
});
assertRegressionExecutionBaselineSync({ rootDir, baseline: bootstrapExecutionBaseline });

const [
  manifestModule,
  authModule,
  preflightModule,
  secretChannelModule,
  processTreeModule,
  detachedLedgerModule,
  artifactSafetyModule,
  suiteLockModule,
  credentialCapabilityModule,
  dockerLeaseModule,
  fixtureLedgerModule
] = await Promise.all([
  import("./validate-regression-manifest.mjs"),
  import("./helpers/regression-auth.mjs"),
  import("./helpers/regression-preflight.mjs"),
  import("./helpers/regression-secret-channel.mjs"),
  import("./helpers/regression-process-tree.mjs"),
  import("./helpers/regression-detached-spawn-ledger.mjs"),
  import("./helpers/regression-artifact-safety.mjs"),
  import("./helpers/regression-suite-lock.mjs"),
  import("./helpers/regression-credential-capability.mjs"),
  import("./helpers/regression-docker-lease.mjs"),
  import("./helpers/regression-fixture-ledger.mjs")
]);
const { loadRegressionManifest } = manifestModule;
const {
  closeAndRecoverRegressionFixtureLedger,
  createIsolatedAdminSessionFixture,
  manageRegressionRequestFence,
  recoverIsolatedAdminSessionFixture
} = authModule;
const {
  assertRegressionPostflight,
  assertSharedAdminSessionInvariant,
  assertSharedRegressionBaseline,
  runRegressionPreflight
} = preflightModule;
const { RegressionSecretFrameCollector } = secretChannelModule;
const {
  adoptRegressionProcessLedgerRecords,
  classifyRegressionProcessGroupLedger,
  mergeRegressionProcessGroupLedger,
  selectRegressionProcessOwnershipMembers,
  signalRegressionProcessGroupLedger
} = processTreeModule;
const {
  initializeRegressionDetachedSpawnLedger,
  inspectUnreferencedRegressionDetachedSpawnLedger,
  readRegressionDetachedSpawnLedger,
  removeRecoveredRegressionDetachedSpawnLedger,
  removeUnpublishedRegressionDetachedSpawnCapability,
  removeRegressionDetachedSpawnLedger
} = detachedLedgerModule;
const {
  assertRegressionArtifactRootIdentitySync,
  persistRegressionArtifactBaseline,
  purgeChangedRegressionArtifacts,
  readPersistedRegressionArtifactBaseline,
  readPersistedRegressionArtifactBaselineSync,
  regressionArtifactPayloadContainsSecret,
  scanChangedRegressionArtifactsForSecrets,
  serializeRegressionArtifactBaseline,
  snapshotRegressionArtifacts
} = artifactSafetyModule;
const {
  acquireRegressionSuiteRecoveryClaim,
  assertRegressionSuiteOwnerSnapshotMatches,
  readRegressionSuiteOwner,
  regressionSuiteOwnerIsPreIdentity,
  relocateRegressionSuiteLockForReleaseSync,
  relocateRecoveredRegressionSuiteLock,
  writeRegressionSuiteOwnerCas,
  writeRegressionSuiteOwnerFile
} = suiteLockModule;
const {
  publishRegressionCredentialCapability,
  removeStaleRegressionCredentialCapabilities
} = credentialCapabilityModule;
const {
  captureRegressionDockerOwnershipSync,
  cleanupRegressionDockerLeaseIntents,
  regressionDockerCleanupDeadlineMs,
  readRegressionDockerWatchdogAck,
  scavengeRegressionDockerClosedReceipts
} = dockerLeaseModule;
const {
  initializeRegressionFixtureLedger,
  inspectUnreferencedRegressionFixtureLedger,
  readRegressionFixtureLedger,
  removeRegressionFixtureLedger,
  sealRegressionFixtureLedger
} = fixtureLedgerModule;

assertRegressionExecutionBaselineSync({ rootDir, baseline: bootstrapExecutionBaseline });
const { manifest, summary: manifestSummary } = await loadRegressionManifest(rootDir);
assertRegressionExecutionBaselineSync({ rootDir, baseline: bootstrapExecutionBaseline });
const smokeScripts = manifest.smoke;
const areaScripts = manifest.areas;
const fullScripts = manifest.full;

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: node scripts/run-regression-tier.mjs smoke|area:<module>|full [--continue-on-failure] [--list]

Examples:
  node scripts/run-regression-tier.mjs smoke
  node scripts/run-regression-tier.mjs area:sales
  node scripts/run-regression-tier.mjs full
  node scripts/run-regression-tier.mjs full --continue-on-failure
  node scripts/run-regression-tier.mjs full --list

Areas:
  ${Object.keys(areaScripts).sort().join(", ")}`);
  process.exit(0);
}

const startedAt = new Date().toISOString();
const scripts = await scriptsForTier(tier);
if (listOnly) {
  console.log(JSON.stringify({
    tier,
    total: scripts.length,
    manifest: manifestSummary.manifest,
    scripts
  }, null, 2));
  process.exit(0);
}
const safeTier = resultTier.replace(/[^a-zA-Z0-9_-]/g, "-");
const resultPath = path.join(verificationDir, `regression-tier-${safeTier}-latest.json`);
const results = [];
const runId = randomUUID().replaceAll("-", "");
const requestFenceControlToken = randomUUID().replaceAll("-", "");
const requestFenceControlDigest = createHash("sha256").update(requestFenceControlToken).digest("hex");
const suiteUsername = "r_full_000000000000000000000000";
const suiteDisplayName = "本地管理员";
const regressionChildGuardTokenEnvironment = "JDY_REGRESSION_CHILD_GUARD_TOKEN";
const regressionDetachedSpawnLedgerFdEnvironment = "JDY_REGRESSION_DETACHED_SPAWN_LEDGER_FD";
const regressionDetachedSpawnSigningKeyFdEnvironment = "JDY_REGRESSION_DETACHED_SPAWN_SIGNING_KEY_FD";
const regressionDetachedSpawnLedgerPathEnvironment = "JDY_REGRESSION_DETACHED_SPAWN_LEDGER_PATH";
const regressionDetachedSpawnLedgerReferenceEnvironment = "JDY_REGRESSION_DETACHED_SPAWN_LEDGER_REFERENCE";
const regressionDockerWatchdogPathEnvironment = "JDY_REGRESSION_DOCKER_WATCHDOG_PATH";
const regressionDockerWatchdogAckFdEnvironment = "JDY_REGRESSION_DOCKER_WATCHDOG_ACK_FD";
const regressionExecutionBaselineFdEnvironment = "JDY_REGRESSION_EXECUTION_BASELINE_FD";
const regressionSuiteLockDir = path.join(tmpdir(), "jdy-erp-regression-suite.lock");
const regressionSuiteProvisionalPrefix = "jdy-erp-regression-suite.provisional-";
const regressionJavaHome = realpathSync("/opt/homebrew/opt/openjdk@21");

await mkdir(path.dirname(resultPath), { recursive: true });

let suiteLock = null;
let suiteFixture = null;
let secretDir = "";
let parentFixtureLedger = null;
let artifactBaseline = null;
let artifactBaselinePublished = false;
let executionBaseline = bootstrapExecutionBaseline;
let executionBaselineReference = null;
let executionIntegrityComplete = true;
let activeChild = null;
let activeChildFixtureLedger = null;
let activeChildDetachedSpawnLedger = null;
let terminationSignal = "";
let terminationEscalationTimer = null;
let childProcessGroupClosed = true;
let processOwnershipComplete = true;
let dockerLeaseClosureComplete = true;
let suiteDockerOwnership = null;
let setupError = "";
let secretScan = { ok: true, residueFree: true, scannedChangedFiles: 0 };
let secretChannelComplete = true;
let auxiliaryFixturesClosed = true;
let suiteReleasePrepared = false;
let completionCommitted = false;
const secretChannelErrors = [];
const childReportedSecrets = new Set();
childReportedSecrets.add(requestFenceControlToken);
const releaseCleanupWarnings = [];
const assertSuiteExecutionIntegrity = () => {
  try {
    return assertRegressionExecutionBaselineSync({ rootDir, baseline: executionBaseline });
  } catch (error) {
    executionIntegrityComplete = false;
    throw error;
  }
};
let suiteIdentity = { mode: "suite-tombstone-admin", created: false, cleanup: { ok: false, error: "not started" } };
let postflight = { ok: false, error: "not started" };
const onTerminationSignal = (signal) => {
  if (completionCommitted) {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.kill(process.pid, signal);
    return;
  }
  const repeated = Boolean(terminationSignal);
  if (!terminationSignal) terminationSignal = signal;
  tryTerminateOwnedChildProcessGroup(activeChild, repeated ? "SIGKILL" : "SIGTERM");
  if (repeated) {
    activeChild?.forceClose?.("regression child was force-closed after a repeated termination signal");
    return;
  }
  if (activeChild) {
    terminationEscalationTimer = setTimeout(() => {
      tryTerminateOwnedChildProcessGroup(activeChild, "SIGKILL");
      activeChild?.forceClose?.("regression child was closed after bounded SIGKILL escalation");
    }, 5_000);
    terminationEscalationTimer.unref?.();
  }
};
const onSigint = () => onTerminationSignal("SIGINT");
const onSigterm = () => onTerminationSignal("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);

let preflight;
try {
  suiteLock = await acquireSuiteLock({
    runId,
    tier: resultTier,
    username: suiteUsername,
    requestFenceControlDigest
  });
  suiteDockerOwnership = captureRegressionDockerOwnershipSync({ execFileSync });
  await scavengeRegressionDockerClosedReceipts({ ownership: suiteDockerOwnership });
  executionBaselineReference = persistRegressionExecutionBaselineSync({
    lockDir: suiteLock.lockDir,
    baseline: executionBaseline,
    runId,
    rootDir
  });
  artifactBaseline = await snapshotRegressionArtifacts(verificationDir);
  const artifactBaselineReference = await persistRegressionArtifactBaseline({
    lockDir: suiteLock.lockDir,
    serialized: serializeRegressionArtifactBaseline(artifactBaseline),
    runId
  });
  await suiteLock.update({
    state: "baseline-ready",
    artifactBaseline: artifactBaselineReference,
    executionBaseline: executionBaselineReference
  });
  artifactBaselinePublished = true;
  assertSuiteExecutionIntegrity();
  // Keep all pre-publication metadata below the already durable suite lock. A crash
  // before the owner CAS can therefore leave no orphan outside the directory that stale
  // recovery atomically relocates and removes.
  secretDir = path.join(suiteLock.lockDir, "private");
  await mkdir(secretDir, { mode: 0o700 });
  parentFixtureLedger = initializeRegressionFixtureLedger({
    secretDir,
    name: "parent",
    runId
  });
  childReportedSecrets.add(parentFixtureLedger.signingPrivateKey);
  await suiteLock.update({ state: "preflight", userId: "", secretDir });
  assertSuiteExecutionIntegrity();
  preflight = await runRegressionPreflight({
    rootDir,
    tier,
    scripts,
    adminFixtureOptions: {
      username: suiteUsername,
      displayName: suiteDisplayName,
      allowForcedRedisRelease: true,
      reuseQuarantinedIdentity: true,
      retainQuarantinedIdentity: true,
      adoptLegacySuiteTombstone: true,
      autoManageRequestFence: true,
      requestFenceControlToken,
      fixtureLedgerWriter: parentFixtureLedger.writer,
      fixtureLedgerRunId: runId
    }
  });
  assertSuiteExecutionIntegrity();
  await suiteLock.update({
    state: "preflight",
    userId: preflight.user.fixtureUserId,
    requestFenceGeneration: preflight.user.fixtureRequestFenceGeneration,
    secretDir
  });
  console.log(JSON.stringify({ tier, preflight: "regression-environment", ok: true, ...preflight }));
} catch (error) {
  let message = error instanceof Error ? error.message : String(error);
  if (suiteLock) {
    let fixtureLedgerClosed = false;
    try {
      if (parentFixtureLedger) {
        const parentFixtureClosure = await closeAndRecoverRegressionFixtureLedger(
          "http://127.0.0.1:8080",
          {
            secretDir,
            reference: parentFixtureLedger.reference,
            writer: parentFixtureLedger.writer
          },
          runId,
          requestFenceControlToken
        );
        const latestSuiteOwner = parentFixtureClosure.results
          .filter((entry) => entry.username === suiteUsername)
          .sort((left, right) => right.generation - left.generation)[0];
        if (latestSuiteOwner) {
          await suiteLock.update({
            userId: latestSuiteOwner.userId,
            requestFenceGeneration: latestSuiteOwner.generation
          });
        }
        sealRegressionFixtureLedger(parentFixtureLedger.writer);
        removeRegressionFixtureLedger({
          secretDir,
          reference: parentFixtureLedger.reference,
          requireSealed: true
        });
        parentFixtureLedger = null;
      }
      fixtureLedgerClosed = true;
      const cleanup = recoverIsolatedAdminSessionFixture({
        username: suiteUsername,
        displayName: suiteDisplayName,
        retainQuarantinedIdentity: true,
        allowIdentityNeverCreated: true,
        allowLegacySuiteTombstoneAdoption: true
      });
      if (cleanup.closed && fixtureLedgerClosed && executionIntegrityComplete) {
        await suiteLock.update({
          state: "release-ready",
          childPid: 0,
          childScript: "",
          childProcessFingerprint: "",
          childProcessGuardToken: "",
          childDetachedSpawnLedger: null,
          childProcessLedger: []
        });
        await suiteLock.assertReleaseReady();
        suiteReleasePrepared = true;
      }
    } catch (cleanupError) {
      message = `${message}; preflight recovery failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
    }
  }
  if (!suiteLock) {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    console.error(`Regression preflight rejected before suite-lock ownership: ${message}`);
    process.exit(terminationSignal === "SIGINT" ? 130 : terminationSignal === "SIGTERM" ? 143 : 1);
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    tier,
    resultTier,
    continueOnFailure: shouldContinue,
    ok: false,
    total: 0,
    expectedTotal: scripts.length,
    badCount: 1,
    skipped: scripts.length,
    startedAt,
    finishedAt: new Date().toISOString(),
    resultPath: path.relative(rootDir, resultPath),
    manifest: manifestSummary.manifest,
    availableAreas: Object.keys(areaScripts).sort(),
    preflight: { ok: false, error: message },
    suiteLock: { releasePrepared: suiteReleasePrepared, releaseCommitted: false },
    terminationSignal: terminationSignal || null,
    results: []
  };
  if (!artifactBaselinePublished) {
    if (suiteReleasePrepared) {
      try {
        const release = suiteLock.releaseSync();
        completionCommitted = true;
        secretDir = "";
        releaseCleanupWarnings.push(...release.cleanupErrors);
      } catch (releaseError) {
        message = `${message}; pre-baseline lock release failed: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`;
      }
    }
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    console.error(`Regression preflight failed before artifact-baseline publication: ${message}`);
    process.exit(terminationSignal === "SIGINT" ? 130 : terminationSignal === "SIGTERM" ? 143 : 1);
  }
  if (suiteReleasePrepared && !terminationSignal) {
    try {
      const release = suiteLock.releaseSync();
      completionCommitted = true;
      secretDir = "";
      releaseCleanupWarnings.push(...release.cleanupErrors);
    } catch (releaseError) {
      message = `${message}; preflight lock release failed: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`;
      summary.preflight.error = message;
      summary.suiteLock.releaseError = releaseError instanceof Error ? releaseError.message : String(releaseError);
    }
  }
  if (completionCommitted) await new Promise((resolve) => setImmediate(resolve));
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  console.error(`Regression preflight failed: ${message}`);
  process.exit(terminationSignal === "SIGINT" ? 130 : terminationSignal === "SIGTERM" ? 143 : 1);
}

try {
  if (terminationSignal) throw new Error(`regression suite interrupted during preflight by ${terminationSignal}`);
  suiteFixture = createIsolatedAdminSessionFixture(preflight.apiBase, {
    label: "full",
    username: suiteUsername,
    displayName: suiteDisplayName,
    allowForcedRedisRelease: true,
    reuseQuarantinedIdentity: true,
    retainQuarantinedIdentity: true,
    adoptLegacySuiteTombstone: true,
    requestFenceControlToken,
    fixtureLedgerWriter: parentFixtureLedger.writer,
    fixtureLedgerRunId: runId
  });
  suiteIdentity = { mode: "suite-tombstone-admin", created: true, cleanup: { ok: false, error: "pending" } };
  await suiteLock.update({
    state: "fixture-created",
    userId: suiteFixture.userId,
    requestFenceGeneration: suiteFixture.requestFenceGeneration
  });
  await suiteFixture.openRequestFence();
  await suiteLock.update({
    state: "running",
    userId: suiteFixture.userId,
    secretDir
  });
  const credentials = {
    runId,
    userId: suiteFixture.userId,
    username: suiteFixture.username,
    password: suiteFixture.password,
    requestFenceControlToken,
    apiBase: preflight.apiBase,
    frontendBase: "http://127.0.0.1:5173"
  };

  for (const [index, script] of scripts.entries()) {
    if (terminationSignal) break;
    assertSuiteExecutionIntegrity();
    const started = Date.now();
    const childFixtureLedger = initializeRegressionFixtureLedger({
      secretDir,
      name: String(index + 1).padStart(3, "0"),
      runId
    });
    childReportedSecrets.add(childFixtureLedger.signingPrivateKey);
    activeChildFixtureLedger = childFixtureLedger;
    const childProcessGuardToken = randomUUID().replaceAll("-", "");
    childReportedSecrets.add(childProcessGuardToken);
    const childDetachedSpawnLedger = initializeRegressionDetachedSpawnLedger({
      secretDir,
      index: index + 1,
      runId,
      childScript: script,
      guardToken: childProcessGuardToken
    });
    const childExecutionBaselineCapability = createRegressionExecutionBaselineCapability({
      secretDir,
      baseline: executionBaseline,
      rootDir
    });
    activeChildDetachedSpawnLedger = childDetachedSpawnLedger;
    const result = await runScript(script, {
      credentials,
      secretDir,
      fixtureLedger: childFixtureLedger,
      index,
      childProcessGuardToken,
      childDetachedSpawnLedger,
      childExecutionBaselineCapability,
      isolatedBackend: preflight.adminCredentialContract.spawnedBackendExclusions.includes(script),
      usesSuiteCredentials: preflight.adminCredentialContract.mainCredentialScripts.includes(script),
      onChild: async (handle) => {
        activeChild = handle;
        childProcessGroupClosed = false;
        handle.childScript = script;
        handle.childProcessFingerprint = proveChildProcessLeaderOwnership(handle);
        assertSuiteExecutionIntegrity();
        refreshChildProcessLedger(handle);
        await suiteLock.update({
          state: "running-child",
          childPid: handle.child.pid,
          childScript: script,
          childProcessFingerprint: handle.childProcessFingerprint,
          childProcessGuardToken: handle.childProcessGuardToken,
          childDetachedSpawnLedger: handle.childDetachedSpawnLedger,
          childProcessLedger: handle.childProcessLedger,
          diagnosticError: ""
        });
        startChildProcessLedgerMonitor(handle, async (childProcessLedger) => {
          await suiteLock.update({ childProcessLedger });
        }, async (error) => {
          await suiteLock.update({
            diagnosticError: redactOutput(
              error instanceof Error ? error.message : String(error),
              suiteFixture?.password || "",
              [...childReportedSecrets]
            ).slice(0, 1_024)
          });
        });
      }
    });
    assertSuiteExecutionIntegrity();
    for (const secret of result.sensitiveValues || []) childReportedSecrets.add(secret);
    if (result.secretReportComplete !== true) {
      secretChannelComplete = false;
      processOwnershipComplete = false;
      secretChannelErrors.push(`${script}: ${result.secretReportError || "secret report did not close"}`);
    }
    if (result.childCloseForced === true) {
      processOwnershipComplete = false;
      setupError = [
        setupError,
        `regression child output descriptors outlived its process: ${script}`
      ].filter(Boolean).join("; ");
    }
    const completedChild = activeChild;
    try {
      await completedChild?.stopProcessLedgerMonitor?.();
    } catch (error) {
      processOwnershipComplete = false;
      setupError = [setupError, error instanceof Error ? error.message : String(error)].filter(Boolean).join("; ");
    }
    if (closeChildDetachedSpawnLedger(completedChild)) {
      await suiteLock.update({ childProcessLedger: completedChild.childProcessLedger });
    }
    const lingeringChildError = await closeCompletedChildGroup(completedChild);
    // Completion can race a signed watchdog's final short-lived descendants.
    // Persist any safely reconciled identities before the suite advances, so a
    // crash after the bounded cleanup retains the same exact-member evidence.
    if (suiteLock) {
      await suiteLock.update({ childProcessLedger: completedChild.childProcessLedger });
    }
    if (processGroupIsAlive(completedChild)) {
      throw new Error("regression child process group survived bounded cleanup; lock ownership was preserved");
    }
    childProcessGroupClosed = true;
    if (closeChildDetachedSpawnLedger(completedChild)) {
      await suiteLock.update({ childProcessLedger: completedChild.childProcessLedger });
    }
    let dockerLeaseCleanupError = "";
    try {
      closeChildDockerLeaseWatchdog(completedChild);
    } catch (error) {
      dockerLeaseClosureComplete = false;
      dockerLeaseCleanupError = error instanceof Error ? error.message : String(error);
    }
    try {
      await closeAndRecoverRegressionFixtureLedger(preflight.apiBase, {
        secretDir,
        reference: childFixtureLedger.reference,
        writer: childFixtureLedger.writer
      }, runId, requestFenceControlToken);
      sealRegressionFixtureLedger(childFixtureLedger.writer);
      removeRegressionFixtureLedger({
        secretDir,
        reference: childFixtureLedger.reference,
        requireSealed: true
      });
      activeChildFixtureLedger = null;
    } catch (error) {
      auxiliaryFixturesClosed = false;
      throw new Error(`regression auxiliary fixture closure failed for ${script}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (result.secretReportComplete === true
      && processOwnershipComplete
      && completedChild?.dockerLeaseClosureVerified === true) {
      await suiteLock.update({
        state: "running",
        childPid: 0,
        childScript: "",
        childProcessFingerprint: "",
        childProcessGuardToken: "",
        childDetachedSpawnLedger: null,
        childProcessLedger: []
      });
      // The durable owner no longer references a live process. From this point an
      // interrupted unlink is an unreferenced, strictly closed sidecar that stale
      // recovery validates in place before relocating the whole lock container.
      activeChild = null;
      await scavengeRegressionDockerClosedReceipts({ ownership: suiteDockerOwnership });
      removeRegressionDetachedSpawnLedger({
        secretDir,
        reference: completedChild.childDetachedSpawnLedger,
        expectedParentPid: completedChild.child.pid,
        allowHeaderOnly: true
      });
      activeChildDetachedSpawnLedger = null;
    } else {
      await suiteLock.update({
        state: processOwnershipComplete
          ? "docker-closure-incomplete"
          : "process-ownership-incomplete",
        childPid: Number(completedChild?.child?.pid || 0),
        childScript: String(completedChild?.childScript || ""),
        childProcessFingerprint: String(completedChild?.childProcessFingerprint || ""),
        childProcessGuardToken: String(completedChild?.childProcessGuardToken || ""),
        childDetachedSpawnLedger: completedChild?.childDetachedSpawnLedger || null,
        childProcessLedger: completedChild?.childProcessLedger || []
      });
    }
    activeChild = null;
    clearTerminationTimers();
    if (dockerLeaseCleanupError) {
      throw new Error(`regression Docker lease cleanup failed for ${script}: ${dockerLeaseCleanupError}`);
    }
    if (lingeringChildError) {
      result.status = 1;
      result.stderr = [result.stderr, lingeringChildError].filter(Boolean).join("\n");
    }
    let sharedStateInvariantError = "";
    try {
      await assertSharedAdminSessionInvariant(preflight, script);
      if (preflight.sharedStateMutationScripts.includes(script)) {
        await assertSharedRegressionBaseline(preflight, script);
      }
    } catch (error) {
      sharedStateInvariantError = error instanceof Error ? error.message : String(error);
    }
    const finished = Date.now();
    const entry = {
      script,
      ok: result.status === 0 && !sharedStateInvariantError,
      status: sharedStateInvariantError ? 1 : result.status,
      durationMs: finished - started,
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(finished).toISOString(),
      stdoutTail: tail(redactOutput(
        result.stdout,
        credentials.password,
        [...(result.sensitiveValues || []), childProcessGuardToken]
      )),
      stderrTail: tail(redactOutput(
        [result.stderr, sharedStateInvariantError].filter(Boolean).join("\n"),
        credentials.password,
        [...(result.sensitiveValues || []), childProcessGuardToken]
      )),
      sharedStateInvariantError: sharedStateInvariantError || null
    };
    results.push(entry);
    console.log(JSON.stringify({ tier, script, ok: entry.ok, status: entry.status, durationMs: entry.durationMs, continueOnFailure: shouldContinue }));
    if (!entry.ok && entry.stderrTail) {
      // Full results are only published after lock release. Emit the already
      // redacted per-script tail as well, so a fail-closed ownership stop is
      // diagnosable without publishing an incomplete suite summary.
      console.error(JSON.stringify({ tier, script, stderrTail: entry.stderrTail }));
    }
    if (sharedStateInvariantError) {
      console.error(`Regression stopped after shared regression-state drift: ${sharedStateInvariantError}`);
      break;
    }
    if (!processOwnershipComplete) {
      console.error("Regression stopped because a child secret descriptor outlived its owned process group; the suite lock was retained");
      break;
    }
    if (!entry.ok && !shouldContinue) break;
  }
} catch (error) {
  setupError = error instanceof Error ? error.message : String(error);
  console.error(`Regression suite setup failed before script execution: ${redactOutput(setupError, suiteFixture?.password || "", [...childReportedSecrets])}`);
} finally {
  if (activeChild) {
    try {
      await activeChild.stopProcessLedgerMonitor?.();
    } catch (error) {
      processOwnershipComplete = false;
      setupError = [setupError, error instanceof Error ? error.message : String(error)].filter(Boolean).join("; ");
    }
    try {
      if (refreshChildProcessLedger(activeChild) && suiteLock) {
        await suiteLock.update({ childProcessLedger: activeChild.childProcessLedger });
      }
      await closeCompletedChildGroup(activeChild);
      activeChild.forceClose?.("regression child was force-closed during suite cleanup");
      const finalClassification = persistedChildProcessClassification(activeChild);
      childProcessGroupClosed = finalClassification.matching.length === 0
        && finalClassification.drifted.length === 0
        && finalClassification.unproven.length === 0
        && !processGroupIsAlive(activeChild);
      if (childProcessGroupClosed && closeChildDetachedSpawnLedger(activeChild) && suiteLock) {
        await suiteLock.update({ childProcessLedger: activeChild.childProcessLedger });
      }
      if (childProcessGroupClosed && activeChild.dockerLeaseClosureVerified !== true) {
        try {
          closeChildDockerLeaseWatchdog(activeChild);
        } catch (error) {
          dockerLeaseClosureComplete = false;
          setupError = [
            setupError,
            `regression Docker lease closure evidence is incomplete: ${error instanceof Error ? error.message : String(error)}`
          ].filter(Boolean).join("; ");
        }
      }
    } catch (error) {
      processOwnershipComplete = false;
      childProcessGroupClosed = false;
      setupError = [setupError, error instanceof Error ? error.message : String(error)].filter(Boolean).join("; ");
      tryTerminateOwnedChildProcessGroup(activeChild, "SIGKILL");
      activeChild.forceClose?.("regression child was force-closed during suite cleanup");
    }
    if (!childProcessGroupClosed) {
      setupError = [setupError, "regression child process group remained alive; suite lock retained"].filter(Boolean).join("; ");
    } else if (suiteLock
      && processOwnershipComplete
      && activeChild.dockerLeaseClosureVerified === true) {
      try {
        const completedChildReference = activeChild.childDetachedSpawnLedger;
        const completedChildPid = activeChild.child.pid;
        await suiteLock.update({
          state: "cleanup",
          childPid: 0,
          childScript: "",
          childProcessFingerprint: "",
          childProcessGuardToken: "",
          childDetachedSpawnLedger: null,
          childProcessLedger: []
        });
        activeChild = null;
        await scavengeRegressionDockerClosedReceipts({ ownership: suiteDockerOwnership });
        removeRegressionDetachedSpawnLedger({
          secretDir,
          reference: completedChildReference,
          expectedParentPid: completedChildPid,
          allowHeaderOnly: true
        });
        activeChildDetachedSpawnLedger = null;
      } catch (error) {
        auxiliaryFixturesClosed = false;
        setupError = [setupError, error instanceof Error ? error.message : String(error)].filter(Boolean).join("; ");
      }
    } else if (suiteLock) {
      try {
        await suiteLock.update({
          state: processOwnershipComplete
            ? "docker-closure-incomplete"
            : "process-ownership-incomplete"
        });
      } catch (error) {
        setupError = [setupError, error instanceof Error ? error.message : String(error)].filter(Boolean).join("; ");
      }
    }
  }
  activeChild = null;
  clearTerminationTimers();
  if (activeChildFixtureLedger) {
    try {
      await closeAndRecoverRegressionFixtureLedger(
        preflight?.apiBase || "http://127.0.0.1:8080",
        {
          secretDir,
          reference: activeChildFixtureLedger.reference,
          writer: activeChildFixtureLedger.writer
        },
        runId,
        requestFenceControlToken
      );
      if (childProcessGroupClosed) {
        sealRegressionFixtureLedger(activeChildFixtureLedger.writer);
        removeRegressionFixtureLedger({
          secretDir,
          reference: activeChildFixtureLedger.reference,
          requireSealed: true
        });
        activeChildFixtureLedger = null;
      } else {
        auxiliaryFixturesClosed = false;
        setupError = [
          setupError,
          "regression active-child identity was closed but its ownership ledger was retained with the live process group"
        ].filter(Boolean).join("; ");
      }
    } catch (error) {
      auxiliaryFixturesClosed = false;
      setupError = [
        setupError,
        `regression active-child fixture closure failed: ${error instanceof Error ? error.message : String(error)}`
      ].filter(Boolean).join("; ");
    }
  }
  // The parent ledger drain uses the suite request-fence control capability.
  // Close it while the suite fixture is still authenticated; its cleanup
  // deliberately closes that fence and would otherwise turn this final,
  // deterministic drain into a 403 after every otherwise-complete run.
  if (parentFixtureLedger) {
    try {
      const parentFixtureClosure = await closeAndRecoverRegressionFixtureLedger(
        preflight?.apiBase || "http://127.0.0.1:8080",
        {
          secretDir,
          reference: parentFixtureLedger.reference,
          writer: parentFixtureLedger.writer
        },
        runId,
        requestFenceControlToken
      );
      const latestSuiteOwner = parentFixtureClosure.results
        .filter((entry) => entry.username === suiteUsername)
        .sort((left, right) => right.generation - left.generation)[0];
      if (latestSuiteOwner && suiteLock) {
        await suiteLock.update({
          userId: latestSuiteOwner.userId,
          requestFenceGeneration: latestSuiteOwner.generation
        });
      }
      sealRegressionFixtureLedger(parentFixtureLedger.writer);
      removeRegressionFixtureLedger({
        secretDir,
        reference: parentFixtureLedger.reference,
        requireSealed: true
      });
      parentFixtureLedger = null;
    } catch (error) {
      auxiliaryFixturesClosed = false;
      setupError = [setupError, error instanceof Error ? error.message : String(error)].filter(Boolean).join("; ");
    }
  }
  if (suiteFixture) {
    try {
      const cleanup = await suiteFixture.cleanup({ allowForcedRedisRelease: true });
      const expectedTombstone = cleanup.closed === true
        && cleanup.retainedDisabled === true
        && cleanup.reusableTombstone === true;
      if (expectedTombstone) {
        suiteIdentity.cleanup = { ok: true, ...cleanup };
      } else {
        const recovery = recoverIsolatedAdminSessionFixture({
          username: suiteUsername,
          displayName: suiteDisplayName,
          retainQuarantinedIdentity: true,
          allowIdentityNeverCreated: true,
          allowLegacySuiteTombstoneAdoption: true
        });
        suiteIdentity.cleanup = recovery.closed === true
          ? { ok: true, fallbackRecovery: true, originalCleanup: cleanup, ...recovery }
          : { ok: false, error: "suite identity did not close as the owned disabled tombstone", originalCleanup: cleanup, ...recovery };
      }
    } catch (error) {
      const originalError = redactOutput(error instanceof Error ? error.message : String(error), suiteFixture.password);
      try {
        const recovery = recoverIsolatedAdminSessionFixture({
          username: suiteUsername,
          displayName: suiteDisplayName,
          retainQuarantinedIdentity: true,
          allowIdentityNeverCreated: true,
          allowLegacySuiteTombstoneAdoption: true
        });
        suiteIdentity.cleanup = recovery.closed === true
          ? { ok: true, fallbackRecovery: true, originalError, ...(error?.cleanup || {}), ...recovery }
          : { ok: false, error: originalError, ...(error?.cleanup || {}), ...recovery };
      } catch (recoveryError) {
        suiteIdentity.cleanup = {
          ok: false,
          error: `${originalError}; fallback recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
          ...(error?.cleanup || {})
        };
      }
    }
  } else if (suiteLock) {
    try {
      const cleanup = recoverIsolatedAdminSessionFixture({
        username: suiteUsername,
        displayName: suiteDisplayName,
        retainQuarantinedIdentity: true,
        allowIdentityNeverCreated: true,
        allowLegacySuiteTombstoneAdoption: true
      });
      suiteIdentity.cleanup = { ok: true, ...cleanup };
    } catch (error) {
      suiteIdentity.cleanup = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (artifactBaseline) {
    try {
      secretScan = !suiteFixture
        ? await scanChangedRegressionArtifactsForSecrets({
            root: verificationDir,
            workspaceRoot: rootDir,
            baseline: artifactBaseline,
            password: "",
            exactSecrets: [...childReportedSecrets]
          })
        : secretChannelComplete
        ? await scanChangedRegressionArtifactsForSecrets({
            root: verificationDir,
            workspaceRoot: rootDir,
            baseline: artifactBaseline,
            password: suiteFixture.password,
            exactSecrets: [...childReportedSecrets, ...suiteFixture.sensitiveArtifactValues()]
          })
        : await (async () => {
            const purge = await purgeChangedRegressionArtifacts({
              root: verificationDir,
              workspaceRoot: rootDir,
              baseline: artifactBaseline
            });
            return {
              ok: false,
              residueFree: purge.residueFree,
              error: `regression secret sidecar did not close: ${unique(secretChannelErrors).join("; ")}`,
              scannedChangedFiles: 0,
              purgedChangedFiles: purge.purgedFiles,
              cleanupErrors: purge.cleanupErrors,
              residueFiles: purge.residueFiles
            };
          })();
    } catch (error) {
      secretScan = { ok: false, error: error instanceof Error ? error.message : String(error), scannedChangedFiles: 0 };
    }
  }
  try {
    postflight = { ok: true, ...(await assertRegressionPostflight(preflight, "suite postflight")) };
  } catch (error) {
    postflight = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (suiteLock
    && processOwnershipComplete
    && dockerLeaseClosureComplete
    && secretScan.residueFree !== true) {
    try {
      await suiteLock.update({
        state: "artifact-residue",
        childPid: 0,
        childScript: "",
        childProcessFingerprint: "",
        childProcessGuardToken: "",
        childDetachedSpawnLedger: null,
        childProcessLedger: []
      });
    } catch (error) {
      setupError = [setupError, error instanceof Error ? error.message : String(error)].filter(Boolean).join("; ");
    }
  }
  if (executionBaseline) {
    try {
      assertSuiteExecutionIntegrity();
    } catch (error) {
      setupError = [
        setupError,
        `tracked execution integrity failed: ${error instanceof Error ? error.message : String(error)}`
      ].filter(Boolean).join("; ");
    }
  }
  if (suiteLock
    && suiteIdentity.cleanup.closed
    && childProcessGroupClosed
    && auxiliaryFixturesClosed
    && processOwnershipComplete
    && dockerLeaseClosureComplete
    && executionIntegrityComplete
    && secretScan.residueFree === true
    && !terminationSignal) {
    try {
      await suiteLock.update({
        state: "release-ready",
        childPid: 0,
        childScript: "",
        childProcessFingerprint: "",
        childProcessGuardToken: "",
        childDetachedSpawnLedger: null,
        childProcessLedger: []
      });
      await suiteLock.assertReleaseReady();
      suiteReleasePrepared = true;
    } catch (error) {
      setupError = [setupError, error instanceof Error ? error.message : String(error)].filter(Boolean).join("; ");
    }
  }
  if (suiteLock && !suiteReleasePrepared) {
    // A retained lock must say which final invariant prevented release. Keep
    // this structural and secret-free so stale recovery can be diagnosed
    // without publishing child output or credentials.
    try {
      await suiteLock.update({
        diagnosticError: JSON.stringify({
          suiteCleanupClosed: suiteIdentity.cleanup?.closed === true,
          suiteCleanupOk: suiteIdentity.cleanup?.ok === true,
          childProcessGroupClosed,
          auxiliaryFixturesClosed,
          processOwnershipComplete,
          dockerLeaseClosureComplete,
          executionIntegrityComplete,
          secretResidueFree: secretScan.residueFree === true,
          postflightOk: postflight.ok === true,
          postflightError: postflight.ok === true ? "" : redactOutput(
            String(postflight.error || "postflight failed"),
            suiteFixture?.password || "",
            [...childReportedSecrets]
          ).slice(0, 512),
          setupError: redactOutput(
            String(setupError || ""),
            suiteFixture?.password || "",
            [...childReportedSecrets]
          ).slice(0, 512),
          terminationSignal: terminationSignal || null
        })
      });
    } catch (error) {
      setupError = [setupError, error instanceof Error ? error.message : String(error)].filter(Boolean).join("; ");
    }
  }
}
const bad = results.filter((result) => !result.ok);
const infrastructureBadCount = (setupError ? 1 : 0)
  + (suiteIdentity.cleanup.ok ? 0 : 1)
  + (postflight.ok ? 0 : 1)
  + (secretScan.ok ? 0 : 1)
  + (processOwnershipComplete ? 0 : 1)
  + (dockerLeaseClosureComplete ? 0 : 1)
  + (executionIntegrityComplete ? 0 : 1)
  + (terminationSignal ? 1 : 0);
const verifiedOutcomeOk = bad.length === 0
  && results.length === scripts.length
  && infrastructureBadCount === 0;
const verifiedOutcomeBadCount = bad.length + infrastructureBadCount;
const summary = {
  runId,
  generatedAt: new Date().toISOString(),
  tier,
  resultTier,
  continueOnFailure: shouldContinue,
  // Shared latest is deliberately fail-closed until the canonical suite lock
  // has been atomically relocated. A crash may leave a false negative, never a
  // green result whose shared side effects are still uncommitted.
  ok: false,
  total: results.length,
  expectedTotal: scripts.length,
  badCount: verifiedOutcomeBadCount + 1,
  scriptBadCount: bad.length,
  skipped: scripts.length - results.length,
  startedAt,
  finishedAt: new Date().toISOString(),
  resultPath: path.relative(rootDir, resultPath),
  manifest: manifestSummary.manifest,
  availableAreas: Object.keys(areaScripts).sort(),
  preflight: { ok: true, ...preflight },
  setup: { ok: !setupError, error: setupError || null },
  auxiliaryFixtures: { closed: auxiliaryFixturesClosed },
  processOwnership: { complete: processOwnershipComplete },
  dockerLeaseClosure: { complete: dockerLeaseClosureComplete },
  executionIntegrity: {
    complete: executionIntegrityComplete,
    rootDigest: executionBaseline?.rootDigest || null,
    strictClean: executionBaseline?.strictClean === true
  },
  suiteLock: { releasePrepared: suiteReleasePrepared, releaseCommitted: false },
  suiteIdentity,
  secretScan,
  terminationSignal: terminationSignal || null,
  postflight,
  results
};

const exactSessionSecrets = [
  ...childReportedSecrets,
  ...(suiteFixture?.sensitiveArtifactValues?.() || [])
];
for (const result of summary.results) {
  result.stdoutTail = redactOutput(result.stdoutTail, suiteFixture?.password || "", exactSessionSecrets);
  result.stderrTail = redactOutput(result.stderrTail, suiteFixture?.password || "", exactSessionSecrets);
}
if (suiteReleasePrepared && !terminationSignal) {
  try {
    summary.suiteLock.releaseCommitted = true;
    summary.badCount = verifiedOutcomeBadCount;
    summary.ok = verifiedOutcomeOk;
    const summaryText = redactOutput(JSON.stringify(summary, null, 2), suiteFixture?.password || "", exactSessionSecrets);
    const publication = await prepareLatestPublication(summaryText);
    await suiteLock.update({ latestPublication: publication });
    const release = suiteLock.releaseSync({
      publishLatestSync: () => publishLatestSync(publication),
      rollbackPublishedLatestSync: () => rollbackLatestPublicationSync(publication)
    });
    completionCommitted = true;
    secretDir = "";
    releaseCleanupWarnings.push(...release.cleanupErrors);
    summary.suiteLock.releaseCleanupErrorCount = release.cleanupErrors.length;
    // The candidate became latest under the canonical lock. Do not write any
    // shared artifact after release: a newer owner may already have acquired it.
  } catch (error) {
    setupError = [setupError, error instanceof Error ? error.message : String(error)].filter(Boolean).join("; ");
    summary.setup = { ok: false, error: setupError };
    summary.suiteLock.releaseError = error instanceof Error ? error.message : String(error);
    summary.ok = false;
    summary.badCount = verifiedOutcomeBadCount + 1;
    console.error(`Regression final summary was not published: ${summary.suiteLock.releaseError}`);
  }
}
if (completionCommitted) await new Promise((resolve) => setImmediate(resolve));
process.off("SIGINT", onSigint);
process.off("SIGTERM", onSigterm);
for (const warning of releaseCleanupWarnings) {
  console.error(`Regression released-lock cleanup warning: ${warning}`);
}
console.log(JSON.stringify({
  ok: summary.ok,
  tier,
  resultTier,
  continueOnFailure: shouldContinue,
  total: summary.total,
  expectedTotal: summary.expectedTotal,
  badCount: summary.badCount,
  skipped: summary.skipped,
  resultPath: summary.resultPath
}, null, 2));

if (!summary.ok) {
  process.exitCode = terminationSignal === "SIGINT" ? 130 : terminationSignal === "SIGTERM" ? 143 : 1;
}

async function scriptsForTier(selectedTier) {
  if (selectedTier === "smoke") {
    return smokeScripts;
  }
  if (selectedTier === "full") {
    return fullScripts;
  }
  if (selectedTier.startsWith("area:")) {
    const area = selectedTier.slice("area:".length);
    if (!areaScripts[area]) {
      throw new Error(`Unknown area "${area}". Available: ${Object.keys(areaScripts).sort().join(", ")}`);
    }
    return unique([...smokeScripts, ...areaScripts[area]]);
  }
  throw new Error("Usage: node scripts/run-regression-tier.mjs smoke|area:<module>|full");
}

async function writeAtomicResult(targetPath, content, baseline) {
  assertRegressionArtifactRootIdentitySync({ root: verificationDir, baseline });
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { mode: 0o600, flag: "wx" });
    assertRegressionArtifactRootIdentitySync({ root: verificationDir, baseline });
    await rename(temporaryPath, targetPath);
    assertRegressionArtifactRootIdentitySync({ root: verificationDir, baseline });
  } catch (error) {
    try {
      assertRegressionArtifactRootIdentitySync({ root: verificationDir, baseline });
      await unlink(temporaryPath).catch(() => {});
    } catch { /* Never follow an artifact-root replacement during error cleanup. */ }
    throw error;
  }
}

async function prepareLatestPublication(summaryText) {
  assertRegressionArtifactRootIdentitySync({ root: verificationDir, baseline: artifactBaseline });
  if (regressionArtifactPayloadContainsSecret(summaryText, {
    password: suiteFixture?.password || "",
    exactSecrets: exactSessionSecrets
  })) {
    throw new Error("regression final summary contains a secret and cannot be published");
  }
  const targetRelative = path.relative(verificationDir, resultPath);
  const baselineEntry = artifactBaseline.get(targetRelative);
  const publicationDir = path.join(suiteLock.lockDir, "publication");
  await mkdir(publicationDir, { mode: 0o700 });
  let previous;
  if (baselineEntry) {
    if (baselineEntry.kind !== "file") {
      throw new Error("regression latest baseline is not a regular file");
    }
    const metadata = await lstat(resultPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error("regression latest baseline changed before publication");
    }
    const payload = await readFile(resultPath);
    const digest = createHash("sha256").update(payload).digest("hex");
    if (metadata.size !== baselineEntry.size || digest !== baselineEntry.sha256) {
      throw new Error("regression latest baseline changed before publication");
    }
    const backupPath = path.join(publicationDir, "previous.json");
    await writeFile(backupPath, payload, { mode: 0o600, flag: "wx" });
    const backupHandle = await (await import("node:fs/promises")).open(backupPath, "r");
    try { await backupHandle.sync(); } finally { await backupHandle.close(); }
    const backupMetadata = await lstat(backupPath);
    previous = {
      kind: "file",
      size: metadata.size,
      sha256: digest,
      backup: {
        file: "publication/previous.json",
        device: String(backupMetadata.dev),
        inode: String(backupMetadata.ino),
        size: backupMetadata.size,
        sha256: digest
      }
    };
  } else {
    try {
      await lstat(resultPath);
      throw new Error("regression latest was created after artifact baseline");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    previous = { kind: "absent" };
  }
  const candidateFile = `.regression-tier-${safeTier}-${runId}.candidate`;
  const candidatePath = path.join(verificationDir, candidateFile);
  await writeFile(candidatePath, summaryText, { mode: 0o600, flag: "wx" });
  const candidateHandle = await (await import("node:fs/promises")).open(candidatePath, "r");
  try { await candidateHandle.sync(); } finally { await candidateHandle.close(); }
  const candidateMetadata = await lstat(candidatePath);
  const candidateDigest = createHash("sha256").update(await readFile(candidatePath)).digest("hex");
  return {
    version: 1,
    runId,
    targetRelative,
    candidate: {
      file: candidateFile,
      device: String(candidateMetadata.dev),
      inode: String(candidateMetadata.ino),
      size: candidateMetadata.size,
      sha256: candidateDigest
    },
    previous
  };
}

function assertPublicationFile(pathname, expected) {
  const metadata = lstatSync(pathname);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || String(metadata.dev) !== expected.device
    || String(metadata.ino) !== expected.inode
    || metadata.size !== expected.size
    || createHash("sha256").update(readFileSync(pathname)).digest("hex") !== expected.sha256) {
    throw new Error("regression latest publication capability changed");
  }
}

function publishLatestSync(publication) {
  const candidatePath = path.join(verificationDir, publication.candidate.file);
  assertPublicationFile(candidatePath, publication.candidate);
  renameSync(candidatePath, resultPath);
  const published = { ...publication.candidate };
  assertPublicationFile(resultPath, published);
}

function rollbackLatestPublicationSync(publication) {
  const targetPath = resultPath;
  if (publication.previous.kind === "absent") {
    const published = lstatSync(targetPath);
    if (!published.isFile() || createHash("sha256").update(readFileSync(targetPath)).digest("hex") !== publication.candidate.sha256) {
      throw new Error("regression latest publication changed before rollback");
    }
    rmSync(targetPath, { force: false });
    return;
  }
  const backupPath = path.join(suiteLock.lockDir, publication.previous.backup.file);
  assertPublicationFile(backupPath, publication.previous.backup);
  const payload = readFileSync(backupPath);
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.rollback`;
  writeFileSync(temporaryPath, payload, { mode: 0o600, flag: "wx" });
  const descriptor = openSync(temporaryPath, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(temporaryPath, targetPath);
}

async function runScript(script, {
  credentials,
  secretDir: credentialDir,
  fixtureLedger,
  index,
  childProcessGuardToken,
  childDetachedSpawnLedger,
  childExecutionBaselineCapability,
  isolatedBackend,
  usesSuiteCredentials,
  onChild
}) {
  if (isolatedBackend && usesSuiteCredentials) {
    throw new Error("isolated regression child cannot receive the main suite credential capability");
  }
  if (!fixtureLedger
    || !path.isAbsolute(String(fixtureLedger.path || ""))
    || fixtureLedger.reference?.runId !== credentials.runId
    || !/^(?:parent|\d{3})\.fixtures\.jsonl$/.test(String(fixtureLedger.reference?.file || ""))
    || typeof fixtureLedger.signingPrivateKey !== "string"
    || fixtureLedger.signingPrivateKey.length < 40) {
    throw new Error("regression child fixture ledger capability is invalid");
  }
  if (!/^[0-9a-f]{32}$/.test(String(childProcessGuardToken || ""))) {
    throw new Error("regression child process guard token is invalid");
  }
  if (!childDetachedSpawnLedger
    || !Number.isInteger(childDetachedSpawnLedger.descriptor)
    || childDetachedSpawnLedger.descriptor < 0
    || !path.isAbsolute(String(childDetachedSpawnLedger.path || ""))
    || childDetachedSpawnLedger.reference?.guardToken !== childProcessGuardToken
    || childDetachedSpawnLedger.reference?.childScript !== script
    || childDetachedSpawnLedger.reference?.runId !== credentials.runId
    || !Number.isInteger(childDetachedSpawnLedger.signingKeyDescriptor)
    || childDetachedSpawnLedger.signingKeyDescriptor < 0) {
    throw new Error("regression detached spawn ledger capability is invalid");
  }
  if (!childExecutionBaselineCapability
    || !Number.isInteger(childExecutionBaselineCapability.descriptor)
    || childExecutionBaselineCapability.descriptor < 0) {
    throw new Error("regression tracked execution baseline capability is invalid");
  }
  const credentialPath = usesSuiteCredentials
    ? path.join(credentialDir, `${String(index + 1).padStart(3, "0")}.json`)
    : "";
  let credentialIdentity = null;
  if (credentialPath) {
    credentialIdentity = await publishRegressionCredentialCapability({
      credentialPath,
      credential: {
        ...credentials,
        fixtureLedgerReference: fixtureLedger.reference,
        fixtureLedgerSigningPrivateKey: fixtureLedger.signingPrivateKey
      }
    });
  }
  try {
    return await new Promise((resolve) => {
      const childEnvironment = {
        ...process.env,
        JAVA_HOME: regressionJavaHome
      };
      delete childEnvironment.JDY_REGRESSION_RUN_ID;
      delete childEnvironment.JDY_REGRESSION_ADMIN_CREDENTIAL_FILE;
      delete childEnvironment.JDY_REGRESSION_ADMIN_CREDENTIAL_IDENTITY;
      delete childEnvironment.JDY_REGRESSION_ISOLATED_BACKEND_ONLY;
      delete childEnvironment.NODE_OPTIONS;
      delete childEnvironment.NODE_PATH;
      delete childEnvironment.PLAYWRIGHT_BROWSERS_PATH;
      delete childEnvironment.DYLD_INSERT_LIBRARIES;
      delete childEnvironment.DYLD_LIBRARY_PATH;
      delete childEnvironment.LD_PRELOAD;
      delete childEnvironment.LD_LIBRARY_PATH;
      for (const name of [
        "BASH_ENV", "BASHOPTS", "CDPATH", "CLASSPATH", "ENV", "GLOBIGNORE", "GRADLE_OPTS",
        "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "M2_HOME", "MAVEN_ARGS", "MAVEN_CONFIG",
        "MAVEN_HOME", "MAVEN_OPTS", "MAVEN_PROJECTBASEDIR", "MAVEN_USER_HOME",
        "MVNW_PASSWORD", "MVNW_REPOURL", "MVNW_USERNAME", "PROMPT_COMMAND", "SHELLOPTS",
        "_JAVA_OPTIONS"
      ]) delete childEnvironment[name];
      for (const name of Object.keys(childEnvironment)) {
        if (name.startsWith("DOCKER_")) delete childEnvironment[name];
      }
      childEnvironment.JAVA_HOME = regressionJavaHome;
      childEnvironment.JDY_POSTGRES_CONTAINER = "jdy-erp-postgres";
      childEnvironment.JDY_POSTGRES_USER = "jdy";
      childEnvironment.JDY_POSTGRES_DATABASE = "jdy_erp";
      childEnvironment.JDY_DATABASE = "jdy_erp";
      childEnvironment.JDY_DATABASE_USER = "jdy";
      childEnvironment.JDY_DATABASE_PASSWORD = "jdy_dev";
      childEnvironment.JDY_REDIS_CONTAINER = "jdy-erp-redis";
      childEnvironment.JDY_REDIS_DB = "0";
      delete childEnvironment[regressionChildGuardTokenEnvironment];
      delete childEnvironment[regressionDetachedSpawnLedgerFdEnvironment];
      delete childEnvironment[regressionDetachedSpawnSigningKeyFdEnvironment];
      delete childEnvironment[regressionDetachedSpawnLedgerPathEnvironment];
      delete childEnvironment[regressionDetachedSpawnLedgerReferenceEnvironment];
      delete childEnvironment[regressionDockerWatchdogPathEnvironment];
      delete childEnvironment[regressionDockerWatchdogAckFdEnvironment];
      delete childEnvironment[regressionExecutionBaselineFdEnvironment];
      delete childEnvironment.JDY_REGRESSION_PARENT_WATCHDOG_FD;
      if (usesSuiteCredentials) {
        childEnvironment.JDY_REGRESSION_RUN_ID = credentials.runId;
        childEnvironment.JDY_REGRESSION_ADMIN_CREDENTIAL_FILE = credentialPath;
        childEnvironment.JDY_REGRESSION_ADMIN_CREDENTIAL_IDENTITY = `${credentialIdentity.device}:${credentialIdentity.inode}`;
      }
      if (isolatedBackend) childEnvironment.JDY_REGRESSION_ISOLATED_BACKEND_ONLY = "1";
      childEnvironment[regressionChildGuardTokenEnvironment] = childProcessGuardToken;
      childEnvironment.JDY_REGRESSION_SECRET_REPORT_FD = "3";
      childEnvironment[regressionDetachedSpawnLedgerFdEnvironment] = "4";
      childEnvironment[regressionDetachedSpawnSigningKeyFdEnvironment] = "5";
      childEnvironment.JDY_REGRESSION_PARENT_WATCHDOG_FD = "6";
      childEnvironment[regressionDetachedSpawnLedgerPathEnvironment] = childDetachedSpawnLedger.path;
      childEnvironment[regressionDetachedSpawnLedgerReferenceEnvironment] = JSON.stringify(childDetachedSpawnLedger.reference);
      childEnvironment[regressionDockerWatchdogPathEnvironment] = path.resolve(
        rootDir,
        "scripts/helpers/regression-docker-lease-watchdog.mjs"
      );
      childEnvironment[regressionDockerWatchdogAckFdEnvironment] = "7";
      childEnvironment[regressionExecutionBaselineFdEnvironment] = "8";
      delete childEnvironment.JDY_REGRESSION_ALLOW_CLEANUP_FAULTS;
      const childScriptPath = path.resolve(rootDir, script);
      const authHelperPath = path.resolve(rootDir, "scripts/helpers/regression-auth.mjs");
      const childGuardPath = path.resolve(rootDir, "scripts/helpers/regression-child-process-guard.mjs");
      const childBootstrapPath = path.resolve(rootDir, "scripts/helpers/regression-child-bootstrap.mjs");
      const parentWatchdogPath = path.resolve(rootDir, "scripts/helpers/regression-parent-watchdog.mjs");
      const fixtureLedgerHelperPath = path.resolve(rootDir, "scripts/helpers/regression-fixture-ledger.mjs");
      let child;
      try {
        child = spawn(process.execPath, [
          "--no-addons",
          childBootstrapPath,
          childScriptPath,
          authHelperPath,
          childGuardPath,
          parentWatchdogPath,
          fixtureLedgerHelperPath
        ], {
          cwd: rootDir,
          env: childEnvironment,
          detached: process.platform !== "win32",
          stdio: [
            "pipe",
            "pipe",
            "pipe",
            "pipe",
            childDetachedSpawnLedger.descriptor,
            childDetachedSpawnLedger.signingKeyDescriptor,
            "pipe",
            "pipe",
            childExecutionBaselineCapability.descriptor
          ]
        });
      } finally {
        closeSync(childDetachedSpawnLedger.descriptor);
        childDetachedSpawnLedger.descriptor = -1;
        closeSync(childDetachedSpawnLedger.signingKeyDescriptor);
        childDetachedSpawnLedger.signingKeyDescriptor = -1;
        closeSync(childExecutionBaselineCapability.descriptor);
        childExecutionBaselineCapability.descriptor = -1;
        delete childEnvironment[regressionDetachedSpawnSigningKeyFdEnvironment];
        delete childEnvironment[regressionExecutionBaselineFdEnvironment];
      }
      let stdout = "";
      let stderr = "";
      const secretCollector = new RegressionSecretFrameCollector();
      let dockerWatchdogAckPayload = "";
      let dockerWatchdogAckError = "";
      let settled = false;
      let secretStreamClosed = false;
      let dockerWatchdogAckClosed = false;
      let childCloseStatus = null;
      let childCloseObserved = false;
      let forcedCloseMessage = "";
      let forcedResolutionTimer = null;
      let dockerWatchdogAckTimer = null;
      let childCloseTimer = null;
      let childCloseForced = false;
      const finish = (status) => {
        if (settled) return;
        settled = true;
        if (forcedResolutionTimer) clearTimeout(forcedResolutionTimer);
        if (dockerWatchdogAckTimer) clearTimeout(dockerWatchdogAckTimer);
        if (childCloseTimer) clearTimeout(childCloseTimer);
        if (!secretStreamClosed) {
          secretCollector.fail("regression child secret report descriptor did not reach EOF");
        }
        const secretReport = secretCollector.finish();
        if (!secretReport.ok) {
          stdout = "";
          stderr = secretReport.error;
        }
        resolve({
          status: Number.isInteger(status)
            && secretReport.ok
            && dockerWatchdogAckClosed
            && !dockerWatchdogAckError
            ? status
            : 1,
          stdout,
          stderr,
          sensitiveValues: [...secretReport.values],
          secretReportComplete: secretReport.ok && secretStreamClosed,
          secretReportError: secretReport.error,
          dockerWatchdogAckComplete: dockerWatchdogAckClosed && !dockerWatchdogAckError,
          dockerWatchdogAckError,
          dockerWatchdogAckPayload,
          childCloseForced
        });
      };
      const maybeFinish = () => {
        if (childCloseObserved && secretStreamClosed && dockerWatchdogAckClosed) {
          finish(childCloseStatus);
        }
      };
      const scheduleSecretDescriptorFailure = (message) => {
        if (forcedResolutionTimer) return;
        forcedResolutionTimer = setTimeout(() => {
          if (!forcedCloseMessage) forcedCloseMessage = message;
          secretCollector.fail("regression child secret report descriptor did not close after child exit or SIGKILL");
          child.stdio[3].destroy();
          maybeFinish();
        }, childDescriptorCloseGraceMs);
        forcedResolutionTimer.unref?.();
      };
      const scheduleChildCloseFailure = () => {
        if (childCloseTimer || childCloseObserved) return;
        childCloseTimer = setTimeout(() => {
          childCloseForced = true;
          if (!forcedCloseMessage) {
            forcedCloseMessage = "regression child output descriptors did not close after child exit";
          }
          child.stdout?.destroy();
          child.stderr?.destroy();
          childCloseObserved = true;
          childCloseStatus = 1;
          maybeFinish();
        }, childDescriptorCloseGraceMs);
      };
      const scheduleDockerWatchdogAckFailure = () => {
        if (dockerWatchdogAckTimer || dockerWatchdogAckClosed) return;
        const ledgerReadDeadline = Date.now() + 1_000;
        const armExactCleanupDeadline = () => {
          if (dockerWatchdogAckClosed) return;
          let ledger;
          try {
            ledger = readRegressionDetachedSpawnLedger({
              secretDir: credentialDir,
              reference: childDetachedSpawnLedger.reference,
              expectedParentPid: child.pid,
              requireClosed: false
            });
          } catch {
            if (Date.now() < ledgerReadDeadline) {
              dockerWatchdogAckTimer = setTimeout(() => {
                dockerWatchdogAckTimer = null;
                armExactCleanupDeadline();
              }, 25);
              return;
            }
            dockerWatchdogAckError = "regression Docker ledger could not be read after child exit";
            child.stdio[7]?.destroy();
            dockerWatchdogAckClosed = true;
            maybeFinish();
            return;
          }
          // Only leases without a signed completion can require watchdog
          // cleanup. A43 legitimately records hundreds of completed Redis
          // commands; charging all of them here turns a closed child into an
          // hour-long false wait for an acknowledgement.
          const timeoutMs = regressionDockerCleanupDeadlineMs(ledger.pendingDockerIntents.length);
          dockerWatchdogAckTimer = setTimeout(() => {
            dockerWatchdogAckError = "regression Docker watchdog acknowledgement did not close within its cleanup deadline";
            child.stdio[7]?.destroy();
            dockerWatchdogAckClosed = true;
            maybeFinish();
          }, timeoutMs);
        };
        armExactCleanupDeadline();
      };
      const handle = {
        child,
        runId: credentials.runId,
        secretDir: credentialDir,
        childScript: script,
        childProcessFingerprint: "",
        childProcessGuardToken,
        childDetachedSpawnLedger: childDetachedSpawnLedger.reference,
        childDetachedSpawnLedgerPath: childDetachedSpawnLedger.path,
        childProcessLedger: [],
        dockerWatchdogAckPayload: "",
        dockerLeaseClosureVerified: false,
        dockerLeaseClosureResult: null,
        parentWatchdogControlClosed: false,
        closeParentWatchdogControl() {
          if (this.parentWatchdogControlClosed) return;
          this.parentWatchdogControlClosed = true;
          child.stdio[6]?.destroy();
        },
        forceClose(message) {
          if (!forcedCloseMessage) {
            forcedCloseMessage = message || "regression child did not close after bounded termination";
          }
          if (secretStreamClosed && dockerWatchdogAckClosed) {
            stderr += `\n${forcedCloseMessage}`;
            finish(1);
            return;
          }
          scheduleSecretDescriptorFailure("regression child secret report descriptor outlived bounded SIGKILL");
          scheduleDockerWatchdogAckFailure();
          scheduleChildCloseFailure();
        }
      };
      child.stdout.on("data", (chunk) => { if (!settled) stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { if (!settled) stderr += chunk.toString(); });
      child.stdio[3].on("data", (chunk) => {
        if (!settled) secretCollector.push(chunk);
      });
      child.stdio[3].on("close", () => {
        secretStreamClosed = true;
        if (forcedCloseMessage) {
          stderr += `\n${forcedCloseMessage}`;
          maybeFinish();
        } else {
          maybeFinish();
        }
      });
      child.stdio[7].on("data", (chunk) => {
        if (settled || dockerWatchdogAckError) return;
        dockerWatchdogAckPayload += chunk.toString();
        if (Buffer.byteLength(dockerWatchdogAckPayload) > 1024 * 1024) {
          dockerWatchdogAckError = "regression Docker watchdog acknowledgement exceeded its safety bound";
          child.stdio[7].destroy();
        }
      });
      child.stdio[7].on("error", (error) => {
        if (!dockerWatchdogAckError) {
          dockerWatchdogAckError = `regression Docker watchdog acknowledgement failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      });
      child.stdio[7].on("close", () => {
        dockerWatchdogAckClosed = true;
        handle.dockerWatchdogAckPayload = dockerWatchdogAckPayload;
        if (dockerWatchdogAckTimer) clearTimeout(dockerWatchdogAckTimer);
        maybeFinish();
      });
      child.stdin.on("error", (error) => {
        stderr += `\nregression child start gate failed: ${error instanceof Error ? error.message : String(error)}`;
        tryTerminateOwnedChildProcessGroup(handle, "SIGKILL");
      });
      child.on("error", (error) => {
        stderr += `\nregression child spawn failed: ${error instanceof Error ? error.message : String(error)}`;
        handle.closeParentWatchdogControl();
      });
      child.on("exit", () => {
        handle.closeParentWatchdogControl();
        if (!secretStreamClosed) {
          scheduleSecretDescriptorFailure("regression child secret report descriptor outlived the child process");
        }
        scheduleDockerWatchdogAckFailure();
        scheduleChildCloseFailure();
      });
      child.on("close", (status) => {
        childCloseObserved = true;
        childCloseStatus = status;
        maybeFinish();
      });
      Promise.resolve(onChild(handle)).then(() => {
        if (!settled) child.stdin.write("start\n");
      }).catch((error) => {
        stderr += `\nregression child ledger update failed: ${error instanceof Error ? error.message : String(error)}`;
        // The stdin gate has not opened, so this exact ChildProcess cannot have spawned descendants.
        // Abort through the retained handle instead of a not-yet-proven numeric process group.
        try {
          child.stdin.destroy();
          if (child.exitCode === null) child.kill("SIGKILL");
        } catch (abortError) {
          processOwnershipComplete = false;
          setupError = [
            setupError,
            abortError instanceof Error ? abortError.message : String(abortError)
          ].filter(Boolean).join("; ");
        }
        handle.forceClose("regression child was aborted before its process identity ledger opened");
      });
    });
  } finally {
    if (credentialPath) await unlink(credentialPath).catch(() => {});
  }
}

function proveChildProcessLeaderOwnership(handle) {
  const child = handle?.child || handle;
  const childScript = String(handle?.childScript || "");
  if (!child?.pid || child.exitCode !== null || !fullScripts.includes(childScript)) {
    throw new Error("regression child leader is not an active manifest process");
  }
  const leader = processGroupIdentitySnapshot(child.pid)
    .find((member) => member.pid === child.pid);
  const childScriptPath = path.resolve(rootDir, childScript);
  if (!leader
    || leader.parentPid !== process.pid
    || leader.pgid !== child.pid
    || !leader.command.includes(childScriptPath)) {
    throw new Error("regression child leader ownership could not be proven before opening its start gate");
  }
  return processIdentityFingerprint(child.pid);
}

function assertChildProcessLedgerMetadata(handle) {
  const child = handle?.child || handle;
  const childScript = String(handle?.childScript || "");
  const recordedFingerprint = String(handle?.childProcessFingerprint || "");
  const guardToken = String(handle?.childProcessGuardToken || "");
  const detachedLedger = handle?.childDetachedSpawnLedger;
  if (!child?.pid
    || !fullScripts.includes(childScript)
    || !/^[0-9a-f]{64}$/.test(recordedFingerprint)
    || !/^[0-9a-f]{32}$/.test(guardToken)
    || !detachedLedger
    || detachedLedger.guardToken !== guardToken
    || detachedLedger.childScript !== childScript
    || detachedLedger.runId !== String(handle?.runId || runId)
    || !Array.isArray(handle?.childProcessLedger)) {
    throw new Error("regression child process ownership ledger is not proven before signaling");
  }
  return child;
}

function dockerWatchdogPid(handle) {
  const child = assertChildProcessLedgerMetadata(handle);
  const detached = readRegressionDetachedSpawnLedger({
    secretDir: String(handle?.secretDir || secretDir),
    reference: handle.childDetachedSpawnLedger,
    expectedParentPid: child.pid,
    requireClosed: false
  });
  if (detached.members.length !== 1) {
    throw new Error("regression child does not have one proven Docker watchdog identity");
  }
  return detached.members[0].pid;
}

function signalPersistedChildProcessMembers(handle, signal = "SIGTERM", { deferDockerWatchdog = false } = {}) {
  const child = assertChildProcessLedgerMetadata(handle);
  const deferredPid = deferDockerWatchdog ? dockerWatchdogPid(handle) : 0;
  const ledger = deferredPid
    ? handle.childProcessLedger.filter((member) => member.pid !== deferredPid)
    : handle.childProcessLedger;
  return signalRegressionProcessGroupLedger({
    ledger,
    groupId: child.pid,
    signal,
    snapshotMembers: () => processGroupIdentitySnapshot(
      child.pid,
      handle.childProcessLedger,
      true
    ).filter((member) => member.pid !== deferredPid),
    signalProcess: (pid, requestedSignal) => process.kill(pid, requestedSignal)
  });
}

function persistedChildProcessClassification(handle) {
  const child = assertChildProcessLedgerMetadata(handle);
  return classifyRegressionProcessGroupLedger({
    ledger: handle.childProcessLedger,
    members: processGroupIdentitySnapshot(
      child.pid,
      handle.childProcessLedger,
      true
    ),
    groupId: child.pid
  });
}

async function waitForPersistedChildProcessesExit(handle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (persistedChildProcessClassification(handle).matching.length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return persistedChildProcessClassification(handle).matching.length === 0;
}

function terminateChildProcessGroup(handle, signal = "SIGTERM") {
  const child = handle?.child || handle;
  if (!child?.pid) return false;
  if (process.platform !== "win32") refreshChildProcessLedger(handle);
  if (process.platform === "win32") {
    if (child.exitCode === null) child.kill(signal);
    return child.exitCode === null;
  }
  // Do not close the shared owner control before the bootstrap has exited:
  // doing so races Docker watchdog OWNER_EOF against an explicit SIGTERM. The
  // child exit handler closes it after the signer and all normal group members
  // have stopped; the signed detached watchdog is deliberately left to that
  // single OWNER_EOF path.
  const report = signalPersistedChildProcessMembers(handle, signal, {
    deferDockerWatchdog: true
  });
  if (report.ambiguous) {
    const pids = [...report.drifted, ...report.unproven].map(({ pid }) => pid).sort((a, b) => a - b);
    throw new Error(`regression child process group contains unproven identities: ${unique(pids).join(",")}`);
  }
  return report.signaled.length > 0;
}

function tryTerminateOwnedChildProcessGroup(handle, signal = "SIGTERM") {
  try {
    return terminateChildProcessGroup(handle, signal);
  } catch (error) {
    processOwnershipComplete = false;
    setupError = [
      setupError,
      error instanceof Error ? error.message : String(error)
    ].filter(Boolean).join("; ");
    return false;
  }
}

function clearTerminationTimers() {
  if (terminationEscalationTimer) clearTimeout(terminationEscalationTimer);
  terminationEscalationTimer = null;
}

function processGroupIsAlive(handle) {
  const child = handle?.child || handle;
  if (!child?.pid || process.platform === "win32") return Boolean(child?.pid && child.exitCode === null);
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForProcessGroupExit(handle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupIsAlive(handle) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !processGroupIsAlive(handle);
}

async function closeCompletedChildGroup(handle) {
  if (!handle) return "";
  // The monitor deliberately stops before this bounded cleanup. A signed
  // Docker watchdog may nevertheless still be reaping one of its own command
  // children. Reconcile the final live snapshot through the existing
  // continuity proof before classifying it; this never adopts a numerically
  // reused group because mergeRegressionProcessGroupLedger requires a live
  // persisted PID+lstart anchor.
  refreshChildProcessLedger(handle);
  const initial = persistedChildProcessClassification(handle);
  if (initial.matching.length === 0 && initial.drifted.length === 0 && initial.unproven.length === 0) return "";
  const termReport = signalPersistedChildProcessMembers(handle, "SIGTERM");
  refreshChildProcessLedger(handle);
  const afterTerm = persistedChildProcessClassification(handle);
  if (termReport.ambiguous && (afterTerm.drifted.length > 0 || afterTerm.unproven.length > 0)) {
    processOwnershipComplete = false;
    throw new Error("regression child process group contains unproven identities after SIGTERM cleanup");
  }
  if (await waitForPersistedChildProcessesExit(handle, 2_000)) {
    refreshChildProcessLedger(handle);
    const final = persistedChildProcessClassification(handle);
    if (final.drifted.length > 0 || final.unproven.length > 0 || processGroupIsAlive(handle)) {
      processOwnershipComplete = false;
      throw new Error("regression child process group contains unproven identities after SIGTERM cleanup");
    }
    return "regression child left descendants after completion; the process group required SIGTERM cleanup";
  }
  const killReport = signalPersistedChildProcessMembers(handle, "SIGKILL");
  refreshChildProcessLedger(handle);
  const afterKill = persistedChildProcessClassification(handle);
  if (killReport.ambiguous && (afterKill.drifted.length > 0 || afterKill.unproven.length > 0)) {
    processOwnershipComplete = false;
    throw new Error("regression child process group contains unproven identities after SIGKILL cleanup");
  }
  if (!(await waitForPersistedChildProcessesExit(handle, 2_000))) {
    processOwnershipComplete = false;
    throw new Error("regression child process group survived bounded exact-member SIGKILL cleanup");
  }
  refreshChildProcessLedger(handle);
  const final = persistedChildProcessClassification(handle);
  if (final.drifted.length > 0 || final.unproven.length > 0 || processGroupIsAlive(handle)) {
    processOwnershipComplete = false;
    throw new Error("regression child process group contains unproven identities after SIGKILL cleanup");
  }
  return "regression child left descendants after completion; the process group required SIGKILL cleanup";
}

async function stopStaleChildGroup(staleOwner) {
  const staleState = String(staleOwner?.state || "");
  const requiresManualOwnershipReview = staleState === "process-ownership-incomplete";
  const childPid = Number(staleOwner?.childPid || 0);
  if (!Number.isInteger(childPid) || childPid < 0) {
    throw new Error("stale regression suite lock contains an invalid child pid");
  }
  if (childPid === 0) {
    if (staleOwner?.childScript
      || staleOwner?.childProcessFingerprint
      || staleOwner?.childProcessGuardToken
      || staleOwner?.childDetachedSpawnLedger !== null
      || !Array.isArray(staleOwner?.childProcessLedger)
      || staleOwner.childProcessLedger.length !== 0) {
      throw new Error("stale regression suite lock has inconsistent empty child ownership metadata");
    }
    return;
  }
  const handle = {
    child: { pid: childPid, exitCode: null },
    runId: String(staleOwner.runId || ""),
    secretDir: String(staleOwner.secretDir || "")
  };
  if (!["running-child", "process-ownership-incomplete", "docker-closure-incomplete"].includes(staleState)) {
    throw new Error("stale regression suite lock has a live child group outside running-child state");
  }
  const childScript = String(staleOwner?.childScript || "");
  if (!fullScripts.includes(childScript)) {
    throw new Error("stale regression suite lock does not identify a manifest child script");
  }
  const recordedFingerprint = String(staleOwner?.childProcessFingerprint || "");
  if (!/^[0-9a-f]{64}$/.test(recordedFingerprint)) {
    throw new Error("stale regression suite lock does not contain a child process fingerprint");
  }
  const recordedGuardToken = String(staleOwner?.childProcessGuardToken || "");
  if (!/^[0-9a-f]{32}$/.test(recordedGuardToken)) {
    throw new Error("stale regression suite lock does not contain a child process guard token");
  }
  handle.childScript = childScript;
  handle.childProcessFingerprint = recordedFingerprint;
  handle.childProcessGuardToken = recordedGuardToken;
  handle.childDetachedSpawnLedger = staleOwner.childDetachedSpawnLedger;
  handle.childProcessLedger = staleOwner.childProcessLedger;
  refreshChildProcessLedger(handle);
  const preCleanedDockerIntentIds = new Set();
  try {
    const detachedBeforeSignal = readRegressionDetachedSpawnLedger({
      secretDir: handle.secretDir,
      reference: handle.childDetachedSpawnLedger,
      expectedParentPid: childPid,
      requireClosed: false
    });
    const dockerCleanup = await cleanupRegressionDockerLeaseIntents({
      intents: detachedBeforeSignal.pendingDockerIntents,
      runId: String(staleOwner.runId || ""),
      guardToken: recordedGuardToken
    });
    for (const intent of dockerCleanup.cleaned) preCleanedDockerIntentIds.add(intent.id);
  } catch { /* Retry every unproved intent after exact child quiescence. */ }
  const termReport = signalPersistedChildProcessMembers(handle, "SIGTERM");
  let ambiguityObserved = termReport.ambiguous;
  if (!(await waitForPersistedChildProcessesExit(handle, 2_000))) {
    const killReport = signalPersistedChildProcessMembers(handle, "SIGKILL");
    ambiguityObserved ||= killReport.ambiguous;
    if (!(await waitForPersistedChildProcessesExit(handle, 2_000))) {
      throw new Error(`stale regression child process group ${childPid} survived exact-member SIGKILL`);
    }
  }
  const final = persistedChildProcessClassification(handle);
  ambiguityObserved ||= final.drifted.length > 0 || final.unproven.length > 0;
  if (ambiguityObserved || processGroupIsAlive(handle)) {
    throw new Error("stale regression child group contains unproven identities; exact owned members were closed and the lock was retained");
  }
  const finalDetachedLedger = readRegressionDetachedSpawnLedger({
    secretDir: handle.secretDir,
    reference: handle.childDetachedSpawnLedger,
    expectedParentPid: childPid,
    requireClosed: false
  });
  if (finalDetachedLedger.hasPartialRecord || finalDetachedLedger.pendingIntentIds.length > 0) {
    throw new Error("stale regression detached spawn ledger has ambiguous unsigned tail or spawn intent");
  }
  const finalDockerCleanupTargets = finalDetachedLedger.dockerIntents
    .filter(({ id }) => !preCleanedDockerIntentIds.has(id));
  const finalDockerCleanup = await cleanupRegressionDockerLeaseIntents({
    intents: finalDockerCleanupTargets,
    runId: String(staleOwner.runId || ""),
    guardToken: recordedGuardToken
  });
  if (!finalDockerCleanup.ok) {
    throw new Error(`stale regression Docker lease cleanup failed for ${finalDockerCleanup.errors.length} intent(s)`);
  }
  for (const intent of finalDockerCleanup.cleaned) preCleanedDockerIntentIds.add(intent.id);
  if (preCleanedDockerIntentIds.size !== finalDetachedLedger.dockerIntents.length) {
    throw new Error("stale regression Docker lease cleanup did not cover the final signed intent set");
  }
  handle.childProcessLedger = adoptRegressionProcessLedgerRecords({
    ledger: handle.childProcessLedger,
    records: finalDetachedLedger.members,
    groupId: childPid
  });
  handle.childProcessLedger = mergeRegressionProcessGroupLedger({
    ledger: handle.childProcessLedger,
    members: processGroupIdentitySnapshot(childPid, handle.childProcessLedger, true),
    groupId: childPid
  });
  const closed = persistedChildProcessClassification(handle);
  if (closed.matching.length > 0 || closed.drifted.length > 0 || closed.unproven.length > 0) {
    throw new Error("stale regression detached process ledger did not reach exact closure");
  }
  if (requiresManualOwnershipReview) {
    throw new Error("stale regression lock records an escaped or inherited child descriptor; exact owned members and Docker leases were closed, but manual process ownership review is still required");
  }
  removeRecoveredRegressionDetachedSpawnLedger({
    secretDir: handle.secretDir,
    reference: handle.childDetachedSpawnLedger,
    expectedParentPid: childPid
  });
}

function assertStaleSuiteOwnerInactive(staleOwner) {
  const pid = Number(staleOwner?.pid);
  const recordedFingerprint = String(staleOwner?.parentProcessFingerprint || "");
  if (!Number.isInteger(pid) || pid <= 0 || !/^[0-9a-f]{64}$/.test(recordedFingerprint)) {
    throw new Error("regression suite lock has no provable parent process identity");
  }
  if (!processIsAlive(pid)) return;
  let currentFingerprint;
  try {
    currentFingerprint = processIdentityFingerprint(pid);
  } catch {
    throw new Error("regression suite lock parent is live but cannot be fingerprinted");
  }
  if (currentFingerprint === recordedFingerprint) {
    throw new Error(`another regression suite is active with pid ${pid}`);
  }
}

async function purgeStaleRegressionArtifacts(lockDir, staleOwner) {
  const state = String(staleOwner?.state || "");
  const artifactProducingStates = new Set([
    "baseline-ready",
    "preflight",
    "fixture-created",
    "running",
    "running-child",
    "cleanup",
    "docker-closure-incomplete",
    "process-ownership-incomplete",
    "artifact-residue",
    "release-ready"
  ]);
  if (!artifactProducingStates.has(state)) return { residueFree: true, purgedFiles: [] };
  if (staleOwner?.artifactBaseline == null && state === "release-ready") {
    return { residueFree: true, purgedFiles: [], baselineAbsentBeforeArtifactProduction: true };
  }
  const baseline = await readPersistedRegressionArtifactBaseline({
    lockDir,
    reference: staleOwner.artifactBaseline
  });
  await recoverStaleLatestPublication({ lockDir, staleOwner, baseline });
  const purge = await purgeChangedRegressionArtifacts({
    root: verificationDir,
    workspaceRoot: rootDir,
    baseline
  });
  if (purge.cleanupErrors.length > 0 || !purge.residueFree) {
    const details = [
      ...purge.cleanupErrors.map(({ file, error }) => `${file}: ${error}`),
      ...purge.residueFiles.map((file) => `${file}: residue remains`)
    ];
    throw new Error(`stale regression artifact recovery was incomplete: ${unique(details).join("; ")}`);
  }
  return purge;
}

async function recoverStaleLatestPublication({ lockDir, staleOwner, baseline }) {
  const publication = staleOwner?.latestPublication;
  if (publication == null) return;
  validateLatestPublication(publication, staleOwner);
  const targetPath = path.join(verificationDir, publication.targetRelative);
  const digestAt = async (pathname) => {
    const metadata = await lstat(pathname);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error("stale regression latest publication target is unsafe");
    }
    return createHash("sha256").update(await readFile(pathname)).digest("hex");
  };
  if (publication.previous.kind === "absent") {
    try {
      const digest = await digestAt(targetPath);
      if (digest !== publication.candidate.sha256) {
        throw new Error("stale regression latest publication drifted outside its candidate");
      }
      await unlink(targetPath);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    return;
  }
  const currentDigest = await digestAt(targetPath);
  if (currentDigest === publication.previous.sha256) return;
  if (currentDigest !== publication.candidate.sha256) {
    throw new Error("stale regression latest publication drifted outside its candidate");
  }
  const backupPath = path.join(lockDir, publication.previous.backup.file);
  const backupMetadata = await lstat(backupPath);
  if (!backupMetadata.isFile() || backupMetadata.isSymbolicLink() || backupMetadata.nlink !== 1
    || String(backupMetadata.dev) !== publication.previous.backup.device
    || String(backupMetadata.ino) !== publication.previous.backup.inode
    || backupMetadata.size !== publication.previous.backup.size) {
    throw new Error("stale regression latest rollback capability changed");
  }
  const backup = await readFile(backupPath);
  if (createHash("sha256").update(backup).digest("hex") !== publication.previous.sha256) {
    throw new Error("stale regression latest rollback payload changed");
  }
  await writeAtomicResult(targetPath, backup, baseline);
}

async function assertStaleSecretDirectoryEmpty(staleOwner, lockDir) {
  if (!staleOwner?.secretDir) return "";
  const staleSecretDir = path.resolve(String(staleOwner.secretDir));
  if (staleSecretDir !== path.join(path.resolve(lockDir), "private")) {
    throw new Error("stale regression suite lock contains an unsafe secret directory path");
  }
  const metadata = await lstat(staleSecretDir).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!metadata
    || !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    || (metadata.mode & 0o077) !== 0) {
    throw new Error("stale regression secret path is missing or unsafe");
  }
  const remainingEntries = await readdir(staleSecretDir, { withFileTypes: true });
  const unexpectedEntries = [];
  for (const entry of remainingEntries) {
    if (/^\.execution-baseline\.\d+\.[0-9a-f]{16}\.tmp$/.test(entry.name)) {
      const temporaryPath = path.join(staleSecretDir, entry.name);
      const temporaryMetadata = await lstat(temporaryPath);
      if (!entry.isFile()
        || entry.isSymbolicLink()
        || !temporaryMetadata.isFile()
        || temporaryMetadata.isSymbolicLink()
        || temporaryMetadata.nlink !== 1
        || temporaryMetadata.size < 1
        || temporaryMetadata.size > 8 * 1024 * 1024
        || (temporaryMetadata.mode & 0o077) !== 0
        || (typeof process.getuid === "function" && temporaryMetadata.uid !== process.getuid())) {
        unexpectedEntries.push(entry.name);
        continue;
      }
      await unlink(temporaryPath);
      continue;
    }
    if (!entry.isFile()
      || entry.isSymbolicLink()
      || !/^\d{3}\.detached-processes\.jsonl$/.test(entry.name)) {
      unexpectedEntries.push(entry.name);
      continue;
    }
    const reference = staleOwner?.childDetachedSpawnLedger;
    if (reference?.file === entry.name) {
      readRegressionDetachedSpawnLedger({
        secretDir: staleSecretDir,
        reference,
        expectedParentPid: Number(staleOwner.childPid || 0),
        requireClosed: true
      });
    } else {
      inspectUnreferencedRegressionDetachedSpawnLedger({
        secretDir: staleSecretDir,
        file: entry.name,
        runId: String(staleOwner.runId || ""),
        requireClosed: true
      });
    }
  }
  if (unexpectedEntries.length > 0) {
    throw new Error(`stale regression secret directory is not empty after fixture recovery: ${unexpectedEntries.sort().join(",")}`);
  }
  return staleSecretDir;
}

function assertSuiteLockUpdateChange(change, currentOwner) {
  if (!change || typeof change !== "object" || Array.isArray(change)) {
    throw new Error("regression suite lock update must be an object");
  }
  for (const field of [
    "runId",
    "pid",
    "parentProcessFingerprint",
    "acquiredAt",
    "ownerRevision",
    "tier",
    "username",
    "requestFenceControlDigest"
  ]) {
    if (Object.prototype.hasOwnProperty.call(change, field)
      && change[field] !== currentOwner[field]) {
      throw new Error(`regression suite lock update cannot replace immutable ${field}`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(change, "artifactBaseline")) {
    if (currentOwner.artifactBaseline !== null
      && JSON.stringify(change.artifactBaseline) !== JSON.stringify(currentOwner.artifactBaseline)) {
      throw new Error("regression suite lock artifact baseline is immutable once published");
    }
    if (currentOwner.artifactBaseline === null && change.state !== "baseline-ready") {
      throw new Error("regression suite lock artifact baseline must be published with the baseline-ready transition");
    }
  }
  if (Object.prototype.hasOwnProperty.call(change, "executionBaseline")) {
    if (currentOwner.executionBaseline !== null
      && JSON.stringify(change.executionBaseline) !== JSON.stringify(currentOwner.executionBaseline)) {
      throw new Error("regression suite lock execution baseline is immutable once published");
    }
    if (currentOwner.executionBaseline === null && change.state !== "baseline-ready") {
      throw new Error("regression suite lock execution baseline must publish with the baseline-ready transition");
    }
  }
  if (Object.prototype.hasOwnProperty.call(change, "latestPublication")) {
    if (currentOwner.latestPublication !== null
      || currentOwner.state !== "release-ready") {
      throw new Error("regression suite latest publication can only be prepared once at release-ready");
    }
    validateLatestPublication(change.latestPublication, currentOwner);
  }
  if (Object.prototype.hasOwnProperty.call(change, "secretDir")) {
    const nextSecretDir = String(change.secretDir || "");
    const expectedSecretDir = path.join(regressionSuiteLockDir, "private");
    if (nextSecretDir && nextSecretDir !== expectedSecretDir) {
      throw new Error("regression suite lock private directory is outside its canonical lock");
    }
    if (currentOwner.secretDir && nextSecretDir !== currentOwner.secretDir) {
      throw new Error("regression suite lock private directory is immutable once published");
    }
    if (!currentOwner.secretDir && nextSecretDir
      && !(currentOwner.state === "baseline-ready" && change.state === "preflight")) {
      throw new Error("regression suite lock private directory must publish at the preflight transition");
    }
  }
  const candidate = { ...currentOwner, ...change };
  if (!/^[0-9a-f]{64}$/.test(String(candidate.requestFenceControlDigest || ""))) {
    throw new Error("regression suite lock request-fence control digest is invalid");
  }
  if ([
    "preflight",
    "fixture-created",
    "running",
    "running-child",
    "cleanup",
    "docker-closure-incomplete",
    "process-ownership-incomplete",
    "artifact-residue"
  ].includes(candidate.state)
    && candidate.secretDir !== path.join(regressionSuiteLockDir, "private")) {
    throw new Error("regression suite lock cannot enter an active state without its canonical private directory");
  }
  if (candidate.artifactBaseline == null
    && candidate.state !== "creating"
    && !(candidate.state === "release-ready"
      && regressionSuiteOwnerIsPreIdentity(candidate)
      && !candidate.secretDir)) {
    throw new Error("regression suite lock cannot enter an artifact-producing state before baseline publication");
  }
  if (candidate.executionBaseline == null
    && candidate.state !== "creating"
    && !(candidate.state === "release-ready"
      && regressionSuiteOwnerIsPreIdentity(candidate)
      && !candidate.secretDir)) {
    throw new Error("regression suite lock cannot enter execution before its tracked baseline publication");
  }
  const childPid = Number(candidate.childPid || 0);
  const childLedger = candidate.childProcessLedger;
  const detachedLedger = candidate.childDetachedSpawnLedger;
  if (!Number.isInteger(childPid) || childPid < 0 || !Array.isArray(childLedger)) {
    throw new Error("regression suite lock child ownership metadata is invalid");
  }
  if (childPid === 0) {
    if (candidate.childScript
      || candidate.childProcessFingerprint
      || candidate.childProcessGuardToken
      || detachedLedger !== null
      || childLedger.length !== 0) {
      throw new Error("regression suite lock empty child ownership metadata is inconsistent");
    }
  } else if (!["running-child", "process-ownership-incomplete", "docker-closure-incomplete"].includes(candidate.state)
    || !fullScripts.includes(String(candidate.childScript || ""))
    || !/^[0-9a-f]{64}$/.test(String(candidate.childProcessFingerprint || ""))
    || !/^[0-9a-f]{32}$/.test(String(candidate.childProcessGuardToken || ""))
    || !detachedLedger
    || typeof detachedLedger !== "object"
    || Array.isArray(detachedLedger)
    || Object.keys(detachedLedger).sort().join(",") !== "childScript,device,file,guardToken,inode,runId,signingPublicKey"
    || !/^\d{3}\.detached-processes\.jsonl$/.test(String(detachedLedger.file || ""))
    || !/^\d+$/.test(String(detachedLedger.device || ""))
    || !/^\d+$/.test(String(detachedLedger.inode || ""))
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(String(detachedLedger.signingPublicKey || ""))
    || detachedLedger.runId !== candidate.runId
    || detachedLedger.childScript !== candidate.childScript
    || detachedLedger.guardToken !== candidate.childProcessGuardToken) {
    throw new Error("regression suite lock live child ownership metadata is incomplete");
  }
}

function validateLatestPublication(publication, owner) {
  if (!publication || typeof publication !== "object" || Array.isArray(publication)
    || Object.keys(publication).sort().join(",") !== "candidate,previous,runId,targetRelative,version"
    || publication.version !== 1
    || publication.runId !== owner.runId
    || publication.targetRelative !== `regression-tier-${String(owner.tier || "").replace(/[^a-zA-Z0-9_-]/g, "-")}-latest.json`
    || !publication.candidate || typeof publication.candidate !== "object"
    || Object.keys(publication.candidate).sort().join(",") !== "device,file,inode,sha256,size"
    || !/^\.regression-tier-[A-Za-z0-9_-]+-[0-9a-f]{32}\.candidate$/.test(String(publication.candidate.file || ""))
    || !/^\d+$/.test(String(publication.candidate.device || ""))
    || !/^\d+$/.test(String(publication.candidate.inode || ""))
    || !Number.isSafeInteger(publication.candidate.size) || publication.candidate.size < 2
    || !/^[0-9a-f]{64}$/.test(String(publication.candidate.sha256 || ""))) {
    throw new Error("regression suite latest publication descriptor is invalid");
  }
  const previous = publication.previous;
  if (!previous || typeof previous !== "object" || Array.isArray(previous)) {
    throw new Error("regression suite latest publication rollback descriptor is invalid");
  }
  if (previous.kind === "absent" && Object.keys(previous).sort().join(",") === "kind") return;
  if (previous.kind !== "file"
    || Object.keys(previous).sort().join(",") !== "backup,kind,sha256,size"
    || !Number.isSafeInteger(previous.size) || previous.size < 0
    || !/^[0-9a-f]{64}$/.test(String(previous.sha256 || ""))
    || !previous.backup || typeof previous.backup !== "object"
    || Object.keys(previous.backup).sort().join(",") !== "device,file,inode,sha256,size"
    || previous.backup.file !== "publication/previous.json"
    || !/^\d+$/.test(String(previous.backup.device || ""))
    || !/^\d+$/.test(String(previous.backup.inode || ""))
    || previous.backup.size !== previous.size
    || previous.backup.sha256 !== previous.sha256) {
    throw new Error("regression suite latest publication rollback descriptor is invalid");
  }
}

async function acquireSuiteLock(owner) {
  const lockDir = regressionSuiteLockDir;
  const ownerPath = path.join(lockDir, "owner.json");
  await removeStaleRegressionSuiteProvisionalDirectories();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const acquiredAt = new Date().toISOString();
      const initialOwner = {
        ...owner,
        pid: process.pid,
        state: "creating",
        userId: "",
        requestFenceGeneration: -1,
        secretDir: "",
        childPid: 0,
        childScript: "",
        childProcessFingerprint: "",
        childProcessGuardToken: "",
        childDetachedSpawnLedger: null,
        childProcessLedger: [],
        artifactBaseline: null,
        executionBaseline: null,
        latestPublication: null,
        ownerRevision: 0,
        parentProcessFingerprint: processIdentityFingerprint(process.pid),
        acquiredAt,
        updatedAt: acquiredAt
      };
      const provisionalDir = await mkdtemp(path.join(
        tmpdir(),
        `${regressionSuiteProvisionalPrefix}${process.pid}-${initialOwner.parentProcessFingerprint}-${runId}-`
      ));
      try {
        await chmod(provisionalDir, 0o700);
        await writeRegressionSuiteOwnerFile(path.join(provisionalDir, "owner.json"), initialOwner);
        await rename(provisionalDir, lockDir);
      } catch (error) {
        await rm(provisionalDir, { recursive: true, force: true });
        throw error;
      }
      let currentOwner = initialOwner;
      let updateQueue = Promise.resolve();
      let updateFailure = null;
      let pendingUpdateCount = 0;
      const assertReleaseReady = async () => {
        await updateQueue;
        if (updateFailure) throw updateFailure;
        const persisted = await readRegressionSuiteOwner(ownerPath);
        try {
          assertRegressionSuiteOwnerSnapshotMatches(persisted, currentOwner);
        } catch {
          throw new Error("regression suite lock ownership changed before release");
        }
        if (currentOwner.parentProcessFingerprint !== processIdentityFingerprint(process.pid)) {
          throw new Error("regression suite lock ownership changed before release");
        }
        if (currentOwner.state !== "release-ready"
          || Number(currentOwner.childPid || 0) !== 0
          || currentOwner.childScript
          || currentOwner.childProcessFingerprint
          || currentOwner.childProcessGuardToken
          || currentOwner.childDetachedSpawnLedger !== null
          || !Array.isArray(currentOwner.childProcessLedger)
          || currentOwner.childProcessLedger.length !== 0) {
          throw new Error("regression suite lock is not in the exact release-ready state");
        }
        if (currentOwner.artifactBaseline != null) {
          readPersistedRegressionArtifactBaselineSync({
            lockDir,
            reference: currentOwner.artifactBaseline
          });
        }
        if (currentOwner.executionBaseline != null) {
          const persistedExecutionBaseline = readPersistedRegressionExecutionBaselineSync({
            lockDir,
            reference: currentOwner.executionBaseline,
            rootDir,
            expectedRunId: currentOwner.runId
          });
          assertRegressionExecutionBaselineSync({ rootDir, baseline: persistedExecutionBaseline });
        }
        const ownerCasLock = await lstat(path.join(lockDir, "owner.update.lock")).catch((error) => {
          if (error?.code === "ENOENT") return null;
          throw error;
        });
        if (ownerCasLock) {
          throw new Error("regression suite lock owner CAS lock is still active at release");
        }
        if (currentOwner.secretDir) {
          if (path.resolve(String(currentOwner.secretDir)) !== path.join(lockDir, "private")) {
            throw new Error("regression suite lock secret directory is not canonical at release");
          }
          const metadata = await lstat(String(currentOwner.secretDir)).catch(() => null);
          if (!metadata
            || !metadata.isDirectory()
            || metadata.isSymbolicLink()
            || (metadata.mode & 0o077) !== 0
            || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
            throw new Error("regression suite lock secret directory is missing or unsafe at release");
          }
          const remainingEntries = await readdir(String(currentOwner.secretDir), { withFileTypes: true });
          if (remainingEntries.length > 0) {
            const unexpected = remainingEntries
              .map((entry) => `${entry.name}:${entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "nonregular"}`)
              .sort();
            throw new Error(`regression suite lock cannot release with unresolved private artifacts: ${unexpected.join(",")}`);
          }
        }
      };
      return {
        lockDir,
        update(change) {
          assertSuiteLockUpdateChange(change, currentOwner);
          pendingUpdateCount += 1;
          const operation = updateQueue.then(async () => {
            if (updateFailure) throw updateFailure;
            assertSuiteLockUpdateChange(change, currentOwner);
            const nextOwner = {
              ...currentOwner,
              ...change,
              ownerRevision: Number(currentOwner.ownerRevision) + 1,
              updatedAt: new Date().toISOString()
            };
            await writeRegressionSuiteOwnerCas({ ownerPath, expectedOwner: currentOwner, nextOwner });
            currentOwner = nextOwner;
          });
          updateQueue = operation.catch((error) => {
            updateFailure ||= error;
          });
          return operation.finally(() => {
            pendingUpdateCount -= 1;
          });
        },
        async flush() {
          await updateQueue;
          if (updateFailure) throw updateFailure;
        },
        releaseSync({ publishLatestSync, rollbackPublishedLatestSync } = {}) {
          if (pendingUpdateCount !== 0) {
            throw new Error("regression suite lock has pending ownership-ledger writes at atomic release");
          }
          if (updateFailure) throw updateFailure;
          const releasedLockDir = relocateRegressionSuiteLockForReleaseSync({
            lockDir,
            expectedOwner: currentOwner,
            validateOwner() {
              if (currentOwner.parentProcessFingerprint !== processIdentityFingerprint(process.pid)) {
                throw new Error("regression suite lock ownership changed before atomic release");
              }
              if (currentOwner.state !== "release-ready"
                || Number(currentOwner.childPid || 0) !== 0
                || currentOwner.childScript
                || currentOwner.childProcessFingerprint
                || currentOwner.childProcessGuardToken
                || currentOwner.childDetachedSpawnLedger !== null
                || !Array.isArray(currentOwner.childProcessLedger)
                || currentOwner.childProcessLedger.length !== 0) {
                throw new Error("regression suite lock is not in the exact atomic release-ready state");
              }
              if (currentOwner.artifactBaseline != null) {
                readPersistedRegressionArtifactBaselineSync({
                  lockDir,
                  reference: currentOwner.artifactBaseline
                });
              }
              if (currentOwner.executionBaseline != null) {
                const persistedExecutionBaseline = readPersistedRegressionExecutionBaselineSync({
                  lockDir,
                  reference: currentOwner.executionBaseline,
                  rootDir,
                  expectedRunId: currentOwner.runId
                });
                assertRegressionExecutionBaselineSync({ rootDir, baseline: persistedExecutionBaseline });
              }
              if (currentOwner.secretDir) {
                if (path.resolve(String(currentOwner.secretDir)) !== path.join(lockDir, "private")) {
                  throw new Error("regression suite lock secret directory is not canonical at atomic release");
                }
                const metadata = lstatSync(String(currentOwner.secretDir));
                if (!metadata.isDirectory()
                  || metadata.isSymbolicLink()
                  || (metadata.mode & 0o077) !== 0
                  || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
                  throw new Error("regression suite lock secret directory is unsafe at atomic release");
                }
                const remainingEntries = readdirSync(String(currentOwner.secretDir), { withFileTypes: true });
                if (remainingEntries.length > 0) {
                  throw new Error("regression suite lock secret directory changed after release preparation");
                }
              }
            },
            publishLatestSync,
            rollbackPublishedLatestSync
          });
          const cleanupErrors = [];
          try {
            rmSync(releasedLockDir, { recursive: true, force: true });
          } catch (error) {
            cleanupErrors.push(error instanceof Error ? error.message : String(error));
          }
          return { cleanupErrors };
        },
        assertReleaseReady
      };
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw error;
      const [lockMetadata, ownerMetadata] = await Promise.all([lstat(lockDir), lstat(ownerPath)]).catch(() => {
        throw new Error("regression suite lock exists without private owned metadata");
      });
      const unexpectedOwner = typeof process.getuid === "function"
        && (lockMetadata.uid !== process.getuid() || ownerMetadata.uid !== process.getuid());
      if (!lockMetadata.isDirectory()
        || lockMetadata.isSymbolicLink()
        || !ownerMetadata.isFile()
        || ownerMetadata.isSymbolicLink()
        || unexpectedOwner
        || (lockMetadata.mode & 0o077) !== 0
        || (ownerMetadata.mode & 0o077) !== 0) {
        throw new Error("regression suite lock exists without private owned metadata");
      }
      const staleOwner = await readRegressionSuiteOwner(ownerPath);
      assertStaleSuiteOwnerInactive(staleOwner);
      const recoveryFixtureTargets = await collectStaleRecoveryFixtureTargets(staleOwner, lockDir);
      const recoveryClaim = await acquireRegressionSuiteRecoveryClaim({
        lockDir,
        staleOwner,
        fixtureTargets: recoveryFixtureTargets,
        claimantPid: process.pid,
        claimantFingerprint: processIdentityFingerprint(process.pid),
        processIsAlive,
        processIdentityFingerprint
      });
      assertStaleSuiteOwnerInactive(staleOwner);
      let executionRecoveryError = null;
      try {
        assertStaleRegressionExecutionBaseline(lockDir, staleOwner);
      } catch (error) {
        executionRecoveryError = error;
      }
      let childRecoveryError = null;
      try {
        await stopStaleChildGroup(staleOwner);
      } catch (error) {
        childRecoveryError = error;
      }
      // Process ambiguity must retain the canonical lock, but it must never leave
      // the durable suite ADMIN usable. Recover the durable fixture ledgers first:
      // they may contain a newer generation than the last owner CAS published.
      let fixtureLedgerRecoveryError = null;
      let fixtureLedgerRecovery = null;
      try {
        // Keep recovering auxiliary ledgers even after one ledger fails; the helper
        // reports every identity it did close and leaves unsafe evidence in place.
        fixtureLedgerRecovery = await recoverStaleFixtureLedgers(
          staleOwner,
          lockDir,
          recoveryClaim.token
        );
      } catch (error) {
        fixtureLedgerRecoveryError = error;
        fixtureLedgerRecovery = error?.recovery || null;
      }
      let fenceRecoveryError = null;
      const fenceAlreadyClosedByLedger = fixtureLedgerRecovery?.identities?.some((identity) => (
        identity.username === String(staleOwner.username || "")
        && identity.userId === String(staleOwner.userId || "")
        && identity.generation >= Number(staleOwner.requestFenceGeneration)
      ));
      if (!fenceAlreadyClosedByLedger) {
        try {
          await closeStaleSuiteRequestFence(staleOwner, recoveryClaim.token);
        } catch (error) {
          fenceRecoveryError = error;
        }
      }
      let identityRecoveryError = null;
      if (staleOwner.username) {
        try {
          recoverStaleSuiteIdentity(staleOwner);
        } catch (error) {
          identityRecoveryError = error;
        }
      }
      let artifactRecoveryError = null;
      if (!childRecoveryError) {
        try {
          await purgeStaleRegressionArtifacts(lockDir, staleOwner);
        } catch (error) {
          artifactRecoveryError = error;
        }
      }
      if (executionRecoveryError
        || childRecoveryError
        || artifactRecoveryError
        || fixtureLedgerRecoveryError
        || fenceRecoveryError
        || identityRecoveryError) {
        const messages = [
          executionRecoveryError,
          childRecoveryError,
          artifactRecoveryError,
          fixtureLedgerRecoveryError,
          fenceRecoveryError,
          identityRecoveryError
        ]
          .filter(Boolean)
          .map((entry) => entry instanceof Error ? entry.message : String(entry));
        throw new Error(`stale regression recovery did not close: ${unique(messages).join("; ")}`);
      }
      const staleSecretDir = await assertStaleSecretDirectoryEmpty(staleOwner, lockDir);
      const recoveredLockDir = await relocateRecoveredRegressionSuiteLock({
        lockDir,
        staleOwner,
        claim: recoveryClaim
      });
      for (const cleanupTarget of [staleSecretDir, recoveredLockDir].filter(Boolean)) {
        try {
          await rm(cleanupTarget, { recursive: true, force: true });
        } catch (cleanupError) {
          console.warn(`Recovered regression private metadata cleanup warning: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
        }
      }
    }
  }
  throw new Error("could not acquire the regression suite lock");
}

async function collectStaleRecoveryFixtureTargets(staleOwner, lockDir) {
  const targets = [];
  const addTarget = ({ username, userId, generation }) => {
    const normalized = {
      username: String(username || ""),
      userId: String(userId || ""),
      generation: Number(generation)
    };
    if (!/^r_[a-z0-9_]{1,58}_[0-9a-f]{12,32}$/.test(normalized.username)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized.userId)
      || !Number.isSafeInteger(normalized.generation)
      || normalized.generation < 0) {
      throw new Error("stale regression recovery target identity is invalid");
    }
    targets.push(normalized);
  };
  if (!regressionSuiteOwnerIsPreIdentity(staleOwner)) {
    addTarget({
      username: staleOwner.username,
      userId: staleOwner.userId,
      generation: staleOwner.requestFenceGeneration
    });
  }
  const staleSecretDir = String(staleOwner?.secretDir || "");
  if (!staleSecretDir) return canonicalRecoveryFixtureTargets(targets);
  const resolvedLockDir = path.resolve(lockDir);
  const resolvedSecretDir = path.resolve(staleSecretDir);
  if (resolvedSecretDir !== path.join(resolvedLockDir, "private")) {
    throw new Error("stale regression fixture target directory is outside the canonical lock");
  }
  const metadata = await lstat(resolvedSecretDir);
  if (!metadata.isDirectory()
    || metadata.isSymbolicLink()
    || (metadata.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    throw new Error("stale regression fixture target directory is not private");
  }
  const entries = await readdir(resolvedSecretDir, { withFileTypes: true });
  const ledgerNames = entries
    .filter((entry) => entry.name.endsWith(".fixtures.jsonl"))
    .map((entry) => entry.name)
    .sort();
  for (const ledgerName of ledgerNames) {
    if (!/^(?:parent|[0-9]{3})\.fixtures\.jsonl$/.test(ledgerName)) {
      throw new Error("stale regression fixture target ledger filename is invalid");
    }
    const directoryEntry = entries.find((entry) => entry.name === ledgerName);
    if (!directoryEntry?.isFile() || directoryEntry.isSymbolicLink()) {
      throw new Error("stale regression fixture target ledger is unsafe");
    }
    const ledger = inspectUnreferencedRegressionFixtureLedger({
      secretDir: resolvedSecretDir,
      file: ledgerName,
      runId: String(staleOwner.runId || ""),
      requireSealed: false
    });
    for (const entry of ledger.entries) addTarget(entry);
  }
  return canonicalRecoveryFixtureTargets(targets);
}

function canonicalRecoveryFixtureTargets(targets) {
  const sorted = [...targets].sort((left, right) => left.username.localeCompare(right.username)
    || left.userId.localeCompare(right.userId)
    || left.generation - right.generation);
  return sorted.filter((target, index) => index === 0
    || target.username !== sorted[index - 1].username
    || target.userId !== sorted[index - 1].userId
    || target.generation !== sorted[index - 1].generation);
}

async function removeStaleRegressionSuiteProvisionalDirectories() {
  const entries = await readdir(tmpdir(), { withFileTypes: true });
  const pattern = /^jdy-erp-regression-suite\.provisional-(\d+)-([0-9a-f]{64})-([0-9a-f]{32})-([A-Za-z0-9_-]{6})$/;
  for (const entry of entries) {
    if (!entry.name.startsWith(regressionSuiteProvisionalPrefix)) continue;
    const match = entry.name.match(pattern);
    if (!match) {
      throw new Error(`regression suite contains an unrecognized provisional lock directory: ${entry.name}`);
    }
    const provisionalPath = path.join(tmpdir(), entry.name);
    const ownerPid = Number(match[1]);
    const ownerFingerprint = match[2];
    if (processIsAlive(ownerPid)) {
      try {
        if (processIdentityFingerprint(ownerPid) === ownerFingerprint) continue;
      } catch {
        throw new Error(`live provisional regression lock ${entry.name} cannot be fingerprinted`);
      }
    }
    const directoryMetadata = await lstat(provisionalPath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!directoryMetadata) continue;
    if (!directoryMetadata.isDirectory()
      || directoryMetadata.isSymbolicLink()
      || (directoryMetadata.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && directoryMetadata.uid !== process.getuid())) {
      throw new Error(`stale provisional regression lock ${entry.name} is unsafe`);
    }
    const children = await readdir(provisionalPath, { withFileTypes: true });
    for (const child of children) {
      if (child.isSymbolicLink()
        || !child.isFile()
        || !(child.name === "owner.json"
          || /^owner\.json\.\d+\.[0-9a-f-]{16,64}\.tmp$/.test(child.name))) {
        throw new Error(`stale provisional regression lock ${entry.name} contains unsafe residue`);
      }
      const metadata = await lstat(path.join(provisionalPath, child.name));
      if (!metadata.isFile()
        || metadata.isSymbolicLink()
        || metadata.nlink !== 1
        || (metadata.mode & 0o077) !== 0
        || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
        throw new Error(`stale provisional regression lock ${entry.name} contains unsafe metadata`);
      }
    }
    await rm(provisionalPath, { recursive: true, force: false }).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

function assertStaleRegressionExecutionBaseline(lockDir, staleOwner) {
  if (staleOwner?.executionBaseline == null
    && (staleOwner?.state === "creating"
      || (staleOwner?.state === "release-ready"
        && regressionSuiteOwnerIsPreIdentity(staleOwner)
        && !staleOwner?.secretDir))) return;
  if (staleOwner?.executionBaseline == null) {
    throw new Error("stale regression suite lock has no tracked execution baseline");
  }
  const baseline = readPersistedRegressionExecutionBaselineSync({
    lockDir,
    reference: staleOwner.executionBaseline,
    rootDir,
    expectedRunId: staleOwner.runId
  });
  assertRegressionExecutionBaselineSync({ rootDir, baseline });
}

async function closeStaleSuiteRequestFence(staleOwner, recoveryCapability) {
  const state = String(staleOwner?.state || "");
  const username = String(staleOwner?.username || "");
  const userId = String(staleOwner?.userId || "");
  const generation = Number(staleOwner?.requestFenceGeneration);
  if (regressionSuiteOwnerIsPreIdentity(staleOwner)) return { state: "UNMANAGED", activeCount: 0 };
  if (!username || !userId) {
    throw new Error("stale regression recovery ledger cannot prove the request-fence identity");
  }
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("stale regression recovery ledger cannot prove the request-fence generation");
  }
  return manageRegressionRequestFence(
    "http://127.0.0.1:8080",
    { username, userId, generation },
    "CLOSE_AND_DRAIN",
    recoveryCapability
  );
}

async function recoverStaleFixtureLedgers(staleOwner, lockDir, recoveryCapability) {
  const staleSecretDir = String(staleOwner?.secretDir || "");
  if (!staleSecretDir) return { closed: true, ledgerCount: 0 };
  const resolvedSecretDir = path.resolve(staleSecretDir);
  if (resolvedSecretDir !== path.join(path.resolve(lockDir), "private")) {
    throw new Error("stale regression suite lock contains an unsafe fixture ledger directory");
  }
  const metadata = await lstat(resolvedSecretDir).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) {
    throw new Error("stale regression fixture ledger directory is missing; auxiliary ownership evidence was lost");
  }
  if (!metadata.isDirectory()
    || metadata.isSymbolicLink()
    || (metadata.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    throw new Error("stale regression fixture ledger directory is not private");
  }
  const secretEntries = await readdir(resolvedSecretDir, { withFileTypes: true });
  const recoveryErrors = [];
  const credentialRecovery = await removeStaleRegressionCredentialCapabilities({
    secretDir: resolvedSecretDir,
    owner: staleOwner
  });
  recoveryErrors.push(...credentialRecovery.errors.map(({ file, error }) => `${file}: ${error}`));
  const detachedCapabilityTemporaryEntries = secretEntries.filter((entry) => (
    /^\.\d{3}\.detached-(?:processes\.jsonl|signing-key)\.[0-9a-f]{16}\.tmp$/.test(entry.name)
  ));
  for (const entry of detachedCapabilityTemporaryEntries) {
    try {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error("unpublished regression detached spawn capability is unsafe");
      }
      removeUnpublishedRegressionDetachedSpawnCapability({
        secretDir: resolvedSecretDir,
        file: entry.name
      });
    } catch (error) {
      recoveryErrors.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const detachedLedgerEntries = secretEntries.filter((entry) => (
    /^\d{3}\.detached-processes\.jsonl$/.test(entry.name)
  ));
  for (const entry of detachedLedgerEntries) {
    try {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error("stale regression detached spawn ledger is a symlink or non-regular entry");
      }
      const reference = staleOwner?.childDetachedSpawnLedger;
      const detached = reference?.file === entry.name
        ? readRegressionDetachedSpawnLedger({
            secretDir: resolvedSecretDir,
            reference,
            expectedParentPid: Number(staleOwner.childPid || 0),
            requireClosed: true
          })
        : inspectUnreferencedRegressionDetachedSpawnLedger({
            secretDir: resolvedSecretDir,
            file: entry.name,
            runId: String(staleOwner.runId || ""),
            requireClosed: true
          });
      const detachedScript = reference?.file === entry.name
        ? String(reference.childScript || "")
        : String(detached.reference?.childScript || "");
      if (!fullScripts.includes(detachedScript)) {
        throw new Error("stale regression detached spawn ledger does not identify a manifest child");
      }
    } catch (error) {
      recoveryErrors.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const ledgerTemporaryName = /^\.(?:parent|[0-9]{3})\.fixtures\.jsonl\.[0-9a-f]{16}\.tmp$/;
  const ledgerTemporaryEntries = secretEntries.filter((entry) => ledgerTemporaryName.test(entry.name));
  const suspiciousLedgerEntries = secretEntries.filter((entry) => (
    entry.name.includes(".fixtures.jsonl.") && !ledgerTemporaryName.test(entry.name)
  ));
  if (suspiciousLedgerEntries.length > 0) {
    recoveryErrors.push("stale regression fixture ledger has an unexpected temporary filename");
  }
  let discardedTemporaryLedgerCount = 0;
  for (const entry of ledgerTemporaryEntries) {
    try {
      const temporaryPath = path.join(resolvedSecretDir, entry.name);
      const temporaryMetadata = await lstat(temporaryPath);
      if (!entry.isFile()
        || entry.isSymbolicLink()
        || !temporaryMetadata.isFile()
        || temporaryMetadata.isSymbolicLink()
        || (temporaryMetadata.mode & 0o077) !== 0
        || (typeof process.getuid === "function" && temporaryMetadata.uid !== process.getuid())) {
        throw new Error("stale regression fixture ledger temporary file is unsafe");
      }
      await unlink(temporaryPath);
      discardedTemporaryLedgerCount += 1;
    } catch (error) {
      recoveryErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const ledgerEntries = secretEntries.filter((entry) => entry.name.endsWith(".fixtures.jsonl"));
  const ledgerNames = ledgerEntries.map((entry) => entry.name).sort();
  const identities = [];
  for (const ledgerName of ledgerNames) {
    try {
      if (!/^(?:parent|[0-9]{3})\.fixtures\.jsonl$/.test(ledgerName)) {
        throw new Error("stale regression fixture ledger has an unexpected filename");
      }
      const ledgerEntry = ledgerEntries.find((entry) => entry.name === ledgerName);
      if (!ledgerEntry?.isFile() || ledgerEntry.isSymbolicLink()) {
        throw new Error("stale regression fixture ledger is a symlink or non-regular entry");
      }
      const ledger = inspectUnreferencedRegressionFixtureLedger({
        secretDir: resolvedSecretDir,
        file: ledgerName,
        runId: String(staleOwner.runId || ""),
        requireSealed: false
      });
      const recovery = await closeAndRecoverRegressionFixtureLedger(
        "http://127.0.0.1:8080",
        {
          secretDir: resolvedSecretDir,
          reference: ledger.reference,
          writer: null
        },
        String(staleOwner.runId || ""),
        recoveryCapability
      );
      identities.push(...recovery.results.map(({ username, userId, generation }) => ({
        username,
        userId,
        generation
      })));
      removeRegressionFixtureLedger({
        secretDir: resolvedSecretDir,
        reference: ledger.reference,
        requireSealed: false
      });
    } catch (error) {
      recoveryErrors.push(`${ledgerName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const recovery = {
    closed: recoveryErrors.length === 0,
    ledgerCount: ledgerNames.length,
    discardedCredentialCount: credentialRecovery.removed.length,
    detachedLedgerCount: detachedLedgerEntries.length,
    discardedTemporaryLedgerCount,
    identities
  };
  if (recoveryErrors.length > 0) {
    const error = new Error(`stale regression fixture ledger recovery was incomplete: ${unique(recoveryErrors).join("; ")}`);
    error.recovery = recovery;
    throw error;
  }
  return recovery;
}

function recoverStaleSuiteIdentity(staleOwner) {
  return recoverIsolatedAdminSessionFixture({
    username: String(staleOwner.username),
    userId: String(staleOwner.userId || ""),
    displayName: suiteDisplayName,
    retainQuarantinedIdentity: true,
    allowIdentityNeverCreated: regressionSuiteOwnerIsPreIdentity(staleOwner),
    allowLegacySuiteTombstoneAdoption: true
  });
}

function processIsAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function processIdentityFingerprint(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) {
    throw new Error("regression process identity requires a positive pid");
  }
  let description;
  try {
    description = execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch {
    throw new Error(`could not fingerprint regression process pid ${pid}`);
  }
  if (!description) throw new Error(`could not fingerprint regression process pid ${pid}`);
  return createHash("sha256").update(description).digest("hex");
}

function processGroupIdentitySnapshot(groupId, persistedMembers = [], includeDescendants = false) {
  if (!Number.isInteger(Number(groupId)) || Number(groupId) <= 0) return [];
  const normalizedPersisted = Array.isArray(persistedMembers) ? persistedMembers : [];
  const includedPids = new Set(normalizedPersisted
    .map((member) => Number(typeof member === "object" ? member?.pid : member))
    .filter((pid) => Number.isInteger(pid) && pid > 1));
  const includedProcessGroups = new Set(normalizedPersisted
    .filter((member) => member && typeof member === "object"
      && Number(member.pid) === Number(member.pgidAtProof))
    .map((member) => Number(member.pid))
    .filter((pid) => Number.isInteger(pid) && pid > 1));
  // A43 can create thousands of short-lived guarded commands.  Do not ask ps
  // for every process on the host: unrelated long command lines make that
  // global snapshot both unnecessarily expensive and capable of overflowing a
  // bounded capture.  The child PGID plus previously proven detached PGIDs and
  // PIDs form the complete trusted observation set; a new reparented group can
  // only enter through the signed detached ledger below.
  const observedProcessGroups = new Set([Number(groupId)]);
  for (const member of normalizedPersisted) {
    const memberGroupId = Number(member?.pgidAtProof);
    if (Number.isInteger(memberGroupId) && memberGroupId > 1) {
      observedProcessGroups.add(memberGroupId);
    }
  }
  const psFormat = "pid=,ppid=,pgid=,state=,lstart=,command=";
  const snapshots = [];
  const readSelectedProcesses = (args) => {
    try {
      return execFileSync("ps", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024
      });
    } catch (error) {
      // BSD ps exits 1 when a previously-proven PID or PGID has naturally
      // disappeared between snapshots. That is an empty, valid observation;
      // treating it as an infrastructure failure turns normal short-lived
      // descendants into a false ownership escape.
      if (Number(error?.status) === 1) return String(error?.stdout || "");
      throw error;
    }
  };
  try {
    snapshots.push(readSelectedProcesses([
      "-ww",
      "-g", [...observedProcessGroups].join(","),
      "-o", psFormat
    ]));
    if (includedPids.size > 0) {
      snapshots.push(readSelectedProcesses([
        "-ww",
        "-p", [...includedPids].join(","),
        "-o", psFormat
      ]));
    }
  } catch (error) {
    throw new Error(`could not enumerate regression process group ${groupId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const rowsByPid = new Map();
  for (const output of snapshots) for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/);
    if (!match || match[4].startsWith("Z")) continue;
    const row = {
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      pgid: Number(match[3]),
      lstart: match[5].replace(/\s+/g, " "),
      command: match[6],
      commandFingerprint: createHash("sha256").update(match[6]).digest("hex")
    };
    rowsByPid.set(row.pid, row);
  }
  const rows = [...rowsByPid.values()];
  if (includeDescendants) {
    return selectRegressionProcessOwnershipMembers({
      members: rows,
      groupId,
      persistedPids: [...includedPids],
      persistedProcessGroups: [...includedProcessGroups]
    });
  }
  return rows.filter((row) => row.pgid === Number(groupId)
    || includedPids.has(row.pid)
    || includedProcessGroups.has(row.pgid));
}

function refreshChildProcessLedger(handle) {
  const groupId = Number(handle?.child?.pid || 0);
  const before = JSON.stringify(handle?.childProcessLedger || []);
  const detached = readRegressionDetachedSpawnLedger({
    secretDir: String(handle?.secretDir || secretDir),
    reference: handle?.childDetachedSpawnLedger,
    expectedParentPid: groupId,
    requireClosed: false
  });
  handle.childProcessLedger = adoptRegressionProcessLedgerRecords({
    ledger: handle?.childProcessLedger || [],
    records: detached.members,
    groupId
  });
  handle.childProcessLedger = mergeRegressionProcessGroupLedger({
    ledger: handle?.childProcessLedger || [],
    members: processGroupIdentitySnapshot(
      groupId,
      handle?.childProcessLedger || [],
      true
    ),
    groupId
  });
  return before !== JSON.stringify(handle.childProcessLedger);
}

function closeChildDetachedSpawnLedger(handle) {
  const groupId = Number(handle?.child?.pid || 0);
  const before = JSON.stringify(handle?.childProcessLedger || []);
  const detached = readRegressionDetachedSpawnLedger({
    secretDir: String(handle?.secretDir || secretDir),
    reference: handle?.childDetachedSpawnLedger,
    expectedParentPid: groupId,
    requireClosed: true,
    allowHeaderOnly: true
  });
  handle.childProcessLedger = adoptRegressionProcessLedgerRecords({
    ledger: handle?.childProcessLedger || [],
    records: detached.members,
    groupId
  });
  handle.childProcessLedger = mergeRegressionProcessGroupLedger({
    ledger: handle.childProcessLedger,
    members: processGroupIdentitySnapshot(groupId, handle.childProcessLedger, true),
    groupId
  });
  return before !== JSON.stringify(handle.childProcessLedger);
}

function closeChildDockerLeaseWatchdog(handle) {
  if (handle?.dockerLeaseClosureVerified === true) return handle.dockerLeaseClosureResult;
  const groupId = Number(handle?.child?.pid || 0);
  const detached = readRegressionDetachedSpawnLedger({
    secretDir: String(handle?.secretDir || secretDir),
    reference: handle?.childDetachedSpawnLedger,
    expectedParentPid: groupId,
    requireClosed: true
  });
  const payload = String(handle?.dockerWatchdogAckPayload || "");
  let result;
  try {
    result = readRegressionDockerWatchdogAck({
      payload,
      ledgerFile: handle.childDetachedSpawnLedger.file,
      runId: handle.childDetachedSpawnLedger.runId,
      guardToken: handle.childDetachedSpawnLedger.guardToken,
      expectedIntentIds: detached.dockerIntents.map(({ id }) => id),
      expectedCompletedIds: detached.completedDockerIntentIds,
      requireSealed: true
    });
  } catch (error) {
    // The ACK itself is capability-bearing; retain only transport shape when
    // diagnosing a rejected frame, never the payload or its identifiers.
    const byteLength = Buffer.byteLength(payload);
    const terminalByte = byteLength === 0 ? -1 : payload.charCodeAt(payload.length - 1);
    throw new Error(`${error instanceof Error ? error.message : String(error)} (ackBytes=${byteLength}, terminalByte=${terminalByte})`);
  }
  handle.dockerLeaseClosureVerified = true;
  handle.dockerLeaseClosureResult = result;
  return result;
}

function startChildProcessLedgerMonitor(handle, persistLedger, persistFailure = async () => {}) {
  handle.processLedgerUpdate = Promise.resolve();
  handle.processLedgerError = null;
  handle.processLedgerStopped = false;
  const tick = () => {
    handle.processLedgerUpdate = handle.processLedgerUpdate.then(async () => {
      if (!refreshChildProcessLedger(handle)) return;
      await persistLedger(handle.childProcessLedger);
    }).catch((error) => {
      handle.processLedgerError = error;
      processOwnershipComplete = false;
      setupError = [
        setupError,
        error instanceof Error ? error.message : String(error)
      ].filter(Boolean).join("; ");
      return persistFailure(error).catch(() => {});
    });
  };
  handle.processLedgerMonitor = setInterval(tick, 100);
  handle.processLedgerMonitor.unref?.();
  handle.stopProcessLedgerMonitor = async () => {
    if (handle.processLedgerStopped) {
      await handle.processLedgerUpdate;
      if (handle.processLedgerError) throw handle.processLedgerError;
      return;
    }
    handle.processLedgerStopped = true;
    if (handle.processLedgerMonitor) clearInterval(handle.processLedgerMonitor);
    handle.processLedgerMonitor = null;
    tick();
    await handle.processLedgerUpdate;
    if (handle.processLedgerError) throw handle.processLedgerError;
  };
}

function secretVariants(secret) {
  if (!secret) return [];
  return unique([
    secret,
    Buffer.from(secret).toString("base64"),
    Buffer.from(secret).toString("base64url"),
    encodeURIComponent(secret)
  ]).filter((value) => value.length >= 8);
}

function redactOutput(value, password, exactSecrets = []) {
  let redacted = String(value ?? "");
  for (const secret of unique([password, ...exactSecrets].flatMap(secretVariants))) {
    redacted = redacted.replaceAll(secret, "[REDACTED_RUN_SECRET]");
  }
  return redacted
    .replace(/SESSION=[^;\s"']+/g, "SESSION=[REDACTED]")
    .replace(/[A-Za-z0-9:_-]+:sessions:(?:expires:)?[A-Za-z0-9%+/_=-]{16,}/gi, "[REDACTED_REDIS_SESSION_KEY]")
    .replace(/[A-Za-z0-9:_-]+:expirations:\d{6,}/gi, "[REDACTED_REDIS_EXPIRATION_KEY]")
    .replace(/((?:sessionCookie|sessionToken|activeSessionToken|scopeToken)["']?\s*[:=]\s*["']?)[A-Za-z0-9%+/_=-]{16,}/gi, "$1[REDACTED]");
}

function unique(values) {
  return [...new Set(values)];
}

function tail(value, max = 4000) {
  return value.length > max ? value.slice(-max) : value;
}
