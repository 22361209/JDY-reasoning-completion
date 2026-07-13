# 验收报告：A137 Tenant Schema 约束与结构一致性

## 基本信息

- 验收日期：2026-07-13
- 开工基线：`bf931e1ad42d7c968fce9703e775846967546c89`
- 当前分支：`codex/review-cleanup-20260627`
- 路线坐标：问题 4“tenant schema 没有外键”
- 目标等级：A4
- 范围：现有及新建 tenant 的列、PK、UK、FK、CHECK 一致性，schema 唯一登记，备份恢复兼容与 fail-closed
- 范围外：item 5 主数据 PATCH、item 6 未知列表、6A–6E 业务功能

## 结论

**A137 达到 A4，路线问题 4 已关闭。**

- 两个现有 tenant 均由同一版本化计划同步为 72 张受管表、PK 72、UK 64、有效 FK 153、CHECK 11；列与参考约束漂移、未验证 FK、退役税字段及禁止的 4 个 `sys_account_set` FK 均为 0。
- 新建 tenant 与存量 tenant 共用 `jdy_sync_tenant_schema`；存量同步不能补造缺失 schema/表，新建同步不能收编已存在 schema。
- 非 public schema 名规范化后只能登记给一个账套；重复登记在迁移时 fail-closed，运行期创建返回 409 且不产生半截账套或授权。
- 用户授权的 7 条 A136 自动化孤儿行已在完整隔离后精确删除；当前 public 与两个 tenant 的盘点行缺父单、缺物料和 A136 marker 残留均为 0。
- restore 在清空目标数据前验证全部 71 张可恢复受管表和必填列，按版本化父子拓扑与显式共同列恢复，不再依赖 `CASCADE` 或 `SELECT *`。
- backend `167/167`、A119 8 suites、A137 14 项 topology、`area:system 15/15`、smoke `10/10` 通过；full 没有新增失败。

## 用户授权与 7 条孤儿处理

只读预检在 `tenant_a119ops_49f5546b.stock_count_line` 发现 7 行，每行同时缺少 `stock_count` 父单和 `md_product` 父记录。所有行都带 `A136_ACTOR_*` marker，且在当前 tenant、public 和另一 tenant 都不存在可恢复父记录。

处理顺序与边界如下：

1. 先把 7 行全部字段保存到 ignored `verification/a137-orphan-quarantine.json`；文件 SHA-256 为 `05770f1904017b7485a45ea411d0d3d4a6d9dd21eea05b8af0d215167c72e995`。
2. 用户于 2026-07-13 明确确认“按建议删除”。授权只覆盖清单中的 7 个 UUID，不构成未知孤儿的通用删除授权。
3. V98 对每行精确校验 `(id, line_remark, product_code_snapshot, bill_id, product_id)` 五字段完整 tuple，并确认盘点父单与物料父记录仍缺失；精确匹配数不是 0 或 7、任一字段变化、实际删除数不等于匹配数时迁移停止。
4. 修复 A136 清理脚本，使其先删 `stock_count_line` 再删父单与物料，并把明细残留纳入 cleanup 断言，防止同类夹具再次产生孤儿。

迁移与回归后，public、`tenant_a119ops_49f5546b`、`tenant_a119ui` 三个 schema 的 `stock_count_line` 缺父单、缺物料和 `A136_ACTOR_%` 行均为 0。

## V98 版本化同步计划

V98 文件：`backend/src/main/resources/db/migration/V98__tenant_schema_constraint_parity.sql`。

- Flyway 11.7.2 installed/source checksum：`1143207774`
- 源文件 SHA-256：`c8fea70ac33b3f24c077b77c48f9c502bfa0f7d988a6002fb818b03313690a02`
- 当前库 installed rank：96，success：true

V99 文件：`backend/src/main/resources/db/migration/V99__tenant_schema_exemption_runtime_guard.sql`。

- Flyway 11.7.2 installed/source checksum：`-1144028933`
- 源文件 SHA-256：`aa1628b6776e00b1ce5fe6546d24c833ad27347a505d1d1db50720ddb9fd33a7`
- 当前库 installed rank：97，success：true

V98 在本地未发布阶段因独立 review 修正精确删除守卫，先生成当前库完整备份 `verification/backups/a137-before-final-v98-repair-20260713.dump`（SHA-256 `5892c9b795ccd593498be9df5ab96961296a0a11610b023850baa13bdb65c2e6`），再在 V97 克隆和 empty fresh 验证最终迁移，最后只使用 Flyway 11.7.2 官方 `repair` 更新当前 V98 checksum并正式 `migrate` V99；没有手工编辑 `flyway_schema_history`。

V98 新增版本化 `sys_tenant_managed_table`，72 张表按父表先于子表的 `restore_order` 排列。同步函数以 public 受管表为唯一参考，处理并验证：

- 缺列的类型、默认值、NULL、identity/generated 语义；类型漂移和未知额外数据列不猜测转换，直接失败。
- PK、UK、CHECK 的名称及语义；已有名称碰撞但语义不同会失败。
- FK 创建前的父表拓扑、列映射、match/update/delete 行为与全量孤儿预检；所有 FK 最终必须 validated。
- tenant 业务父表指向同一 tenant，真实平台父表显式指向 public。
- A119 已固定的四个派生作用域 UUID 列不引用 `public.sys_account_set`：`document_number_sequence.account_set_id`、`inv_stock_balance.account_set_id`、`inv_stock_opening.account_set_id`、`inv_stock_txn.account_set_id`。V98 在迁移期同时验证精确形状数与所有保留名称数均为 4；V99 在每次同步前再次验证，其他表冒用同名约束会 fail-closed。
- `production_plan.status` 默认值对齐 `DRAFT`，后续迁移缺失列补齐，7 个已退役且无待保留值的 `is_tax_inclusive` 列按显式清单移除。

两个现有 tenant 的最终指标完全相同：

| 指标 | 结果 |
| --- | ---: |
| 受管表 | 72 |
| PK | 72 |
| UK | 64 |
| 有效 FK | 153 |
| CHECK | 11 |
| 未验证 FK | 0 |
| 列漂移 | 0 |
| 参考约束漂移 | 0 |
| 退役税字段 | 0 |
| 禁止的 `sys_account_set` FK | 0 |

两个 tenant 连续执行两次 `create_missing=FALSE`，返回值均为 72，schema 与逐表数据指纹前后完全不变。

## 新建账套、唯一登记与恢复

- `TenantSchemaProvisioner` 不再维护第二份 Java 表清单；现有 schema 使用 `create_missing=FALSE`，新建 schema 使用 `create_missing=TRUE`，两者共用 V98 计划。
- 新建账套在写入前检查重复 code、重复非 public schema 登记和未登记但已存在的 schema；数据库唯一索引承担并发最终门禁。
- `create_missing=TRUE` 只允许创建不存在且只有一条注册记录的安全 schema；重复调用或试图收编已有 schema 均失败。
- 备份恢复表清单来自同一 `restore_order`。restore 先检查目标与备份中的全部 71 张可恢复表，再检查目标必填列是否在备份存在，之后才执行无 `CASCADE` 的统一 TRUNCATE。
- 回插显式列出目标与备份共同列，因此旧备份缺少后来新增的可选列时使用目标默认值，备份中已退役的额外列被忽略。
- 实测旧备份删除 `md_product_category.remark`、增加已退役 `sales_order.is_tax_inclusive` 后可恢复；随后删除备份 `md_unit`，恢复在目标数据清空前失败，已存在业务行保持不变。

备份动作仍逐表运行在默认 `READ COMMITTED` 下；高并发写入期间可能形成跨表非同一时点快照。这是已有备份一致性模型的非阻断残余风险，不影响本批 restore 的事务原子性与约束闭环。

## 迁移与失败拓扑

A137 专项覆盖并通过 14 项运行时 topology：

- 新建临时 tenant 立即达到 72/64/153/11；
- 冒用四个保留 FK 名称中的任意一个，runtime guard 按 `reserved_names=5 exact=4` 拒绝；
- 缺 schema、缺表、unsafe schema、未登记 schema；
- 重复 schema 登记、重复 `create_missing=TRUE`；
- 列类型漂移、未知额外列、额外约束、FK 孤儿；
- 修复后拓扑与重复 `create_missing=FALSE`。

运行时专项之外，另以官方 Flyway 对 empty database 1→V99、V97 备份→V98/V99 和当前库 repair→V99 三条迁移拓扑做人工编排验收；三库均为 97 条成功 history，V98/V99 checksum 相同，core 函数哈希 `549a52d1f6167a147b68c595a6875792`、wrapper 哈希 `d70c482692f1010855d4917900c668b3` 完全一致。迁移前重复 schema 登记拓扑保持 fail-closed。

所有应拒绝拓扑均整笔回滚。FK、UK、CHECK 非法写入均被数据库拒绝；同一 tenant 的重复业务码被拒绝，两个 tenant 使用相同业务码允许且互不串数据。专项临时 schema、账套、客户和非法行清理计数均为 0；fresh、upgrade 和 duplicate 临时数据库在保存证据后删除。

## 自动化结果

| 门禁 | 结果 | 结论 |
| --- | ---: | --- |
| backend Maven 全测试 | 167/167，fail 0，error 0，skip 0 | 通过 |
| A137 相关 Java 测试 | 10/10 | 通过 |
| A119 双账套隔离 | 8 suites | 通过 |
| A137 专项 | 14 runtime topology，cleanup 全 0 | 通过 |
| Flyway 迁移拓扑 | empty fresh、V97 upgrade、current repair；三库函数哈希一致 | 通过；人工编排证据 |
| A136 复跑 | cleanup 全 0 | 通过 |
| regression manifest | discovered 134、full 113、smoke 10、system membership 5、exemptions 21 | 通过 |
| feature delivery status scan | 当前路线 item 4 | 通过 |
| area:system | 15/15、skip 0 | 通过 |
| smoke | 10/10、skip 0 | 通过 |
| full | 107/113、skip 0 | 达到冻结门槛，无新增失败 |
| `git diff --check` | 通过 | 无空白错误 |

full 的 6 个失败精确为 A32、A38、A63、A101、A116、A118，均为 A137 之前登记的冻结债务。runner 因这些合同内失败返回 exit 1；验收依据是 `badCount=6`、`skipped=0` 且失败集合完全匹配，不描述为全绿。

## 独立 review

独立只读 review 先发现 2 个 P1，修复并复跑全部门禁后最终 APPROVE，无剩余 P0/P1：

- 原孤儿删除使用 SQL pattern，`_` 可被解释成通配且只校验前缀；现改为隔离证据中的 7 组五字段完整 tuple，同一 UUID 的任一 marker、snapshot 或父 ID 改变都会停止。
- 原同步核心仅按全局 constraint name 排除四项豁免；现由 V98 的 exact/reserved 双计数守住迁移期，V99 每次调用前复验 child/name/parent/column 完整形状，冒名 FK 专项已通过。
- schema 唯一登记、四项精确 FK 豁免和 72/64/153/11 强门禁一致；
- 新建/既有 schema 分流，无隐式收编或补造既有结构；
- 残缺备份在 TRUNCATE 前失败，旧备份按共同列恢复，restore 顺序符合 FK 拓扑；
- A137 专项、当前库指标和清理结果与合同一致。

非阻断残余风险与范围边界：

- 逐表备份运行在 `READ COMMITTED`，高并发写入时不是跨表同一时点快照；tenant schema 或其 `sys_operation_log` 自身损坏时，恢复失败日志也可能覆盖原异常。数据路径仍 fail-closed。
- V99 校验与核心函数调用之间不锁 public DDL；项目迁移在应用启动前串行执行、运行时不并发修改受管 public DDL。在该既定前提下不阻断；若以后开放在线 DDL，应为 72 张受管表增加 DDL 锁。
- 五个主数据 `system_no` 默认值仍共享 public sequence；两个 tenant 各少 6 个 public 非唯一索引，且 public 的 18 个快照触发器未复制到 tenant。本批硬退出只覆盖列与 PK/UK/FK/CHECK，不把这些描述为“完整 DDL/所有编号一致”；应另立架构任务处理。
- restore 已覆盖缺整表、旧备份缺可选列和已退役额外列，尚未单独注入“备份缺无默认必填列”；生产代码会在 TRUNCATE 前显式拒绝，该分支可在后续恢复专项补自动化。

## 独立提交

1. `a07582af` `docs(a137): define tenant constraint parity contract`
2. `49d6e109` `fix(tenant): synchronize versioned schema constraints`
3. `2f3e619b` `test(tenant): add A137 constraint and isolation regression`
4. `8733999b` `fix(tenant): harden schema exemption guards`
5. `f28626a3` `test(tenant): cover exact migration guard topology`
6. 本报告所在提交 `docs(a137): close tenant constraint remediation`

合同、生产实现、自动化与验收闭环按可独立审查和回退的边界拆分；运行产物与数据库 dump 保持 ignored，不进入提交。

## 下一步

1. A137 提交后保持不 push，除非用户明确要求。
2. 按 predecessor 顺序建立 A138/item 5“主数据稀疏更新/PATCH”合同；四类主数据以 absent 保留、显式 null 清空可空字段、version CAS 和审核状态门禁为核心。
3. A32/A38/A63/A101/A116/A118 保持各自独立债务，不在 item 5 顺带修改。
