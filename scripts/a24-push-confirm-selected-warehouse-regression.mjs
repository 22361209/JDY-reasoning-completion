import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const resultPath = path.join(rootDir, "verification/a24-push-confirm-selected-warehouse-regression.json");

const result = {
  generatedAt: new Date().toISOString(),
  status: "retired",
  reason: "A100 retired pre-draft selected-line warehouse override for both sales and purchase pushdown. Warehouses are carried from source lines and can be edited in the downstream draft.",
  replacement: "scripts/a100-purchase-direct-push-regression.mjs and scripts/a93-sales-out-source-selection-regression.mjs",
  removedAssertions: [
    "pre-draft warehouse code",
    "apply warehouse before draft",
    "selected-line warehouse override"
  ]
};

await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
