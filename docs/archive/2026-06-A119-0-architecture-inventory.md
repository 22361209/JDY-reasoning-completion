---
status: historical
supersededBy: docs/guides/account-set-architecture.md
---

# A119-0 架构清单与迁移路线冻结（历史过程）

> A119 已完成。本文件保留迁移开始时的盘点，不是现行多账套规范。

本文是 A119-0 的交付物。它回答四个问题：

1. 哪些表属于平台层，哪些表属于账套业务层。
2. 哪些 API 是平台 API，哪些 API 必须走当前账套。
3. 哪些 SQL 入口是 A119 后续迁移的高风险点。
4. A119 采用独立 database 还是独立 schema。

证据脚本：

```bash
node scripts/a119-architecture-inventory.mjs
```

最新输出：

```text
verification/a119-0-architecture-inventory.json
Tables: 80; APIs: 35 controllers; SQL-risk files: 44
```

`verification/` 是临时证据目录，默认不进 Git；本文保留关键结论。

## 路线冻结

A119 采用 **独立 database 路线**：

```text
platform_db
tenant_bld_2026
tenant_test
tenant_history
```

理由：

- 与用户确认的长期目标一致。
- 按账套备份、恢复、复制到测试环境更直接。
- 比 schema 更不容易被误查询串账套。
- 小公司内部 ERP 不需要按账套启动多套应用容器，应用容器共享即可。

代价：

- 后端需要平台 DataSource + tenant DataSource 路由。
- 跨账套查询不能靠跨 schema join，必须走平台管理接口或专门管理查询。
- Flyway 初始化要区分 platform 迁移和 tenant 迁移。
- 不能继续依赖“单库里到处直接查表”的习惯。

若后续要改成 schema 路线，必须新开 ADR 或更新本文件，不能在实现过程中静默混用。

### A119-3 过渡补充

A119-3 实现采用 schema-first 过渡：平台表仍在 `public`，新账套先创建独立 `tenant_*` schema，`sys_account_set.database_name` 记录当前数据库，`schema_name` 指向 tenant schema。原因是当前 Flyway 迁移尚未拆成 platform/tenant 两套脚本；如果直接给新 tenant database 跑全量迁移，会把平台用户、权限、账套配置一起复制进去。

因此：长期目标仍是独立 tenant database；A119-3 只把“新建账套、初始化 tenant 结构、清空当前账套”先落成 schema 边界。等迁移脚本拆分后，再把 tenant schema 升级为 tenant database。详见 `docs/guides/a119-3-account-set-initialization.md`。

## 表归属清单

探针识别当前迁移中的表共 80 张。

| 归属 | 数量 | 当前已有 account_set_id | 说明 |
| --- | ---: | ---: | --- |
| platform | 8 | 1 | 用户、权限、账套、平台安全配置 |
| tenant-system | 7 | 1 | 编号、编辑锁、列表预设、日志、打印模板等账套内系统表 |
| tenant-business | 65 | 3 | 主数据、库存、销售、采购、生产、委外、财务业务表 |

当前只有 `document_number_sequence`、`inv_stock_balance`、`inv_stock_opening`、`inv_stock_txn` 这些 A117 范围表已经显式带账套字段。A119 不能继续用“给单表补 account_set_id”的方式推进；目标是把 tenant 表整体迁到对应 tenant database。

### Platform 表

这些表进入 `platform_db`。

| 表 | 说明 | A119 注意 |
| --- | --- | --- |
| `sys_account_set` | 账套配置 | 平台核心表，记录 tenant database/schema、附件前缀、Redis 前缀、初始化状态 |
| `sys_user` | 用户 | 当前有 `default_account_set_id`，拆平台后保留为默认账套引用，不代表用户属于某个 tenant |
| `sys_role` | 角色 | 平台角色/后续可扩账套内角色映射 |
| `sys_user_role` | 用户角色 | 平台授权入口 |
| `sys_permission` | 权限 | 平台权限定义 |
| `sys_permission_catalog` | 权限目录 | 平台权限展示 |
| `sys_password_reset_request` | 重置密码请求 | 平台安全能力 |
| `sys_setting` | 安全设置 | 第一版归平台；若后续出现账套级参数，另建 tenant 参数表 |

### Tenant-System 表

这些表进入每个 `tenant_*`，或者由平台表带明确 tenant key 后路由；A119 默认按进入 tenant database 处理。

| 表 | 说明 | A119 注意 |
| --- | --- | --- |
| `document_number_sequence` | 单据编号规则 | 已有 `account_set_id`，迁移后变为每个 tenant 内独立编号表 |
| `doc_edit_lock` | 单据编辑锁 | 必须账套隔离；切账套后旧锁不能影响新账套 |
| `sys_list_filter_preset` | 列表筛选/列设置预设 | 应按账套隔离，避免同名列表配置串账套 |
| `sys_operation_log` | 操作日志 | 必须记录账套，迁移后建议 tenant 内保留，平台侧只做跨账套审计索引 |
| `sys_outbox_event` | 本地事件 | tenant 内事件，不跨账套消费 |
| `sys_notification_outbox` | 通知 outbox | tenant 内通知；Redis/key/消息也要带账套前缀 |
| `sys_print_template` | 打印模板 | 第一版按账套隔离；后续如需共享模板，再增加平台模板复制机制 |

### Tenant-Business 表

这些表进入每个 `tenant_*`。当前大多数不带 `account_set_id`，迁移后通过数据库边界隔离。

| 模块 | 表 |
| --- | --- |
| masterdata | `md_product`, `md_customer`, `md_supplier`, `md_warehouse`, `md_product_category`, `md_unit`, `md_product_partner_code`, `md_production_department` |
| inventory | `inv_stock_balance`, `inv_stock_txn`, `inv_stock_opening`, `inv_safety_stock_setting`, `other_stock_in`, `other_stock_in_line`, `other_stock_out`, `other_stock_out_line`, `stock_count`, `stock_count_line`, `stock_count_gain`, `stock_count_gain_line`, `stock_count_loss`, `stock_count_loss_line`, `stock_transfer`, `stock_transfer_line` |
| sales | `sales_quote`, `sales_quote_line`, `sales_order`, `sales_order_line`, `delivery_notice`, `delivery_notice_line`, `sales_out`, `sales_out_line` |
| purchase | `purchase_requisition`, `purchase_requisition_line`, `purchase_order`, `purchase_order_line`, `purchase_in`, `purchase_in_line`, `purchase_return`, `purchase_return_line` |
| production | `prod_bom`, `prod_bom_line`, `production_plan`, `production_task`, `production_task_material_snapshot`, `production_material_issue`, `production_material_issue_line`, `production_completion`, `production_completion_line` |
| outsourcing | `outsourcing_work_order`, `outsourcing_work_order_line`, `outsourcing_work_order_component`, `outsourcing_material_issue`, `outsourcing_material_issue_line`, `outsourcing_receipt`, `outsourcing_receipt_line`, `outsourcing_return`, `outsourcing_return_line`, `outsourcing_scrap`, `outsourcing_scrap_line`, `outsourcing_surface_process` |
| finance | `ar_receivable`, `ar_receipt`, `ap_payable`, `ap_payment` |

## API 归属清单

当前后端识别 35 个 Controller，共 190 个 endpoint。

| 归属 | Controller 数 | Endpoint 数 | 说明 |
| --- | ---: | ---: | --- |
| platform | 5 | 18 | 用户、权限、安全、通知配置、健康检查 |
| platform-or-cross-tenant | 2 | 10 | 登录/session/账套切换/账套初始化等跨账套入口 |
| tenant-system | 4 | 19 | 编号、单据生命周期、编辑锁、列表预设 |
| tenant-business | 23 | 147 | 主数据、库存、销售、采购、生产、委外、财务、中心列表 |
| tenant-reporting | 1 | 6 | 打印、导出、报表型读取 |

### Platform / Cross-Tenant API

| Controller | 当前路径 | 归属 |
| --- | --- | --- |
| `SystemShellController` | `/api/system` | platform-or-cross-tenant |
| `AccountSetController` | `/api/system/account-sets` | platform-or-cross-tenant |
| `UserManagementController` | `/api/system` | platform |
| `RolePermissionController` | `/api/system` | platform |
| `SecuritySettingsController` | `/api/system/security-settings` | platform |
| `NotificationProviderSettingsController` | `/api/system/notification-provider-settings` | platform |
| `SystemHealthController` | `/api/system` | platform |

### Tenant-System API

| Controller | 当前路径 | A119 要求 |
| --- | --- | --- |
| `NumberingController` | `/api/numbering` | 按当前 tenant 取号和维护规则 |
| `BillLifecycleController` | `/api/document-lifecycle` | 所有状态动作只作用当前 tenant |
| `DocumentLockController` | `/api/document-locks` | 锁按 tenant 隔离 |
| `ListFilterPresetController` | `/api/list-presets` | 预设按 tenant 隔离 |

### Tenant-Business / Reporting API

这些 API 必须全部走当前 tenant 数据源：

- `MasterDataController`
- `ListStubController`：`/api/lists`，中心列表入口，A119 高风险。
- 库存：`OpeningStockController`、`InventoryAdjustmentController`、`OtherStockInController`、`OtherStockOutController`、`StockCount*Controller`、`StockTransferController`、`StockAlertSettingController`
- 销售：`SalesQuoteController`、`SalesOrderController`、`DeliveryNoticeController`、`SalesOutController`、`SalesPriceController`
- 采购：`PurchaseOrderController`、`PurchaseInController`、`PurchaseReturnController`
- 生产：`ProductionController`
- 委外：`OutsourcingController`
- 财务：`FinanceSettlementController`
- 报表/打印：`DocumentOutputController`

## SQL 风险清单

探针识别 44 个文件存在直接 SQL/JdbcTemplate 风险，合计约 451 次 SQL 调用、605 段 SQL 片段。

### 最高风险入口

| 风险 | 文件 | 原因 |
| --- | --- | --- |
| 中心列表 | `backend/src/main/java/com/jdy/erp/system/api/ListStubController.java` | `/api/lists` 聚合大量业务列表 SQL，且有动态表/列逻辑；A119-2/A119-4 必须优先路由到 tenant |
| 生命周期 | `backend/src/main/java/com/jdy/erp/shared/application/BillLifecycleService.java` | 通用审核、反审核、删除、关闭、冻结等动态表 SQL；若不走 tenant 会跨账套改状态 |
| 库存过账 | `backend/src/main/java/com/jdy/erp/inventory/application/InventoryPostingService.java` | 库存余额/流水核心写入；必须证明账套 A 审核不改账套 B 库存 |
| 编号 | `backend/src/main/java/com/jdy/erp/shared/application/NumberingService.java` | 当前已有 account_set_id，迁移后应改为 tenant 内独立编号或平台路由后写 tenant |
| 打印/导出 | `backend/src/main/java/com/jdy/erp/reports/api/DocumentOutputController.java` | 按单号读取各类业务单据，不能跨账套读取同号单据 |
| session/登录 | `backend/src/main/java/com/jdy/erp/system/security/CurrentSessionService.java` | 平台登录和账套上下文来源；A119-1/A119-2 的根入口 |
| 主数据动态表 | `backend/src/main/java/com/jdy/erp/masterdata/api/MasterDataController.java` | 多主数据共享动态表逻辑；A119-4 第一批迁移对象 |
| 委外链 | `backend/src/main/java/com/jdy/erp/outsourcing/application/OutsourcingDocumentAppService.java` | A118 新增链路，SQL 密集，后续委外迁移必须重点回归 |

### 模块 SQL 风险分布

| 模块 | 文件数 | SQL 调用数 |
| --- | ---: | ---: |
| system | 11 | 121 |
| production | 3 | 63 |
| inventory | 9 | 53 |
| shared | 7 | 51 |
| sales | 5 | 49 |
| outsourcing | 2 | 43 |
| purchase | 3 | 30 |
| reports | 1 | 17 |
| masterdata | 1 | 15 |
| finance | 2 | 9 |

## A119 后续迁移顺序

按 A119 计划保持以下顺序，不跳跃：

1. A119-1 平台层：先拆用户、账套、登录、权限入口。
2. A119-2 路由层：TenantContext、DataSource 路由、Redis/附件前缀、无账套阻断。
3. A119-3 初始化：新建账套、初始化、清空当前账套。
4. A119-4 业务迁移：主数据/BOM/编号 → 库存 → 销售 → 采购 → 生产 → 委外 → 报表。

每迁一个模块必须补至少一条两账套隔离断言，不等全量结束。

## A119-0 结论

- 当前 A117 是单数据库过渡，不是完整多账套。
- 业务表当前基本未按账套字段隔离；A119 长期应通过 tenant database 边界隔离，而不是继续补丁式塞 `account_set_id`。A119-3 在 Flyway 拆分前先用 tenant schema 作为过渡边界。
- A119 最危险的不是登录页，而是中心列表、生命周期服务、库存过账、编号、打印导出和模块 AppService 里的直接 SQL。
- A119-1 可以从平台表和平台 API 拆分开始；A119-2 必须先建 TenantContext/DataSource 路由，再进入 A119-4 业务表迁移。
