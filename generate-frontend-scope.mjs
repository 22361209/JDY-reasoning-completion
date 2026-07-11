import fs from "node:fs/promises";
import path from "node:path";
import {
  deriveEffectiveFeatureScopeFromFiles,
  getFrontendFeatureScopeFeatures,
  serializeFrontendFeatureScope,
  writeEffectiveFeatureScope,
} from "./scripts/helpers/effective-feature-scope.mjs";

const rootDir = import.meta.dirname;
const scopePath = path.join(rootDir, "config/approved-feature-scope.json");
const overridePath = path.join(rootDir, "config/implementation-overrides.json");
const effectiveScopePath = path.join(rootDir, "config/effective-feature-scope.json");
const outputPath = path.join(rootDir, "frontend/src/app/featureScope.ts");

const effectiveScope = await deriveEffectiveFeatureScopeFromFiles({
  approvedScopePath: scopePath,
  implementationOverridesPath: overridePath,
});
await writeEffectiveFeatureScope(effectiveScopePath, effectiveScope);

const features = getFrontendFeatureScopeFeatures(effectiveScope);
const content = serializeFrontendFeatureScope(effectiveScope);

await fs.writeFile(outputPath, content);
console.log(`wrote ${features.length} features to ${outputPath}`);
