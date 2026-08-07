#!/usr/bin/env node

import assert from "node:assert/strict";

import {
  encodeRegressionSecretFrame,
  RegressionSecretFrameCollector
} from "./helpers/regression-secret-channel.mjs";

const firstSecret = "session-contract-value-01";
const secondSecret = "SESSION=contract-cookie-value-02";
const frames = encodeRegressionSecretFrame(firstSecret) + encodeRegressionSecretFrame(secondSecret);
const collector = new RegressionSecretFrameCollector();
collector.push(frames.slice(0, 7));
collector.push(Buffer.from(frames.slice(7, 31)));
collector.push(frames.slice(31));
const collected = collector.finish();
assert.equal(collected.ok, true, "fragmented sidecar frames must close successfully");
assert.deepEqual([...collected.values].sort(), [firstSecret, secondSecret].sort());

const incomplete = new RegressionSecretFrameCollector();
incomplete.push(encodeRegressionSecretFrame(firstSecret).trimEnd());
const incompleteResult = incomplete.finish();
assert.equal(incompleteResult.ok, false, "a sidecar frame without its newline boundary must fail closed");
assert.match(incompleteResult.error, /incomplete/);

const invalidUtf8 = new RegressionSecretFrameCollector();
invalidUtf8.push(`${Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa, 0xf9, 0xf8]).toString("base64url")}\n`);
const invalidUtf8Result = invalidUtf8.finish();
assert.equal(invalidUtf8Result.ok, false, "non-UTF-8 payloads must not enter the redaction set");
assert.match(invalidUtf8Result.error, /UTF-8/);

const overflow = new RegressionSecretFrameCollector();
overflow.push("a".repeat(2_000_001));
const overflowResult = overflow.finish();
assert.equal(overflowResult.ok, false, "unbounded sidecar buffering must fail closed");
assert.match(overflowResult.error, /bounded buffer/);

const frameBoundary = new RegressionSecretFrameCollector();
const repeatedSmallFrame = encodeRegressionSecretFrame("12345678");
for (let index = 0; index < 4096; index += 1) frameBoundary.push(repeatedSmallFrame);
const frameBoundaryResult = frameBoundary.finish();
assert.equal(frameBoundaryResult.ok, true, "the exact cumulative frame boundary must remain valid");

const frameOverflow = new RegressionSecretFrameCollector();
for (let index = 0; index < 4097; index += 1) frameOverflow.push(repeatedSmallFrame);
const frameOverflowResult = frameOverflow.finish();
assert.equal(frameOverflowResult.ok, false, "duplicate frames must still consume the cumulative frame budget");
assert.match(frameOverflowResult.error, /cumulative frame limit/);

const decodedByteBoundary = new RegressionSecretFrameCollector();
const maximumValueFrame = encodeRegressionSecretFrame("x".repeat(4096));
for (let index = 0; index < 256; index += 1) decodedByteBoundary.push(maximumValueFrame);
const decodedByteBoundaryResult = decodedByteBoundary.finish();
assert.equal(decodedByteBoundaryResult.ok, true, "the exact cumulative decoded-byte boundary must remain valid");

const decodedByteOverflow = new RegressionSecretFrameCollector();
for (let index = 0; index < 257; index += 1) decodedByteOverflow.push(maximumValueFrame);
const decodedByteOverflowResult = decodedByteOverflow.finish();
assert.equal(decodedByteOverflowResult.ok, false, "duplicate values must still consume the decoded-byte budget");
assert.match(decodedByteOverflowResult.error, /cumulative decoded byte limit/);

assert.equal(encodeRegressionSecretFrame("short"), "", "short non-secret values must not create sidecar frames");
assert.equal(encodeRegressionSecretFrame("x".repeat(4097)), "", "oversized values must not create sidecar frames");

console.log(JSON.stringify({
  ok: true,
  fragmentedFrames: 2,
  failClosedCases: 5,
  cumulativeFrameBoundary: 4096,
  cumulativeDecodedByteBoundary: 1_048_576
}));
