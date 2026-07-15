# 文档导航

本目录按“现行决策优先、当前任务优先、历史可追溯但不冒充现行”组织。当前完成度只由机器真相源、交接快照和当前任务包共同说明。

## 开工与当前状态

| 需要回答的问题 | 读取位置 |
| --- | --- |
| 当前在做什么、下一步是什么 | [`09-交接清单.md`](09-交接清单.md) |
| 本任务能改什么、如何验收、何时停止 | [`12-当前批次验收清单.md`](12-当前批次验收清单.md) |
| 项目定位与接手顺序 | [`00-项目接手指南.md`](00-项目接手指南.md) |
| 执行预算、最小上下文与提交纪律 | [`../AGENTS.md`](../AGENTS.md)、[`guides/codex-execution-policy.md`](guides/codex-execution-policy.md) |
| 范围、交付状态、回归归属 | `config/effective-feature-scope.json`、`config/feature-delivery-status.json`、`config/regression-manifest.json` |

## 现行产品与工程规则

### 所有实现改动必读

1. [`04-架构决策记录.md`](04-架构决策记录.md)：长期技术与产品决策。
2. [`08-工程规范.md`](08-工程规范.md)：代码分层、生成物、测试与文档边界。
3. [`07-模块契约与边界.md`](07-模块契约与边界.md)：跨模块、tenant、身份、权限和事实域边界。

### 按改动类型追加阅读

| 改动类型 | 必读现行规范 |
| --- | --- |
| 页面、列表、表格、选择器、单据外壳 | [`10-前端体验与视觉规范.md`](10-前端体验与视觉规范.md)、[`guides/bld-page-unification-protocol.md`](guides/bld-page-unification-protocol.md) |
| 保存、审核、反审核、作废、关闭、冻结、红冲 | [`guides/bill-lifecycle-unification-protocol.md`](guides/bill-lifecycle-unification-protocol.md)、[`guides/action-button-rules.md`](guides/action-button-rules.md) |
| 按钮可见、可用、权限或危险确认 | [`guides/action-button-rules.md`](guides/action-button-rules.md) |
| 列表查询、筛选、分页、导出 | [`13-列表API契约.md`](13-列表API契约.md)、[`guides/list-query-unification-protocol.md`](guides/list-query-unification-protocol.md) |
| 报表、合计、CSV、钻取 | [`guides/report-query-protocol.md`](guides/report-query-protocol.md) |
| 基础资料导入 | [`guides/master-data-import-protocol.md`](guides/master-data-import-protocol.md) |
| 跨模块业务口径 | [`guides/business-rules.md`](guides/business-rules.md) |

| 主题 | 文档 |
| --- | --- |
| 架构决策、产品化优先级 | [`04-架构决策记录.md`](04-架构决策记录.md) |
| 当前系统架构与 tenant 边界 | [`05-系统架构说明.md`](05-系统架构说明.md)、[`guides/account-set-architecture.md`](guides/account-set-architecture.md) |
| 数据一致性与库存 | [`06-数据一致性与库存原则.md`](06-数据一致性与库存原则.md) |
| 模块、身份、权限、资金与导入边界 | [`07-模块契约与边界.md`](07-模块契约与边界.md) |
| 工程规范与生成物边界 | [`08-工程规范.md`](08-工程规范.md)、[`guides/repository-map.md`](guides/repository-map.md) |
| 前端体验与验收门禁 | [`10-前端体验与视觉规范.md`](10-前端体验与视觉规范.md)、[`11-验收标准与测试门禁.md`](11-验收标准与测试门禁.md) |
| 列表 API 与业务/动作规则 | [`13-列表API契约.md`](13-列表API契约.md)、[`guides/business-rules.md`](guides/business-rules.md)、[`guides/action-button-rules.md`](guides/action-button-rules.md) |
| 本地开发、启动与故障恢复 | [`guides/local-development.md`](guides/local-development.md) |

## 历史、证据与生成物

- [`验收报告/`](验收报告/)：已关闭任务的可追溯验收证据；先读其 [`README.md`](验收报告/README.md)，不将报告当作当前任务或当前完成度。
- [`archive/`](archive/)：历史任务合同、历史队列与已替换文档。
- `archive/2026-06-核心流稳定化追踪.md`：已归档的 2026-06 稳定化队列，不维护当前状态。
- `01-审批结果复刻范围.md`、`02-第一版模块边界.md`、`03-开发执行顺序.md`：范围生成物，禁止手改；其中保留的复刻/阶段措辞属于审批时期记录，不覆盖 ADR-015、当前交接快照或当前任务包。
- `archive/2026-06-A119-*`、`archive/2026-06-new-project-migration-blueprint.md` 与 `archive/2026-06-bill-metadata-roadmap.md`：历史迁移过程与路线方案，保留背景但不作为当前默认路线。

JDY 调研资料只在具体任务需要术语、交互或视觉参考时读取；它不替代本目录的现行规则。

修改现行文档或验收报告目录后，运行 `node scripts/docs-governance-check.mjs`；该门禁不替代业务或浏览器回归。
