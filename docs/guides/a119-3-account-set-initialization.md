# A119-3 账套创建与初始化说明

本文记录 A119-3 的实现边界：新建账套、初始化 tenant 结构、清空当前账套业务数据，并证明不会影响其他账套。

## 路线说明

A119 长期目标仍是共享应用容器 + 平台层 + 账套数据隔离。A119-0 冻结的长期方向是 tenant database；但当前 Flyway 迁移尚未拆成 platform/tenant 两套脚本，如果直接给新 database 跑全量迁移，会把平台用户、权限、账套表也复制进去，反而形成假隔离。

所以 A119-3 采用 **schema-first 过渡实现**：

- 平台表仍在 `public` schema。
- 新账套创建独立 `tenant_*` schema。
- `sys_account_set.database_name` 先记录当前数据库，`schema_name` 指向 tenant schema。
- A119-4 继续按模块把业务 SQL 迁入默认路由数据源。
- 等 platform/tenant Flyway 脚本拆分完成后，再把 tenant schema 升级为独立 tenant database。

这不是放弃 database 路线，而是避免在迁移脚本未拆分时复制平台数据。

## 已落地

- 新增 `TenantSchemaProvisioner`：按 A119-0 表归属清单创建 tenant schema，并复制 tenant-system / tenant-business 表结构。
- 新增 `AccountSetManagementService`：平台侧创建账套、分配 schema、授权当前用户和管理员、记录平台操作日志。
- `/api/system/account-sets` 支持管理员新建账套。
- 账套设置页新增“新建账套”区域：账套编码、名称、环境、会计期间、业务期间。
- `AccountSetInitializationService` 改为平台表用 `platformJdbcTemplate`，业务清理用默认 routed `JdbcTemplate`。
- 初始化当前账套会先确保 tenant schema 存在，再清理当前 tenant 的业务表、分录表、库存流水、锁和列表预设，并重置当前 tenant 的编号流水。

## 默认种子数据

新 tenant schema 会初始化最小可用主数据：

- 物料类别：原材料、半成品、成品、包装辅料。
- 计量单位：PCS、KGS、个、条、箱。
- 仓库：默认仓库 `CK-001`。
- 生产部门：冲压车间 `CY`、焊接车间 `HJ`、金工车间 `JG`、安装车间 `AZ`、包装车间 `BZ`。

这些种子数据只保证新账套能进入工作台并开始建档，不代表业务资料已完备。

## 清空边界

初始化“当前账套”只清当前 tenant schema 内的数据：

- 清：销售、采购、库存、生产、委外、财务单据，表体/快照/库存余额/流水/编辑锁/列表预设/编号流水。
- 不清：平台用户、权限、账套配置、账套授权。
- 不跨账套：另一个 tenant schema 的同名表不会被清理。

## 测试证据

```bash
cd backend && JAVA_HOME=/opt/homebrew/opt/openjdk@21 ./mvnw -Dtest=AccountSetManagementServiceTest test
```

覆盖：

- 新建账套会创建 `tenant_*` schema。
- 新 schema 具备 `md_product`、`sales_order`、`document_number_sequence` 等 tenant 表。
- 新 schema 种入默认单位和默认仓库。
- 管理员自动获得新账套授权，并可登录该账套。
- 两个 tenant schema 同时写入业务数据后，初始化账套 A 只清 A，不影响账套 B。

## 后续边界

- A119-3 不迁移业务模块 SQL 语义，不修业务字段问题。
- A119-3 不实现跨数据库 Flyway 拆分。
- A119-4 开始按主数据/BOM/编号、库存、销售、采购、生产、委外、报表顺序逐模块迁移，并为每个模块补两账套隔离断言。
