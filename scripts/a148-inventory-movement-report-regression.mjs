#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertReportImportGraph } from "./helpers/report-import-graph.mjs";

const root = path.resolve(import.meta.dirname, "..");
const checks = [];

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function check(condition, message) {
  assert(condition, message);
  checks.push(message);
}

function contains(source, pattern, message) {
  check(pattern.test(source), message);
}

function excludes(source, pattern, message) {
  check(!pattern.test(source), message);
}

const paths = {
  spec: "backend/src/main/java/com/jdy/erp/inventory/application/InventoryMovementReportQuerySpec.java",
  test: "backend/src/test/java/com/jdy/erp/inventory/application/InventoryMovementReportQueryIntegrationTest.java",
  page: "frontend/src/components/report/ReportQueryPage.vue",
  composable: "frontend/src/components/report/useReportQuery.ts",
  types: "frontend/src/modules/reports/reportTypes.ts",
  registry: "frontend/src/modules/reports/reportRegistry.ts",
  domainConfig: "frontend/src/modules/reports/inventoryMovementReport.ts",
  api: "frontend/src/services/reportApi.ts",
  app: "frontend/src/app/App.vue",
  catalog: "frontend/src/modules/catalog.ts",
  css: "frontend/src/styles/base.css",
  manifest: "config/regression-manifest.json"
};

for (const [name, relativePath] of Object.entries(paths)) {
  check(existsSync(path.join(root, relativePath)), `A148 ${name} 文件必须存在`);
}

const spec = read(paths.spec);
const integrationTest = read(paths.test);
const page = read(paths.page);
const composable = read(paths.composable);
const reportTypes = read(paths.types);
const registry = read(paths.registry);
const domainConfig = read(paths.domainConfig);
const api = read(paths.api);
const app = read(paths.app);
const catalog = read(paths.catalog);
const css = read(paths.css);
const manifest = JSON.parse(read(paths.manifest));

// Shared type ownership is deliberately runtime-free and acyclic.
excludes(reportTypes, /^\s*import\s/m, "reportTypes.ts 必须零 import");
excludes(reportTypes, /\b(?:const|let|function|class|new)\b/, "reportTypes.ts 只能声明类型，不得产生 runtime");
for (const [name, source] of Object.entries({ registry, domainConfig, composable, page })) {
  contains(source, /import\s+type\s+[\s\S]{0,240}from\s+["'][^"']*reportTypes["']/, `${name} 必须单向 import type reportTypes`);
  excludes(source, /import\s+(?!type\b)[^;\n]*from\s+["'][^"']*reportTypes["']/, `${name} 不得 runtime import reportTypes`);
}
contains(registry, /import \{ inventoryMovementReport \} from "\.\/inventoryMovementReport"/, "registry 必须 runtime import 精确领域 config");
contains(registry, /new Map<string, ReportDefinition>\(\)/, "registry 必须使用精确 entry map");
contains(registry, /registry\.get\(entryId\) \?\? null/, "未登记 report entry 必须返回 null 而非默认报表");
excludes(domainConfig, /reportRegistry|reportDefinitionForEntryId/, "领域 config 不得反向 import registry");
const importGraph = assertReportImportGraph(root);
check(importGraph.checked, "A148 必须调用共享 helper 实际扫描 report import graph");

// Backend definition: one server-scoped inventory fact and honest trace/date semantics.
contains(spec, /REPORT_KEY = "inventory-movement-detail"/, "F042 report key 必须精确登记");
contains(spec, /"inventory\.stock\.view"/, "F042 查询与引出必须要求库存查看权限");
contains(spec, /\.bindSourceDataScope\("inventory"\)/, "F042 必须绑定 server-owned inventory data scope");
contains(spec, /FROM \(\s*SELECT formal_txn\.\*,[\s\S]*?FROM inv_stock_txn formal_txn[\s\S]*?formal_txn\.account_set_id = \?::uuid/, "正式事实必须先按 inventory scope 过滤 inv_stock_txn");
contains(spec, /formal_txn\.trace_quality IN \('EXACT', 'CONTROLLED', 'HEADER_ONLY', 'LEGACY'\)/, "TEST 必须在日期降级前从事实子查询排除");
contains(spec, /formal_txn\.qty_delta <> 0/, "零数量预留释放不得进入商品收发");
contains(spec, /formal_txn\.source_bill_date IS NOT NULL OR formal_txn\.trace_quality = 'LEGACY'/, "只有 LEGACY 可缺失业务日期");
contains(spec, /txn\.trace_quality = 'LEGACY' AND txn\.source_bill_date IS NULL[\s\S]*?txn\.occurred_at AT TIME ZONE 'Asia\/Shanghai'[\s\S]*?'POSTING_FALLBACK'/, "LEGACY 空日期必须固定使用上海记账日期并显式标记");
contains(spec, /ELSE 'BUSINESS_DATE'/, "其他正式事实必须标记 BUSINESS_DATE");
contains(spec, /qty_delta > 0 THEN txn\.qty_delta ELSE 0::numeric/, "正向数量必须只计入入库");
contains(spec, /qty_delta < 0 THEN abs\(txn\.qty_delta\) ELSE 0::numeric/, "负向数量必须以绝对值只计入出库");
contains(spec, /txn\.qty_on_hand_after AS "qtyOnHandAfter"/, "结存必须读取事实落库值");
excludes(spec, /inv_stock_balance|qty_on_hand\s+AS|current balance/i, "报表不得从当前余额猜历史结存");
contains(spec, /txn\.trace_quality = 'EXACT'[\s\S]*?sales_out_header\.id IS NOT NULL[\s\S]*?sales_out_line\.id IS NOT NULL[\s\S]*?THEN 'salesOut'/, "只有验证真实头行映射的 EXACT 才可钻取");
contains(spec, /sales_out_header\.id = txn\.source_bill_id[\s\S]*?sales_out_header\.bill_no = txn\.source_bill_no[\s\S]*?sales_out_line\.id = txn\.source_bill_line_id[\s\S]*?sales_out_line\.bill_id = sales_out_header\.id/, "EXACT 钻取必须同时验证 header、billNo 与 line 归属");
for (const target of ["salesOut", "salesReturn", "purchaseIn", "purchaseReturn", "materialIssue", "productIn", "otherStockIn", "otherStockOut", "stockTransfer", "stockCountGain", "stockCountLoss"]) {
  contains(spec, new RegExp(`THEN '${target}'`), `EXACT 真实来源必须登记 ${target} 钻取目标`);
}
contains(spec, /PRODUCTION_MATERIAL_ISSUE[\s\S]*?PRODUCTION_COMPLETION[\s\S]*?OPENING_STOCK/, "来源显示必须使用 A147 实际写入类型并兼容库存期初");
contains(spec, /ELSE NULL[\s\S]*?END AS "sourceTarget"/, "不可信来源必须返回只读 target=null");
contains(spec, /\.totalGroupColumns\("productId", "productCode", "productName", "unit"\)[\s\S]*?\.totalSum\("inboundQty"[\s\S]*?\.totalSum\("outboundQty"/, "数量 totals 必须按稳定商品身份+单位分组且由服务端求和");
contains(spec, /历史记账日期（业务日期缺失）[\s\S]*?AS "dateBasisLabel"[\s\S]*?历史结存不可精确还原[\s\S]*?AS "balanceBasisLabel"/, "CSV 必须保留机器枚举并提供日期/结存中文降级说明");
contains(spec, /历史流水（源单不可定位）[\s\S]*?AS "traceQualityLabel"[\s\S]*?csvColumn\("来源定位说明", "traceQualityLabel"/, "CSV 必须为不可定位来源提供中文说明而非只输出机器枚举");
contains(spec, /\.requiredDateRange\("businessDate", PredicatePlacement\.FACT\)/, "日期必须在事实层过滤");
for (const filter of ["sourceType", "sourceBillNo", "product", "warehouse"]) {
  contains(spec, new RegExp(`FilterDefinition\\.contains\\(\\s*"${filter}"`), `F042 必须支持 ${filter} 业务筛选`);
}
excludes(spec, /unitCost|unit_cost|amount|currency/i, "F042 第一版不得伪造成本、金额或币种字段");

// Dynamic PostgreSQL proof covers both routing shapes and every SQL consumer.
contains(integrationTest, /CREATE DATABASE[\s\S]*?DROP DATABASE IF EXISTS/, "A148 集成测试必须创建并销毁随机数据库");
contains(integrationTest, /refuses shared jdy_erp/, "A148 集成测试必须拒绝共享 jdy_erp");
contains(integrationTest, /setDatabaseTimeZone\(settings, databaseName, "America\/Los_Angeles"\)/, "UTC 跨日夹具必须使用非上海 session 时区");
contains(integrationTest, /2026-07-13T16:30:00Z/, "LEGACY 夹具必须跨 UTC/上海业务日期边界");
contains(integrationTest, /startsWith\("2026-07-14"\)/, "LEGACY 跨日必须稳定落到上海 2026-07-14");
contains(integrationTest, /TenantContext\.setTenant\(tenant\(PUBLIC_ACCOUNT_SET[\s\S]*?assertScope[\s\S]*?TenantContext\.setTenant\(tenant\(TENANT_ACCOUNT_SET/, "必须同时执行 registered public 与 tenant scope");
contains(integrationTest, /insertFixture\(platformJdbc, "public", PUBLIC_ACCOUNT_SET, DECOY_SCOPE[\s\S]*?insertFixture\(platformJdbc, tenantSchema, tenantScope, DECOY_SCOPE/, "public 与 tenant 必须各有同条件其他 UUID decoy");
contains(integrationTest, /response\.total\(\)[\s\S]*?response\.rows\(\)[\s\S]*?response\.totals\(\)[\s\S]*?prepareExport[\s\S]*?doesNotContain\(excludedPrefix\)/, "count/rows/totals/export 四路必须排除 decoy");
contains(integrationTest, /artifact\.rowCount\(\)\)\.isEqualTo\(response\.total\(\)\)/, "CSV 行数必须与页面 total 一致");
contains(integrationTest, /12\.3400[\s\S]*?2\.5000[\s\S]*?1\.1250/, "CSV 必须保留 BigDecimal 原始 scale");
contains(integrationTest, /"PCS"[\s\S]*?"kg"/, "数量 totals 必须用不同单位夹具证明不混量纲");
contains(integrationTest, /P-001[\s\S]*?"PCS"[\s\S]*?P-003[\s\S]*?"PCS"/, "两个不同商品即使单位相同也必须形成独立 totals 行");
contains(integrationTest, /"TEST"[\s\S]*?"0\.0000"[\s\S]*?"HEADER_ONLY"/, "动态夹具必须包含 TEST、零数量和非法空日期正式行的反例");
contains(integrationTest, /assertStablePagination[\s\S]*?assertEmptyResult[\s\S]*?assertInvalidQuery[\s\S]*?assertExportLimit[\s\S]*?assertAllMappedExactDrills/, "每个 report key 必须覆盖分页稳定性、空态、400、413 与全部可用 EXACT 钻取");
for (const status of ["BAD_REQUEST", "FORBIDDEN", "PAYLOAD_TOO_LARGE"]) {
  contains(integrationTest, new RegExp(`HttpStatus\\.${status}`), `动态验收必须覆盖 ${status}`);
}
contains(integrationTest, /verify\(dataScopeService, times\(11\)\)\.currentScopeId\("inventory"\)/, "每次通过权限的 query/export 必须只解析一次 inventory scope");
contains(integrationTest, /databaseExists\(settings, databaseName\)\)\.isFalse\(\)/, "随机 PostgreSQL 数据库 residue 必须为零");

// Shared page owns query state, stale-response protection and server totals rendering.
contains(api, /\/api\/reports\/\$\{encodeURIComponent\(reportKey\)\}/, "前端必须调用共享 report API");
contains(api, /exporting \? "\/export\.csv"/, "引出必须调用同 report key 的 export.csv");
for (const status of ["400", "403", "404", "413"]) {
  contains(api, new RegExp(`status === ${status}`), `report API 必须显式处理 HTTP ${status}`);
}
contains(composable, /queryController\?\.abort\(\)[\s\S]*?const serial = \+\+querySerial[\s\S]*?serial !== querySerial/, "查询必须 abort+serial 防止旧响应覆盖");
contains(composable, /exportController\?\.abort\(\)[\s\S]*?const serial = \+\+exportSerial[\s\S]*?serial !== exportSerial/, "引出必须有独立 abort+serial");
contains(composable, /resetForAccountSet\(\)[\s\S]*?invalidateRequests\(\)[\s\S]*?response\.value = null[\s\S]*?loadAppliedQuery/, "切账套必须先清空结果、使旧响应失效再查询");
contains(composable, /loadAppliedQuery\(\)[\s\S]*?invalidateExportForQueryChange\(\)[\s\S]*?exportSerial \+= 1[\s\S]*?exportController\?\.abort\(\)/, "任一查询变化必须中止旧条件引出并使其响应失效");
contains(composable, /response\.value\?\.query \?\? appliedQuery\.value/, "引出必须复用服务端 normalized query");
excludes(composable + page, /parseFloat\(|parseInt\(|Number\(\s*row|reduce\(\s*\([^)]*total/i, "前端不得把精确数量转浮点或重算 totals");
contains(page, /^(?=[\s\S]*const TOTALS_PAGE_SIZE = 20)(?=[\s\S]*const TOTALS_SCROLL_ROWS = 3)(?=[\s\S]*visibleTotals = computed\(\(\) => totals\.value\.slice\(totalsOffset\.value, totalsOffset\.value \+ TOTALS_PAGE_SIZE\)\))(?=[\s\S]*ref="reportTableWrap")(?=[\s\S]*<TableCore[\s\S]*?:rows="rows")(?=[\s\S]*:footer-wrapper-attrs="totalFooterAttrs")(?=[\s\S]*<template #footer>[\s\S]*?visibleTotals[\s\S]*?:title="totalCell\(totalRow, column\.key, columnIndex\)")(?=[\s\S]*report-total-pagination[\s\S]*?role="navigation"[\s\S]*?aria-live="polite"[\s\S]*?report-total-prev[\s\S]*?report-total-next)(?=[\s\S]*totalFooterAttrs = computed[\s\S]*totals\.value\.length === 0[\s\S]*"aria-hidden": "true"[\s\S]*currentPageScrollable = visibleTotals\.value\.length > TOTALS_SCROLL_ROWS[\s\S]*role: "region"[\s\S]*tabindex: currentPageScrollable \? 0 : -1)(?=[\s\S]*async function resetTotalsViewport\(\)[\s\S]*await nextTick\(\)[\s\S]*querySelector<HTMLElement>\("\.table-core-footer-wrapper"\)[\s\S]*footer\.scrollTop = 0)/, "共享页必须只分页展示服务端 totals、禁止挂载无界合计 DOM，并保留 title、按真实滚动状态暴露的可访问组页导航与翻页回顶");
contains(page, /历史结存不可精确还原/, "缺失历史结存必须明确降级提示");
contains(page, /历史记账日期（业务日期缺失）/, "POSTING_FALLBACK 日期必须明确提示");
contains(domainConfig, /历史流水（源单不可定位）/, "不可定位历史来源必须由 typed trust contract 明确保持只读");
contains(domainConfig, /sourceDrill:[\s\S]*?targets:[\s\S]*?trust:[\s\S]*?acceptedValues: \["EXACT"\]/, "库存领域配置必须通过共享 typed contract 要求 EXACT + trusted target");
contains(page, /props\.definition\.sourceDrill[\s\S]*?drill\.targets\.some[\s\S]*?drill\.trust\.acceptedValues\.includes/, "共享页面必须执行 definition 声明的 target/trust contract");
excludes(page, /trustedSourceTargets|row\.traceQuality === "EXACT"/, "共享页面不得硬编码库存 target 或 EXACT 规则");
contains(page, /#header-cell="\{ column, startResize \}"[\s\S]*?table-core-column-resizer[\s\S]*?startResize\(column, \$event\)/, "自定义排序表头必须保留真实列宽拖拽热区");
for (const marker of ["report-filter-form", "report-query-summary", "report-refresh", "report-export", "report-column-settings", "report-empty", "report-error", "report-pagination"]) {
  contains(page, new RegExp(marker), `共享页缺少 ${marker} 状态或动作`);
}
contains(css, /\.report-result-table__body td[\s\S]*?overflow: hidden;[\s\S]*?text-overflow: ellipsis;[\s\S]*?\.report-result-table \.table-core-footer-wrapper[\s\S]*?max-height: 96px;[\s\S]*?overflow-y: auto;[\s\S]*?\.report-total-row td[\s\S]*?background: #fff5c9[\s\S]*?text-overflow: ellipsis;/, "报表明细必须范围化截断长文本，高基数组服务端合计必须保留黄色语义且独立限高滚动");
contains(css, /\.report-table-wrap[\s\S]*?overflow: hidden[\s\S]*?\.report-table-wrap > \.table-core-frame/, "页面不得横向溢出，横滚只能留在 TableCore");
contains(css, /@media \(max-width: 1366px\)[\s\S]*?\.report-filter-grid/, "共享页必须有 1366 宽度适配");

// Shell routing remains exact; the verified report is now published through its frozen owner and permission.
contains(
  catalog,
  /id: "inventory-movement-detail", label: "商品收发明细", module: "库存管理", mode: "report", queryable: true, permission: "inventory\.stock\.view"/,
  "F042 必须以 inventory.stock.view 发布商品收发明细 catalog 入口"
);
contains(app, /v-else-if="activeReportDefinition"[\s\S]*?<DataListPage[\s\S]*?tabs\.activeTab\.value\.kind === 'report'/, "精确 registry 报表走 ReportQueryPage，既有 report 仍走 DataListPage");
contains(app, /tabs\.activeTab\.value\.kind === "report"[\s\S]*?reportDefinitionForEntryId\(tabs\.activeTabId\.value\)[\s\S]*?: null/, "App 必须同时校验 tab kind 与精确 registry entry");
contains(app, /:key="activeReportDefinition\.entryId"/, "不同 report key 切换必须销毁旧查询状态而非复用组件");
contains(app, /openReportSourceDocument[\s\S]*?openableDocumentTarget\(payload\.type\)\.tabId[\s\S]*?confirmDirtyTabReplacement\(targetTabId[\s\S]*?openDocumentFromModule/, "报表钻取覆盖既有同类型表单前必须复用 dirty replacement 确认");
excludes(app, /ReportQueryPage[\s\S]{0,180}tabs\.activeTab\.value\.kind === ['"]report['"]/, "不得对所有 report kind 做 ReportQueryPage blanket fallback");

for (const area of ["inventory", "reports", "table", "security"]) {
  check(manifest.areas?.[area]?.includes("scripts/a148-inventory-movement-report-regression.mjs"), `manifest area:${area} 必须登记 A148`);
}
check(manifest.full?.includes("scripts/a148-inventory-movement-report-regression.mjs"), "manifest full 必须登记 A148");
execFileSync(process.execPath, [path.join(root, "scripts/validate-regression-manifest.mjs")], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"]
});
checks.push("regression manifest 必须通过全量路径验证");

const verificationDir = path.join(root, "verification");
mkdirSync(verificationDir, { recursive: true });
writeFileSync(path.join(verificationDir, "a148-inventory-movement-report-regression.json"), `${JSON.stringify({
  taskId: "A148",
  generatedAt: new Date().toISOString(),
  checks: checks.length,
  status: "passed"
}, null, 2)}\n`, "utf8");
console.log(`[a148-inventory-movement-report] ${checks.length} assertions passed`);
