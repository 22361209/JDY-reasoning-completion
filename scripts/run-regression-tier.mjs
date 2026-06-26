import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const latestFullPath = path.join(rootDir, "verification/a2-a110-regression-latest.json");
const verificationDir = path.join(rootDir, "verification");
const fullTailScripts = [
  "scripts/a112-table-core-scroll-regression.mjs"
];

const smokeScripts = [
  "scripts/a59-formal-login-regression.mjs",
  "scripts/a90-numbering-regression.mjs",
  "scripts/a85-finance-posting-regression.mjs",
  "scripts/a86-other-stock-in-regression.mjs",
  "scripts/a87-other-stock-out-regression.mjs",
  "scripts/a93-sales-out-source-selection-regression.mjs",
  "scripts/a94-tax-amount-regression.mjs",
  "scripts/a105-bill-lifecycle-regression.mjs",
  "scripts/a108-delivery-notice-reservation-regression.mjs",
  "scripts/a110-table-display-brand-regression.mjs"
];

const areaScripts = {
  sales: [
    "scripts/a89-sales-order-detail-pushdown-regression.mjs",
    "scripts/a92-sales-document-fields-regression.mjs",
    "scripts/a93-sales-out-source-selection-regression.mjs",
    "scripts/a94-tax-amount-regression.mjs",
    "scripts/a98-line-level-source-regression.mjs",
    "scripts/a100-purchase-direct-push-regression.mjs",
    "scripts/a103-price-memory-regression.mjs",
    "scripts/a108-delivery-notice-reservation-regression.mjs"
  ],
  purchase: [
    "scripts/a92-sales-document-fields-regression.mjs",
    "scripts/a94-tax-amount-regression.mjs",
    "scripts/a100-purchase-direct-push-regression.mjs"
  ],
  inventory: [
    "scripts/a85-finance-posting-regression.mjs",
    "scripts/a86-other-stock-in-regression.mjs",
    "scripts/a87-other-stock-out-regression.mjs",
    "scripts/a87-stock-transfer-regression.mjs",
    "scripts/a88-stock-count-regression.mjs",
    "scripts/a88-stock-count-gain-regression.mjs",
    "scripts/a88-stock-count-loss-regression.mjs",
    "scripts/a101-stock-alert-regression.mjs",
    "scripts/a108-delivery-notice-reservation-regression.mjs"
  ],
  finance: [
    "scripts/a85-finance-posting-regression.mjs",
    "scripts/a94-tax-amount-regression.mjs"
  ],
  lifecycle: [
    "scripts/a95-lifecycle-workbench-regression.mjs",
    "scripts/a104-document-lock-regression.mjs",
    "scripts/a105-bill-lifecycle-regression.mjs"
  ],
  table: [
    "scripts/a91-frontend-ux-regression.mjs",
    "scripts/a96-master-selector-dialog-regression.mjs",
    "scripts/a97-entry-table-ux-regression.mjs",
    "scripts/a102-core-flow-ui-regression.mjs",
    "scripts/a106-detail-view-regression.mjs",
    "scripts/a107-table-structure-regression.mjs",
    "scripts/a110-table-display-brand-regression.mjs"
  ],
  security: [
    "scripts/a54-role-permission-matrix-regression.mjs",
    "scripts/a55-permission-driven-ui-regression.mjs",
    "scripts/a56-backend-permission-guard-regression.mjs",
    "scripts/a59-formal-login-regression.mjs",
    "scripts/a60-password-session-regression.mjs",
    "scripts/a61-login-lock-audit-regression.mjs",
    "scripts/a67-cross-tab-session-regression.mjs",
    "scripts/a68-single-active-session-regression.mjs",
    "scripts/a69-security-settings-policy-regression.mjs",
    "scripts/a70-session-timeout-settings-regression.mjs",
    "scripts/a71-password-policy-settings-regression.mjs"
  ],
  print: [
    "scripts/a38-document-pdf-output-regression.mjs",
    "scripts/a39-core-document-pdf-regression.mjs",
    "scripts/a40-production-document-pdf-regression.mjs",
    "scripts/a46-document-print-template-regression.mjs",
    "scripts/a47-print-template-settings-regression.mjs",
    "scripts/a52-print-template-role-default-regression.mjs",
    "scripts/a53-production-red-source-print-regression.mjs",
    "scripts/a63-print-page-settings-regression.mjs"
  ]
};

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: node scripts/run-regression-tier.mjs smoke|area:<module>|full

Examples:
  node scripts/run-regression-tier.mjs smoke
  node scripts/run-regression-tier.mjs area:sales
  node scripts/run-regression-tier.mjs full

Areas:
  ${Object.keys(areaScripts).sort().join(", ")}`);
  process.exit(0);
}

const tier = process.argv[2] ?? "smoke";
const startedAt = new Date().toISOString();
const scripts = await scriptsForTier(tier);
const safeTier = tier.replace(/[^a-zA-Z0-9_-]/g, "-");
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
  console.log(JSON.stringify({ tier, script, ok: entry.ok, status: entry.status, durationMs: entry.durationMs }));
  if (!entry.ok) {
    break;
  }
}

const bad = results.filter((result) => !result.ok);
const summary = {
  generatedAt: new Date().toISOString(),
  tier,
  ok: bad.length === 0 && results.length === scripts.length,
  total: results.length,
  expectedTotal: scripts.length,
  badCount: bad.length,
  skipped: scripts.length - results.length,
  startedAt,
  finishedAt: new Date().toISOString(),
  resultPath: path.relative(rootDir, resultPath),
  availableAreas: Object.keys(areaScripts).sort(),
  results
};

await writeFile(resultPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({
  ok: summary.ok,
  tier,
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
    const baseline = JSON.parse(await readFile(latestFullPath, "utf8"));
    return unique([...baseline.results.map((result) => result.script), ...fullTailScripts]);
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
    const child = spawn(process.execPath, [script], { cwd: rootDir });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function unique(values) {
  return [...new Set(values)];
}

function tail(value, max = 4000) {
  return value.length > max ? value.slice(-max) : value;
}
