import { fstatSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

for (const name of [
  "NODE_OPTIONS",
  "NODE_PATH",
  "PLAYWRIGHT_BROWSERS_PATH",
  "DYLD_INSERT_LIBRARIES",
  "LD_PRELOAD",
  "BASH_ENV",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "MAVEN_OPTS",
  "JDY_REGRESSION_CHILD_GUARD_TOKEN",
  "JDY_REGRESSION_DETACHED_SPAWN_LEDGER_FD",
  "JDY_REGRESSION_DETACHED_SPAWN_SIGNING_KEY_FD"
]) {
  if (process.env[name]) throw new Error(`guard probe inherited ${name}`);
}
if (realpathSync(process.env.JAVA_HOME || "") !== realpathSync("/opt/homebrew/opt/openjdk@21")) {
  throw new Error("guard probe did not receive the pinned JAVA_HOME");
}
const secretDescriptor = Number(process.env.JDY_REGRESSION_SECRET_REPORT_FD);
if (!Number.isInteger(secretDescriptor) || secretDescriptor < 3) {
  throw new Error("guard probe did not receive the secret-report descriptor index");
}
fstatSync(secretDescriptor);
const delayMs = Number(process.env.JDY_REGRESSION_CHILD_GUARD_PROBE_DELAY_MS || "400");
if (!Number.isInteger(delayMs) || delayMs < 400 || delayMs > 3_000) {
  throw new Error("guard probe delay is invalid");
}
if (process.env.JDY_REGRESSION_CHILD_GUARD_PROBE_REPARENT === "1") {
  const descendant = spawn(process.execPath, [
    "--no-addons",
    "--eval",
    "setTimeout(() => {}, 3000)"
  ], { stdio: "ignore" });
  if (!Number.isInteger(descendant.pid) || descendant.pid <= 1) {
    throw new Error("guard probe reparent descendant did not start");
  }
  descendant.unref();
  console.log(String(descendant.pid));
}
await sleep(delayMs);
