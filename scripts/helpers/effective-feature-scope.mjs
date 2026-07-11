import { readFile, writeFile } from "node:fs/promises";

const EFFECTIVE_DECISIONS = new Set(["build", "simple", "optional", "later", "exclude"]);
const PROTECTED_OVERRIDE_FIELDS = new Set([
  "id",
  "module",
  "feature",
  "originalApproval",
  "originalDecision",
  "originalTargetVersion",
]);

export function reconcileApprovedFeatureIds({
  existingFeatures,
  candidateFeatures,
}) {
  if (!Array.isArray(existingFeatures)) {
    throw new Error("现有原始审批范围缺少 features 数组，不能安全分配功能 ID");
  }
  if (!Array.isArray(candidateFeatures)) {
    throw new Error("工作簿解析结果缺少 features 数组，不能安全分配功能 ID");
  }

  assertApprovedScope({ features: existingFeatures });
  const existingByIdentity = indexFeaturesByIdentity(
    existingFeatures,
    "现有原始审批范围",
  );
  const candidateByIdentity = indexFeaturesByIdentity(
    candidateFeatures,
    "审批工作簿",
  );

  const deleted = existingFeatures.filter((feature) => (
    !candidateByIdentity.has(featureIdentityKey(feature, "现有原始审批范围"))
  ));
  const added = candidateFeatures.filter((feature) => (
    !existingByIdentity.has(featureIdentityKey(feature, "审批工作簿"))
  ));

  if (deleted.length > 0 || added.length > 0) {
    const details = [];
    if (deleted.length > 0) {
      details.push(
        `工作簿缺少现有功能：${deleted.map((feature) => `${feature.id} ${formatFeatureIdentity(feature)}`).join("；")}`,
      );
    }
    if (added.length > 0) {
      details.push(
        `工作簿出现未分配 ID 的新功能：${added.map(formatFeatureIdentity).join("；")}`,
      );
    }
    throw new Error(
      `审批功能身份集合发生漂移，已拒绝导出以避免 override/status 静默重绑。${details.join(" ")}。新增、删除或重命名功能必须先走显式范围审批与 ID 分配流程。`,
    );
  }

  // 输出顺序也沿用现有审批快照，Excel 行重排不会制造无意义的范围 diff。
  return existingFeatures.map((existingFeature) => {
    const identity = featureIdentityKey(existingFeature, "现有原始审批范围");
    const { id: _candidateId, ...candidateFields } = candidateByIdentity.get(identity);
    return {
      id: existingFeature.id,
      ...candidateFields,
    };
  });
}

export async function readJsonFile(filePath, label) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`无法读取${label}：${filePath}`, { cause: error });
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label}不是合法 JSON：${filePath}`, { cause: error });
  }
}

export function deriveEffectiveFeatureScope({
  approvedScope,
  implementationOverrides,
  approvedScopeRef = "config/approved-feature-scope.json",
  implementationOverridesRef = "config/implementation-overrides.json",
}) {
  assertApprovedScope(approvedScope);
  assertImplementationOverrides(implementationOverrides);

  const approvedIds = new Set(approvedScope.features.map((feature) => feature.id));
  const unknownOverrideIds = Object.keys(implementationOverrides.overrides)
    .filter((id) => !approvedIds.has(id));
  if (unknownOverrideIds.length > 0) {
    throw new Error(`implementation overrides 含未知功能 ID：${unknownOverrideIds.join(", ")}`);
  }

  const features = approvedScope.features.map((feature) => {
    const override = implementationOverrides.overrides[feature.id] ?? {};
    for (const field of Object.keys(override)) {
      if (PROTECTED_OVERRIDE_FIELDS.has(field)) {
        throw new Error(`功能 ${feature.id} 的 override 不得修改受保护字段：${field}`);
      }
    }

    const effectiveFeature = {
      ...feature,
      ...override,
      originalApproval: feature.approval,
      originalDecision: feature.decision,
      originalTargetVersion: feature.targetVersion,
    };
    if (!EFFECTIVE_DECISIONS.has(effectiveFeature.decision)) {
      throw new Error(`功能 ${feature.id} 的有效 decision 非法：${effectiveFeature.decision}`);
    }
    return effectiveFeature;
  });

  return {
    schemaVersion: 1,
    sources: {
      approvedFeatureScope: approvedScopeRef,
      implementationOverrides: implementationOverridesRef,
      approvedGeneratedAt: approvedScope.generatedAt ?? null,
    },
    features,
  };
}

export async function deriveEffectiveFeatureScopeFromFiles({
  approvedScopePath,
  implementationOverridesPath,
  approvedScopeRef = "config/approved-feature-scope.json",
  implementationOverridesRef = "config/implementation-overrides.json",
}) {
  const approvedScope = await readJsonFile(approvedScopePath, "原始审批范围");
  const implementationOverrides = await readJsonFile(implementationOverridesPath, "实施 overrides");
  return deriveEffectiveFeatureScope({
    approvedScope,
    implementationOverrides,
    approvedScopeRef,
    implementationOverridesRef,
  });
}

export function serializeEffectiveFeatureScope(effectiveScope) {
  return `${JSON.stringify(effectiveScope, null, 2)}\n`;
}

export function getFrontendFeatureScopeFeatures(effectiveScope) {
  if (!effectiveScope || !Array.isArray(effectiveScope.features)) {
    throw new Error("有效范围缺少 features 数组，无法生成前端 featureScope");
  }

  return effectiveScope.features
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
}

export function serializeFrontendFeatureScope(effectiveScope) {
  const features = getFrontendFeatureScopeFeatures(effectiveScope);
  return `export type FeatureDecision = "build" | "simple" | "optional" | "later";

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
}

export async function writeEffectiveFeatureScope(outputPath, effectiveScope) {
  await writeFile(outputPath, serializeEffectiveFeatureScope(effectiveScope));
}

function assertApprovedScope(approvedScope) {
  if (!approvedScope || !Array.isArray(approvedScope.features)) {
    throw new Error("原始审批范围缺少 features 数组");
  }

  const seenIds = new Set();
  const seenIdentities = new Map();
  for (const feature of approvedScope.features) {
    if (!feature || typeof feature.id !== "string" || feature.id.length === 0) {
      throw new Error("原始审批范围存在缺少 id 的功能");
    }
    if (!/^F\d{3,}$/.test(feature.id)) {
      throw new Error(`原始审批范围存在非法功能 ID：${feature.id}`);
    }
    if (seenIds.has(feature.id)) {
      throw new Error(`原始审批范围存在重复功能 ID：${feature.id}`);
    }
    seenIds.add(feature.id);

    const identity = featureIdentityKey(feature, `原始审批范围功能 ${feature.id}`);
    const duplicateId = seenIdentities.get(identity);
    if (duplicateId) {
      throw new Error(
        `原始审批范围存在重复 module+feature：${formatFeatureIdentity(feature)}（${duplicateId}、${feature.id}）`,
      );
    }
    seenIdentities.set(identity, feature.id);
  }
}

function assertImplementationOverrides(implementationOverrides) {
  if (!implementationOverrides || !isPlainObject(implementationOverrides.overrides)) {
    throw new Error("implementation overrides 缺少 overrides 对象");
  }
  for (const [id, override] of Object.entries(implementationOverrides.overrides)) {
    if (!isPlainObject(override)) {
      throw new Error(`功能 ${id} 的 override 必须是对象`);
    }
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function indexFeaturesByIdentity(features, label) {
  const byIdentity = new Map();
  for (const feature of features) {
    const identity = featureIdentityKey(feature, label);
    if (byIdentity.has(identity)) {
      throw new Error(`${label}存在重复 module+feature：${formatFeatureIdentity(feature)}`);
    }
    byIdentity.set(identity, feature);
  }
  return byIdentity;
}

function featureIdentityKey(feature, label) {
  if (!feature || typeof feature.module !== "string" || feature.module.length === 0) {
    throw new Error(`${label}存在缺少 module 的功能`);
  }
  if (typeof feature.feature !== "string" || feature.feature.length === 0) {
    throw new Error(`${label}存在缺少 feature 的功能`);
  }
  return JSON.stringify([feature.module, feature.feature]);
}

function formatFeatureIdentity(feature) {
  return `${feature.module} / ${feature.feature}`;
}
