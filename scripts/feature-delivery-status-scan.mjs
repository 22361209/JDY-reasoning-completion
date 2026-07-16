#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const statusPath = path.join(rootDir, "config/feature-delivery-status.json");
const effectiveScopePath = path.join(rootDir, "config/effective-feature-scope.json");
const remediationRoadmapPath = path.join(rootDir, "config/remediation-roadmap.json");
const currentSnapshotPath = path.join(rootDir, "docs/09-交接清单.md");
const currentTaskPath = path.join(rootDir, "docs/12-当前批次验收清单.md");
const effectiveScopeContractPath = path.join(rootDir, "scripts/effective-scope-contract-check.mjs");
const catalogPaths = [
  path.join(rootDir, "frontend/src/modules/catalog.ts"),
  path.join(rootDir, "frontend/src/modules/inventory/stock-alert/definition.ts")
];

await promisify(execFile)(process.execPath, [effectiveScopeContractPath], { cwd: rootDir });

const [status, effectiveScope, remediationRoadmap, currentSnapshotSource, currentTaskSource, ...catalogSources] = await Promise.all([
  readJson(statusPath),
  readJson(effectiveScopePath),
  readJson(remediationRoadmapPath),
  readFile(currentSnapshotPath, "utf8"),
  readFile(currentTaskPath, "utf8"),
  ...catalogPaths.map((filePath) => readFile(filePath, "utf8"))
]);

assert.equal(status.schemaVersion, 1, "feature delivery status schemaVersion must be 1");
assert.equal(status.source.effectiveScope, "config/effective-feature-scope.json", "status source must point to effective scope");
assert(Array.isArray(status.features), "status.features must be an array");
assert(Array.isArray(status.catalogExceptions), "status.catalogExceptions must be an array");

const effectiveFeatures = effectiveScope.features.filter((feature) => feature.decision !== "exclude");
const effectiveById = new Map(effectiveFeatures.map((feature) => [feature.id, feature]));
const statusById = new Map();

for (const item of status.features) {
  assert.match(item.id, /^F\d{3}$/, `invalid feature id: ${item.id}`);
  assert(!statusById.has(item.id), `duplicate feature delivery status: ${item.id}`);
  statusById.set(item.id, item);
}

const expectedIds = effectiveFeatures.map((feature) => feature.id).sort();
const actualIds = [...statusById.keys()].sort();
assert.deepEqual(actualIds, expectedIds, "delivery status must cover every effective non-excluded feature exactly once");

const states = new Set(["verified", "unverified", "not_started", "deferred"]);
const levels = new Set(["A0", "A1", "A2", "A3", "A4"]);
const exposures = new Set(["published", "hold", "hidden", "deferred"]);
const surfaces = new Set(["catalog", "global", "shared", "none"]);
const capabilityKeys = ["entry", "backend", "permission", "auditLog", "automation", "browser"];
const capabilityValues = new Set(["verified", "unverified", "not_applicable"]);
const capabilityCounts = Object.fromEntries(capabilityKeys.map((key) => [key, {
  verified: 0,
  unverified: 0,
  not_applicable: 0
}]));
const catalogIdList = catalogSources.flatMap((source) => [...source.matchAll(/\bid:\s*"([^"]+)"/g)].map((match) => match[1]));
const catalogIds = new Set(catalogIdList);
assert.equal(catalogIds.size, catalogIdList.length, "catalog source contains duplicate entry ids");
const catalogOwners = new Map();
const levelRank = { A0: 0, A1: 1, A2: 2, A3: 3, A4: 4 };
const roadmapSummary = await validateRemediationRoadmap({
  roadmap: remediationRoadmap,
  effectiveById,
  statusById,
  currentSnapshotSource,
  currentTaskSource,
  levels
});

for (const id of expectedIds) {
  const feature = effectiveById.get(id);
  const item = statusById.get(id);
  assert(states.has(item.state), `${id}: invalid state ${item.state}`);
  assert(item.level === null || levels.has(item.level), `${id}: invalid level ${item.level}`);
  assert(exposures.has(item.exposure), `${id}: invalid exposure ${item.exposure}`);
  assert(surfaces.has(item.surface), `${id}: invalid surface ${item.surface}`);
  assert(Array.isArray(item.catalogEntryIds), `${id}: catalogEntryIds must be an array`);
  assert(Array.isArray(item.evidence), `${id}: evidence must be an array`);
  assert(Array.isArray(item.knownGaps), `${id}: knownGaps must be an array`);
  assert(item.capabilityChecks && typeof item.capabilityChecks === "object" && !Array.isArray(item.capabilityChecks), `${id}: capabilityChecks must be an object`);
  assert.deepEqual(Object.keys(item.capabilityChecks).sort(), [...capabilityKeys].sort(), `${id}: capabilityChecks must contain exactly ${capabilityKeys.join(", ")}`);
  assert.equal(new Set(item.catalogEntryIds).size, item.catalogEntryIds.length, `${id}: duplicate catalog entry id`);
  assert.equal(new Set(item.evidence).size, item.evidence.length, `${id}: duplicate evidence path`);

  for (const capability of capabilityKeys) {
    const value = item.capabilityChecks[capability];
    assert(capabilityValues.has(value), `${id}: invalid ${capability} capability ${value}`);
    capabilityCounts[capability][value] += 1;
  }
  if (item.state !== "verified") {
    for (const capability of capabilityKeys) {
      assert.notEqual(item.capabilityChecks[capability], "verified", `${id}: non-verified feature cannot claim verified ${capability} capability`);
    }
  }
  if (item.surface === "none") {
    assert.equal(item.capabilityChecks.entry, "not_applicable", `${id}: surface=none requires entry capability not_applicable`);
    assert.equal(item.capabilityChecks.browser, "not_applicable", `${id}: surface=none requires browser capability not_applicable`);
  }

  if (item.surface === "catalog") {
    assert(item.catalogEntryIds.length > 0, `${id}: catalog surface must name at least one catalog entry`);
  } else {
    assert.equal(item.catalogEntryIds.length, 0, `${id}: non-catalog surface cannot name catalog entries`);
  }
  for (const entryId of item.catalogEntryIds) {
    assert(catalogIds.has(entryId), `${id}: catalog entry does not exist: ${entryId}`);
    assert(!catalogOwners.has(entryId), `${entryId}: catalog entry is claimed by both ${catalogOwners.get(entryId)} and ${id}`);
    catalogOwners.set(entryId, id);
  }
  for (const gap of item.knownGaps) {
    assert.equal(typeof gap, "string", `${id}: known gap must be a string`);
    assert(gap.trim().length > 0, `${id}: known gap cannot be blank`);
  }

  if (item.state === "verified") {
    assert(item.level !== null, `${id}: verified feature must have an A0-A4 level`);
    assert(item.evidence.length > 0, `${id}: verified feature must cite an acceptance report`);
  }
  if (item.state === "unverified") {
    assert.notEqual(item.exposure, "published", `${id}: unverified feature cannot be published`);
    assert(item.knownGaps.length > 0, `${id}: unverified feature must explain its verification gap`);
  }
  if (item.state === "not_started") {
    assert.equal(item.level, null, `${id}: not_started feature cannot claim a delivery level`);
    assert.equal(item.evidence.length, 0, `${id}: not_started feature cannot cite delivery evidence`);
    assert.notEqual(item.exposure, "published", `${id}: not_started feature cannot be published`);
  }
  if (["later", "optional"].includes(feature.decision)) {
    assert.equal(item.state, "deferred", `${id}: later/optional feature must be marked deferred`);
  } else {
    assert.notEqual(item.state, "deferred", `${id}: build/simple feature cannot be marked deferred`);
  }
  if (item.state === "deferred") {
    assert.equal(item.level, null, `${id}: deferred feature cannot claim a current delivery level`);
    assert(["deferred", "hold"].includes(item.exposure), `${id}: deferred feature exposure must be deferred or hold`);
    assert(item.knownGaps.length > 0, `${id}: deferred feature must state its boundary`);
  }
  if (item.exposure === "published") {
    assert.equal(item.state, "verified", `${id}: published feature must be verified`);
    assert(levelRank[item.level] >= levelRank.A1, `${id}: published feature must be at least A1`);
    assert.equal(item.capabilityChecks.entry, "verified", `${id}: published feature must have verified entry capability`);
    if (feature.priority === "P0" && feature.targetVersion === "第一版") {
      assert(levelRank[item.level] >= levelRank.A3, `${id}: first-version P0 published feature must be at least A3`);
    }
  }
  if (item.exposure === "hold") {
    assert(item.knownGaps.length > 0, `${id}: held exposure must explain why it is not publishable`);
  }
  if (item.level !== "A4" && item.state !== "deferred") {
    assert(item.knownGaps.length > 0, `${id}: non-A4 feature must state remaining gaps`);
  }
  if (item.level === "A4") {
    for (const capability of capabilityKeys) {
      if (item.capabilityChecks[capability] !== "not_applicable") {
        assert.equal(item.capabilityChecks[capability], "verified", `${id}: A4 requires verified ${capability} capability when applicable`);
      }
    }
  }

  for (const evidencePath of item.evidence) {
    assert.equal(typeof evidencePath, "string", `${id}: evidence path must be a string`);
    assert(evidencePath.startsWith("docs/验收报告/"), `${id}: evidence must reference an acceptance report`);
    assert(evidencePath.endsWith(".md"), `${id}: evidence must be a Markdown report`);
    await access(path.join(rootDir, evidencePath));
  }
}

const catalogExceptionById = new Map();
for (const exception of status.catalogExceptions) {
  assert(exception && typeof exception === "object" && !Array.isArray(exception), "catalog exception must be an object");
  const { catalogEntryId, disposition, reason } = exception;
  assert.equal(typeof catalogEntryId, "string", "catalog exception catalogEntryId must be a string");
  assert(catalogIds.has(catalogEntryId), `catalog exception references missing entry: ${catalogEntryId}`);
  assert(!catalogExceptionById.has(catalogEntryId), `duplicate catalog exception: ${catalogEntryId}`);
  assert(!catalogOwners.has(catalogEntryId), `${catalogEntryId}: catalog entry cannot be both feature-owned and excepted`);
  assert.equal(typeof disposition, "string", `${catalogEntryId}: catalog exception disposition must be a string`);
  assert.match(disposition, /^[a-z][a-z0-9_]*$/, `${catalogEntryId}: invalid catalog exception disposition`);
  assert.equal(typeof reason, "string", `${catalogEntryId}: catalog exception reason must be a string`);
  assert(reason.trim().length >= 12, `${catalogEntryId}: catalog exception reason is missing or too short`);
  catalogExceptionById.set(catalogEntryId, exception);
}

for (const catalogEntryId of catalogIds) {
  const claimCount = Number(catalogOwners.has(catalogEntryId)) + Number(catalogExceptionById.has(catalogEntryId));
  assert.equal(claimCount, 1, `${catalogEntryId}: catalog entry must have exactly one feature owner or catalog exception`);
}

const counts = status.features.reduce((summary, item) => {
  summary.states[item.state] = (summary.states[item.state] ?? 0) + 1;
  summary.exposures[item.exposure] = (summary.exposures[item.exposure] ?? 0) + 1;
  if (item.level) {
    summary.levels[item.level] = (summary.levels[item.level] ?? 0) + 1;
  }
  return summary;
}, { states: {}, exposures: {}, levels: {} });

console.log(JSON.stringify({
  ok: true,
  effectiveFeatureCount: effectiveFeatures.length,
  catalogEntryCount: catalogIds.size,
  catalogOwnedEntryCount: catalogOwners.size,
  catalogExceptionCount: catalogExceptionById.size,
  remediationRoadmap: roadmapSummary,
  capabilities: capabilityCounts,
  ...counts
}, null, 2));

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function validateRemediationRoadmap({ roadmap, effectiveById, statusById, currentSnapshotSource, currentTaskSource, levels }) {
  assertExactObjectKeys(roadmap, ["schemaVersion", "description", "sources", "order", "gates", "items"], "remediation roadmap");
  assert.equal(roadmap.schemaVersion, 1, "remediation roadmap schemaVersion must be 1");
  assertExactObjectKeys(roadmap.sources, ["effectiveScope", "deliveryStatus", "currentSnapshot", "currentTask"], "roadmap.sources");
  assert.equal(roadmap.sources?.effectiveScope, "config/effective-feature-scope.json", "roadmap effectiveScope source is invalid");
  assert.equal(roadmap.sources?.deliveryStatus, "config/feature-delivery-status.json", "roadmap deliveryStatus source is invalid");
  assert.equal(roadmap.sources?.currentSnapshot, "docs/09-交接清单.md", "roadmap currentSnapshot source is invalid");
  assert.equal(roadmap.sources?.currentTask, "docs/12-当前批次验收清单.md", "roadmap currentTask source is invalid");
  assert(Array.isArray(roadmap.order), "roadmap.order must be an array");
  assert(Array.isArray(roadmap.gates), "roadmap.gates must be an array");
  assert(Array.isArray(roadmap.items), "roadmap.items must be an array");

  const approvedOrderPrefix = ["0", "1", "2", "3", "4", "5", "6", "6A", "6B", "6C", "6D", "6E"];
  const expectedTitles = new Map([
    ["0", "上下文与范围持续漂移"],
    ["1", "后端测试和 Flyway 不可复现"],
    ["2", "权限 fail-open、生命周期和库存直调接口可绕过"],
    ["3", "操作日志缺操作人并伪装成本地管理员"],
    ["4", "tenant schema 没有外键"],
    ["5", "主数据编辑会清空隐藏字段"],
    ["6", "未知列表错误返回销售订单数据"],
    ["6A", "账户资料与员工主档"],
    ["6B", "正式收款单与付款单"],
    ["6C", "销售退货单"],
    ["6D", "Excel 导入"],
    ["6E", "报表与当前错误入口"]
  ]);
  const expectedFeatureScopeIds = new Map([
    ["6A", ["F016", "F017"]],
    ["6B", ["F026", "F036", "F080", "F082"]],
    ["6C", ["F024"]],
    ["6D", ["F008"]],
    ["6E", ["F029", "F042", "F061", "F091", "F093"]]
  ]);
  const expectedKinds = new Map(approvedOrderPrefix.map((id) => [
    id,
    id === "0" ? "governance" : id.startsWith("6") && id.length > 1 ? "feature_delivery" : "cross_cutting"
  ]));
  const expectedAcceptance = new Map(approvedOrderPrefix.map((id) => [
    id,
    id === "6A" || id === "6E" ? "A3" : "A4"
  ]));
  assert(
    roadmap.order.length >= approvedOrderPrefix.length,
    "remediation roadmap cannot remove approved 0-6 and 6A-6E items"
  );
  assert.deepEqual(
    roadmap.order.slice(0, approvedOrderPrefix.length),
    approvedOrderPrefix,
    "remediation roadmap must preserve the approved 0-6 and 6A-6E order as an immutable prefix"
  );
  assert.deepEqual(roadmap.items.map((item) => item.id), roadmap.order, "roadmap.items must follow roadmap.order exactly");

  const itemById = new Map();
  const allowedKinds = new Set(["governance", "cross_cutting", "feature_delivery"]);
  for (const [index, item] of roadmap.items.entries()) {
    assert(item && typeof item === "object" && !Array.isArray(item), `roadmap item ${index} must be an object`);
    assertExactObjectKeys(item, ["id", "title", "kind", "scopeIds", "targetAcceptance", "boundaries", "hardExitConditions", "predecessorIds", "historyRefs"], `roadmap item ${index}`);
    assert.equal(typeof item.id, "string", `roadmap item ${index} id must be a string`);
    assert(!itemById.has(item.id), `duplicate roadmap item: ${item.id}`);
    assert.equal(typeof item.title, "string", `${item.id}: title must be a string`);
    assert(item.title.trim().length > 0, `${item.id}: title cannot be blank`);
    if (expectedTitles.has(item.id)) {
      assert.equal(item.title, expectedTitles.get(item.id), `${item.id}: title does not match the approved remediation route`);
    }
    assert(allowedKinds.has(item.kind), `${item.id}: invalid kind ${item.kind}`);
    if (expectedKinds.has(item.id)) {
      assert.equal(item.kind, expectedKinds.get(item.id), `${item.id}: kind does not match the approved remediation route`);
    }
    assert(levels.has(item.targetAcceptance), `${item.id}: invalid targetAcceptance ${item.targetAcceptance}`);
    if (expectedAcceptance.has(item.id)) {
      assert.equal(item.targetAcceptance, expectedAcceptance.get(item.id), `${item.id}: targetAcceptance does not match the approved remediation route`);
    }
    assertStringArray(item.scopeIds, `${item.id}: scopeIds`, { allowEmpty: item.kind !== "feature_delivery" });
    assert.equal(new Set(item.scopeIds).size, item.scopeIds.length, `${item.id}: duplicate scope ID`);
    if (expectedFeatureScopeIds.has(item.id)) {
      assert.deepEqual([...item.scopeIds].sort(), [...expectedFeatureScopeIds.get(item.id)].sort(), `${item.id}: feature scope IDs do not match the approved route`);
    } else if (expectedTitles.has(item.id)) {
      assert.equal(item.scopeIds.length, 0, `${item.id}: cross-cutting route item cannot claim feature scope IDs`);
    }
    for (const scopeId of item.scopeIds) {
      assert(effectiveById.has(scopeId), `${item.id}: scope ID is not in effective non-excluded scope: ${scopeId}`);
      assert(statusById.has(scopeId), `${item.id}: scope ID is missing delivery status: ${scopeId}`);
    }
    validateRoadmapBoundaries(item.boundaries, item.id);
    assertStringArray(item.hardExitConditions, `${item.id}: hardExitConditions`);
    assertStringArray(item.predecessorIds, `${item.id}: predecessorIds`, { allowEmpty: index === 0 });
    assert.equal(new Set(item.predecessorIds).size, item.predecessorIds.length, `${item.id}: duplicate predecessor ID`);
    for (const predecessorId of item.predecessorIds) {
      const predecessorIndex = roadmap.order.indexOf(predecessorId);
      assert(predecessorIndex >= 0, `${item.id}: missing predecessor ${predecessorId}`);
      assert(predecessorIndex < index, `${item.id}: predecessor ${predecessorId} must appear earlier in the route`);
    }
    if (index > 0) {
      assert(item.predecessorIds.includes(roadmap.order[index - 1]), `${item.id}: must depend on the immediately preceding route item`);
    }
    assertStringArray(item.historyRefs, `${item.id}: historyRefs`, { allowEmpty: true });
    assert.equal(new Set(item.historyRefs).size, item.historyRefs.length, `${item.id}: duplicate history reference`);
    for (const historyRef of item.historyRefs) {
      assert(historyRef.startsWith("docs/验收报告/"), `${item.id}: historyRefs must point to acceptance reports`);
      assert(historyRef.endsWith(".md"), `${item.id}: historyRefs must point to Markdown files`);
      await access(path.join(rootDir, historyRef));
    }
    itemById.set(item.id, item);
  }

  const gateById = new Map();
  for (const gate of roadmap.gates) {
    assert(gate && typeof gate === "object" && !Array.isArray(gate), "roadmap gate must be an object");
    assertExactObjectKeys(gate, ["id", "title", "afterItemId", "beforeItemId", "targetAcceptance", "boundaries", "hardExitConditions"], "roadmap gate");
    assert.match(gate.id, /^G\d+-[a-z0-9-]+$/, `invalid roadmap gate id: ${gate.id}`);
    assert(!gateById.has(gate.id), `duplicate roadmap gate: ${gate.id}`);
    assert.equal(typeof gate.title, "string", `${gate.id}: title must be a string`);
    assert(gate.title.trim().length > 0, `${gate.id}: title cannot be blank`);
    assert(itemById.has(gate.afterItemId), `${gate.id}: afterItemId does not exist`);
    assert(itemById.has(gate.beforeItemId), `${gate.id}: beforeItemId does not exist`);
    assert(roadmap.order.indexOf(gate.afterItemId) < roadmap.order.indexOf(gate.beforeItemId), `${gate.id}: gate order is invalid`);
    assert(levels.has(gate.targetAcceptance), `${gate.id}: invalid targetAcceptance ${gate.targetAcceptance}`);
    validateRoadmapBoundaries(gate.boundaries, gate.id);
    assertStringArray(gate.hardExitConditions, `${gate.id}: hardExitConditions`);
    gateById.set(gate.id, gate);
  }
  const regressionGate = gateById.get("G0-regression-baseline-before-2");
  assert(regressionGate, "roadmap must contain G0-regression-baseline-before-2");
  assert.equal(regressionGate.title, "JavaScript 回归夹具基线", "G0 title does not match the approved remediation gate");
  assert.equal(regressionGate.afterItemId, "1", "G0 must follow roadmap item 1");
  assert.equal(regressionGate.beforeItemId, "2", "G0 must block roadmap item 2");
  assert.equal(regressionGate.targetAcceptance, "A4", "G0 targetAcceptance must be A4");

  const currentCoordinate = parseCurrentRoadmapCoordinate(currentTaskSource, "current task");
  const snapshotCoordinate = parseCurrentRoadmapCoordinate(currentSnapshotSource, "current snapshot");
  assert.deepEqual(snapshotCoordinate, currentCoordinate, "docs/09 and docs/12 must reference the same current roadmap coordinate");
  for (const itemId of currentCoordinate.itemIds) {
    assert(itemById.has(itemId), `current task references missing roadmap item: ${itemId}`);
  }
  if (currentCoordinate.gateId) {
    assert(gateById.has(currentCoordinate.gateId), `current task references missing roadmap gate: ${currentCoordinate.gateId}`);
  }

  return {
    itemCount: itemById.size,
    gateCount: gateById.size,
    currentTaskKind: currentCoordinate.taskKind,
    currentItemIds: currentCoordinate.itemIds,
    currentGateId: currentCoordinate.gateId
  };
}

function validateRoadmapBoundaries(boundaries, context) {
  assert(boundaries && typeof boundaries === "object" && !Array.isArray(boundaries), `${context}: boundaries must be an object`);
  assert.deepEqual(Object.keys(boundaries).sort(), ["inScope", "outOfScope"], `${context}: boundaries must contain exactly inScope and outOfScope`);
  assertStringArray(boundaries.inScope, `${context}: boundaries.inScope`);
  assertStringArray(boundaries.outOfScope, `${context}: boundaries.outOfScope`);
}

function assertStringArray(value, context, { allowEmpty = false } = {}) {
  assert(Array.isArray(value), `${context} must be an array`);
  if (!allowEmpty) {
    assert(value.length > 0, `${context} cannot be empty`);
  }
  for (const entry of value) {
    assert.equal(typeof entry, "string", `${context} entries must be strings`);
    assert(entry.trim().length > 0, `${context} entries cannot be blank`);
  }
}

function assertExactObjectKeys(value, expectedKeys, context) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${context} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expectedKeys].sort(), `${context} contains missing or unsupported fields`);
}

function parseCurrentRoadmapCoordinate(source, context) {
  const frontmatterMatch = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert(frontmatterMatch, `${context} must contain YAML frontmatter`);
  const lines = frontmatterMatch[1].split(/\r?\n/);
  const itemLineIndex = lines.findIndex((line) => line.startsWith("roadmapItemIds:"));
  assert(itemLineIndex >= 0, `${context} must declare roadmapItemIds`);
  const inlineItems = lines[itemLineIndex].slice("roadmapItemIds:".length).trim();
  const itemIds = [];
  if (inlineItems && inlineItems !== "[]") {
    assert(inlineItems.startsWith("[") && inlineItems.endsWith("]"), `${context} roadmapItemIds inline value must be a YAML array`);
    for (const value of inlineItems.slice(1, -1).split(",").map((entry) => entry.trim()).filter(Boolean)) {
      itemIds.push(normalizeYamlScalar(value));
    }
  } else if (!inlineItems) {
    for (let index = itemLineIndex + 1; index < lines.length; index += 1) {
      const match = lines[index].match(/^\s{2}-\s+(.+)$/);
      if (!match) {
        break;
      }
      itemIds.push(normalizeYamlScalar(match[1]));
    }
  }
  assert.equal(new Set(itemIds).size, itemIds.length, `${context} contains duplicate roadmapItemIds`);
  assert(itemIds.length <= 1, `${context} must reference at most one roadmap item`);

  const gateLine = lines.find((line) => line.startsWith("roadmapGateId:"));
  assert(gateLine, `${context} must declare roadmapGateId`);
  const rawGateId = gateLine.slice("roadmapGateId:".length).trim();
  const gateId = rawGateId && rawGateId !== "null" ? normalizeYamlScalar(rawGateId) : null;
  const taskKindLine = lines.find((line) => line.startsWith("taskKind:"));
  const taskKind = taskKindLine ? normalizeYamlScalar(taskKindLine.slice("taskKind:".length).trim()) : "roadmap";
  assert(["roadmap", "governance"].includes(taskKind), `${context} taskKind must be roadmap or governance`);
  if (taskKind === "governance") {
    assert(itemIds.length === 0 && !gateId, `${context} governance task must not claim a remediation roadmap coordinate`);
  } else {
    assert((itemIds.length > 0) !== Boolean(gateId), `${context} roadmap task must reference one roadmap item or one roadmap gate, but not both`);
  }
  return { itemIds, gateId, taskKind };
}

function normalizeYamlScalar(value) {
  return value.replace(/^['"]|['"]$/g, "");
}
