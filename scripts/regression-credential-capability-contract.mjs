#!/usr/bin/env node

import assert from "node:assert/strict";
import { access, link, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  publishRegressionCredentialCapability,
  removeStaleRegressionCredentialCapabilities
} from "./helpers/regression-credential-capability.mjs";
import { initializeRegressionFixtureLedger } from "./helpers/regression-fixture-ledger.mjs";

const secretDir = await mkdtemp(path.join(tmpdir(), "a174-credential-capability-"));
const externalDir = await mkdtemp(path.join(tmpdir(), "a174-credential-external-"));
const owner = {
  runId: "a".repeat(32),
  userId: "fixture-user",
  username: "r_full_000000000000000000000000"
};
const fixtureLedgers = new Map();

try {
  const credentialPath = path.join(secretDir, "001.json");
  await publishRegressionCredentialCapability({
    credentialPath,
    credential: credential(1)
  });
  assert.deepEqual(JSON.parse(await readFile(credentialPath, "utf8")), credential(1));

  const truncatedTemporaryPath = path.join(
    secretDir,
    `.002.json.1234.${"b".repeat(32)}.tmp`
  );
  await writeFile(truncatedTemporaryPath, '{"password":"partial-secret', { mode: 0o600 });
  const recovered = await removeStaleRegressionCredentialCapabilities({ secretDir, owner });
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.removed, [path.basename(truncatedTemporaryPath), "001.json"].sort(),
    "stale recovery must remove both an atomically published capability and a partial private temp");
  await assert.rejects(access(credentialPath));
  await assert.rejects(access(truncatedTemporaryPath));

  const mismatchedPath = path.join(secretDir, "003.json");
  await writeFile(mismatchedPath, JSON.stringify({ ...credential(3), runId: "c".repeat(32) }), { mode: 0o600 });
  const mismatched = await removeStaleRegressionCredentialCapabilities({ secretDir, owner });
  assert.equal(mismatched.ok, false, "a credential belonging to another run must fail closed");
  assert.match(mismatched.errors[0].error, /does not match the owning run/);
  assert.equal((await readFile(mismatchedPath, "utf8")).length > 0, true);
  await rm(mismatchedPath);

  const externalPath = path.join(externalDir, "external.json");
  const linkedPath = path.join(secretDir, "004.json");
  await writeFile(externalPath, JSON.stringify(credential(4)), { mode: 0o600 });
  await symlink(externalPath, linkedPath);
  const linked = await removeStaleRegressionCredentialCapabilities({ secretDir, owner });
  assert.equal(linked.ok, false, "a credential symlink must fail closed");
  assert.equal(await readFile(externalPath, "utf8"), JSON.stringify(credential(4)),
    "credential recovery must never follow a symlink target");
  await unlink(linkedPath);

  const hardlinkedCredentialPath = path.join(secretDir, "005.json");
  const externalHardlinkPath = path.join(externalDir, "external-hardlink.json");
  await publishRegressionCredentialCapability({
    credentialPath: hardlinkedCredentialPath,
    credential: credential(5)
  });
  await link(hardlinkedCredentialPath, externalHardlinkPath);
  const hardlinked = await removeStaleRegressionCredentialCapabilities({ secretDir, owner });
  assert.equal(hardlinked.ok, false,
    "credential recovery must not report success while an external hardlink retains the capability");
  assert.match(hardlinked.errors[0].error, /unsafe/);
  assert.deepEqual(JSON.parse(await readFile(externalHardlinkPath, "utf8")), credential(5));
  assert.deepEqual(JSON.parse(await readFile(hardlinkedCredentialPath, "utf8")), credential(5));

  console.log(JSON.stringify({
    ok: true,
    atomicCapabilityPublishVerified: true,
    truncatedTemporaryCleanupVerified: true,
    crossRunRefusalVerified: true,
    symlinkRefusalVerified: true,
    hardlinkRefusalVerified: true
  }));
} finally {
  await rm(secretDir, { recursive: true, force: true });
  await rm(externalDir, { recursive: true, force: true });
}

function credential(index) {
  const name = String(index).padStart(3, "0");
  let fixtureLedger = fixtureLedgers.get(name);
  if (!fixtureLedger) {
    fixtureLedger = initializeRegressionFixtureLedger({ secretDir, name, runId: owner.runId });
    fixtureLedgers.set(name, fixtureLedger);
  }
  return {
    ...owner,
    password: "contract-password-0001",
    apiBase: "http://127.0.0.1:8080",
    frontendBase: "http://127.0.0.1:5173",
    requestFenceControlToken: "f".repeat(32),
    fixtureLedgerReference: fixtureLedger.reference,
    fixtureLedgerSigningPrivateKey: fixtureLedger.signingPrivateKey
  };
}
