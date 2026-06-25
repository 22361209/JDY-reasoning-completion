import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const resultPath = path.join(rootDir, "verification/a11-push-confirm-regression.json");

const result = {
  generatedAt: new Date().toISOString(),
  status: "retired",
  reason: "A93 removed the sales outbound push confirmation dialog. Sales order pushdown now opens a sales out draft directly with all remaining source lines.",
  replacement: "scripts/a93-sales-out-source-selection-regression.mjs",
  removedAssertions: [
    "push-confirm-dialog visible",
    "push-confirm-qty manual adjustment before draft",
    "push-confirm-error for over remaining quantity"
  ]
};

await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
