import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const baselinePath = path.join(rootDir, "verification/a2-a95-regression-latest.json");
const resultPath = path.join(rootDir, "verification/a2-a96-regression-latest.json");
const expectedMinimum = 84;
const appendedScripts = [
  "scripts/a96-master-selector-dialog-regression.mjs"
];

const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const scripts = [
  ...baseline.results.map((result) => result.script),
  ...appendedScripts
];
const startedAt = new Date().toISOString();
const results = [];

await mkdir(path.dirname(resultPath), { recursive: true });

for (const script of scripts) {
  const started = Date.now();
  const startedAtScript = new Date(started).toISOString();
  const result = await runScript(script);
  const finished = Date.now();
  const entry = {
    script,
    ok: result.status === 0,
    status: result.status,
    durationMs: finished - started,
    startedAt: startedAtScript,
    finishedAt: new Date(finished).toISOString(),
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr)
  };
  results.push(entry);
  console.log(JSON.stringify({ script, ok: entry.ok, status: entry.status, durationMs: entry.durationMs }));
  if (entry.status !== 0) {
    break;
  }
}

const bad = results.filter((result) => result.status !== 0);
const summary = {
  generatedAt: new Date().toISOString(),
  ok: bad.length === 0 && results.length === scripts.length && scripts.length >= expectedMinimum,
  total: results.length,
  expectedMinimum,
  expectedTotal: scripts.length,
  badCount: bad.length,
  skipped: scripts.length - results.length,
  startedAt,
  finishedAt: new Date().toISOString(),
  note: "A96 full suite: A95 baseline plus shared master selector full-list dialog browsing, search and row backfill regression.",
  results
};

await writeFile(resultPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({
  ok: summary.ok,
  total: summary.total,
  expectedTotal: summary.expectedTotal,
  badCount: summary.badCount,
  skipped: summary.skipped,
  resultPath: "verification/a2-a96-regression-latest.json"
}, null, 2));

if (!summary.ok) {
  process.exit(1);
}

function runScript(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { cwd: rootDir });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function tail(value, max = 4000) {
  return value.length > max ? value.slice(-max) : value;
}
