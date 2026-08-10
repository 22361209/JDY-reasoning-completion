import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  captureA126RunSnapshot,
  cleanupA126Run,
  dbJson,
  sqlLiteral,
  validateA126RunSnapshot
} from "../scripts/helpers/a126-fixture-cleanup.mjs";
import { recoverIsolatedAdminSessionFixture } from "../scripts/helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digestPattern = /^[0-9a-f]{64}$/;

function assert(condition, message, details = undefined) {
  if (!condition) throw new Error(`${message}${details === undefined ? "" : ` ${JSON.stringify(details)}`}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArguments(argv) {
  const parsed = {
    evidencePath: "",
    receiptPath: "",
    receiptSha: "",
    apply: false,
    digest: ""
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--evidence") parsed.evidencePath = argv[++index] ?? "";
    else if (argument === "--receipt") parsed.receiptPath = argv[++index] ?? "";
    else if (argument === "--receipt-sha") parsed.receiptSha = argv[++index] ?? "";
    else if (argument === "--apply") parsed.apply = true;
    else if (argument === "--digest") parsed.digest = argv[++index] ?? "";
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (parsed.apply) {
    assert(!parsed.evidencePath, "--apply consumes a reviewed --receipt, not --evidence");
    assert(parsed.receiptPath && digestPattern.test(parsed.receiptSha) && digestPattern.test(parsed.digest),
      "--apply requires --receipt, --receipt-sha and --digest");
  } else {
    assert(parsed.evidencePath, "dry-run requires --evidence");
    assert(!parsed.receiptPath && !parsed.receiptSha && !parsed.digest,
      "--receipt, --receipt-sha and --digest are only accepted with --apply");
  }
  return parsed;
}

function verificationPath(relativeOrAbsolutePath, label) {
  const resolved = path.resolve(rootDir, relativeOrAbsolutePath);
  assert(resolved.startsWith(`${verificationDir}${path.sep}`), `${label} must stay inside verification/`, resolved);
  return resolved;
}

function validateFailedEvidence(evidence) {
  assert(evidence?.ok === false && evidence?.cleanup?.attempted === true && evidence?.cleanup?.success === false,
    "input evidence is not a failed A126 cleanup receipt");
  assert(uuidPattern.test(String(evidence.runId ?? ""))
    && evidence.marker === `A126:${evidence.runId}`
    && evidence.baseline?.balance,
  "input evidence has no exact A126 run/baseline identity");
  for (const [role, label] of [["admin", "admin fence"], ["warehouse", "warehouse fence"]]) {
    const phase = evidence.cleanup.phases?.find((candidate) => candidate.label === label);
    assert(phase?.ok === true && phase.result?.state === "CLOSED" && Number(phase.result?.activeCount) === 0,
      `A126 ${role} request fence was not CLOSED/0; exact recovery is forbidden`, phase);
  }
  for (const role of ["admin", "warehouse"]) {
    const identity = evidence.identities?.[role];
    assert(uuidPattern.test(String(identity?.userId ?? "")) && identity?.username,
      "failed A126 evidence does not contain two exact identity owners", { role, identity });
  }
}

function queryIdentityRows(descriptors) {
  const ids = descriptors.map((identity) => `${sqlLiteral(identity.id ?? identity.userId)}::uuid`).join(",");
  const usernames = descriptors.map((identity) => sqlLiteral(identity.username)).join(",");
  return dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', user_row.id::text,
      'username', user_row.username,
      'displayName', user_row.display_name,
      'enabled', user_row.enabled,
      'createdBy', user_row.created_by::text,
      'activeSessionToken', user_row.active_session_token,
      'activeSessionStartedAt', user_row.active_session_started_at
    ) ORDER BY user_row.id::text), '[]'::jsonb)::text
    FROM public.sys_user user_row
    WHERE user_row.id IN (${ids}) OR user_row.username IN (${usernames})
  `, "A184 A126 recovery identity snapshot");
}

function captureRequiredQuarantinedIdentities(evidenceIdentities) {
  const requested = [evidenceIdentities.admin, evidenceIdentities.warehouse];
  const rows = queryIdentityRows(requested);
  assert(Array.isArray(rows) && rows.length === 2, "A126 dry-run requires both quarantined identities", rows);
  return requested.map((identity) => {
    const row = rows.find((candidate) => candidate.id === identity.userId);
    assert(row?.username === identity.username
      && row.enabled === false
      && row.createdBy === row.id
      && row.activeSessionToken == null
      && row.activeSessionStartedAt == null
      && row.displayName,
    "A126 recovery identity ownership/quarantine drifted", { expected: identity, actual: row });
    assert(rows.filter((candidate) => candidate.username === identity.username).length === 1,
      "A126 recovery identity username is not unique", identity);
    return row;
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function inspectReviewedIdentities(reviewedIdentities) {
  assert(Array.isArray(reviewedIdentities) && reviewedIdentities.length === 2,
    "reviewed recovery receipt must contain exactly two identities");
  const rows = queryIdentityRows(reviewedIdentities);
  return reviewedIdentities.map((expected) => {
    assert(uuidPattern.test(String(expected.id ?? "")) && expected.username && expected.displayName,
      "reviewed identity descriptor is incomplete", expected);
    const byId = rows.find((candidate) => candidate.id === expected.id);
    const byUsername = rows.filter((candidate) => candidate.username === expected.username);
    if (!byId) {
      assert(byUsername.length === 0, "reviewed identity username was reused by another principal", { expected, rows: byUsername });
      return { ...expected, state: "ABSENT" };
    }
    assert(byUsername.length === 1
      && byId.username === expected.username
      && byId.displayName === expected.displayName
      && byId.enabled === false
      && byId.createdBy === byId.id
      && byId.activeSessionToken == null
      && byId.activeSessionStartedAt == null,
    "reviewed identity is neither absent nor the exact quarantined principal", { expected, actual: byId });
    return { ...expected, state: "PRESENT_QUARANTINED" };
  });
}

function buildConfig(failedEvidence, reviewedIdentities) {
  return {
    marker: failedEvidence.marker,
    seedPrefix: `A126_SEED:${failedEvidence.runId}:`,
    productCode: "CP-001",
    warehouseCode: "CK-001",
    billDate: "2026-07-01",
    startedAt: failedEvidence.generatedAt,
    userIds: reviewedIdentities.map((identity) => identity.id).sort()
  };
}

function snapshotAllowlist(snapshot) {
  const ids = (rows) => rows.map((row) => String(row.id)).sort();
  const documents = (rows) => rows
    .map((row) => ({ id: String(row.id), billNo: String(row.bill_no) }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    quotes: documents(snapshot.quotes),
    quoteLineIds: ids(snapshot.quoteLines),
    orders: documents(snapshot.orders),
    orderLineIds: ids(snapshot.orderLines),
    notices: documents(snapshot.notices),
    noticeLineIds: ids(snapshot.noticeLines),
    outs: documents(snapshot.outs),
    outLineIds: ids(snapshot.outLines),
    receivableIds: ids(snapshot.receivables),
    transactionIds: ids(snapshot.transactions),
    operationLogIds: ids(snapshot.logs),
    locks: snapshot.locks
      .map((row) => ({ documentType: row.document_type, billNo: row.bill_no, holderUserId: row.holder_user_id }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  };
}

function recoveryDigestFor({ inputEvidenceSha256, runId, marker, config, identities, baseline, snapshotDigest, allowlist }) {
  return sha256(JSON.stringify({
    inputEvidenceSha256,
    runId,
    marker,
    config,
    identities,
    baseline,
    snapshotDigest,
    allowlist
  }));
}

async function persistReceipt(receipt, outputPath) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporaryPath, outputPath);
}

function outputPathFor(runId, mode) {
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
  return path.join(
    verificationDir,
    `a184-a126-current-run-recovery-${timestamp}-${runId.slice(0, 8)}-${mode}-${randomUUID().slice(0, 8)}.json`
  );
}

function zeroRunCounts(snapshot) {
  return [
    snapshot.quotes,
    snapshot.quoteLines,
    snapshot.orders,
    snapshot.orderLines,
    snapshot.notices,
    snapshot.noticeLines,
    snapshot.outs,
    snapshot.outLines,
    snapshot.receivables,
    snapshot.transactions,
    snapshot.logs,
    snapshot.locks
  ].every((rows) => Array.isArray(rows) && rows.length === 0);
}

async function runDry(evidenceArgument) {
  const inputPath = verificationPath(evidenceArgument, "--evidence");
  const inputBytes = await readFile(inputPath);
  const failedEvidence = JSON.parse(inputBytes.toString("utf8"));
  validateFailedEvidence(failedEvidence);
  const identities = captureRequiredQuarantinedIdentities(failedEvidence.identities);
  const config = buildConfig(failedEvidence, identities);
  const snapshot = captureA126RunSnapshot(config);
  const transform = validateA126RunSnapshot({ baseline: failedEvidence.baseline, snapshot, config });
  const inputEvidenceSha256 = sha256(inputBytes);
  const allowlist = snapshotAllowlist(snapshot);
  const recoveryDigest = recoveryDigestFor({
    inputEvidenceSha256,
    runId: failedEvidence.runId,
    marker: failedEvidence.marker,
    config,
    identities,
    baseline: failedEvidence.baseline,
    snapshotDigest: snapshot.snapshotDigest,
    allowlist
  });
  const outputPath = outputPathFor(failedEvidence.runId, "dry-run");
  const receipt = {
    taskId: "A184",
    operation: "A126_CURRENT_RUN_EXACT_RECOVERY",
    generatedAt: new Date().toISOString(),
    inputEvidence: { path: path.relative(rootDir, inputPath), sha256: inputEvidenceSha256 },
    run: { runId: failedEvidence.runId, marker: failedEvidence.marker, config, identities },
    baseline: failedEvidence.baseline,
    frozen: {
      snapshotDigest: snapshot.snapshotDigest,
      recoveryDigest,
      transform,
      external: snapshot.external,
      currentBalance: snapshot.balance,
      nonOwnedTransactions: snapshot.nonOwnedTransactions,
      allowlist
    },
    disposition: "READY_FOR_EXACT_APPLY",
    apply: { requested: false, success: false, phases: [] }
  };
  await persistReceipt(receipt, outputPath);
  console.log(JSON.stringify({
    ok: true,
    disposition: receipt.disposition,
    outputPath: path.relative(rootDir, outputPath),
    receiptSha256: sha256(await readFile(outputPath)),
    snapshotDigest: snapshot.snapshotDigest,
    recoveryDigest,
    transform
  }));
}

async function runApply(arguments_) {
  const parentPath = verificationPath(arguments_.receiptPath, "--receipt");
  const parentBytes = await readFile(parentPath);
  assert(sha256(parentBytes) === arguments_.receiptSha, "reviewed dry-run receipt SHA does not match");
  const parent = JSON.parse(parentBytes.toString("utf8"));
  assert(parent?.taskId === "A184"
    && parent?.operation === "A126_CURRENT_RUN_EXACT_RECOVERY"
    && parent?.disposition === "READY_FOR_EXACT_APPLY"
    && parent?.apply?.requested === false
    && digestPattern.test(String(parent?.frozen?.snapshotDigest ?? ""))
    && digestPattern.test(String(parent?.frozen?.recoveryDigest ?? "")),
  "reviewed receipt is not an unapplied A126 recovery manifest");

  const inputPath = verificationPath(parent.inputEvidence.path, "reviewed input evidence");
  const inputBytes = await readFile(inputPath);
  assert(sha256(inputBytes) === parent.inputEvidence.sha256, "failed A126 evidence changed after dry-run review");
  const failedEvidence = JSON.parse(inputBytes.toString("utf8"));
  validateFailedEvidence(failedEvidence);
  assert(failedEvidence.runId === parent.run.runId && failedEvidence.marker === parent.run.marker,
    "reviewed run identity does not match failed evidence");
  assert(JSON.stringify(failedEvidence.baseline) === JSON.stringify(parent.baseline),
    "reviewed baseline does not match failed evidence");
  for (const role of ["admin", "warehouse"]) {
    const evidenceIdentity = failedEvidence.identities[role];
    const matches = parent.run.identities.filter((identity) => identity.id === evidenceIdentity.userId);
    assert(matches.length === 1 && matches[0].username === evidenceIdentity.username,
      `reviewed ${role} identity does not match failed evidence`, { evidenceIdentity, reviewed: parent.run.identities });
  }
  const expectedConfig = buildConfig(failedEvidence, parent.run.identities);
  assert(JSON.stringify(expectedConfig) === JSON.stringify(parent.run.config),
    "reviewed cleanup config does not match failed evidence");
  const recomputedRecoveryDigest = recoveryDigestFor({
    inputEvidenceSha256: parent.inputEvidence.sha256,
    runId: parent.run.runId,
    marker: parent.run.marker,
    config: parent.run.config,
    identities: parent.run.identities,
    baseline: parent.baseline,
    snapshotDigest: parent.frozen.snapshotDigest,
    allowlist: parent.frozen.allowlist
  });
  assert(recomputedRecoveryDigest === parent.frozen.recoveryDigest
    && arguments_.digest === parent.frozen.recoveryDigest,
  "reviewed recovery digest does not match the immutable dry-run manifest");

  const identityStates = inspectReviewedIdentities(parent.run.identities);
  const currentSnapshot = captureA126RunSnapshot(parent.run.config);
  const currentTransform = validateA126RunSnapshot({
    baseline: parent.baseline,
    snapshot: currentSnapshot,
    config: parent.run.config
  });
  let businessState = "";
  if (currentSnapshot.snapshotDigest === parent.frozen.snapshotDigest) {
    assert(JSON.stringify(snapshotAllowlist(currentSnapshot)) === JSON.stringify(parent.frozen.allowlist),
      "fresh snapshot allowlist does not match the reviewed manifest");
    businessState = "PENDING_EXACT_CLEANUP";
  } else {
    assert(zeroRunCounts(currentSnapshot),
      "current A126 state matches neither the reviewed snapshot nor a fully restored baseline", {
        reviewed: parent.frozen.snapshotDigest,
        current: currentSnapshot.snapshotDigest
      });
    businessState = "ALREADY_RECOVERED_AND_BASELINE_VERIFIED";
  }

  const outputPath = outputPathFor(parent.run.runId, "apply");
  const receipt = {
    taskId: "A184",
    operation: "A126_CURRENT_RUN_EXACT_RECOVERY_APPLY",
    generatedAt: new Date().toISOString(),
    parentReceipt: {
      path: path.relative(rootDir, parentPath),
      sha256: arguments_.receiptSha,
      recoveryDigest: parent.frozen.recoveryDigest
    },
    run: parent.run,
    baseline: parent.baseline,
    preApply: {
      businessState,
      identityStates,
      snapshotDigest: currentSnapshot.snapshotDigest,
      transform: currentTransform,
      external: currentSnapshot.external,
      currentBalance: currentSnapshot.balance,
      nonOwnedTransactions: currentSnapshot.nonOwnedTransactions
    },
    disposition: "APPLY_PENDING",
    apply: { requested: true, success: false, phases: [] }
  };
  await persistReceipt(receipt, outputPath);

  let businessCleanup = null;
  let recoveryVerified = false;
  const identityCleanup = [];
  try {
    if (businessState === "PENDING_EXACT_CLEANUP") {
      businessCleanup = cleanupA126Run({
        baseline: parent.baseline,
        snapshot: currentSnapshot,
        config: parent.run.config
      });
      receipt.apply.phases.push({ label: "business facts and stock baseline", ok: true, result: businessCleanup });
    } else {
      receipt.apply.phases.push({ label: "business facts and stock baseline", ok: true, alreadyRecovered: true });
    }
    await persistReceipt(receipt, outputPath);

    for (const role of ["warehouse", "admin"]) {
      const evidenceIdentity = failedEvidence.identities[role];
      const identity = parent.run.identities.find((candidate) => candidate.id === evidenceIdentity.userId);
      try {
        const result = recoverIsolatedAdminSessionFixture({
          username: identity.username,
          userId: identity.id,
          displayName: identity.displayName,
          retainQuarantinedIdentity: false,
          allowIdentityNeverCreated: false
        });
        identityCleanup.push({ role, ok: true, result });
      } catch (error) {
        identityCleanup.push({ role, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      receipt.apply.phases.push(identityCleanup.at(-1));
      await persistReceipt(receipt, outputPath);
    }

    const finalSnapshot = captureA126RunSnapshot(parent.run.config);
    const finalTransform = validateA126RunSnapshot({
      baseline: parent.baseline,
      snapshot: finalSnapshot,
      config: parent.run.config
    });
    assert(zeroRunCounts(finalSnapshot), "A126 exact recovery left run-owned business residue");
    assert(identityCleanup.every((phase) => phase.ok
      && phase.result?.closed === true
      && (phase.result?.principalDeleted === true || phase.result?.absent === true)),
    "A126 exact recovery left a quarantined identity", identityCleanup);
    const finalIdentityStates = inspectReviewedIdentities(parent.run.identities);
    assert(finalIdentityStates.every((identity) => identity.state === "ABSENT"),
      "A126 exact recovery did not remove both reviewed principals", finalIdentityStates);
    receipt.apply.final = {
      snapshotDigest: finalSnapshot.snapshotDigest,
      transform: finalTransform,
      external: finalSnapshot.external,
      currentBalance: finalSnapshot.balance,
      nonOwnedTransactions: finalSnapshot.nonOwnedTransactions,
      zeroRunResidue: true,
      identityCleanup,
      identityStates: finalIdentityStates
    };
    receipt.apply.success = true;
    receipt.disposition = "APPLIED_AND_VERIFIED";
    receipt.completedAt = new Date().toISOString();
    recoveryVerified = true;
    await persistReceipt(receipt, outputPath);
  } catch (error) {
    receipt.apply.success = false;
    receipt.apply.recoveryVerified = recoveryVerified;
    receipt.disposition = recoveryVerified
      ? "RECOVERY_VERIFIED_FINAL_RECEIPT_WRITE_FAILED"
      : (businessCleanup || businessState === "ALREADY_RECOVERED_AND_BASELINE_VERIFIED"
          ? "BUSINESS_RECOVERED_IDENTITY_OR_VERIFICATION_FAILED"
          : "APPLY_FAILED_OR_ROLLED_BACK");
    receipt.apply.error = error instanceof Error ? error.message : String(error);
    receipt.completedAt = new Date().toISOString();
    try {
      await persistReceipt(receipt, outputPath);
    } catch (persistError) {
      throw new AggregateError([error, persistError], "A126 exact recovery and final receipt persistence both failed");
    }
    throw error;
  }

  console.log(JSON.stringify({
    ok: true,
    disposition: receipt.disposition,
    outputPath: path.relative(rootDir, outputPath),
    receiptSha256: sha256(await readFile(outputPath)),
    parentReceiptSha256: arguments_.receiptSha,
    recoveryDigest: parent.frozen.recoveryDigest,
    cleanup: businessCleanup,
    identityCleanup
  }));
}

const arguments_ = parseArguments(process.argv.slice(2));
if (arguments_.apply) await runApply(arguments_);
else await runDry(arguments_.evidencePath);
