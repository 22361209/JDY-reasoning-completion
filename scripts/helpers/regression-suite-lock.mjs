import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmdirSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";

const CLAIM_NAME_PATTERN = /^recovery\.claim\.(\d{6})$/;
const MAX_RECOVERY_EPOCH = 999_999;
const OWNER_CAS_LOCK_NAME = "owner.update.lock";
const OWNER_CAS_LOCK_ATTEMPTS = 1_000;
const MAX_RECOVERY_FIXTURE_TARGETS = 1_024;
const FIXTURE_USERNAME_PATTERN = /^r_[a-z0-9_]{1,58}_[0-9a-f]{12,32}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PRE_IDENTITY_STATES = new Set([
  "creating",
  "baseline-ready",
  "preflight",
  "release-ready"
]);

export function regressionSuiteOwnerIsPreIdentity(owner) {
  return PRE_IDENTITY_STATES.has(String(owner?.state || ""))
    && !String(owner?.userId || "")
    && Number(owner?.requestFenceGeneration) === -1;
}

export function regressionSuiteOwnerIdentity(owner) {
  return {
    runId: String(owner?.runId || ""),
    pid: Number(owner?.pid),
    parentProcessFingerprint: String(owner?.parentProcessFingerprint || ""),
    acquiredAt: String(owner?.acquiredAt || ""),
    ownerRevision: Number(owner?.ownerRevision)
  };
}

export function assertRegressionSuiteOwnerMatches(actual, expected, { includeRevision = true } = {}) {
  const actualIdentity = regressionSuiteOwnerIdentity(actual);
  const expectedIdentity = regressionSuiteOwnerIdentity(expected);
  if (!/^[0-9a-f]{32}$/.test(actualIdentity.runId)
    || !Number.isInteger(actualIdentity.pid) || actualIdentity.pid <= 0
    || !/^[0-9a-f]{64}$/.test(actualIdentity.parentProcessFingerprint)
    || !actualIdentity.acquiredAt
    || (includeRevision && (!Number.isSafeInteger(actualIdentity.ownerRevision)
      || actualIdentity.ownerRevision < 0))
    || JSON.stringify(
      includeRevision ? actualIdentity : { ...actualIdentity, ownerRevision: 0 }
    ) !== JSON.stringify(
      includeRevision ? expectedIdentity : { ...expectedIdentity, ownerRevision: 0 }
    )) {
    throw new Error("regression suite lock ownership ledger changed");
  }
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])]));
  }
  return value;
}

export function assertRegressionSuiteOwnerSnapshotMatches(actual, expected) {
  assertRegressionSuiteOwnerMatches(actual, expected);
  if (JSON.stringify(canonicalJsonValue(actual)) !== JSON.stringify(canonicalJsonValue(expected))) {
    throw new Error("regression suite lock owner snapshot changed");
  }
}

export async function readRegressionSuiteOwner(ownerPath) {
  let owner;
  try {
    owner = JSON.parse(await readFile(ownerPath, "utf8"));
  } catch {
    throw new Error("regression suite lock exists without a readable recovery ledger");
  }
  return owner;
}

export async function writeRegressionSuiteOwnerFile(ownerPath, owner) {
  const temporaryPath = `${ownerPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(owner), { mode: 0o600, flag: "wx" });
  await rename(temporaryPath, ownerPath);
}

export async function writeRegressionSuiteOwnerCas({ ownerPath, expectedOwner, nextOwner }) {
  const release = await acquireOwnerCasLock(ownerPath);
  try {
    const persisted = await readRegressionSuiteOwner(ownerPath);
    assertRegressionSuiteOwnerSnapshotMatches(persisted, expectedOwner);
    assertRegressionSuiteOwnerMatches(nextOwner, expectedOwner, { includeRevision: false });
    if (Number(nextOwner?.ownerRevision) !== Number(expectedOwner?.ownerRevision) + 1) {
      throw new Error("regression suite lock owner revision must advance exactly once");
    }
    await writeRegressionSuiteOwnerFile(ownerPath, nextOwner);
  } finally {
    await release();
  }
}

export function relocateRegressionSuiteLockForReleaseSync({
  lockDir,
  expectedOwner,
  validateOwner = () => {},
  publishLatestSync = () => {},
  rollbackPublishedLatestSync = () => {}
}) {
  if (!path.isAbsolute(lockDir)
    || typeof validateOwner !== "function"
    || typeof publishLatestSync !== "function"
    || typeof rollbackPublishedLatestSync !== "function") {
    throw new Error("regression suite atomic release arguments are invalid");
  }
  const ownerCasLockPath = path.join(lockDir, OWNER_CAS_LOCK_NAME);
  try {
    mkdirSync(ownerCasLockPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("regression suite lock owner CAS lock is active at atomic release");
    }
    throw error;
  }
  let relocated = false;
  const releasedLockDir = `${lockDir}.released-${expectedOwner.runId}-${randomUUID()}`;
  try {
    let persisted;
    try {
      persisted = JSON.parse(readFileSync(path.join(lockDir, "owner.json"), "utf8"));
      assertRegressionSuiteOwnerSnapshotMatches(persisted, expectedOwner);
    } catch {
      throw new Error("regression suite lock ownership changed before atomic release");
    }
    validateOwner(persisted);
    publishLatestSync(persisted);
    try {
      renameSync(lockDir, releasedLockDir);
    } catch (error) {
      try {
        rollbackPublishedLatestSync(persisted);
      } catch (rollbackError) {
        error.addSuppressed?.(rollbackError);
      }
      throw error;
    }
    relocated = true;
    return releasedLockDir;
  } finally {
    if (!relocated) rmdirSync(ownerCasLockPath);
  }
}

async function acquireOwnerCasLock(ownerPath) {
  const lockPath = path.join(path.dirname(ownerPath), OWNER_CAS_LOCK_NAME);
  for (let attempt = 0; attempt < OWNER_CAS_LOCK_ATTEMPTS; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await rmdir(lockPath);
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const metadata = await lstat(lockPath).catch(() => null);
      if (!metadata
        || !metadata.isDirectory()
        || metadata.isSymbolicLink()
        || (metadata.mode & 0o077) !== 0
        || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
        throw new Error("regression suite owner CAS lock is unsafe");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error("regression suite owner CAS lock did not quiesce");
}

export async function acquireRegressionSuiteRecoveryClaim({
  lockDir,
  staleOwner,
  fixtureTargets = [],
  claimantPid,
  claimantFingerprint,
  processIsAlive,
  processIdentityFingerprint
}) {
  assertRegressionSuiteOwnerMatches(staleOwner, staleOwner);
  if (!Number.isInteger(claimantPid) || claimantPid <= 0
    || !/^[0-9a-f]{64}$/.test(claimantFingerprint)) {
    throw new Error("regression suite recovery claimant identity is invalid");
  }
  const normalizedFixtureTargets = normalizeRecoveryFixtureTargets(fixtureTargets);
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const ownerBeforeClaim = await readRegressionSuiteOwner(path.join(lockDir, "owner.json"));
    assertRegressionSuiteOwnerSnapshotMatches(ownerBeforeClaim, staleOwner);
    const latest = await readLatestRecoveryClaim(lockDir);
    if (latest) {
      try {
        assertRegressionSuiteOwnerSnapshotMatches(latest.staleOwner, staleOwner);
      } catch {
        await quarantineForeignRecoveryClaim(lockDir, latest);
        continue;
      }
      const alive = processIsAlive(latest.pid);
      if (alive) {
        let fingerprint;
        try {
          fingerprint = processIdentityFingerprint(latest.pid);
        } catch {
          throw new Error("regression suite recovery claimant is live but cannot be fingerprinted");
        }
        if (fingerprint === latest.parentProcessFingerprint) {
          const error = new Error(`another stale regression recovery is active with pid ${latest.pid}`);
          error.code = "REGRESSION_RECOVERY_ACTIVE";
          throw error;
        }
      }
    }
    const epoch = (latest?.epoch || 0) + 1;
    if (epoch > MAX_RECOVERY_EPOCH) {
      throw new Error("regression suite recovery claim epoch limit was exceeded");
    }
    const claim = {
      epoch,
      token: randomUUID().replaceAll("-", ""),
      pid: claimantPid,
      parentProcessFingerprint: claimantFingerprint,
      staleOwner: structuredClone(staleOwner),
      fixtureTargets: normalizedFixtureTargets,
      acquiredAt: new Date().toISOString()
    };
    const provisionalDir = await mkdtemp(path.join(lockDir, "recovery.provisional-"));
    const claimPath = path.join(lockDir, recoveryClaimName(epoch));
    try {
      await chmod(provisionalDir, 0o700);
      await writeFile(path.join(provisionalDir, "claim.json"), JSON.stringify(claim), {
        mode: 0o600,
        flag: "wx"
      });
      await rename(provisionalDir, claimPath);
    } catch (error) {
      await rm(provisionalDir, { recursive: true, force: true });
      if (["EEXIST", "ENOTEMPTY"].includes(error?.code)) continue;
      throw error;
    }
    try {
      const persisted = await readRegressionSuiteOwner(path.join(lockDir, "owner.json"));
      assertRegressionSuiteOwnerSnapshotMatches(persisted, staleOwner);
      const confirmed = await readLatestRecoveryClaim(lockDir);
      assertRecoveryClaimMatches(confirmed, claim);
    } catch (error) {
      await withdrawRecoveryClaimIfOwned(lockDir, claim);
      throw error;
    }
    return claim;
  }
  throw new Error("could not acquire the stale regression recovery claim");
}

async function quarantineForeignRecoveryClaim(lockDir, claim) {
  const claimPath = path.join(lockDir, recoveryClaimName(claim.epoch));
  const quarantinePath = path.join(lockDir, `recovery.foreign.${claim.token}`);
  try {
    await rename(claimPath, quarantinePath);
  } catch (error) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error?.code)) return;
    throw error;
  }
}

async function withdrawRecoveryClaimIfOwned(lockDir, claim) {
  let latest;
  try {
    latest = await readLatestRecoveryClaim(lockDir);
    assertRecoveryClaimMatches(latest, claim);
  } catch {
    return;
  }
  const claimPath = path.join(lockDir, recoveryClaimName(claim.epoch));
  const withdrawnPath = path.join(lockDir, `recovery.withdrawn.${claim.token}`);
  try {
    await rename(claimPath, withdrawnPath);
    await rm(withdrawnPath, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function relocateRecoveredRegressionSuiteLock({ lockDir, staleOwner, claim }) {
  const persisted = await readRegressionSuiteOwner(path.join(lockDir, "owner.json"));
  assertRegressionSuiteOwnerSnapshotMatches(persisted, staleOwner);
  const latest = await readLatestRecoveryClaim(lockDir);
  assertRecoveryClaimMatches(latest, claim);
  const recoveredDir = `${lockDir}.recovered-${staleOwner.runId}-${claim.token}`;
  await rename(lockDir, recoveredDir);
  return recoveredDir;
}

async function readLatestRecoveryClaim(lockDir) {
  const entries = await readdir(lockDir, { withFileTypes: true });
  const claims = [];
  for (const entry of entries) {
    if (!entry.name.startsWith("recovery.claim.")) continue;
    const match = entry.name.match(CLAIM_NAME_PATTERN);
    if (!match || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("regression suite lock contains an unsafe recovery claim");
    }
    claims.push({ name: entry.name, epoch: Number(match[1]) });
  }
  claims.sort((left, right) => right.epoch - left.epoch);
  if (claims.length === 0) return null;
  const selected = claims[0];
  const claimDir = path.join(lockDir, selected.name);
  const [directoryMetadata, claimMetadata] = await Promise.all([
    lstat(claimDir),
    lstat(path.join(claimDir, "claim.json"))
  ]).catch(() => {
    throw new Error("regression suite recovery claim is incomplete");
  });
  const unexpectedOwner = typeof process.getuid === "function"
    && (directoryMetadata.uid !== process.getuid() || claimMetadata.uid !== process.getuid());
  if (!directoryMetadata.isDirectory()
    || directoryMetadata.isSymbolicLink()
    || !claimMetadata.isFile()
    || claimMetadata.isSymbolicLink()
    || unexpectedOwner
    || (directoryMetadata.mode & 0o077) !== 0
    || (claimMetadata.mode & 0o077) !== 0) {
    throw new Error("regression suite recovery claim is not private owned metadata");
  }
  let claim;
  try {
    claim = JSON.parse(await readFile(path.join(claimDir, "claim.json"), "utf8"));
  } catch {
    throw new Error("regression suite recovery claim is unreadable");
  }
  validateRecoveryClaim(claim, selected.epoch);
  return claim;
}

function validateRecoveryClaim(claim, epoch) {
  if (!claim || typeof claim !== "object" || Array.isArray(claim)
    || Object.keys(claim).sort().join(",") !== "acquiredAt,epoch,fixtureTargets,parentProcessFingerprint,pid,staleOwner,token"
    || Number(claim.epoch) !== epoch
    || !Number.isInteger(Number(claim.pid)) || Number(claim.pid) <= 0
    || !/^[0-9a-f]{64}$/.test(String(claim.parentProcessFingerprint || ""))
    || !/^[0-9a-f]{32}$/.test(String(claim.token || ""))
    || !claim.acquiredAt) {
    throw new Error("regression suite recovery claim has invalid identity metadata");
  }
  assertRegressionSuiteOwnerMatches(claim.staleOwner, claim.staleOwner);
  const normalizedFixtureTargets = normalizeRecoveryFixtureTargets(claim.fixtureTargets);
  if (JSON.stringify(normalizedFixtureTargets) !== JSON.stringify(claim.fixtureTargets)) {
    throw new Error("regression suite recovery claim fixture targets are not canonical");
  }
}

function normalizeRecoveryFixtureTargets(targets) {
  if (!Array.isArray(targets) || targets.length > MAX_RECOVERY_FIXTURE_TARGETS) {
    throw new Error("regression suite recovery fixture target count is invalid");
  }
  const normalized = targets.map((target) => {
    if (!target || typeof target !== "object" || Array.isArray(target)
      || Object.keys(target).sort().join(",") !== "generation,userId,username") {
      throw new Error("regression suite recovery fixture target shape is invalid");
    }
    const userId = String(target.userId || "");
    const username = String(target.username || "");
    const generation = Number(target.generation);
    if (!UUID_PATTERN.test(userId)
      || !FIXTURE_USERNAME_PATTERN.test(username)
      || !Number.isSafeInteger(generation)
      || generation < 0) {
      throw new Error("regression suite recovery fixture target identity is invalid");
    }
    return { userId, username, generation };
  }).sort((left, right) => left.username.localeCompare(right.username)
    || left.userId.localeCompare(right.userId)
    || left.generation - right.generation);
  const keys = normalized.map(({ userId, username, generation }) => `${username}\0${userId}\0${generation}`);
  if (new Set(keys).size !== keys.length) {
    throw new Error("regression suite recovery fixture targets contain duplicates");
  }
  return normalized;
}

function assertRecoveryClaimMatches(actual, expected) {
  if (!actual
    || Number(actual.epoch) !== Number(expected.epoch)
    || actual.token !== expected.token
    || Number(actual.pid) !== Number(expected.pid)
    || actual.parentProcessFingerprint !== expected.parentProcessFingerprint
    || JSON.stringify(canonicalJsonValue(actual.staleOwner))
      !== JSON.stringify(canonicalJsonValue(expected.staleOwner))) {
    throw new Error("regression suite recovery claim ownership changed");
  }
}

function recoveryClaimName(epoch) {
  return `recovery.claim.${String(epoch).padStart(6, "0")}`;
}
