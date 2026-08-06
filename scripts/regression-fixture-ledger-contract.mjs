#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  appendRegressionFixturePrepared,
  appendRegressionFixtureState,
  initializeRegressionFixtureLedger,
  readRegressionFixtureLedger,
  sealRegressionFixtureLedger,
  sealRegressionFixtureLedgerPrivilegedPathApi
} from "./helpers/regression-fixture-ledger.mjs";

const secretDir = mkdtempSync(path.join(tmpdir(), "a174-fixture-ledger-contract-"));
chmodSync(secretDir, 0o700);
const runId = randomBytes(16).toString("hex");
const fixture = {
  registrationId: randomBytes(16).toString("hex"),
  username: `r_contract_${randomBytes(8).toString("hex")}`,
  userId: randomUUID(),
  displayName: "签名 fixture ledger 合同",
  generation: 1,
  retainQuarantinedIdentity: false
};

try {
  const ledger = initializeRegressionFixtureLedger({ secretDir, name: "001", runId });
  appendRegressionFixturePrepared(ledger.writer, fixture);
  let snapshot = readRegressionFixtureLedger({ secretDir, reference: ledger.reference });
  assert.equal(snapshot.entries.length, 1);
  assert.equal(snapshot.entries[0].state, "PREPARED");

  const authenticBytes = readFileSync(ledger.path);
  const tamperedBytes = Buffer.from(authenticBytes);
  tamperedBytes[tamperedBytes.length - 2] ^= 1;
  writeFileSync(ledger.path, tamperedBytes);
  assert.throws(
    () => appendRegressionFixtureState(ledger.writer, fixture.registrationId, "CLOSED"),
    /signature|hash chain|invalid JSONL/,
    "a changed writer snapshot must fully re-verify and reject any tampered ledger"
  );
  writeFileSync(ledger.path, authenticBytes);
  writeFileSync(ledger.path, `${JSON.stringify({ version: 1, runId, entries: [] })}\n`);
  assert.throws(
    () => readRegressionFixtureLedger({ secretDir, reference: ledger.reference }),
    /header|identity|signature/,
    "an unsigned empty ledger must never erase prepared fixture ownership"
  );
  writeFileSync(ledger.path, authenticBytes);
  snapshot = readRegressionFixtureLedger({ secretDir, reference: ledger.reference });
  assert.equal(snapshot.entries[0].state, "PREPARED");

  assert.throws(
    () => appendRegressionFixtureState({}, fixture.registrationId, "CLOSED"),
    /writer capability is invalid/,
    "a manifest-created object must not obtain the signing authority"
  );

  sealRegressionFixtureLedgerPrivilegedPathApi();
  assert.throws(
    () => readRegressionFixtureLedger({ secretDir, reference: ledger.reference }),
    /privileged path API is sealed/,
    "the manifest-visible module must not retain path-based ledger authority"
  );
  assert.throws(
    () => initializeRegressionFixtureLedger({ secretDir, name: "002", runId }),
    /privileged path API is sealed/,
    "the manifest must not create residue through the preloaded helper"
  );

  appendRegressionFixtureState(ledger.writer, fixture.registrationId, "CLOSED");
  const sealed = sealRegressionFixtureLedger(ledger.writer);
  assert.equal(sealed.sealed, true);
  assert.equal(sealed.entries[0].state, "CLOSED");

  console.log(JSON.stringify({
    ok: true,
    unsignedEmptyLedgerRejected: true,
    writerTamperReverified: true,
    unbrandedWriterRejected: true,
    privilegedPathApiSealed: true,
    brandedAppendAfterSealVerified: true
  }));
} finally {
  rmSync(secretDir, { recursive: true, force: true });
}
