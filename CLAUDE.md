# CLAUDE.md — JDY 推理补完（实现层）

本仓库是 `JDY-复刻-local`（/Users/linzhenyue/Projects/JDY-复刻-local）的**落地实现**。
规格（做什么/长什么样/怎么交互/95%验收）以 `复刻-local/02_复刻规划` + `01_金蝶调研/截图` 为准，本仓库不复述，只指向。

## 铁律（不可违反）

1. **规格不复述**：页面/组件/交互/文案/像素以 复刻-local 为准；本仓库只管实现层。
2. **只缓存登录态**：库存/可用量/单据列表/审核状态/应收应付/资金/报表一律不缓存，直查数据库。
3. **库存双写**：`inv_stock_txn` 流水 + `inv_stock_balance` 余额，同一事务写入；扣减用行级约束（`qty_available >= :qty`）+ 乐观锁 `version`，不靠前端提示。
4. **审核才动账**：单据保存只产生草稿；审核才扣/补库存、生成应收应付。第一版**单人单级直接审核**，状态机 `草稿→已审核→已反审核`，不耦合审批流引擎。反审核必须查下游单据。
5. **不跨模块改表**：模块间走应用服务或领域事件；业务规则放 application/domain，不写在 Controller 或前端。
6. **前台95%/后台可桩**：成本核算、期末关账、网络控制、打印落地等深水区，第一版先做界面/交互/状态/扩展点，真实写入后置。
7. **第一版不上微服务、不上 MQ**：模块化单体 + outbox 本地事件；前端必须产品化，不用后台管理页冒充。

详见 `docs/06`（数据一致性）、`docs/04`（ADR）、`docs/07`（模块契约）。

## 开工协议（廉价起步，省 token）

每个任务自包含，**只读这几样，不要重读全部 docs**：

1. `docs/09-交接清单.md`（当前快照）
2. 目标入口的 复刻-local 截图 + 对应 B 批次组件规格（`复刻-local/02_复刻规划/首版页面实现批次与组件复用矩阵-1880收口版.md`）
3. 本任务相关代码文件

- 新接手、不熟目录、或不确定规则放在哪里时，读 `docs/guides/repository-map.md`；业务规则和动作按钮规则也从该文件跳转。
- 改功能、逻辑、规则、机制或动作前，先扫是否已有复用点：`docs/guides/*`（规则口径）、`scripts/helpers/*`（回归动作）、`frontend/src/components` 与模块 composable（产品范式）。能复用先复用；需要新机制时先沉淀共享层，再改具体入口。
- 执行范围以生成物 `config/effective-feature-scope.json` 为准；它必须且只能由原始审批快照 `config/approved-feature-scope.json` + 手维护 `config/implementation-overrides.json` 推导，别手改生成物或擅自扩范围。
- 验收 = 业务逻辑门禁（`docs/11`）+ 对照截图的视觉相似度。
- 收尾覆盖更新 `docs/09` 快照。

## 分层回归门禁（A111 起）

回归入口统一用：

```bash
node scripts/run-regression-tier.mjs smoke
node scripts/run-regression-tier.mjs area:sales
node scripts/run-regression-tier.mjs full
```

结果统一写入 `verification/regression-tier-<tier>-latest.json`。smoke / area / full 清单统一来自受版本控制的 `config/regression-manifest.json`；`area:<module>` 会自动包含 smoke。新增、删除或豁免回归脚本必须在同一提交更新 manifest，不得再从 ignored `verification/` 读取清单。

每批按改动性质选档：

| 改动分类 | 例子 | 必跑 |
| --- | --- | --- |
| 表现改动 | 共享 UI 的 CSS、布局、密度、列宽、图标、文案、品牌 | `smoke` + 人工眼验/截图核对；不必全量行为回归 |
| 行为改动 | 业务逻辑、SQL、过账、状态机、金额、库存、财务 | `smoke` + 对应 `area:<module>` |
| 共享核心逻辑 | `BillLifecycle`、`PostingPipeline`、库存账、税、预留 | `full` + 后端快测 |

后端快测兜底核心行为：生命周期状态转换、库存/财务过账、税额计算、发货通知预留不变式。后续不要把所有行为校验继续压到慢 Playwright。

## 注意（生成产物会回滚，别手改）

生成链：`xlsx → export-approved-scope.mjs → approved 原始快照`；`approved + implementation-overrides → effective 执行快照 + docs/01/02/03 → generate-frontend-scope.mjs`；退役中的静态工作台仍按需单独运行 `build-app-data.mjs`

| 文件 | 由谁生成 | 规则 |
| --- | --- | --- |
| `outputs/.../JDY复刻功能审批表.xlsx` | `build-jdy-feature-approval.mjs` | ⚠️ **绝不要重跑此脚本**。它只生成「空白审批模板」，会抹掉用户手填的「你的审批」列并静默改范围。脚本已加防覆盖闸（FORCE_REGEN=1 才覆盖）。该脚本视为退役。 |
| `config/approved-feature-scope.json` | `export-approved-scope.mjs`（只读 xlsx 原始审批） | 生成物，别手改；它是原始审批快照，不应用 overrides |
| `config/effective-feature-scope.json` | 共享 scope 推导 helper（读 approved + implementation-overrides） | 生成物，别手改；正式执行范围和前端生成都以此推导结果为准 |
| `docs/01 / 02 / 03` | `export-approved-scope.mjs`（读 approved + implementation-overrides 的有效结果） | 生成物，改要改脚本模板/overrides 再 `node export-approved-scope.mjs` |
| `app/feature-data.js` | `build-app-data.mjs` | 生成物，别手改 |
| `frontend/src/app/featureScope.ts` | `generate-frontend-scope.mjs` | ⚠️ 在 frontend 源码树里但是**生成物**；脚本同时刷新 effective scope，开工后别手改，改 overrides 再重跑 |

- 范围的实施例外（如某功能后置）走 `config/implementation-overrides.json`，然后按顺序重跑：
  1. `node export-approved-scope.mjs`（更新 effective scope 与 `docs/01/02/03`；xlsx 未变时保留原始审批快照时间）
  2. `node generate-frontend-scope.mjs`（按同一共享推导刷新 effective scope 与正式前端 `frontend/src/app/featureScope.ts`）
  3. `node scripts/effective-scope-contract-check.mjs`（确认 effective scope 与两个输入逐字节一致）
  4. 可选：`node build-app-data.mjs`（更新退役中的静态范围工作台 `app/feature-data.js`）
- 绝不重跑 `build-jdy-feature-approval.mjs`，除非明确要用 `FORCE_REGEN=1` 重建空白审批模板。
- 手维护安全文件：`docs/00/04/05/06/07/08/09/10/11`、`README.md`、`CLAUDE.md`、`config/implementation-overrides.json`、`config/feature-delivery-status.json`、`config/regression-manifest.json` 和相关生成/门禁脚本。`config/effective-feature-scope.json` 仍是生成物，不在手维护清单内。
