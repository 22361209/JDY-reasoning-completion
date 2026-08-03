#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, link, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeRegressionFixtureLedger } from "./helpers/regression-fixture-ledger.mjs";

const helperPath = path.resolve(import.meta.dirname, "helpers/regression-auth.mjs");
const runId = randomBytes(16).toString("hex");
const username = `r_full_${randomBytes(12).toString("hex")}`;
const password = `R!${randomBytes(18).toString("base64url")}a1`;
const userId = randomUUID();
const secretDigest = createHash("sha256").update(password).digest("hex");
const secretDir = await mkdtemp(path.join(tmpdir(), "jdy-regression-credential-contract-"));
const credentialPath = path.join(secretDir, "credential.json");
const fixtureLedger = initializeRegressionFixtureLedger({ secretDir, name: "001", runId });
const runtimeCredential = {
  runId,
  username,
  password,
  userId,
  apiBase: "http://127.0.0.1:8080",
  frontendBase: "http://127.0.0.1:5173",
  requestFenceControlToken: "f".repeat(32),
  fixtureLedgerReference: fixtureLedger.reference,
  fixtureLedgerSigningPrivateKey: fixtureLedger.signingPrivateKey
};

const childSource = `
  import assert from "node:assert/strict";
  import { createHash } from "node:crypto";
  import { existsSync } from "node:fs";
  import { pathToFileURL } from "node:url";
  const credentialPath = process.env.JDY_REGRESSION_ADMIN_CREDENTIAL_FILE;
  const auth = await import(pathToFileURL(process.argv[1]).href);
  const credentials = auth.regressionAdminCredentials();
  const identity = auth.regressionAdminIdentity();
  assert.equal(credentials.username, process.env.JDY_CONTRACT_EXPECTED_USERNAME);
  assert.equal(identity.username, process.env.JDY_CONTRACT_EXPECTED_USERNAME);
  assert.equal(identity.userId, process.env.JDY_CONTRACT_EXPECTED_USER_ID);
  assert.equal(identity.mode, "run-scoped");
  assert.equal(createHash("sha256").update(credentials.password).digest("hex"), process.env.JDY_CONTRACT_PASSWORD_DIGEST);
  assert.equal(existsSync(credentialPath), false);
  assert.equal(Object.hasOwn(process.env, "JDY_REGRESSION_ADMIN_CREDENTIAL_FILE"), false);
  assert.equal(Object.hasOwn(process.env, "JDY_REGRESSION_ADMIN_CREDENTIAL_IDENTITY"), false);
  assert.equal(Object.hasOwn(process.env, "JDY_REGRESSION_RUN_ID"), false);
  assert.equal(Object.hasOwn(process.env, "JDY_REGRESSION_SECRET_REPORT_FD"), false);
  console.log(JSON.stringify({ ok: true, credentialFileConsumed: true, environmentCapabilityRemoved: true }));
`;

async function runChild(runtimeCredentialPath, identity) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", childSource, helperPath], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: {
        ...process.env,
        JDY_REGRESSION_RUN_ID: runId,
        JDY_REGRESSION_ADMIN_CREDENTIAL_FILE: runtimeCredentialPath,
        JDY_REGRESSION_ADMIN_CREDENTIAL_IDENTITY: `${identity.dev}:${identity.ino}`,
        JDY_REGRESSION_SECRET_REPORT_FD: "3",
        JDY_CONTRACT_EXPECTED_USERNAME: username,
        JDY_CONTRACT_EXPECTED_USER_ID: userId,
        JDY_CONTRACT_PASSWORD_DIGEST: secretDigest
      },
      stdio: ["ignore", "pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let sidecar = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.stdio[3].on("data", (chunk) => { sidecar += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr, sidecar }));
  });
}

try {
  await writeFile(credentialPath, JSON.stringify(runtimeCredential), { mode: 0o600, flag: "wx" });
  const before = await stat(credentialPath);
  assert.equal(before.mode & 0o077, 0, "credential contract file must be private");
  const result = await runChild(credentialPath, before);
  assert.equal(result.status, 0, `credential contract child failed: ${result.stderr}`);
  assert.equal(result.sidecar, "", "reading the already-known suite password must not emit a sidecar frame");
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    credentialFileConsumed: true,
    environmentCapabilityRemoved: true
  });

  const hardlinkedCredentialPath = path.join(secretDir, "hardlinked-credential.json");
  const externalHardlinkPath = path.join(secretDir, "external-hardlink.json");
  await writeFile(hardlinkedCredentialPath, JSON.stringify(runtimeCredential), { mode: 0o600, flag: "wx" });
  const hardlinkedIdentity = await stat(hardlinkedCredentialPath);
  await link(hardlinkedCredentialPath, externalHardlinkPath);
  const hardlinkedResult = await runChild(hardlinkedCredentialPath, hardlinkedIdentity);
  assert.notEqual(hardlinkedResult.status, 0, "a multiply-linked runtime credential must fail closed");
  assert.match(hardlinkedResult.stderr, /external hardlink/);
  await assert.rejects(access(hardlinkedCredentialPath));
  assert.equal(await readFile(externalHardlinkPath, "utf8"), "",
    "the exact published credential inode must be erased when an external hardlink appears");

  console.log(JSON.stringify({
    ok: true,
    credentialFileConsumed: true,
    environmentCapabilityRemoved: true,
    runtimeHardlinkRejectedAndErased: true
  }));
} finally {
  await rm(secretDir, { recursive: true, force: true });
}
