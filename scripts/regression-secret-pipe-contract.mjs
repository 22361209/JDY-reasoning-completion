#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";

import { RegressionSecretFrameCollector } from "./helpers/regression-secret-channel.mjs";

const helperPath = path.resolve(import.meta.dirname, "helpers/regression-secret-channel.mjs");

await verifySigtermClosesACompleteReport();
await verifyInheritedDescriptorOutlivesLeader();
await verifyBoundedDescriptorFallback();

console.log(JSON.stringify({
  ok: true,
  signal: "SIGTERM",
  inheritedDescriptorEofVerified: true,
  boundedDescriptorFallbackVerified: true
}));

async function verifySigtermClosesACompleteReport() {
  const expectedValues = Array.from(
    { length: 256 },
    (_, index) => `SESSION=pipe-contract-${String(index).padStart(4, "0")}-value`
  );
  const childSource = `
    import { writeSync } from "node:fs";
    import { pathToFileURL } from "node:url";
    const { encodeRegressionSecretFrame } = await import(pathToFileURL(process.argv[1]).href);
    for (const value of JSON.parse(process.argv[2])) writeSync(3, encodeRegressionSecretFrame(value));
    writeSync(1, "READY\\n");
    setInterval(() => {}, 1_000);
  `;
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    childSource,
    helperPath,
    JSON.stringify(expectedValues)
  ], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
  const collector = new RegressionSecretFrameCollector();
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.stdio[3].on("data", (chunk) => collector.push(chunk));
  try {
    await withTimeout(waitForOutput(child.stdout, "READY"), 2_000, "SIGTERM child readiness");
    process.kill(child.pid, "SIGTERM");
    const [[code, signal]] = await withTimeout(Promise.all([
      once(child, "close"),
      once(child.stdio[3], "close")
    ]), 2_000, "SIGTERM child and secret descriptor closure");
    assert.equal(code, null, `SIGTERM child exited with an unexpected code: ${stderr}`);
    assert.equal(signal, "SIGTERM", `child close must report the real SIGTERM signal: ${stderr}`);
    const report = collector.finish();
    assert.equal(report.ok, true, `SIGTERM secret report must close cleanly: ${report.error}`);
    assert.deepEqual([...report.values].sort(), [...expectedValues].sort(),
      "SIGTERM handling must retain every frame written before descriptor EOF");
  } finally {
    killIfAlive(child.pid);
  }
}

async function verifyInheritedDescriptorOutlivesLeader() {
  const firstValue = "SESSION=leader-frame-0001";
  const delayedValue = "SESSION=descendant-frame-0002";
  const descendantSource = `
    import { closeSync, writeSync } from "node:fs";
    import { pathToFileURL } from "node:url";
    const { encodeRegressionSecretFrame } = await import(pathToFileURL(process.argv[1]).href);
    setTimeout(() => {
      writeSync(3, encodeRegressionSecretFrame(process.argv[2]));
      closeSync(3);
    }, 300);
  `;
  const leaderSource = `
    import { spawn } from "node:child_process";
    import { writeSync } from "node:fs";
    import { pathToFileURL } from "node:url";
    const { encodeRegressionSecretFrame } = await import(pathToFileURL(process.argv[1]).href);
    writeSync(3, encodeRegressionSecretFrame(process.argv[2]));
    const holder = spawn(process.execPath, [
      "--input-type=module", "--eval", process.argv[4], process.argv[1], process.argv[3]
    ], { stdio: ["ignore", "ignore", "ignore", 3] });
    holder.unref();
    writeSync(1, "HOLDER:" + holder.pid + "\\n");
  `;
  const leader = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    leaderSource,
    helperPath,
    firstValue,
    delayedValue,
    descendantSource
  ], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
  const collector = new RegressionSecretFrameCollector();
  let holderPid = 0;
  let leaderClosed = false;
  let descriptorClosed = false;
  let delayedDataAfterLeaderClose = false;
  leader.stdio[3].on("data", (chunk) => {
    if (leaderClosed) delayedDataAfterLeaderClose = true;
    collector.push(chunk);
  });
  leader.stdio[3].on("close", () => { descriptorClosed = true; });
  try {
    const holderLine = await withTimeout(waitForOutput(leader.stdout, "HOLDER:"), 2_000, "holder pid");
    holderPid = Number(holderLine.match(/HOLDER:(\d+)/)?.[1] || 0);
    assert(Number.isInteger(holderPid) && holderPid > 0, "leader must report its fd3-holding descendant");
    await withTimeout(once(leader, "exit"), 2_000, "leader exit");
    leaderClosed = true;
    assert.equal(descriptorClosed, false,
      "the parent descriptor must remain open after the leader exits while a descendant owns fd3");
    await withTimeout(once(leader.stdio[3], "close"), 2_000, "inherited fd3 EOF");
    assert.equal(delayedDataAfterLeaderClose, true,
      "the delayed descendant frame must arrive after the leader exit and before EOF");
    const report = collector.finish();
    assert.equal(report.ok, true, `inherited descriptor report must close cleanly: ${report.error}`);
    assert.deepEqual([...report.values].sort(), [firstValue, delayedValue].sort());
  } finally {
    killIfAlive(leader.pid);
    killIfAlive(holderPid);
  }
}

async function verifyBoundedDescriptorFallback() {
  const firstValue = "SESSION=bounded-holder-frame-0003";
  const holderSource = "setInterval(() => {}, 1_000);";
  const leaderSource = `
    import { spawn } from "node:child_process";
    import { writeSync } from "node:fs";
    import { pathToFileURL } from "node:url";
    const { encodeRegressionSecretFrame } = await import(pathToFileURL(process.argv[1]).href);
    writeSync(3, encodeRegressionSecretFrame(process.argv[2]));
    const holder = spawn(process.execPath, ["--input-type=module", "--eval", process.argv[3]], {
      stdio: ["ignore", "ignore", "ignore", 3]
    });
    holder.unref();
    writeSync(1, "HOLDER:" + holder.pid + "\\n");
  `;
  const leader = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    leaderSource,
    helperPath,
    firstValue,
    holderSource
  ], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
  const collector = new RegressionSecretFrameCollector();
  let holderPid = 0;
  leader.stdio[3].on("data", (chunk) => collector.push(chunk));
  try {
    const holderLine = await withTimeout(waitForOutput(leader.stdout, "HOLDER:"), 2_000, "bounded holder pid");
    holderPid = Number(holderLine.match(/HOLDER:(\d+)/)?.[1] || 0);
    assert(Number.isInteger(holderPid) && holderPid > 0, "bounded fallback leader must report its descendant");
    await withTimeout(once(leader, "exit"), 2_000, "bounded fallback leader exit");
    const started = Date.now();
    const descriptorClosed = once(leader.stdio[3], "close");
    await new Promise((resolve) => setTimeout(resolve, 400));
    collector.fail("regression child secret report descriptor did not close within the bounded fallback");
    leader.stdio[3].destroy();
    await withTimeout(descriptorClosed, 1_000, "bounded descriptor destroy");
    const elapsed = Date.now() - started;
    assert(elapsed >= 350 && elapsed < 1_500, `descriptor fallback was not bounded: ${elapsed}ms`);
    assert.equal(leader.stdio[3].destroyed, true, "bounded fallback must destroy the parent descriptor");
    const report = collector.finish();
    assert.equal(report.ok, false, "an inherited descriptor timeout must fail closed");
    assert.match(report.error, /descriptor did not close/);
  } finally {
    killIfAlive(leader.pid);
    killIfAlive(holderPid);
  }
}

function waitForOutput(stream, marker) {
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes(marker)) {
        cleanup();
        resolve(output);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`stream closed before emitting ${marker}: ${output}`));
    };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    stream.on("data", onData);
    stream.once("error", onError);
    stream.once("close", onClose);
  });
}

async function withTimeout(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function killIfAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}
