#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationPath = path.join(rootDir, "verification/a146-numbering-rule-closure-regression.json");
const files = {
  service: "backend/src/main/java/com/jdy/erp/shared/application/NumberingService.java",
  controller: "backend/src/main/java/com/jdy/erp/shared/api/NumberingController.java",
  logCommand: "backend/src/main/java/com/jdy/erp/shared/application/OperationLogCommand.java",
  migration: "backend/src/main/resources/db/migration/V105__numbering_rule_reliability.sql",
  inventoryTraceMigration: "backend/src/main/resources/db/migration/V106__inventory_source_trace.sql",
  inventoryTraceCorrection: "backend/src/main/resources/db/migration/V107__inventory_source_trace_reaudit_fix.sql",
  api: "frontend/src/services/numberingApi.ts",
  page: "frontend/src/modules/system/numbering/NumberingRuleSettingsPage.vue",
  app: "frontend/src/app/App.vue",
  catalog: "frontend/src/modules/catalog.ts",
  manifest: "config/regression-manifest.json",
  tenantIsolationTest: "backend/src/test/java/com/jdy/erp/system/tenant/TenantMasterDataBomNumberingIsolationTest.java",
  a137: "scripts/a137-tenant-schema-constraint-regression.mjs",
  a141Migration: "scripts/a141-settlement-migration-regression.mjs",
  a142Migration: "scripts/a142-sales-return-migration-regression.mjs",
  a143Migration: "scripts/a143-master-data-import-migration-regression.mjs",
  integrationTest: "backend/src/test/java/com/jdy/erp/shared/application/NumberingServiceReliabilityIntegrationTest.java",
  permissionTest: "backend/src/test/java/com/jdy/erp/shared/application/NumberingControllerPermissionIntegrationTest.java",
  migrationTest: "scripts/a146-numbering-rule-migration-regression.mjs"
};
const source = Object.fromEntries(await Promise.all(
  Object.entries(files).map(async ([key, relative]) => [key, await readFile(path.join(rootDir, relative), "utf8")])
));
const assertions = [];
const manifest = JSON.parse(source.manifest);

function assert(condition, message) {
  if (!condition) throw new Error(message);
  assertions.push(message);
}

function count(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function methodBody(text, signature) {
  const start = text.indexOf(signature);
  if (start < 0) throw new Error(`missing method signature: ${signature}`);
  const open = text.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    if (text[index] === "}") depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }
  throw new Error(`unterminated method: ${signature}`);
}

assert(count(source.catalog, /id:\s*["']numbering-rule-settings["']/g) === 1, "numbering-rule-settings must remain the only catalog owner");
assert(!source.catalog.includes("id: \"numbering-rule-list\""), "retired unknown numbering list must not return");

assert(count(source.service, /new NumberingRule\(/g) === 26, "backend registry must contain exactly 26 formal document types");
assert(source.service.includes("registry.size() != 26"), "backend registry must fail closed on count drift");
assert(!/synchronized\s+String\s+nextBillNo/.test(source.service), "single-JVM synchronized numbering guard must be removed");
assert(count(source.service, /public Map<String, Object> saveRule\(/g) === 1, "NumberingService must expose only the versioned saveRule API");
assert(source.tenantIsolationTest.includes('JSON.textNode("0")'), "tenant numbering isolation must call the versioned saveRule API");
assert(source.service.includes("FOR UPDATE"), "issuance and maintenance must lock the tenant rule row");
assert(source.service.includes("version = version + 1"), "issuance and maintenance must advance version");
assert(source.service.includes("maximumForWidth") && source.service.includes("safeHighWater >= maximum"), "sequence exhaustion must be checked before update");
assert(source.service.includes("currentDocumentHighWater") && source.service.includes("requestedDocumentHighWater"), "rule updates must check both persisted and requested document high water");
assert(source.service.includes("bill_no >= ?") && source.service.includes("bill_no <= ?") && source.service.includes("ORDER BY bill_no DESC") && source.service.includes("LIMIT 1"), "high-water lookup must use the bill_no btree range and reverse seek");
assert(!source.service.includes("MAX(CAST(SUBSTRING"), "issuance must not scan the full prefix history with a regex aggregate");
assert(source.service.includes("lastNumber < safeMinimum"), "lastNumber rollback must be rejected");
assert(!source.service.includes("Math.max(0, lastNumber)"), "negative lastNumber must never be silently clamped");
assert(source.service.includes("UPDATE_NUMBERING_RULE") && source.service.includes("NUMBERING_RULE"), "successful rule changes must write the frozen operation-log action and target");
assert(source.service.includes("StateField.PREFIX") && source.service.includes("StateField.WIDTH") && source.service.includes("StateField.LAST_NUMBER"), "operation log must contain before/after rule fields");

const listRules = methodBody(source.service, "public List<Map<String, Object>> listRules()");
assert(!listRules.includes("INSERT INTO") && !listRules.includes("ensureRuleRow"), "GET rules must not create or mutate sequence rows");
assert(listRules.includes("RULES_BY_TYPE.containsKey"), "GET rules must hide unknown historical rows");
const saveRule = methodBody(source.service, "private Map<String, Object> saveRuleInternal(");
assert(saveRule.includes("before.version() != expectedVersion"), "PUT must reject stale versions");
assert(saveRule.indexOf("lockedRule") < saveRule.indexOf("UPDATE document_number_sequence"), "PUT must lock before updating");
assert(saveRule.indexOf("UPDATE document_number_sequence") < saveRule.indexOf("operationLogService.logCurrent"), "rule update and success log must share transaction order");

assert(count(source.controller, /@RequirePermission\("system\.numbering_rule\.manage"\)/g) === 2, "GET and PUT rule endpoints must require numbering permission");
assert(source.controller.includes("JsonNode lastNumber") && source.controller.includes("JsonNode version"), "PUT must accept exact canonical 64-bit fields");
assert(source.logCommand.includes("PREFIX(\"prefix\")") && source.logCommand.includes("LAST_NUMBER(\"lastNumber\")"), "operation-log state whitelist must include numbering fields");

for (const fragment of [
  "ALTER COLUMN last_number TYPE BIGINT",
  "ADD COLUMN version BIGINT NOT NULL DEFAULT 0",
  "ck_document_number_sequence_prefix",
  "ck_document_number_sequence_width",
  "ck_document_number_sequence_last_number",
  "ck_document_number_sequence_version",
  "V105 formal numbering index is missing",
  "index_row.indisunique",
  "document_type = 'outsourcingSurface'",
  "expected=82/76/170/80"
]) {
  assert(source.migration.includes(fragment), `V105 must preserve migration contract fragment: ${fragment}`);
}
assert(source.migration.includes("Historical\n+-- backup schemas stay data-only snapshots") || source.migration.includes("backup schemas stay data-only snapshots"), "historical backup schemas must remain data-only");
assert(source.migration.indexOf("ALTER COLUMN last_number TYPE BIGINT") < source.migration.indexOf("ck_document_number_sequence_last_number"), "V105 must widen the counter before installing checks");
assert(sha256(source.inventoryTraceMigration) === "63a6e0a208c9dd91af07ff46d82e26142dc6ee7f140d86b7f830c38da1535e53", "published V106 migration source must remain byte-for-byte immutable");
for (const fragment of [
  "forward-only correction",
  "uq_inv_stock_txn_exact_posting_fact",
  "idx_inv_stock_txn_exact_posting_fact",
  "registered backup",
  "Asia/Shanghai"
]) {
  assert(source.inventoryTraceCorrection.includes(fragment), `V107 must preserve forward-correction contract fragment: ${fragment}`);
}

const saveApi = methodBody(source.api, "export async function saveNumberingRule");
assert(saveApi.includes("version: rule.version"), "frontend PUT must send version");
assert(saveApi.includes("const persisted = normalizeRule(payload.rule)"), "frontend save must use the direct persisted PUT response");
assert(!saveApi.includes("fetchNumberingRules"), "frontend must not depend on a second GET after successful PUT");
assert(source.api.includes("lastNumber: string") && source.api.includes("version: string"), "frontend must preserve canonical integer strings");

for (const fragment of [
  "dirtyChange",
  "discardClose",
  "discardRefresh",
  "discardSelect",
  "numbering-confirm-dialog",
  "saving.value",
  "result.status === 400",
  "result.rule"
]) {
  assert(source.page.includes(fragment), `numbering page must preserve UI boundary fragment: ${fragment}`);
}
assert(source.page.includes("if (!result.ok || !result.rule)"), "409/network failures must keep the edited draft instead of replacing it");
assert(
  /dirty\.value && selectedRule\.value\?\.documentType === rule\.documentType[\s\S]*?已为你保留[\s\S]*?return;[\s\S]*?dirty\.value && selectedRule\.value\?\.documentType !== rule\.documentType/.test(source.page),
  "clicking the active dirty numbering rule must preserve the draft before any discard branch"
);
assert(source.page.includes('type="text"') && source.page.includes('inputmode="numeric"'), "lastNumber editor must preserve canonical decimal text without numeric coercion");
assert(source.app.includes("v-if=\"hasNumberingRuleSettingsTab\"") && source.app.includes("v-show=\"tabs.activeTab.value.id === numberingRuleSettingsTabId\""), "numbering editor must stay mounted across internal tab switches");
assert(source.app.includes("@dirty-change=\"markNumberingRuleSettingsDirty\""), "numbering dirty state must reach the shell tab");
assert(source.app.includes("beforeunload") && source.app.includes("tab.dirty"), "browser refresh must use the shared dirty guard");

for (const fragment of [
  "issueConcurrently(12)",
  "updateConcurrently",
  "issuanceAndRuleUpdateSerializeOnTheSameRowLock",
  "ruleChangeHonorsBothPersistedAndRequestedPrefixHighWater",
  "twelveDigitMaximumIssuesOnceThenReturnsConflictWithoutAdvancing",
  "operationLogFailureRollsBackRuleAndVersionInTheSameTransaction",
  "realAccountSetMaintenanceBackupAndRestorePreservesBigintVersionAndNoLegacyRule",
  "accountSetMaintenanceService.restoreCurrentAccountSet",
  "doesNotHaveDuplicates",
  "operationLogCount()",
  "invalidAndUnknownRulesFailWithoutWritesOrSuccessLogs"
]) {
  assert(source.integrationTest.includes(fragment), `integration test must cover: ${fragment}`);
}
for (const fragment of [
  "isUnauthorized()",
  "isForbidden()",
  "$.rules.length()",
  "notRegistered",
  "\"lastNumber\", \"0\""
]) {
  assert(source.permissionTest.includes(fragment), `permission integration test must cover: ${fragment}`);
}
assert(
  source.permissionTest.includes(`"lastNumber", "0",
                    "enabled", true
                ))))`),
  "permission integration test must exercise a PUT body with version omitted"
);
for (const fragment of ["upgradeDatabase", "freshDatabase", "invalidDatabase", "restoreDataOnlySnapshot", "real AccountSetMaintenanceService", "billNoIndexCoverage", "jdy_sync_tenant_schema", "zero residue"]) {
  assert(source.migrationTest.includes(fragment), `migration regression must cover: ${fragment}`);
}
for (const tier of [manifest.areas.system, manifest.full]) {
  assert(tier.includes("scripts/a146-numbering-rule-closure-regression.mjs"), "A146 closure gate must be registered in system and full");
  assert(tier.includes("scripts/a146-numbering-rule-migration-regression.mjs"), "A146 migration gate must be registered in system and full");
}
assert(manifest.areas.security.includes("scripts/a146-numbering-rule-closure-regression.mjs"), "A146 permission/static gate must be registered in security");
assert(source.a137.includes("checkConstraints: 80") && source.a137.includes("V105__numbering_rule_reliability.sql"), "A137 numbering guard must preserve the V105 and 80-CHECK semantics");
for (const [name, migrationSource, historicalTarget] of [
  ["A141", source.a141Migration, "flywayMigrate(upgradeDatabase, 104)"],
  ["A142", source.a142Migration, "flyway(upgradeDatabase, 104)"],
  ["A143", source.a143Migration, "flyway(upgradeDatabase, 104)"],
  ["A146", source.migrationTest, "flyway(upgradeDatabase, 104)"]
]) {
  assert(migrationSource.includes(historicalTarget), `${name} migration gate must preserve its historical target boundary`);
  assert(migrationSource.includes('version === "105"') && migrationSource.includes("V105") && migrationSource.includes("numbering"), `${name} migration gate must preserve V105 numbering semantics`);
  assert(migrationSource.includes('version === "106"') && migrationSource.includes("1207842815"), `${name} migration gate must enforce exactly one successful immutable V106`);
  assert(migrationSource.includes('version === "107"'), `${name} migration gate must enforce exactly one successful V107`);
  assert(migrationSource.includes("freshHistory") && migrationSource.includes("source"), `${name} migration gate must compare fresh history with migration sources`);
}

const result = {
  ok: true,
  generatedAt: new Date().toISOString(),
  assertionCount: assertions.length,
  assertions,
  note: "Static source/contract gate only; it does not replace the isolated database integration, migration, permission, or browser runs."
};
await mkdir(path.dirname(verificationPath), { recursive: true });
await writeFile(verificationPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, assertionCount: assertions.length }, null, 2));
