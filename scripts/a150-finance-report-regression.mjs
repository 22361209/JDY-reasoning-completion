#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertReportImportGraph } from "./helpers/report-import-graph.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const resultPath = path.join(verificationDir, "a150-finance-report-regression.json");
const backendPath = "backend/src/main/java/com/jdy/erp/finance/application/FinanceReportQuerySpec.java";
const testPath = "backend/src/test/java/com/jdy/erp/finance/application/FinanceReportQueryIntegrationTest.java";
const frontendPath = "frontend/src/modules/reports/financeReports.ts";
const registryPath = "frontend/src/modules/reports/reportRegistry.ts";
const catalogPath = "frontend/src/modules/catalog.ts";
const backend = read(backendPath);
const test = read(testPath);
const frontend = read(frontendPath);
const registry = read(registryPath);
const catalog = read(catalogPath);
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

const exactKeys = [
  "receivable-detail",
  "receivable-summary",
  "payable-detail",
  "payable-summary",
];
for (const key of exactKeys) {
  assert(occurrences(backend, `"${key}"`) === 1, `后端必须精确登记一次 ${key}`);
  assert(occurrences(frontend, `entryId: "${key}"`) === 1, `前端共享配置必须精确登记一次 entryId ${key}`);
  assert(occurrences(frontend, `reportKey: "${key}"`) === 1, `前端共享配置必须精确登记一次 reportKey ${key}`);
}
assert(occurrences(backend, "finance.report.view") === 1, "四个报表必须共享 finance.report.view 常量");
contains(backend, /@Configuration\(proxyBeanMethods = false\)/, "F091 definition 必须作为显式 Spring beans 注册");
contains(backend, /@Bean[\s\S]*receivableDetailReportQuerySpec/, "应收明细必须是精确 bean");
contains(backend, /@Bean[\s\S]*receivableSummaryReportQuerySpec/, "应收汇总必须是精确 bean");
contains(backend, /@Bean[\s\S]*payableDetailReportQuerySpec/, "应付明细必须是精确 bean");
contains(backend, /@Bean[\s\S]*payableSummaryReportQuerySpec/, "应付汇总必须是精确 bean");

contains(backend, /FROM ar_receivable receivable[\s\S]*receivable\.status IN \('OPEN', 'PART_SETTLED', 'SETTLED'\)/, "AR 必须保留三种结算状态且包含 SETTLED");
contains(backend, /FROM ap_payable payable[\s\S]*payable\.status IN \('OPEN', 'PART_SETTLED', 'SETTLED'\)/, "AP 必须保留三种结算状态且包含 SETTLED");
excludes(backend, /receivable\.status\s*=\s*'AUDITED'|payable\.status\s*=\s*'AUDITED'/, "AR/AP 结算状态不得冒充审核状态");
contains(backend, /FROM ar_receipt_allocation allocation[\s\S]*receipt\.status = 'AUDITED'/, "收款事件只允许已审核父单 allocation");
contains(backend, /FROM ap_payment_allocation allocation[\s\S]*payment\.status = 'AUDITED'/, "付款事件只允许已审核父单 allocation");
contains(backend, /FROM sales_return_finance_allocation allocation[\s\S]*sales_return\.status = 'AUDITED'/, "退货冲应收只允许已审核 finance allocation");
contains(backend, /allocation\.pending_refund_amount AS "pendingRefundAmount"[\s\S]*-allocation\.offset_amount AS "balanceDelta"/, "待退款必须单独展示且只有 offset 进入 AR 余额");
contains(backend, /receivable\.amount AS "occurrenceAmount"[\s\S]*receivable\.amount AS "balanceDelta"/, "AR signed amount 必须原样进入发生额和余额事件");
contains(backend, /payable\.amount AS "occurrenceAmount"[\s\S]*payable\.amount AS "balanceDelta"/, "AP signed amount 必须原样进入发生额和余额事件");
contains(backend, /allocation\.settlement_amount AS "settledAmount"[\s\S]*-allocation\.settlement_amount AS "balanceDelta"/, "核销金额必须只扣减一次余额");
excludes(backend, /received_amount|paid_amount|return_offset_amount/, "报表不得使用 AR/AP 当前结算快照倒推历史");
excludes(backend, /ar_refund|ap_refund|prepayment|advance_receipt|advance_payment|other_receivable|other_payable/i, "A150 不得伪造退款、预收预付或其他往来事实");
excludes(backend, /DefaultStub|SeedRows|sales_order|queryForList|JdbcTemplate/, "领域 definition 不得回退旧列表、销售订单或自行执行 JDBC");

contains(backend, /requiredDateRange\("businessDate", ReportQuerySpec\.PredicatePlacement\.FACT\)/, "明细必须按事件业务日期在 FACT 层过滤");
contains(backend, /requiredDateRange\(\)[\s\S]*keywordColumns\([\s\S]*PredicatePlacement\.FACT/, "汇总必须绑定日期并在聚合前应用关键词");
contains(backend, /"partyId"::text \|\| ':' \|\| "currency" AS "rowKey"/, "客户供应商 UUID 加币种必须形成无碰撞稳定结果键");
contains(backend, /"businessDate" < \?[\s\S]*"businessDate" BETWEEN \? AND \?[\s\S]*"businessDate" <= \?/, "汇总必须按事件日期重建期初期间期末");
contains(backend, /totalGroupColumns\("currency"\)/, "rows/totals 必须按币种分组");
assert(occurrences(backend, '.totalGroupColumns("currency")') === 2, "明细与汇总 builder 必须各自按币种分组");
contains(backend, /enumEquals\([\s\S]*"currency"[\s\S]*"CNY"[\s\S]*"USD"/, "币种筛选只允许 CNY/USD");

for (const value of ["1877597.16", "13210.00", "1864387.16", "1414929.10", "15540.00", "1399389.1"]) {
  contains(test, new RegExp(value.replace(".", "\\.")), `测试必须锁定当前基线 ${value}`);
}
contains(test, /"USD"[\s\S]*"-20\.00"[\s\S]*"150\.00"[\s\S]*"25\.00"/, "测试必须覆盖 USD signed AR、退货冲减和待退款");
contains(test, /receivedSnapshot[\s\S]*returnOffsetSnapshot[\s\S]*paidSnapshot/, "测试必须放置错误快照诱饵证明报表不读取快照");
contains(test, /UPDATE [\s\S]*ar_receipt SET status = 'AUDITED'[\s\S]*ar_receipt SET status = 'DRAFT'/, "测试必须覆盖收款审核与反审核事件进出");
contains(test, /sales_return SET status = 'DRAFT'[\s\S]*sales_return SET status = 'AUDITED'/, "测试必须覆盖退货反审核与重新审核事件进出");
contains(test, /tenant_a150_a[\s\S]*tenant_a150_b[\s\S]*TENANT-B-DECOY/, "测试必须使用同库双 schema decoy 证明 tenant 隔离");
contains(test, /prepareExport\("receivable-summary"[\s\S]*artifact\.rowCount\(\)[\s\S]*doesNotContain\("TENANT-B-DECOY"/, "CSV 必须与页面同条件且排除跨 tenant decoy");
contains(test, /get\("closingBalance"\)\)\.isInstanceOf\(String\.class\)/, "API 金额必须在出站边界成为 decimal string");
contains(test, /assertCurrencyTotalsSeparated\(service\)/, "动态 PostgreSQL 验收必须执行双币种 totals 隔离断言");
contains(test, /receivable\.totals\(\)\)\.hasSize\(2\)[\s\S]*containsExactlyInAnyOrder\("CNY", "USD"\)[\s\S]*"CNY"\.equals[\s\S]*"1864387\.16"[\s\S]*"USD"\.equals[\s\S]*"730"/, "应收 totals 必须同时返回独立 CNY/USD 行且不生成跨币种总计");
contains(test, /payable\.totals\(\)\)\.hasSize\(2\)[\s\S]*containsExactlyInAnyOrder\("CNY", "USD"\)[\s\S]*"CNY"\.equals[\s\S]*"1399389\.1"[\s\S]*"USD"\.equals[\s\S]*"450"/, "应付 totals 必须同时返回独立 CNY/USD 行且不生成跨币种总计");

contains(frontend, /import type \{ ReportDefinition, ReportFilterDefinition \} from "\.\/reportTypes";/, "财务 definition 必须单向使用共享 ReportDefinition");
contains(frontend, /as const satisfies readonly ReportDefinition\[\];/, "财务 definition 必须由共享 ReportDefinition 静态校验且保留 literal key");
excludes(frontend, /reportRegistry|reportDefinitionForEntryId/, "财务 definition 不得反向依赖共享 registry");
contains(registry, /import \{ financeReportDefinitions \} from "\.\/financeReports";/, "共享 registry 必须 runtime import 财务 definition");
contains(
  registry,
  /const definitions[\s\S]*?inventoryMovementReport[\s\S]*?\.\.\.financeReportDefinitions/,
  "共享 registry 必须合并库存与财务 definitions，并允许既有销售领域保持注册"
);
const importGraph = assertReportImportGraph(rootDir);
assert(importGraph.checked, "A150 必须通过 A144 共享 report import graph 扫描");
assert(importGraph.domainConfigs.includes(frontendPath), "共享 import graph 必须识别财务领域 definition");
contains(frontend, /待退款金额/, "前端必须单独展示待退款金额");
contains(frontend, /options: \[[\s\S]*\{ value: "CNY", label: "CNY" \}[\s\S]*\{ value: "USD", label: "USD" \}/, "前端必须提供 CNY/USD 分币种筛选");
assert(occurrences(frontend, 'groupKeys: ["currency"]') === 4, "四个财务报表 footer 必须只按 currency 显示独立合计行");
for (const key of exactKeys) {
  excludes(catalog, new RegExp(`id:\\s*["']${key}["']`), `A150 不得在 A153 前发布 ${key} catalog 入口`);
}

mkdirSync(verificationDir, { recursive: true });
writeFileSync(
  resultPath,
  `${JSON.stringify({
    taskId: "A150",
    generatedAt: new Date().toISOString(),
    status: "PASS",
    assertions: checks.length,
    checks,
    files: [backendPath, testPath, frontendPath, registryPath, catalogPath],
  }, null, 2)}\n`,
  "utf8",
);

console.log(`A150 finance report regression PASS (${checks.length} assertions)`);
console.log(`evidence: ${path.relative(rootDir, resultPath)}`);
