import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadRegressionManifest } from "./validate-regression-manifest.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const { manifest, summary: manifestSummary } = await loadRegressionManifest(rootDir);
const smokeScripts = manifest.smoke;
const areaScripts = manifest.areas;
const fullScripts = manifest.full;

const args = process.argv.slice(2);
const continueOnFailure = args.includes("--continue-on-failure") || args.includes("--continue");
const listOnly = args.includes("--list");
const requestedTier = args.find((arg) => !arg.startsWith("--")) ?? "smoke";
const tier = requestedTier.endsWith(":continue") ? requestedTier.slice(0, -":continue".length) : requestedTier;
const shouldContinue = continueOnFailure || requestedTier.endsWith(":continue");
const resultTier = shouldContinue && tier === "full" ? "full-continue" : tier;

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: node scripts/run-regression-tier.mjs smoke|area:<module>|full [--continue-on-failure] [--list]

Examples:
  node scripts/run-regression-tier.mjs smoke
  node scripts/run-regression-tier.mjs area:sales
  node scripts/run-regression-tier.mjs full
  node scripts/run-regression-tier.mjs full --continue-on-failure
  node scripts/run-regression-tier.mjs full --list

Areas:
  ${Object.keys(areaScripts).sort().join(", ")}`);
  process.exit(0);
}

const startedAt = new Date().toISOString();
const scripts = await scriptsForTier(tier);
if (listOnly) {
  console.log(JSON.stringify({
    tier,
    total: scripts.length,
    manifest: manifestSummary.manifest,
    scripts
  }, null, 2));
  process.exit(0);
}
if (await requiresTestInventoryAdjustmentApi(scripts)) {
  await requireTestInventoryAdjustmentCapability(tier);
}
const safeTier = resultTier.replace(/[^a-zA-Z0-9_-]/g, "-");
const resultPath = path.join(verificationDir, `regression-tier-${safeTier}-latest.json`);
const results = [];

await mkdir(path.dirname(resultPath), { recursive: true });

for (const script of scripts) {
  const started = Date.now();
  const result = await runScript(script);
  const finished = Date.now();
  const entry = {
    script,
    ok: result.status === 0,
    status: result.status,
    durationMs: finished - started,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr)
  };
  results.push(entry);
  console.log(JSON.stringify({ tier, script, ok: entry.ok, status: entry.status, durationMs: entry.durationMs, continueOnFailure: shouldContinue }));
  if (!entry.ok && !shouldContinue) {
    break;
  }
}

const bad = results.filter((result) => !result.ok);
const summary = {
  generatedAt: new Date().toISOString(),
  tier,
  resultTier,
  continueOnFailure: shouldContinue,
  ok: bad.length === 0 && results.length === scripts.length,
  total: results.length,
  expectedTotal: scripts.length,
  badCount: bad.length,
  skipped: scripts.length - results.length,
  startedAt,
  finishedAt: new Date().toISOString(),
  resultPath: path.relative(rootDir, resultPath),
  manifest: manifestSummary.manifest,
  availableAreas: Object.keys(areaScripts).sort(),
  results
};

await writeFile(resultPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({
  ok: summary.ok,
  tier,
  resultTier,
  continueOnFailure: shouldContinue,
  total: summary.total,
  expectedTotal: summary.expectedTotal,
  badCount: summary.badCount,
  skipped: summary.skipped,
  resultPath: summary.resultPath
}, null, 2));

if (!summary.ok) {
  process.exit(1);
}

async function scriptsForTier(selectedTier) {
  if (selectedTier === "smoke") {
    return smokeScripts;
  }
  if (selectedTier === "full") {
    return fullScripts;
  }
  if (selectedTier.startsWith("area:")) {
    const area = selectedTier.slice("area:".length);
    if (!areaScripts[area]) {
      throw new Error(`Unknown area "${area}". Available: ${Object.keys(areaScripts).sort().join(", ")}`);
    }
    return unique([...smokeScripts, ...areaScripts[area]]);
  }
  throw new Error("Usage: node scripts/run-regression-tier.mjs smoke|area:<module>|full");
}

function runScript(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd: rootDir,
      env: {
        ...process.env,
        JAVA_HOME: process.env.JAVA_HOME || "/opt/homebrew/opt/openjdk@21"
      }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function requiresTestInventoryAdjustmentApi(scripts) {
  for (const script of scripts) {
    const source = await readFile(path.join(rootDir, script), "utf8");
    if (source.includes("/api/inventory/adjustments")) {
      return true;
    }
  }
  return false;
}

async function requireTestInventoryAdjustmentCapability(selectedTier) {
  const healthUrl = "http://127.0.0.1:8080/api/system/health";
  let response;
  try {
    response = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
  } catch (error) {
    throw new Error(`Regression tier ${selectedTier} requires the controlled BLD-TEST inventory fixture API, but backend health is unavailable at ${healthUrl}: ${error}`);
  }
  if (!response.ok) {
    throw new Error(`Regression tier ${selectedTier} requires the controlled BLD-TEST inventory fixture API, but ${healthUrl} returned ${response.status}`);
  }
  let health;
  try {
    health = await response.json();
  } catch (error) {
    throw new Error(`Regression tier ${selectedTier} requires the controlled BLD-TEST inventory fixture API, but backend health was not JSON: ${error}`);
  }
  if (health?.testInventoryAdjustmentApi !== true) {
    throw new Error(`Regression tier ${selectedTier} requires the controlled BLD-TEST inventory fixture API. Restart with ./scripts/dev-down.sh && ./scripts/dev-up.sh before running the tier.`);
  }
  console.log(JSON.stringify({ tier: selectedTier, preflight: "controlled-bld-test-inventory-fixture", ok: true }));
}

function unique(values) {
  return [...new Set(values)];
}

function tail(value, max = 4000) {
  return value.length > max ? value.slice(-max) : value;
}
