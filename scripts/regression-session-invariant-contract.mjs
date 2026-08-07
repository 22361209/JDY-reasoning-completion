#!/usr/bin/env node

import assert from "node:assert/strict";

import {
  assertMainRegressionRedisTarget,
  captureUserSessionInvariant,
  createIsolatedAdminSessionFixture,
  resolveRegressionSessionLogicalExpiry,
  retryRegressionRedisInvariantCapture
} from "./helpers/regression-auth.mjs";
import { assertRedisDigestEvolution } from "./helpers/regression-preflight.mjs";

assert.deepEqual(assertMainRegressionRedisTarget({}), {
  container: "jdy-erp-redis",
  database: 0
}, "the main invariant must bind the canonical Redis container and DB 0");
assert.throws(() => assertMainRegressionRedisTarget({ JDY_REDIS_DB: "1" }),
  /must be jdy-erp-redis DB 0/,
  "an alternate Redis database must fail before invariant capture");
assert.throws(() => assertMainRegressionRedisTarget({ JDY_REDIS_CONTAINER: "alternate-redis" }),
  /must be jdy-erp-redis DB 0/,
  "an alternate Redis container must fail before invariant capture");

const fixture = createIsolatedAdminSessionFixture("http://127.0.0.1:8080", {
  label: "redis_expiry_contract",
  allowForcedRedisRelease: true
});
let retryAttempts = 0;
const retriedSnapshot = retryRegressionRedisInvariantCapture(() => {
  retryAttempts += 1;
  if (retryAttempts < 3) {
    throw Object.assign(new Error("simulated whole-snapshot expiry race"), {
      code: "REGRESSION_REDIS_INVARIANT_CAPTURE_RACE"
    });
  }
  return { attempt: retryAttempts, complete: true };
}, { pause: () => {} });
assert.deepEqual(retriedSnapshot, { attempt: 3, complete: true },
  "a disappearing key must restart the entire Redis invariant capture");
let nonRaceAttempts = 0;
assert.throws(() => retryRegressionRedisInvariantCapture(() => {
  nonRaceAttempts += 1;
  throw new Error("non-race failure");
}, { pause: () => {} }), /non-race failure/);
assert.equal(nonRaceAttempts, 1, "non-race invariant failures must not be retried");
let primaryError = null;
try {
  await fixture.login("BLD-TEST");
  const invariant = captureUserSessionInvariant(fixture.username);
  assert.deepEqual(invariant.redis.target, { container: "jdy-erp-redis", database: 0 });
  assert.equal(invariant.redis.primarySessions.length, 1, "the fixture must own exactly one primary Redis session");
  assert(invariant.redis.relatedKeys.length <= 1, "the primary hash must not be duplicated as a related key");
  const [primary] = invariant.redis.primarySessions;
  const [expiresKey] = invariant.redis.relatedKeys;
  if (expiresKey) {
    assert.equal(expiresKey.primaryKeyDigest, primary.keyDigest,
      "the expires key must prove which primary session owns its logical boundary");
    assert(primary.expiresAtEpochMs >= expiresKey.expiresAtEpochMs,
      "the primary physical TTL must not precede its logical expires-key boundary");
  }
  assert.equal(primary.expiryBoundarySource, "primary-key",
    "primary disappearance must be judged by its own physical TTL, including any grace period");
  assert.equal(resolveRegressionSessionLogicalExpiry({
    primaryExpiresAtEpochMs: 1_300,
    expiresKeyExpiresAtEpochMs: 1_000,
    expirationBucketEpochMs: 1_100
  }), 1_000, "an expires key must win over the primary hash grace TTL and bucket fallback");

  assert.deepEqual(assertRedisDigestEvolution({
    before: [{ keyDigest: "primary", contentDigest: "stable", expiresAtEpochMs: 1_000 }],
    current: [],
    digestField: "keyDigest",
    expiryField: "expiresAtEpochMs",
    observedAtEpochMs: 1_000,
    label: "logical expiry contract"
  }), { expired: 1 });
  assert.throws(() => assertRedisDigestEvolution({
    before: [{ keyDigest: "primary", contentDigest: "stable", expiresAtEpochMs: 1_000 }],
    current: [{ keyDigest: "primary", contentDigest: "stable", expiresAtEpochMs: 1_300 }],
    digestField: "keyDigest",
    expiryField: "expiresAtEpochMs",
    observedAtEpochMs: 1_000,
    label: "primary TTL extension contract"
  }), /content or expiry boundary changed/,
  "a retained key may not extend or revive its captured absolute expiry boundary");
  assert.throws(() => assertRedisDigestEvolution({
    before: [{ keyDigest: "primary", contentDigest: "stable", expiresAtEpochMs: 1_000 }],
    current: [],
    digestField: "keyDigest",
    expiryField: "expiresAtEpochMs",
    observedAtEpochMs: 999,
    label: "early disappearance contract"
  }), /before its captured expiry boundary/);
} catch (error) {
  primaryError = error;
} finally {
  try {
    await fixture.cleanup({ allowForcedRedisRelease: true });
  } catch (cleanupError) {
    if (primaryError) throw new AggregateError([primaryError, cleanupError], "session invariant contract and cleanup failed");
    throw cleanupError;
  }
}
if (primaryError) throw primaryError;

console.log(JSON.stringify({
  ok: true,
  logicalPrimaryExpiryVerified: true,
  duplicatePrimaryKeyExcluded: true,
  wholeSnapshotExpiryRetryVerified: true
}));
