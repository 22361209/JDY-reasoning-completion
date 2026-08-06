import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync
} from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_SERIALIZED_BASELINE_ENTRIES = 20_000;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const PERSISTED_BASELINE_FILE = "artifact-baseline.json";
const PERSISTED_BACKUP_DIR = "artifact-baseline-backup";
const MAX_PERSISTED_BASELINE_BYTES = 32 * 1024 * 1024;
const ARTIFACT_BASELINE_VERSION = 2;
const artifactRootIdentityProperty = Symbol("regressionArtifactRootIdentity");
const safeUnlinkHelperPath = path.join(import.meta.dirname, "regression-safe-unlink.py");

function isMutableServiceLogArtifact(relative) {
  return relative === "logs" || relative.startsWith(`logs${path.sep}`);
}

export async function snapshotRegressionArtifacts(root) {
  const snapshot = new Map();
  const rootIdentity = captureArtifactDirectoryIdentitySync(root, "regression artifact root");
  attachArtifactRootIdentity(snapshot, rootIdentity);
  for (const entry of await recursiveEntries(root, rootIdentity)) {
    const relative = path.relative(root, entry.file);
    // dev-up owns these append-only service logs. They are neither suite
    // evidence nor private artifacts, so including them makes crash recovery
    // falsely treat a normal backend write as an unremovable baseline drift.
    if (isMutableServiceLogArtifact(relative)) continue;
    if (entry.kind === "directory") {
      snapshot.set(relative, { kind: "directory" });
      continue;
    }
    if (entry.kind !== "file") {
      throw new Error(`regression artifact baseline contains an unsafe non-regular entry: ${path.relative(root, entry.file)}`);
    }
    const file = entry.file;
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error(`regression artifact baseline contains a multiply-linked or unsafe file: ${path.relative(root, file)}`);
    }
    const payload = await readFile(file);
    snapshot.set(relative, {
      kind: "file",
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      sha256: createHash("sha256").update(payload).digest("hex")
    });
  }
  return snapshot;
}

export function serializeRegressionArtifactBaseline(baseline) {
  if (!(baseline instanceof Map)) {
    throw new Error("regression artifact baseline must be a Map");
  }
  if (baseline.size > MAX_SERIALIZED_BASELINE_ENTRIES) {
    throw new Error("regression artifact baseline exceeds the persisted-entry limit");
  }
  const rootIdentity = regressionArtifactRootIdentity(baseline);
  const entries = [...baseline.entries()]
    .map(([relative, metadata]) => {
      assertSafeBaselineRelativePath(relative);
      assertBaselineMetadata(metadata);
      return metadata.kind === "directory"
        ? { relative, kind: "directory" }
        : {
            relative,
            kind: "file",
            size: metadata.size,
            mtimeMs: metadata.mtimeMs,
            sha256: metadata.sha256
          };
    })
    .sort((left, right) => left.relative.localeCompare(right.relative));
  return {
    version: ARTIFACT_BASELINE_VERSION,
    root: rootIdentity,
    entries
  };
}

export function deserializeRegressionArtifactBaseline(serialized) {
  if (!serialized || typeof serialized !== "object" || Array.isArray(serialized)
    || Object.keys(serialized).sort().join(",") !== "entries,root,version"
    || serialized.version !== ARTIFACT_BASELINE_VERSION
    || !Array.isArray(serialized.entries)) {
    throw new Error("persisted regression artifact baseline envelope is invalid");
  }
  const rootIdentity = validateArtifactRootIdentity(serialized.root);
  if (serialized.entries.length > MAX_SERIALIZED_BASELINE_ENTRIES) {
    throw new Error("persisted regression artifact baseline exceeds the entry limit");
  }
  const baseline = new Map();
  attachArtifactRootIdentity(baseline, rootIdentity);
  for (const entry of serialized.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("persisted regression artifact baseline contains an invalid entry");
    }
    const keys = Object.keys(entry).sort();
    const expectedKeys = entry.kind === "directory"
      ? "kind,relative"
      : "kind,mtimeMs,relative,sha256,size";
    if (keys.join(",") !== expectedKeys) {
      throw new Error("persisted regression artifact baseline entry has an unexpected shape");
    }
    assertSafeBaselineRelativePath(entry.relative);
    assertBaselineMetadata(entry);
    if (baseline.has(entry.relative)) {
      throw new Error("persisted regression artifact baseline contains a duplicate path");
    }
    baseline.set(entry.relative, entry.kind === "directory"
      ? { kind: "directory" }
      : {
          kind: "file",
          size: entry.size,
          mtimeMs: entry.mtimeMs,
          sha256: entry.sha256
        });
  }
  return baseline;
}

export async function persistRegressionArtifactBaseline({ lockDir, serialized, runId }) {
  const baseline = deserializeRegressionArtifactBaseline(serialized);
  if (!/^[0-9a-f]{32}$/.test(String(runId || ""))) {
    throw new Error("regression artifact baseline requires the owning run id");
  }
  const payload = Buffer.from(JSON.stringify(serialized));
  if (payload.byteLength > MAX_PERSISTED_BASELINE_BYTES) {
    throw new Error("persisted regression artifact baseline exceeds the byte limit");
  }
  const targetPath = path.join(lockDir, PERSISTED_BASELINE_FILE);
  const temporaryPath = path.join(lockDir, `${PERSISTED_BASELINE_FILE}.${runId}.tmp`);
  await writeFile(temporaryPath, payload, { mode: 0o600, flag: "wx" });
  try {
    const temporaryHandle = await open(temporaryPath, "r");
    try {
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }
    await link(temporaryPath, targetPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  await unlink(temporaryPath);
  const directoryHandle = await open(lockDir, fsConstants.O_RDONLY);
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
  const metadata = await lstat(targetPath);
  assertPersistedBaselineMetadata(metadata, null);
  return {
    version: ARTIFACT_BASELINE_VERSION,
    file: PERSISTED_BASELINE_FILE,
    device: String(metadata.dev),
    inode: String(metadata.ino),
    sha256: createHash("sha256").update(payload).digest("hex"),
    entryCount: baseline.size
  };
}

// Persist bytes as well as metadata: a stale owner may have overwritten an
// ignored, pre-existing artifact and hash-only metadata cannot restore it.
export async function persistRegressionArtifactBaselineBackup({ root, lockDir, baseline }) {
  const rootIdentity = assertRegressionArtifactRootIdentitySync({ root, baseline });
  const backupDir = path.join(lockDir, PERSISTED_BACKUP_DIR);
  await mkdir(backupDir, { mode: 0o700 });
  for (const [relative, metadata] of baseline) {
    if (metadata.kind !== "file") continue;
    const source = path.join(root, relative);
    assertArtifactPathBoundarySync({ root, file: source, rootIdentity });
    const payload = await readFile(source);
    if (payload.length !== metadata.size || createHash("sha256").update(payload).digest("hex") !== metadata.sha256) {
      throw new Error("regression artifact changed before private baseline backup");
    }
    await writeFile(path.join(backupDir, Buffer.from(relative).toString("base64url")), payload, { mode: 0o600, flag: "wx" });
  }
  return { directory: PERSISTED_BACKUP_DIR };
}

export async function restoreRegressionArtifactBaselineBackup({ root, lockDir, baseline }) {
  const rootIdentity = assertRegressionArtifactRootIdentitySync({ root, baseline });
  const backupDir = path.join(lockDir, PERSISTED_BACKUP_DIR);
  for (const [relative, metadata] of baseline) {
    if (metadata.kind !== "file") continue;
    const payload = await readFile(path.join(backupDir, Buffer.from(relative).toString("base64url")));
    if (payload.length !== metadata.size || createHash("sha256").update(payload).digest("hex") !== metadata.sha256) {
      throw new Error("regression private artifact backup changed");
    }
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const targetMetadata = await lstat(target).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (targetMetadata && (!targetMetadata.isFile() || targetMetadata.isSymbolicLink() || targetMetadata.nlink !== 1)) {
      throw new Error("regression artifact restore target is unsafe");
    }
    const temporary = `${target}.restore-${process.pid}`;
    await writeFile(temporary, payload, { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
    assertArtifactPathBoundarySync({ root, file: target, rootIdentity });
  }
}

export async function readPersistedRegressionArtifactBaseline({ lockDir, reference }) {
  return readPersistedRegressionArtifactBaselineSync({ lockDir, reference });
}

export function readPersistedRegressionArtifactBaselineSync({ lockDir, reference }) {
  validatePersistedBaselineReference(reference);
  const baselinePath = path.join(lockDir, PERSISTED_BASELINE_FILE);
  const descriptor = openSync(baselinePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let payload;
  try {
    const before = fstatSync(descriptor);
    assertPersistedBaselineMetadata(before, reference);
    payload = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    assertPersistedBaselineMetadata(after, reference);
    if (before.size !== after.size || String(before.dev) !== String(after.dev) || String(before.ino) !== String(after.ino)) {
      throw new Error("persisted regression artifact baseline changed while being read");
    }
  } finally {
    closeSync(descriptor);
  }
  if (createHash("sha256").update(payload).digest("hex") !== reference.sha256) {
    throw new Error("persisted regression artifact baseline digest changed");
  }
  let serialized;
  try {
    serialized = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new Error("persisted regression artifact baseline is unreadable");
  }
  if (!serialized || typeof serialized !== "object" || Array.isArray(serialized)
    || !Array.isArray(serialized.entries)
    || serialized.entries.length !== reference.entryCount) {
    throw new Error("persisted regression artifact baseline entry count changed");
  }
  return deserializeRegressionArtifactBaseline(serialized);
}

function validatePersistedBaselineReference(reference) {
  const keys = reference && typeof reference === "object" && !Array.isArray(reference)
    ? Object.keys(reference).sort()
    : [];
  if (keys.join(",") !== "device,entryCount,file,inode,sha256,version"
    || reference.version !== ARTIFACT_BASELINE_VERSION
    || reference.file !== PERSISTED_BASELINE_FILE
    || !/^\d+$/.test(String(reference.device || ""))
    || !/^\d+$/.test(String(reference.inode || ""))
    || !SHA256_HEX_PATTERN.test(String(reference.sha256 || ""))
    || !Number.isSafeInteger(reference.entryCount)
    || reference.entryCount < 0
    || reference.entryCount > MAX_SERIALIZED_BASELINE_ENTRIES) {
    throw new Error("regression artifact baseline reference is invalid");
  }
}

function assertPersistedBaselineMetadata(metadata, reference) {
  if (!metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || (metadata.mode & 0o077) !== 0
    || metadata.size > MAX_PERSISTED_BASELINE_BYTES
    || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    || (reference && (String(metadata.dev) !== reference.device || String(metadata.ino) !== reference.inode))) {
    throw new Error("persisted regression artifact baseline is missing or unsafe");
  }
}

export async function scanChangedRegressionArtifactsForSecrets({
  root,
  workspaceRoot,
  baseline,
  password,
  exactSecrets = []
}) {
  const rootIdentity = assertRegressionArtifactRootIdentitySync({ root, baseline });
  const secretNeedles = unique([password, ...exactSecrets].flatMap(secretVariants)).map((value) => Buffer.from(value));
  const exposed = [];
  const classificationErrors = [];
  const changedFiles = await changedArtifactFiles(root, baseline);
  for (const { file, relative, kind } of changedFiles) {
    if (kind === "directory") continue;
    if (kind !== "file") {
      exposed.push(relative);
      continue;
    }
    try {
      if (await containsSecret(file, secretNeedles)) exposed.push(relative);
    } catch (error) {
      exposed.push(relative);
      classificationErrors.push({
        file: relative,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const remediatedFiles = [];
  const cleanupErrors = [];
  for (const relative of exposed.sort(deepestPathFirst)) {
    const file = path.join(root, relative);
    try {
      if (baseline?.has(relative)) {
        throw new Error("regression artifact cleanup refuses to delete a pre-existing baseline entry");
      }
      assertIgnoredVerificationArtifact({ root, workspaceRoot, file, rootIdentity, allowUnsafeEntry: true });
      await removeArtifactEntry({ root, file, rootIdentity });
      remediatedFiles.push(relative);
    } catch (error) {
      cleanupErrors.push({
        file: relative,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const residue = [];
  for (const { file, relative, kind } of await changedArtifactFiles(root, baseline)) {
    if (kind === "directory") continue;
    if (kind !== "file") {
      residue.push(relative);
      continue;
    }
    try {
      if (await containsSecret(file, secretNeedles)) residue.push(relative);
    } catch (error) {
      residue.push(relative);
      classificationErrors.push({
        file: relative,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return {
    ok: exposed.length === 0 && cleanupErrors.length === 0 && classificationErrors.length === 0,
    residueFree: residue.length === 0,
    scannedChangedFiles: changedFiles.length,
    exposedFiles: exposed,
    remediatedFiles,
    classificationErrors,
    cleanupErrors,
    residueFiles: residue.sort()
  };
}

export function regressionArtifactPayloadContainsSecret(payload, { password, exactSecrets = [] } = {}) {
  const content = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ""));
  const needles = unique([password, ...exactSecrets].flatMap(secretVariants)).map((value) => Buffer.from(value));
  if (needles.some((needle) => needle.length > 0 && content.includes(needle))) return true;
  const text = content.toString("utf8");
  return /(?:^|[\s"'])SESSION=[A-Za-z0-9%+/_=-]{16,}/m.test(text)
    || /[A-Za-z0-9:_-]+:sessions:(?:expires:)?[A-Za-z0-9%+/_=-]{16,}/i.test(text)
    || /[A-Za-z0-9:_-]+:expirations:\d{6,}/i.test(text)
    || /(?:sessionCookie|sessionToken|activeSessionToken|scopeToken)["']?\s*[:=]\s*["']?[A-Za-z0-9%+/_=-]{16,}/i.test(text)
    || /(?:Set-Cookie|Cookie)\s*:\s*[^\r\n]*SESSION=[A-Za-z0-9%+/_=-]{16,}/i.test(text);
}

export async function purgeChangedRegressionArtifacts({ root, workspaceRoot, baseline }) {
  const rootIdentity = assertRegressionArtifactRootIdentitySync({ root, baseline });
  const changed = await changedArtifactFiles(root, baseline);
  const purged = [];
  const cleanupErrors = [];
  for (const { file, relative } of changed) {
    try {
      if (baseline?.has(relative)) {
        throw new Error("regression artifact cleanup refuses to delete a pre-existing baseline entry");
      }
      assertIgnoredVerificationArtifact({ root, workspaceRoot, file, rootIdentity, allowUnsafeEntry: true });
      await removeArtifactEntry({ root, file, rootIdentity });
      purged.push(relative);
    } catch (error) {
      cleanupErrors.push({
        file: relative,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const residueFiles = (await changedArtifactFiles(root, baseline))
    .map(({ relative }) => relative)
    .sort();
  return {
    purgedFiles: purged.sort(),
    cleanupErrors,
    residueFree: residueFiles.length === 0,
    residueFiles
  };
}

async function changedArtifactFiles(root, baseline) {
  const rootIdentity = assertRegressionArtifactRootIdentitySync({ root, baseline });
  const changed = [];
  const seenPaths = new Set();
  for (const entry of await recursiveEntries(root, rootIdentity)) {
    const { file, kind } = entry;
    const relative = path.relative(root, file);
    if (isMutableServiceLogArtifact(relative)) continue;
    seenPaths.add(relative);
    const before = baseline?.get(relative);
    if (kind === "directory") {
      if (before?.kind === "directory") continue;
      changed.push({ file, relative, kind });
      continue;
    }
    if (kind !== "file") {
      changed.push({ file, relative, kind });
      continue;
    }
    try {
      const metadata = await lstat(file);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        changed.push({ file, relative, kind: "unsafe" });
        continue;
      }
      if (metadata.nlink !== 1) {
        changed.push({ file, relative, kind: "hardlink" });
        continue;
      }
      if (before?.kind === "file" && before.size === metadata.size) {
        const digest = createHash("sha256").update(await readFile(file)).digest("hex");
        if (digest === before.sha256) continue;
      }
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      changed.push({ file, relative, kind: "unreadable" });
      continue;
    }
    changed.push({ file, relative, kind });
  }
  if (baseline instanceof Map) {
    for (const relative of baseline.keys()) {
      if (isMutableServiceLogArtifact(relative)) continue;
      if (seenPaths.has(relative)) continue;
      changed.push({ file: path.join(root, relative), relative, kind: "missing" });
    }
  }
  assertRegressionArtifactRootIdentitySync({ root, baseline });
  return changed;
}

export function assertRegressionArtifactRootIdentitySync({ root, baseline }) {
  const expected = regressionArtifactRootIdentity(baseline);
  const actual = captureArtifactDirectoryIdentitySync(root, "regression artifact root");
  if (actual.device !== expected.device
    || actual.inode !== expected.inode
    || actual.uid !== expected.uid) {
    throw new Error("regression artifact root identity changed after baseline capture");
  }
  return expected;
}

function regressionArtifactRootIdentity(baseline) {
  if (!(baseline instanceof Map)) {
    throw new Error("regression artifact baseline must be a Map");
  }
  return validateArtifactRootIdentity(baseline[artifactRootIdentityProperty]);
}

function attachArtifactRootIdentity(baseline, identity) {
  Object.defineProperty(baseline, artifactRootIdentityProperty, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({ ...validateArtifactRootIdentity(identity) })
  });
}

function validateArtifactRootIdentity(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)
    || Object.keys(identity).sort().join(",") !== "device,inode,uid"
    || !/^\d+$/.test(String(identity.device || ""))
    || !/^\d+$/.test(String(identity.inode || ""))
    || !/^\d+$/.test(String(identity.uid ?? ""))) {
    throw new Error("regression artifact baseline root identity is invalid");
  }
  return {
    device: String(identity.device),
    inode: String(identity.inode),
    uid: String(identity.uid)
  };
}

function captureArtifactDirectoryIdentitySync(directory, label) {
  let metadata;
  try {
    metadata = lstatSync(path.resolve(directory));
  } catch {
    throw new Error(`${label} is unavailable`);
  }
  if (!metadata.isDirectory()
    || metadata.isSymbolicLink()
    || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    throw new Error(`${label} is not one owned regular directory`);
  }
  return {
    device: String(metadata.dev),
    inode: String(metadata.ino),
    uid: String(metadata.uid)
  };
}

function assertSafeBaselineRelativePath(relative) {
  if (typeof relative !== "string"
    || !relative
    || relative.includes("\0")
    || path.isAbsolute(relative)
    || path.normalize(relative) !== relative
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)) {
    throw new Error("regression artifact baseline contains an unsafe relative path");
  }
}

function assertBaselineMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
    || !["file", "directory"].includes(metadata.kind)) {
    throw new Error("regression artifact baseline contains invalid file metadata");
  }
  if (metadata.kind === "directory") return;
  if (!Number.isSafeInteger(metadata.size) || metadata.size < 0
    || !Number.isFinite(metadata.mtimeMs) || metadata.mtimeMs < 0
    || typeof metadata.sha256 !== "string" || !SHA256_HEX_PATTERN.test(metadata.sha256)) {
    throw new Error("regression artifact baseline contains invalid file metadata");
  }
}

async function removeArtifactEntry({ root, file, rootIdentity }) {
  const capability = captureArtifactDeletionCapability({ root, file, rootIdentity });
  const rootDescriptor = openSync(
    path.resolve(root),
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW
  );
  try {
    const rootMetadata = fstatSync(rootDescriptor);
    if (Number(rootMetadata.dev) !== capability.root.device
      || Number(rootMetadata.ino) !== capability.root.inode
      || Number(rootMetadata.uid) !== capability.root.uid) {
      throw new Error("regression artifact root changed before fd-relative cleanup");
    }
    execFileSync("/usr/bin/python3", ["-I", "-S", safeUnlinkHelperPath, JSON.stringify(capability)], {
      stdio: ["ignore", "ignore", "pipe", rootDescriptor],
      encoding: "utf8"
    });
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim();
    throw new Error(`regression artifact fd-relative cleanup failed${detail ? `: ${detail}` : ""}`);
  } finally {
    closeSync(rootDescriptor);
  }
  assertArtifactRootIdentityValueSync(root, rootIdentity);
}

function captureArtifactDeletionCapability({ root, file, rootIdentity }) {
  assertArtifactPathBoundarySync({ root, file, rootIdentity });
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, path.resolve(file));
  assertSafeBaselineRelativePath(relative);
  const segments = relative.split(path.sep);
  const expectedRoot = validateArtifactRootIdentity(rootIdentity);
  const ancestors = [];
  let ancestorPath = resolvedRoot;
  for (const name of segments.slice(0, -1)) {
    ancestorPath = path.join(ancestorPath, name);
    const metadata = lstatSync(ancestorPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("regression artifact cleanup ancestor is unsafe");
    }
    ancestors.push({
      name,
      device: Number(metadata.dev),
      inode: Number(metadata.ino),
      uid: Number(metadata.uid)
    });
  }
  const metadata = lstatSync(path.resolve(file));
  const kind = metadata.isDirectory() && !metadata.isSymbolicLink()
    ? "directory"
    : metadata.isFile() && !metadata.isSymbolicLink()
      ? "file"
      : metadata.isSymbolicLink()
        ? "symlink"
        : "other";
  if (kind === "file" && metadata.nlink !== 1) {
    throw new Error("regression artifact cleanup refuses a multiply-linked file");
  }
  return {
    root: {
      device: Number(expectedRoot.device),
      inode: Number(expectedRoot.inode),
      uid: Number(expectedRoot.uid)
    },
    ancestors,
    leaf: {
      name: segments.at(-1),
      device: Number(metadata.dev),
      inode: Number(metadata.ino),
      uid: Number(metadata.uid),
      nlink: Number(metadata.nlink),
      kind
    }
  };
}

function deepestPathFirst(left, right) {
  const depth = (value) => value.split(path.sep).length;
  return depth(right) - depth(left) || left.localeCompare(right);
}

async function containsSecret(file, secretNeedles) {
  const payload = await readFile(file);
  if (secretNeedles.some((needle) => needle.length > 0 && payload.includes(needle))) return true;
  return regressionArtifactPayloadContainsSecret(payload);
}

async function recursiveEntries(root, expectedIdentity) {
  assertArtifactRootIdentityValueSync(root, expectedIdentity);
  const files = [];
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    throw error;
  }
  assertArtifactRootIdentityValueSync(root, expectedIdentity);
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    let metadata;
    try {
      metadata = await lstat(target);
    } catch (error) {
      files.push({ file: target, kind: "unreadable", error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (metadata.isSymbolicLink()) files.push({ file: target, kind: "symlink" });
    else if (metadata.isDirectory()) {
      try {
        const childIdentity = {
          device: String(metadata.dev),
          inode: String(metadata.ino),
          uid: String(metadata.uid)
        };
        files.push(...await recursiveEntries(target, childIdentity));
        files.push({ file: target, kind: "directory" });
      } catch (error) {
        files.push({
          file: target,
          kind: "unreadable-directory",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    else if (metadata.isFile()) files.push({ file: target, kind: "file" });
    else files.push({ file: target, kind: "nonregular" });
  }
  assertArtifactRootIdentityValueSync(root, expectedIdentity);
  return files;
}

function assertIgnoredVerificationArtifact({ root, workspaceRoot, file, rootIdentity, allowUnsafeEntry = false }) {
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(file);
  if (resolvedFile === resolvedRoot || !resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("regression artifact cleanup escaped the verification directory");
  }
  assertArtifactPathBoundarySync({ root: resolvedRoot, file: resolvedFile, rootIdentity });
  let metadata;
  try {
    metadata = lstatSync(resolvedFile);
  } catch {
    throw new Error("regression artifact cleanup target is unavailable");
  }
  if (!allowUnsafeEntry && (!metadata.isFile() || metadata.isSymbolicLink())) {
    throw new Error("regression artifact cleanup target is not a regular file");
  }
  try {
    execFileSync("git", ["check-ignore", "-q", "--", path.relative(workspaceRoot, resolvedFile)], {
      cwd: workspaceRoot,
      stdio: "ignore"
    });
  } catch {
    throw new Error("regression artifact cleanup refuses a tracked or non-ignored file");
  }
}

function assertArtifactPathBoundarySync({ root, file, rootIdentity }) {
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(file);
  if (resolvedFile === resolvedRoot || !resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("regression artifact cleanup escaped the verification directory");
  }
  assertArtifactRootIdentityValueSync(resolvedRoot, rootIdentity);
  const relative = path.relative(resolvedRoot, resolvedFile);
  const segments = relative.split(path.sep);
  let ancestor = resolvedRoot;
  for (const segment of segments.slice(0, -1)) {
    ancestor = path.join(ancestor, segment);
    let metadata;
    try {
      metadata = lstatSync(ancestor);
    } catch {
      throw new Error("regression artifact cleanup ancestor is unavailable");
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("regression artifact cleanup ancestor is unsafe");
    }
  }
  assertArtifactRootIdentityValueSync(resolvedRoot, rootIdentity);
}

function assertArtifactRootIdentityValueSync(root, expectedIdentity) {
  const expected = validateArtifactRootIdentity(expectedIdentity);
  const actual = captureArtifactDirectoryIdentitySync(root, "regression artifact directory");
  if (actual.device !== expected.device
    || actual.inode !== expected.inode
    || actual.uid !== expected.uid) {
    throw new Error("regression artifact directory identity changed during access");
  }
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

function unique(values) {
  return [...new Set(values)];
}
