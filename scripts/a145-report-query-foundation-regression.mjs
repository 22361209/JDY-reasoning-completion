#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const resultPath = path.join(verificationDir, "a145-report-query-foundation-regression.json");
const sourceRoot = "backend/src/main/java/com/jdy/erp/reports";
const controller = read(`${sourceRoot}/api/ReportQueryController.java`);
const spec = read(`${sourceRoot}/application/ReportQuerySpec.java`);
const registry = read(`${sourceRoot}/application/ReportQuerySpecRegistry.java`);
const parser = read(`${sourceRoot}/application/ReportQueryParser.java`);
const planner = read(`${sourceRoot}/application/ReportQueryPlanner.java`);
const queryPlan = read(`${sourceRoot}/application/ReportQueryPlan.java`);
const executor = read(`${sourceRoot}/application/SqlReportQueryExecutor.java`);
const csvWriter = read(`${sourceRoot}/application/ReportCsvWriter.java`);
const service = read(`${sourceRoot}/application/ReportQueryService.java`);
const response = read(`${sourceRoot}/application/ReportQueryResponse.java`);
const artifact = read(`${sourceRoot}/application/ReportExportArtifact.java`);
const cleanupManager = read(`${sourceRoot}/application/ReportExportCleanupManager.java`);
const testRoot = "backend/src/test/java/com/jdy/erp/reports";
const controllerTest = read(`${testRoot}/api/ReportQueryControllerTest.java`);
const reportTestRoot = `${testRoot}/application`;
const artifactTest = read(`${reportTestRoot}/ReportExportArtifactTest.java`);
const cleanupManagerTest = read(`${reportTestRoot}/ReportExportCleanupManagerTest.java`);
const executorTest = read(`${reportTestRoot}/SqlReportQueryExecutorTest.java`);
const parserPlannerTest = read(`${reportTestRoot}/ReportQueryParserPlannerTest.java`);
const serviceTest = read(`${reportTestRoot}/ReportQueryServiceTest.java`);
const specTest = read(`${reportTestRoot}/ReportQuerySpecRegistryTest.java`);
const routedPostgresTest = read(`${reportTestRoot}/ReportQueryRoutedPostgresIntegrationTest.java`);
const reportSources = [
  controller, spec, registry, parser, planner, queryPlan, executor, csvWriter, service, response, artifact, cleanupManager
].join("\n");
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

function section(source, start, end, label) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert(startIndex >= 0 && endIndex > startIndex, `必须能定位 ${label}`);
  return source.slice(startIndex, endIndex);
}

// Dedicated HTTP boundary. It must never re-enter /api/lists or the old seed adapter.
contains(controller, /^package com\.jdy\.erp\.reports\.api;/m, "报表 Controller 必须属于 Reports API 模块");
contains(service, /^package com\.jdy\.erp\.reports\.application;/m, "报表应用服务必须属于 Reports application 模块");
excludes(reportSources, /package com\.jdy\.erp\.system\./, "A145 生产代码不得越界落入 System 模块");
contains(controller, /@RequestMapping\("\/api\/reports"\)/, "A145 必须使用专用 /api/reports 根路径");
contains(controller, /@GetMapping\("\/\{reportKey\}"\)/, "A145 必须提供专用报表查询端点");
contains(controller, /@GetMapping\(value = "\/\{reportKey\}\/export\.csv"/, "A145 必须提供专用 CSV 端点");
excludes(controller, /JdbcTemplate|SELECT\s|INSERT\s|UPDATE\s|DELETE\s/i, "ReportQueryController 不得包含 JDBC 或 SQL");
excludes(controller, /scope|schema|accountSet|tenantId/, "ReportQueryController 不得接收客户端 scope/schema/tenant 参数");
excludes(
  controller,
  /public\s+final\s+class\s+ReportQueryController/,
  "ReportQueryController 必须可被 Spring Modulith observability 代理"
);

// Exact registry: A145 deliberately ships no business key and has no fallback branch.
contains(registry, /Map<String, ReportQuerySpec> specs/, "Registry 必须只持有精确 report key 映射");
contains(registry, /specs\.get\(reportKey\)/, "Registry 必须精确查找 report key");
contains(registry, /HttpStatus\.NOT_FOUND/, "未知 report key 必须返回 404");
excludes(registry, /default\s*->|fallback|DefaultStub|SeedRows|ListQuery/i, "Registry 不得声明 fallback/default/旧列表依赖");
for (const key of [
  "sales-detail",
  "sales-summary",
  "sales-order-tracking",
  "inventory-movement-detail",
  "receivable-detail",
  "receivable-summary",
  "payable-detail",
  "payable-summary",
  "material-scrap-summary"
]) {
  excludes(reportSources, new RegExp(`\\b${key}\\b`), `A145 生产代码不得提前登记业务 key ${key}`);
}

// Trusted definition + request parser are both closed allowlists.
contains(spec, /Pattern\.compile\("\[A-Za-z_\]\[A-Za-z0-9_\]\{0,62\}"\)/, "动态列只能使用受控输出 alias");
contains(spec, /report " \+ stage \+ " SQL must be one comment-free statement/, "source/result SQL 必须拒绝多语句和注释拼接");
contains(spec, /report default sort must contain exactly one primary field/, "每个 report 必须声明唯一默认主排序");
contains(spec, /report stable sort must not be empty/, "每个 report 必须声明稳定兜底排序");
contains(spec, /stable sort must end with one explicitly unique and non-null field/, "稳定排序末项必须显式声明为唯一且非空字段");
contains(spec, /uniqueNonNullStableSort\(String field, SortDirection direction\)/, "唯一稳定排序必须使用显式 non-null definition API");
contains(spec, /tokenizeSql\(String sql\)/, "source/result SQL 必须先词法化而不是叠加单条 relation 正则");
contains(spec, /tokenDepths\(List<SqlToken> tokens\)/, "SQL relation gate 必须跟踪 CTE/子查询括号深度");
contains(spec, /validateFromClause[\s\S]*?token\.keyword\("join"\) \|\| token\.type\(\) == SqlTokenType\.COMMA/, "SQL relation gate 必须覆盖 explicit 与 comma join");
contains(spec, /tokens\.get\(index\)\.keyword\("only"\) \|\| tokens\.get\(index\)\.keyword\("lateral"\)/, "SQL relation gate 必须覆盖 ONLY 与 LATERAL");
contains(spec, /validateParenthesizedRelation[\s\S]*?token\.keyword\("join"\) \|\| token\.type\(\) == SqlTokenType\.COMMA/, "SQL relation gate 必须递归覆盖括号化 join tree");
contains(spec, /FORBIDDEN_SQL_KEYWORDS[\s\S]*?insert[\s\S]*?update[\s\S]*?delete[\s\S]*?merge/, "SQL relation gate 必须拒绝 data-modifying CTE 与非只读关键字");
contains(spec, /relations must be unqualified for tenant routing/, "报表 relation 必须保持不带 schema 并由路由连接定域");
contains(spec, /report result SQL may only read the controlled report_fact relation/, "result SQL 只能读取受控 report_fact CTE");
contains(spec, /enum PredicatePlacement[\s\S]*?FACT[\s\S]*?RESULT[\s\S]*?BOTH[\s\S]*?BOUND_ONLY/, "filter/keyword/date 必须显式区分 FACT 与 RESULT placement");
contains(spec, /enumEqualsDefault[\s\S]*?requiredEnumEquals/, "代码定义 enum 必须支持 default 与 required 语义");
contains(spec, /bound report filter must not be repeated as a result predicate/, "source/result-bound filter 不得意外重复到聚合后 RESULT WHERE");
contains(spec, /BOUND_ONLY report filter must have a source or result binding/, "BOUND_ONLY 只能绑定到固定 source/result SQL");
contains(planner, /definition\.placement\(\) == PredicatePlacement\.BOUND_ONLY[\s\S]*?return;/, "BOUND_ONLY 不得生成 FACT 或 RESULT 外层谓词");
contains(spec, /report CSV columns must not be empty/, "每个 report 必须声明固定 CSV 列");
contains(spec, /enum SourceParameterKind[\s\S]*?FIXED[\s\S]*?DATE_FROM[\s\S]*?DATE_TO[\s\S]*?FILTER[\s\S]*?DATA_SCOPE/, "source 参数只能来自固定值、日期、白名单 filter 或服务端 data scope");
contains(spec, /bindSourceDataScope\(String namespace\)[\s\S]*?SourceParameterBinding\.dataScope\(namespace\)/, "definition 必须显式声明 source DATA_SCOPE 绑定");
contains(spec, /bindResultDataScope\(String namespace\)[\s\S]*?SourceParameterBinding\.dataScope\(namespace\)/, "definition 必须显式声明 result DATA_SCOPE 绑定");
contains(spec, /DATA_SCOPE_NAMESPACE = Pattern\.compile\("\[a-z\]\[a-z0-9_-\]\{0,63\}"\)/, "DATA_SCOPE namespace 必须是受控代码标识");
contains(spec, /LinkedHashSet<String>[\s\S]*?Stream\.concat\(sourceParameters\.stream\(\), resultParameters\.stream\(\)\)[\s\S]*?SourceParameterKind\.DATA_SCOPE[\s\S]*?List\.copyOf\(scopeNamespaces\)/, "重复 DATA_SCOPE namespace 必须在 definition 阶段稳定去重");
contains(spec, /RESERVED_PARAMETERS\.contains\(namespace\) \|\| filters\.containsKey\(namespace\)[\s\S]*?must not overlap a client parameter/, "DATA_SCOPE namespace 不得与通用参数或业务 filter 共用名称");
contains(spec, /private final boolean dateRangeRequired;[\s\S]*?private final String dateColumn;/, "必填日期范围与外层日期谓词必须分离建模");
contains(spec, /dateRangeRequired && dateColumn == null[\s\S]*?SourceParameterKind\.DATE_FROM[\s\S]*?SourceParameterKind\.DATE_TO[\s\S]*?!hasDateFrom \|\| !hasDateTo/, "无外层日期列时 source 必须同时绑定 DATE_FROM 和 DATE_TO");
contains(queryPlan, /case DATE_FROM -> query\.dateFrom\(\)[\s\S]*?case DATE_TO -> query\.dateTo\(\)[\s\S]*?case FILTER -> query\.filters\(\)\.get/, "source 参数必须从同一 normalized query 绑定");
contains(queryPlan, /Map<String, String> dataScopeIds[\s\S]*?unmodifiableMap\(new LinkedHashMap<>\(dataScopeIds\)\)/, "plan 必须持有不可变的服务端 data scope snapshot");
contains(queryPlan, /case DATA_SCOPE -> requireDataScope\(binding\.dataScopeNamespace\(\)\)/, "source/result DATA_SCOPE 必须只从 plan snapshot 绑定");
contains(queryPlan, /report data scope was not resolved/, "未解析 DATA_SCOPE 的 plan 必须 fail closed");
contains(parser, /PAGE_SIZES = Set\.of\(20, 50, 100, 200, 500\)/, "pageSize 必须固定白名单且最大 500");
contains(parser, /MAX_PAGE = 10_000/, "page 必须有合理硬上限");
contains(parser, /MAX_OFFSET = 1_000_000L[\s\S]*?requestedOffset > MAX_OFFSET/, "高成本 OFFSET 必须 fail closed");
contains(parser, /FORBIDDEN_SCOPE_PARAMETERS = Set\.of\([\s\S]*?scope[\s\S]*?dataScope[\s\S]*?schema[\s\S]*?accountSetId[\s\S]*?tenantId/, "parser 必须显式拒绝客户端 tenant/data scope 参数");
contains(parser, /FORBIDDEN_SCOPE_PARAMETERS\.contains\(name\) \|\| spec\.dataScopeNamespaces\(\)\.contains\(name\)/, "parser 必须显式拒绝 definition 内部 DATA_SCOPE binding 名");
contains(parser, /rawValues\.size\(\) != 1/, "重复 query 参数必须 fail closed");
contains(parser, /未知报表参数/, "未知 query 参数必须 400");
contains(parser, /dateFrom 不能晚于 dateTo/, "日期范围必须 fail closed");
contains(parser, /sortOrder 只允许 asc\/desc/, "排序方向必须白名单");
excludes(parser, /ObjectMapper|readValue|parseColumnFilters/, "专用 parser 不得沿用会吞错的 JSON columnFilters");

// API JSON owns decimal normalization; planner, JDBC and CSV retain exact BigDecimal values.
contains(response, /value instanceof BigDecimal decimal[\s\S]*?decimal\.stripTrailingZeros\(\)\.toPlainString\(\)/, "rows/totals/query 中的 BigDecimal 必须转为无指数 plain string");
contains(response, /value instanceof Map<\?, \?> map[\s\S]*?normalizeValue\(nestedValue\)/, "BigDecimal normalizer 必须递归遍历嵌套 map");
contains(response, /value instanceof Iterable<\?> iterable[\s\S]*?normalizeValue\(nestedValue\)/, "BigDecimal normalizer 必须递归遍历嵌套 iterable");
contains(response, /value\.getClass\(\)\.isArray\(\)[\s\S]*?Array\.get\(value, index\)/, "BigDecimal normalizer 必须递归遍历数组");
excludes(response, /doubleValue\(|floatValue\(/, "JSON BigDecimal normalizer 不得先降精度为浮点数");
contains(csvWriter, /value instanceof BigDecimal decimal[\s\S]*?decimal\.toPlainString\(\)/, "CSV 必须绕过响应 normalizer 并保留数据库 BigDecimal plain string");

// One normalized predicate and one whitelisted order plan feed every SQL shape.
contains(planner, /String\.join\(" AND ", factPredicates\)/, "FACT keyword/filter 谓词必须共享 AND planner");
contains(planner, /String\.join\(" AND ", resultPredicates\)/, "RESULT keyword/filter 谓词必须共享 AND planner");
contains(planner, /String\.join\(" OR ", factAlternatives\)/, "每个 FACT keyword 词必须在白名单字段间 OR");
contains(planner, /String\.join\(" OR ", resultAlternatives\)/, "每个 RESULT keyword 词必须在白名单字段间 OR");
contains(planner, /ESCAPE '!'/, "ILIKE 必须声明固定 escape 字符");
contains(planner, /\.replace\("!", "!!"\)[\s\S]*?\.replace\("%", "!%"\)[\s\S]*?\.replace\("_", "!_"\)/, "ILIKE 必须转义 escape/%/_");
contains(queryPlan, /sourceParameters\(\)[\s\S]*?factPredicateParameters[\s\S]*?resultParameters\(\)[\s\S]*?resultPredicateParameters/, "绑定参数顺序必须与 source→FACT→result SQL→RESULT 两阶段一致");
contains(executor, /WITH report_fact AS[\s\S]*?report_fact_source[\s\S]*?WHERE %s[\s\S]*?report_result AS/, "executor 必须固定构造 FACT→RESULT 两阶段 CTE");
contains(executor, /plan\.factPredicateSql\(\)/, "executor 必须复用 FACT planner predicate");
contains(executor, /plan\.resultPredicateSql\(\)/, "count/rows/totals/export 必须复用 RESULT planner predicate");
contains(executor, /LIMIT \? OFFSET \?/, "页面结果必须由数据库 LIMIT/OFFSET 分页");
contains(executor, /SUM\(" \+ column\(totalColumn\.sourceColumn\(\)\)/, "totals 必须由数据库聚合");
excludes(executor, /stream\(\).*skip\(|subList\(|Comparator</, "executor 不得做 Java 内存分页/排序");

// CSV is capped before stream creation, then synchronously generated with fixed columns.
const exportMethod = section(executor, "public ReportExportArtifact export", "private long count", "export method");
contains(exportMethod, /cappedExportCount\(spec, plan\)/, "CSV 必须先执行 20,001 cap probe");
contains(exportMethod, /cappedTotal > EXPORT_ROW_LIMIT/, "20,001 行必须返回 413");
contains(exportMethod, /cleanupManager\.createOwnedFile\(spec\.reportKey\(\)\)/, "CSV 必须从统一 cleanup manager 取得专属目录文件");
contains(exportMethod, /Files\.newOutputStream\(path\)/, "CSV 必须分块写临时文件而不是驻留 byte[]");
contains(exportMethod, /abandonFailedArtifact\(path, spec\.reportKey\(\)\)/, "CSV 生成失败必须把精确文件移交 cleanup manager");
contains(executor, /EXPORT_ROW_LIMIT = 20_000/, "CSV 行上限必须固定为 20,000");
contains(executor, /EXPORT_PROBE_LIMIT = EXPORT_ROW_LIMIT \+ 1/, "CSV cap probe 必须精确探测 20,001");
contains(executor, /PreparedStatementCreator streamingStatement/, "CSV 必须使用同步 JDBC cursor");
contains(executor, /statement\.setFetchSize\(EXPORT_FETCH_SIZE\)/, "CSV cursor 必须设置有界 fetch size");
contains(executor, /spec\.csvColumns\(\)\.stream\(\)/, "CSV SQL 必须只选择 definition 固定列");
excludes(exportMethod, /queryForList|StringBuilder/, "CSV 不得全量 queryForList 或无界 StringBuilder");
contains(csvWriter, /writer\.write\('\\ufeff'\)/, "CSV 必须写 UTF-8 BOM");
contains(csvWriter, /MAX_OUTPUT_BYTES = 64 \* 1024 \* 1024/, "CSV 文件输出必须有 64 MiB 硬上限");
contains(csvWriter, /value\.replace\("\\\"", "\\\"\\\""\)/, "CSV 必须使用 RFC 4180 双引号转义");
contains(csvWriter, /containsControlCharacter\(value\)/, "普通 tab 与控制字符必须进入 RFC 4180 quoted field");
contains(csvWriter, /startsFormula\(value\)/, "CSV 必须防公式注入");
contains(csvWriter, /var neutralizeFormula = !numericValue && startsFormula\(value\);[\s\S]*?value = "\\t" \+ value;[\s\S]*?value = "'" \+ value;/, "公式中和 apostrophe 必须位于 forceText tab 之前");
contains(controller, /transferredBytes = fileTransfer\.copy\(artifact\.path\(\), response\.getOutputStream\(\)\)[\s\S]*?transferredBytes != artifact\.contentLength\(\)[\s\S]*?response\.flushBuffer\(\)[\s\S]*?recordSuccessfulExport\(artifact\)/, "CSV 必须校验 Files.copy 字节数并在 flush 成功后记录成功审计");
contains(controller, /finally[\s\S]*?artifact\.release\(requestId\(request\)\)/, "CSV 响应无论成功、客户端失败或审计失败都必须向 manager 释放临时文件");
contains(controller, /catch \(IOException exception\)[\s\S]*?报表引出响应失败，请重试/, "文件缺失、拒绝访问和客户端断连不得直接暴露 IOException 消息");
contains(service, /report_export_success_audit_failed errorCategory=AUDIT_PERSISTENCE_FAILURE/, "flush 后审计失败必须写安全分类的结构化服务端 ERROR");
contains(service, /tenantId=\{\} actor=\{\} reportKey=\{\} rowCount=\{\} requestId=\{\}/, "运维告警必须携带受限 actor 与 tenant 标识");
excludes(service, /report_export_success_audit_failed[\s\S]{0,500}(?:artifact\.path|schemaName|sourceSql|exception\s*\))/, "审计失败告警不得记录路径、schema、SQL 或异常详情");
const postFlushAuditBranch = section(
  controller,
  "try {\n                reportQueryService.recordSuccessfulExport(artifact);",
  "        } catch (IOException exception)",
  "post-flush audit branch"
);
contains(postFlushAuditBranch, /first operational compensation signal/, "结构化 ERROR 必须明确作为首版可运维补偿信号");
excludes(postFlushAuditBranch, /throw new ResponseStatusException/, "响应 committed 后审计失败不得伪装成客户端可收到的 500");
contains(cleanupManager, /Path\.of\(System\.getProperty\("java\.io\.tmpdir"\), "jdy-report-exports"\)/, "export 必须使用专属持久责任目录");
contains(cleanupManager, /DEFAULT_STALE_GRACE = Duration\.ofHours\(2\)/, "跨实例 orphan 接管必须有最大合理请求时长 grace");
contains(cleanupManager, /activePaths\.contains\(path\)[\s\S]*?pendingPaths\.contains\(path\)[\s\S]*?!isManagedFile/, "目录扫描不得删除本进程 active artifact");
contains(cleanupManager, /@Scheduled\(fixedDelayString = "\$\{jdy\.report-export\.cleanup-interval-ms:30000\}"\)/, "pending/stale cleanup 必须周期重试");
contains(cleanupManager, /afterPropertiesSet\(\)[\s\S]*?ensureInitialized/, "startup 必须扫描并接管 stale artifact");
contains(cleanupManager, /destroy\(\)[\s\S]*?sweepPending\("shutdown"\)[\s\S]*?adoptAndSweepStale\("shutdown"\)/, "shutdown 必须 final sweep own pending 与 stale artifact");
contains(cleanupManager, /catch \(IOException \| RuntimeException deletionFailure\)[\s\S]*?pendingPaths\.add\(path\)/, "删除失败必须保留 manager pending 责任而非耗尽丢引用");
excludes(cleanupManager, /LOGGER\.(?:warn|error)\([^;]*(?:deletionFailure|metadataFailure|scanFailure)/, "cleanup 日志不得携带路径、IOException 消息或堆栈");
excludes(reportSources, /ReportExportPayload|ByteArrayOutputStream|ResponseEntity<byte\[\]>/, "CSV 不得构造 64 MiB byte[] 副本");
excludes(reportSources, /StreamingResponseBody|@Async/, "报表不得使用会丢 TenantContext 的异步响应");

// Permission and routed tenant are resolved before the transaction acquires a business connection.
const prepareMethod = section(service, "private PreparedReport prepare", "private ResponseStatusException unavailable", "prepare method");
contains(prepareMethod, /registry\.require\(reportKey\)[\s\S]*?parser\.parse[\s\S]*?permissionService\.requirePermission[\s\S]*?requireRoutableTenant\(\);[\s\S]*?resolveDataScopes\(spec\)[\s\S]*?planner\.plan\(spec, query\)\.withDataScopes/, "registry→parse→permission→exact route→scope→planner 前置顺序必须固定");
contains(prepareMethod, /UUID\.fromString\(accountSetId\)[\s\S]*?tenant\.databaseName\(\)[\s\S]*?validTenantSchema\(tenant\.schemaName\(\)\)/, "tenant gate 必须在业务事务前校验 accountSetId、database 与 schema");
contains(service, /@Qualifier\("platformJdbcTemplate"\) JdbcTemplate platformJdbcTemplate/, "tenant route gate 必须只使用平台 JdbcTemplate 查注册表");
contains(prepareMethod, /FROM sys_account_set[\s\S]*?id = \?::uuid[\s\S]*?database_name = \?[\s\S]*?schema_name = \?[\s\S]*?enabled = TRUE[\s\S]*?initialized = TRUE/, "tenant route gate 必须精确匹配可用账套当前 id/database/schema 绑定");
contains(prepareMethod, /Boolean\.TRUE\.equals\(registered\)/, "未注册、停用、未初始化或伪造 route 必须 fail closed");
excludes(prepareMethod, /!\"public\"\.equals\(value\)/, "合法注册 public 账套不得按 schema 名一律拒绝");
contains(service, /setReadOnly\(true\)/, "报表事务必须只读");
contains(service, /ISOLATION_REPEATABLE_READ/, "rows/count/totals/export 必须使用同快照");
contains(service, /AtomicReference<ReportExportArtifact>[\s\S]*?generatedArtifact\.set\(generated\)/, "事务 callback 生成的 artifact 必须在 commit 前由外部 holder 接管");
contains(service, /catch \(DataAccessException \| TransactionException exception\)[\s\S]*?deleteFailedTransactionArtifact/, "commit/rollback 失败必须清理 callback artifact");
contains(service, /recordSuccessfulExport\(ReportExportArtifact artifact\)[\s\S]*?operationLogService\.logCurrent[\s\S]*?SOURCE_COUNT/, "成功引出必须由响应层确认传输后记录 report key 与结果行数");
contains(artifact, /public void release\(String requestId\)[\s\S]*?cleanupManager\.release\(this, requestId\)/, "artifact 删除必须统一委托 cleanup manager");
contains(cleanupManager, /fileDeleter\.deleteIfExists\(path\)[\s\S]*?completeOwnership\(path\)/, "artifact 只能在 manager 删除成功后完成 ownership");
contains(service, /TenantDataScopeService tenantDataScopeService/, "报表 service 必须注入现有 TenantDataScopeService 解析服务端 scope");
contains(service, /for \(var namespace : spec\.dataScopeNamespaces\(\)\)[\s\S]*?currentScopeId\(namespace\)[\s\S]*?unmodifiableMap\(resolved\)/, "每个去重 namespace 必须在 tenant JDBC 前只解析一次并冻结 snapshot");
contains(service, /safeUuid\(scopeId\)[\s\S]*?UUID\.fromString\(scopeId\)\.toString\(\)/, "服务端 scope 必须 canonical UUID 化后才进入 plan");
excludes(reportSources, /DefaultStubListQueryAdapter|StubListSeedRowsProvider|ListSeedRowsProvider/, "A145 不得依赖旧 seed/default 列表底座");

// Dynamic gates must cover distinct SQL shapes and failure paths, not one shared string assertion.
for (const sqlShape of ["countSql", "listSql", "exportSql"]) {
  contains(executorTest, new RegExp(`assertSummarySourceAndPredicate\\(${sqlShape}`), `动态 SQL capture 必须独立校验 ${sqlShape}`);
}
contains(executorTest, /actualTwentyThousandAndFirstStreamedRowFailsAndDeletesTemporaryFile/, "动态门禁必须真实触发第 20,001 行");
contains(executorTest, /csvBeyondSixtyFourMiBFailsWith413AndDeletesTemporaryFile/, "动态门禁必须真实触发 64 MiB 上限");
contains(controllerTest, /missingArtifactUsesSafeUncommittedErrorWithoutLeakingAbsolutePath/, "动态门禁必须覆盖 NoSuchFile 安全错误");
contains(controllerTest, /accessDeniedUsesSafeUncommittedErrorAndStillDeletesArtifact/, "动态门禁必须覆盖 AccessDenied 安全错误");
contains(controllerTest, /auditFailureAfterFlushOnlySignalsOneOperationalErrorAndStillDeletesExactArtifact/, "动态门禁必须覆盖 committed 后仅告警并精确清理");
contains(controllerTest, /shortFileCopyFailsBeforeFlushOrAuditAndDeletesArtifact/, "动态门禁必须拒绝 Files.copy 短写并删除 artifact");
contains(controllerTest, /recordPostFlushAuditFailure\(artifact, "request-audit-145", true\)/, "动态门禁必须证明 flush 后审计失败记录 committed 状态");
contains(controllerTest, /cleanupFailureAfterCommittedTransferRemainsManagerOwnedWithoutFalseHttpFailure/, "动态门禁必须覆盖删除失败仍由 manager 持有且不伪造 HTTP 失败");
contains(serviceTest, /successfulExportCallbackFollowedByCommitFailureDeletesGeneratedArtifact/, "动态门禁必须覆盖 callback 成功后 commit 失败零残留");
contains(serviceTest, /transactionCleanupFailureIsSuppressedOnCommitFailureAndArtifactRemainsRetryable/, "动态门禁必须覆盖事务清理失败 suppressed 证据");
contains(serviceTest, /incompleteOrReservedTenantRouteCannotAcquirePlatformOrBusinessJdbc/, "动态门禁必须覆盖非法 UUID、空 database 与 pg\/information schema fail closed");
contains(serviceTest, /registeredEnabledInitializedPublicRouteIsAllowedBeforeRoutedBusinessTransaction/, "动态门禁必须允许平台注册、启用且初始化的 public 账套");
contains(serviceTest, /forgedOrStalePublicBindingFailsClosedBeforeRoutedBusinessTransaction/, "动态门禁必须拒绝伪造或过期 public route 绑定");
contains(serviceTest, /postFlushAuditLogContainsOnlyBoundedIdentityAndSafeCategory/, "动态门禁必须覆盖安全有界审计告警");
contains(specTest, /dataScopeDefinitionAcceptsOnlyCanonicalServerOwnedNamespaces/, "动态门禁必须覆盖 DATA_SCOPE definition 与 namespace fail closed");
contains(parserPlannerTest, /serverOwnedDataScopeCannotBeSubmittedOrEchoedAndRequiresOneResolvedImmutableSnapshot/, "动态门禁必须拒绝 raw scope/schema/accountSet/tenant/dataScope/内部绑定名并冻结 snapshot");
contains(parserPlannerTest, /decimalFilterRemainsBigDecimalThroughTypedParserAndPlanUntilTheApiResponseBoundary/, "动态门禁必须证明 parser/plan 在 API 边界前保留 BigDecimal");
contains(serviceTest, /serverOwnedDataScopeResolvesOnceAfterRouteRegistryAndBeforeTenantJdbcForTheWholePlan/, "动态门禁必须证明 exact route 后、tenant JDBC 前每请求只解析一次 scope");
contains(serviceTest, /clientCannotForgeServerOwnedDataScopeBeforePermissionRegistryResolutionOrTenantJdbc/, "动态门禁必须证明伪造 scope 在权限、路由、scope 与 tenant JDBC 前 400");
contains(executorTest, /oneResolvedDataScopeSnapshotFeedsCountTotalsRowsAndExportWithoutLiteralOrReResolution/, "动态门禁必须证明 count/totals/rows/export 共用同一 scope snapshot");
contains(executorTest, /queryData\.rows\(\)[\s\S]*?new BigDecimal\("12\.30"\)[\s\S]*?queryData\.totals\(\)/, "动态门禁必须证明 JDBC/executor 结果在响应边界前保留 BigDecimal");
contains(controllerTest, /responseRecursivelySerializesBigDecimalAsPlainStringsWithoutJsPrecisionLoss/, "动态门禁必须覆盖递归 BigDecimal plain-string 与 JS 安全精度");
contains(executorTest, /ordinaryTabsAndControlCharactersAreQuotedAndRoundTripAsOneCsvCell/, "动态门禁必须覆盖普通 tab/控制字符 quote 与 round-trip");
contains(artifactTest, /failedReleaseDoesNotMarkArtifactDeletedAndSecondAttemptCanSucceed/, "动态门禁必须覆盖 artifact manager release 失败后二次成功");
contains(cleanupManagerTest, /periodicSweepNeverDeletesThisProcessActiveArtifactEvenWhenItsTimestampIsOld/, "动态门禁必须证明 periodic 不删本进程 active artifact");
contains(cleanupManagerTest, /startupDeletesOnlyStaleOrphanAndKeepsAnotherInstanceFreshArtifact/, "动态门禁必须证明跨实例 grace 仅接管 stale orphan");
contains(cleanupManagerTest, /generationFailureHandsOffToManagerAndPeriodicSweepKeepsResponsibilityUntilDeleteSucceeds/, "动态门禁必须覆盖 generation failure handoff 与持续责任");
contains(cleanupManagerTest, /shutdownRetriesOwnPendingArtifactWithoutDeletingUnreleasedActiveArtifact/, "动态门禁必须覆盖 shutdown own pending final sweep");
contains(cleanupManagerTest, /cleanupFailureLogContainsOnlyBoundedIdentityAndSafeCategory/, "动态门禁必须证明 cleanup 日志不泄露路径/schema/SQL/raw exception");
contains(specTest, /requiredDateRangeAndUniqueSortContractsFailClosedAtDefinitionStartup/, "动态门禁必须覆盖日期与唯一非空排序启动失败");
contains(specTest, /resultStageOnlyReadsControlledFactAndBoundFiltersCannotLeakIntoResultPredicate/, "动态门禁必须覆盖 result SQL relation 与 bound filter placement 绕过");
contains(parserPlannerTest, /twoStageSummaryNormalizesDimensionDefaultAndPlacesAllDetailPredicatesBeforeAggregation/, "动态门禁必须证明 dimension 默认值和明细谓词位于聚合前 FACT 层");
contains(parserPlannerTest, /codeDefinedRequiredEnumRejectsMissingAndInvalidWhileDefaultEnumIsEchoed/, "动态门禁必须覆盖 enum default\/required\/非法值语义");
contains(executorTest, /twoStageFactPredicatesPrecedeAggregationForCountTotalsRowsAndExportWithoutResultDuplication/, "动态门禁必须证明 count\/totals\/rows\/export 复用两阶段计划且聚合后不重复");
contains(routedPostgresTest, /CREATE DATABASE[\s\S]*?DROP DATABASE IF EXISTS/, "路由 PostgreSQL 测试必须使用并销毁随机数据库");
contains(routedPostgresTest, /refuses shared jdy_erp/, "路由 PostgreSQL 测试必须 fail closed 拒绝共享 jdy_erp");
contains(routedPostgresTest, /databaseExists\(settings, databaseName\)\)\.isFalse\(\)/, "路由 PostgreSQL 测试必须验证数据库 residue=0");
contains(routedPostgresTest, /BLD-TEST-PUBLIC[\s\S]*?00000000-0000-0000-0000-000000000001[\s\S]*?"public"[\s\S]*?publicResponse/, "随机 PostgreSQL 必须证明 BLD-TEST 等价合法 public route 可用");
contains(routedPostgresTest, /00000000-0000-0000-0000-000000000999[\s\S]*?"public"[\s\S]*?HttpStatus\.INTERNAL_SERVER_ERROR[\s\S]*?verifyNoInteractions\(executor\)/, "随机 PostgreSQL 必须证明 public 数据存在时伪造 route 仍在 tenant JDBC 前 fail closed");
contains(routedPostgresTest, /report_scope_id UUID NOT NULL[\s\S]*?report_scope_id = \?::uuid/, "随机 PostgreSQL fixture 必须由真实 UUID 列执行 DATA_SCOPE 谓词");
contains(routedPostgresTest, /BLD-TEST-PUBLIC[\s\S]*?BLD-TEST-DECOY[\s\S]*?assertScopedQueryAndExport[\s\S]*?TENANT-A-OLD[\s\S]*?TENANT-A-DECOY/, "随机 PostgreSQL 必须在 public 与 tenant schema 注入同筛选不同 scope 的 decoy");
contains(routedPostgresTest, /response\.total\(\)[\s\S]*?isEqualTo\(1L\)[\s\S]*?response\.rows\(\)[\s\S]*?response\.totals\(\)[\s\S]*?prepareExport[\s\S]*?doesNotContain\(excludedCustomer\)/, "随机 PostgreSQL 必须证明 count/rows/totals/export 全部排除 decoy");
contains(routedPostgresTest, /verify\(tenantDataScopeService, times\(2\)\)\.currentScopeId\("reporting"\)[\s\S]*?verify\(tenantDataScopeService, times\(4\)\)\.currentScopeId\("reporting"\)/, "随机 PostgreSQL 必须证明 query 与 export 各只解析一次 namespace");
excludes(routedPostgresTest, /@SpringBootTest|localhost:8080|:8080/, "A145 动态路由测试不得启动共享 Spring/8080");

mkdirSync(verificationDir, { recursive: true });
const result = {
  taskId: "A145",
  generatedAt: new Date().toISOString(),
  checks: checks.length,
  status: "passed"
};
writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(`[a145-report-query-foundation] ${checks.length} assertions passed`);
