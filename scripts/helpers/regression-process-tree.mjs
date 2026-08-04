import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const ownershipDriftCode = "REGRESSION_PROCESS_OWNERSHIP_DRIFT";
const unprovenIdentityCode = "REGRESSION_PROCESS_IDENTITY_UNPROVEN";
const unprovenRootCode = "REGRESSION_PROCESS_ROOT_UNPROVEN";
const persistedLedgerCode = "REGRESSION_PERSISTED_PROCESS_LEDGER_UNPROVEN";
// A43 legitimately launches hundreds of short-lived guarded Docker commands.
// Keep the process-identity envelope above the reviewed per-child Docker
// intent recovery cap (4,096) so a valid concurrent peak cannot turn into a false
// ownership escape, while remaining bounded for lock/recovery handling.
const maximumPersistedMembers = 4_096;

function normalizedPid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 1 ? pid : 0;
}

function commandFingerprint(command) {
  return createHash("sha256").update(String(command)).digest("hex");
}

function normalizedPersistedMember(member, expectedGroupId) {
  const pid = normalizedPid(member?.pid);
  const parentPid = Number(member?.parentPidAtProof ?? member?.parentPid);
  const pgid = Number(member?.pgidAtProof ?? member?.pgid);
  const lstart = String(member?.lstart ?? "").trim().replace(/\s+/g, " ");
  const fingerprint = String(member?.commandFingerprint ?? "");
  if (!pid
    || !Number.isInteger(parentPid)
    || parentPid < 0
    || !Number.isInteger(pgid)
    || pgid <= 0
    || (pid === expectedGroupId && pgid !== expectedGroupId)
    || !lstart
    || !/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw Object.assign(new Error("persisted regression process ledger contains invalid identity metadata"), {
      code: persistedLedgerCode
    });
  }
  return {
    pid,
    lstart,
    commandFingerprint: fingerprint,
    parentPidAtProof: parentPid,
    pgidAtProof: pgid,
    proof: pid === expectedGroupId ? "root" : "descendant"
  };
}

function normalizedPersistedCollection(members, groupId) {
  if (!Array.isArray(members) || members.length > maximumPersistedMembers) {
    throw Object.assign(new Error("persisted regression process ledger member count is invalid"), {
      code: persistedLedgerCode
    });
  }
  const normalized = members.map((member) => normalizedPersistedMember(member, groupId));
  const uniquePids = new Set(normalized.map(({ pid }) => pid));
  if (uniquePids.size !== normalized.length) {
    throw Object.assign(new Error("persisted regression process ledger contains duplicate PIDs"), {
      code: persistedLedgerCode
    });
  }
  return normalized;
}

export function adoptRegressionProcessLedgerRecords({ ledger = [], records = [], groupId }) {
  const normalizedGroupId = normalizedPid(groupId);
  if (!normalizedGroupId) {
    throw Object.assign(new Error("persisted regression process ledger group id is invalid"), {
      code: persistedLedgerCode
    });
  }
  const previous = normalizedPersistedCollection(ledger, normalizedGroupId);
  const adopted = normalizedPersistedCollection(records, normalizedGroupId);
  const merged = new Map(previous.map((member) => [member.pid, member]));
  for (const record of adopted) {
    const existing = merged.get(record.pid);
    if (existing && existing.lstart !== record.lstart) {
      throw Object.assign(new Error(`persisted regression process PID ${record.pid} was reused`), {
        code: persistedLedgerCode
      });
    }
    // The sidecar carries the durable detached-group proof. Preserve its PGID/parent
    // proof while retaining a newer command hash observed online after a legal exec.
    merged.set(record.pid, existing
      ? { ...record, commandFingerprint: existing.commandFingerprint }
      : record);
  }
  if (merged.size > maximumPersistedMembers) {
    throw Object.assign(new Error("persisted regression process ledger exceeded its safe member bound"), {
      code: persistedLedgerCode
    });
  }
  return [...merged.values()].sort((left, right) => left.pid - right.pid);
}

export function mergeRegressionProcessGroupLedger({ ledger = [], members = [], groupId }) {
  const normalizedGroupId = normalizedPid(groupId);
  if (!normalizedGroupId) {
    throw Object.assign(new Error("persisted regression process ledger group id is invalid"), {
      code: persistedLedgerCode
    });
  }
  const previous = normalizedPersistedCollection(ledger, normalizedGroupId);
  const current = normalizedPersistedCollection(members, normalizedGroupId);
  const previousByPid = new Map(previous.map((member) => [member.pid, member]));
  const currentByPid = new Map(current.map((member) => [member.pid, member]));
  const continuityAnchors = previous.filter((member) => {
    const observed = currentByPid.get(member.pid);
    return observed?.lstart === member.lstart;
  });
  if (previous.length === 0) {
    const root = currentByPid.get(normalizedGroupId);
    if (!root) {
      throw Object.assign(new Error("regression process root exited before its ownership ledger was persisted"), {
        code: persistedLedgerCode
      });
    }
  } else if (current.length > 0 && continuityAnchors.length === 0) {
    throw Object.assign(new Error("regression process group continuity cannot be proven from its persisted members"), {
      code: persistedLedgerCode
    });
  }
  const authorizedPids = new Set();
  const anchoredGroups = new Set();
  if (previous.length === 0) {
    authorizedPids.add(normalizedGroupId);
    anchoredGroups.add(normalizedGroupId);
  }
  for (const member of continuityAnchors) {
    const observed = currentByPid.get(member.pid);
    authorizedPids.add(member.pid);
    if (observed.pgidAtProof === member.pgidAtProof) anchoredGroups.add(observed.pgidAtProof);
  }
  const unresolved = new Map(current
    .filter((member) => !previousByPid.has(member.pid))
    .map((member) => [member.pid, member]));
  let progress = true;
  while (progress && unresolved.size > 0) {
    progress = false;
    for (const member of unresolved.values()) {
      if (anchoredGroups.has(member.pgidAtProof)
        || authorizedPids.has(member.parentPidAtProof)) {
        authorizedPids.add(member.pid);
        anchoredGroups.add(member.pgidAtProof);
        unresolved.delete(member.pid);
        progress = true;
      }
    }
  }
  if (unresolved.size > 0) {
    throw Object.assign(new Error(
      `regression process groups have no same-group or live-parent continuity anchor: ${[...unresolved.keys()].sort((a, b) => a - b).join(",")}`
    ), { code: persistedLedgerCode });
  }
  const merged = new Map(previousByPid);
  for (const member of current) {
    const existing = previousByPid.get(member.pid);
    if (existing && existing.lstart !== member.lstart) {
      throw Object.assign(new Error(`persisted regression process PID ${member.pid} was reused`), {
        code: persistedLedgerCode
      });
    }
    // PID+lstart proves the live identity online. Persist the latest command hash after a legal exec.
    merged.set(member.pid, existing ? { ...existing, commandFingerprint: member.commandFingerprint } : member);
  }
  if (merged.size > maximumPersistedMembers) {
    // Exited identities no longer require a termination signal. Compact to the complete
    // live snapshot rather than ever persisting an invalid >512 ledger. The remaining
    // live PID+lstart anchors still prevent adoption of a numerically reused group.
    if (current.length > maximumPersistedMembers) {
      throw Object.assign(new Error("live regression process ledger exceeds its safe member bound"), {
        code: persistedLedgerCode
      });
    }
    return [...current].sort((left, right) => left.pid - right.pid);
  }
  return [...merged.values()].sort((left, right) => left.pid - right.pid);
}

export function classifyRegressionProcessGroupLedger({ ledger = [], members = [], groupId }) {
  const normalizedGroupId = normalizedPid(groupId);
  if (!normalizedGroupId) {
    throw Object.assign(new Error("persisted regression process ledger group id is invalid"), {
      code: persistedLedgerCode
    });
  }
  const persisted = normalizedPersistedCollection(ledger, normalizedGroupId);
  const current = normalizedPersistedCollection(members, normalizedGroupId);
  const persistedByPid = new Map(persisted.map((member) => [member.pid, member]));
  const currentByPid = new Map(current.map((member) => [member.pid, member]));
  const matching = [];
  const drifted = [];
  const unproven = [];
  for (const member of current) {
    const expected = persistedByPid.get(member.pid);
    if (!expected) {
      unproven.push(member);
    } else if (expected.lstart === member.lstart
      && expected.commandFingerprint === member.commandFingerprint) {
      matching.push(member);
    } else {
      drifted.push(member);
    }
  }
  const exited = persisted.filter((member) => !currentByPid.has(member.pid));
  const relocated = matching.filter((member) => member.pgidAtProof !== normalizedGroupId);
  return { matching, drifted, unproven, exited, relocated };
}

export function selectRegressionProcessOwnershipMembers({
  members = [],
  groupId,
  persistedPids = [],
  persistedProcessGroups = []
}) {
  const normalizedGroupId = normalizedPid(groupId);
  if (!normalizedGroupId
    || !Array.isArray(members)
    || !Array.isArray(persistedPids)
    || !Array.isArray(persistedProcessGroups)) {
    throw Object.assign(new Error("regression process ownership snapshot selection is invalid"), {
      code: persistedLedgerCode
    });
  }
  const persisted = new Set(persistedPids.map(normalizedPid).filter(Boolean));
  const processGroups = new Set(persistedProcessGroups.map(normalizedPid).filter(Boolean));
  const byPid = new Map();
  for (const member of members) {
    // `ps -axo` includes the init/launchd row (PID 1, PPID 0). It cannot be a
    // descendant of a runner-owned group (which always has a PID above 1), so
    // ignore it before applying the ownership-record validation below.
    if (Number(member?.pid) === 1) continue;
    const pid = normalizedPid(member?.pid);
    const parentPid = Number(member?.parentPid);
    const pgid = Number(member?.pgid);
    if (!pid || !Number.isInteger(parentPid) || parentPid < 0 || !Number.isInteger(pgid) || pgid <= 0) {
      // PIDs are operating-system metadata rather than regression credentials.
      // Keeping this bounded context makes a fail-closed launch rejection
      // diagnosable without exposing a child command line or environment.
      throw Object.assign(new Error(
        `regression process ownership snapshot member is invalid (pid=${String(member?.pid)}, parentPid=${String(member?.parentPid)}, pgid=${String(member?.pgid)})`
      ), {
        code: persistedLedgerCode
      });
    }
    if (byPid.has(pid)) {
      throw Object.assign(new Error(`regression process ownership snapshot duplicates PID ${pid}`), {
        code: persistedLedgerCode
      });
    }
    byPid.set(pid, member);
  }
  const selected = new Map([...byPid.values()]
    .filter((member) => Number(member.pgid) === normalizedGroupId
      || persisted.has(Number(member.pid))
      || processGroups.has(Number(member.pgid)))
    .map((member) => [Number(member.pid), member]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const member of byPid.values()) {
      if (selected.has(member.pid) || !selected.has(member.parentPid)) continue;
      selected.set(member.pid, member);
      changed = true;
    }
  }
  return [...selected.values()].sort((left, right) => left.pid - right.pid);
}

function mergeIdentityObservations(target, members) {
  for (const member of members) {
    const key = `${member.pid}:${member.lstart}:${member.commandFingerprint}`;
    if (!target.has(key)) target.set(key, member);
  }
}

export function signalRegressionProcessGroupLedger({
  ledger = [],
  groupId,
  signal = "SIGTERM",
  snapshotMembers,
  signalProcess
}) {
  if (typeof snapshotMembers !== "function" || typeof signalProcess !== "function") {
    throw new Error("persisted regression process signaling requires snapshot and signal adapters");
  }
  const drifted = new Map();
  const unproven = new Map();
  const observe = () => {
    const members = snapshotMembers();
    if (!Array.isArray(members)) {
      throw new Error("persisted regression process snapshot adapter must return an array");
    }
    const classification = classifyRegressionProcessGroupLedger({ ledger, members, groupId });
    mergeIdentityObservations(drifted, classification.drifted);
    mergeIdentityObservations(unproven, classification.unproven);
    return classification;
  };

  const initial = observe();
  const signaled = [];
  for (const candidate of initial.matching) {
    // Re-read the process table immediately before every signal. PID reuse, exec drift,
    // or leaving the recorded process group must turn this candidate into a no-op.
    const current = observe();
    if (!current.matching.some((member) => member.pid === candidate.pid)) continue;
    try {
      signalProcess(candidate.pid, signal);
      signaled.push(candidate.pid);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  const final = observe();
  return {
    signaled,
    matching: final.matching,
    drifted: [...drifted.values()],
    unproven: [...unproven.values()],
    exited: final.exited,
    relocated: final.relocated,
    ambiguous: drifted.size > 0 || unproven.size > 0
  };
}

function systemProcessSnapshot() {
  const output = execFileSync("ps", ["-ww", "-axo", "pid=,ppid=,state=,lstart=,comm="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return output.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/);
    return match ? [{
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      state: match[3],
      lstart: match[4].replace(/\s+/g, " "),
      command: match[5]
    }] : [];
  });
}

function normalizedSnapshot(rows) {
  const snapshot = new Map();
  for (const row of rows) {
    const pid = normalizedPid(row?.pid);
    const parentPid = Number(row?.parentPid);
    const lstart = String(row?.lstart ?? "").trim().replace(/\s+/g, " ");
    const command = String(row?.command ?? "");
    if (!pid) continue;
    if (String(row?.state ?? "").startsWith("Z")) continue;
    if (!Number.isInteger(parentPid) || parentPid < 0 || !lstart || !command) {
      throw new Error("regression process snapshot contains invalid identity metadata");
    }
    if (snapshot.has(pid)) throw new Error(`regression process snapshot contains duplicate PID ${pid}`);
    snapshot.set(pid, {
      pid,
      parentPid,
      lstart,
      commandFingerprint: commandFingerprint(command)
    });
  }
  return snapshot;
}

function immutableRecord(row, parentPid, depth) {
  return Object.freeze({
    pid: row.pid,
    parentPid,
    depth,
    lstart: row.lstart,
    commandFingerprint: row.commandFingerprint
  });
}

function identityMatches(record, row) {
  return record.lstart === row.lstart
    && record.commandFingerprint === row.commandFingerprint;
}

function ownershipDrift(record, row) {
  return Object.assign(new Error(`regression process ownership drift for PID ${record.pid}`), {
    code: ownershipDriftCode,
    expected: { lstart: record.lstart, commandFingerprint: record.commandFingerprint },
    observed: { lstart: row.lstart, commandFingerprint: row.commandFingerprint }
  });
}

function unprovenIdentity(message) {
  return Object.assign(new Error(message), { code: unprovenIdentityCode });
}

function validateKnownIdentities(known, snapshot) {
  for (const record of known.values()) {
    const row = snapshot.get(record.pid);
    if (!row) continue;
    if (record.lstart !== row.lstart) throw ownershipDrift(record, row);
    if (!identityMatches(record, row)) {
      // PID+lstart is the live identity. A command change is a legal exec transition;
      // refresh its hash online so later cleanup can still revalidate exactly.
      known.set(record.pid, immutableRecord(row, record.parentPid, record.depth));
    }
  }
}

const defaultSignalProcess = (pid, signal, processInfo) => process.kill(pid, signal, processInfo.child);
const defaultRegisterSignalTarget = (pid, processInfo) => process.kill(pid, 0, processInfo.child);
const noSignalTargetRegistration = () => {};

export function createRegressionProcessTreeController({
  snapshotProcesses = systemProcessSnapshot,
  signalProcess = defaultSignalProcess,
  registerSignalTarget = signalProcess === defaultSignalProcess
    ? defaultRegisterSignalTarget
    : noSignalTargetRegistration,
  pollIntervalMs = 100,
  identityStabilizationMs = 400
} = {}) {
  if (typeof snapshotProcesses !== "function"
    || typeof signalProcess !== "function"
    || typeof registerSignalTarget !== "function") {
    throw new Error("regression process tree adapters must be functions");
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 0
    || !Number.isInteger(identityStabilizationMs) || identityStabilizationMs < 0) {
    throw new Error("regression process tree timing options must be non-negative integers");
  }
  const processTreeState = Symbol("regressionProcessTreeState");

  function takeSnapshot() {
    const rows = snapshotProcesses();
    if (!Array.isArray(rows)) throw new Error("regression process snapshot adapter must return an array");
    return normalizedSnapshot(rows);
  }

  function stopMonitor(state) {
    if (!state.monitor) return;
    clearInterval(state.monitor);
    state.monitor = null;
  }

  function stateFor(processInfo) {
    const state = processInfo?.[processTreeState];
    if (!state) {
      throw Object.assign(new Error("regression process tree must be registered immediately after spawn"), {
        code: unprovenRootCode
      });
    }
    if (state.monitorError) throw state.monitorError;
    return state;
  }

  function addCandidate(state, row, parentPid, depth, now) {
    // In guarded child processes this signal-0 call registers a PID+lstart proof
    // while the original root/group continuity anchor is still live. The proof
    // remains opaque in the guard's WeakMap and permits exact cleanup after a
    // leader exits and the proven descendant is reparented.
    registerSignalTarget(row.pid, state.processInfo);
    state.candidates.set(row.pid, {
      pid: row.pid,
      parentPid,
      depth,
      lstart: row.lstart,
      commandFingerprint: row.commandFingerprint,
      stableSince: now
    });
  }

  function promoteStableCandidates(state, snapshot, now) {
    for (const candidate of [...state.candidates.values()]) {
      const row = snapshot.get(candidate.pid);
      if (!row) {
        // A short-lived candidate that is already gone cannot survive cleanup.
        // Drop it; any still-live descendant remains discoverable from a proven parent
        // or is contained by the outer runner's detached process-group ledger.
        state.candidates.delete(candidate.pid);
        continue;
      }
      if (candidate.lstart !== row.lstart) throw ownershipDrift(candidate, row);
      if (candidate.commandFingerprint !== row.commandFingerprint) {
        candidate.commandFingerprint = row.commandFingerprint;
        candidate.stableSince = now;
        continue;
      }
      if (now - candidate.stableSince < identityStabilizationMs) continue;
      state.known.set(candidate.pid, immutableRecord(row, candidate.parentPid, candidate.depth));
      state.candidates.delete(candidate.pid);
    }
  }

  function discoverCandidates(state, snapshot, now) {
    const childrenByParent = new Map();
    for (const row of snapshot.values()) {
      const children = childrenByParent.get(row.parentPid) || [];
      children.push(row);
      childrenByParent.set(row.parentPid, children);
    }
    const pending = [...state.known.values()].filter((record) => snapshot.has(record.pid));
    const visited = new Set();
    while (pending.length > 0) {
      const parent = pending.pop();
      if (visited.has(parent.pid)) continue;
      visited.add(parent.pid);
      for (const child of childrenByParent.get(parent.pid) || []) {
        if (child.pid === process.pid) continue;
        const known = state.known.get(child.pid);
        if (known) {
          pending.push(known);
          continue;
        }
        if (!state.candidates.has(child.pid)) {
          addCandidate(state, child, parent.pid, parent.depth + 1, now);
        }
      }
    }
    promoteStableCandidates(state, snapshot, now);
  }

  function refresh(processInfo) {
    const state = stateFor(processInfo);
    const snapshot = takeSnapshot();
    const now = Date.now();
    validateKnownIdentities(state.known, snapshot);
    promoteStableCandidates(state, snapshot, now);
    discoverCandidates(state, snapshot, now);
    validateKnownIdentities(state.known, snapshot);
    const alive = [...state.known.keys(), ...state.candidates.keys()].some((pid) => snapshot.has(pid));
    if (!alive) stopMonitor(state);
    return { state, snapshot, alive };
  }

  function register(processInfo) {
    const existing = processInfo?.[processTreeState];
    if (existing) {
      refresh(processInfo);
      return processInfo;
    }
    const rootPid = normalizedPid(processInfo?.child?.pid);
    if (!rootPid) {
      throw Object.assign(new Error("regression process tree root PID is unavailable at registration"), {
        code: unprovenRootCode
      });
    }
    const snapshot = takeSnapshot();
    const root = snapshot.get(rootPid);
    if (!root) {
      throw Object.assign(new Error(`regression process tree root PID ${rootPid} exited before registration`), {
        code: unprovenRootCode
      });
    }
    const state = {
      rootPid,
      processInfo,
      known: new Map(),
      candidates: new Map(),
      monitor: null,
      monitorError: null
    };
    Object.defineProperty(processInfo, processTreeState, { value: state, enumerable: false });
    addCandidate(state, root, 0, 0, Date.now());
    promoteStableCandidates(state, snapshot, Date.now());
    discoverCandidates(state, snapshot, Date.now());
    if (pollIntervalMs > 0) {
      state.monitor = setInterval(() => {
        try {
          refresh(processInfo);
        } catch (error) {
          state.monitorError = error;
          stopMonitor(state);
        }
      }, pollIntervalMs);
      state.monitor.unref?.();
    }
    return processInfo;
  }

  function isAlive(processInfo) {
    return refresh(processInfo).alive;
  }

  function signal(processInfo, signalName) {
    let current = refresh(processInfo);
    if (current.state.candidates.size > 0) {
      throw unprovenIdentity(`regression process tree has unproven PIDs: ${[...current.state.candidates.keys()].join(",")}`);
    }
    const records = [...current.state.known.values()]
      .filter(({ pid }) => current.snapshot.has(pid) && pid !== process.pid)
      .sort((left, right) => right.depth - left.depth
        || Number(left.pid === current.state.rootPid) - Number(right.pid === current.state.rootPid));
    const signaledPids = [];
    for (const record of records) {
      current = refresh(processInfo);
      if (current.state.candidates.size > 0) {
        throw unprovenIdentity(`regression process tree discovered unproven PIDs before signal: ${[...current.state.candidates.keys()].join(",")}`);
      }
      if (!current.snapshot.has(record.pid)) continue;
      try {
        signalProcess(record.pid, signalName, processInfo);
        signaledPids.push(record.pid);
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    return signaledPids;
  }

  return Object.freeze({ register, isAlive, signal });
}

const defaultController = createRegressionProcessTreeController();

export function registerRegressionProcessTree(processInfo) {
  return defaultController.register(processInfo);
}

export function regressionProcessTreeIsAlive(processInfo) {
  return defaultController.isAlive(processInfo);
}

export function signalRegressionProcessTree(processInfo, signal) {
  return defaultController.signal(processInfo, signal);
}
