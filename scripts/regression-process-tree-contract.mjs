#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

import {
  adoptRegressionProcessLedgerRecords,
  classifyRegressionProcessGroupLedger,
  createRegressionProcessTreeController,
  mergeRegressionProcessGroupLedger,
  registerRegressionProcessTree,
  regressionProcessTreeIsAlive,
  selectRegressionProcessOwnershipMembers,
  signalRegressionProcessGroupLedger,
  signalRegressionProcessTree
} from "./helpers/regression-process-tree.mjs";

function assertPersistedGroupLedgerContract() {
  const hash = (character) => character.repeat(64);
  const root = {
    pid: 43_001,
    parentPid: 42_000,
    pgid: 43_001,
    lstart: "Mon Aug 3 09:00:00 2026",
    commandFingerprint: hash("a")
  };
  const descendant = {
    pid: 43_002,
    parentPid: 43_001,
    pgid: 43_001,
    lstart: "Mon Aug 3 09:00:01 2026",
    commandFingerprint: hash("b")
  };
  let ledger = mergeRegressionProcessGroupLedger({
    ledger: [],
    members: [root, descendant],
    groupId: root.pid
  });
  assert.equal(ledger.length, 2);

  ledger = mergeRegressionProcessGroupLedger({
    ledger,
    members: [{ ...root }, { ...descendant, commandFingerprint: hash("c") }],
    groupId: root.pid
  });
  assert.equal(ledger.find(({ pid }) => pid === descendant.pid)?.commandFingerprint, hash("c"),
    "online PID+lstart continuity must persist a legal exec command change");

  const leaderExited = classifyRegressionProcessGroupLedger({
    ledger,
    members: [{ ...descendant, commandFingerprint: hash("c") }],
    groupId: root.pid
  });
  assert.deepEqual(leaderExited.matching.map(({ pid }) => pid), [descendant.pid]);
  assert.deepEqual(leaderExited.exited.map(({ pid }) => pid), [root.pid]);

  const reused = classifyRegressionProcessGroupLedger({
    ledger,
    members: [{ ...descendant, lstart: "Mon Aug 3 10:00:01 2026", commandFingerprint: hash("d") }],
    groupId: root.pid
  });
  assert.deepEqual(reused.matching, []);
  assert.deepEqual(reused.drifted.map(({ pid }) => pid), [descendant.pid]);

  const mixed = classifyRegressionProcessGroupLedger({
    ledger,
    members: [{ ...descendant, commandFingerprint: hash("c") }, {
      pid: 43_003,
      parentPid: 1,
      pgid: root.pid,
      lstart: "Mon Aug 3 09:00:02 2026",
      commandFingerprint: hash("e")
    }],
    groupId: root.pid
  });
  assert.deepEqual(mixed.matching.map(({ pid }) => pid), [descendant.pid]);
  assert.deepEqual(mixed.unproven.map(({ pid }) => pid), [43_003]);

  let liveMembers = [{ ...descendant, commandFingerprint: hash("c") }, {
    pid: 43_003,
    parentPid: 1,
    pgid: root.pid,
    lstart: "Mon Aug 3 09:00:02 2026",
    commandFingerprint: hash("e")
  }];
  const exactSignals = [];
  const exactSignalReport = signalRegressionProcessGroupLedger({
    ledger,
    groupId: root.pid,
    signal: "SIGKILL",
    snapshotMembers: () => liveMembers,
    signalProcess: (pid, signal) => {
      exactSignals.push({ pid, signal });
      liveMembers = liveMembers.filter((member) => member.pid !== pid);
    }
  });
  assert.deepEqual(exactSignals, [{ pid: descendant.pid, signal: "SIGKILL" }],
    "mixed groups must signal only exact persisted identities");
  assert.equal(exactSignalReport.ambiguous, true,
    "an unproven group member must retain the ownership ambiguity after exact cleanup");

  let reuseSnapshotCount = 0;
  const reuseSignals = [];
  const reuseSignalReport = signalRegressionProcessGroupLedger({
    ledger,
    groupId: root.pid,
    signal: "SIGTERM",
    snapshotMembers: () => {
      reuseSnapshotCount += 1;
      return reuseSnapshotCount === 1
        ? [{ ...descendant, commandFingerprint: hash("c") }]
        : [{ ...descendant, lstart: "Mon Aug 3 12:00:01 2026", commandFingerprint: hash("d") }];
    },
    signalProcess: (pid, signal) => reuseSignals.push({ pid, signal })
  });
  assert.deepEqual(reuseSignals, [], "PID identity must be revalidated immediately before every signal");
  assert.equal(reuseSignalReport.ambiguous, true);

  const escaped = classifyRegressionProcessGroupLedger({
    ledger,
    members: [{ ...descendant, pgid: 99_999, commandFingerprint: hash("c") }],
    groupId: root.pid
  });
  assert.deepEqual(escaped.matching.map(({ pid }) => pid), [descendant.pid]);
  assert.deepEqual(escaped.relocated.map(({ pid }) => pid), [descendant.pid],
    "a persisted exact identity may be diagnosed as relocated without losing ownership");
  let escapedMembers = [{ ...descendant, pgid: 99_999, commandFingerprint: hash("c") }];
  const escapedSignals = [];
  const escapedSignalReport = signalRegressionProcessGroupLedger({
    ledger,
    groupId: root.pid,
    signal: "SIGKILL",
    snapshotMembers: () => escapedMembers,
    signalProcess: (pid, signal) => {
      escapedSignals.push({ pid, signal });
      escapedMembers = [];
    }
  });
  assert.deepEqual(escapedSignals, [{ pid: descendant.pid, signal: "SIGKILL" }],
    "an exact persisted identity must remain individually terminable after changing PGID");
  assert.equal(escapedSignalReport.ambiguous, false);

  const boundedRootPid = 50_000;
  const boundedLedger = Array.from({ length: 512 }, (_, index) => ({
    pid: boundedRootPid + index,
    parentPid: index === 0 ? 49_999 : boundedRootPid,
    pgid: boundedRootPid,
    lstart: `Mon Aug 3 09:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")} 2026`,
    commandFingerprint: hash(index % 2 === 0 ? "a" : "b")
  }));
  const compactedLedger = mergeRegressionProcessGroupLedger({
    ledger: boundedLedger,
    members: [boundedLedger[0], {
      pid: 51_000,
      parentPid: boundedRootPid,
      pgid: 51_000,
      lstart: "Mon Aug 3 10:00:00 2026",
      commandFingerprint: hash("f")
    }],
    groupId: boundedRootPid
  });
  assert.equal(compactedLedger.length, 2,
    "a full historical ledger plus a new live member must compact before persistence");
  assert.deepEqual(compactedLedger.map(({ pid }) => pid), [boundedRootPid, 51_000]);

  const detachedSelection = selectRegressionProcessOwnershipMembers({
    members: [{
      pid: 1,
      parentPid: 0,
      pgid: 1,
      lstart: "Mon Aug 3 09:00:00 2026",
      commandFingerprint: hash("init")
    }, root, {
      pid: 43_010,
      parentPid: root.pid,
      pgid: 43_010,
      lstart: "Mon Aug 3 09:00:03 2026",
      commandFingerprint: hash("d")
    }, {
      pid: 43_011,
      parentPid: 43_010,
      pgid: 43_010,
      lstart: "Mon Aug 3 09:00:04 2026",
      commandFingerprint: hash("e")
    }, {
      pid: 43_012,
      parentPid: 1,
      pgid: 43_012,
      lstart: "Mon Aug 3 09:00:05 2026",
      commandFingerprint: hash("f")
    }],
    groupId: root.pid
  });
  assert.deepEqual(detachedSelection.map(({ pid }) => pid), [root.pid, 43_010, 43_011],
    "a live detached descendant chain must remain selected while the global init row is ignored");

  const detachedLeader = {
    pid: 43_010,
    parentPid: root.pid,
    pgid: 43_010,
    lstart: "Mon Aug 3 09:00:03 2026",
    commandFingerprint: hash("d")
  };
  const ledgerWithDetachedLeader = adoptRegressionProcessLedgerRecords({
    ledger,
    records: [detachedLeader],
    groupId: root.pid
  });
  const reparentedDetachedMember = {
    pid: 43_011,
    parentPid: 1,
    pgid: detachedLeader.pid,
    lstart: "Mon Aug 3 09:00:04 2026",
    commandFingerprint: hash("e")
  };
  const anchoredDetachedMerge = mergeRegressionProcessGroupLedger({
    ledger: ledgerWithDetachedLeader,
    members: [
      { ...root },
      { ...detachedLeader, parentPid: 1 },
      reparentedDetachedMember
    ],
    groupId: root.pid
  });
  assert(anchoredDetachedMerge.some(({ pid }) => pid === reparentedDetachedMember.pid),
    "a live same-PGID detached anchor must authorize its reparented group member");
  assert.throws(() => mergeRegressionProcessGroupLedger({
    ledger: ledgerWithDetachedLeader,
    members: [{ ...root }, {
      ...reparentedDetachedMember,
      pid: 43_099,
      parentPid: 1,
      lstart: "Mon Aug 3 11:00:04 2026",
      commandFingerprint: hash("f")
    }],
    groupId: root.pid
  }), (error) => error?.code === "REGRESSION_PERSISTED_PROCESS_LEDGER_UNPROVEN",
  "a continuous outer root cannot authorize reuse of an exited detached PGID");
  assert.throws(() => adoptRegressionProcessLedgerRecords({
    ledger: ledgerWithDetachedLeader,
    records: [{ ...detachedLeader, lstart: "Mon Aug 3 12:00:03 2026" }],
    groupId: root.pid
  }), (error) => error?.code === "REGRESSION_PERSISTED_PROCESS_LEDGER_UNPROVEN",
  "a sidecar must not replace a persisted PID with a reused identity");

  assert.throws(() => mergeRegressionProcessGroupLedger({
    ledger,
    members: [{
      pid: 43_004,
      parentPid: 1,
      pgid: root.pid,
      lstart: "Mon Aug 3 11:00:00 2026",
      commandFingerprint: hash("f")
    }],
    groupId: root.pid
  }), (error) => error?.code === "REGRESSION_PERSISTED_PROCESS_LEDGER_UNPROVEN",
  "a fully reused numeric group must not be adopted without a persisted continuity anchor");
}

const stubbornDescendantSource = `
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
`;
const leaderSource = `
  const { spawn } = require("node:child_process");
  const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(stubbornDescendantSource)}], {
    detached: false,
    stdio: "ignore"
  });
  console.log(descendant.pid);
  setInterval(() => {}, 1_000);
`;

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function firstLine(stream, timeoutMs) {
  const reader = createInterface({ input: stream });
  try {
    const timeout = sleep(timeoutMs, undefined, { ref: false }).then(() => {
      throw new Error("timed out waiting for descendant PID");
    });
    const [line] = await Promise.race([once(reader, "line"), timeout]);
    return line;
  } finally {
    reader.close();
  }
}

function assertIdentityReuseIsRejected() {
  const root = {
    pid: 41_001,
    parentPid: 1,
    lstart: "Mon Aug 3 08:00:00 2026",
    command: "node contract-leader"
  };
  const descendant = {
    pid: 41_002,
    parentPid: root.pid,
    lstart: "Mon Aug 3 08:00:01 2026",
    command: "node owned-descendant"
  };
  let snapshot = [root, descendant];
  const signals = [];
  const controller = createRegressionProcessTreeController({
    snapshotProcesses: () => snapshot,
    signalProcess: (pid, signal) => signals.push({ pid, signal }),
    pollIntervalMs: 0,
    identityStabilizationMs: 0
  });
  const processInfo = { child: { pid: root.pid } };
  controller.register(processInfo);

  snapshot = [root];
  assert.equal(controller.isAlive(processInfo), true, "live leader should retain the absent descendant identity ledger");
  snapshot = [root, {
    ...descendant,
    parentPid: 1,
    lstart: "Mon Aug 3 08:01:01 2026",
    command: "node unrelated-reused-pid"
  }];
  assert.throws(
    () => controller.isAlive(processInfo),
    (error) => error?.code === "REGRESSION_PROCESS_OWNERSHIP_DRIFT",
    "alive check must reject a reused descendant PID"
  );
  assert.throws(
    () => controller.signal(processInfo, "SIGKILL"),
    (error) => error?.code === "REGRESSION_PROCESS_OWNERSHIP_DRIFT",
    "signal must reject a reused descendant PID"
  );
  assert.deepEqual(signals, [], "ownership drift must never reach the signal adapter");
}

function assertMissingRootRegistrationFailsClosed() {
  const signals = [];
  const controller = createRegressionProcessTreeController({
    snapshotProcesses: () => [],
    signalProcess: (pid, signal) => signals.push({ pid, signal }),
    pollIntervalMs: 0,
    identityStabilizationMs: 0
  });
  assert.throws(
    () => controller.register({ child: { pid: 42_001 } }),
    (error) => error?.code === "REGRESSION_PROCESS_ROOT_UNPROVEN",
    "a leader that exited before registration must not produce an unproven empty closure"
  );
  assert.deepEqual(signals, [], "unproven registration must never signal a PID");
}

function assertKnownExecRefreshesIdentity() {
  const root = {
    pid: 42_101,
    parentPid: 1,
    lstart: "Mon Aug 3 08:30:00 2026",
    command: "node original-command"
  };
  let snapshot = [root];
  const signals = [];
  const controller = createRegressionProcessTreeController({
    snapshotProcesses: () => snapshot,
    signalProcess: (pid, signal) => signals.push({ pid, signal }),
    pollIntervalMs: 0,
    identityStabilizationMs: 0
  });
  const processInfo = { child: { pid: root.pid } };
  controller.register(processInfo);
  snapshot = [{ ...root, command: "node command-after-exec" }];
  assert.equal(controller.isAlive(processInfo), true,
    "same PID+lstart must accept and persist a legal exec command transition");
  controller.signal(processInfo, "SIGTERM");
  assert.deepEqual(signals, [{ pid: root.pid, signal: "SIGTERM" }]);
}

async function assertShortLivedCandidateDoesNotPoisonCleanup() {
  const root = {
    pid: 42_201,
    parentPid: 1,
    lstart: "Mon Aug 3 08:40:00 2026",
    command: "node stable-root"
  };
  const child = {
    pid: 42_202,
    parentPid: root.pid,
    lstart: "Mon Aug 3 08:40:01 2026",
    command: "node short-lived-child"
  };
  let snapshot = [root];
  const controller = createRegressionProcessTreeController({
    snapshotProcesses: () => snapshot,
    signalProcess: () => {},
    pollIntervalMs: 0,
    identityStabilizationMs: 20
  });
  const processInfo = { child: { pid: root.pid } };
  controller.register(processInfo);
  await sleep(25);
  assert.equal(controller.isAlive(processInfo), true);
  snapshot = [root, child];
  assert.equal(controller.isAlive(processInfo), true);
  snapshot = [root];
  assert.equal(controller.isAlive(processInfo), true,
    "an already-exited candidate must not leave a permanent ownership error");
}

assertIdentityReuseIsRejected();
assertMissingRootRegistrationFailsClosed();
assertKnownExecRefreshesIdentity();
await assertShortLivedCandidateDoesNotPoisonCleanup();
assertPersistedGroupLedgerContract();

const leader = spawn(process.execPath, ["-e", leaderSource], {
  detached: false,
  stdio: ["ignore", "pipe", "inherit"]
});
const processInfo = { child: leader };
let descendantPid = 0;

try {
  registerRegressionProcessTree(processInfo);
  descendantPid = Number(await firstLine(leader.stdout, 5_000));
  assert(Number.isInteger(descendantPid) && descendantPid > 1, "contract descendant PID is invalid");
  await waitFor(
    () => pidIsAlive(descendantPid) && regressionProcessTreeIsAlive(processInfo),
    5_000,
    "leader and descendant process tree"
  );
  await sleep(1_000);

  const termSignals = signalRegressionProcessTree(processInfo, "SIGTERM");
  assert(termSignals.includes(leader.pid), "TERM did not include the exact leader PID");
  assert(termSignals.includes(descendantPid), "TERM did not include the exact descendant PID");
  await Promise.race([
    once(leader, "exit"),
    sleep(5_000, undefined, { ref: false }).then(() => {
      throw new Error("leader did not exit after SIGTERM");
    })
  ]);

  assert(pidIsAlive(descendantPid), "stubborn descendant should survive TERM for escalation coverage");
  assert(regressionProcessTreeIsAlive(processInfo), "known descendant was lost after its leader exited");
  const killSignals = signalRegressionProcessTree(processInfo, "SIGKILL");
  assert(killSignals.includes(descendantPid), "KILL did not retain the exact known descendant PID");
  await waitFor(
    () => !pidIsAlive(descendantPid) && !regressionProcessTreeIsAlive(processInfo),
    5_000,
    "process tree SIGKILL cleanup"
  );

  console.log(JSON.stringify({
    ok: true,
    leaderPid: leader.pid,
    descendantPid,
    identityReuseRejected: true,
    missingRootRejected: true,
    legalExecRefreshed: true,
    shortLivedCandidateIgnored: true,
    retainedAfterLeaderExit: true,
    persistedGroupLedgerVerified: true,
    exactPersistedSignalsVerified: true,
    relocatedIdentitySignaled: true,
    boundedLedgerCompactionVerified: true,
    detachedDescendantSelected: true,
    initProcessIgnored: true
  }));
} finally {
  try {
    signalRegressionProcessTree(processInfo, "SIGKILL");
  } catch {
    // The contract reports its primary assertion failure above.
  }
  if (pidIsAlive(descendantPid)) {
    try {
      process.kill(descendantPid, "SIGKILL");
    } catch {
      // Best-effort last resort for the contract's own exact child PID.
    }
  }
  if (pidIsAlive(leader.pid)) {
    try {
      leader.kill("SIGKILL");
    } catch {
      // Best-effort last resort for the contract's direct child.
    }
  }
}
