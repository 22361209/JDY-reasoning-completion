#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "verification/a151-material-scrap-backend-regression.json");
const files = {
  migration: "backend/src/main/resources/db/migration/V108__production_material_scrap.sql",
  service: "backend/src/main/java/com/jdy/erp/production/application/MaterialScrapAppService.java",
  controller: "backend/src/main/java/com/jdy/erp/production/api/MaterialScrapController.java",
  issueService: "backend/src/main/java/com/jdy/erp/production/application/MaterialIssueAppService.java",
  lifecycleService: "backend/src/main/java/com/jdy/erp/shared/application/BillLifecycleService.java",
  lifecycleController: "backend/src/main/java/com/jdy/erp/shared/api/BillLifecycleController.java",
  lifecyclePolicy: "backend/src/main/java/com/jdy/erp/shared/application/BillLifecyclePolicy.java",
  permissionPolicy: "backend/src/main/java/com/jdy/erp/shared/application/DocumentPermissionPolicy.java",
  lockGuard: "backend/src/main/java/com/jdy/erp/shared/api/DocumentLockGuardInterceptor.java",
  numbering: "backend/src/main/java/com/jdy/erp/shared/application/NumberingService.java",
  registry: "backend/src/main/java/com/jdy/erp/system/application/list/ListQueryContractRegistry.java",
  stateGuard: "backend/src/main/java/com/jdy/erp/system/application/list/ListStubStateGuard.java",
  adapter: "backend/src/main/java/com/jdy/erp/system/application/list/MaterialScrapListQueryAdapter.java",
  appTest: "backend/src/test/java/com/jdy/erp/production/application/MaterialScrapAppServiceIntegrationTest.java",
  controllerTest: "backend/src/test/java/com/jdy/erp/production/api/MaterialScrapControllerIntegrationTest.java",
  listTest: "backend/src/test/java/com/jdy/erp/system/application/list/MaterialScrapListQueryAdapterIntegrationTest.java",
  tenantTest: "backend/src/test/java/com/jdy/erp/system/tenant/TenantMaterialScrapIsolationTest.java",
  numberingTest: "backend/src/test/java/com/jdy/erp/shared/application/NumberingServiceReliabilityIntegrationTest.java",
  lifecycleTest: "backend/src/test/java/com/jdy/erp/shared/application/BillLifecyclePermissionIntegrationTest.java"
};

const source = Object.fromEntries(await Promise.all(
  Object.entries(files).map(async ([key, relative]) => [key, await readFile(path.join(root, relative), "utf8")])
));
const assertions = [];

function check(condition, message) {
  if (!condition) throw new Error(message);
  assertions.push(message);
}

function count(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function methodBody(text, signature) {
  const start = text.indexOf(signature);
  if (start < 0) throw new Error(`missing method: ${signature}`);
  const open = text.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    if (text[index] === "}") depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }
  throw new Error(`unterminated method: ${signature}`);
}

for (const marker of [
  "CREATE TABLE production_material_scrap (",
  "CREATE TABLE production_material_scrap_line (",
  "source_issue_line_id UUID NOT NULL",
  "scrap_qty NUMERIC(18, 4) NOT NULL DEFAULT 0",
  "reissue_qty NUMERIC(18, 4) NOT NULL DEFAULT 0",
  "is_stock_in BOOLEAN NOT NULL DEFAULT FALSE",
  "stock_in_status VARCHAR(24) NOT NULL DEFAULT 'NOT_REQUIRED'",
  "expected=84/79/176/97",
  "production_material_scrap_line",
  "production_material_scrap"
]) {
  check(source.migration.includes(marker), `V108 must preserve marker: ${marker}`);
}
check(!/CONSTRAINT\s+[A-Za-z0-9_]+\s+FOREIGN KEY \(source_issue_line_id\)/.test(source.migration), "source issue line id must remain a soft historical reference");
check(source.migration.indexOf("('production_material_scrap',") < source.migration.indexOf("('production_material_scrap_line',"), "tenant catalog must restore header before line");

for (const signature of [
  "public Map<String, Object> detail(",
  "public Map<String, Object> previewFromIssue(",
  "public Map<String, Object> pushFromIssue(",
  "public Map<String, Object> saveDraft(",
  "public Map<String, Object> deleteDraft(",
  "public Map<String, Object> audit(",
  "public Map<String, Object> reverse(",
  "public Map<String, Object> stockIn(",
  "public Map<String, Object> reverseStockIn("
]) {
  check(source.service.includes(signature), `material scrap service must expose: ${signature}`);
}
for (const marker of [
  "record ScrapDraftRequest(",
  "record ScrapLineRequest(",
  "guardSourceLineIdQuantities",
  "source_issue_line_id",
  "PRODUCTION_MATERIAL_SCRAP",
  "MATERIAL_SCRAP_STOCK_IN",
  "MATERIAL_SCRAP_STOCK_IN_REVERSE",
  "PostingAction.AUDIT",
  "PostingAction.REVERSE",
  "STOCKED_IN",
  "REVERSED",
  "PENDING",
  "NOT_REQUIRED"
]) {
  check(source.service.includes(marker), `material scrap service must preserve marker: ${marker}`);
}
const audit = methodBody(source.service, "public Map<String, Object> audit(");
check(!audit.includes("postingPipeline.post") && !audit.includes("InventoryPostingCommand.document"), "scrap audit must not deduct or add inventory");
check(audit.indexOf("lockSourceBeforeScrap") < audit.indexOf("lockScrapHeader"), "audit must lock source quota before scrap header");
const sourceLock = methodBody(source.service, "private void lockSourceBeforeScrap(");
check(sourceLock.includes("guardSourceLineIdQuantities"), "source lock helper must use the shared UUID quota guard");
const stockChange = methodBody(source.service, "private Map<String, Object> changeStockIn(");
check(stockChange.includes(".sorted(Comparator") && stockChange.includes("postingPipeline.post"), "stock-in and reversal must use stable ordered formal posting");
check(stockChange.indexOf("requireScrapHeader") < stockChange.indexOf("scrapLines") && stockChange.indexOf("scrapLines") < stockChange.indexOf("postingPipeline.post"), "stock actions must lock header then lines before posting");

for (const route of [
  "/production/material-scraps/{billNo}",
  "/production/material-issues/{billNo}/material-scrap-preview",
  "/production/material-issues/{billNo}/push-material-scrap",
  "/production/material-scraps/draft",
  "/production/material-scraps/{billNo}/audit",
  "/production/material-scraps/{billNo}/reverse",
  "/production/material-scraps/{billNo}/stock-in",
  "/production/material-scraps/{billNo}/reverse-stock-in"
]) {
  check(source.controller.includes(route), `controller must expose frozen route: ${route}`);
}
check(source.controller.includes('@RequestMapping("/api")'), "material scrap controller must use the shared /api prefix");
check(source.controller.includes('@DeleteMapping("/production/material-scraps/{billNo}")'), "material scrap controller must preserve the frozen DELETE route");
check(count(source.controller, /@(GetMapping|PostMapping|DeleteMapping)\(/g) === 9, "material scrap controller must expose exactly nine mapped operations");
check(count(source.controller, /@RequirePermission\("production\.document\.audit"\)/g) === 1, "material scrap controller must centrally require the existing production permission");
check(!/JdbcTemplate|PostingPipeline|InventoryPosting/.test(source.controller), "controller must not contain business or inventory rules");

for (const marker of [
  "SourceLineIdQuantityGuard",
  "SourceLineIdQuantityDemand",
  "guardSourceLineIdQuantities",
  "new TreeMap",
  "FOR UPDATE",
  "production_material_scrap"
]) {
  check(source.lifecycleService.includes(marker), `shared lifecycle quantity guard must preserve: ${marker}`);
}
check(source.issueService.includes("production_material_scrap"), "material issue writes must guard non-VOID material scrap downstream facts");
check(source.lifecycleController.includes('Map.entry("materialScrap"'), "shared lifecycle controller must register materialScrap");
check(source.lifecyclePolicy.includes('Map.entry("production_material_scrap"'), "backend lifecycle policy must register material scrap");
check(source.permissionPolicy.includes('Map.entry("materialScrap", "production.document.audit")'), "document permission policy must reuse production.document.audit");
check(source.lockGuard.includes('Map.entry("/api/production/material-scraps/", "materialScrap")'), "document lock interceptor must protect material scrap writes");

check(count(source.numbering, /new NumberingRule\(/g) === 27, "numbering registry must contain exactly 27 formal types");
check(source.numbering.includes('new NumberingRule("materialScrap", "CLBF", "production_material_scrap", "材料报废单")'), "numbering registry must contain only the frozen materialScrap rule");
check(source.numbering.includes("registry.size() != 27"), "numbering registry must fail closed on 27-count drift");

for (const marker of [
  'return "materialScrap"',
  '"material-scrap-form-list"',
  '"material-scrap-source-selector"',
  "SELECT COUNT(*)",
  "LIMIT ? OFFSET ?",
  "production_material_scrap",
  "production_material_issue"
]) {
  check(source.adapter.includes(marker), `material scrap list adapter must preserve: ${marker}`);
}
check(!/DefaultStubListQueryAdapter|StubListSeedRowsProvider/.test(source.adapter), "material scrap adapter must never fall back to seeded/default rows");
check(source.adapter.includes('fields.put("status", "status")'), "visible material scrap status filters must compare the localized status value");
check(source.registry.includes('"material-scrap-form-list"') && source.registry.includes('"material-scrap-source-selector"'), "list registry must explicitly register both material scrap contracts");
check(source.stateGuard.includes('"material-scrap-form-list"') && source.stateGuard.includes('"material-scrap-source-selector"'), "list state guard must explicitly allow both material scrap contracts");

for (const marker of [
  "zeroDraftIsValidButAuditRevalidatesPositiveQuantityAndReason",
  "fullyConsumedSourceIsRejectedByPreviewAndPushInsteadOfCreatingZeroDrafts",
  "stockInIsASeparateWholeDocumentIdempotentLifecycle",
  "multiLineStockInRollsBackEveryLineWhenOneWarehouseBecomesInvalid",
  "auditStatusAndSuccessLogRollBackTogetherWhenLogPersistenceFails",
  "concurrentStockInAndReverseUseFreshLockedLineStateAndOnlyOneCanWin",
  "concurrentQuotaAllowsOneAuditAndLeavesTheLoserBusinessTransactionClean",
  "sharedLifecyclePolicyRejectsHeaderAndLineCloseFreezeActions",
  "sourceRedAndWorkshopPredicatesAreRecheckedAndVoidReleasesSourceGuard",
  "holdRowLock",
  "awaitDatabaseLockWaiters",
  "get(10, TimeUnit.SECONDS)",
  "trackScrap",
  "deleteTrackedScrapLogs",
  "scrapQty",
  "reissueQty",
  "reverseStockIn"
]) {
  check(source.appTest.includes(marker), `app integration coverage must include: ${marker}`);
}
for (const marker of [
  "requestRecordsExposeOnlyTheFrozenNarrowWriteContract",
  "controllerPublishesExactlyTheFrozenApiUnderTheApiPrefix",
  "aWriteConflictUsesTheUnifiedHttpFailureAuditExactlyOnce",
  "mappedRoutes",
  "logDeclaredWriteFailureOnce"
]) {
  check(source.controllerTest.includes(marker), `controller integration coverage must include: ${marker}`);
}
for (const marker of [
  "formalListUsesRealCountLimitOffsetStatusAndDetailPredicates",
  "sourceSelectorSharesTheExecutablePredicateAndAuditedQuota",
  "sourceSelectorDynamicallyRechecksEveryExecutableSourcePredicate",
  "adapterRejectsEveryContractOutsideItsTwoExplicitKeys"
]) {
  check(source.listTest.includes(marker), `real list coverage must include: ${marker}`);
}
check(source.listTest.includes('\\"value\\":\\"已审核\\"'), "list integration coverage must exercise the visible Chinese status column filter");
check(source.tenantTest.includes("sameBillNumberFactsListsInventoryAndLogsStayInsideEachRoutedTenant"), "tenant test must cover same-number routed isolation");
check(source.tenantTest.includes("public.sys_operation_log"), "tenant test must prove material scrap logs never land in public");
check(source.numberingTest.includes("hasSize(27)") && source.numberingTest.includes('"materialScrap"'), "numbering integration test must freeze the 27th rule");
check(source.lifecycleTest.includes('Map.entry("materialScrap", "production.document.audit")'), "lifecycle permission test must freeze materialScrap permission");

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({
  task: "A151",
  generatedAt: new Date().toISOString(),
  ok: true,
  assertionCount: assertions.length,
  assertions
}, null, 2) + "\n");

console.log(`A151 material scrap backend regression PASS (${assertions.length} assertions)`);
