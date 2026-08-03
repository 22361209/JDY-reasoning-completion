import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync
} from "node:fs";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify
} from "node:crypto";
import path from "node:path";

const ledgerVersion = 1;
const maximumLedgerBytes = 1024 * 1024;
const maximumSpawnIntents = 128;
// New guards stop at 1,024 before launch. The reader deliberately retains a
// larger bounded recovery envelope so a ledger produced by the former
// post-launch limit bug can still expose every signed lease for cleanup.
const maximumRecoverableDockerIntents = 4_096;
const referenceKeys = "childScript,device,file,guardToken,inode,runId,signingPublicKey";

function decodeCanonicalBase64(value, label) {
  const encoded = String(value || "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error(`${label} is not canonical base64`);
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== encoded) {
    throw new Error(`${label} is not canonical base64`);
  }
  return decoded;
}

function signingPublicKeyObject(encoded) {
  try {
    return createPublicKey({
      key: decodeCanonicalBase64(encoded, "regression detached spawn signing public key"),
      format: "der",
      type: "spki"
    });
  } catch (error) {
    throw new Error(`regression detached spawn signing public key is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function canonicalSignedPayload(record) {
  const unsigned = Object.fromEntries(Object.entries(record)
    .filter(([key]) => key !== "signature")
    .sort(([left], [right]) => left.localeCompare(right)));
  return Buffer.from(JSON.stringify(unsigned));
}

function canonicalRecord(record) {
  return Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(record)
    .sort(([left], [right]) => left.localeCompare(right)))));
}

function recordHash(record) {
  return createHash("sha256").update(canonicalRecord(record)).digest("hex");
}

function signRecord(record, privateKey) {
  return sign(null, canonicalSignedPayload(record), privateKey).toString("base64");
}

function assertRecordSignature(record, publicKey) {
  const signature = decodeCanonicalBase64(record?.signature, "regression detached spawn record signature");
  if (signature.length !== 64 || !verify(null, canonicalSignedPayload(record), publicKey, signature)) {
    throw new Error("regression detached spawn ledger record signature is invalid");
  }
}

function assertPrivateLedgerMetadata(metadata, label) {
  if (!metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || (metadata.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    throw new Error(`${label} is not one private owned file`);
  }
}

function ledgerFileName(index) {
  if (!Number.isInteger(index) || index < 1 || index > 999) {
    throw new Error("regression detached spawn ledger index is invalid");
  }
  return `${String(index).padStart(3, "0")}.detached-processes.jsonl`;
}

function assertChildScript(childScript) {
  const normalized = String(childScript || "");
  if (!/^scripts\/[A-Za-z0-9_.\/-]+\.mjs$/.test(normalized)
    || path.posix.normalize(normalized) !== normalized
    || normalized.split("/").includes("..")) {
    throw new Error("regression detached spawn ledger child script is invalid");
  }
  return normalized;
}

function fsyncDirectory(directory) {
  const descriptor = openSync(directory, fsConstants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function initializeRegressionDetachedSpawnLedger({
  secretDir,
  index,
  runId,
  childScript,
  guardToken
}) {
  if (!path.isAbsolute(secretDir)
    || !/^[0-9a-f]{32}$/.test(String(runId || ""))
    || !/^[0-9a-f]{32}$/.test(String(guardToken || ""))) {
    throw new Error("regression detached spawn ledger ownership metadata is invalid");
  }
  const normalizedChildScript = assertChildScript(childScript);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signingPrivateKey = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const signingPublicKey = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const file = ledgerFileName(index);
  const ledgerPath = path.join(secretDir, file);
  const provisionalPath = path.join(
    secretDir,
    `.${file}.${randomBytes(8).toString("hex")}.tmp`
  );
  const descriptor = openSync(
    provisionalPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_APPEND,
    0o600
  );
  let signingKeyDescriptor = -1;
  let signingKeyPath = "";
  try {
    const header = {
      type: "header",
      version: ledgerVersion,
      runId,
      childScript: normalizedChildScript,
      guardToken,
      signingPublicKey
    };
    header.signature = signRecord(header, privateKey);
    const headerHash = recordHash(header);
    writeSync(descriptor, `${JSON.stringify(header)}\n`);
    fsyncSync(descriptor);
    signingKeyPath = path.join(
      secretDir,
      `.${String(index).padStart(3, "0")}.detached-signing-key.${randomBytes(8).toString("hex")}.tmp`
    );
    signingKeyDescriptor = openSync(
      signingKeyPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR,
      0o600
    );
    const signingCapability = Buffer.from(`${JSON.stringify({
      version: 1,
      privateKey: signingPrivateKey,
      headerHash
    })}\n`);
    writeSync(signingKeyDescriptor, signingCapability, 0, signingCapability.length, 0);
    fsyncSync(signingKeyDescriptor);
    unlinkSync(signingKeyPath);
    signingKeyPath = "";
    fsyncDirectory(secretDir);
    renameSync(provisionalPath, ledgerPath);
    fsyncDirectory(secretDir);
    const metadata = fstatSync(descriptor);
    assertPrivateLedgerMetadata(metadata, "regression detached spawn ledger");
    return {
      descriptor,
      path: ledgerPath,
      signingKeyDescriptor,
      reference: {
        file,
        device: String(metadata.dev),
        inode: String(metadata.ino),
        runId,
        childScript: normalizedChildScript,
        guardToken,
        signingPublicKey
      }
    };
  } catch (error) {
    closeSync(descriptor);
    if (signingKeyDescriptor >= 0) {
      try { closeSync(signingKeyDescriptor); } catch { /* preserve the initialization error */ }
    }
    if (signingKeyPath) {
      try { unlinkSync(signingKeyPath); } catch { /* preserve the initialization error */ }
    }
    try {
      unlinkSync(ledgerPath);
    } catch {
      try { unlinkSync(provisionalPath); } catch { /* preserve the initialization error */ }
    }
    throw error;
  }
}

function validateReference(secretDir, reference) {
  if (!path.isAbsolute(secretDir)
    || !reference
    || typeof reference !== "object"
    || Array.isArray(reference)
    || !/^\d{3}\.detached-processes\.jsonl$/.test(String(reference.file || ""))
    || !/^\d+$/.test(String(reference.device || ""))
    || !/^\d+$/.test(String(reference.inode || ""))
    || !/^[0-9a-f]{32}$/.test(String(reference.runId || ""))
    || !/^[0-9a-f]{32}$/.test(String(reference.guardToken || ""))
    || Object.keys(reference).sort().join(",") !== referenceKeys) {
    throw new Error("regression detached spawn ledger reference is invalid");
  }
  assertChildScript(reference.childScript);
  signingPublicKeyObject(reference.signingPublicKey);
  return path.join(secretDir, reference.file);
}

function readStableLedgerFile(ledgerPath, reference) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const descriptor = openSync(ledgerPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const before = fstatSync(descriptor);
      assertPrivateLedgerMetadata(before, "regression detached spawn ledger");
      if (String(before.dev) !== reference.device
        || String(before.ino) !== reference.inode
        || before.size > maximumLedgerBytes) {
        throw new Error("regression detached spawn ledger identity or size changed");
      }
      const content = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < content.length) {
        const count = readSync(descriptor, content, offset, content.length - offset, offset);
        if (count === 0) break;
        offset += count;
      }
      const after = fstatSync(descriptor);
      if (String(after.dev) !== reference.device
        || String(after.ino) !== reference.inode
        || after.size > maximumLedgerBytes) {
        throw new Error("regression detached spawn ledger identity or size changed");
      }
      if (offset === before.size && after.size === before.size) return content.toString("utf8");
    } finally {
      closeSync(descriptor);
    }
  }
  throw new Error("regression detached spawn ledger did not reach a stable read snapshot");
}

export function readRegressionDetachedSpawnLedger({
  secretDir,
  reference,
  requireClosed = false,
  expectedParentPid = 0,
  allowHeaderOnly = false
}) {
  const ledgerPath = validateReference(secretDir, reference);
  const pathMetadata = lstatSync(ledgerPath);
  assertPrivateLedgerMetadata(pathMetadata, "regression detached spawn ledger");
  const raw = readStableLedgerFile(ledgerPath, reference);
  const hasPartialRecord = raw.length > 0 && !raw.endsWith("\n");
  const lineParts = raw.split("\n");
  if (raw.endsWith("\n")) lineParts.pop();
  else lineParts.pop();
  if (lineParts.some((line) => line.length === 0)) {
    throw new Error("regression detached spawn ledger contains an empty JSONL record");
  }
  let records;
  try {
    records = lineParts.map((line) => JSON.parse(line));
  } catch {
    throw new Error("regression detached spawn ledger contains invalid JSONL");
  }
  const header = records.shift();
  const signingPublicKey = signingPublicKeyObject(reference.signingPublicKey);
  if (!header
    || header.type !== "header"
    || header.version !== ledgerVersion
    || header.runId !== reference.runId
    || header.childScript !== reference.childScript
    || header.guardToken !== reference.guardToken
    || header.signingPublicKey !== reference.signingPublicKey
    || Object.keys(header).sort().join(",") !== "childScript,guardToken,runId,signature,signingPublicKey,type,version") {
    throw new Error("regression detached spawn ledger header does not match its owner");
  }
  assertRecordSignature(header, signingPublicKey);
  const intents = new Map();
  const dockerIntents = new Map();
  const completedDockerIntentIds = new Set();
  const abortedDockerIntentIds = new Set();
  const members = [];
  const spawnedPids = new Set();
  let failedCount = 0;
  let expectedSequence = 1;
  let previousHash = recordHash(header);
  let sealed = false;
  for (const record of records) {
    if (sealed) throw new Error("regression detached spawn ledger contains a record after its seal");
    if (!Number.isSafeInteger(record.sequence) || record.sequence !== expectedSequence) {
      throw new Error("regression detached spawn ledger record sequence is invalid");
    }
    expectedSequence += 1;
    assertRecordSignature(record, signingPublicKey);
    if (record.previousHash !== previousHash) {
      throw new Error("regression detached spawn ledger signature chain is invalid");
    }
    if (record.type === "seal") {
      if (Object.keys(record).sort().join(",") !== "dockerAbortedCount,dockerCompletedCount,dockerIntentCount,failedCount,intentCount,previousHash,recordCount,sequence,signature,spawnedCount,type"
        || record.recordCount !== record.sequence - 1
        || record.intentCount !== intents.size
        || record.dockerIntentCount !== dockerIntents.size
        || record.dockerCompletedCount !== completedDockerIntentIds.size
        || record.dockerAbortedCount !== abortedDockerIntentIds.size
        || record.spawnedCount !== members.length
        || record.failedCount !== failedCount) {
        throw new Error("regression detached spawn ledger seal does not match its records");
      }
      sealed = true;
      previousHash = recordHash(record);
      continue;
    }
    const id = String(record?.id || "");
    if (!/^[0-9a-f]{32}$/.test(id)) {
      throw new Error("regression detached spawn ledger record id is invalid");
    }
    if (record.type === "docker-intent") {
      if (Object.keys(record).sort().join(",") !== "applicationName,container,containerId,containerStartedAt,daemonId,endpointFingerprint,id,imageId,previousHash,sequence,signature,tool,type"
        || dockerIntents.has(id)) {
        throw new Error("regression detached spawn ledger Docker intent is ambiguous");
      }
      const container = String(record.container || "");
      const containerId = String(record.containerId || "");
      const containerStartedAt = String(record.containerStartedAt || "");
      const daemonId = String(record.daemonId || "");
      const endpointFingerprint = String(record.endpointFingerprint || "");
      const imageId = String(record.imageId || "");
      const tool = String(record.tool || "");
      const applicationName = String(record.applicationName || "");
      if (!/^[0-9a-f]{64}$/.test(containerId)
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(containerStartedAt)
        || !/^sha256:[0-9a-f]{64}$/.test(imageId)
        || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(daemonId)
        || !/^[0-9a-f]{64}$/.test(endpointFingerprint)
        || !((container === "jdy-erp-postgres"
          && ["psql", "pg_dump", "createdb", "dropdb"].includes(tool)
          && /^(?:a172_lock_[0-9]{10}|jdy_regression_[0-9a-f]{32})$/.test(applicationName))
        || (container === "jdy-erp-redis" && tool === "redis-cli" && applicationName === ""))) {
        throw new Error("regression detached spawn ledger Docker intent target is invalid");
      }
      dockerIntents.set(id, {
        id,
        container,
        containerId,
        containerStartedAt,
        daemonId,
        endpointFingerprint,
        imageId,
        tool,
        applicationName
      });
    } else if (record.type === "docker-completed") {
      if (Object.keys(record).sort().join(",") !== "id,previousHash,sequence,signature,type"
        || !dockerIntents.has(id)
        || completedDockerIntentIds.has(id)
        || abortedDockerIntentIds.has(id)) {
        throw new Error("regression detached spawn ledger Docker completion is ambiguous");
      }
      completedDockerIntentIds.add(id);
    } else if (record.type === "docker-aborted") {
      if (Object.keys(record).sort().join(",") !== "id,previousHash,sequence,signature,type"
        || !dockerIntents.has(id)
        || completedDockerIntentIds.has(id)
        || abortedDockerIntentIds.has(id)) {
        throw new Error("regression detached spawn ledger Docker abort is ambiguous");
      }
      abortedDockerIntentIds.add(id);
    } else if (record.type === "intent") {
      if (Object.keys(record).sort().join(",") !== "executable,id,previousHash,sequence,signature,type" || intents.has(id)) {
        throw new Error("regression detached spawn ledger intent is ambiguous");
      }
      const executable = String(record.executable || "");
      if (!path.isAbsolute(executable)) {
        throw new Error("regression detached spawn ledger executable is not absolute");
      }
      intents.set(id, { executable, state: "pending" });
    } else if (record.type === "spawned") {
      const intent = intents.get(id);
      if (!intent || intent.state !== "pending"
        || record.executable !== intent.executable
        || Object.keys(record).sort().join(",") !== "commandFingerprint,executable,id,lstart,parentPid,pgid,pid,previousHash,sequence,signature,type") {
        throw new Error("regression detached spawn ledger completion has no unique intent");
      }
      const pid = Number(record.pid);
      const parentPid = Number(record.parentPid);
      const pgid = Number(record.pgid);
      const lstart = String(record.lstart || "").trim().replace(/\s+/g, " ");
      const commandFingerprint = String(record.commandFingerprint || "");
      if (!Number.isInteger(pid) || pid <= 1
        || !Number.isInteger(parentPid) || parentPid <= 1
        || Number(expectedParentPid) <= 1
        || (expectedParentPid > 1 && parentPid !== Number(expectedParentPid))
        || pgid !== pid
        || !lstart
        || !/^[0-9a-f]{64}$/.test(commandFingerprint)
        || spawnedPids.has(pid)) {
        throw new Error("regression detached spawn ledger process identity is invalid");
      }
      spawnedPids.add(pid);
      members.push({
        pid,
        parentPidAtProof: parentPid,
        pgidAtProof: pgid,
        lstart,
        commandFingerprint
      });
      intent.state = "spawned";
    } else if (record.type === "failed") {
      const intent = intents.get(id);
      if (!intent || intent.state !== "pending" || Object.keys(record).sort().join(",") !== "id,previousHash,sequence,signature,type") {
        throw new Error("regression detached spawn ledger failure has no unique intent");
      }
      intent.state = "failed";
      failedCount += 1;
    } else {
      throw new Error("regression detached spawn ledger record type is invalid");
    }
    previousHash = recordHash(record);
  }
  if (intents.size > maximumSpawnIntents) {
    throw new Error("regression detached spawn ledger exceeded its safe intent bound");
  }
  if (dockerIntents.size > maximumRecoverableDockerIntents) {
    throw new Error("regression detached spawn ledger exceeded its Docker intent bound");
  }
  const pendingIntentIds = [...intents]
    .filter(([, intent]) => intent.state === "pending")
    .map(([id]) => id)
    .sort();
  const headerOnly = records.length === 0 && !hasPartialRecord;
  if (requireClosed
    && (hasPartialRecord || pendingIntentIds.length > 0 || (!sealed && !(allowHeaderOnly && headerOnly)))) {
    throw new Error("regression detached spawn ledger has an unclosed spawn intent");
  }
  return {
    path: ledgerPath,
    members: members.sort((left, right) => left.pid - right.pid),
    dockerIntents: [...dockerIntents.values()]
      .filter(({ id }) => !abortedDockerIntentIds.has(id))
      .sort((left, right) => left.id.localeCompare(right.id)),
    pendingDockerIntents: [...dockerIntents.values()]
      .filter(({ id }) => !completedDockerIntentIds.has(id) && !abortedDockerIntentIds.has(id))
      .sort((left, right) => left.id.localeCompare(right.id)),
    completedDockerIntentIds: [...completedDockerIntentIds].sort(),
    abortedDockerIntentIds: [...abortedDockerIntentIds].sort(),
    failedCount,
    pendingIntentIds,
    hasPartialRecord,
    sealed,
    headerOnly
  };
}

export function removeRegressionDetachedSpawnLedger({
  secretDir,
  reference,
  expectedParentPid,
  allowHeaderOnly = false
}) {
  const ledger = readRegressionDetachedSpawnLedger({
    secretDir,
    reference,
    expectedParentPid,
    requireClosed: true,
    // A signed header with no intent record proves that this child never
    // requested a detached spawn. It is therefore a closed capability, not a
    // crashed spawn intent. Callers must opt in explicitly so recovery still
    // fails closed for all non-empty ledgers.
    allowHeaderOnly
  });
  unlinkSync(ledger.path);
  fsyncDirectory(secretDir);
  return ledger;
}

export function removeRecoveredRegressionDetachedSpawnLedger({
  secretDir,
  reference,
  expectedParentPid
}) {
  const ledger = readRegressionDetachedSpawnLedger({
    secretDir,
    reference,
    expectedParentPid,
    requireClosed: false
  });
  if (ledger.hasPartialRecord || ledger.pendingIntentIds.length > 0) {
    throw new Error("crashed regression detached spawn ledger has ambiguous ownership evidence");
  }
  unlinkSync(ledger.path);
  fsyncDirectory(secretDir);
  return ledger;
}

export function removeUnpublishedRegressionDetachedSpawnCapability({ secretDir, file }) {
  if (!path.isAbsolute(secretDir)
    || !/^\.\d{3}\.detached-(?:processes\.jsonl|signing-key)\.[0-9a-f]{16}\.tmp$/.test(String(file || ""))) {
    throw new Error("unpublished regression detached spawn capability filename is invalid");
  }
  const capabilityPath = path.join(secretDir, file);
  const metadata = lstatSync(capabilityPath);
  assertPrivateLedgerMetadata(metadata, "unpublished regression detached spawn capability");
  if (metadata.size > maximumLedgerBytes) {
    throw new Error("unpublished regression detached spawn capability is oversized");
  }
  unlinkSync(capabilityPath);
  fsyncDirectory(secretDir);
}

export function inspectUnreferencedRegressionDetachedSpawnLedger({
  secretDir,
  file,
  runId,
  requireClosed = true
}) {
  if (!/^\d{3}\.detached-processes\.jsonl$/.test(String(file || ""))
    || !/^[0-9a-f]{32}$/.test(String(runId || ""))) {
    throw new Error("unreferenced regression detached spawn ledger metadata is invalid");
  }
  const ledgerPath = path.join(secretDir, file);
  const metadata = lstatSync(ledgerPath);
  assertPrivateLedgerMetadata(metadata, "unreferenced regression detached spawn ledger");
  const provisionalReference = {
    file,
    device: String(metadata.dev),
    inode: String(metadata.ino),
    runId,
    childScript: "scripts/placeholder.mjs",
    guardToken: "0".repeat(32),
    signingPublicKey: "provisional"
  };
  const raw = readStableLedgerFile(ledgerPath, provisionalReference);
  const firstLine = raw.split("\n", 1)[0];
  let header;
  try {
    header = JSON.parse(firstLine);
  } catch {
    throw new Error("unreferenced regression detached spawn ledger header is invalid");
  }
  if (header?.type !== "header"
    || header.version !== ledgerVersion
    || header.runId !== runId
    || Object.keys(header).sort().join(",") !== "childScript,guardToken,runId,signature,signingPublicKey,type,version") {
    throw new Error("unreferenced regression detached spawn ledger header does not match the suite");
  }
  const reference = {
    file,
    device: String(metadata.dev),
    inode: String(metadata.ino),
    runId,
    childScript: assertChildScript(header.childScript),
    guardToken: String(header.guardToken || ""),
    signingPublicKey: String(header.signingPublicKey || "")
  };
  if (!/^[0-9a-f]{32}$/.test(reference.guardToken)) {
    throw new Error("unreferenced regression detached spawn ledger guard token is invalid");
  }
  const parentPids = new Set(raw.split("\n").flatMap((line, index) => {
    if (index === 0 || !line) return [];
    try {
      const record = JSON.parse(line);
      return record?.type === "spawned" ? [Number(record.parentPid)] : [];
    } catch {
      return [];
    }
  }).filter((pid) => Number.isInteger(pid) && pid > 1));
  if (parentPids.size > 1) {
    throw new Error("unreferenced regression detached spawn ledger has multiple parent processes");
  }
  const expectedParentPid = [...parentPids][0] || 0;
  const ledger = readRegressionDetachedSpawnLedger({
    secretDir,
    reference,
    expectedParentPid,
    requireClosed,
    allowHeaderOnly: true
  });
  return { ...ledger, reference, expectedParentPid };
}
