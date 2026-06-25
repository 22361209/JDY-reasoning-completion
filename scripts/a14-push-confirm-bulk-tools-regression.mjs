import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const resultPath = path.join(rootDir, "verification/a14-push-confirm-bulk-tools-regression.json");

const result = {
  generatedAt: new Date().toISOString(),
  status: "retired",
  reason: "A93 removed bulk tools from the sales outbound push confirmation dialog. Quantity changes now happen in the generated sales out draft.",
  replacement: "scripts/a93-sales-out-source-selection-regression.mjs",
  removedAssertions: [
    "push-confirm-clear",
    "push-confirm-all",
    "push-confirm-ratio",
    "push-confirm-apply-ratio"
  ]
};

await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
