import path from "node:path";
import { closeSync, fstatSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import {
  cleanupRegressionDockerLeaseIntents,
  encodeRegressionDockerWatchdogAck,
  regressionDockerLeaseVersion,
} from "./regression-docker-lease.mjs";
import { readRegressionDetachedSpawnLedger } from "./regression-detached-spawn-ledger.mjs";

let ownershipBytes;
let ownership;
try {
  const ownershipMetadata = fstatSync(3);
  const readinessMetadata = fstatSync(4);
  if (!ownershipMetadata.isFile()
    || ownershipMetadata.isSymbolicLink()
    || ownershipMetadata.nlink !== 0
    || ownershipMetadata.size < 1
    || ownershipMetadata.size > 16 * 1024
    || (ownershipMetadata.mode & 0o077) !== 0
    || !readinessMetadata.isFile()
    || readinessMetadata.isSymbolicLink()
    || readinessMetadata.nlink !== 0
    || readinessMetadata.size !== 0
    || (readinessMetadata.mode & 0o077) !== 0
    || (typeof process.getuid === "function"
      && (ownershipMetadata.uid !== process.getuid() || readinessMetadata.uid !== process.getuid()))) {
    throw new Error("regression Docker watchdog ownership descriptors are unsafe");
  }
  ownershipBytes = readFileSync(3);
  ownership = JSON.parse(ownershipBytes.toString("utf8"));
} catch {
  throw new Error("regression Docker watchdog ownership capability is invalid");
} finally {
  ownershipBytes?.fill(0);
  try { closeSync(3); } catch { /* invalid ownership already fails closed */ }
}
const secretDir = String(ownership?.secretDir || "");
const reference = ownership?.reference;
const expectedParentPid = Number(ownership?.expectedParentPid || 0);
if (!path.isAbsolute(secretDir)
  || !ownership
  || typeof ownership !== "object"
  || Array.isArray(ownership)
  || Object.keys(ownership).sort().join(",") !== "expectedParentPid,reference,secretDir,version"
  || ownership.version !== 1
  || !Number.isInteger(expectedParentPid)
  || expectedParentPid <= 1
  || reference?.runId == null
  || reference?.guardToken == null) {
  throw new Error("regression Docker watchdog ownership metadata is invalid");
}
const watchdogAckFile = `${String(reference.file).replace(/\.detached-processes\.jsonl$/, "")}.docker-watchdog.ack`;
if (!/^[0-9]{3}\.docker-watchdog\.ack$/.test(watchdogAckFile)) {
  throw new Error("regression Docker watchdog acknowledgement path is invalid");
}
const watchdogAckPath = path.join(secretDir, watchdogAckFile);

let closing = false;
async function closeOwnedDockerLeases(trigger) {
  if (closing) return;
  closing = true;
  process.stdin.pause();
  process.stdin.unref?.();
  let result;
  try {
    const ledger = readRegressionDetachedSpawnLedger({
      secretDir,
      reference,
      expectedParentPid,
      requireClosed: false
    });
    const cleanup = await cleanupRegressionDockerLeaseIntents({
      // A signed docker-completed record proves the guarded tool already
      // returned; only an uncompleted intent can still own a live Docker-side
      // resource.  Replaying all completed intents turns normal teardown into
      // an unbounded N-by-N recovery delay.
      intents: ledger.pendingDockerIntents,
      runId: reference.runId,
      guardToken: reference.guardToken
    });
    result = {
      version: regressionDockerLeaseVersion,
      runId: reference.runId,
      guardToken: reference.guardToken,
      ledgerFile: reference.file,
      trigger,
      sealed: ledger.sealed,
      partialLedgerRecord: ledger.hasPartialRecord,
      intentIds: ledger.dockerIntents.map(({ id }) => id).sort(),
      completedIds: ledger.completedDockerIntentIds,
      cleanedIds: [...ledger.completedDockerIntentIds, ...cleanup.cleaned.map(({ id }) => id)].sort(),
      errors: cleanup.errors,
      ok: cleanup.ok,
      completedAt: new Date().toISOString()
    };
  } catch (error) {
    result = {
      version: regressionDockerLeaseVersion,
      runId: reference.runId,
      guardToken: reference.guardToken,
      ledgerFile: reference.file,
      trigger,
      sealed: false,
      partialLedgerRecord: true,
      intentIds: [],
      completedIds: [],
      cleanedIds: [],
      errors: [{ error: error instanceof Error ? error.message : String(error) }],
      ok: false,
      completedAt: new Date().toISOString()
    };
  }
  try {
    const payload = encodeRegressionDockerWatchdogAck(result);
    // The bootstrap may close the inherited stdout descriptor before a
    // detached watchdog completes its bounded cleanup.  Persist the exact
    // same signed frame in the already-private suite directory so the runner
    // can recover it only when the pipe delivered no bytes at all.
    writeFileSync(watchdogAckPath, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
    // The durable ACK is the authoritative completion proof.  The inherited
    // pipe is only a latency optimisation: when its peer has already closed,
    // waiting for Node's end callback can retain this detached watchdog after
    // the bootstrap exits.  Best-effort the same frame, then terminate on the
    // next turn; the runner reads the durable frame when this pipe is empty.
    try { process.stdout.end(payload); } catch { /* Durable ACK remains valid. */ }
  } catch {
    process.exitCode = 1;
    return;
  }
  if (!result.ok) process.exitCode = 1;
  setImmediate(() => process.exit(process.exitCode ?? 0));
}

process.once("SIGINT", () => { void closeOwnedDockerLeases("SIGINT"); });
process.once("SIGTERM", () => { void closeOwnedDockerLeases("SIGTERM"); });
process.stdin.once("end", () => { void closeOwnedDockerLeases("OWNER_EOF"); });
// A parent-side pipe close can surface as `close` (or an I/O error) without
// delivering Node's readable `end` event.  All three terminal conditions are
// the same owner-loss boundary; `closing` makes the cleanup idempotent.
process.stdin.once("close", () => { void closeOwnedDockerLeases("OWNER_EOF"); });
process.stdin.once("error", () => { void closeOwnedDockerLeases("OWNER_EOF"); });
process.stdin.resume();
const readinessMarker = Buffer.from("READY\n");
if (writeSync(4, readinessMarker, 0, readinessMarker.length, 0) !== readinessMarker.length) {
  throw new Error("regression Docker watchdog readiness capability is truncated");
}
