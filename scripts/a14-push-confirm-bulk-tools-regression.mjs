import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const resultPath = path.join(rootDir, "verification/a14-push-confirm-bulk-tools-regression.json");

const result = {
  generatedAt: new Date().toISOString(),
  status: "retired",
  reason: "A100 retired the old pre-draft bulk quantity tools for both sales and purchase pushdown. Quantity and warehouse edits now happen in the generated downstream draft.",
  replacement: "scripts/a100-purchase-direct-push-regression.mjs and scripts/a93-sales-out-source-selection-regression.mjs",
  removedAssertions: [
    "clear quantities before draft",
    "fill all remaining before draft",
    "percentage quantity calculation before draft",
    "apply percentage before draft"
  ]
};

await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
