import { randomUUID } from "node:crypto";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { link, lstat, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export async function publishRegressionCredentialCapability({ credentialPath, credential }) {
  if (!/^\d{3}\.json$/.test(path.basename(credentialPath))) {
    throw new Error("regression credential capability requires a numbered private target");
  }
  const temporaryPath = path.join(
    path.dirname(credentialPath),
    `.${path.basename(credentialPath)}.${process.pid}.${randomUUID().replaceAll("-", "")}.tmp`
  );
  await writeFile(temporaryPath, JSON.stringify(credential), { mode: 0o600, flag: "wx" });
  try {
    await link(temporaryPath, credentialPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  await unlink(temporaryPath);
  const published = await lstat(credentialPath);
  if (!published.isFile()
    || published.isSymbolicLink()
    || published.nlink !== 1
    || (published.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && published.uid !== process.getuid())) {
    throw new Error("regression credential capability publication did not produce one private inode");
  }
  return {
    device: String(published.dev),
    inode: String(published.ino)
  };
}

export async function removeStaleRegressionCredentialCapabilities({
  secretDir,
  owner,
  apiBase = "http://127.0.0.1:8080",
  frontendBase = "http://127.0.0.1:5173"
}) {
  const entries = await readdir(secretDir, { withFileTypes: true });
  const temporaryPattern = /^\.\d{3}\.json\.\d+\.[0-9a-f]{32}\.tmp$/;
  const temporaryEntries = entries.filter((entry) => temporaryPattern.test(entry.name));
  const credentialEntries = entries.filter((entry) => /^\d{3}\.json$/.test(entry.name));
  const removed = [];
  const errors = [];
  for (const entry of temporaryEntries) {
    const temporaryPath = path.join(secretDir, entry.name);
    try {
      const metadata = await lstat(temporaryPath);
      if (!entry.isFile()
        || entry.isSymbolicLink()
        || !metadata.isFile()
        || metadata.isSymbolicLink()
        || ![1, 2].includes(metadata.nlink)
        || (metadata.mode & 0o077) !== 0
        || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
        throw new Error("stale regression credential temporary capability is unsafe");
      }
      if (metadata.nlink === 2) {
        const targetName = entry.name.match(/^\.(\d{3}\.json)\./)?.[1] || "";
        const targetMetadata = targetName
          ? await lstat(path.join(secretDir, targetName)).catch(() => null)
          : null;
        if (!targetMetadata
          || !targetMetadata.isFile()
          || targetMetadata.isSymbolicLink()
          || targetMetadata.dev !== metadata.dev
          || targetMetadata.ino !== metadata.ino
          || targetMetadata.nlink !== 2) {
          throw new Error("stale regression credential temporary capability has an external hardlink");
        }
      }
      await unlink(temporaryPath);
      removed.push(entry.name);
    } catch (error) {
      errors.push({
        file: entry.name,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  for (const entry of credentialEntries) {
    const credentialPath = path.join(secretDir, entry.name);
    try {
      const metadata = await lstat(credentialPath);
      if (!entry.isFile()
        || entry.isSymbolicLink()
        || !metadata.isFile()
        || metadata.isSymbolicLink()
        || metadata.nlink !== 1
        || (metadata.mode & 0o077) !== 0
        || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
        throw new Error("stale regression credential capability is unsafe");
      }
      const credential = JSON.parse(await readFile(credentialPath, "utf8"));
      const credentialKeys = credential && typeof credential === "object" && !Array.isArray(credential)
        ? Object.keys(credential).sort()
        : [];
      const expectedLedgerFile = `${path.basename(entry.name, ".json")}.fixtures.jsonl`;
      const fixtureLedgerReference = credential.fixtureLedgerReference;
      let signingKeyMatches = false;
      try {
        const privateKey = createPrivateKey({
          key: Buffer.from(String(credential.fixtureLedgerSigningPrivateKey || ""), "base64"),
          format: "der",
          type: "pkcs8"
        });
        signingKeyMatches = createPublicKey(privateKey)
          .export({ format: "der", type: "spki" })
          .toString("base64") === String(fixtureLedgerReference?.signingPublicKey || "");
      } catch { /* rejected below */ }
      if (credentialKeys.join(",") !== "apiBase,fixtureLedgerReference,fixtureLedgerSigningPrivateKey,frontendBase,password,requestFenceControlToken,runId,userId,username"
        || credential.runId !== String(owner?.runId || "")
        || credential.userId !== String(owner?.userId || "")
        || credential.username !== String(owner?.username || "")
        || credential.apiBase !== apiBase
        || credential.frontendBase !== frontendBase
        || !fixtureLedgerReference
        || Object.keys(fixtureLedgerReference).sort().join(",") !== "device,file,inode,runId,signingPublicKey"
        || fixtureLedgerReference.file !== expectedLedgerFile
        || fixtureLedgerReference.runId !== credential.runId
        || !/^\d+$/.test(String(fixtureLedgerReference.device || ""))
        || !/^\d+$/.test(String(fixtureLedgerReference.inode || ""))
        || !signingKeyMatches
        || !/^[0-9a-f]{32}$/.test(String(credential.requestFenceControlToken || ""))
        || typeof credential.password !== "string"
        || credential.password.length < 16) {
        throw new Error("stale regression credential capability does not match the owning run");
      }
      await unlink(credentialPath);
      removed.push(entry.name);
    } catch (error) {
      errors.push({
        file: entry.name,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return {
    ok: errors.length === 0,
    removed: removed.sort(),
    errors
  };
}
