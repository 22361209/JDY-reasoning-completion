#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { assertReportImportGraph } from "./helpers/report-import-graph.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const contract = readIfPresent("docs/12-当前批次验收清单.md");
const protocol = readIfPresent("docs/guides/report-query-protocol.md");
const spec = read("backend/src/main/java/com/jdy/erp/sales/application/SalesReportQuerySpec.java");
const test = read("backend/src/test/java/com/jdy/erp/sales/application/SalesReportQueryIntegrationTest.java");
const frontend = read("frontend/src/modules/reports/salesReports.ts");
const reportTypes = read("frontend/src/modules/reports/reportTypes.ts");
const reportRegistry = read("frontend/src/modules/reports/reportRegistry.ts");
const reportPage = read("frontend/src/components/report/ReportQueryPage.vue");
const inventoryFrontend = read("frontend/src/modules/reports/inventoryMovementReport.ts");
const catalog = read("frontend/src/modules/catalog.ts");
const checks = [];

function read(relativePath) {
  return readFileSync(path.join(rootDir, relativePath), "utf8");
}

function readIfPresent(relativePath) {
  const filePath = path.join(rootDir, relativePath);
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
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

if (contract.includes("F029")) {
  contains(contract, /F029[\s\S]*?销售明细、销售汇总和销售订单跟踪/, "A149 合同必须保持首版三张销售报表");
}
if (protocol) {
  contains(protocol, /`sales-detail`[\s\S]*?`sales-summary`[\s\S]*?`sales-order-tracking`/, "协议必须精确登记三个 F029 key");
  contains(protocol, /`sales_out\.status IN \('AUDITED','RED_REVERSED'\)`/, "协议必须保留有效销售出库状态");
  contains(protocol, /`sales_return\.status='AUDITED'`[\s\S]*?统一转为负数/, "协议必须冻结退货单次负向语义");
  contains(protocol, /executedQty=N\+D[\s\S]*?netDeliveredQty=O-R[\s\S]*?executedUnshippedQty=max/, "协议必须冻结 N/O/D/R 公式");
}

for (const key of ["sales-detail", "sales-summary", "sales-order-tracking"]) {
  contains(spec, new RegExp(`(?:ReportQuerySpec\\.builder|salesFactBuilder)\\(\\"${key}\\"`), `${key} 必须使用精确 registry definition`);
  contains(frontend, new RegExp(`reportKey: \\"${key}\\"`), `${key} 必须提供共享前端配置`);
}
contains(spec, /PERMISSION = "sales\.order\.audit"/, "三个销售报表必须复用 sales.order.audit");
contains(spec, /bill\.status IN \('AUDITED', 'RED_REVERSED'\)/, "销售出库必须纳入 AUDITED 与 legacy RED_REVERSED");
contains(spec, /line\.qty AS "qty"[\s\S]*?line\.amount AS "amount"[\s\S]*?line\.tax_amount AS "taxAmount"/, "销售出库必须保留行内 signed 数值");
contains(spec, /-line\.qty AS "qty"[\s\S]*?-line\.amount AS "amount"[\s\S]*?-line\.tax_amount AS "taxAmount"[\s\S]*?-line\.price_tax_total AS "priceTaxTotal"/, "销售退货必须只在共享事实层负向一次");
excludes(spec, /ABS\s*\(|Math\.abs|doubleValue\(|floatValue\(/i, "销售事实不得绝对值或浮点降精度");
contains(spec, /requiredDateRange\("billDate", PredicatePlacement\.FACT\)/, "日期必须在 fact 层进入聚合前过滤");
contains(spec, /keywordColumns\([\s\S]*?PredicatePlacement\.FACT/, "AND 多词 keyword 必须复用 fact predicate");
contains(spec, /FilterDefinition\.contains\("billNo", "billNo", PredicatePlacement\.FACT\)/, "单号过滤必须在 fact 层");
contains(spec, /enumEqualsDefault\([\s\S]*?"dimension"[\s\S]*?"CUSTOMER"[\s\S]*?"PRODUCT_UNIT"/, "sales-summary 必须默认 CUSTOMER 并限制两种维度");
contains(spec, /NULL::numeric AS "qty"[\s\S]*?WHERE \? = 'CUSTOMER'/, "客户汇总不得制造数量合计");
contains(spec, /jsonb_build_array\('CUSTOMER', "customerId", "currency"\)/, "客户汇总身份必须是客户加币种");
contains(spec, /MAX\("customerCode"\) AS "customerCode"[\s\S]*?MAX\("customerName"\) AS "customerName"[\s\S]*?GROUP BY "customerId", "currency"/, "客户显示名称不得进入汇总 identity tuple");
contains(spec, /jsonb_build_array\('PRODUCT_UNIT', "productId", "unit", "currency"\)/, "商品汇总身份必须是商品、单位快照和币种");
contains(spec, /GROUP BY "productId", "unit", "currency"/, "商品数量禁止跨单位或币种聚合");
contains(spec, /bindResultFilter\("dimension"\)[\s\S]*?bindResultFilter\("dimension"\)/, "固定 result 两分支必须绑定同一规范化 dimension");
contains(spec, /totalGroupColumns\("dimension", "currency"\)[\s\S]*?totalSum\("amount", "amount"\)[\s\S]*?totalSum\("taxAmount", "taxAmount"\)[\s\S]*?totalSum\("priceTaxTotal", "priceTaxTotal"\)/, "汇总金额 totals 必须按维度和币种分组");
excludes(spec, /totalSum\("qty", "qty"\)/, "汇总 totals 不得跨商品单位给出数量总计");
contains(spec, /'salesOut'::text AS "sourceTarget"[\s\S]*?bill\.bill_no AS "sourceBillNo"[\s\S]*?'salesReturn'::text AS "sourceTarget"[\s\S]*?bill\.bill_no AS "sourceBillNo"/, "销售明细钻取必须使用共享 salesOut/salesReturn target 与 sourceBillNo");
contains(spec, /'salesOrder'::text AS "sourceTarget"[\s\S]*?bill\.bill_no AS "sourceBillNo"/, "订单跟踪必须使用共享 salesOrder target 与 sourceBillNo");
excludes(spec, /sales-(?:out|return|order)-form/, "后端报表不得返回 UI tab id 作为钻取 target");

contains(spec, /WITH notice_qty AS[\s\S]*?out_qty AS[\s\S]*?return_qty AS/, "订单跟踪必须从真实通知、出库和退货聚合");
contains(spec, /bill\.status = 'AUDITED'[\s\S]*?line\.source_order_no IS NOT NULL[\s\S]*?line\.source_line_no IS NOT NULL/, "发货通知只允许已审核且有订单行 trace");
contains(spec, /sales_out_line line[\s\S]*?bill\.status IN \('AUDITED', 'RED_REVERSED'\)/, "订单 O 必须读取有效 signed 销售出库");
contains(spec, /EXISTS \([\s\S]*?delivery_notice_line notice_line[\s\S]*?notice_bill\.status = 'AUDITED'[\s\S]*?notice_line\.source_order_no = line\.source_order_no[\s\S]*?notice_line\.source_line_no = line\.source_line_no[\s\S]*?THEN 0 ELSE line\.qty END/, "D 必须只含未匹配同一订单行有效已审核通知的直接出库");
contains(spec, /sales_return_line return_line[\s\S]*?source_line\.id = return_line\.source_out_line_id/, "R 必须经 source_out_line_id 回溯订单行");
contains(spec, /"noticeQty" \+ "directOutQty" AS "executedQty"/, "executedQty 必须等于 N+D");
contains(spec, /"shippedQty" - "returnedQty" AS "netDeliveredQty"/, "netDeliveredQty 必须等于 O-R");
contains(spec, /GREATEST\("orderQty" - \("noticeQty" \+ "directOutQty"\), 0::numeric\)/, "unexecutedQty 必须只在派生值使用 max");
contains(spec, /GREATEST\(\("noticeQty" \+ "directOutQty"\) - "shippedQty", 0::numeric\)/, "executedUnshippedQty 必须等于 max(N+D-O,0)");
contains(spec, /"executedQty" > "orderQty"[\s\S]*?"shippedQty" > "executedQty"[\s\S]*?'INCONSISTENT'/, "原始超量与 shipped>executed 必须显式 INCONSISTENT");
contains(spec, /"legacyShippedCounter" = "shippedQty"[\s\S]*?'COUNTER_MISMATCH'/, "订单冗余 shipped counter 只能用于回归对账");
contains(spec, /WHEN "shippedQty" >= "orderQty" THEN 'FULLY_SHIPPED'/, "出库状态必须按 O 判定全部出库");
excludes(spec, /WHEN "netDeliveredQty" >= "orderQty" THEN 'FULLY_SHIPPED'/, "退货后的净交付量不得回退已发生的出库状态");
excludes(spec, /product_id\s*=.*qty|qty\s*=.*product_id/i, "订单跟踪不得按商品加数量猜配");
contains(spec, /CURRENT_TIMESTAMP AT TIME ZONE 'Asia\/Shanghai'/, "剩余发货天数必须使用 Asia/Shanghai 当前日期");

contains(frontend, /import type \{ ReportDefinition, ReportSourceDrillDefinition \} from "\.\/reportTypes"/, "销售配置必须单向复用共享 ReportDefinition 与钻取类型");
contains(frontend, /export const salesReportDefinitions: readonly ReportDefinition\[\]/, "销售配置必须直接实现共享 ReportDefinition");
contains(frontend, /options: currencies/, "前端必须显式支持 CNY 与 USD");
contains(frontend, /title: "含税金额"/, "销售可见文案必须使用含税金额");
contains(frontend, /targets: \["salesOut", "salesReturn"\][\s\S]*?targets: \["salesOrder"\]/, "销售钻取 target 必须由共享 typed contract 明确限制");
contains(frontend, /billNoField: "sourceBillNo"[\s\S]*?lineNoField: "lineNo"[\s\S]*?key: "sourceBillNo"/, "销售钻取必须显示可信 sourceBillNo 并把真实行号传给共享打开协议");
contains(frontend, /Decimal[\s\S]*?server[\s\S]*?never aggregates[\s\S]*?CNY and USD/i, "前端配置必须声明服务端 decimal、零浏览器聚合与不跨币种边界");
excludes(frontend, /reportRegistry|ReportQueryPage|useReportQuery|reportApi/, "销售领域配置不得反向依赖 registry 或共享 UI owner");

contains(reportTypes, /interface ReportSourceDrillDefinition[\s\S]*?targets: readonly ReportSourceTarget\[\][\s\S]*?trust\?: ReportSourceTrustDefinition/, "共享类型必须统一 target allowlist 与可选 trust rule");
contains(reportTypes, /interface ReportSourceTrustDefinition[\s\S]*?acceptedValues: readonly string\[\]/, "共享类型必须定义可审计 trust accepted values");
contains(inventoryFrontend, /sourceDrill:[\s\S]*?targets:[\s\S]*?"salesOut"[\s\S]*?trust:[\s\S]*?acceptedValues: \["EXACT"\]/, "库存报表必须把 EXACT 追溯要求放入共享 typed trust contract");
contains(reportPage, /props\.definition\.sourceDrill[\s\S]*?drill\.targets\.some[\s\S]*?drill\.trust\.acceptedValues\.includes/, "共享页面必须从 definition 读取 target/trust contract");
excludes(reportPage, /trustedSourceTargets|row\.traceQuality === "EXACT"/, "共享页面不得硬编码 target 集合或库存 EXACT 规则");
contains(reportRegistry, /import \{ salesReportDefinitions \} from "\.\/salesReports"/, "registry 必须 runtime import 销售领域 definitions");
contains(reportRegistry, /\[inventoryMovementReport, \.\.\.salesReportDefinitions\]/, "registry 必须显式汇总库存与销售 definitions");
excludes(frontend, /reportDefinitionForEntryId|isRegisteredReportEntry/, "销售领域配置不得反向 import reportRegistry");
const importGraph = assertReportImportGraph(rootDir);
assert(importGraph.checked && importGraph.domainConfigs.includes("frontend/src/modules/reports/salesReports.ts"), "A149 必须通过共享 report import graph 并覆盖销售配置");

contains(test, /containsEntry\("amount", "-30"\)/, "集成测试必须证明退货仅负向一次且 BigDecimal 出站为字符串");
contains(test, /containsEntry\("sourceTarget", "salesOut"\)[\s\S]*?containsEntry\("sourceTarget", "salesReturn"\)[\s\S]*?containsEntry\("sourceTarget", "salesOrder"\)/, "动态测试必须证明三个共享钻取 target 精确出站");
contains(test, /containsEntry\("currency", "CNY"\)[\s\S]*?containsEntry\("currency", "USD"\)/, "集成测试必须分别证明 CNY 与 USD totals");
contains(test, /containsEntry\("qty", "7"\)[\s\S]*?containsEntry\("qty", "5"\)/, "集成测试必须证明商品单位分组不混量");
contains(test, /noticeQty", "4"[\s\S]*?directOutQty", "2"[\s\S]*?executedQty", "6"[\s\S]*?returnedQty", "1"/, "集成测试必须证明 N/O/D/R 公式");
contains(test, /legacyShippedCounter", "999"[\s\S]*?counterReconciliation", "COUNTER_MISMATCH"/, "集成测试必须证明 shipped counter 不参与公式");
contains(test, /shippedQty", "10"[\s\S]*?returnedQty", "1"[\s\S]*?netDeliveredQty", "9"[\s\S]*?shipmentStatus", "FULLY_SHIPPED"/, "集成测试必须证明退货不回退已发生的全部出库状态");
contains(test, /createDetailSchema\(schemaA[\s\S]*?createDetailSchema\(schemaB[\s\S]*?TENANT-B-DECOY/, "集成测试必须放置同号跨 schema decoy");
contains(test, /executor\.export[\s\S]*?artifact\.rowCount\(\)[\s\S]*?artifact\.release/, "集成测试必须覆盖同条件 CSV 行数与受控清理");

for (const key of ["sales-detail", "sales-summary", "sales-order-tracking"]) {
  excludes(catalog, new RegExp(`id: ["']${key}["']`), `${key} 在 A153 双视口证据前不得发布 catalog`);
}

console.log(`A149 sales report regression passed (${checks.length} assertions).`);
