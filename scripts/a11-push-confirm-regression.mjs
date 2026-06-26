import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const resultPath = path.join(rootDir, "verification/a11-push-confirm-regression.json");

const result = {
  generatedAt: new Date().toISOString(),
  status: "retired",
  reason: "A100 completed pushdown direct-draft parity. Sales order and purchase order pushdown now open downstream drafts directly with all remaining source lines; quantity changes happen in the downstream document.",
  replacement: "scripts/a100-purchase-direct-push-regression.mjs and scripts/a93-sales-out-source-selection-regression.mjs",
  removedAssertions: [
    "confirmation dialog visible before draft",
    "manual quantity adjustment before draft",
    "frontend over-remaining prompt before draft"
  ]
};

await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
