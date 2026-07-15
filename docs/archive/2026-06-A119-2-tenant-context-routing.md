---
status: historical
supersededBy: docs/guides/account-set-architecture.md
---

# A119-2 TenantContext 与数据路由说明（历史过程）

> A119 已完成。本文件保留中间路由阶段的边界，不是现行多账套规范。

本文件记录 A119-2 的实现边界。A119-2 只完成“统一上下文 + 路由底座”，不代表所有业务表已经物理迁入 `tenant_*` 数据库；业务模块迁移仍归 A119-4。

## 已落地

- `TenantContext`：请求级线程上下文，区分 `PLATFORM` 与 `TENANT`。
- `TenantContextInterceptor`：所有 `/api/**` 请求进入统一上下文。
  - 平台路径：登录、登出、session、账套列表、用户管理、权限管理、安全设置、通知设置。
  - 账套业务路径：销售、采购、库存、生产、委外、列表、编号、单据生命周期、打印导出等。
  - 业务路径未登录时后端返回 401，不允许在无账套上下文下继续路由。
- `TenantRoutingDataSource`：默认业务 `JdbcTemplate` 走路由数据源；当前上下文为租户时，按账套 `database_name/schema_name` 创建并缓存租户连接池；无上下文或平台上下文走平台数据源。
- `platformJdbcTemplate` / `platformTransactionManager`：会话、权限、用户管理等平台数据显式使用平台连接，避免业务租户上下文误查平台表。
- `TenantResourceLocator`：Redis key 和附件路径统一由当前上下文生成前缀，禁止后续模块裸拼 key/path。

## 测试证据

- `TenantContextInterceptorTest`
  - 平台路径未登录可进入平台上下文。
  - 业务路径未登录被 401 阻断。
  - 业务路径登录后可生成租户上下文，并产出账套级 Redis key / 附件路径前缀。
- `TenantRoutingDataSourceBoundaryTest`
  - 测试中创建临时 schema。
  - `TenantContext` 指向该 schema 后，默认业务 `JdbcTemplate` 查询到的 `current_schema()` 为临时 schema。
  - 切回平台上下文后，默认业务 `JdbcTemplate` 回到 `public`。

## 当前边界

- A119-2 不迁移业务表，不改业务 SQL 语义。
- A119-2 暂不创建真实 `tenant_*` database；测试以临时 schema 验证路由边界，因为本地开发库已能证明路由层按 `schema_name` 切换连接。
- `sys_account_set`、用户、角色、权限、登录/安全设置仍在平台侧。
- 当前业务数据仍在历史单库表中，A119-4 会按模块逐步迁移并补隔离断言。
- Spring Session 仍是平台登录态，不承载业务缓存；业务 Redis key 必须通过 `TenantResourceLocator.redisKey(...)` 生成。
- 物料附件当前仍在数据库字段内，未来文件服务/对象存储落地时必须通过 `TenantResourceLocator.attachmentPath(...)` 生成账套路径。

## 后续接口使用规则

- 平台能力需要平台数据时，注入 `@Qualifier("platformJdbcTemplate") JdbcTemplate`。
- 平台写事务使用 `@Transactional(transactionManager = "platformTransactionManager")`。
- 业务模块继续注入默认 `JdbcTemplate`，由 `TenantContext` 自动路由。
- 新增业务 API 时不得把路径加进平台白名单，除非该接口确实只读/写平台库。
- 新增 Redis key 或附件路径时不得手写账套前缀，必须走 `TenantResourceLocator`。
