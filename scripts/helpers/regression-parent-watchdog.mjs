const ownedProcessGroupId = Number(process.argv[2]);
if (!Number.isInteger(ownedProcessGroupId) || ownedProcessGroupId <= 1 || process.platform === "win32") {
  throw new Error("regression parent watchdog requires one owned POSIX process group");
}

const trustedKill = process.kill.bind(process);
let fired = false;
const killOwnedGroup = () => {
  if (fired) return;
  fired = true;
  try {
    trustedKill(-ownedProcessGroupId, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") process.exitCode = 1;
  }
};

// Runner-directed graceful termination must not remove the only kernel-EOF
// watcher before the runner itself has exited. A repeated/escalated SIGKILL is
// still authoritative.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});
process.stdin.once("end", killOwnedGroup);
process.stdin.once("error", killOwnedGroup);
process.stdin.resume();
