import fs from "node:fs/promises";

const scopePath = "/Users/linzhenyue/Projects/JDY 推理补完/config/approved-feature-scope.json";
const overridePath = "/Users/linzhenyue/Projects/JDY 推理补完/config/implementation-overrides.json";
const outputPath = "/Users/linzhenyue/Projects/JDY 推理补完/frontend/src/app/featureScope.ts";

const scope = JSON.parse(await fs.readFile(scopePath, "utf8"));
let overrides = { overrides: {} };

try {
  overrides = JSON.parse(await fs.readFile(overridePath, "utf8"));
} catch {
  overrides = { overrides: {} };
}

const features = scope.features
  .map((feature) => ({ ...feature, ...(overrides.overrides[feature.id] || {}) }))
  .filter((feature) => feature.decision !== "exclude")
  .map((feature) => ({
    id: feature.id,
    module: feature.module === "全局框架" ? "首页工作台" : feature.module,
    feature: feature.feature,
    description: feature.description,
    approval: feature.approval,
    decision: feature.decision,
    priority: feature.priority,
    targetVersion: feature.targetVersion,
    note: feature.note || "",
  }));

const content = `export type FeatureDecision = "build" | "simple" | "optional" | "later";

export interface FeatureScopeItem {
  id: string;
  module: string;
  feature: string;
  description: string;
  approval: string;
  decision: FeatureDecision;
  priority: string;
  targetVersion: string;
  note: string;
}

export const featureScope: FeatureScopeItem[] = ${JSON.stringify(features, null, 2)} as FeatureScopeItem[];
`;

await fs.writeFile(outputPath, content);
console.log(`wrote ${features.length} features to ${outputPath}`);
