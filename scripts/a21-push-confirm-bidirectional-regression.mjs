import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const resultPath = path.join(rootDir, "verification/a21-push-confirm-bidirectional-regression.json");

const result = {
  generatedAt: new Date().toISOString(),
  status: "retired",
  reason: "A100 retires the bidirectional pushdown confirmation regression. Sales and purchase pushdown direct draft flows are now covered by A93 and A100.",
  replacement: "scripts/a100-purchase-direct-push-regression.mjs and scripts/a93-sales-out-source-selection-regression.mjs",
  removedAssertions: [
    "sales pre-draft confirmation dialog",
    "purchase pre-draft confirmation dialog",
    "bidirectional dialog parity"
  ]
};

await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
