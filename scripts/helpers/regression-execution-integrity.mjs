import { execFileSync as nodeExecFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

const trustedExecFileSync = nodeExecFileSync.bind(null);
const trustedJsonParse = JSON.parse.bind(JSON);
const trustedJsonStringify = JSON.stringify.bind(JSON);
const trustedObjectFreeze = Object.freeze.bind(Object);
const trustedObjectKeys = Object.keys.bind(Object);
const trustedArrayIsArray = Array.isArray.bind(Array);
const trustedArrayPop = Function.call.bind(Array.prototype.pop);
const trustedArrayPush = Function.call.bind(Array.prototype.push);
const trustedArraySort = Function.call.bind(Array.prototype.sort);
const trustedArrayJoin = Function.call.bind(Array.prototype.join);
const trustedBufferFrom = Buffer.from.bind(Buffer);
const trustedBufferToString = Function.call.bind(Buffer.prototype.toString);
const trustedPathIsAbsolute = path.isAbsolute.bind(path);
const trustedPathJoin = path.join.bind(path);
const trustedPathResolve = path.resolve.bind(path);
const trustedPathSeparator = path.sep;
const trustedRegExpExec = Function.call.bind(RegExp.prototype.exec);
const trustedRegExpTest = Function.call.bind(RegExp.prototype.test);
const trustedNumber = Number;
const trustedNumberIsInteger = Number.isInteger.bind(Number);
const trustedNumberIsSafeInteger = Number.isSafeInteger.bind(Number);
const trustedBigInt = BigInt;
const trustedString = String;
const trustedStringIncludes = Function.call.bind(String.prototype.includes);
const trustedStringIndexOf = Function.call.bind(String.prototype.indexOf);
const trustedStringSlice = Function.call.bind(String.prototype.slice);
const trustedStringSplit = Function.call.bind(String.prototype.split);
const trustedStringStartsWith = Function.call.bind(String.prototype.startsWith);
const trustedStringToLowerCase = Function.call.bind(String.prototype.toLowerCase);
const trustedStringTrim = Function.call.bind(String.prototype.trim);
const TrustedError = Error;
const TrustedSet = Set;
const trustedSetAdd = Function.call.bind(Set.prototype.add);
const trustedSetHas = Function.call.bind(Set.prototype.has);
const trustedStatsIsDirectory = Function.call.bind(lstatSync(import.meta.filename).isDirectory);
const trustedStatsIsFile = Function.call.bind(lstatSync(import.meta.filename).isFile);
const trustedStatsIsSymbolicLink = Function.call.bind(lstatSync(import.meta.filename).isSymbolicLink);
const trustedHashProbe = createHash("sha256");
const trustedHashUpdate = Function.call.bind(trustedHashProbe.update);
const trustedHashDigest = Function.call.bind(trustedHashProbe.digest);
const trustedUid = typeof process.getuid === "function" ? process.getuid() : null;
const maximumBaselineBytes = 8 * 1024 * 1024;
const maximumTrackedFiles = 20_000;
const maximumTrackedBytes = 512 * 1024 * 1024;
const gitExecutable = "/usr/bin/git";
const gitEnvironment = trustedObjectFreeze({
  HOME: "/var/empty",
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "0",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  PAGER: "cat"
});
const gitSafetyArguments = trustedObjectFreeze([
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.attributesFile=/dev/null",
  "-c", "core.excludesFile=/dev/null",
  "-c", "submodule.recurse=false"
]);

function sha256(value) {
  const hash = createHash("sha256");
  trustedHashUpdate(hash, value);
  return trustedHashDigest(hash, "hex");
}

function assert(condition, message) {
  if (!condition) throw new TrustedError(message);
}

function canonicalObjectKeys(value) {
  const keys = trustedObjectKeys(value);
  trustedArraySort(keys);
  return trustedArrayJoin(keys, ",");
}

function stableFileBytes(filePath, expected = null) {
  const beforePath = lstatSync(filePath, { bigint: true });
  assert(trustedStatsIsFile(beforePath)
    && !trustedStatsIsSymbolicLink(beforePath)
    && beforePath.nlink === 1n
    && (trustedUid === null || beforePath.uid === trustedBigInt(trustedUid)),
  `tracked execution file is not one owned regular inode: ${filePath}`);
  const descriptor = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    assert(trustedStatsIsFile(before)
      && before.dev === beforePath.dev
      && before.ino === beforePath.ino
      && before.nlink === 1n
      && before.size >= 0n
      && before.size <= trustedBigInt(maximumTrackedBytes),
    `tracked execution file changed before read: ${filePath}`);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(filePath, { bigint: true });
    assert(after.dev === before.dev
      && after.ino === before.ino
      && after.size === before.size
      && after.mtimeNs === before.mtimeNs
      && after.ctimeNs === before.ctimeNs
      && after.nlink === 1n
      && afterPath.dev === before.dev
      && afterPath.ino === before.ino
      && afterPath.size === before.size
      && afterPath.mtimeNs === before.mtimeNs
      && afterPath.ctimeNs === before.ctimeNs
      && trustedBigInt(bytes.length) === before.size,
    `tracked execution file changed while being read: ${filePath}`);
    const snapshot = {
      device: trustedString(before.dev),
      inode: trustedString(before.ino),
      mode: trustedNumber(before.mode & 0o777n),
      size: trustedNumber(before.size),
      sha256: sha256(bytes)
    };
    if (expected != null && trustedJsonStringify(snapshot) !== trustedJsonStringify(expected)) {
      throw new TrustedError(`tracked execution file drifted: ${filePath}`);
    }
    return snapshot;
  } finally {
    closeSync(descriptor);
  }
}

function gitOutput(rootDir, args, execFileSync) {
  return execFileSync(gitExecutable, [...gitSafetyArguments, "-C", rootDir, ...args], {
    encoding: null,
    env: gitEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: maximumBaselineBytes
  });
}

function assertSafeLocalGitConfiguration(rootDir, execFileSync) {
  const raw = execFileSync(gitExecutable, [
    ...gitSafetyArguments,
    "-C", rootDir,
    "config", "--local", "--no-includes", "--null", "--list"
  ], {
    encoding: null,
    env: gitEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: maximumBaselineBytes
  });
  assert(raw.length <= maximumBaselineBytes, "local Git configuration is oversized");
  const records = trustedStringSplit(trustedBufferToString(raw, "utf8"), "\0");
  if (records[records.length - 1] === "") trustedArrayPop(records);
  for (const record of records) {
    const separator = trustedStringIndexOf(record, "\n");
    const key = trustedStringToLowerCase(
      trustedStringTrim(separator < 0 ? record : trustedStringSlice(record, 0, separator))
    );
    const value = separator < 0 ? "" : trustedStringSlice(record, separator + 1);
    const executableSetting = trustedStringStartsWith(key, "include.")
      || trustedStringStartsWith(key, "includeif.")
      || key === "core.fsmonitor"
      || key === "core.hookspath"
      || key === "core.worktree"
      || key === "extensions.worktreeconfig"
      || trustedRegExpTest(/^filter\..+\.(?:clean|smudge|process|required)$/, key)
      || trustedRegExpTest(/^diff\..+\.(?:command|textconv)$/, key)
      || (trustedRegExpTest(/^submodule\..+\.update$/, key) && trustedStringStartsWith(value, "!"));
    assert(!executableSetting, `local Git configuration contains an executable setting: ${key}`);
  }
  return sha256(raw);
}

function trackedRoster(rootDir, execFileSync) {
  const raw = gitOutput(rootDir, ["ls-files", "--stage", "-z", "--"], execFileSync);
  assert(raw.length > 0 && raw.length <= maximumBaselineBytes,
    "tracked execution roster is empty or oversized");
  const records = trustedStringSplit(trustedBufferToString(raw, "utf8"), "\0");
  assert(records[records.length - 1] === "", "tracked execution roster is not NUL terminated");
  trustedArrayPop(records);
  assert(records.length > 0 && records.length <= maximumTrackedFiles,
    "tracked execution roster count is invalid");
  const entries = [];
  const paths = new TrustedSet();
  for (const record of records) {
    const match = trustedRegExpExec(/^(100644|100755) ([0-9a-f]{40,64}) 0\t(.+)$/, record);
    assert(match, "tracked execution roster contains a symlink, submodule, conflict, or invalid entry");
    const relativePath = match[3];
    assert(relativePath.length > 0
      && relativePath.length <= 4096
      && !trustedStringIncludes(relativePath, "\0")
      && !trustedPathIsAbsolute(relativePath),
    "tracked execution roster contains an unsafe path");
    const absolutePath = trustedPathResolve(rootDir, relativePath);
    assert(trustedStringStartsWith(absolutePath, `${rootDir}${trustedPathSeparator}`),
      "tracked execution roster escaped the workspace");
    assert(!trustedSetHas(paths, relativePath), "tracked execution roster is not unique");
    trustedSetAdd(paths, relativePath);
    trustedArrayPush(entries, { path: relativePath, gitMode: match[1], gitObject: match[2] });
  }
  return { rawSha256: sha256(raw), entries };
}

function validateBaselineShape(baseline, rootDir) {
  assert(baseline
    && typeof baseline === "object"
    && !trustedArrayIsArray(baseline)
    && canonicalObjectKeys(baseline) === "entries,head,rootDigest,rosterSha256,strictClean,totalBytes,version"
    && baseline.version === 1
    && trustedRegExpTest(/^[0-9a-f]{40}$/, trustedString(baseline.head || ""))
    && trustedRegExpTest(/^[0-9a-f]{64}$/, trustedString(baseline.rosterSha256 || ""))
    && trustedRegExpTest(/^[0-9a-f]{64}$/, trustedString(baseline.rootDigest || ""))
    && typeof baseline.strictClean === "boolean"
    && trustedNumberIsSafeInteger(baseline.totalBytes)
    && baseline.totalBytes >= 0
    && baseline.totalBytes <= maximumTrackedBytes
    && trustedArrayIsArray(baseline.entries)
    && baseline.entries.length > 0
    && baseline.entries.length <= maximumTrackedFiles,
  "tracked execution baseline shape is invalid");
  let totalBytes = 0;
  const seenPaths = new TrustedSet();
  for (const entry of baseline.entries) {
    assert(entry
      && typeof entry === "object"
      && !trustedArrayIsArray(entry)
      && canonicalObjectKeys(entry) === "device,gitMode,gitObject,inode,mode,path,sha256,size"
      && typeof entry.path === "string"
      && !trustedSetHas(seenPaths, entry.path)
      && !trustedPathIsAbsolute(entry.path)
      && trustedStringStartsWith(trustedPathResolve(rootDir, entry.path), `${rootDir}${trustedPathSeparator}`)
      && trustedRegExpTest(/^(100644|100755)$/, trustedString(entry.gitMode || ""))
      && trustedRegExpTest(/^[0-9a-f]{40,64}$/, trustedString(entry.gitObject || ""))
      && trustedRegExpTest(/^\d+$/, trustedString(entry.device || ""))
      && trustedRegExpTest(/^\d+$/, trustedString(entry.inode || ""))
      && trustedNumberIsInteger(entry.mode)
      && entry.mode >= 0
      && entry.mode <= 0o777
      && trustedNumberIsSafeInteger(entry.size)
      && entry.size >= 0
      && trustedRegExpTest(/^[0-9a-f]{64}$/, trustedString(entry.sha256 || "")),
    "tracked execution baseline entry is invalid");
    trustedSetAdd(seenPaths, entry.path);
    totalBytes += entry.size;
  }
  assert(totalBytes === baseline.totalBytes,
    "tracked execution baseline byte total is inconsistent");
  const rootDigest = sha256(trustedJsonStringify({
    head: baseline.head,
    rosterSha256: baseline.rosterSha256,
    entries: baseline.entries
  }));
  assert(rootDigest === baseline.rootDigest,
    "tracked execution baseline root digest is invalid");
  return baseline;
}

export function assertRegressionExecutionSourcesTrackedSync({ rootDir, baseline }) {
  rootDir = trustedPathResolve(trustedString(rootDir || ""));
  validateBaselineShape(baseline, rootDir);
  const trackedPaths = new TrustedSet();
  for (const entry of baseline.entries) trustedSetAdd(trackedPaths, entry.path);
  const scriptsRoot = trustedPathJoin(rootDir, "scripts");
  let scriptsMetadata;
  try {
    scriptsMetadata = lstatSync(scriptsRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  assert(trustedStatsIsDirectory(scriptsMetadata) && !trustedStatsIsSymbolicLink(scriptsMetadata),
    "regression scripts root is not one regular directory");
  const pending = [scriptsRoot];
  while (pending.length > 0) {
    const directory = trustedArrayPop(pending);
    for (const name of readdirSync(directory)) {
      const absolutePath = trustedPathJoin(directory, name);
      const metadata = lstatSync(absolutePath);
      assert(!trustedStatsIsSymbolicLink(metadata),
        `regression execution source tree contains a symlink: ${absolutePath}`);
      if (trustedStatsIsDirectory(metadata)) {
        trustedArrayPush(pending, absolutePath);
        continue;
      }
      if (!trustedStatsIsFile(metadata)
        || !trustedRegExpTest(/\.(?:cjs|js|mjs|sh)$/, name)) continue;
      const rootPrefix = `${rootDir}${trustedPathSeparator}`;
      assert(trustedStringStartsWith(absolutePath, rootPrefix),
        "regression execution source escaped the workspace");
      const relativePath = trustedStringSlice(absolutePath, rootPrefix.length);
      assert(trustedSetHas(trackedPaths, relativePath),
        `regression execution source is not tracked in the baseline: ${relativePath}`);
    }
  }
  return true;
}

export function captureRegressionExecutionBaselineSync({
  rootDir,
  strictClean = false,
  execFileSync = trustedExecFileSync
}) {
  rootDir = trustedPathResolve(trustedString(rootDir || ""));
  assert(trustedPathIsAbsolute(rootDir) && typeof execFileSync === "function",
    "tracked execution baseline arguments are invalid");
  const rootMetadata = lstatSync(rootDir);
  assert(trustedStatsIsDirectory(rootMetadata)
    && !trustedStatsIsSymbolicLink(rootMetadata)
    && (trustedUid === null || rootMetadata.uid === trustedUid),
  "tracked execution workspace is not one owned directory");
  const gitConfigurationDigest = assertSafeLocalGitConfiguration(rootDir, execFileSync);
  if (strictClean) {
    const status = gitOutput(rootDir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], execFileSync);
    assert(status.length === 0,
      "full regression requires one clean tracked and untracked Git workspace");
  }
  const head = trustedStringTrim(trustedBufferToString(
    gitOutput(rootDir, ["rev-parse", "--verify", "HEAD"], execFileSync),
    "utf8"
  ));
  assert(trustedRegExpTest(/^[0-9a-f]{40}$/, head), "tracked execution HEAD is invalid");
  const rosterBefore = trackedRoster(rootDir, execFileSync);
  let totalBytes = 0;
  const entries = [];
  for (const entry of rosterBefore.entries) {
    const file = stableFileBytes(trustedPathJoin(rootDir, entry.path));
    totalBytes += file.size;
    assert(totalBytes <= maximumTrackedBytes, "tracked execution baseline is oversized");
    trustedArrayPush(entries, { ...entry, ...file });
  }
  const rosterAfter = trackedRoster(rootDir, execFileSync);
  assert(rosterAfter.rawSha256 === rosterBefore.rawSha256,
    "tracked execution roster changed during baseline capture");
  assert(assertSafeLocalGitConfiguration(rootDir, execFileSync) === gitConfigurationDigest,
    "local Git configuration changed during baseline capture");
  const baseline = {
    version: 1,
    head,
    strictClean: strictClean === true,
    rosterSha256: rosterBefore.rawSha256,
    totalBytes,
    entries,
    rootDigest: sha256(trustedJsonStringify({
      head,
      rosterSha256: rosterBefore.rawSha256,
      entries
    }))
  };
  return trustedObjectFreeze(validateBaselineShape(baseline, rootDir));
}

export function assertRegressionExecutionBaselineSync({
  rootDir,
  baseline,
  execFileSync = trustedExecFileSync
}) {
  rootDir = trustedPathResolve(trustedString(rootDir || ""));
  validateBaselineShape(baseline, rootDir);
  assertRegressionExecutionSourcesTrackedSync({ rootDir, baseline });
  const gitConfigurationDigest = assertSafeLocalGitConfiguration(rootDir, execFileSync);
  const head = trustedStringTrim(trustedBufferToString(
    gitOutput(rootDir, ["rev-parse", "--verify", "HEAD"], execFileSync),
    "utf8"
  ));
  assert(head === baseline.head, "tracked execution HEAD changed during regression");
  const rosterBefore = trackedRoster(rootDir, execFileSync);
  assert(rosterBefore.rawSha256 === baseline.rosterSha256
    && rosterBefore.entries.length === baseline.entries.length,
  "tracked execution roster changed during regression");
  for (let index = 0; index < baseline.entries.length; index += 1) {
    const expected = baseline.entries[index];
    const rosterEntry = rosterBefore.entries[index];
    assert(rosterEntry.path === expected.path
      && rosterEntry.gitMode === expected.gitMode
      && rosterEntry.gitObject === expected.gitObject,
    "tracked execution index identity changed during regression");
    stableFileBytes(trustedPathJoin(rootDir, expected.path), {
      device: expected.device,
      inode: expected.inode,
      mode: expected.mode,
      size: expected.size,
      sha256: expected.sha256
    });
  }
  const rosterAfter = trackedRoster(rootDir, execFileSync);
  assert(rosterAfter.rawSha256 === baseline.rosterSha256,
    "tracked execution roster changed during verification");
  assert(assertSafeLocalGitConfiguration(rootDir, execFileSync) === gitConfigurationDigest,
    "local Git configuration changed during baseline verification");
  return baseline.rootDigest;
}

export function persistRegressionExecutionBaselineSync({ lockDir, baseline, runId, rootDir }) {
  assert(trustedPathIsAbsolute(lockDir)
    && trustedRegExpTest(/^[0-9a-f]{32}$/, trustedString(runId || "")),
  "tracked execution baseline persistence arguments are invalid");
  validateBaselineShape(baseline, trustedPathResolve(rootDir));
  const file = "execution-baseline.json";
  const target = trustedPathJoin(lockDir, file);
  const temporary = trustedPathJoin(lockDir, `.${file}.${process.pid}.${trustedBufferToString(randomBytes(8), "hex")}.tmp`);
  const payload = trustedBufferFrom(`${trustedJsonStringify({ version: 1, runId, baseline })}\n`);
  assert(payload.length <= maximumBaselineBytes, "tracked execution baseline payload is oversized");
  writeFileSync(temporary, payload, { mode: 0o600, flag: "wx" });
  const temporaryDescriptor = openSync(temporary, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { fsyncSync(temporaryDescriptor); } finally { closeSync(temporaryDescriptor); }
  renameSync(temporary, target);
  const directoryDescriptor = openSync(lockDir, fsConstants.O_RDONLY);
  try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
  const metadata = lstatSync(target);
  return trustedObjectFreeze({
    file,
    device: trustedString(metadata.dev),
    inode: trustedString(metadata.ino),
    size: metadata.size,
    sha256: sha256(payload),
    rootDigest: baseline.rootDigest,
    runId
  });
}

export function readPersistedRegressionExecutionBaselineSync({
  lockDir,
  reference,
  rootDir,
  expectedRunId = reference?.runId
}) {
  assert(trustedPathIsAbsolute(lockDir)
    && reference
    && canonicalObjectKeys(reference) === "device,file,inode,rootDigest,runId,sha256,size"
    && reference.file === "execution-baseline.json"
    && trustedRegExpTest(/^\d+$/, trustedString(reference.device || ""))
    && trustedRegExpTest(/^\d+$/, trustedString(reference.inode || ""))
    && trustedNumberIsSafeInteger(reference.size)
    && reference.size > 0
    && reference.size <= maximumBaselineBytes
    && trustedRegExpTest(/^[0-9a-f]{64}$/, trustedString(reference.sha256 || ""))
    && trustedRegExpTest(/^[0-9a-f]{64}$/, trustedString(reference.rootDigest || ""))
    && trustedRegExpTest(/^[0-9a-f]{32}$/, trustedString(reference.runId || ""))
    && reference.runId === expectedRunId,
  "tracked execution baseline reference is invalid");
  const target = trustedPathJoin(lockDir, reference.file);
  const descriptor = openSync(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    assert(trustedStatsIsFile(before)
      && !trustedStatsIsSymbolicLink(before)
      && before.nlink === 1
      && trustedString(before.dev) === reference.device
      && trustedString(before.ino) === reference.inode
      && before.size === reference.size
      && (before.mode & 0o077) === 0
      && (trustedUid === null || before.uid === trustedUid),
    "persisted tracked execution baseline is unsafe");
    const payload = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    assert(after.dev === before.dev
      && after.ino === before.ino
      && after.size === before.size
      && sha256(payload) === reference.sha256,
    "persisted tracked execution baseline changed while being read");
    const envelope = trustedJsonParse(trustedBufferToString(payload, "utf8"));
    assert(envelope
      && typeof envelope === "object"
      && !trustedArrayIsArray(envelope)
      && canonicalObjectKeys(envelope) === "baseline,runId,version"
      && envelope.version === 1
      && envelope.runId === reference.runId,
    "persisted tracked execution baseline ownership changed");
    const baseline = envelope.baseline;
    validateBaselineShape(baseline, trustedPathResolve(rootDir));
    assert(baseline.rootDigest === reference.rootDigest,
      "persisted tracked execution baseline digest changed");
    return baseline;
  } finally {
    closeSync(descriptor);
  }
}

export function createRegressionExecutionBaselineCapability({ secretDir, baseline, rootDir }) {
  assert(trustedPathIsAbsolute(secretDir), "tracked execution capability directory is invalid");
  validateBaselineShape(baseline, trustedPathResolve(rootDir));
  const temporary = trustedPathJoin(secretDir, `.execution-baseline.${process.pid}.${trustedBufferToString(randomBytes(8), "hex")}.tmp`);
  const payload = trustedBufferFrom(`${trustedJsonStringify({ version: 1, rootDir: trustedPathResolve(rootDir), baseline })}\n`);
  assert(payload.length <= maximumBaselineBytes, "tracked execution capability is oversized");
  let descriptor = -1;
  try {
    writeFileSync(temporary, payload, { mode: 0o600, flag: "wx" });
    descriptor = openSync(temporary, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    unlinkSync(temporary);
    const metadata = fstatSync(descriptor);
    assert(trustedStatsIsFile(metadata)
      && metadata.nlink === 0
      && metadata.size === payload.length
      && (metadata.mode & 0o077) === 0,
    "tracked execution capability is not one private unlinked file");
    return { descriptor };
  } catch (error) {
    if (descriptor >= 0) {
      try { closeSync(descriptor); } catch { /* preserve the capability error */ }
    }
    try { unlinkSync(temporary); } catch { /* it may already be unlinked */ }
    throw error;
  }
}

export function consumeRegressionExecutionBaselineCapabilitySync(descriptor, expectedRootDir) {
  assert(trustedNumberIsInteger(descriptor) && descriptor >= 3,
    "tracked execution capability descriptor is invalid");
  const metadata = fstatSync(descriptor);
  assert(trustedStatsIsFile(metadata)
    && metadata.nlink === 0
    && metadata.size > 0
    && metadata.size <= maximumBaselineBytes
    && (metadata.mode & 0o077) === 0,
  "tracked execution capability is not one private unlinked file");
  const payload = readFileSync(descriptor, "utf8");
  const after = fstatSync(descriptor);
  assert(after.dev === metadata.dev
    && after.ino === metadata.ino
    && after.size === metadata.size,
  "tracked execution capability changed while being read");
  const capability = trustedJsonParse(payload);
  const rootDir = trustedPathResolve(trustedString(capability?.rootDir || ""));
  assert(capability?.version === 1
    && canonicalObjectKeys(capability) === "baseline,rootDir,version"
    && rootDir === trustedPathResolve(expectedRootDir),
  "tracked execution capability ownership is invalid");
  validateBaselineShape(capability.baseline, rootDir);
  return capability.baseline;
}
