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
const effectiveScopeContractPath = path.join(rootDir, "scripts/effective-scope-contract-check.mjs");
const catalogPaths = [
  path.join(rootDir, "frontend/src/modules/catalog.ts"),
  path.join(rootDir, "frontend/src/modules/inventory/stock-alert/definition.ts")
];

await promisify(execFile)(process.execPath, [effectiveScopeContractPath], { cwd: rootDir });

const [status, effectiveScope, ...catalogSources] = await Promise.all([
  readJson(statusPath),
  readJson(effectiveScopePath),
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
  capabilities: capabilityCounts,
  ...counts
}, null, 2));

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}
