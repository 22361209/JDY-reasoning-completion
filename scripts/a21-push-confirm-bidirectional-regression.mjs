import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const resultPath = path.join(rootDir, "verification/a21-push-confirm-bidirectional-regression.json");

const result = {
  generatedAt: new Date().toISOString(),
  status: "retired",
  reason: "A93 retires the sales outbound push confirmation regression. Sales pushdown direct draft and source selection are covered by A93.",
  replacement: "scripts/a93-sales-out-source-selection-regression.mjs",
  removedAssertions: [
    "sales push-confirm-dialog",
    "sales selected-line adjustment",
    "bidirectional sales dialog parity"
  ],
  note: "Purchase inbound confirmation behavior is outside A93 scope and was not expanded here."
};

await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
