import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync
} from "node:fs";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify
} from "node:crypto";
import path from "node:path";

// This module is deliberately preloaded by the trusted child bootstrap before
// the manifest guard replaces public filesystem mutators. These captured
// primordials are only reachable through a branded writer whose Ed25519 private
// key is consumed from the unlinked runtime credential capability.
const trustedCloseSync = closeSync;
const trustedFstatSync = fstatSync;
const trustedFsyncSync = fsyncSync;
const trustedLstatSync = lstatSync;
const trustedOpenSync = openSync;
const trustedReadFileSync = readFileSync;
const trustedRenameSync = renameSync;
const trustedUnlinkSync = unlinkSync;
const trustedWriteSync = writeSync;
const trustedJsonParse = JSON.parse.bind(JSON);
const trustedJsonStringify = JSON.stringify.bind(JSON);
const trustedObjectEntries = Object.entries.bind(Object);
const trustedObjectFromEntries = Object.fromEntries.bind(Object);
const trustedObjectFreeze = Object.freeze.bind(Object);
const trustedObjectKeys = Object.keys.bind(Object);
const trustedArrayIsArray = Array.isArray.bind(Array);
const trustedArrayMap = Function.call.bind(Array.prototype.map);
const trustedArraySort = Function.call.bind(Array.prototype.sort);
const trustedString = String;
const trustedWeakMapGet = Function.call.bind(WeakMap.prototype.get);
const trustedWeakMapSet = Function.call.bind(WeakMap.prototype.set);
const trustedUid = typeof process.getuid === "function" ? process.getuid() : null;
const writerState = new WeakMap();
let privilegedPathApiSealed = false;
const ledgerVersion = 2;
const maximumLedgerBytes = 512 * 1024;
const maximumRegistrations = 64;
const referenceKeys = "device,file,inode,runId,signingPublicKey";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertPrivilegedPathApiAvailable() {
  assert(!privilegedPathApiSealed,
    "regression fixture ledger privileged path API is sealed");
}

export function sealRegressionFixtureLedgerPrivilegedPathApi() {
  privilegedPathApiSealed = true;
}

function canonicalKeys(value) {
  const keys = trustedObjectKeys(value);
  trustedArraySort(keys);
  return keys.join(",");
}

function canonicalUnsignedPayload(record) {
  const entries = trustedObjectEntries(record).filter(([key]) => key !== "signature");
  trustedArraySort(entries, ([left], [right]) => left.localeCompare(right));
  return Buffer.from(trustedJsonStringify(trustedObjectFromEntries(entries)));
}

function canonicalRecord(record) {
  const entries = trustedObjectEntries(record);
  trustedArraySort(entries, ([left], [right]) => left.localeCompare(right));
  return Buffer.from(trustedJsonStringify(trustedObjectFromEntries(entries)));
}

function recordHash(record) {
  return createHash("sha256").update(canonicalRecord(record)).digest("hex");
}

function bytesDigest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeCanonicalBase64(value, label) {
  const encoded = trustedString(value || "");
  assert(/^[A-Za-z0-9+/]+={0,2}$/.test(encoded), `${label} is not canonical base64`);
  const decoded = Buffer.from(encoded, "base64");
  assert(decoded.length > 0 && decoded.toString("base64") === encoded,
    `${label} is not canonical base64`);
  return decoded;
}

function publicKeyObject(encoded) {
  try {
    return createPublicKey({
      key: decodeCanonicalBase64(encoded, "regression fixture signing public key"),
      format: "der",
      type: "spki"
    });
  } catch (error) {
    throw new Error(`regression fixture signing public key is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function privateKeyObject(encoded, expectedPublicKey) {
  try {
    const privateKey = createPrivateKey({
      key: decodeCanonicalBase64(encoded, "regression fixture signing private key"),
      format: "der",
      type: "pkcs8"
    });
    assert(privateKey.asymmetricKeyType === "ed25519",
      "regression fixture signing private key type is invalid");
    const derived = createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64");
    assert(derived === expectedPublicKey,
      "regression fixture signing private key does not match its ledger");
    return privateKey;
  } catch (error) {
    throw new Error(`regression fixture signing private key is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function signRecord(record, privateKey) {
  return sign(null, canonicalUnsignedPayload(record), privateKey).toString("base64");
}

function assertRecordSignature(record, publicKey) {
  const signature = decodeCanonicalBase64(record?.signature, "regression fixture record signature");
  assert(signature.length === 64
    && verify(null, canonicalUnsignedPayload(record), publicKey, signature),
  "regression fixture ledger record signature is invalid");
}

function assertPrivateRegularFile(metadata, label) {
  assert(metadata.isFile()
    && !metadata.isSymbolicLink()
    && metadata.nlink === 1
    && (metadata.mode & 0o077) === 0
    && (trustedUid === null || metadata.uid === trustedUid),
  `${label} is not one private owned file`);
}

function fixtureLedgerFileName(name) {
  const normalized = trustedString(name || "");
  assert(normalized === "parent" || /^\d{3}$/.test(normalized),
    "regression fixture ledger name is invalid");
  return `${normalized}.fixtures.jsonl`;
}

function validateReference(secretDir, reference) {
  assert(path.isAbsolute(secretDir)
    && reference
    && typeof reference === "object"
    && !trustedArrayIsArray(reference)
    && /^(?:parent|\d{3})\.fixtures\.jsonl$/.test(trustedString(reference.file || ""))
    && /^\d+$/.test(trustedString(reference.device || ""))
    && /^\d+$/.test(trustedString(reference.inode || ""))
    && /^[0-9a-f]{32}$/.test(trustedString(reference.runId || ""))
    && canonicalKeys(reference) === referenceKeys,
  "regression fixture ledger reference is invalid");
  publicKeyObject(reference.signingPublicKey);
  return path.join(secretDir, reference.file);
}

function stableLedgerBytes(secretDir, reference) {
  const ledgerPath = validateReference(secretDir, reference);
  const pathMetadata = trustedLstatSync(ledgerPath);
  assertPrivateRegularFile(pathMetadata, "regression fixture ledger");
  assert(String(pathMetadata.dev) === reference.device
    && String(pathMetadata.ino) === reference.inode
    && pathMetadata.size > 0
    && pathMetadata.size <= maximumLedgerBytes,
  "regression fixture ledger identity or size changed");
  const descriptor = trustedOpenSync(ledgerPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = trustedFstatSync(descriptor);
    assertPrivateRegularFile(before, "regression fixture ledger");
    assert(String(before.dev) === reference.device
      && String(before.ino) === reference.inode
      && before.size === pathMetadata.size,
    "regression fixture ledger changed before read");
    const bytes = trustedReadFileSync(descriptor);
    const after = trustedFstatSync(descriptor);
    assert(after.dev === before.dev
      && after.ino === before.ino
      && after.size === before.size
      && after.mtimeMs === before.mtimeMs
      && after.ctimeMs === before.ctimeMs
      && bytes.length === before.size,
    "regression fixture ledger changed during read");
    return bytes;
  } finally {
    trustedCloseSync(descriptor);
  }
}

function normalizePreparedRecord(record) {
  const normalized = {
    registrationId: trustedString(record?.registrationId || ""),
    username: trustedString(record?.username || ""),
    userId: trustedString(record?.userId || ""),
    displayName: trustedString(record?.displayName || ""),
    generation: Number(record?.generation),
    retainQuarantinedIdentity: record?.retainQuarantinedIdentity === true
  };
  assert(/^[0-9a-f]{32}$/.test(normalized.registrationId),
    "regression fixture registration id is invalid");
  assert(/^r_[a-z0-9_]{1,58}_[0-9a-f]{12,32}$/.test(normalized.username),
    "regression fixture username is outside the owned namespace");
  assert(uuidPattern.test(normalized.userId), "regression fixture user id is invalid");
  assert(normalized.displayName.length > 0 && normalized.displayName.length <= 120,
    "regression fixture display name is invalid");
  assert(Number.isSafeInteger(normalized.generation) && normalized.generation >= 0,
    "regression fixture generation is invalid");
  return normalized;
}

export function initializeRegressionFixtureLedger({ secretDir, name, runId }) {
  assertPrivilegedPathApiAvailable();
  assert(path.isAbsolute(secretDir) && /^[0-9a-f]{32}$/.test(trustedString(runId || "")),
    "regression fixture ledger ownership is invalid");
  const file = fixtureLedgerFileName(name);
  const ledgerPath = path.join(secretDir, file);
  const provisionalPath = path.join(secretDir, `.${file}.${randomBytes(8).toString("hex")}.tmp`);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signingPrivateKey = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const signingPublicKey = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  let descriptor = -1;
  try {
    descriptor = trustedOpenSync(
      provisionalPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600
    );
    const header = { type: "header", version: ledgerVersion, runId, signingPublicKey };
    header.signature = signRecord(header, privateKey);
    const frame = Buffer.from(`${trustedJsonStringify(header)}\n`);
    assert(trustedWriteSync(descriptor, frame) === frame.length,
      "regression fixture ledger header write was incomplete");
    trustedFsyncSync(descriptor);
    trustedCloseSync(descriptor);
    descriptor = -1;
    trustedRenameSync(provisionalPath, ledgerPath);
    const directoryDescriptor = trustedOpenSync(secretDir, fsConstants.O_RDONLY);
    try {
      trustedFsyncSync(directoryDescriptor);
    } finally {
      trustedCloseSync(directoryDescriptor);
    }
    const metadata = trustedLstatSync(ledgerPath);
    assertPrivateRegularFile(metadata, "regression fixture ledger");
    const reference = trustedObjectFreeze({
      file,
      device: String(metadata.dev),
      inode: String(metadata.ino),
      runId,
      signingPublicKey
    });
    const writer = openRegressionFixtureLedgerWriter({ secretDir, reference, signingPrivateKey });
    return trustedObjectFreeze({
      path: ledgerPath,
      reference,
      signingPrivateKey,
      writer
    });
  } catch (error) {
    if (descriptor >= 0) {
      try { trustedCloseSync(descriptor); } catch { /* preserve the primary error */ }
    }
    try { trustedUnlinkSync(provisionalPath); } catch { /* unpublished path may not exist */ }
    try { trustedUnlinkSync(ledgerPath); } catch { /* published path may not exist */ }
    throw error;
  }
}

export function openRegressionFixtureLedgerWriter({ secretDir, reference, signingPrivateKey }) {
  assertPrivilegedPathApiAvailable();
  const ledger = readRegressionFixtureLedgerInternal({ secretDir, reference, requireSealed: false });
  assert(!ledger.sealed, "regression fixture ledger is already sealed");
  const writer = trustedObjectFreeze({});
  trustedWeakMapSet(writerState, writer, {
    secretDir,
    reference,
    privateKey: privateKeyObject(signingPrivateKey, reference.signingPublicKey),
    ledger,
    byteLength: ledger.byteLength,
    contentDigest: ledger.contentDigest
  });
  return writer;
}

function assertWriterLedgerUnchanged(state) {
  const bytes = stableLedgerBytes(state.secretDir, state.reference);
  assert(bytes.length === state.byteLength && bytesDigest(bytes) === state.contentDigest,
    "regression fixture ledger changed outside its trusted writer");
}

function applyTrustedAppend(ledger, record) {
  assert(record.sequence === ledger.nextSequence && record.previousHash === ledger.previousHash,
    "regression fixture ledger writer sequence changed unexpectedly");
  if (record.type === "prepared") {
    ledger.entries.push({ ...normalizePreparedRecord(record), state: "PREPARED" });
  } else if (record.type === "state") {
    const entry = ledger.entries.find(({ registrationId }) => registrationId === record.registrationId);
    assert(entry && entry.state === "PREPARED", "regression fixture ledger writer state changed unexpectedly");
    entry.state = record.state;
  } else if (record.type === "seal") {
    ledger.sealed = true;
  } else {
    throw new Error("regression fixture ledger writer record type is invalid");
  }
  ledger.nextSequence += 1;
  ledger.previousHash = recordHash(record);
}

function appendSignedRecord(writer, unsigned) {
  const state = trustedWeakMapGet(writerState, writer);
  assert(state, "regression fixture ledger writer capability is invalid");
  assertWriterLedgerUnchanged(state);
  const ledger = state.ledger;
  assert(!ledger.sealed && !ledger.hasPartialRecord,
    "regression fixture ledger cannot append after an incomplete or sealed record");
  const record = {
    ...unsigned,
    sequence: ledger.nextSequence,
    previousHash: ledger.previousHash
  };
  record.signature = signRecord(record, state.privateKey);
  const frame = Buffer.from(`${trustedJsonStringify(record)}\n`);
  const ledgerPath = validateReference(state.secretDir, state.reference);
  const descriptor = trustedOpenSync(
    ledgerPath,
    fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW
  );
  try {
    const metadata = trustedFstatSync(descriptor);
    assertPrivateRegularFile(metadata, "regression fixture ledger");
    assert(String(metadata.dev) === state.reference.device
      && String(metadata.ino) === state.reference.inode,
    "regression fixture ledger writer inode changed");
    assert(trustedWriteSync(descriptor, frame) === frame.length,
      "regression fixture ledger append was incomplete");
    trustedFsyncSync(descriptor);
  } finally {
    trustedCloseSync(descriptor);
  }
  const bytes = stableLedgerBytes(state.secretDir, state.reference);
  assert(bytes.length === state.byteLength + frame.length,
    "regression fixture ledger append changed its expected length");
  state.byteLength = bytes.length;
  state.contentDigest = bytesDigest(bytes);
  applyTrustedAppend(ledger, record);
  return record;
}

export function appendRegressionFixturePrepared(writer, entry) {
  const normalized = normalizePreparedRecord(entry);
  const state = trustedWeakMapGet(writerState, writer);
  assert(state, "regression fixture ledger writer capability is invalid");
  const ledger = state.ledger;
  assert(ledger.entries.length < maximumRegistrations
    && !ledger.entries.some(({ registrationId }) => registrationId === normalized.registrationId),
  "regression fixture registration already exists or reached its bound");
  appendSignedRecord(writer, { type: "prepared", ...normalized });
  return normalized.registrationId;
}

export function appendRegressionFixtureState(writer, registrationId, stateName) {
  const normalizedId = trustedString(registrationId || "");
  const normalizedState = trustedString(stateName || "");
  assert(/^[0-9a-f]{32}$/.test(normalizedId)
    && ["CLOSED", "HARD_DISABLED"].includes(normalizedState),
  "regression fixture state transition is invalid");
  const state = trustedWeakMapGet(writerState, writer);
  assert(state, "regression fixture ledger writer capability is invalid");
  const ledger = state.ledger;
  const entry = ledger.entries.find(({ registrationId: candidate }) => candidate === normalizedId);
  assert(entry && entry.state === "PREPARED",
    "regression fixture state transition does not match one prepared identity");
  appendSignedRecord(writer, { type: "state", registrationId: normalizedId, state: normalizedState });
}

export function sealRegressionFixtureLedger(writer) {
  const state = trustedWeakMapGet(writerState, writer);
  assert(state, "regression fixture ledger writer capability is invalid");
  const ledger = state.ledger;
  if (ledger.sealed) return ledger;
  assert(!ledger.hasPartialRecord, "regression fixture ledger cannot seal a partial record");
  appendSignedRecord(writer, {
    type: "seal",
    registrationCount: ledger.entries.length,
    terminalCount: ledger.entries.filter(({ state: entryState }) => entryState !== "PREPARED").length
  });
  return readRegressionFixtureLedgerInternal({
    secretDir: state.secretDir,
    reference: state.reference,
    requireSealed: true
  });
}

function readRegressionFixtureLedgerInternal({ secretDir, reference, requireSealed = false }) {
  const bytes = stableLedgerBytes(secretDir, reference);
  const raw = bytes.toString("utf8");
  const hasPartialRecord = !raw.endsWith("\n");
  const lines = raw.split("\n");
  if (raw.endsWith("\n")) lines.pop();
  else lines.pop();
  assert(lines.length > 0 && lines.every(Boolean),
    "regression fixture ledger contains an empty or missing record");
  let records;
  try {
    records = trustedArrayMap(lines, (line) => trustedJsonParse(line));
  } catch {
    throw new Error("regression fixture ledger contains invalid JSONL");
  }
  const header = records.shift();
  assert(header
    && header.type === "header"
    && header.version === ledgerVersion
    && header.runId === reference.runId
    && header.signingPublicKey === reference.signingPublicKey
    && canonicalKeys(header) === "runId,signature,signingPublicKey,type,version",
  "regression fixture ledger header does not match its owner");
  const publicKey = publicKeyObject(reference.signingPublicKey);
  assertRecordSignature(header, publicKey);
  let previousHash = recordHash(header);
  let expectedSequence = 1;
  let sealed = false;
  const entries = [];
  for (const record of records) {
    assert(!sealed
      && Number.isSafeInteger(record?.sequence)
      && record.sequence === expectedSequence
      && record.previousHash === previousHash,
    "regression fixture ledger sequence or hash chain is invalid");
    assertRecordSignature(record, publicKey);
    expectedSequence += 1;
    if (record.type === "prepared") {
      assert(canonicalKeys(record) === "displayName,generation,previousHash,registrationId,retainQuarantinedIdentity,sequence,signature,type,userId,username",
        "regression fixture prepared record shape is invalid");
      const normalized = normalizePreparedRecord(record);
      assert(entries.length < maximumRegistrations
        && !entries.some(({ registrationId }) => registrationId === normalized.registrationId),
      "regression fixture ledger contains duplicate or excessive registrations");
      entries.push({ ...normalized, state: "PREPARED" });
    } else if (record.type === "state") {
      assert(canonicalKeys(record) === "previousHash,registrationId,sequence,signature,state,type",
        "regression fixture state record shape is invalid");
      const registrationId = trustedString(record.registrationId || "");
      const stateName = trustedString(record.state || "");
      const entry = entries.find(({ registrationId: candidate }) => candidate === registrationId);
      assert(entry
        && entry.state === "PREPARED"
        && ["CLOSED", "HARD_DISABLED"].includes(stateName),
      "regression fixture ledger contains an invalid state transition");
      entry.state = stateName;
    } else if (record.type === "seal") {
      assert(canonicalKeys(record) === "previousHash,registrationCount,sequence,signature,terminalCount,type"
        && record.registrationCount === entries.length
        && record.terminalCount === entries.filter(({ state }) => state !== "PREPARED").length,
      "regression fixture ledger seal does not match its registrations");
      sealed = true;
    } else {
      throw new Error("regression fixture ledger record type is invalid");
    }
    previousHash = recordHash(record);
  }
  assert(!requireSealed || (sealed && !hasPartialRecord),
    "regression fixture ledger is not durably sealed");
  return {
    version: ledgerVersion,
    runId: reference.runId,
    reference,
    byteLength: bytes.length,
    contentDigest: bytesDigest(bytes),
    entries,
    sealed,
    hasPartialRecord,
    nextSequence: expectedSequence,
    previousHash
  };
}

export function readRegressionFixtureLedger(options) {
  assertPrivilegedPathApiAvailable();
  return readRegressionFixtureLedgerInternal(options);
}

export function inspectUnreferencedRegressionFixtureLedger({ secretDir, file, runId, requireSealed = false }) {
  assertPrivilegedPathApiAvailable();
  assert(/^(?:parent|\d{3})\.fixtures\.jsonl$/.test(trustedString(file || ""))
    && /^[0-9a-f]{32}$/.test(trustedString(runId || "")),
  "unreferenced regression fixture ledger identity is invalid");
  const ledgerPath = path.join(secretDir, file);
  const metadata = trustedLstatSync(ledgerPath);
  assertPrivateRegularFile(metadata, "unreferenced regression fixture ledger");
  assert(metadata.size > 0 && metadata.size <= maximumLedgerBytes,
    "unreferenced regression fixture ledger size is invalid");
  const raw = trustedReadFileSync(ledgerPath, "utf8");
  const firstLine = raw.split("\n", 1)[0];
  let header;
  try {
    header = trustedJsonParse(firstLine);
  } catch {
    throw new Error("unreferenced regression fixture ledger header is invalid");
  }
  const reference = {
    file,
    device: String(metadata.dev),
    inode: String(metadata.ino),
    runId,
    signingPublicKey: trustedString(header?.signingPublicKey || "")
  };
  return readRegressionFixtureLedgerInternal({ secretDir, reference, requireSealed });
}

export function removeRegressionFixtureLedger({ secretDir, reference, requireSealed = true }) {
  assertPrivilegedPathApiAvailable();
  readRegressionFixtureLedgerInternal({ secretDir, reference, requireSealed });
  const ledgerPath = validateReference(secretDir, reference);
  const metadata = trustedLstatSync(ledgerPath);
  assert(String(metadata.dev) === reference.device && String(metadata.ino) === reference.inode,
    "regression fixture ledger changed before removal");
  trustedUnlinkSync(ledgerPath);
}
