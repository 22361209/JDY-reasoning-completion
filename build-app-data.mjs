import fs from "node:fs/promises";

const raw = await fs.readFile("/Users/linzhenyue/Projects/JDY 推理补完/config/approved-feature-scope.json", "utf8");
const scope = JSON.parse(raw);
let overrides = { overrides: {} };
try {
  overrides = JSON.parse(await fs.readFile("/Users/linzhenyue/Projects/JDY 推理补完/config/implementation-overrides.json", "utf8"));
} catch {
  overrides = { overrides: {} };
}

const features = scope.features
  .map((item) => ({ ...item, ...(overrides.overrides[item.id] || {}) }))
  .filter((item) => item.decision !== "exclude");

await fs.writeFile(
  "/Users/linzhenyue/Projects/JDY 推理补完/app/feature-data.js",
  `window.JDY_FEATURES = ${JSON.stringify(features, null, 2)};\n`,
);

console.log(`wrote ${features.length} active features`);
