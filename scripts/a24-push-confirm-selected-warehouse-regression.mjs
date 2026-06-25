import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const resultPath = path.join(rootDir, "verification/a24-push-confirm-selected-warehouse-regression.json");

const result = {
  generatedAt: new Date().toISOString(),
  status: "retired",
  reason: "A93 removed warehouse override from the sales outbound push confirmation dialog. The warehouse is carried from source lines and can be edited in the sales out draft.",
  replacement: "scripts/a93-sales-out-source-selection-regression.mjs",
  removedAssertions: [
    "push-confirm-warehouse-code",
    "push-confirm-apply-warehouse",
    "selected-line warehouse override"
  ]
};

await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
