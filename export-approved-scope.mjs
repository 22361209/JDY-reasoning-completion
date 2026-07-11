import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import {
  deriveEffectiveFeatureScope,
  readJsonFile,
  reconcileApprovedFeatureIds,
  writeEffectiveFeatureScope,
} from "./scripts/helpers/effective-feature-scope.mjs";

const rootDir = import.meta.dirname;
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const unknownArgs = args.filter((arg) => arg !== "--dry-run");
if (unknownArgs.length > 0) {
  throw new Error(`未知参数：${unknownArgs.join(", ")}。仅支持 --dry-run。`);
}
const workbookPath = path.join(rootDir, "outputs/jdy-feature-approval/JDY复刻功能审批表.xlsx");
const approvedScopePath = path.join(rootDir, "config/approved-feature-scope.json");
const implementationOverridesPath = path.join(rootDir, "config/implementation-overrides.json");
const effectiveScopePath = path.join(rootDir, "config/effective-feature-scope.json");
const input = await FileBlob.load(workbookPath);
const workbook = await SpreadsheetFile.importXlsx(input);
const sheet = workbook.worksheets.getItem("功能审批");
const values = sheet.getUsedRange().values;
const headers = values[0];
const requiredHeaders = [
  "模块",
  "功能",
  "功能说明",
  "我的建议",
  "你的审批",
  "优先级",
  "建议版本",
  "备注",
  "推理补完方式",
];
const missingHeaders = requiredHeaders.filter((header) => !headers.includes(header));
if (missingHeaders.length > 0) {
  throw new Error(`功能审批工作表缺少列：${missingHeaders.join(", ")}`);
}
const duplicateHeaders = headers.filter((header, index) => (
  header && headers.indexOf(header) !== index
));
if (duplicateHeaders.length > 0) {
  throw new Error(`功能审批工作表存在重复列：${[...new Set(duplicateHeaders)].join(", ")}`);
}

const records = values
  .slice(1)
  .filter((row) => row[0] && row[1])
  .map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])));

const approvalRank = {
  "要": "build",
  "简单版": "simple",
  "后面重点做": "build",
  "可选": "optional",
  "后面再说": "later",
  "不要": "exclude",
  "大概率不要": "exclude",
  "不建议做": "exclude",
};

const implementationOverrides = await readJsonFile(implementationOverridesPath, "实施 overrides");

const candidateFeatures = records.map((item) => ({
  module: item["模块"],
  feature: item["功能"],
  description: item["功能说明"],
  recommendation: item["我的建议"],
  approval: item["你的审批"] || item["我的建议"],
  decision: approvalRank[item["你的审批"]] || approvalRank[item["我的建议"]] || "conditional",
  priority: item["优先级"],
  targetVersion: item["建议版本"],
  note: item["备注"],
  inferenceMode: item["推理补完方式"],
}));

// 现有 approved scope 是 F ID 的身份注册表；没有它就不允许按行号静默重建 ID。
const existingApprovedScope = await readJsonFile(approvedScopePath, "现有原始审批范围");
const normalized = reconcileApprovedFeatureIds({
  existingFeatures: existingApprovedScope.features,
  candidateFeatures,
});
const approvedScopeChanged = (
  JSON.stringify(existingApprovedScope.features) !== JSON.stringify(normalized)
);
const approvedScope = approvedScopeChanged
  ? {
      ...existingApprovedScope,
      source: existingApprovedScope.source ?? workbookPath,
      generatedAt: new Date().toISOString(),
      features: normalized,
    }
  : existingApprovedScope;

const effectiveScope = deriveEffectiveFeatureScope({
  approvedScope,
  implementationOverrides,
});
const implementationFeatures = effectiveScope.features;

const byDecision = normalized.reduce((acc, item) => {
  acc[item.decision] ||= [];
  acc[item.decision].push(item);
  return acc;
}, {});

const byModule = implementationFeatures.reduce((acc, item) => {
  acc[item.module] ||= [];
  acc[item.module].push(item);
  return acc;
}, {});

const retained = implementationFeatures.filter((item) =>
  item.decision === "build" ||
  item.decision === "simple" ||
  (item.decision === "optional" && item.targetVersion === "第一版")
);
const later = implementationFeatures.filter((item) => item.decision === "later" || item.decision === "optional");
const excluded = implementationFeatures.filter((item) => item.decision === "exclude");
const overrideLater = implementationFeatures.filter((item) => item.originalDecision !== item.decision && item.decision === "later");

if (!dryRun) {
  await fs.writeFile(
    approvedScopePath,
    `${JSON.stringify(approvedScope, null, 2)}\n`,
  );
  await writeEffectiveFeatureScope(effectiveScopePath, effectiveScope);
}

function featureList(items) {
  return items.map((item) => `- ${item.module} / ${item.feature}: ${item.approval} (${item.priority}, ${item.targetVersion})`).join("\n");
}

function scopeFeatureList(items) {
  return items
    .map((item) => {
      const suffix = item.originalDecision !== item.decision
        ? `；原始审批：${item.originalApproval}，实施解释：${item.note}`
        : "";
      return `- ${item.module} / ${item.feature}: ${item.approval} (${item.priority}, ${item.targetVersion}${suffix})`;
    })
    .join("\n");
}

const scopeMd = `# JDY 推理补完复刻范围

来源：\`${workbookPath}\`

> 本文是审批后的**范围过滤**：决定 \`JDY-复刻-local\` 调研的 277 个入口里实际要建哪些。
> 功能外观、页面布局、交互行为、文案口径、像素级验收一律以 \`JDY-复刻-local/02_复刻规划\` 为准，本文不复述。

## 审批结果总览

| 决策 | 数量 | 含义 |
| --- | ---: | --- |
| 要 / 后面重点做 | ${byDecision.build?.length ?? 0} | 纳入复刻范围，按已采证据和可验证推理补完实现 |
| 简单版 | ${byDecision.simple?.length ?? 0} | 做可用主流程，不追求金蝶全量边界 |
| 可选 | ${byDecision.optional?.length ?? 0} | 保留为可启用扩展点，默认不阻塞第一阶段 |
| 后面再说 | ${byDecision.later?.length ?? 0} | 后置，不作为当前开发阻塞项 |
| 不要 / 大概率不要 | ${byDecision.exclude?.length ?? 0} | 从当前复刻范围剔除 |

注：上表数量来自用户 Excel 原始审批。后文可能额外列出“审批为要、但因架构依赖实施后置”的例外项，例如 BOM 成本查询。

## 审批后保留范围

本节表示用户审批后需要保留在产品路线里的功能，不等于全部都在第一版一次性交付。具体上线顺序以 \`docs/03-开发执行顺序.md\` 为准。

${scopeFeatureList(retained)}

## 后置或可选范围

本节包含两类：用户原始审批为后置/可选的功能，以及审批为“要”但因第一版技术或业务依赖不足而实施后置的例外项。

${scopeFeatureList(later)}

## 明确剔除范围

${scopeFeatureList(excluded)}
`;

if (!dryRun) {
  await fs.writeFile(path.join(rootDir, "docs/01-审批结果复刻范围.md"), scopeMd);
}

const moduleMd = `# 审批后模块边界

本文档按你的审批结果组织，不再追求 100% 金蝶云星辰功能。

说明：\`做\` 表示产品路线中保留并计划实现，不代表全部在第一版一次性交付；每项实际版本仍以括号中的 \`第一版/第二版/后续\` 和 \`docs/03-开发执行顺序.md\` 为准。

本表只表达**审批后的范围过滤**（建 / 可选 / 后置 / 不做）。页面布局、组件、交互行为、文案口径、像素级验收以 \`JDY-复刻-local/02_复刻规划\`（组件复用矩阵、交互组件复刻规范、像素级布局复刻规格、字段字典、业务术语与文案口径）为准，本文不复述外观与交互。

${Object.entries(byModule)
  .map(([module, items]) => {
    const build = items.filter((item) => item.decision === "build" || item.decision === "simple");
    const optional = items.filter((item) => item.decision === "optional");
    const laterItems = items.filter((item) => item.decision === "later");
    const excludeItems = items.filter((item) => item.decision === "exclude");
    return `## ${module}

### 做
${featureList(build) || "- 无"}

### 可选
${featureList(optional) || "- 无"}

### 后置
${featureList(laterItems) || "- 无"}

### 不做
${featureList(excludeItems) || "- 无"}`;
  })
  .join("\n\n")}
`;

if (!dryRun) {
  await fs.writeFile(path.join(rootDir, "docs/02-第一版模块边界.md"), moduleMd);
}

const devPlanMd = `# 开发执行顺序

## 口径

- 本仓库是 \`JDY-复刻-local\` 的落地实现。开发批次、页面范式、组件、验收**以 \`JDY-复刻-local/02_复刻规划\` 为准**，本文只做实现层补充，不复述规格。
- 执行批次采用 复刻-local 的 **B0-B6**，详见 \`JDY-复刻-local/02_复刻规划/首版页面实现批次与组件复用矩阵-1880收口版.md\`。
- 范围过滤（建哪些入口）见 \`docs/01-审批结果复刻范围.md\` + \`config/effective-feature-scope.json\`；原始审批快照仍保留在 \`config/approved-feature-scope.json\`。
- 架构与数据底线见 \`docs/04\`、\`docs/06\`、\`docs/07\`。

## 批次落地顺序（对齐 复刻-local 实现顺序）

1. **B0 页面外壳 / B1 高密度列表 / B3 选择器与分录**：先固化全局范式（外壳、导航、页签、列表、选择器），否则后续单据反复返工。
2. **B2 单据新增/详情**：用销售订单 → 采购订单 → 生产任务/领料/产品入库 做单据引擎样板。这条同时是第一条纵向库存/资金闭环（采购入库增库存+应付 → 销售出库扣库存+应收 → 收付款核销）。
3. **B4 查询报表**：库存、销售、采购、应收应付统一到查询范式。
4. **B5 成本/期间页面族**：前台页面、状态、日志、检查、风险提示照复刻；真实成本写入、关账推进后置（对齐 复刻-local 风险 RA-04/RA-05/RB-07）。
5. **B6 设置/权限/工作流**：先建模型与入口，落地实效后置。

## 实现层口径

- **前台 95% 复刻，后台深水区可先桩**：成本核算、期末关账、网络控制、打印落地等先做界面/交互/状态/扩展点，真实写入按专项或点状补证触发再做。
- 数据权限、全局搜索入口预留，完整能力按 P2 实施。
- 库存/资金/审核底线见 \`docs/06\`；模块边界与跨模块调用见 \`docs/07\`。
${overrideLater.length ? `
## 实施后置例外（来自 config/implementation-overrides.json）

${overrideLater.map((item) => `- ${item.module} / ${item.feature}：${item.note}`).join("\n")}
` : ""}`;

if (!dryRun) {
  await fs.writeFile(path.join(rootDir, "docs/03-开发执行顺序.md"), devPlanMd);
}

console.log(JSON.stringify({
  dryRun,
  approvedScopeChanged,
  total: normalized.length,
  build: byDecision.build?.length ?? 0,
  simple: byDecision.simple?.length ?? 0,
  optional: byDecision.optional?.length ?? 0,
  later: byDecision.later?.length ?? 0,
  exclude: byDecision.exclude?.length ?? 0,
}, null, 2));
