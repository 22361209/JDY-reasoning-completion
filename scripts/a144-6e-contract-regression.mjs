#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertReportImportGraph, hasFunctionCall, importDeclarations } from "./helpers/report-import-graph.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const resultPath = path.join(verificationDir, "a144-6e-contract-regression.json");
const draftMode = process.argv.includes("--draft");

const currentTask = read("docs/12-当前批次验收清单.md");
const reportProtocol = read("docs/guides/report-query-protocol.md");
const lifecycleProtocol = read("docs/guides/bill-lifecycle-unification-protocol.md");
const roadmap = JSON.parse(read("config/remediation-roadmap.json"));
const regressionManifest = JSON.parse(read("config/regression-manifest.json"));
const checks = [];
const a143ReportPath = "docs/验收报告/验收报告-A143-基础资料Excel导入-20260714.md";

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

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function git(args) {
  return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function gitSucceeds(args) {
  try {
    git(args);
    return true;
  } catch {
    return false;
  }
}

function jsonAtCommit(commit, relativePath) {
  return JSON.parse(git(["show", `${commit}:${relativePath}`]));
}

function frontmatterList(source, key) {
  const lines = source.split(/\r?\n/);
  const start = lines.indexOf(`${key}:`);
  if (start < 0) return [];
  const values = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^[A-Za-z][A-Za-z0-9]*:/.test(line)) break;
    const item = line.match(/^  - (.+)$/);
    if (item) values.push(item[1]);
  }
  return values;
}

function changeSetRows(source) {
  const rows = new Map();
  for (const match of source.matchAll(/^\| (A(?:14[4-9]|15[0-3])) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)) {
    rows.set(match[1], {
      content: match[2].trim(),
      dependencies: match[3].trim(),
      parallelism: match[4].trim()
    });
  }
  return rows;
}

function hasA143GovernanceClosure(commit) {
  try {
    const delivery = jsonAtCommit(commit, "config/feature-delivery-status.json");
    const roadmapAtCommit = jsonAtCommit(commit, "config/remediation-roadmap.json");
    const feature = delivery.features?.find((candidate) => candidate.id === "F008");
    const item6dAtCommit = roadmapAtCommit.items?.find((item) => item.id === "6D");
    const capabilities = feature?.capabilityChecks ?? {};
    return feature?.state === "verified"
      && feature?.level === "A4"
      && feature?.exposure === "published"
      && feature?.evidence?.includes(a143ReportPath)
      && Object.values(capabilities).length > 0
      && Object.values(capabilities).every((value) => value === "verified")
      && same(item6dAtCommit?.historyRefs, [a143ReportPath])
      && gitSucceeds(["cat-file", "-e", `${commit}:${a143ReportPath}`]);
  } catch {
    return false;
  }
}

function changedPathsSince(baseCommit) {
  const paths = new Set();
  const commands = [
    ["diff", "--name-only", `${baseCommit}..HEAD`],
    ["diff", "--cached", "--name-only"],
    ["diff", "--name-only"],
    ["ls-files", "--others", "--exclude-standard"]
  ];
  for (const command of commands) {
    const output = git(command);
    for (const relativePath of output.split("\n").filter(Boolean)) paths.add(relativePath);
  }
  return [...paths].sort();
}

function assertActualChangesWithinAllowed(baseCommit, allowedPaths) {
  const changedPaths = changedPathsSince(baseCommit);
  assert(changedPaths.length > 0, "A144 change set 必须包含实际变更");
  for (const changedPath of changedPaths) {
    assert(allowedPaths.includes(changedPath), `实际变更路径越过 allowedPaths: ${changedPath}`);
  }
}

const item6e = roadmap.items.find((item) => item.id === "6E");
assert(Boolean(item6e), "roadmap 必须保留 6E");
assert(same(item6e.scopeIds, ["F029", "F042", "F061", "F091", "F093"]), "6E scopeIds 必须精确匹配五个有效范围");
assert(item6e.targetAcceptance === "A3", "6E 目标验收等级必须为 A3");
assert(item6e.predecessorIds?.length === 1 && item6e.predecessorIds[0] === "6D", "6E predecessor 必须只有 6D");

const allowedPaths = frontmatterList(currentTask, "allowedPaths");
assert(allowedPaths.length === 163, "A144 allowedPaths 数量必须精确冻结为 163");
assert(new Set(allowedPaths).size === allowedPaths.length, "A144 allowedPaths 不得重复");
assert(
  allowedPaths.every((allowedPath) => !allowedPath.startsWith("/") && !/[?*\[\]]/.test(allowedPath)),
  "A144 allowedPaths 必须是无 glob 的仓库相对精确路径"
);
const allowedPathsHash = createHash("sha256").update([...allowedPaths].sort().join("\n")).digest("hex");
assert(
  allowedPathsHash === "b0c8e0b69dccec638a115528011b635d1964a9034ec33077fc2339c3173d1a41",
  "A144 allowedPaths 精确集合不得漂移"
);
const plannedScripts = [
  "scripts/a145-report-query-foundation-regression.mjs",
  "scripts/a146-numbering-rule-closure-regression.mjs",
  "scripts/a146-numbering-rule-migration-regression.mjs",
  "scripts/a147-inventory-source-trace-regression.mjs",
  "scripts/a147-inventory-source-trace-migration-regression.mjs",
  "scripts/a148-inventory-movement-report-regression.mjs",
  "scripts/a149-sales-report-regression.mjs",
  "scripts/a150-finance-report-regression.mjs",
  "scripts/a151-material-scrap-backend-regression.mjs",
  "scripts/a151-material-scrap-migration-regression.mjs",
  "scripts/a152-material-scrap-ui-regression.mjs",
  "scripts/a153-6e-closure-regression.mjs"
];
for (const plannedScript of plannedScripts) {
  assert(allowedPaths.includes(plannedScript), `allowedPaths 必须包含 ${plannedScript}`);
}
for (const poolFixPath of [
  "backend/src/main/java/com/jdy/erp/system/tenant/TenantDataSourceConfig.java",
  "backend/src/main/resources/application.yml",
  "backend/src/test/java/com/jdy/erp/JdyErpApplicationTests.java"
]) {
  assert(allowedPaths.includes(poolFixPath), `allowedPaths 必须包含全量测试连接池前置修复 ${poolFixPath}`);
}
assert(
  allowedPaths.includes("frontend/src/modules/reports/reportTypes.ts"),
  "allowedPaths 必须包含共享 reportTypes 所有者"
);
assert(
  allowedPaths.includes("scripts/helpers/report-import-graph.mjs"),
  "allowedPaths 必须包含共享 report import graph scanner"
);
assert(
  allowedPaths.includes("scripts/a115-metadata-definition-regression.mjs"),
  "A153 catalog 发布必须允许同步更新 A115 metadata gate"
);
assert(
  allowedPaths.includes("scripts/a85-finance-posting-regression.mjs"),
  "A153 当前错误入口清理必须允许同步更新 A85 财务过账浏览器兼容回归"
);
assert(
  allowedPaths.includes("scripts/a118-outsourcing-chain-regression.mjs"),
  "A153 最终 production area 必须允许修复 A118 委外链 fixture 隔离与精确清理"
);
assertContains(
  currentTask,
  /A118 委外链历史夹具冲突[\s\S]*全部 run-unique[\s\S]*create-only[\s\S]*409 时必须 fail-closed[\s\S]*禁止 update\/upsert、覆盖、认领或删除既有记录[\s\S]*完整语义快照、事务锁与 CAS 复验[\s\S]*精确 UUID 删除[\s\S]*归属不明必须回滚[\s\S]*不得借回归修复修改委外业务后端/,
  "A118 授权必须冻结 run-unique、create-only、CAS 与既有数据 fail-closed 边界"
);
if (draftMode) {
  assertActualChangesWithinAllowed(git(["rev-parse", "HEAD"]), allowedPaths);
}

const changeSets = changeSetRows(currentTask);
const expectedDependencies = {
  A144: "A143 治理收口",
  A145: "A144",
  A146: "A144",
  A147: "A144",
  A148: "A145、A147",
  A149: "A145",
  A150: "A145、6B",
  A151: "A145、A146、A147",
  A152: "A151",
  A153: "A146-A152"
};
assert(changeSets.size === 10, "交付拆分必须精确包含 A144-A153 十个 change set");
for (const [changeSet, dependencies] of Object.entries(expectedDependencies)) {
  assert(changeSets.get(changeSet)?.dependencies === dependencies, `${changeSet} 依赖不得漂移`);
}
assert(/后端生命周期/.test(changeSets.get("A151")?.content ?? ""), "A151 必须拥有后端生命周期实现");
assert(/前端生命周期 wiring/.test(changeSets.get("A152")?.content ?? ""), "A152 只拥有前端生命周期 wiring");
assertContains(currentTask, /前端共享类型只归 `frontend\/src\/modules\/reports\/reportTypes\.ts`[\s\S]*不得有任何 runtime import[\s\S]*只能单向使用 `import type \.\.\. from \.\.\.reportTypes`[\s\S]*A144 与 A148 gate 必须实际调用 `scripts\/helpers\/report-import-graph\.mjs`[\s\S]*side-effect[\s\S]*dynamic[\s\S]*require[\s\S]*不能用注释关键词代替扫描/, "A144/A148 必须冻结共享 report type 的单向依赖与真实 import graph scanner");

const reportImportGraph = assertReportImportGraph(rootDir, { allowMissing: true });
assert(typeof reportImportGraph.checked === "boolean", "A144 必须调用共享 helper 实际扫描 report import graph");
if (reportImportGraph.checked) {
  const registrySource = read("frontend/src/modules/reports/reportRegistry.ts");
  assertNotContains(registrySource, /\b(?:export\s+)?(?:interface|type)\s+Report(?:Definition|Column|Filter|Query|Page|Registry)\b/, "reportRegistry 不得重定义共享 report types");
  if (existsSync(path.join(rootDir, "scripts/a148-inventory-movement-report-regression.mjs"))) {
    const a148GatePath = "scripts/a148-inventory-movement-report-regression.mjs";
    const a148Gate = read(a148GatePath);
    const helperImports = importDeclarations(a148Gate, a148GatePath).filter((entry) => entry.source?.endsWith("helpers/report-import-graph.mjs"));
    assert(
      helperImports.some((entry) => entry.kind === "static" && !entry.typeOnly),
      "A148 gate 必须 runtime import 共享 report-import-graph helper"
    );
    assert(
      hasFunctionCall(a148Gate, "assertReportImportGraph", a148GatePath),
      "A148 gate 必须实际调用 assertReportImportGraph"
    );
  }
}

const a144Script = "scripts/a144-6e-contract-regression.mjs";
assert(regressionManifest.areas?.system?.includes(a144Script), "A144 gate 必须登记到 area:system");
assert(regressionManifest.full?.includes(a144Script), "A144 gate 必须登记到 full");
assertContains(
  currentTask,
  /A144-A152 期间登记到 `full` 与 `area:system`[\s\S]*A153 必须[\s\S]*从 regression manifest 移除并删除该临时脚本[\s\S]*`scripts\/a153-6e-closure-regression\.mjs` 替代[\s\S]*不得再读取可变 `docs\/12`[\s\S]*不得用开放式 `A143 base\.\.HEAD`/,
  "A144 临时合同门禁必须由 A153 以稳定 closure gate 替换"
);
assertContains(
  currentTask,
  /A153 发布 6E catalog[\s\S]*`scripts\/a115-metadata-definition-regression\.mjs`[\s\S]*report entry 按 `reportRegistry` 验证[\s\S]*普通 list\/form 查询入口继续按 list contract 验证/,
  "A153 必须在 A115 中区分 report registry 与普通 list contract"
);
let manifestValidated = false;
try {
  execFileSync(process.execPath, [path.join(rootDir, "scripts/validate-regression-manifest.mjs")], {
    cwd: rootDir,
    stdio: ["ignore", "pipe", "pipe"]
  });
  manifestValidated = true;
} catch {
  manifestValidated = false;
}
assert(manifestValidated, "A144 gate 必须自证 regression manifest 完整有效");

assertContains(currentTask, /^taskId: A144$/m, "当前合同 taskId 必须为 A144");
assertContains(currentTask, /^pendingUserDecisions:\n  - none$/m, "A144 不得保留未决用户决定");
assertContains(currentTask, /targetAcceptance: A3/, "A144 targetAcceptance 必须为 A3");
assertContains(currentTask, /F042 的库存来源写入和 F061 的正式单据属于核心业务依赖，必须先达到对应 A4/, "库存与材料报废核心依赖必须先达到 A4");
assertContains(currentTask, /A144-A153 每个 change set 独立 review、测试、commit/, "6E 必须按 A144-A153 独立提交");
assertNotContains(currentTask, /待用户决定|用户确认前|用户决定后|用户最终决定/, "A144 不得残留材料报废开放决定");
assertContains(currentTask, /backend\/src\/main\/java\/com\/jdy\/erp\/reports\/api\/ReportQueryController\.java/, "共享报表 Controller 必须归属 reports api");
assertContains(currentTask, /backend\/src\/main\/java\/com\/jdy\/erp\/reports\/application\/ReportQuerySpec\.java/, "共享报表底座必须归属 reports application");
assertContains(currentTask, /backend\/src\/main\/java\/com\/jdy\/erp\/reports\/application\/ReportExportCleanupManager\.java/, "报表临时文件必须有独立 cleanup manager 所有者");
assertNotContains(currentTask, /backend\/src\/main\/java\/com\/jdy\/erp\/system\/api\/ReportQueryController\.java/, "共享报表 Controller 不得漂移到 system");
assertNotContains(currentTask, /backend\/src\/main\/java\/com\/jdy\/erp\/system\/application\/report\//, "共享报表 application 不得漂移到 system");
const requiredAreas = [
  "sales", "purchase", "inventory", "finance", "production",
  "lifecycle", "reports", "system", "security", "table"
];
for (const area of requiredAreas) {
  assertContains(currentTask, new RegExp(`^  - area-${area}$`, "m"), `requiredTier 必须包含 area:${area}`);
  assertContains(
    currentTask,
    new RegExp(`verification/regression-tier-area-${area}-latest\\.json`),
    `runtimeArtifacts 必须登记 area:${area}`
  );
}
assertContains(
  currentTask,
  /area:sales\/purchase\/inventory\/finance\/production\/lifecycle\/reports\/system\/security\/table。/,
  "最终串行门禁必须覆盖所有受影响 area"
);
if (!draftMode) {
  const baseCommit = currentTask.match(/^baseCommit: ([0-9a-f]{40})$/m)?.[1];
  assert(Boolean(baseCommit), "正式 A144 的 baseCommit 必须是 40 位 A143 治理提交");
  assertNotContains(currentTask, /pending-A143-governance-closure/, "正式 A144 不得保留 pending baseCommit");
  assert(gitSucceeds(["cat-file", "-e", `${baseCommit}^{commit}`]), "A144 baseCommit 必须是本仓库存在的 commit");
  assert(gitSucceeds(["merge-base", "--is-ancestor", baseCommit, "HEAD"]), "A144 baseCommit 必须属于当前 HEAD 祖先链");
  assert(hasA143GovernanceClosure(baseCommit), "A144 baseCommit 必须包含完整 A143/F008 A4 治理关单事实");
  const baseLineage = git(["rev-list", "--parents", "-n", "1", baseCommit]).split(/\s+/);
  assert(baseLineage.length === 2, "A143 治理关单提交必须精确只有一个 parent，不得用 merge commit 冒充首次 closure");
  const baseParent = baseLineage[1];
  assert(!hasA143GovernanceClosure(baseParent), "A144 baseCommit 必须精确指向首次形成 A143 治理关单的提交");
  assertActualChangesWithinAllowed(baseCommit, allowedPaths);
}

assertContains(currentTask, /V105__numbering_rule_reliability\.sql/, "V105 必须专用于编号规则可靠性");
assertContains(currentTask, /V106__inventory_source_trace\.sql/, "V106 必须专用于库存来源追溯");
assertContains(currentTask, /V107__inventory_source_trace_reaudit_fix\.sql/, "V107 必须只做库存追溯前向收口");
assertContains(currentTask, /V108__production_material_scrap\.sql/, "V108 必须专用于正式材料报废");
assertContains(currentTask, /V106 checksum=`1207842815` 是不可修改历史/, "V106 已执行 checksum 必须冻结");
assertContains(currentTask, /不 `repair` V106/, "共享库不得用 repair 掩盖 V106 历史");
assertContains(currentTask, /latest tenant 精确为 `84 tables \/ 84 PK \/ 79 unique \/ 176 FK \/ 97 checks`[\s\S]*public 精确为 `84 tables \/ 84 PK \/ 79 unique \/ 180 FK \/ 97 checks`[\s\S]*tenant sync function 目标精确为 `84\/79\/176\/97`/, "材料报废 V108 topology 必须精确冻结到 97 checks");
assertContains(currentTask, /`close_status` 与 `frozen_status` 各有枚举 CHECK[\s\S]*`voided_at\/void_reason\/void_verified_username\/void_verified_at`[\s\S]*不新增.*`voided_by`/, "V108 必须兼容统一生命周期列且不得虚构 voided_by");
assertContains(currentTask, /V104 历史快照仍断言 82/, "历史 V104 topology 必须继续断言 82");
assertContains(currentTask, /并行 worktree 的 V105\/V106\/V107\/V108 必须在各自随机临时数据库验证/, "并行 migration 必须隔离数据库并保持版本顺序");

assertContains(currentTask, /A146 独立阶段 GET 只返回 registry 精确登记的 26 个正式 document type[\s\S]*A151[\s\S]*第 27 项 `materialScrap\/CLBF\/production_material_scrap\/材料报废单`[\s\S]*最终 GET 精确更新为 27/, "编号 registry 必须按 A146 26→A151 27 项受控演进");
assertContains(currentTask, /lastNumber 只允许上调，不允许下调/, "F093 流水不得回退或复用");
assertContains(currentTask, /同时按持久化旧 prefix\/width 和请求新 prefix\/width 查询/, "F093 保存必须校验旧/新 prefix+width 双高水位");
assertContains(currentTask, /达到 `10\^width-1` 后精确 409/, "F093 必须有耗尽保护");
assertContains(currentTask, /遗留 `outsourcingSurface\/WWBM` 必须从 public、全部 tenant 和历史备份中清除/, "F093 必须清除并阻断恢复遗留规则");

assertContains(currentTask, /public `inv_stock_txn` 共 110,085 行/, "F042 必须记录 live 污染审计基线");
assertContains(currentTask, /新建 typed `InventoryPostingCommand`/, "F042 必须使用 typed posting command");
assertContains(currentTask, /`\/api\/inventory\/adjustments` 不允许成为生产管理员能力/, "F042 不得恢复生产库存调整接口");
assertContains(currentTask, /`local\/test\/regression` \+ 显式开关 \+ 测试账套 allowlist/, "F042 调整夹具必须同时受环境、开关和账套白名单限制");
assertContains(currentTask, /`system\.account_set\.manage` 不得绕过环境门禁/, "F042 管理员权限不得绕过调整环境门禁");
assertContains(currentTask, /`trace_quality` 枚举固定为 `EXACT\/CONTROLLED\/HEADER_ONLY\/LEGACY\/TEST`/, "F042 必须固定五态来源质量枚举");
assertContains(currentTask, /`CONTROLLED` 是受控期初等真实非单据来源[\s\S]*不得伪装成业务单据行或生成假钻取/, "F042 CONTROLLED 必须作为真实非单据来源显示且不得伪造单据钻取");
assertContains(currentTask, /源单反审后保存将更新或删除旧源行时[\s\S]*历史 `EXACT` 单向降级为 `HEADER_ONLY` 并清空 `source_bill_line_id`[\s\S]*禁止把旧事实 retarget 到新行/, "F042 反审后保存必须真实降级旧行追溯且不得重定向历史");
assertContains(currentTask, /所有既有源单 `saveDraft` 必须先锁定 header 并原子确认当前状态为 DRAFT[\s\S]*非 DRAFT 直接保存精确 409[\s\S]*追溯降级只能在该 DRAFT guard 成功后/, "F042 源单保存必须先守卫 DRAFT 再降级追溯");
assertContains(currentTask, /two-stage plan[\s\S]*`FACT\/RESULT\/BOTH\/BOUND_ONLY` placement[\s\S]*`BOUND_ONLY` 只把规范化值绑定到固定 source\/result SQL 参数[\s\S]*不生成外层 WHERE/, "报表 placement 必须包含安全的 BOUND_ONLY 绑定语义");
assertContains(currentTask, /registry require → typed raw query parse → permission → platform registered route → `TenantDataScopeService\.currentScopeId\(namespace\)` → plan\/execute[\s\S]*任何 tenant JDBC[\s\S]*每请求只解析一次[\s\S]*count\/rows\/totals\/export/, "报表底座必须固定 server-owned data scope 解析顺序与单次快照");
assertContains(currentTask, /同一已注册 public schema[\s\S]*另一 UUID decoy[\s\S]*除 account_set_id 外命中相同日期\/业务筛选[\s\S]*count\/rows\/totals\/export 全排除 decoy/, "F042 public decoy 必须真实证明 account_set_id 四路隔离");
assertContains(currentTask, /tenant schema 使用服务返回的 namespace-derived scope[\s\S]*tenant schema 也用 namespace-derived scope 与另一 UUID 做同条件正反夹具[\s\S]*count\/rows\/totals\/export 四路证明只包含合法行/, "F042 tenant decoy 必须证明 namespace-derived scope 四路隔离");
assertContains(currentTask, /raw query 中出现 `scope\/schema\/accountSetId\/tenantId\/dataScope` 或任何 server-owned binding 名一律 400[\s\S]*query echo 不泄露/, "server-owned scope 必须拒绝客户端名称碰撞且不回显");
assertContains(currentTask, /parser\/normalized query\/plan\/JDBC\/executor 内部的 decimal 保持 `BigDecimal`[\s\S]*response rows、totals、query echo[\s\S]*`stripTrailingZeros\(\)\.toPlainString\(\)`[\s\S]*page\/pageSize\/total 保持 JSON integer/, "报表 decimal wire 必须只在 response 边界转精确字符串");
assertContains(currentTask, /CSV 不经过 response normalizer[\s\S]*`BigDecimal\.toPlainString\(\)`[\s\S]*两条路径均不得经 double/, "CSV 必须绕过 response string normalizer 并直接精确输出 BigDecimal");
assertContains(currentTask, /已存在任一历史库存流水的源单 header 不得物理删除[\s\S]*`SELECT \.\.\. FOR UPDATE`[\s\S]*`DELETE \.\.\. WHERE status='DRAFT'`[\s\S]*绝不允许 orphan fact/, "F042 历史源单删除必须锁定且并发 fail closed");
assertContains(currentTask, /`TEST` 永不作为正式报表业务事实，生产报表 SQL 默认排除/, "F042 TEST 必须从生产正式报表排除");
assertContains(currentTask, /禁止在报表查询时用当前余额倒推每行历史结存/, "F042 不得伪造历史结存");
assertContains(currentTask, /期初绝对值保存也不得在锁外读取旧余额[\s\S]*最终余额=基线\+流水 delta 之和/, "F042 期初与正式写入必须锁内计算 delta 并保持账实一致");
assertContains(currentTask, /期初绝对值保存不得清零或覆盖既有 `qty_reserved`[\s\S]*`newQty < existingReserved` 精确 409[\s\S]*正常出库或释放/, "F042 期初保存必须保留预留并阻断低于预留的余额");
assertContains(currentTask, /取得余额序列化锁后用数据库 `clock_timestamp\(\)` 显式写入[\s\S]*`occurred_at,id` 排序[\s\S]*实际余额更新顺序一致/, "F042 并发成功流水时间必须反映余额序列化顺序");
assertContains(currentTask, /Opening CONTROLLED 的 `source_bill_date` 必须由同一 fact `clock_timestamp\(\)` 按 Asia\/Shanghai 推导[\s\S]*EXACT\/HEADER_ONLY\/CONTROLLED 日期一致/, "F042 新来源与期初日期必须固定业务时区");
assertContains(currentTask, /第一版库存成本未启用/, "F042 不得伪造库存成本");

assertContains(currentTask, /报废审核只形成生产损耗事实并占用正式报废配额，绝不再次扣减库存/, "F061 审核不得二次扣库存");
assertContains(currentTask, /`isStockIn=false` 全生命周期零库存流水/, "F061 false 分支必须零库存流水");
assertContains(currentTask, /`isStockIn=true` 审核后仅进入“待报废入库”/, "F061 true 分支必须使用独立报废入库动作");
assertContains(currentTask, /保存草稿时每行 `scrapQty >= 0`[\s\S]*当 `scrapQty = 0` 时报废原因不必填写/, "F061 草稿必须允许 0 且不强制报废原因");
assertContains(currentTask, /`0 <= reissueQty <= scrapQty`/, "F061 报废重发数量必须受报废数量上限约束");
assertContains(currentTask, /审核时必须重新校验每行 `scrapQty > 0`/, "F061 审核时每行报废数量必须大于 0");
assertContains(currentTask, /`BillLifecycleService\.guardSourceLineIdQuantities`[\s\S]*不得在 `MaterialScrapAppService` 私写另一套 quota SQL[\s\S]*先锁 source header[\s\S]*source line UUID 稳定排序并 `FOR UPDATE`[\s\S]*下游 header `AUDITED`[\s\S]*当前 scrap header id 排除自身[\s\S]*AppService 在守卫完成后才锁 scrap header/, "F061 UUID 数量占用必须由共享生命周期服务统一承载并固定锁序");
assertContains(currentTask, /并发审核超量只能一个成功[\s\S]*失败方单据状态\/库存\/业务成功日志为 0[\s\S]*HTTP 409[\s\S]*`SECURITY\/WRITE_FAILED`/, "F061 并发失败必须业务零副作用并保留 A136 失败审计");
assertContains(currentTask, /新建或下推报废单必须先锁来源领料头\/行[\s\S]*`NumberingService\.assignBillNo\/nextBillNo`[\s\S]*MaterialIssue redReverse[\s\S]*锁 source→检查 red\/scrap guard→取红字编号[\s\S]*死锁环/, "F061 创建与红字必须统一 source→numbering 锁序");
assertContains(currentTask, /审核的业务状态与业务成功日志必须在同一 routed 事务内原子提交[\s\S]*事务失败时二者一并回滚[\s\S]*A136[\s\S]*`SECURITY\/WRITE_FAILED`/, "F061 审核状态与成功日志必须同事务并区分 A136 失败审计");
assertContains(currentTask, /frontend\/src\/modules\/production\/material-issue\/MaterialIssueForm\.vue/, "F061 下推入口必须纳入 MaterialIssueForm 允许路径");
assertContains(currentTask, /frontend\/src\/components\/MaterialScrapEntryTable\.vue/, "F061 专用报废明细组件必须纳入允许路径");
assertContains(currentTask, /docs\/guides\/bill-lifecycle-unification-protocol\.md/, "F061 正式单据必须允许更新生命周期登记协议");
assertContains(currentTask, /`source_issue_line_id` 必须非空但采用软引用[\s\S]*不建立到 material issue line 的 FK[\s\S]*历史 VOID 报废行保留旧 source line UUID 和业务快照[\s\S]*不能.*retarget/, "F061 源领料行必须使用不可重定向的历史软引用");
assertContains(currentTask, /`red_source_bill_id IS NULL`[\s\S]*`NOT EXISTS \(red\.red_source_bill_id=source\.id AND red\.status<>'VOID'\)`[\s\S]*preview\/list[\s\S]*push\/save\/audit 必须在锁定来源领料头后重新校验/, "F061 来源必须同时排除自身红字与非 VOID 红字子单并在写入时复检");
assertContains(currentTask, /`COALESCE\(\.\.\.,'生产部'\)` 展示兜底[\s\S]*初次 preview\/push\/new draft[\s\S]*task\.`department_code` 精确解析为 `md_production_department\.code`[\s\S]*`enabled=TRUE AND audit_status='AUDITED'`[\s\S]*不得伪造“生产部”、跨 schema 查找[\s\S]*已有 draft 的 save\/audit[\s\S]*不因车间后来停用或改名而改写历史或无依据拒审/, "F061 workshop 必须真实解析且既有草稿保留历史快照");
assertContains(currentTask, /`MaterialIssueForm\.vue` 的 `showExtraAction\/canExtraAction\/extraActionLabel` 接缝[\s\S]*只对满足来源条件的已审核生产领料显示/, "F061 下推必须复用既有局部 extra action 接缝");
assertContains(currentTask, /`MaterialScrapForm\.vue` 复用 `StandardDocument`\/`ActionBar`[\s\S]*`MaterialScrapEntryTable\.vue`[\s\S]*组件内部复用共享 `TableCore`[\s\S]*业务页面不得直接使用 `TableCore`[\s\S]*不修改共享 `DocumentForm\.vue`/, "F061 表单必须使用符合共享表格规范的专用分录组件");
assertContains(currentTask, /\| A151 \|[\s\S]*\| A145、A146、A147 \|[\s\S]*V108 必须从已合入 V105 的 tenant topology `82 tables \/ 76 unique \/ 170 FK \/ 80 checks`/, "A151 必须显式依赖 A146/V105 和既有编号注册表");
assertContains(currentTask, /`MaterialScrapController`[\s\S]*类级 `\/api`[\s\S]*`\/production\/material-issues\/\{billNo\}\/push-material-scrap`[\s\S]*不修改未授权的 `ProductionController`[\s\S]*DocumentLockGuard/, "F061 下推后端必须留在允许 controller 且保留锁守卫");
assertContains(currentTask, /MaterialScrapListQueryAdapter\.java[\s\S]*MaterialScrapListQueryAdapterIntegrationTest\.java/, "F061 必须允许独立 list adapter 与集成测试路径");
assertContains(currentTask, /MaterialScrapReportQuerySpec\.java[\s\S]*MaterialScrapReportQueryIntegrationTest\.java/, "F061 报表 definition 必须有独立集成测试路径");
assertContains(currentTask, /adapter key=`materialScrap`[\s\S]*`material-scrap-form-list`[\s\S]*`material-scrap-source-selector`[\s\S]*真实 SQL COUNT\+LIMIT\/OFFSET[\s\S]*不得把 adapter 隐藏在 `MaterialScrapAppService\.java`[\s\S]*seed\/default fallback/, "F061 列表必须使用独立真实 adapter 且禁止隐藏类或 fallback");
assertContains(currentTask, /生产车间 id\+商品 id\+单位快照汇总基本数量[\s\S]*显示名称不进入身份 tuple[\s\S]*禁止跨单位相加/, "F061 报废汇总必须使用稳定同量纲 tuple");
assertContains(currentTask, /报废入库与撤销报废入库都必须以整单为边界原子处理全部 `isStockIn=true` 行[\s\S]*不提供选行或部分成功[\s\S]*任一行失败.*整单回滚/, "F061 报废入库及撤销必须整单原子且禁止部分成功");
assertContains(currentTask, /报废 header→报废 lines→按 `\(productId,targetWarehouseId,lineId\)` 稳定排序[\s\S]*不得按前端行顺序锁多个库存维度/, "F061 报废入库必须使用确定性多库存维度锁序");
assertContains(currentTask, /`materialScrap` 必须同时登记到 lifecycle protocol[\s\S]*`DocumentPermissionPolicy=production\.document\.audit`[\s\S]*close\/freeze=false[\s\S]*redReverse=false[\s\S]*void=true[\s\S]*`\/api\/document-lifecycle\/materialScrap\/\{billNo\}\/void`/, "F061 生命周期能力必须前后端登记且复用 hardened void");
assertContains(currentTask, /`BillLifecycleService\.voidBill` 对 `production_material_scrap`[\s\S]*先锁 header[\s\S]*仍有 active 报废入库[\s\S]*已完整撤销的历史库存流水永久阻断作废[\s\S]*关闭\/冻结\/行级动作必须由 policy 返回 400/, "F061 通用作废必须使用报废专用守卫并允许已撤销历史");
assertContains(lifecycleProtocol, /### A151 材料报废生命周期登记[\s\S]*`materialScrap`[\s\S]*`material-scrap-form-list`[\s\S]*反审核固定回 `DRAFT`[\s\S]*共享 reason\/password\/permission 路由[\s\S]*关闭 \/ 冻结 \/ 行关闭 \/ 行冻结[\s\S]*全部不支持[\s\S]*红冲[\s\S]*不支持/, "F061 必须在统一生命周期协议登记完整能力");
assertContains(lifecycleProtocol, /反审核固定回 `DRAFT`[\s\S]*active 报废入库时返回 409[\s\S]*独立“撤销报废入库”动作整单撤销后再反审核[\s\S]*反审核本身不得自动写反向库存流水/, "F061 反审核必须阻断 active 入库且不得自动代替独立撤销动作");
assertContains(lifecycleProtocol, /`MaterialScrapForm\.vue` 复用 `StandardDocument`\/`ActionBar`[\s\S]*`MaterialScrapEntryTable\.vue` 内部复用共享 `TableCore`[\s\S]*不修改 `DocumentForm\.vue`/, "材料报废生命周期登记不得错误复用通用 DocumentForm");
assertContains(lifecycleProtocol, /`BillLifecycleService\.guardSourceLineQuantities`[\s\S]*`guardSourceLineIdQuantities`[\s\S]*不能在某一张单据 AppService 里私写另一套 quota SQL[\s\S]*header→排序后的 source line ids[\s\S]*`FOR UPDATE`[\s\S]*父单 `AUDITED`[\s\S]*header id 排除自身[\s\S]*HTTP 409/, "UUID 源行数量守卫必须纳入共享生命周期协议");
assertContains(currentTask, /“报废重发数量”首版仅记录，不自动生成生产领料单/, "F061 首版不得自动重发领料");
assertContains(currentTask, /有报废入库未撤销时阻断报废单反审核/, "F061 必须先撤销报废入库再反审核");
assertContains(currentTask, /A152 的材料报废专用明细表必须验收业务列拖拽[\s\S]*列头筛选[\s\S]*适用列批量填充[\s\S]*组件内部横向滚动[\s\S]*页面本身.*不得横向溢出/, "A152 必须覆盖专用报废明细表共享交互与横向滚动边界");
assertContains(currentTask, /F029\/F091 的 CNY\/USD 分组[\s\S]*F042\/F061 只验商品基本单位\/单位快照分组[\s\S]*不伪造 currency、不跨单位相加/, "浏览器验收必须区分金额币种与纯数量单位口径");

assertContains(currentTask, /销售出库过账生命周期写入的 `ar_receivable` 正负事实行[\s\S]*采购入库\/退货过账生命周期写入的 `ap_payable` 正负事实行/, "F091 首版必须使用真实销售出库 AR 与采购入库/退货 AP 事实");
assertContains(currentTask, /`ar_receivable\.status\/ap_payable\.status` 只有 `OPEN\/PART_SETTLED\/SETTLED`[\s\S]*禁止使用 `WHERE ar_receivable\.status='AUDITED'` 或 `WHERE ap_payable\.status='AUDITED'`/, "F091 不得把 AR/AP 结算状态误当审核状态");
assertContains(currentTask, /实际收款退款单\/付款退款单、预收\/预付、其他应收\/其他应付和任何未交付资金事实都不属于 A150/, "F091 必须明确排除未交付退款、预收预付和其他往来");
assertContains(currentTask, /AR\/AP 发生按来源 `bill_date`[\s\S]*parent header `status=AUDITED`[\s\S]*parent 回 `DRAFT` 则该事件退出/, "F091 期间必须按 AR/AP 发生和 A141 父单状态/日期重建");
assertContains(currentTask, /`sales_return\.status=AUDITED` 的 finance allocation[\s\S]*日期取 return `bill_date`/, "F091 销售退货冲应收必须按已审核退货事件日期");
assertContains(currentTask, /应收余额事件增量固定为：[\s\S]*`ar_receivable\.amount`[\s\S]*`settlement_amount`[\s\S]*`offset_amount`[\s\S]*应付余额事件增量固定为：[\s\S]*`ap_payable\.amount`[\s\S]*`settlement_amount`/, "F091 必须冻结 AR/AP 精确事件增量公式");
assertContains(currentTask, /A142 退货只通过 finance allocation 进入[\s\S]*禁止再生成或读取一条所谓“退货 AR”重复冲减/, "F091 不得虚构 A142 退货 AR 或双重冲减");
assertContains(currentTask, /`pending_refund_amount` 只作为待退款状态单独展示，绝不进入 AR 余额或现金流/, "F091 待退款不得伪装成现金流或 AR 余额");
assertContains(currentTask, /期初=所有 `dateFrom` 之前上述事件增量之和，期间=`dateFrom\.\.dateTo` 上述事件增量之和，期末=期初\+期间净额/, "F091 期初/期间/期末必须按精确事件增量计算");
assertContains(currentTask, /禁止使用 AR\/AP 当前 `received_amount\/paid_amount\/return_offset_amount` 快照重建期初或期间[\s\S]*禁止同时读取快照与 allocation 重复扣减/, "F091 不得用当前快照伪造期间或重复扣减");
assertContains(currentTask, /作废只允许 DRAFT[\s\S]*统计和库存流水均为 0[\s\S]*释放对源领料反审核、红字反审核或作废的下游阻断/, "F061 VOID 必须清零统计库存并释放源单阻断");
assertContains(currentTask, /固定 registry 的 GET\/PUT[\s\S]*不开放新增 `documentType` 或 DELETE/, "F093 首版只允许固定 registry GET/PUT");
assertContains(currentTask, /`dimension=CUSTOMER\|PRODUCT_UNIT`[\s\S]*默认并 echo `CUSTOMER`[\s\S]*CUSTOMER 按客户\+币种只汇总金额、税额、含税金额，不返回数量合计/, "F029 客户维度必须默认且只聚合金额");
assertContains(currentTask, /PRODUCT_UNIT 按商品 id\+单位快照\+币种汇总数量、金额、税额、含税金额[\s\S]*禁止跨单位或币种相加/, "F029 商品维度数量金额不得跨单位或币种相加");
assertContains(currentTask, /`N`=按来源订单号\+行号聚合的已审核发货通知数量[\s\S]*`executedQty=N\+D`[\s\S]*`netDeliveredQty=O-R`[\s\S]*`executedUnshippedQty=max\(executedQty-shippedQty,0\)`/, "F029 订单跟踪必须冻结真实下游公式");
assertContains(currentTask, /缺 trace 不得按商品\+数量猜配[\s\S]*shipped counter 只用于回归对账[\s\S]*`INCONSISTENT`/, "F029 订单跟踪不得猜配或隐藏异常");
assertContains(currentTask, /`sales_out\.status IN \('AUDITED','RED_REVERSED'\)`[\s\S]*RED_REVERSED 只作为 legacy effective red 状态[\s\S]*绝不再次取反/, "F029 必须兼容有效历史红字且保留销售出库行符号");

const expectedReports = [
  ["sales-detail", "sales.order.audit"],
  ["sales-summary", "sales.order.audit"],
  ["sales-order-tracking", "sales.order.audit"],
  ["inventory-movement-detail", "inventory.stock.view"],
  ["receivable-detail", "finance.report.view"],
  ["receivable-summary", "finance.report.view"],
  ["payable-detail", "finance.report.view"],
  ["payable-summary", "finance.report.view"],
  ["material-scrap-summary", "production.document.audit"]
];
for (const [reportKey, permission] of expectedReports) {
  const permissionRow = reportProtocol.split("\n").find((line) => line.includes(`| \`${reportKey}\` |`));
  assert(Boolean(permissionRow?.includes(`| \`${permission}\` |`)), `${reportKey} 必须绑定项目既有权限 ${permission}`);
}

assertContains(reportProtocol, /GET \/api\/reports\/\{reportKey\}/, "报表 query API 必须固定");
assertContains(reportProtocol, /GET \/api\/reports\/\{reportKey\}\/export\.csv/, "报表 CSV API 必须固定");
assertContains(reportProtocol, /`com\.jdy\.erp\.reports\.api\/application` 模块/, "报表协议必须固定 reports 模块归属");
assertContains(reportProtocol, /引出最多 20,000 行；超过上限返回 413/, "CSV 必须固定 20,000/413 边界");
assertContains(reportProtocol, /空结果也必须输出表头/, "CSV 空结果必须保留固定表头");
assertContains(reportProtocol, /非数值文本以 `= \+ - @ tab CR` 等公式触发字符开头时必须中和/, "CSV 必须覆盖全部公式注入前缀");
assertContains(reportProtocol, /含 tab 或其他受控字符的普通文本也必须进入引用\/安全处理分支并通过 round-trip 测试/, "CSV 普通 tab/受控字符必须安全引用并可回读");
assertContains(reportProtocol, /只有当前请求线程完成响应写出\/flush 后才尝试记录/, "CSV 成功日志必须晚于同步响应写出");
assertContains(reportProtocol, /传输复制字节数必须等于 artifact 声明的 `contentLength`/, "CSV 传输必须校验完整字节数");
assertContains(reportProtocol, /专用临时目录并由单一 cleanup manager 持有[\s\S]*生成阶段失败、队列满、调度拒绝或重试耗尽[\s\S]*周期清扫、启动扫描和关闭清理/, "CSV 临时文件在全部失败阶段都必须有最终所有者");
assertContains(reportProtocol, /区分本进程 active\/pending[\s\S]*stale grace[\s\S]*不得删除仍在传输的活跃 artifact/, "CSV 清扫不得误删活跃引出文件");
assertContains(reportProtocol, /不得抛出或宣称一个客户端不可能收到的 HTTP 500/, "post-flush 审计失败不得伪造不可送达的 500");
assertContains(reportProtocol, /服务端结构化告警[\s\S]*运维补偿/, "post-flush 审计失败必须进入结构化告警和运维补偿");
assertContains(reportProtocol, /不记录 SQL、schema、绝对路径或原始异常消息/, "补偿和清扫日志不得泄漏 SQL/schema/path/原始异常");
assertContains(reportProtocol, /规范化 `dateFrom\/dateTo` 作为绑定参数传给固定 source SQL/, "报表底座必须支持聚合前安全日期绑定");
assertContains(reportProtocol, /受控 two-stage plan[\s\S]*fact 层应用 date、AND 多词 keyword 与 filters[\s\S]*optional fixed result\/aggregate SQL[\s\S]*count\/rows\/totals\/export/, "报表底座必须支持聚合前统一 predicate 的两阶段计划");
assertContains(reportProtocol, /`FACT\/RESULT\/BOTH\/BOUND_ONLY` placement[\s\S]*enum default 或 required[\s\S]*进入 query echo[\s\S]*返回 400/, "报表 filter/keyword/date 必须声明执行层级和默认/必填语义");
assertContains(reportProtocol, /合法 accountSetId、非空 databaseName 与 schemaName[\s\S]*platform JDBC[\s\S]*`sys_account_set` 当前登记精确一致[\s\S]*平台注册为 `public` 的合法老账套必须可用/, "报表 tenant route 必须绑定平台注册且兼容合法 public 账套");
assertContains(reportProtocol, /逗号 join[\s\S]*括号化 JOIN tree[\s\S]*`ONLY \(schema\.table\)`[\s\S]*`TABLE schema\.table`[\s\S]*CTE\/子查询[\s\S]*schema-qualified 名称全部拒绝/, "固定报表 SQL 必须阻断全部 schema relation 绕过");
assertContains(reportProtocol, /明细 definition 的稳定排序必须以真实非空行主键收尾/, "报表明细分页必须有真实 PK 稳定兜底");
assertContains(reportProtocol, /汇总 definition 必须以能唯一标识结果行的完整 GROUP BY 维度 tuple 收尾/, "报表汇总分页必须使用完整 group tuple 稳定兜底");
assertContains(reportProtocol, /禁止回退到 `DefaultStubListQueryAdapter`、`StubListSeedRowsProvider`/, "报表不得进入 seed/default fallback");
assertContains(reportProtocol, /`trace_quality` 只有五态：`EXACT\/CONTROLLED\/HEADER_ONLY\/LEGACY\/TEST`/, "F042 协议必须固定五态来源质量枚举");
assertContains(reportProtocol, /`CONTROLLED` 是受控期初等真实非单据来源[\s\S]*不得伪装成业务单据行或生成假钻取/, "F042 协议必须正确呈现 CONTROLLED 非单据来源");
assertContains(reportProtocol, /保存前必须锁定 header 并确认仍为 DRAFT[\s\S]*历史 `EXACT` 单向降级为 `HEADER_ONLY` 并清空 `source_bill_line_id`[\s\S]*禁止把旧事实 retarget 到新行/, "F042 协议必须固定 DRAFT guard 与反审编辑追溯降级");
assertContains(reportProtocol, /删除必须 `SELECT \.\.\. FOR UPDATE`[\s\S]*`DELETE \.\.\. WHERE status='DRAFT'`[\s\S]*不得产生 orphan fact/, "F042 协议必须固定历史头删除并发边界");
assertContains(reportProtocol, /`TEST` 永不作为正式报表业务事实，生产报表 SQL 默认排除/, "F042 协议必须排除生产 TEST 流水");
assertContains(reportProtocol, /锁定余额行后才读取旧值、计算 delta、更新余额并写流水[\s\S]*`clock_timestamp\(\)`[\s\S]*最终余额必须等于基线加流水 delta 之和/, "F042 协议必须固定并发库存账实与流水时间顺序");
assertContains(reportProtocol, /保留锁内既有 `qty_reserved`[\s\S]*new_on_hand<reserved 时 409[\s\S]*余额\/流水\/业务成功日志零变化[\s\S]*`SECURITY\/WRITE_FAILED`/, "F042 协议必须固定期初与预留的安全关系及 A136 失败审计");
assertContains(reportProtocol, /`FACT\/RESULT\/BOTH\/BOUND_ONLY` placement[\s\S]*`BOUND_ONLY` 只允许把已规范化的值绑定到固定 source\/result SQL 参数[\s\S]*不再生成外层 WHERE/, "报表协议必须固定安全的 BOUND_ONLY 语义");
assertContains(reportProtocol, /registry require → typed raw query parse → permission → platform registered route → `TenantDataScopeService\.currentScopeId\(namespace\)` → plan\/execute[\s\S]*每请求只解析一次[\s\S]*count\/rows\/totals\/export/, "报表协议必须固定 server-owned data scope 解析顺序与快照");
assertContains(reportProtocol, /同一已注册 public schema[\s\S]*除 `account_set_id` 外均命中相同日期与业务筛选[\s\S]*另一 UUID[\s\S]*count\/rows\/totals\/export 必须全部只包含合法行/, "报表协议 public decoy 必须证明 account_set_id 四路隔离");
assertContains(reportProtocol, /tenant schema 使用该服务返回的 namespace-derived scope[\s\S]*tenant schema 同样以 namespace-derived scope 与另一 UUID 做同条件正反夹具[\s\S]*count\/rows\/totals\/export 四路证明只包含合法行/, "报表协议 tenant decoy 必须证明 namespace-derived scope 四路隔离");
assertContains(reportProtocol, /`scope\/schema\/accountSetId\/tenantId\/dataScope` 或任何 server-owned binding 名[\s\S]*出现即 400[\s\S]*不得进入 query echo/, "报表协议必须拒绝客户端 scope 名称碰撞");
assertContains(reportProtocol, /parser、normalized query、plan、JDBC bindings、executor rows\/totals 在内部必须保持 `BigDecimal`[\s\S]*response 的 rows、totals 与 query echo[\s\S]*`stripTrailingZeros\(\)\.toPlainString\(\)`[\s\S]*page\/pageSize\/total 等安全整数仍为 JSON integer/, "报表协议必须固定内部 BigDecimal 与 response string 边界");
assertContains(reportProtocol, /CSV 不经过 response normalizer[\s\S]*`BigDecimal\.toPlainString\(\)`[\s\S]*均不得经 double/, "报表协议 CSV 必须从 BigDecimal 直接精确输出");
assertContains(reportProtocol, /非 DRAFT 直接保存 409[\s\S]*header\/line\/余额\/流水\/业务成功日志零变化[\s\S]*`SECURITY\/WRITE_FAILED`/, "F042 协议必须固定非草稿保存 409 的业务零副作用与失败审计");
assertContains(reportProtocol, /\(created_at AT TIME ZONE 'Asia\/Shanghai'\)::date[\s\S]*Opening CONTROLLED[\s\S]*不能使用 session `CURRENT_DATE`/, "F042 协议必须固定来源日期业务时区");
assertContains(reportProtocol, /CNY 与 USD 在行、合计和汇总中按 `currency` 分组/, "金额报表必须分币种");
assertContains(reportProtocol, /`sales_return\.status='AUDITED'` 的数量、金额、税额和含税金额由报表统一转为负数/, "销售退货必须负向进入报表");
assertContains(reportProtocol, /`sales_out\.status IN \('AUDITED','RED_REVERSED'\)`[\s\S]*旧 link 缺失[\s\S]*不按类型再次取反[\s\S]*DRAFT\/REVERSED\/VOID 排除/, "F029 协议必须兼容历史有效红字并排除非正式状态");
assertContains(reportProtocol, /实际收款退款单\/付款退款单、预收\/预付、其他应收\/其他应付和任何未交付事实不进入 6E 首版/, "F091 协议不得越界消费未交付资金事实");
assertContains(reportProtocol, /`ar_receivable\.status\/ap_payable\.status` 只有 `OPEN\/PART_SETTLED\/SETTLED`[\s\S]*禁止用 `status='AUDITED'` 查询 AR\/AP/, "F091 协议不得把 AR/AP 结算状态误当审核状态");
assertContains(reportProtocol, /应收余额事件增量=`ar_receivable\.amount`[\s\S]*receipt allocation\.`settlement_amount`[\s\S]*finance allocation\.`offset_amount`[\s\S]*应付余额事件增量=`ap_payable\.amount`[\s\S]*payment allocation\.`settlement_amount`/, "F091 协议必须冻结精确事件增量公式");
assertContains(reportProtocol, /A142 不创建 `ar_receivable` 行[\s\S]*禁止把销售退货同时算作负 AR 事实和 `offset_amount` 双重扣减/, "F091 协议不得虚构 A142 AR 或双计退货冲减");
assertContains(reportProtocol, /A141 allocation 只在 receipt\/payment parent header `status=AUDITED` 时生效[\s\S]*反审核回 `DRAFT` 后退出/, "F091 协议必须按 A141 父单状态重建核销事件");
assertContains(reportProtocol, /期初=所有 `dateFrom` 之前上述事件增量之和[\s\S]*`received_amount\/paid_amount\/return_offset_amount` 快照重建期初或期间[\s\S]*allocation 重复扣减/, "F091 协议必须固定事件期间口径并禁止快照倒推或重复扣减");
assertContains(reportProtocol, /`trace_quality=LEGACY AND source_bill_date IS NULL`[\s\S]*`dateBasis=POSTING_FALLBACK`[\s\S]*不得冒充业务日期/, "F042 协议必须显式标记无业务日期 LEGACY 的记账日期降级");
assertContains(reportProtocol, /`TEST` 必须在任何日期\/fallback 计算前排除[\s\S]*绝不进入 rows\/count\/totals\/export/, "F042 TEST 必须先于日期降级从正式报表排除");
assertContains(reportProtocol, /\(occurred_at AT TIME ZONE 'Asia\/Shanghai'\)::date[\s\S]*UTC 跨日边界夹具[\s\S]*session TimeZone/, "F042 LEGACY 降级日期必须固定业务时区且跨 session 时区稳定");
assertContains(reportProtocol, /销售汇总：单一 `sales-summary` key 使用 `dimension=CUSTOMER\|PRODUCT_UNIT`[\s\S]*默认\/echo `CUSTOMER`[\s\S]*CUSTOMER 按客户\+币种只汇总金额、税额、含税金额且不返回数量合计/, "F029 协议客户维度必须默认且只聚合金额");
assertContains(reportProtocol, /PRODUCT_UNIT 按商品 id\+单位快照\+币种汇总数量、金额、税额、含税金额[\s\S]*禁止跨单位或币种相加/, "F029 协议商品数量金额不得跨单位或币种相加");
assertContains(reportProtocol, /令 `N` 为按来源订单号\+行号聚合的已审核发货通知数量[\s\S]*`executedQty=N\+D`[\s\S]*`netDeliveredQty=O-R`[\s\S]*`executedUnshippedQty=max\(executedQty-shippedQty,0\)`/, "F029 协议必须冻结订单跟踪公式");
assertContains(reportProtocol, /不得以商品\+数量猜配缺失 trace[\s\S]*`INCONSISTENT`[\s\S]*日期范围只过滤订单业务日期/, "F029 协议不得猜配、隐藏异常或伪装历史时点");
assertContains(reportProtocol, /第一版没有库存成本口径/, "商品收发不得伪造成本");
assertContains(reportProtocol, /包含金额\/币种的 report key 覆盖 CNY\/USD[\s\S]*纯数量报表不伪造 currency[\s\S]*无跨单位合计/, "报表自动化必须区分金额币种与纯数量单位口径");

mkdirSync(verificationDir, { recursive: true });
writeFileSync(resultPath, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  draftMode,
  ok: true,
  assertionCount: checks.length,
  assertions: checks
}, null, 2)}\n`);

console.log(`A144 6E contract regression: PASS (${checks.length} assertions${draftMode ? ", draft" : ""})`);
