# JDY 推理补完 ERP

本项目以已采集的金蝶云星辰/JDY 调研资料和用户审批后的功能范围为基础，建设面向控制臂/摆臂工厂的可运行 ERP。项目已完成复刻骨架，当前目标转为持续完善本项目的业务闭环、数据正确性、安全性、可用性和可维护性；不追求金蝶云星辰的全量或逐页复制。

> **仓库定位**：本仓库是 `JDY-复刻-local`（/Users/linzhenyue/Projects/JDY-复刻-local）的**落地实现**。
> JDY 资料是业务术语、信息架构、常用流程、关键交互和视觉基线的高优先级参考；用户已确认的业务决策和本仓库的架构、安全、数据一致性规范优先于参考资料。
> 本仓库负责产品实现与演进。新增功能必须说明其对当前 ERP 的业务价值，不能仅以“JDY 存在该功能”为理由扩张范围；有意差异需记录原因并验收。
> 详见 `docs/00-项目接手指南.md`、`docs/04-架构决策记录.md` 与 `AGENTS.md`。

## 当前阶段

- 正式工程已经落地为 `Java 21 + Spring Boot 模块化单体 + Vue 3 + PostgreSQL + Redis`，销售、采购、库存、生产、委外、多账套等已有不同程度实现；实际完成度不能再由菜单或历史批次推断。
- 项目已建立防偏移治理基线：有效范围、A0-A4 交付状态和 smoke/area/full 回归清单均为可机器校验的版本控制产物；具体当前批次不在 README 固化。
- 阻断整改与 P0 收口的长期顺序、边界和硬退出条件由 `config/remediation-roadmap.json` 保存；它不记录当前完成度，当前位置仍由交接快照和当前任务包表达。
- 当前实时状态、已知失败和唯一下一步以 `docs/09-交接清单.md` 为准；当前任务允许路径、明确不做事项和验收门禁以 `docs/12-当前批次验收清单.md` 为准。

## 快速入口

| 文件 | 用途 |
| --- | --- |
| `docs/00-项目接手指南.md` | 新接手者第一份必读文件 |
| `docs/01-审批结果复刻范围.md` | 用户审批后的功能范围 |
| `docs/02-第一版模块边界.md` | 按模块拆分的保留/可选/后置/不做 |
| `docs/03-开发执行顺序.md` | 推荐开发阶段 |
| `docs/04-架构决策记录.md` | 技术栈、缓存、微服务预留等关键决策 |
| `docs/05-系统架构说明.md` | 后端、前端、数据库、模块关系 |
| `docs/06-数据一致性与库存原则.md` | 库存、单据、资金一致性底线 |
| `docs/07-模块契约与边界.md` | 模块之间如何调用，避免未来拆不动 |
| `docs/08-工程规范.md` | 命名、代码分层、测试、文档规范 |
| `docs/09-交接清单.md` | 每次交接和阶段收尾必须更新的内容 |
| `docs/10-前端体验与视觉规范.md` | 金蝶式产品前台的视觉、交互和手感标准 |
| `docs/11-验收标准与测试门禁.md` | 功能、数据、前端体验和交接验收标准 |
| `docs/12-当前批次验收清单.md` | 唯一当前任务包，随批次覆盖更新并在换批时归档 |
| `docs/12-本地开发启动说明.md` | 本地启动 PostgreSQL、Redis、后端和前端 |
| `config/approved-feature-scope.json` | Excel 原始审批快照，生成物，不应用实施 override |
| `config/implementation-overrides.json` | 唯一人工范围差异入口 |
| `config/effective-feature-scope.json` | 原始审批与 override 推导出的当前有效范围，生成物 |
| `config/feature-delivery-status.json` | 按 scope ID 记录 A0-A4、能力、证据和已知缺口 |
| `config/remediation-roadmap.json` | 0–6、6A–6E 的长期整改顺序、边界和硬退出条件 |
| `config/regression-manifest.json` | 受版本控制的 smoke / area / full 回归清单 |
| `outputs/jdy-feature-approval/JDY复刻功能审批表.xlsx` | 用户填写过的审批 Excel |

## 静态范围工作台

当前已有一个静态页面用于查看审批后的功能范围：

```bash
cd "/Users/linzhenyue/Projects/JDY 推理补完/app"
python3 -m http.server 5088 --bind 127.0.0.1
```

打开：

```text
http://127.0.0.1:5088/
```

该页面只是范围工作台，不是正式 ERP 前端。

## 核心原则

- 不再按金蝶云星辰全量功能开发，按用户审批范围开发。
- 第一版使用模块化单体，不上微服务，但保留未来拆服务可能。
- 只缓存登录态，不缓存库存、单据、资金等业务结果。
- 库存、资金、单据状态以数据库事务为准。
- UI 不能使用传统后台管理页替代产品前台；正式前端需要做金蝶式多页签、列表、单据、选择器和复杂表格体验。
- 前端体验必须按 `docs/10-前端体验与视觉规范.md` 验收；页面完成不等于接口可用，必须看截图、点流程、查状态。
- JDY 是产品参考基线而不是唯一需求来源；安全、数据一致性、tenant 隔离、权限和可维护性可以且应当优先于像素级一致。

## 正式工程骨架

| 目录 | 说明 |
| --- | --- |
| `backend/` | Spring Boot 3.5.15 + Java 21 模块化单体 |
| `frontend/` | Vue 3 + TypeScript 产品前台 |
| `infra/` | PostgreSQL 和 Redis 本地开发依赖 |

## 仓库边界

本仓库定位为落地实现仓库，长期只保留代码、必要脚本、架构文档、验收报告和少量精选证据。金蝶原始采集资料、批量截图、临时 Playwright 产物、大体积对照素材应放在调研/资料仓库或本地资料目录，不和实现代码混提交。

验证运行产物默认写入 `verification/`，该目录按本地临时产物处理，不进入 Git。需要长期保留的验收截图，应随验收报告归档到 `docs/验收报告/` 下的稳定路径。

## 本地一键启动

```bash
./scripts/dev-up.sh
```

脚本会自动启动 PostgreSQL/Redis、本地后端和前端；已在运行时不会重复启动。访问 `http://127.0.0.1:5173/`，账号 `admin`，密码 `admin123`。

常用配套命令：

```bash
./scripts/dev-status.sh
./scripts/dev-down.sh
```

日志默认写入 `verification/logs/`。

## 项目门禁

治理与清单检查不需要启动浏览器：

```bash
node scripts/effective-scope-contract-check.mjs
node scripts/feature-delivery-status-scan.mjs
node scripts/validate-regression-manifest.mjs
node scripts/run-regression-tier.mjs full --list
```

行为回归仍按改动类型执行 `smoke`、`area:<module>` 或 `full`。运行结果写入 ignored `verification/`，验收结论写入 `docs/验收报告/`；不得再用 ignored 文件充当 full 的清单来源。
