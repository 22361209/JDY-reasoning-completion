#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertReportImportGraph } from "./helpers/report-import-graph.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const resultPath = path.join(verificationDir, "a152-material-scrap-ui-regression.json");
const paths = {
  contract: "docs/12-当前批次验收清单.md",
  lifecycleProtocol: "docs/guides/bill-lifecycle-unification-protocol.md",
  reportProtocol: "docs/guides/report-query-protocol.md",
  actionRules: "docs/guides/action-button-rules.md",
  backend: "backend/src/main/java/com/jdy/erp/production/application/MaterialScrapReportQuerySpec.java",
  controller: "backend/src/main/java/com/jdy/erp/production/api/MaterialScrapController.java",
  issueBackend: "backend/src/main/java/com/jdy/erp/production/application/MaterialIssueAppService.java",
  test: "backend/src/test/java/com/jdy/erp/production/application/MaterialScrapReportQueryIntegrationTest.java",
  form: "frontend/src/modules/production/material-scrap/MaterialScrapForm.vue",
  document: "frontend/src/modules/production/material-scrap/useMaterialScrapDocument.ts",
  table: "frontend/src/components/MaterialScrapEntryTable.vue",
  issue: "frontend/src/modules/production/material-issue/MaterialIssueForm.vue",
  productionApi: "frontend/src/services/productionApi.ts",
  documentApi: "frontend/src/services/documentApi.ts",
  policy: "frontend/src/app/documentLifecyclePolicy.ts",
  app: "frontend/src/app/App.vue",
  listDefinition: "frontend/src/components/list/useDataListDefinition.ts",
  listPage: "frontend/src/components/DataListPage.vue",
  report: "frontend/src/modules/reports/materialScrapReport.ts",
  registry: "frontend/src/modules/reports/reportRegistry.ts",
  catalog: "frontend/src/modules/catalog.ts"
};
const sources = Object.fromEntries(Object.entries(paths).map(([key, relativePath]) => [key, read(relativePath)]));
const checks = [];

function read(relativePath) {
  return readFileSync(path.join(rootDir, relativePath), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  checks.push(message);
}

function contains(source, pattern, message) {
  assert(pattern.test(source), message);
}

function excludes(source, pattern, message) {
  assert(!pattern.test(source), message);
}

function occurrences(source, literal) {
  return source.split(literal).length - 1;
}

function appearsBefore(source, earlier, later, message) {
  const earlierIndex = source.indexOf(earlier);
  const laterIndex = source.indexOf(later);
  assert(earlierIndex >= 0 && laterIndex > earlierIndex, message);
}

function sliceBetween(source, start, end, message) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert(startIndex >= 0 && endIndex > startIndex, message);
  return source.slice(startIndex, endIndex);
}

contains(sources.contract, /\| A152 \| F061 页面、前端生命周期 wiring 与材料报废统计 A3 \| A151 \|/, "A152 合同必须锁定 F061 页面、前端生命周期和统计范围");
contains(sources.contract, /不提前恢复旧 `scrap-report` fallback/, "A152 合同必须禁止提前恢复旧 scrap-report fallback");
contains(sources.contract, /MaterialScrapForm\.vue` 复用 `StandardDocument`\/`ActionBar`/, "F061 页面必须遵循 StandardDocument 与 ActionBar 合同");
contains(sources.contract, /MaterialScrapEntryTable\.vue`；该组件内部复用共享 `TableCore`/, "F061 专用分录表必须内部复用 TableCore");
contains(sources.lifecycleProtocol, /前端 `materialScrap`；后端 target\/header `production_material_scrap`/, "生命周期协议必须登记 materialScrap 精确 target");
contains(sources.reportProtocol, /`material-scrap-summary` \| F061 材料报废统计 \| 已审核正式材料报废单/, "报表协议必须登记正式 F061 report key");
contains(sources.reportProtocol, /F042\/F061 等纯数量报表不伪造 currency/, "报表协议必须冻结 F061 数量-only 边界");
contains(sources.actionRules, /列表页和单据详情页必须使用同一份生命周期能力口径/, "页面和列表必须复用统一生命周期动作口径");

assert(occurrences(sources.backend, '"material-scrap-summary"') === 1, "后端必须精确登记一次 material-scrap-summary");
contains(sources.backend, /PERMISSION = "production\.document\.audit"/, "F061 单据和统计必须复用 production.document.audit");
contains(sources.backend, /WHERE scrap\.status = 'AUDITED'/, "统计事实只允许已审核材料报废单");
contains(sources.backend, /requiredDateRange\("businessDate", PredicatePlacement\.FACT\)/, "日期必须在聚合前 FACT 层过滤");
contains(sources.backend, /GROUP BY "workshopId", "productId", "unit"/, "报废数量必须按车间 UUID、商品 UUID 和单位快照分组");
contains(sources.backend, /jsonb_build_array\("workshopId", "productId", "unit"\)::text AS "rowKey"/, "稳定行键必须使用无碰撞 identity tuple");
contains(sources.backend, /totalGroupColumns\("unit"\)[\s\S]*totalSum\("scrapQty", "scrapQty"\)/, "报表 totals 只能按单位汇总报废数量");
contains(sources.backend, /\.filter\(FilterDefinition\.enumEquals\(\s*"businessType",\s*"businessType",\s*PredicatePlacement\.FACT,\s*"PRODUCTION_SCRAP"\s*\)\)/, "businessType 必须以固定枚举在 FACT 层过滤");
for (const filter of ["workshopId", "productId"]) {
  contains(sources.backend, new RegExp(`\\.filter\\(FilterDefinition\\.equals\\(\\s*"${filter}",\\s*"${filter}",\\s*ValueType\\.UUID,\\s*PredicatePlacement\\.FACT\\s*\\)\\)`), `${filter} 必须以 UUID 在 FACT 层过滤`);
}
contains(sources.backend, /\.filter\(FilterDefinition\.contains\(\s*"scrapReason",\s*"scrapReason",\s*PredicatePlacement\.FACT\s*\)\)/, "scrapReason 必须在 FACT 层执行包含过滤");
excludes(sources.backend, /currency|amount|cost|priceTaxTotal/i, "F061 后端报表不得伪造币种、金额或成本");
contains(sources.controller, /DocumentLockService lockService/, "材料报废 controller 必须注入共享编辑锁服务");
contains(sources.controller, /saveDraft\(@RequestBody ScrapDraftRequest request\)[\s\S]*lockService\.assertWritable\("materialScrap", request\.billNo\(\)\)[\s\S]*materialScrapAppService\.saveDraft\(request\)[\s\S]*lockService\.releaseIfOwned\([\s\S]*"materialScrap"/, "已有材料报废草稿保存必须先验写锁并在成功后释放当前持有锁");
contains(sources.test, /createDatabase\(settings, databaseName\)/, "测试必须创建隔离 PostgreSQL 数据库");
contains(sources.test, /new TenantRoutingDataSource\(platformDataSource, tenantRegistry\)/, "测试必须执行租户数据源路由");
contains(sources.test, /var tenantSchema = "tenant_a152"/, "测试必须创建独立 tenant schema");
contains(sources.test, /TenantContext\.setTenant\(tenant\(PUBLIC_ACCOUNT_SET,[\s\S]*TenantContext\.setTenant\(tenant\(TENANT_ACCOUNT_SET/, "测试必须真实切换 public 与 tenant schema 路由");
contains(sources.test, /prefix \+ "-DRAFT"[\s\S]*"DRAFT"[\s\S]*prefix \+ "-VOID"[\s\S]*"VOID"/, "测试必须放置草稿和作废诱饵并证明不统计");
contains(sources.test, /REVERSE-AUDITED[\s\S]*SET status = 'DRAFT'[\s\S]*SET status = 'AUDITED'[\s\S]*SET status = 'DRAFT'/, "测试必须执行审核、反审核剔除与重新审核状态切换");
contains(sources.test, /assertScopeGroupingTotalsAndCsv\(service, "PUBLIC", "TENANT"[\s\S]*assertScopeGroupingTotalsAndCsv\(service, "TENANT", "PUBLIC"/, "测试必须分别验证 public 与 tenant 查询作用域");
contains(sources.test, /assertThat\(response\.rows\(\)\)\.noneSatisfy[\s\S]*contains\(excludedPrefix\)/, "测试必须断言当前 tenant 结果不含另一 tenant 商品");
contains(sources.test, /response\.totals\(\)\)\.hasSize\(3\)/, "测试必须断言数量 totals 按三个单位分组");
contains(sources.test, /containsEntry\("unit", "PCS"\)[\s\S]*containsEntry\("unit", "KG"\)/, "测试必须分别校验 PCS 与 KG 数量 totals");
assert(occurrences(sources.test, 'insertScrap(jdbc, schema, "A152-SHARED-BILL"') === 1, "fixture 构造器必须让 public 与 tenant schema 使用同一材料报废单号");
contains(sources.test, /assertSameBillNoTenantIsolation\(service, "PUBLIC", "TENANT", "31"\)[\s\S]*assertSameBillNoTenantIsolation\(service, "TENANT", "PUBLIC", "41"\)/, "相同单号必须在两个 tenant 下返回各自不同事实");
contains(sources.test, /prepareExport\(MaterialScrapReportQuerySpec\.REPORT_KEY[\s\S]*artifact\.rowCount\(\)\)\.isEqualTo\(response\.total\(\)\)[\s\S]*artifact\.release\("a152-tenant-scope-proof"\)[\s\S]*Files\.exists\(path\)\)\.isFalse\(\)/, "测试必须证明 CSV 与查询同 predicate 且导出临时文件被清理");
contains(sources.test, /pageOne\.total\(\)\)\.isEqualTo\(21L\)[\s\S]*pageTwo\.rows\(\)\)\.hasSize\(1\)/, "测试必须覆盖 20+1 稳定分页");
contains(sources.test, /"businessType", List\.of\("OTHER"\)[\s\S]*HttpStatus\.BAD_REQUEST/, "报表查询测试必须拒绝非法 businessType 过滤参数");
contains(sources.test, /"currency", List\.of\("USD"\)/, "测试必须拒绝 quantity-only 报表的 currency 参数");
contains(sources.test, /doThrow\(new ResponseStatusException\(HttpStatus\.FORBIDDEN[\s\S]*verify\(permissionService, atLeastOnce\(\)\)\.requirePermission\("production\.document\.audit"\)/, "测试必须执行并验证真实报表权限门禁");
contains(sources.test, /dropDatabase\(settings, databaseName\)[\s\S]*databaseExists\(settings, databaseName\)\)\.isFalse\(\)/, "测试必须销毁隔离数据库并验证清理完成");

contains(sources.form, /<StandardDocument/, "材料报废页面必须直接复用 StandardDocument");
contains(sources.form, /<MaterialScrapEntryTable/, "材料报废页面必须使用专用分录表");
contains(sources.form, /<SourceSelectorDialog/, "材料报废页面必须提供真实来源选择器");
contains(sources.form, /source-select-test-id="material-scrap-open-source-selector"/, "材料报废选源动作必须可验收");
contains(sources.form, /:can-source-select="document\.canSourceSelect\.value"[\s\S]*if \(!document\.canSourceSelect\.value \|\| props\.locked \|\| !sourceSelectorOpen\.value\)/, "已保存、切账套或锁状态变化后必须在确认时再次阻止选源");
contains(sources.form, /extra-action-test-id="material-scrap-stock-action"/, "独立整单报废入库动作必须可验收");
contains(sources.form, /:dirty="dirty"[\s\S]*@create="requestStartNew"[\s\S]*requestStartNew: \[payload: \{ dirtyAlreadyConfirmed: boolean \}\]/, "页面必须保留 StandardDocument 未保存提示，并把已确认状态交给 App replacement helper");
contains(sources.form, /emit\("requestStartNew", \{ dirtyAlreadyConfirmed: props\.dirty \}\)/, "StandardDocument 确认新增后必须显式携带当时 dirty 状态");
excludes(sources.form, /:dirty="false"|emit\(["'](?:markDirty|clearDirty)["']\)/, "页面不得绕过标准 dirty 提示或依赖卸载组件 emit 同步 dirty");
contains(sources.form, /beginPreviewOperation\(\)[\s\S]*selectedBillNo !== billNo[\s\S]*sourceSelectorOpen\.value[\s\S]*finishPreviewOperation\(requestEpoch\)/, "异步选源预览必须防双击、校验选择与弹窗仍打开，并在 finally 解除共享 busy");
for (const action of ["close", "freeze", "red-reverse"]) {
  contains(sources.form, new RegExp(`:show-${action}="false"`), `F061 页面不得显示 ${action} 动作`);
}
excludes(sources.form, /import DocumentForm|<DocumentForm/, "F061 专用页面不得复用或修改共享 DocumentForm");

contains(sources.document, /scrapQty == null \|\| scrapQty < 0/, "草稿报废数量必须允许 0 但拒绝负数");
contains(sources.document, /canSourceSelect = computed\(\(\) => editable\.value && !persisted\.value\)/, "选源只允许未持久化的新草稿");
contains(sources.document, /reissueQty == null \|\| reissueQty < 0 \|\| reissueQty > scrapQty/, "重发数量必须保持 0 到报废数量闭区间");
contains(sources.document, /审核时报废数量必须大于 0/, "审核必须要求报废数量大于 0");
contains(sources.document, /审核时必须填写报废原因/, "审核必须要求报废原因");
contains(sources.document, /stockInStatus !== "STOCKED_IN"/, "存在已生效报废入库时前端必须禁用反审核");
contains(sources.document, /voidDocumentHardened\("materialScrap"/, "草稿作废必须走共享加固生命周期端点");
contains(sources.document, /reverseStockInMaterialScrap[\s\S]*stockInMaterialScrap/, "报废入库与撤销入库必须是显式独立动作");
contains(sources.document, /sourceIssueLineId: stringValue\(line\.sourceIssueLineId \|\| line\.id\)/, "preview 必须把来源领料行 id 规范为 sourceIssueLineId");
contains(sources.document, /let sharedRuntime: MaterialScrapSharedRuntime \| null = null;[\s\S]*state: reactive<MaterialScrapState>\(blankState\(\)\)[\s\S]*saving: ref\(false\)[\s\S]*previewing: ref\(false\)[\s\S]*epoch: ref\(0\)/, "材料报废状态、busy 与 epoch 必须按当前账套共享，跨组件 remount 保持同一 reactive runtime");
contains(sources.document, /export const materialScrapSharedBusy = ref\(false\)[\s\S]*syncMaterialScrapSharedBusy/, "App 必须直接观察不依赖组件 mount 的共享 mutation busy");
contains(sources.document, /export const materialScrapSharedDirty = ref\(false\)[\s\S]*export const materialScrapSharedDirtyRevision = ref\(0\)[\s\S]*setMaterialScrapSharedDirty/, "dirty 与变更序号必须由跨 remount 的 module runtime 权威持有");
contains(sources.document, /startNewMaterialScrapSharedRuntime[\s\S]*setMaterialScrapSharedDirty\(target, true, true\)[\s\S]*applyMaterialScrapSharedDetail[\s\S]*setMaterialScrapSharedDirty\(target, false\)/, "共享新增必须标脏，详情加载必须清脏");
contains(sources.document, /resetMaterialScrapRuntime[\s\S]*sharedRuntime\.epoch\.value \+= 1;[\s\S]*sharedRuntime = null;[\s\S]*materialScrapSharedBusy\.value = false/, "切账套或关闭页签必须销毁旧账套 runtime 并使旧 epoch 失效");
excludes(sources.document, /savedSnapshots|new Map<string, MaterialScrapState>/, "不得缓存并恢复已离开的旧账套材料报废草稿");
contains(sources.document, /applyMaterialScrapSharedDetail\([\s\S]*expectedBillNo: string[\s\S]*document\.billNo !== expectedBillNo/, "共享详情写入必须校验响应单号与请求单号一致");
contains(sources.document, /clearMaterialScrapSharedActionState[\s\S]*pendingAction\.value = ""[\s\S]*voidPassword\.value = ""/, "换单边界必须清空旧生命周期动作和作废凭据");
const saveSource = sliceBetween(sources.document, "  async function save()", "  async function audit()", "必须能提取材料报废 save 实现");
contains(saveSource, /if \(saving\.value \|\| !canSave\.value\) return;[\s\S]*saving\.value = true;[\s\S]*syncMaterialScrapSharedBusy\(shared\)[\s\S]*await saveMaterialScrapDraft[\s\S]*finally \{[\s\S]*saving\.value = false/, "材料报废首次保存必须同步共享 busy 并 try/finally 防止双击创建两张草稿");
contains(saveSource, /state\.document = normalizeDocument\(\{ \.\.\.state\.document, \.\.\.savedHeader, billNo \}\);[\s\S]*setMaterialScrapSharedDirty\(shared, false\);[\s\S]*await fetchMaterialScrapDetail\(billNo\)/, "保存响应必须先写入共享 state 的单号和版本并以 module 状态清 dirty，再尝试刷新详情");
excludes(saveSource, /runtime\.clearDirty|emit\(/, "首存异步回包不得依赖已卸载 MaterialScrapForm 的 emit");
contains(sources.document, /材料报废草稿 \$\{billNo\} 已保存，但刷新失败/, "保存后刷新失败必须明确保留已生成单号");
contains(sources.document, /async function audit\(\)[\s\S]*operationInFlight\.value = true;[\s\S]*finally \{[\s\S]*operationInFlight\.value = false/, "审核必须使用共享 in-flight 与 try/finally 防重");
contains(sources.document, /async function confirmAction\(\)[\s\S]*mutationInFlight\.value[\s\S]*operationInFlight\.value = true;[\s\S]*finally \{[\s\S]*operationInFlight\.value = false/, "风险生命周期确认必须使用统一 mutation guard 与 try/finally 防重");
contains(sources.document, /async function confirmAction\(\)[\s\S]*if \(!pendingActionAllowed\(action\)\)[\s\S]*const result = action === "reverse"/, "风险弹窗确认必须在发送请求前重新校验当前动作能力");
contains(sources.document, /function pendingActionAllowed[\s\S]*canReverse\.value[\s\S]*canDelete\.value[\s\S]*canVoid\.value[\s\S]*canStockAction\.value/, "反审核、删除、作废和入库动作必须分别复验当前能力");
contains(sources.form, /:disabled="!document\.canConfirmPendingAction\.value"[\s\S]*@click="document\.confirmAction"/, "风险弹窗状态失效后确认按钮必须同步禁用");

contains(sources.table, /import TableCore, \{ type TableCoreColumn \} from "\.\/table\/TableCore\.vue"/, "专用分录表必须内部复用 TableCore");
contains(sources.table, /test-id="material-scrap-entry-table-core"[\s\S]*:min-width="1760"/, "宽表必须由内部 TableCore 持有最小宽度");
contains(sources.table, /material-scrap-column-drag-/, "业务列必须有可验收拖拽入口");
contains(sources.table, /material-scrap-column-filter-/, "业务列必须有可验收列头筛选入口");
contains(sources.table, /material-scrap-column-bulk-/, "适用业务列必须有可验收批量填充入口");
contains(sources.table, /material-scrap-column-resize-/, "业务列必须有可验收列宽拖曳热区");
contains(sources.table, /jdy:material-scrap-entry-columns:v1/, "列顺序、宽度和显隐必须持久化");
contains(sources.table, /key === "scrapQty"[\s\S]*key === "reissueQty"[\s\S]*value < 0/, "数量批量填充必须拒绝负数");
contains(sources.table, /:disabled="!editable"[^>]*data-testid="material-scrap-bulk-apply"[\s\S]*function applyBulkFill\(\) \{[\s\S]*if \(!editable\.value\)/, "批量填充弹层打开后若切账套或失去编辑权，按钮和处理器都必须 fail-closed");
contains(sources.table, /"data-testid": "material-scrap-entry-row"[\s\S]*"data-row-index": String\(rowIndex \+ 1\)/, "材料报废分录必须命中共享 entry-row 密度契约并保留行索引");

contains(sources.issue, /:show-extra-action="canPushDownMaterialScrap"/, "生产领料必须复用既有 showExtraAction 接缝");
contains(sources.issue, /:can-extra-action="canPushDownMaterialScrap"/, "生产领料必须复用既有 canExtraAction 接缝");
contains(sources.issue, /extra-action-label="材料报废"/, "生产领料下推动作文案必须为材料报废");
contains(sources.issue, /document\.form\.status === "AUDITED"[\s\S]*closeStatus !== "CLOSED"[\s\S]*frozenStatus !== "FROZEN"[\s\S]*!document\.form\.redSourceBillNo[\s\S]*!document\.form\.redReverseBillNo/, "材料报废下推只允许有效已审核非红字生产领料单");
contains(sources.issue, /const checkedBillNo = document\.form\.billNo;[\s\S]*checkMaterialScrapPushEligibility\(checkedBillNo\)[\s\S]*checkedBillNo === document\.form\.billNo[\s\S]*hasMaterialScrapPushHeader\.value[\s\S]*materialScrapPushEligible\.value = result\.ok && result\.eligible/, "材料报废下推按钮必须复用后端选源资格，并拒绝过期单号响应");
contains(sources.issue, /hasMaterialScrapPushHeader\.value && materialScrapPushEligible\.value/, "按钮必须同时满足头状态和后端完整 eligibility");
contains(sources.issue, /emit\("requestPushMaterialScrap", \{ issueBillNo: document\.form\.billNo \}\)/, "生产领料页必须把下推请求交给 App 统一处理脏页保护");
contains(sources.issueBackend, /i\.close_status AS "closeStatus"[\s\S]*i\.frozen_status AS "frozenStatus"/, "生产领料详情必须返回真实关闭和冻结状态供下推按钮判定");

for (const endpoint of ["material-scraps/draft", "/audit", "/reverse", "/stock-in", "/reverse-stock-in", "material-scrap-preview", "push-material-scrap"]) {
  assert(sources.productionApi.includes(endpoint), `productionApi 必须接入 ${endpoint}`);
}
contains(sources.productionApi, /listKey: "material-scrap-source-selector"/, "选源必须复用统一 list query 协议");
contains(sources.productionApi, /checkMaterialScrapPushEligibility[\s\S]*fetchListRows\("material-scrap-source-selector", \{[\s\S]*pageSize: 1[\s\S]*columnFilters: exactSourceFilter\("billNo", billNo\)/, "下推资格预检必须用精确单号过滤的单行选源查询，禁止全量 preview 或 N+1");
contains(sources.documentApi, /materialScrap: "\/api\/production\/material-scraps"/, "共享详情路由必须识别 materialScrap");
contains(sources.policy, /materialScrap: \{ closeFreezeAllowed: false, lineCloseFreezeAllowed: false, redReverseAllowed: false, voidAllowed: true \}/, "F061 前端生命周期策略必须关闭 close/freeze/red 并允许 void");

contains(sources.listDefinition, /"material-scrap-form-list": \{[\s\S]*title: "材料报废单"/, "材料报废列表必须有精确共享定义");
const materialScrapHeaderColumns = sliceBetween(
  sources.listDefinition,
  '  "material-scrap-form-list": {',
  '  "product-in-form-list": {',
  "必须能提取材料报废 header 列定义"
);
for (const field of ["billNo", "sourceIssueNo", "workshopCode", "productCode", "scrapQty", "reissueQty", "stockInStatus"]) {
  contains(materialScrapHeaderColumns, new RegExp(`field: "${field}"`), `材料报废 header 视图必须展示 ${field}`);
}
const materialScrapDetailColumns = sliceBetween(
  sources.listDefinition,
  '    if (listKey() === "material-scrap-form-list") {',
  "    const metadataDefinition = billDefinition.value;",
  "必须能提取材料报废 detail 列定义"
);
for (const field of ["sourceIssueNo", "scrapQty", "scrapReason", "reissueQty", "isStockIn", "targetWarehouseCode", "stockInStatus"]) {
  contains(materialScrapDetailColumns, new RegExp(`field: "${field}"`), `材料报废 detail 视图必须展示 ${field}`);
}
for (const columns of [materialScrapHeaderColumns, materialScrapDetailColumns]) {
  excludes(columns, /field: "(?:currency|amount|unitPrice|taxInclusiveUnitPrice|priceTaxTotal|netWeight|grossWeight)"/, "材料报废列表不得落入金额、币种或重量通用列");
}
contains(sources.listPage, /"material-scrap-form-list": "materialScrap"/, "列表打开和生命周期动作必须路由到 materialScrap");
contains(sources.listPage, /"material-scrap-form-list": "production\.document\.audit"/, "材料报废列表动作必须复用生产单据权限");
contains(sources.app, /import MaterialScrapForm from "\.\.\/modules\/production\/material-scrap\/MaterialScrapForm\.vue"/, "App 必须静态接入 MaterialScrapForm");
contains(sources.app, /materialScrapSharedBusy,[\s\S]*resetMaterialScrapRuntime,[\s\S]*const materialScrapMutationInFlight = materialScrapSharedBusy;/, "App 必须直接观察跨 remount 的共享材料报废 busy");
contains(sources.app, /materialScrapSharedDirty,[\s\S]*materialScrapSharedDirtyRevision,[\s\S]*watch\(materialScrapSharedDirty,[\s\S]*\{ flush: "sync" \}\)/, "App 必须常驻同步 module dirty 到固定材料报废页签，不能依赖组件 emit");
contains(sources.app, /:locked="materialScrapFormLocked"[\s\S]*:lock-message="materialScrapFormLockMessage"[\s\S]*:can-override-lock="materialScrapCanOverrideLock"/, "F061 必须把切账套和所有异步操作表现为明确只读状态，并隐藏并发强制解锁");
contains(sources.app, /"material-scrap-form-list": "materialScrap"/, "App 必须将列表精确映射到 materialScrap");
contains(sources.app, /case "materialScrap":[\s\S]*title: "材料报废单"/, "App 必须能打开材料报废详情页签");
const replacementSource = sliceBetween(sources.app, "function replaceMaterialScrapTab(", "function openOutsourcingForm(", "必须能提取材料报废统一 replacement helper");
contains(replacementSource, /materialScrapOpenRequestSerial[\s\S]*materialScrapReplacementQueue\.then/, "材料报废打开必须串行并丢弃过期请求");
appearsBefore(replacementSource, "accountSetSwitching.value", "const requestId =", "切账套 guard 必须在分配 replacement requestId 前 fail-closed");
appearsBefore(replacementSource, "materialScrapPushInFlight.value && !options.allowDuringPush", "const requestId =", "普通打开必须在分配 requestId 前拒绝 push pending，不能使 push-result 请求过期");
const replacementGuardSource = sliceBetween(replacementSource, "const blockedMessage", "const requestId =", "必须能提取 replacement 前置 guard");
excludes(replacementGuardSource, /materialScrapReplacementInFlight/, "快速连续打开必须允许后续请求排队替代当前请求");
contains(replacementSource, /materialScrapMutationInFlight\.value[\s\S]*confirmDirtyTabReplacement\(materialScrapTabId[\s\S]*options\.prepare\(\)[\s\S]*releaseDocumentLock\("materialScrap", previousLockBillNo\)[\s\S]*options\.apply/, "replacement helper 必须先拒绝 mutation busy，再确认 dirty、加载详情、释放旧锁和应用新页");
contains(replacementSource, /restoreReleasedMaterialScrapLock\(releasedPreviousLockBillNo, confirmedSnapshot\)/, "旧锁释放后请求失效或应用失败必须补偿恢复原锁");
contains(replacementSource, /materialScrapReplacementPendingCount \+= 1;[\s\S]*result\.finally\(\(\) => \{[\s\S]*materialScrapReplacementPendingCount - 1[\s\S]*materialScrapReplacementInFlight\.value = materialScrapReplacementPendingCount > 0/, "replacement busy 必须由队列 pending 计数收敛，过期请求也不能永久锁死");
contains(sources.app, /if \(!materialScrapInternalRollbackClose\) \{[\s\S]*materialScrapOpenRequestSerial \+= 1;[\s\S]*function rollbackMaterialScrapTabMetadata[\s\S]*materialScrapInternalRollbackClose = true;[\s\S]*tabs\.closeNow\(materialScrapTabId\)[\s\S]*materialScrapInternalRollbackClose = false/, "内部失败回滚关闭页签不得使后续排队打开请求过期");
contains(sources.app, /tab\.lockedObjectId && !\(tab\.id === materialScrapTabId && materialScrapInternalRollbackClose\)/, "内部回滚已显式释放新锁时，close hook 不得再次异步释放并误删后续同单锁");
contains(sources.app, /function materialScrapSnapshotMatches[\s\S]*current\.accountSetKey === snapshot\.accountSetKey/, "replacement snapshot 必须包含账套身份");
const pushSource = sliceBetween(sources.app, "async function pushMaterialScrapFromIssue(", "async function startNewMaterialScrapFromPage(", "必须能提取材料报废下推实现");
contains(pushSource, /accountSetSwitching\.value[\s\S]*materialScrapMutationInFlight\.value[\s\S]*materialScrapReplacementInFlight\.value[\s\S]*materialScrapOverrideInFlight\.value[\s\S]*materialScrapPushInFlight\.value = true;[\s\S]*confirmDirtyTabReplacement\(materialScrapTabId[\s\S]*const confirmedSnapshot = snapshotMaterialScrapTab\(\);[\s\S]*await pushDownMaterialIssueScrap\(issueBillNo\)[\s\S]*materialScrapAllowDuringPush: true[\s\S]*finally \{[\s\S]*materialScrapPushInFlight\.value = false/, "下推必须在 POST 前双向 fail-closed、确认并取快照，且只允许 push-result 绕过自身 push guard");
contains(pushSource, /if \(!result\.ok\) \{[\s\S]*formMessage\.value = message[\s\S]*if \(!billNo\) \{[\s\S]*formMessage\.value = message/, "下推失败或空单号必须写全局反馈，切走领料页后仍可见");
contains(pushSource, /材料报废草稿 \$\{billNo\} 已生成[\s\S]*formMessage\.value = recoveryMessage/, "下推草稿生成但打开失败时必须持久显示可找回单号");
assert(occurrences(sources.app, "materialScrapDirtyAlreadyConfirmed: true") === 1, "只有已在 POST 前确认的材料报废下推允许跳过 replacement dirty 确认");
const openNewSource = sliceBetween(sources.app, "async function openNewMaterialScrapDocument(", "async function openMaterialScrapDocument(", "必须能提取材料报废新增 helper");
contains(openNewSource, /dirtyAlreadyConfirmed\?: boolean;[\s\S]*confirmedSnapshot\?: MaterialScrapTabSnapshot;[\s\S]*replaceMaterialScrapTab\([\s\S]*tabs\.openTab\([\s\S]*if \(!opened\)[\s\S]*startNewMaterialScrapSharedRuntime\(currentMaterialScrapAccountSetKey\(\)\)/, "菜单、列表与页面新增必须复用 replacement helper，页面标准确认可携带精确快照");
excludes(openNewSource, /materialScrapFormRef\.value\?\.startNew/, "材料报废新增正确性不得依赖已挂载 form ref");
contains(sources.app, /async function startNewMaterialScrapFromPage\(payload: \{ dirtyAlreadyConfirmed: boolean \}\)[\s\S]*const snapshot = snapshotMaterialScrapTab\(\);[\s\S]*payload\?\.dirtyAlreadyConfirmed && snapshot\.dirty[\s\S]*confirmedSnapshot: dirtyAlreadyConfirmed \? snapshot : undefined/, "页面标准弹窗确认后必须同步抓快照，并只在真实 dirty 时跳过 replacement 二次确认");
contains(sources.app, /async function openCreateDocumentFromList[\s\S]*payload\.type === "materialScrap"[\s\S]*openNewMaterialScrapDocument/, "列表新增必须回到统一材料报废 helper");
contains(sources.app, /async function openDocumentFromList[\s\S]*payload\.type === "materialScrap"[\s\S]*openMaterialScrapDocument/, "列表打开材料报废必须回到统一 replacement helper");
contains(sources.app, /async function openDocumentFromModule[\s\S]*payload\.type === "materialScrap"[\s\S]*openMaterialScrapDocument/, "模块打开材料报废必须回到统一 replacement helper");
const openMaterialSource = sliceBetween(sources.app, "async function openMaterialScrapDocument(", "async function openDocumentFromList(", "必须能提取材料报废打开实现");
contains(openMaterialSource, /allowDuringPush: options\.materialScrapAllowDuringPush[\s\S]*const opened = tabs\.openTab[\s\S]*if \(!opened\)[\s\S]*applyMaterialScrapDocumentLock[\s\S]*releaseDocumentLock\("materialScrap", billNo\)/, "材料报废打开必须显式区分 push-result，检查页签上限并处理 acquire/close 竞态");
contains(openMaterialSource, /applyMaterialScrapSharedDetail\(currentMaterialScrapAccountSetKey\(\), detail, billNo, loadedMessage\)/, "锁等待期间即使 form unmount，也必须把匹配 billNo 的详情写入共享 runtime");
excludes(openMaterialSource, /materialScrapFormRef\.value\?\.applyDetail/, "材料报废详情正确性不得依赖已挂载 form ref");
excludes(openMaterialSource, /clearActiveDirty\(\)/, "材料报废异步打开不得误清当前其他表单 dirty");
contains(sources.app, /async function applyMaterialScrapDocumentLock[\s\S]*acquireDocumentLock\("materialScrap", billNo\)[\s\S]*if \(!tab \|\| !isCurrent\(\)\)[\s\S]*releaseDocumentLock\("materialScrap", billNo\)/, "acquire 完成时页签已关闭或过期必须立即释放新锁");
contains(sources.app, /restoreReleasedMaterialScrapLock[\s\S]*applyMaterialScrapDocumentLock\(previousLockBillNo[\s\S]*restoredTab\.dirty = snapshot\.dirty/, "旧锁补偿恢复后必须保留原脏页标记");
const switchSource = sliceBetween(sources.app, "async function requestAccountSetSwitch(", "function applyAccountSetSummary(", "必须能提取账套切换 guard");
contains(switchSource, /materialScrapMutationInFlight\.value[\s\S]*materialScrapReplacementInFlight\.value[\s\S]*materialScrapPushInFlight\.value[\s\S]*materialScrapOverrideInFlight\.value[\s\S]*完成前不能切换账套/, "材料报废 mutation、replacement、push 或强制解锁期间必须在请求前拒绝切账套");
contains(sources.app, /async function overrideActiveDocumentLock\(\)[\s\S]*type === "materialScrap"[\s\S]*materialScrapConcurrentOperationInFlight\.value[\s\S]*materialScrapOverrideInFlight\.value = true[\s\S]*finally \{[\s\S]*materialScrapOverrideInFlight\.value = false/, "材料报废强制解锁必须与切账套、保存、替换和下推互斥并用 finally 收敛");
contains(sources.app, /isMaterialScrap && \(!tab\.lockReadOnly \|\| !tab\.lockCanOverride\)/, "材料报废强制解锁处理器必须复验真实只读锁与 override 资格");
contains(sources.app, /function applyAccountSetSummary[\s\S]*materialScrapOpenRequestSerial \+= 1;[\s\S]*resetMaterialScrapRuntime/, "账套身份变化必须使打开请求失效并销毁旧 runtime");

assert(occurrences(sources.report, 'entryId: "material-scrap-summary"') === 1, "前端必须精确配置一次 F061 entryId");
assert(occurrences(sources.report, 'reportKey: "material-scrap-summary"') === 1, "前端必须精确配置一次 F061 reportKey");
contains(sources.report, /permission: "production\.document\.audit"/, "前端报表必须复用生产单据权限");
contains(sources.report, /groupKeys: \["unit"\][\s\S]*valueKeys: \["scrapQty"\]/, "浏览器只能展示服务端按单位返回的数量 totals");
excludes(sources.report, /\bcurrency\s*:|key:\s*"(?:amount|cost|priceTaxTotal)"|title:\s*"(?:金额|成本|含税金额)"/, "F061 前端报表不得伪造币种、金额或成本");
contains(sources.registry, /import \{ materialScrapReport \} from "\.\/materialScrapReport";/, "共享 registry 必须 runtime import F061 definition");
contains(sources.registry, /definitions[\s\S]*materialScrapReport/, "共享 registry 必须登记 F061 definition");
const importGraph = assertReportImportGraph(rootDir);
assert(importGraph.domainConfigs.includes(paths.report), "共享 report import graph 必须覆盖 F061 definition");

excludes(sources.catalog, /id: "material-scrap-form"/, "A152 不得在 A153 双视口证据前发布材料报废页面 catalog 入口");
excludes(sources.catalog, /id: "material-scrap-summary"/, "A152 不得在 A153 双视口证据前发布材料报废统计 catalog 入口");
excludes(sources.catalog, /id: ["']scrap-report["']/, "A152 不得复活旧 scrap-report fallback");

mkdirSync(verificationDir, { recursive: true });
writeFileSync(
  resultPath,
  `${JSON.stringify({
    taskId: "A152",
    generatedAt: new Date().toISOString(),
    status: "PASS",
    assertions: checks.length,
    checks,
    files: Object.values(paths)
  }, null, 2)}\n`,
  "utf8"
);

console.log(`A152 material scrap UI/report regression PASS (${checks.length} assertions)`);
console.log(`evidence: ${path.relative(rootDir, resultPath)}`);
