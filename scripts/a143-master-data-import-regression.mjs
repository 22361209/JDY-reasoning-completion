#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const resultPath = path.join(verificationDir, "a143-master-data-import-regression.json");
const templateResourceDir = path.join(rootDir, "backend/src/main/resources/master-data-import");
const contract = read("docs/12-当前批次验收清单.md");
const delivery = JSON.parse(read("config/feature-delivery-status.json"));
const controller = read("backend/src/main/java/com/jdy/erp/masterdata/api/MasterDataImportController.java");
const exceptionHandler = read("backend/src/main/java/com/jdy/erp/masterdata/api/MasterDataImportExceptionHandler.java");
const definitions = read("backend/src/main/java/com/jdy/erp/masterdata/application/MasterDataImportDefinitionRegistry.java");
const workbookService = read("backend/src/main/java/com/jdy/erp/masterdata/application/MasterDataImportWorkbookService.java");
const importService = read("backend/src/main/java/com/jdy/erp/masterdata/application/MasterDataImportService.java");
const createService = read("backend/src/main/java/com/jdy/erp/masterdata/application/MasterDataCreateService.java");
const masterDataController = read("backend/src/main/java/com/jdy/erp/masterdata/api/MasterDataController.java");
const migration = read("backend/src/main/resources/db/migration/V104__master_data_excel_import.sql");
const applicationConfig = read("backend/src/main/resources/application.yml");
const app = read("frontend/src/app/App.vue");
const dataListPage = read("frontend/src/components/DataListPage.vue");
const actionRegistry = read("frontend/src/components/actions/actionRegistry.ts");
const importRegistry = read("frontend/src/modules/master-data/import/importRegistry.ts");
const importPage = read("frontend/src/modules/master-data/import/MasterDataImportPage.vue");
const importState = read("frontend/src/modules/master-data/import/useMasterDataImport.ts");
const importApi = read("frontend/src/services/masterDataImportApi.ts");
const baseCss = read("frontend/src/styles/base.css");
const templateBuilder = read("scripts/build-a143-master-data-import-templates.mjs");

const checks = [];
const importDefinitions = [
  ["productCategory", "product-category-list"],
  ["unit", "unit-master-list"],
  ["customer", "customer-master-list"],
  ["supplier", "supplier-master-list"],
  ["warehouse", "warehouse-master-list"],
  ["employee", "employee-master-list"],
  ["financialAccount", "financial-account-master-list"],
  ["product", "product-master-list"]
];
const fixedTestIds = [
  "list-import",
  "master-data-import-page",
  "master-data-import-tenant",
  "master-data-import-type",
  "master-data-import-limit-hint",
  "master-data-import-template-download",
  "master-data-import-file",
  "master-data-import-file-clear",
  "master-data-import-dry-run",
  "master-data-import-status",
  "master-data-import-summary-total",
  "master-data-import-summary-valid",
  "master-data-import-summary-errors",
  "master-data-import-summary-write-count",
  "master-data-import-preview-table",
  "master-data-import-error-receipt",
  "master-data-import-confirm",
  "master-data-import-confirm-dialog",
  "master-data-import-confirm-submit",
  "master-data-import-result",
  "master-data-import-reset"
];
const templateArtifacts = [
  ["productCategory", "product-category.xlsx", ["*类别编码", "*类别名称", "上级类别编码", "排序", "状态", "备注"]],
  ["unit", "unit.xlsx", ["*单位名称/编码", "数量小数位", "排序", "状态", "备注"]],
  ["customer", "customer.xlsx", ["*客户编码", "*客户名称", "联系人", "电话", "地区", "地址", "状态", "备注"]],
  ["supplier", "supplier.xlsx", ["*供应商编码", "*供应商名称", "联系人", "电话", "地址", "状态", "备注"]],
  ["warehouse", "warehouse.xlsx", ["*仓库编码", "*仓库名称", "仓库类型", "仓管员", "仓库地址", "状态", "备注"]],
  ["employee", "employee.xlsx", ["*员工编码", "*员工姓名", "岗位", "部门", "手机", "邮箱", "状态", "备注"]],
  ["financialAccount", "financial-account.xlsx", ["*账户编码", "*账户名称", "*账户类型", "*币种", "开户行", "账号", "户名", "状态", "备注"]],
  ["product", "product.xlsx", [
    "*物料编码", "*物料名称", "*物料类别编码", "规格型号", "*计量单位编码", "净重", "毛重", "表面处理",
    "可销售", "可采购", "可库存", "可自制", "可委外", "采购价", "参考成本", "最低销售价", "税率(%)",
    "最低库存数量", "安全库存数量", "最高库存数量", "默认生产车间编码", "默认仓库编码", "默认供应商编码"
  ]]
];

function read(relativePath) {
  return readFileSync(path.join(rootDir, relativePath), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  checks.push(message);
}

function assertContains(source, pattern, message) {
  assert(pattern.test(source), message);
}

function assertNotContains(source, pattern, message) {
  assert(!pattern.test(source), message);
}

function section(source, start, end, label) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert(startIndex >= 0 && endIndex > startIndex, `必须能定位 ${label}`);
  return source.slice(startIndex, endIndex);
}

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function unzipList(filePath) {
  return execFileSync("/usr/bin/unzip", ["-Z1", filePath], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  }).trim().split(/\r?\n/).filter(Boolean);
}

function unzipText(filePath, entry) {
  const archivePattern = entry.startsWith("[") ? `[[]${entry.slice(1)}` : entry;
  return execFileSync("/usr/bin/unzip", ["-p", filePath, archivePattern], {
    encoding: "utf8",
    maxBuffer: 60 * 1024 * 1024
  });
}

function decodeXml(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function rowValues(sheetXml, rowNumber) {
  const row = sheetXml.match(new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?row\\b[^>]*\\br="${rowNumber}"[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?row>`
  ));
  assert(Boolean(row), `模板必须包含第 ${rowNumber} 行`);
  const cells = [];
  const cellPattern = /<(?:[A-Za-z_][\w.-]*:)?c\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?c>/g;
  for (const match of row[1].matchAll(cellPattern)) {
    const reference = match[1].match(/\br="([A-Z]+)[0-9]+"/)?.[1] ?? "";
    const raw = match[2].match(/<(?:[A-Za-z_][\w.-]*:)?v>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?v>/)?.[1]
      ?? match[2].match(/<(?:[A-Za-z_][\w.-]*:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/)?.[1]
      ?? "";
    cells.push({ reference, value: decodeXml(raw) });
  }
  return cells.sort((left, right) => left.reference.localeCompare(right.reference)).map((cell) => cell.value);
}

// Scope anchors: this script guards the frozen A143 contract instead of inventing a second scope.
assertContains(contract, /只接受 `\.xlsx`/, "A143 合同必须继续固定只接受 .xlsx");
assertContains(contract, /只新增，不更新、不覆盖、不静默跳过/, "A143 合同必须继续固定 create-only 原子语义");
assertContains(contract, /最大 `10 MiB`[\s\S]*?5,000 行非空数据/, "A143 合同必须继续固定 10 MiB/5,000 行");
assertContains(contract, /账户资料模板和校验正式支持 `CNY\/USD`/, "A143 合同必须继续固定账户 CNY/USD");
assertContains(contract, /生产部门不在本批导入范围/, "A143 合同必须继续排除生产部门导入");
const f008 = delivery.features.find((feature) => feature.id === "F008");
assert(Boolean(f008), "交付状态必须保留 F008");
assert(f008.surface === "shared", "F008 必须保持 shared surface");
assert(Array.isArray(f008.catalogEntryIds) && f008.catalogEntryIds.length === 0, "F008 不得伪造独立 catalog entry");

// Reproducible resources: inspect the eight committed OOXML files, not only source declarations.
assertContains(templateBuilder, /from "@oai\/artifact-tool"/, "模板必须由项目指定 spreadsheet artifact runtime 构建");
assertContains(templateBuilder, /const templateVersion = "1"/, "模板构建版本必须固定为 1");
assertContains(templateBuilder, /const maxDataRows = 5000/, "模板构建行上限必须固定为 5000");
assertContains(
  templateBuilder,
  /field\.kind === "text" \|\| field\.key === "accountNo"[\s\S]*?numberFormat = "@"/,
  "模板构建器必须把文本和账号列固定为文本格式"
);
assertContains(templateBuilder, /hideAndProtectMetaSheet\(filePath\)/, "模板构建器必须隐藏并保护 __meta");
assertContains(templateBuilder, /kind: "formula"[\s\S]*?unexpectedly contains formulas/, "模板构建器必须扫描公式");
assertContains(
  templateBuilder,
  /for \(const sheetName of \["导入数据", "填写说明"\]\)[\s\S]*?workbook\.render/,
  "模板构建器必须渲染两个可见 sheet 做视觉 QA"
);

const actualTemplateFiles = readdirSync(templateResourceDir).filter((fileName) => !fileName.startsWith(".")).sort();
const expectedTemplateFiles = templateArtifacts.map(([, fileName]) => fileName).sort();
assert(same(actualTemplateFiles, expectedTemplateFiles), "模板资源目录必须精确包含八个预置 .xlsx");

for (const [type, fileName, expectedHeaders] of templateArtifacts) {
  const filePath = path.join(templateResourceDir, fileName);
  assertContains(
    definitions,
    new RegExp(`definition\\(\\s*"${type}",\\s*"[^"]+",\\s*"${fileName.replaceAll(".", "\\.")}"`),
    `后端定义必须映射 ${type} -> ${fileName}`
  );
  const signature = readFileSync(filePath).subarray(0, 4);
  assert(same([...signature], [0x50, 0x4b, 0x03, 0x04]), `${fileName} 必须是真实 OOXML ZIP`);

  const entries = unzipList(filePath);
  assert(
    [
      "[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels",
      "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml", "xl/worksheets/sheet3.xml"
    ].every((entry) => entries.includes(entry)),
    `${fileName} 必须包含固定 OOXML 控制部件和三个 sheet`
  );
  assert(entries.filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry)).length === 3, `${fileName} 不得包含额外 worksheet`);
  assert(
    entries.every((entry) => !/(?:vbaProject\.bin|externalLinks\/|encryptedPackage|encryptionInfo|embeddings\/|oleObjects\/)/i.test(entry)),
    `${fileName} 不得包含宏、外链、加密包或嵌入对象`
  );

  const workbookXml = unzipText(filePath, "xl/workbook.xml");
  const sheetNames = [...workbookXml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?sheet\b[^>]*\bname="([^"]+)"[^>]*\/>/g)]
    .map((match) => decodeXml(match[1]));
  assert(same(sheetNames, ["导入数据", "填写说明", "__meta"]), `${fileName} sheet 集合和顺序必须固定`);
  assert(
    /<(?:[A-Za-z_][\w.-]*:)?sheet\b[^>]*\bname="__meta"[^>]*\bstate="veryHidden"/.test(workbookXml),
    `${fileName} 的 __meta 必须 veryHidden`
  );

  const dataXml = unzipText(filePath, "xl/worksheets/sheet1.xml");
  const metaXml = unzipText(filePath, "xl/worksheets/sheet3.xml");
  assert(same(rowValues(dataXml, 2), expectedHeaders), `${fileName} 第 2 行表头必须与 A143 固定合同一致`);
  assert(/<(?:[A-Za-z_][\w.-]*:)?sheetProtection\b[^>]*\bsheet="1"/.test(metaXml), `${fileName} 的 __meta 必须受保护`);
  const meta = Object.fromEntries(Array.from({ length: 6 }, (_, index) => rowValues(metaXml, index + 2)));
  assert(
    same(meta, {
      contract: "A143",
      type,
      version: "1",
      dataSheet: "导入数据",
      headerRow: "2",
      maxDataRows: "5000"
    }),
    `${fileName} 的 __meta 必须绑定 A143/type/version/header/5000 行`
  );

  for (const entry of entries.filter((name) => name.endsWith(".xml") || name.endsWith(".rels"))) {
    const xml = unzipText(filePath, entry);
    assert(!/<(?:[A-Za-z_][\w.-]*:)?f(?:\s|>)/.test(xml), `${fileName} 不得包含公式: ${entry}`);
    assert(!/\bTargetMode="External"/i.test(xml), `${fileName} 不得包含外部 relationship: ${entry}`);
  }
  if (type === "financialAccount") {
    const guideXml = unzipText(filePath, "xl/worksheets/sheet2.xml");
    assert(/<[^>]*formula1>"CNY,USD"<\/[^>]*formula1>/.test(dataXml), "账户模板币种数据验证必须精确为 CNY/USD");
    assert(guideXml.includes("CNY / USD") || guideXml.includes("CNY/USD"), "账户模板填写说明必须明确 CNY/USD");
  }
}

// Backend API and permission boundary.
assertContains(
  controller,
  /@RequestMapping\("\/api\/master-data\/import"\)[\s\S]*?@RequirePermission\("master\.data\.manage"\)/,
  "全部导入端点必须由 master.data.manage 类级权限保护"
);
for (const route of [
  '@GetMapping("/templates")',
  '@GetMapping("/templates/{type}")',
  '@GetMapping("/jobs")',
  '@GetMapping("/jobs/{jobId}")',
  '@GetMapping("/jobs/{jobId}/error-receipt")',
  '@PostMapping("/jobs/{jobId}/confirm")'
]) {
  assert(controller.includes(route), `后端必须声明 A143 路由 ${route}`);
}
assertContains(
  controller,
  /@PostMapping\([\s\S]*?value = "\/jobs\/\{type\}\/preview"[\s\S]*?consumes = MediaType\.MULTIPART_FORM_DATA_VALUE[\s\S]*?@RequestPart\("file"\) MultipartFile file/,
  "预检必须使用 multipart/form-data 的 file 部件"
);
assertNotContains(controller, /JdbcTemplate|\b(?:SELECT|INSERT|UPDATE|DELETE)\b/i, "Controller 不得包含 JDBC 或 SQL");
assertNotContains(controller, /accountSet|tenantSchema|schemaName/, "Controller 不得接收客户端账套或 schema 参数");
assertNotContains(
  controller,
  /public final class MasterDataImportController/,
  "Controller 不得声明 final，必须允许 Spring Modulith 生成观测代理"
);
assertContains(exceptionHandler, /MaxUploadSizeExceededException[\s\S]*?PAYLOAD_TOO_LARGE/, "multipart 超限必须稳定映射 413 JSON");
assertContains(exceptionHandler, /MultipartException[\s\S]*?BAD_REQUEST/, "损坏 multipart 必须稳定映射 400 JSON");

// One registry owns the eight types and all fixed parser limits.
assertContains(definitions, /TEMPLATE_VERSION = 1/, "模板版本必须固定为 1");
assertContains(definitions, /MAX_DATA_ROWS = 5_000/, "服务端非空数据行上限必须固定为 5,000");
assertContains(definitions, /MAX_COLUMNS = 64/, "服务端列上限必须固定为 64");
assertContains(definitions, /MAX_FILE_BYTES = 10L \* 1024 \* 1024/, "服务端原文件上限必须固定为 10 MiB");
assertContains(definitions, /MAX_EXPANDED_BYTES = 50L \* 1024 \* 1024/, "服务端解压内容上限必须固定为 50 MiB");
assertContains(definitions, /MAX_CELL_CHARACTERS = 32_767/, "服务端单元格上限必须固定为 32,767 字符");
for (const [type] of importDefinitions) {
  assertContains(definitions, new RegExp(`definition\\(\\s*"${type}"`), `后端导入注册表必须包含 ${type}`);
}
assert(occurrences(definitions, "register(ordered, definition(") === 8, "后端导入注册表必须精确包含八类资料");
assertNotContains(definitions, /definition\(\s*"productionDepartment"/, "生产部门不得进入 A143 导入注册表");
assertContains(
  definitions,
  /enumeration\("currency",\s*"币种",\s*true,\s*Set\.of\("CNY",\s*"USD"\),\s*null\)/,
  "账户导入币种必须精确为 CNY/USD"
);

// Untrusted workbook handling is bounded and rejects non-xlsx OOXML features.
assertContains(workbookService, /endsWith\("\.xlsx"\)/, "工作簿服务必须后端校验 .xlsx 扩展名");
assertContains(workbookService, /signature\[0\] != 'P'[\s\S]*?signature\[3\] != 4/, "工作簿服务必须校验 OOXML ZIP 签名");
assertContains(workbookService, /ZipSecureFile\(path\.toFile\(\)\)/, "工作簿服务必须通过 POI ZipSecureFile 扫描压缩包");
assertContains(workbookService, /expanded > MAX_EXPANDED_BYTES/, "工作簿服务必须累计限制 50 MiB 解压内容");
assertContains(workbookService, /column >= MAX_COLUMNS/, "工作簿服务必须拒绝第 65 列");
assertContains(workbookService, /value\.length\(\) > MAX_CELL_CHARACTERS/, "工作簿服务必须限制 32,767 字符单元格");
assertContains(workbookService, /rows\.size\(\) >= MAX_DATA_ROWS/, "工作簿服务必须拒绝第 5,001 个非空数据行");
assertContains(workbookService, /"f"\.equals\(name\)[\s\S]*?工作簿不允许公式/, "工作簿服务必须拒绝公式而非读取缓存值");
assertContains(
  workbookService,
  /"External"\.equalsIgnoreCase\(attribute\(attributes, "TargetMode"\)\)/,
  "工作簿服务必须拒绝外部 relationship"
);
assertContains(workbookService, /vbaproject\.bin[\s\S]*?encryptedpackage[\s\S]*?xl\/externallinks\//i, "工作簿服务必须拒绝宏、加密包和外链部件");
assertContains(workbookService, /REQUIRED_SHEETS = Set\.of\(DATA_SHEET, GUIDE_SHEET, META_SHEET\)/, "工作簿服务必须只接受三个固定 sheet");
assertContains(workbookService, /META_SHEET\.equals\(sheet\.name\(\)\)[\s\S]*?"veryHidden"/, "工作簿服务必须校验 __meta 隐藏状态");
assertContains(workbookService, /META_SHEET\.equals\(sheetName\) && !protectedSheet/, "工作簿服务必须校验 __meta 受保护");
assertContains(workbookService, /ORDINARY_DECIMAL[\s\S]*?toPlainString\(\)/, "数值必须使用普通非负十进制并规范化为非科学计数文本");
assertContains(
  applicationConfig,
  /multipart:[\s\S]*?max-file-size: 10MB[\s\S]*?max-request-size: 11MB[\s\S]*?file-size-threshold: 0[\s\S]*?resolve-lazily: true/,
  "Spring multipart 必须与 10 MiB 服务合同对齐、落盘缓冲并在权限后延迟解析"
);

// Preview is workflow-only; confirm is locked, revalidated and delegated to the shared create service.
const previewMethod = section(importService, "public JobView preview(", "public JobPage list(", "preview 方法");
assertContains(previewMethod, /validateRows\(definition/, "预检必须调用共享业务校验但不写业务资料");
assertContains(previewMethod, /INSERT INTO md_import_batch/, "预检只允许创建 md_import_batch 工作流事实");
assertNotContains(previewMethod, /createService\.create\(/, "预检不得调用业务 create 写入主数据");

const businessMutations = [...importService.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(md_[a-z_]+)/gi)]
  .map((match) => match[1].toLowerCase())
  .filter((table) => table !== "md_import_batch");
assert(businessMutations.length === 0, `ImportService 不得直接维护业务 md_* 表: ${businessMutations.join(", ")}`);
assertNotContains(importService, /\bMERGE\s+INTO\b|ON\s+CONFLICT[\s\S]*?DO\s+UPDATE/i, "导入不得实现覆盖或 upsert 模式");
assertContains(importService, /addFileDuplicateErrors\(rows, "code"[\s\S]*?DUPLICATE_FILE_CODE/, "文件内重复编码必须使行校验失败");
assertContains(createService, /assertCreateUnique\(type, code, name\)/, "共享 create 服务必须拒绝当前账套既有编码");
assertContains(
  masterDataController,
  /private final MasterDataCreateService masterDataCreateService[\s\S]*?masterDataCreateService\.create\(type, payload\)/,
  "手工新增与导入确认必须共享 MasterDataCreateService"
);
assertContains(
  createService,
  /static CreateOptions importStrict\(Map<String, String> explicitDefaults\)[\s\S]*?ReferenceMode\.CODE_ONLY/,
  "导入引用必须使用严格按编码模式"
);
assertContains(
  createService,
  /referenceMode == ReferenceMode\.CODE_ONLY[\s\S]*?WHERE enabled = TRUE[\s\S]*?audit_status = 'AUDITED'[\s\S]*?AND code = \?/,
  "物料导入引用必须只解析已审核且启用的当前账套编码"
);
assertContains(createService, /requiredOneOf\(payload, "currency", Set\.of\("CNY", "USD"\)\)/, "共享账户创建必须正式支持且仅支持 CNY/USD");

assertContains(importService, /new TransactionTemplate\(transactionManager\)/, "确认必须使用 tenant 事务模板");
assertContains(importService, /transactions\.execute\(ignored -> confirmInTransaction\(id, page, pageSize\)\)/, "确认状态机必须在单一事务中执行");
assertContains(importService, /ownedJob\(scope, id, true\)/, "首次和并发确认必须锁定任务");
assertContains(importService, /formatted\(forUpdate \? "FOR UPDATE" : ""\)/, "任务锁必须落为 SELECT FOR UPDATE");
assertContains(importService, /status == JobStatus\.COMMITTED[\s\S]*?return new ConfirmOutcome/, "重复确认必须幂等返回 COMMITTED");
assertContains(
  importService,
  /validateRows\(definition, storedRows, true\)[\s\S]*?status = 'STALE'[\s\S]*?stableCreateOrder\(definition, validated\)[\s\S]*?createService\.create\(definition\.type\(\), stored\.payload\(\), CreateOptions\.importStrict\(definition\.defaults\(\)\)\)[\s\S]*?status = 'COMMITTED'/,
  "确认必须先全批复检，失效转 STALE，再稳定顺序调用共享 create，最后置 COMMITTED"
);
assertContains(importService, /rows_payload = '\[\]'::jsonb[\s\S]*?payload_cleared_at = now\(\)/, "成功或过期后必须清空可提交 payload");
assertContains(importService, /now\(\) \+ interval '30 minutes'/, "预检令牌必须固定 30 分钟过期");
assertContains(importService, /enum JobStatus \{\s*VALIDATED,\s*INVALID,\s*COMMITTED,\s*STALE,\s*FAILED,\s*EXPIRED\s*\}/, "应用状态机必须精确包含六种 A143 状态");
assertContains(
  importService,
  /account_set_id = \?::uuid[\s\S]*?account_set_code = \?[\s\S]*?created_by = \?::uuid[\s\S]*?created_by_username = \?/,
  "任务可见性必须同时绑定 tenant 与真实创建者"
);
assertContains(importService, /TenantContext\.requireTenant\(\)[\s\S]*?currentSessionService\.currentUserId\(\)[\s\S]*?currentUsername\(\)/, "tenant 和 actor 必须来自服务端上下文");

// Expired payloads must be swept through the routed tenant datasource, never by interpolating schemas.
assert(occurrences(importService, "private final JdbcTemplate jdbcTemplate;") === 1, "导入服务必须只持有一个主 routed JdbcTemplate");
assertNotContains(
  importService,
  /platformJdbc(?:Template)?|@Qualifier\s*\(\s*["']platformJdbcTemplate["']\s*\)/i,
  "导入服务不得注入或绕过到 platform JdbcTemplate"
);
const expirySweep = section(
  importService,
  "@Scheduled(",
  "public List<TemplateView> templates()",
  "跨账套过期清理"
);
assertContains(
  expirySweep,
  /TenantContext\.setPlatform\(\)[\s\S]*?jdbcTemplate\.queryForList\([\s\S]*?FROM sys_account_set/,
  "过期清理必须先切换 platform 上下文并用主 routed JdbcTemplate 读取账套目录"
);
assertContains(
  expirySweep,
  /NULLIF\(BTRIM\(schema_name\), ''\) IS NOT NULL[\s\S]*?LOWER\(BTRIM\(schema_name\)\) <> 'public'/,
  "过期清理账套目录必须排除空 schema 和 public"
);
assertNotContains(
  expirySweep,
  /\b(?:enabled|initialized)\b/i,
  "过期清理账套目录不得按 enabled 或 initialized 过滤而遗留历史任务"
);
assertContains(
  expirySweep,
  /for \(var accountSet : accountSets\)[\s\S]*?TenantContext\.setTenant\(accountSet\)[\s\S]*?transactions\.executeWithoutResult\(ignored -> expireOverdueInCurrentTenant\(\)\)/,
  "过期清理必须逐账套切换 tenant 并各自在独立事务中执行"
);
assertContains(
  expirySweep,
  /for \(var accountSet : accountSets\)[\s\S]*?try \{[\s\S]*?transactions\.executeWithoutResult\(ignored -> expireOverdueInCurrentTenant\(\)\)[\s\S]*?\} catch \(RuntimeException exception\) \{[\s\S]*?LOGGER\.warn\([\s\S]*?\} finally \{[\s\S]*?TenantContext\.clear\(\)/,
  "单个账套清理失败必须捕获 RuntimeException、记录受限日志并继续后续账套"
);
assert(occurrences(expirySweep, "TenantContext.clear();") >= 2, "过期清理必须在逐账套和最外层 finally 双重清空 TenantContext");
assertNotContains(
  expirySweep,
  /\.formatted\(|SET\s+(?:LOCAL\s+)?search_path|UPDATE\s+["'`]?[\s\S]*?schemaName/i,
  "过期清理不得拼接 schema、切 search_path 或动态生成 UPDATE"
);
const tenantExpiryUpdate = section(
  importService,
  "private int expireOverdueInCurrentTenant()",
  "private void expireLocked(",
  "当前账套过期更新"
);
assertContains(
  tenantExpiryUpdate,
  /jdbcTemplate\.update\("""[\s\S]*?UPDATE md_import_batch[\s\S]*?status = 'EXPIRED'[\s\S]*?rows_payload = '\[\]'::jsonb[\s\S]*?WHERE status IN \('VALIDATED', 'INVALID', 'STALE', 'FAILED'\)[\s\S]*?expires_at <= now\(\)/,
  "当前账套过期清理必须只更新 routed md_import_batch 并清空已到期可提交 payload"
);
assertNotContains(tenantExpiryUpdate, /schema|\.formatted\(|String\.format|\+\s*["']UPDATE/i, "当前账套过期 UPDATE 不得包含 schema 或动态 SQL 拼接");

const categoryValidation = section(
  importService,
  "private void validateCategoryParents(",
  "private List<StoredRow> stableCreateOrder(",
  "类别跨边界环校验"
);
assertContains(
  categoryValidation,
  /parentByCode\.putAll\(existingParentByCode\)[\s\S]*?categoryCycleCodes\(parentByCode\)/,
  "类别环检测必须合并导入节点与现有祖先图"
);
assertContains(
  categoryValidation,
  /collectExistingCategoryAncestors\([\s\S]*?SELECT code, COALESCE\(parent_code, ''\) AS "parentCode"[\s\S]*?existingParentByCode\.put\(code, parent\)/,
  "类别校验必须沿当前账套既有 parent_code 祖先链建立图"
);
assertContains(
  categoryValidation,
  /while \(!current\.isBlank\(\)[\s\S]*?!importedCodes\.contains\(current\)[\s\S]*?!existingParentByCode\.containsKey\(current\)\)/,
  "类别既有祖先采集必须迭代到导入边界或已访问节点"
);
assertContains(
  categoryValidation,
  /categoryCycleCodes\(Map<String, String> parentByCode\)[\s\S]*?pathIndexes\.putIfAbsent\(current, path\.size\(\)\)[\s\S]*?cycles\.addAll/,
  "类别组合图必须以路径索引检测跨导入与既有节点的环"
);
assertContains(
  categoryValidation,
  /cycleCodes\.forEach\(code -> \{[\s\S]*?var row = byCode\.get\(code\)[\s\S]*?row\.addError\("parentCode", "CATEGORY_PARENT_CYCLE"/,
  "组合图环必须回写为导入行 CATEGORY_PARENT_CYCLE 错误"
);
assertContains(importService, /PREVIEW_MASTER_DATA_IMPORT[\s\S]*?MASTER_DATA_IMPORT/, "预检必须记录批次级操作日志");
assertContains(importService, /CONFIRM_MASTER_DATA_IMPORT[\s\S]*?MASTER_DATA_IMPORT/, "确认成功必须记录批次级操作日志");
const summaryMethod = section(importService, "private String summaryReason(", "private String safeOriginalFilename(", "批次日志摘要");
assertNotContains(summaryMethod, /payload|accountNo|phone|email|bankName|accountHolder/i, "操作日志摘要不得拼接行 payload 或个人/账户字段");

assertContains(migration, /CREATE TABLE md_import_batch/, "V104 必须新增 tenant managed 导入批次表");
assertContains(migration, /status IN \('VALIDATED', 'INVALID', 'COMMITTED', 'STALE', 'FAILED', 'EXPIRED'\)/, "V104 状态约束必须精确包含六种状态");
assertContains(migration, /file_size_bytes <= 10485760/, "V104 必须二次约束 10 MiB 文件大小");
assertContains(migration, /total_rows BETWEEN 0 AND 5000[\s\S]*?jsonb_array_length\(rows_payload\) <= 5000/, "V104 必须二次约束 5,000 行和 payload 长度");
assertContains(migration, /VALUES \('md_import_batch', 75\)/, "V104 必须把批次表纳入 tenant managed catalog");
assertNotContains(migration, /FOREIGN KEY \(account_set_id\)/, "V104 不得扩大 public account-set FK 豁免");

// Frontend: eight list entries converge on one permission-gated shell and server-owned facts.
for (const [type, listKey] of importDefinitions) {
  assertContains(
    importRegistry,
    new RegExp(`\\{ type: "${type}", listKey: "${listKey}"`),
    `前端导入注册表必须映射 ${listKey} -> ${type}`
  );
  assertContains(
    dataListPage,
    new RegExp(`"${listKey}": "master\\.data\\.manage"`),
    `${listKey} 的导入入口必须服从 master.data.manage`
  );
}
assert(occurrences(importRegistry, "{ type:") === 8, "前端导入注册表必须精确包含八个入口");
assertContains(importRegistry, /masterDataImportListKeys[\s\S]*?new Set\(/, "八个列表入口必须由同一注册表集合驱动");
assertContains(dataListPage, /defineAction\("importData"[\s\S]*?visible: supportsMasterDataImport\.value[\s\S]*?enabled: canMaintainCurrentList\.value[\s\S]*?testId: "list-import"/, "列表导入动作必须统一可见性、权限和 test id");
assertContains(dataListPage, /actionKey === "importData"[\s\S]*?emit\("openMasterDataImport", \{ listKey: props\.listKey \}\)/, "八个列表动作必须打开共享导入 shell");
assertContains(actionRegistry, /importData: \{ key: "importData", label: "导入"/, "导入动作必须进入共享 action registry");

assert(occurrences(app, 'const masterDataImportTabId = "master-data-import";') === 1, "应用只能定义一个 master-data-import 页签 id");
assertContains(app, /<MasterDataImportPage[\s\S]*?v-if="hasMasterDataImportTab"[\s\S]*?:can-import="session\.hasPermission\('master\.data\.manage'\)"/, "共享导入页必须由真实权限渲染");
assertContains(
  app,
  /function openMasterDataImport[\s\S]*?hasPermission\("master\.data\.manage"\)[\s\S]*?tabs\.openTab\(\{[\s\S]*?id: masterDataImportTabId[\s\S]*?openForList\(payload\.listKey\)/,
  "八个入口必须预选类型并复用唯一页签"
);
assertContains(app, /markMasterDataImportDirty[\s\S]*?importTab\.dirty = dirty/, "导入 shell 必须接入页签 dirty 保护");
assertContains(app, /!\['master-data-import',[\s\S]*?\]\.includes\(tabs\.activeTab\.value\.id\)/, "导入工作区不得落入通用空壳 fallback");

for (const testId of fixedTestIds) {
  const source = testId === "list-import" ? dataListPage : importPage;
  assert(source.includes(testId), `A143 前端必须保留固定 test id: ${testId}`);
}
assertContains(importPage, /import TableCore/, "错误预览必须导入 TableCore");
assertContains(importPage, /<TableCore/, "错误预览必须复用 TableCore");
assertNotContains(importPage, /DataListPage/, "错误预览不得复用业务 DataListPage");
assertContains(importPage, /function previewCellTitle[\s\S]*?column\.key === "valid"[\s\S]*?row\.valid \? "可导入" : "错误"/, "错误预览结果列 title 必须使用可读状态而不是布尔原值");
assertContains(importPage, /\.xlsx \/ 10 MiB \/ 5,000 行[\s\S]*?只新增[\s\S]*?导入后为草稿[\s\S]*?整批原子/, "首屏必须固定展示四项导入边界");
assertContains(importPage, /accept="\.xlsx,application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet"/, "文件选择器只能提示 .xlsx");
assertContains(importPage, /将新增 \{\{ importState\.currentJob\.value\?\.validRows \?\? 0 \}\} 条草稿，任一失败整批回滚/, "确认前必须显示原子新增二次提示");

assertContains(importApi, /const body = new FormData\(\)[\s\S]*?body\.append\("file", file, file\.name\)/, "浏览器必须使用 FormData 直接上传文件");
for (const apiPath of [
  "/api/master-data/import/templates",
  "/api/master-data/import/jobs/",
  "/preview",
  "/confirm",
  "/error-receipt"
]) {
  assert(importApi.includes(apiPath), `前端 API 必须使用正式 A143 路由片段 ${apiPath}`);
}
assertContains(importApi, /status === 403[\s\S]*?status === 404[\s\S]*?status === 409[\s\S]*?status === 410[\s\S]*?status === 413[\s\S]*?status === 400/, "前端必须区分权限、不可见、漂移、过期、超限和格式错误");
const frontendImportSources = `${importRegistry}\n${importPage}\n${importState}\n${importApi}`;
assertNotContains(frontendImportSources, /FileReader|readAsDataURL|base64/i, "导入前端不得读取或 Base64 化工作簿");
assertNotContains(frontendImportSources, /\/api\/lists\//, "导入工作区不得伪造通用列表 API key");

assertContains(importState, /const MAX_FILE_BYTES = 10 \* 1024 \* 1024/, "前端预判文件上限必须与 10 MiB 后端合同一致");
assertContains(importState, /endsWith\("\.xlsx"\)[\s\S]*?file\.size > MAX_FILE_BYTES/, "前端只能做 .xlsx/大小轻量预判");
assertContains(importState, /currentJob\.value\?\.status === "VALIDATED"[\s\S]*?currentJob\.value\.canConfirm/, "确认按钮必须服从后端 canConfirm 事实");
const canConfirmState = section(importState, "const canConfirm = computed(", "const canDownloadErrorReceipt", "确认 fail-closed 状态");
assertContains(
  canConfirmState,
  /confirmStateFresh\.value[\s\S]*?!requestFailure\.value[\s\S]*?workflowState\.value === "READY_TO_COMMIT"/,
  "确认必须要求详情状态新鲜、无请求失败且处于 READY_TO_COMMIT"
);
assertContains(
  canConfirmState,
  /status === "VALIDATED"[\s\S]*?errorRows === 0[\s\S]*?totalRows > 0[\s\S]*?validRows === currentJob\.value\.totalRows/,
  "确认必须 fail-closed 校验 VALIDATED、零错误、正行数及全行有效"
);
assertContains(
  canConfirmState,
  /currentJob\.value\.canConfirm[\s\S]*?currentJobUnexpired\.value[\s\S]*?!jobLoading\.value[\s\S]*?!busy\.value/,
  "确认必须同时服从服务端 canConfirm、客户端时效与加载状态"
);
assertContains(
  importState,
  /const currentJobUnexpired = computed\([\s\S]*?Date\.parse\(currentJob\.value\?\.expiresAt \?\? ""\)[\s\S]*?expiresAt > currentTimeMs\.value/,
  "确认时效必须按服务端 expiresAt 计算"
);
const loadJobState = section(importState, "async function loadJob(", "async function previousPreviewPage(", "任务详情刷新");
assertContains(
  loadJobState,
  /confirmStateFresh\.value = false[\s\S]*?fetchMasterDataImportJob\([\s\S]*?if \(!result\.ok \|\| !result\.data\)[\s\S]*?return/,
  "任务详情刷新必须先关闭确认能力且失败时保持 fail-closed"
);
assertContains(
  loadJobState,
  /const serial = \+\+jobSerial[\s\S]*?if \(serial !== jobSerial\) return[\s\S]*?result\.data\.id !== jobId[\s\S]*?result\.data\.type !== expectedType/,
  "任务详情刷新必须校验 serial、任务 id 与资料类型"
);
assertContains(
  importState,
  /function scheduleExpiry\([\s\S]*?setTimeout\(\(\) => expireCurrentJobLocally\(job\.id\)[\s\S]*?function expireCurrentJobLocally\([\s\S]*?confirmStateFresh\.value = false[\s\S]*?requestFailure\.value = "JOB_EXPIRED"/,
  "任务到期必须由定时器本地关闭确认并进入过期错误态"
);
const writeCount = section(importState, "const actualWriteCount", "const previewRows", "实际写入计数");
assertContains(
  writeCount,
  /job\?\.status === "COMMITTED" \? job\.committedRows : 0/,
  "只有 COMMITTED 才能显示非零实际写入数"
);
assertNotContains(writeCount, /validRows/, "VALIDATED/INVALID/STALE/FAILED/EXPIRED 的实际写入数必须为 0");
assertContains(importState, /let interactionSerial = 0[\s\S]*?new AbortController\(\)[\s\S]*?serial !== interactionSerial/, "上传与确认异步请求必须使用 abort/serial 防旧响应覆盖");
const previewRequest = section(importState, "async function runPreview()", "function requestTypeChange(", "上传预检异步保护");
assertContains(
  previewRequest,
  /const contextSerial = workspaceSerial[\s\S]*?const requestedType = selectedType\.value[\s\S]*?const fingerprint = fileFingerprint\(file\)[\s\S]*?serial !== interactionSerial[\s\S]*?contextSerial !== workspaceSerial[\s\S]*?requestedType !== selectedType\.value[\s\S]*?fingerprint !== fileFingerprint\(selectedFile\.value\)/,
  "上传预检响应必须同时校验请求 serial、工作区、资料类型与文件指纹"
);
const confirmRequest = section(importState, "async function submitConfirm()", "async function downloadErrorReceipt()", "确认异步保护");
assertContains(
  confirmRequest,
  /const contextSerial = workspaceSerial[\s\S]*?const expectedType = selectedType\.value[\s\S]*?const expectedFingerprint = fileFingerprint\(selectedFile\.value\)[\s\S]*?const serial = \+\+interactionSerial[\s\S]*?if \(serial !== interactionSerial\) return/,
  "确认请求必须冻结工作区、资料类型、文件指纹并校验 interaction serial"
);
assertContains(
  confirmRequest,
  /await loadJob\(job\.id, 1\)[\s\S]*?!workspaceContextMatches\(contextSerial, job\.id, expectedType, expectedFingerprint\)/,
  "确认失败后的任务回读必须重新核对工作区、job、type 与 file"
);
assertContains(
  confirmRequest,
  /result\.data\.id !== job\.id \|\| result\.data\.type !== expectedType/,
  "确认成功响应必须核对服务端任务 id 与资料类型"
);
const receiptRequest = section(importState, "async function downloadErrorReceipt()", "function applyJob(", "回执异步保护");
assertContains(
  receiptRequest,
  /const contextSerial = workspaceSerial[\s\S]*?const expectedType = selectedType\.value[\s\S]*?const expectedFingerprint = fileFingerprint\(selectedFile\.value\)[\s\S]*?const serial = \+\+receiptSerial[\s\S]*?if \(serial !== receiptSerial\) return/,
  "回执请求必须冻结上下文并校验 receipt serial"
);
assertContains(
  receiptRequest,
  /await loadJob\(job\.id, 1\)[\s\S]*?!workspaceContextMatches\(contextSerial, job\.id, expectedType, expectedFingerprint\)/,
  "回执过期后的任务回读必须重新核对工作区、job、type 与 file"
);
const workspaceGuard = section(importState, "function workspaceContextMatches(", "function invalidateJobContract(", "工作区上下文保护");
assertContains(
  workspaceGuard,
  /serial === workspaceSerial[\s\S]*?selectedType\.value === expectedType[\s\S]*?currentJob\.value\?\.id === expectedJobId[\s\S]*?currentJob\.value\.type === expectedType[\s\S]*?fileFingerprint\(selectedFile\.value\) === expectedFingerprint/,
  "异步回读公共保护必须精确覆盖 workspace serial、job id、type 与 file fingerprint"
);
assertContains(importState, /setDirty\(true\)[\s\S]*?requestTypeChange[\s\S]*?dirty\.value[\s\S]*?typeChangeDialogOpen\.value = true/, "选文件后切换类型必须触发 dirty 二次确认");
assertContains(importState, /onBeforeUnmount\(\(\) => \{[\s\S]*?abortAll\(\)/, "关闭工作区必须中止在途请求");

const requestTabClose = section(app, "function requestTabClose(", "function closePendingTabWithoutSaving(", "导入页签关闭保护");
assertContains(
  requestTabClose,
  /tabId === masterDataImportTabId && masterDataImportCommitting\.value[\s\S]*?notifyMasterDataImportNavigationBlocked\(\)[\s\S]*?return/,
  "COMMITTING 时必须阻止直接关闭导入页签"
);
const forceTabClose = section(app, "function closePendingTabWithoutSaving(", "function notifyMasterDataImportNavigationBlocked(", "导入页签强制关闭保护");
assertContains(
  forceTabClose,
  /pendingTab\.id === masterDataImportTabId && masterDataImportCommitting\.value[\s\S]*?tabs\.cancelClose\(\)[\s\S]*?notifyMasterDataImportNavigationBlocked\(\)[\s\S]*?return/,
  "COMMITTING 时必须阻止未保存弹窗强制关闭导入页签"
);
const accountSetSwitch = section(app, "async function requestAccountSetSwitch(", "function applyAccountSetSummary(", "导入期间切账套保护");
assertContains(
  accountSetSwitch,
  /masterDataImportCommitting\.value[\s\S]*?selectedAccountSetCode\.value = session\.accountSetCode\.value[\s\S]*?notifyMasterDataImportNavigationBlocked\(\)[\s\S]*?return/,
  "COMMITTING 时必须还原账套选择并阻止切换账套"
);
assertContains(app, /:aria-disabled="tab\.id === masterDataImportTabId && masterDataImportCommitting"/, "COMMITTING 时关闭按钮必须暴露不可用语义");

assert(occurrences(importPage, 'role="dialog"') === 2, "确认与类型切换弹窗必须都声明 dialog role");
assert(occurrences(importPage, 'aria-modal="true"') === 2, "确认与类型切换弹窗必须都声明 aria-modal");
assert(occurrences(importPage, 'aria-labelledby="master-data-import-') === 2, "确认与类型切换弹窗必须都关联可访问标题");
assert(occurrences(importPage, 'aria-describedby="master-data-import-') === 2, "确认与类型切换弹窗必须都关联可访问说明");
assertContains(
  importPage,
  /function handleConfirmDialogKeydown\([\s\S]*?event\.key === "Escape"[\s\S]*?event\.preventDefault\(\)[\s\S]*?event\.stopPropagation\(\)[\s\S]*?!importState\.committing\.value[\s\S]*?closeConfirmDialog\(\)[\s\S]*?trapDialogFocus/,
  "确认弹窗必须支持 Escape（提交中除外）并执行焦点陷阱"
);
assertContains(
  importPage,
  /function handleTypeChangeDialogKeydown\([\s\S]*?event\.key === "Escape"[\s\S]*?cancelTypeChange\(\)[\s\S]*?trapDialogFocus/,
  "类型切换弹窗必须支持 Escape 并执行焦点陷阱"
);
assertContains(
  importPage,
  /function trapDialogFocus\([\s\S]*?event\.key !== "Tab"[\s\S]*?const first = focusable\[0\][\s\S]*?const last = focusable\[focusable\.length - 1\][\s\S]*?last\.focus\(\)[\s\S]*?first\.focus\(\)/,
  "弹窗必须在首尾可交互控件之间闭环焦点"
);
assertContains(
  importPage,
  /watch\(importState\.confirmDialogOpen[\s\S]*?confirmReturnFocus = activeElement\(\)[\s\S]*?confirmCancelRef\.value \?\? confirmDialogRef\.value[\s\S]*?restoreFocus\(returnTarget, pageRef\.value\)/,
  "确认弹窗必须保存、移入并恢复焦点"
);
assertContains(
  importPage,
  /watch\(importState\.typeChangeDialogOpen[\s\S]*?typeChangeReturnFocus = activeElement\(\)[\s\S]*?typeChangeCancelRef\.value \?\? typeChangeDialogRef\.value[\s\S]*?restoreFocus\(returnTarget, pageRef\.value\)/,
  "类型切换弹窗必须保存、移入并恢复焦点"
);
assertContains(baseCss, /\.master-data-import-confirm-dialog:focus \{[\s\S]*?outline:/, "键盘焦点落入导入确认弹窗时必须可见");

assertContains(baseCss, /\.master-data-import-page \{[\s\S]*?max-width: 100%[\s\S]*?overflow: hidden/, "导入页面自身不得横向溢出");
assertContains(baseCss, /\.master-data-import-table-wrap[\s\S]*?overflow: hidden/, "预览表滚动必须限制在表格容器内");
assertContains(baseCss, /\.master-data-import-preview-table \.table-core-body-wrapper td \{[^}]*overflow: hidden[^}]*text-overflow: ellipsis[^}]*white-space: nowrap[^}]*\}/, "预览表长业务编码和原值必须在同一单元格规则内裁切");
assertContains(baseCss, /\.master-data-import-preview-table \.table-core-body-wrapper td > span \{[^}]*min-width: 0[^}]*max-width: 100%[^}]*\}/, "预览表文本节点必须在同一规则内受单元格宽度约束");
assertContains(baseCss, /\.master-data-import-preview-table \.table-core-body-wrapper td > span:not\(\.master-data-import-row-state\) \{[^}]*display: block[^}]*overflow: hidden[^}]*text-overflow: ellipsis[^}]*\}/, "预览表文本节点必须在同一规则内裁切且不得覆盖相邻列");
assertContains(baseCss, /@media \(max-width: 1200px\)[\s\S]*?\.master-data-import-layout[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/, "导入工作区必须提供窄屏单列布局");
assertContains(baseCss, /@media \(max-width: 900px\)[\s\S]*?\.master-data-import-workspace,[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/, "导入表单和摘要必须提供更窄屏响应式布局");

const result = {
  ok: true,
  taskId: "A143",
  scope: "static-source-contract",
  assertions: checks.length,
  importTypes: importDefinitions.map(([type]) => type),
  dynamicCoverage: false,
  note: "该门禁只证明源码和仓库配置保留关键合同，不替代 API、并发、tenant、事务回滚、浏览器或安全文件动态验收。"
};
mkdirSync(verificationDir, { recursive: true });
writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ...result, resultPath: path.relative(rootDir, resultPath) })}\n`);
