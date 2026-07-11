import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  deriveEffectiveFeatureScopeFromFiles,
  serializeEffectiveFeatureScope,
  serializeFrontendFeatureScope,
} from "./helpers/effective-feature-scope.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const approvedScopePath = path.join(rootDir, "config/approved-feature-scope.json");
const implementationOverridesPath = path.join(rootDir, "config/implementation-overrides.json");
const effectiveScopePath = path.join(rootDir, "config/effective-feature-scope.json");
const frontendScopePath = path.join(rootDir, "frontend/src/app/featureScope.ts");

const expectedScope = await deriveEffectiveFeatureScopeFromFiles({
  approvedScopePath,
  implementationOverridesPath,
});
const expected = serializeEffectiveFeatureScope(expectedScope);
const expectedFrontend = serializeFrontendFeatureScope(expectedScope);

let actual;
try {
  actual = await readFile(effectiveScopePath, "utf8");
} catch (error) {
  throw new Error(
    "缺少 config/effective-feature-scope.json，请先运行 node generate-frontend-scope.mjs",
    { cause: error },
  );
}

if (actual !== expected) {
  throw new Error(
    "config/effective-feature-scope.json 与原始审批 + implementation overrides 不一致，请运行 node generate-frontend-scope.mjs 后提交生成物",
  );
}

let actualFrontend;
try {
  actualFrontend = await readFile(frontendScopePath, "utf8");
} catch (error) {
  throw new Error(
    "缺少 frontend/src/app/featureScope.ts，请先运行 node generate-frontend-scope.mjs",
    { cause: error },
  );
}

if (actualFrontend !== expectedFrontend) {
  throw new Error(
    "frontend/src/app/featureScope.ts 与有效范围不一致，请运行 node generate-frontend-scope.mjs 后提交生成物",
  );
}

const overridden = expectedScope.features.filter((feature) => (
  feature.decision !== feature.originalDecision
  || feature.approval !== feature.originalApproval
  || feature.targetVersion !== feature.originalTargetVersion
));

console.log(JSON.stringify({
  ok: true,
  total: expectedScope.features.length,
  overridden: overridden.map((feature) => feature.id),
  effectiveScope: path.relative(rootDir, effectiveScopePath),
  frontendScope: path.relative(rootDir, frontendScopePath),
}, null, 2));
