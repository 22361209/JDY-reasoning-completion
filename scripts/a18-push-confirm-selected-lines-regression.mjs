import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const resultPath = path.join(rootDir, "verification/a18-push-confirm-selected-lines-regression.json");

const result = {
  generatedAt: new Date().toISOString(),
  status: "retired",
  reason: "A100 retired selected-line pre-draft adjustment for both sales and purchase pushdown. The replacement flow carries all remaining lines into the downstream draft.",
  replacement: "scripts/a100-purchase-direct-push-regression.mjs and scripts/a93-sales-out-source-selection-regression.mjs",
  removedAssertions: [
    "selected pre-draft lines",
    "selected-line adjustment summary",
    "selected-line ratio adjustment"
  ]
};

await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
