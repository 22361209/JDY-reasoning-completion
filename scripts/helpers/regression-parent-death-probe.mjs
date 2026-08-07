import { spawnSync } from "node:child_process";
import { chromium } from "playwright";

// argv[6] is the fixture-ledger helper capability consumed by the bootstrap;
// the probe-specific mode follows it.
const mode = String(process.argv[7] || "completed");
if (mode !== "pending" && mode !== "completed") {
  throw new Error("parent-death probe mode is invalid");
}
await chromium.launch({ headless: true });
const snapshot = String(spawnSync("ps", [
  "-ww", "-axo", "pid=,ppid=,pgid=,state=,lstart=,comm="
], { encoding: "utf8" }).stdout || "");
const chromiumPids = snapshot.split(/\r?\n/).flatMap((line) => {
  if (!line.includes("chrome-headless-shell")) return [];
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+/);
  return Number(match?.[3]) === process.pid ? [Number(match[1])] : [];
});
if (chromiumPids.length === 0) throw new Error("parent-death probe did not find owned Chromium members");
console.log(JSON.stringify({ ready: true, directPid: process.pid, chromiumPids }));
// Deliberately let the imported module resolve while the open Playwright browser
// keeps the bootstrap alive. This covers the parent-death window after top-level
// completion but before the owned process group has actually exited.
if (mode === "pending") await new Promise(() => {});
