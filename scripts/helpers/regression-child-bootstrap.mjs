import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { closeSync } from "node:fs";

const childScriptPath = String(process.argv[2] || "");
const authHelperPath = String(process.argv[3] || "");
const childGuardPath = String(process.argv[4] || "");
const parentWatchdogPath = String(process.argv[5] || "");
const fixtureLedgerHelperPath = String(process.argv[6] || "");
const parentDeathKill = process.kill.bind(process);
let parentWatchdogDescriptorOpen = process.platform !== "win32";

if (process.platform !== "win32") {
  if (process.env.JDY_REGRESSION_PARENT_WATCHDOG_FD !== "6" || !parentWatchdogPath) {
    throw new Error("regression parent watchdog capability is unavailable");
  }
  let watchdog;
  try {
    watchdog = spawn(process.execPath, ["--no-addons", parentWatchdogPath, String(process.pid)], {
      cwd: process.cwd(),
      detached: false,
      env: {},
      stdio: [6, "ignore", "ignore"]
    });
    watchdog.unref();
  } finally {
    delete process.env.JDY_REGRESSION_PARENT_WATCHDOG_FD;
  }
}

process.stdin.once("end", () => {
  if (process.platform !== "win32") {
    try {
      // The runner creates this process as its own process-group leader and the
      // guard rewrites every approved nested launch into that same owned group.
      // Import completion is not process completion: a manifest can finish its
      // top-level await while an owned browser or backend still keeps this
      // bootstrap alive. The runner never closes this control pipe during a
      // normal child lifetime, so every observed EOF is a parent-death signal.
      parentDeathKill(-process.pid, "SIGKILL");
    } catch {
      process.exitCode = 1;
    }
  }
});

process.stdin.once("data", async () => {
  let guard;
  try {
    if (!fixtureLedgerHelperPath) {
      throw new Error("regression fixture ledger helper capability is unavailable");
    }
    const fixtureLedgerHelper = await import(pathToFileURL(fixtureLedgerHelperPath).href);
    // Consume the unlink-on-open credential and construct the private signed
    // fixture-ledger writer before the guard seals every public suite-lock
    // mutator. Builtin ESM bindings are synchronized to the guard afterwards,
    // so later auth subprocess calls still traverse the guarded child policy.
    await import(pathToFileURL(authHelperPath).href);
    // regression-auth consumes and removes this public environment marker as
    // soon as it captures fd 3. Re-expose only the fixed descriptor number so
    // the subsequently loaded guard can bind the same inherited pipe, then the
    // guard removes the marker again before the manifest receives control.
    process.env.JDY_REGRESSION_SECRET_REPORT_FD = "3";
    guard = await import(pathToFileURL(childGuardPath).href);
    guard.assertRegressionChildProcessGuardInstalled(
      process.env.JDY_REGRESSION_CHILD_GUARD_TOKEN
    );
    fixtureLedgerHelper.sealRegressionFixtureLedgerPrivilegedPathApi();
    if (parentWatchdogDescriptorOpen) {
      closeSync(6);
      parentWatchdogDescriptorOpen = false;
    }
    await import(pathToFileURL(childScriptPath).href);
  } catch (error) {
    console.error(error instanceof Error ? (error.stack || error.message) : String(error));
    process.exitCode = 1;
  } finally {
    if (parentWatchdogDescriptorOpen) {
      try { closeSync(6); } catch { /* Preserve the primary bootstrap failure. */ }
      parentWatchdogDescriptorOpen = false;
    }
    try {
      guard?.sealRegressionDetachedSpawnLedger();
    } catch (error) {
      console.error(error instanceof Error ? (error.stack || error.message) : String(error));
      process.exitCode = 1;
    }
    // Keep the pipe flowing so a later kernel EOF is observable even after the
    // imported module has resolved. unref prevents the control pipe itself from
    // prolonging an otherwise completed child.
    process.stdin.resume();
    process.stdin.unref?.();
  }
});

process.stdin.resume();
