import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const resultPath = path.join(rootDir, "verification/a18-push-confirm-selected-lines-regression.json");

const result = {
  generatedAt: new Date().toISOString(),
  status: "retired",
  reason: "A93 removed selected-line adjustment from the sales outbound push confirmation dialog. The replacement flow carries all remaining lines into the sales out draft.",
  replacement: "scripts/a93-sales-out-source-selection-regression.mjs",
  removedAssertions: [
    "push-confirm-select",
    "push-confirm-selection-summary",
    "selected-line ratio adjustment"
  ]
};

await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
