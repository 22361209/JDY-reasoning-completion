# 仓库文件地图与协作说明

本文件给接手者回答三个问题：文件在哪里、哪些能改、做完怎么验。最高优先级仍以 `CLAUDE.md` 为准。

## 开工先读

1. `CLAUDE.md`：铁律、生成链、禁止事项。
2. `docs/09-交接清单.md`：当前批次、服务地址、最近测试和下一步。
3. `docs/12-当前批次验收清单.md`：当前批次验收项和批次坐标。
4. 当前任务涉及的代码文件与对应 `复刻-local` 截图/规格。

不要每次重读全部文档；按任务读取相关文件。

## 改动前复用检查

改功能、逻辑、规则、机制或动作前，先扫已有复用点：

- 规则口径：`docs/guides/business-rules.md`、`docs/guides/action-button-rules.md`
- 单据/主数据字段与动作元数据路线：`docs/guides/bill-metadata-roadmap.md`
- 多账套/初始化边界：`docs/guides/account-set-architecture.md`
- A119 完整多账套迁移计划与 A119-0 清单：`docs/guides/a119-multi-account-migration-plan.md`、`docs/guides/a119-0-architecture-inventory.md`
- 新项目孵化/迁移决策：`docs/guides/new-project-migration-blueprint.md`
- 回归动作：`scripts/helpers/`
- 前端产品范式：`frontend/src/components/`、对应 `frontend/src/modules/**/use*.ts`
- 后端业务规则：对应模块的 `application/`、`domain/`

原则：能复用先复用；复用点不够时先扩共享层，再改具体入口和脚本。不要把同一按钮、同一弹窗、同一保存/审核流程复制到多份脚本里。

回归脚本分层约定：

- `scripts/helpers/document-actions.mjs`：保存、审核、新增、危险动作确认等通用单据动作。
- `scripts/helpers/entry-table-actions.mjs`：分录表行级操作。
- `scripts/helpers/sales-pages.mjs`：销售链页面对象，如打开销售订单列表、打开销售出库新单、选择发货通知源单、读取销售出库分录。
- 新脚本优先表达业务意图；除非脚本本身就在测试某个按钮/弹窗细节，否则不要直接散写 `getByTestId(...).click()`。

共享表格复用点：

- `frontend/src/components/table/TableCore.vue`：列表/分录共同的原生表格框架、列宽计算、横滚、列宽拖曳热区。
- `frontend/src/components/table/TableCoreHeaderCell.vue`：列头文字、筛选按钮、批量填充按钮、列头拖拽入口的统一渲染。
- `frontend/src/components/table/useColumnReorder.ts`：列表/分录共同的列顺序拖拽机制。普通业务列默认可拖；`locked` 或 `reorderable: false` 的系统列/关键列不可拖。以后新增业务列不要额外写拖拽逻辑，只有确实需要锁定时才声明不可拖。
- 业务模块页不要直接使用 `TableCore`。单据页外壳以 `StandardDocument` 为准，分录表以 `EntryTable` 或同层专用分录组件为准；`TableCore` 只作为这些共享组件内部实现细节。

## 目录地图

| 路径 | 作用 | 注意事项 |
| --- | --- | --- |
| `backend/` | Java Spring Boot 后端 | Maven wrapper 在 `backend/mvnw`，因为 `pom.xml` 也在 `backend/` |
| `backend/src/main/java/com/jdy/erp/**/controller` | HTTP API 层 | 不写业务规则，只做请求入口和返回 |
| `backend/src/main/java/com/jdy/erp/**/application` | 应用服务 | 单据保存、审核、删除、状态机编排优先放这里 |
| `backend/src/main/java/com/jdy/erp/**/domain` | 领域规则 | 可复用业务判断、状态规则放这里 |
| `backend/src/main/resources/db/migration` | Flyway 迁移 | 表结构变更必须进迁移，不手工改库后失踪 |
| `frontend/` | Vue 3 前端 | 正式产品前端，不用后台管理页冒充 |
| `frontend/src/app` | 应用外壳、全局模型 | `featureScope.ts` 是生成物，不能手改 |
| `frontend/src/components` | 共享组件 | 表格、单据、弹窗等复用能力优先沉淀到这里 |
| `frontend/src/modules` | 逐入口业务模块 | 新入口应尽量是“共享范式 + 少量入口配置/逻辑” |
| `frontend/src/services` | 前端 API 客户端 | 保持接口契约清晰，不写页面状态 |
| `frontend/src/styles` | 全局样式和共享视觉规范 | 表格密度、按钮、输入框等尽量共享 |
| `scripts/` | 生成链、开发脚本、回归脚本 | 不重跑 `build-jdy-feature-approval.mjs` |
| `scripts/helpers/` | 回归脚本共享辅助 | 新交互不要复制粘贴到每个脚本 |
| `docs/` | 手维护文档和生成文档 | `docs/01/02/03` 是生成物，别手改 |
| `docs/验收报告/` | 已完成批次报告 | 根目录不要散落验收报告 |
| `config/` | 审批范围和实施例外 | 改范围例外走 `implementation-overrides.json` |
| `outputs/` | 用户审批 Excel 输入 | 路径被生成脚本依赖，不改名 |
| `verification/` | 本地临时验证产物 | 默认不进 Git，长期证据写入验收报告 |

## 生成物边界

禁止手改：

- `config/approved-feature-scope.json`
- `docs/01-审批结果复刻范围.md`
- `docs/02-第一版模块边界.md`
- `docs/03-开发执行顺序.md`
- `frontend/src/app/featureScope.ts`
- `app/feature-data.js`

范围例外只改 `config/implementation-overrides.json`，再按 `CLAUDE.md` 的生成链重跑。绝不重跑退役的 `build-jdy-feature-approval.mjs`。

## 规则入口

| 主题 | 文件 |
| --- | --- |
| 架构决策 | `docs/04-架构决策记录.md` |
| 系统架构 | `docs/05-系统架构说明.md` |
| 库存和一致性 | `docs/06-数据一致性与库存原则.md` |
| 模块边界 | `docs/07-模块契约与边界.md` |
| 工程规范 | `docs/08-工程规范.md` |
| 前端视觉/手感 | `docs/10-前端体验与视觉规范.md` |
| 验收门禁 | `docs/11-验收标准与测试门禁.md` |
| 列表 API | `docs/13-列表API契约.md` |
| 业务规则 | `docs/guides/business-rules.md` |
| 动作按钮规则 | `docs/guides/action-button-rules.md` |
| 单据/主数据元数据路线 | `docs/guides/bill-metadata-roadmap.md` |
| 多账套与初始化 | `docs/guides/account-set-architecture.md` |
| A119 多账套迁移计划 | `docs/guides/a119-multi-account-migration-plan.md` |
| A119-0 架构清单 | `docs/guides/a119-0-architecture-inventory.md` |
| 新项目迁移蓝图 | `docs/guides/new-project-migration-blueprint.md` |

## 常用命令

```bash
./scripts/dev-up.sh
./scripts/dev-status.sh
./scripts/dev-down.sh
npm --prefix frontend run build
./scripts/backend-test.sh
node scripts/run-regression-tier.mjs smoke
node scripts/run-regression-tier.mjs area:sales
node scripts/run-regression-tier.mjs full
```

## 测试选择

- 纯视觉/密度/样式：`smoke` + 浏览器眼验。
- 单据业务、按钮状态、SQL、状态机：`smoke` + 对应 `area:<module>`。
- 库存、资金、生命周期、共享核心服务：`full` + 后端测试。
- 带登录态的 Playwright 脚本不要手工并行跑；正式回归用 `run-regression-tier.mjs` 顺序调度，避免单一会话/跨标签登录策略互相抢状态。

回归结果写入 `verification/`，关键结论写进 `docs/验收报告/`。

## 收尾要求

- 写清楚是否改过库存、资金、审核、权限等高风险逻辑。
- 写清楚跑过哪些测试，失败项不能藏。
- 更新 `docs/09-交接清单.md` 的当前快照。
- 需要长期保存的截图和结论归档到验收报告，不依赖临时 `verification/`。
