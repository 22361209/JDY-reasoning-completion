# 列表 API 契约

本文件约束 B1 之后所有高密度列表页的查询接口。列表查询不是页面局部功能，而是 `DataListPage`、列表定义、后端查询服务、导出和回归脚本共同遵守的协议。后续接真实业务表时不得另起一套。

## 请求

统一路径：

```http
GET /api/lists/{listKey}
```

`listKey` 不是自由格式字符串。查询与引出只接受 `ListQueryContractRegistry` 显式登记的完整 key；`*-master-list` 和 `*-source-selector` 后缀只能用于已登记 key 的分类，不构成通配认可。

列表引出：

```http
GET /api/lists/{listKey}/export.csv
```

引出接口复用列表查询参数，导出应用筛选和排序后的结果集，不只导出当前页。

统一参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | string | 否 | 全局关键字，按列表定义的 `searchFields` 覆盖主要可搜索字段；空白分词后按“多词 AND、字段内 OR”匹配。 |
| `status` | string | 否 | 已废弃的状态快速筛选，仅为旧链接和旧预设短期兼容；新前端不得生成该参数，状态筛选必须写入 `columnFilters.status`。 |
| `page` | number | 否 | 当前页，从 `1` 开始。 |
| `pageSize` | number | 否 | 每页条数，前端固定提供 `200/500/1000`。 |
| `view` | `header`/`detail` | 否 | 单据列表视图，默认 `header` 整单视图；`detail` 为明细视图，每行一条分录并带单头字段。 |
| `sortField` | string | 否 | 排序字段，必须是当前列表已知字段。 |
| `sortOrder` | `asc`/`desc` | 否 | 排序方向，默认 `asc`。 |
| `columnFilters` | JSON string | 否 | 列过滤条件，字段名到过滤规则的映射。 |
| `dateFrom` | date | 否 | 通用日期范围起点，作用到列表定义的 `dateField`；无 `dateField` 的列表忽略该参数。 |
| `dateTo` | date | 否 | 通用日期范围终点，作用到列表定义的 `dateField`；无 `dateField` 的列表忽略该参数。 |
| `module` | string | 否 | 操作日志专用，模块代码。 |
| `action` | string | 否 | 操作日志专用，动作代码。 |
| `operator` | string | 否 | 操作日志专用，操作人包含匹配。 |
| `targetType` | string | 否 | 操作日志专用，对象类型精确匹配。 |
| `snapshotToken` | string | 否 | 仅服务端显式声明快照分页的内部选择器使用；第一页不传，续页必须原样回传第一页签发的不透明标识。普通列表和导出不得自行生成。 |

`keyword` 分词规则：

- 使用半角空格、全角空格、制表符、换行等空白字符分词。
- 连续空白忽略。
- 每个词都必须命中至少一个 `searchFields` 字段。
- 一个词命中多个字段中的任意一个即可。
- `view=header` 可以搜索明细字段，但返回仍必须是整单行。命中规则由列表契约声明为 `headerMatch=existsLine`，后端用明细 `EXISTS`/join 参与搜索，不把明细列塞进整单返回结构。
- 第一版不提供页面级 `OR` 语法；后续如需精确短语，必须扩展本契约，不允许页面私写解析规则。

`columnFilters` 示例：

```json
{
  "customer": { "operator": "包含", "value": "广州" },
  "status": { "operator": "等于", "value": "已审核" }
}
```

状态、关闭状态、冻结状态等生命周期展示字段只允许通过 `columnFilters` 查询。查询结果不会改变动作可用性；列表批量动作和详情动作仍以 `documentLifecyclePolicy.ts` 与后端 `BillLifecyclePolicy` 为准。

操作符固定为：

```text
包含、不包含、等于、不等于、以……开始、以……结束、为空、不为空
```

## 响应

```json
{
  "page": 1,
  "pageSize": 200,
  "sortField": "billNo",
  "sortOrder": "asc",
  "total": 1200,
  "snapshotToken": "opaque-server-token",
  "rows": []
}
```

约束：

- `rows` 只返回当前页数据。
- `total` 是应用所有查询条件后的总数。
- 单据列表 `view=header` 时返回一张单据一行；若关键字命中分录字段，只显示命中的单据，不展开明细行。
- 单据列表 `view=detail` 时，后端直查单头 join 分录，只读返回，不缓存；列筛选、分页和导出继续复用同一列表契约。
- 列表引出必须应用同一组 `keyword`、`dateFrom/dateTo`、`columnFilters`、排序参数，导出筛选后的全集。
- 无权限返回 `403`，前端显示无权限态。
- 未登记 `listKey` 的查询和引出均返回 `404`；必须先判定 key 已登记，再做列表专属权限和数据访问。
- 服务异常返回非 `2xx`，前端显示错误态并提供重试。
- 查询无结果返回 `200` 且 `rows=[]`、`total=0`，前端显示空态。
- 声明快照分页的选择器必须在第一页返回 `snapshotToken`。续页缺少标识，或 tenant、查询条件、页大小、排序及候选全集任一发生变化时返回 `409`，且不得返回部分页；前端必须丢弃已经拼接的行并从第一页重试。

`404` 与 `200` 空集的语义不可混用：前者表示列表未登记，后者表示已登记列表在当前条件下没有数据。未知 key 不得返回销售订单列、销售单号或伪空集。

## 列表定义元数据

新列表必须登记以下元数据，不能在页面组件里另写筛选规则：

| 字段 | 说明 |
| --- | --- |
| `searchFields` | `keyword` 覆盖的字段；为空时退回当前列表可见字段，但新列表不得依赖退回行为。 |
| `dateField` | 快捷日期和任意日期范围作用字段，通常为 `billDate`、`operatedAt`、`createdAt`。 |
| `supportsQuickDateFilter` | 是否显示“常用过滤条件”和“日期范围”。 |
| `defaultDateRange` | 可选默认日期范围，当前默认不启用。 |
| `lifecycleColumns` | 生命周期展示列，如 `status`、`closeStatusLabel`、`frozenStatusLabel`；仅用于展示和列筛选，不作为按钮能力来源。 |
| `lineMatchPolicy` | 整单/明细视图如何命中分录；整单视图可声明 `exists`，明细视图声明 `join`，主数据类为 `row`。旧文档中的 `headerMatch=existsLine` 等价于 `lineMatchPolicy=exists` + `returnShape=header`。 |
| `returnShape` | 命中后返回整单还是明细；整单视图必须返回 `header`，不能因命中分录而展开行。 |
| `adapterKey` | 后端 adapter 名称，如 `default`、`salesOrder`；禁止 Controller 通过 `listKey` 自行分支。 |

普通列表筛选区统一由 `DataListPage` 渲染。新增列表不得复制顶部状态下拉、只读日期筛选或私有查询栏；特殊列表扩展字段必须先写入本契约。

## 后端查询层

后端必须通过统一查询层执行列表读取和导出：

```text
Controller -> ListQueryService -> ListQueryContractRegistry -> ListQueryAdapter
```

要求：

- Controller 只收参和返回，不写列表搜索规则。
- 现有 `ListStubStateGuard` 首先委托 `ListQueryContractRegistry` 校验完整 key；未知 key 在列表专属权限、adapter/provider 选择和 JDBC 之前中止。
- `ListQueryService` 负责分词、旧 `status` 兼容、日期、列筛选、排序、分页和导出复用，并按契约选择 adapter。
- `ListQueryContractRegistry` 是列表搜索字段、日期字段、生命周期列和视图语义的唯一后端登记处。
- `ListQueryAdapter` 负责把契约映射到真实 SQL 或 stub 数据。已接库业务列表必须优先把关键字、日期、状态等高选择性条件下推到数据库。
- adapter/provider 的 default 分支也必须 fail-fast，不得在前置门禁失效时回退销售订单行或未知 selector 空集。
- 同一次请求只能生成一次查询计划，不能为搜索字段、日期字段和结果集重复读取 `seedRows`。
- 导出接口必须调用同一查询服务，只改变分页策略为“筛选后全集”。

### 入口与契约一致性

- 每个可见且可查询的 catalog 入口必须同时具有：唯一 delivery-status owner、前端 `ListDefinition`、后端精确 contract、adapter/provider 处置和明确权限。
- 内部 alias 和 source-selector 也必须进入显式登记集；不作为 catalog 入口暴露，但不得依赖通配/default。
- 未交付入口必须从 catalog 移除并在 delivery status 中标记 `exposure=hidden`、`surface=none`，不能以空表或其他业务数据伪装完成。

### 员工与财务账户主数据

A140/A183 登记以下精确 key，后缀不构成通配：

| key | 用途 | 读取权限 | 数据范围 |
| --- | --- | --- | --- |
| `employee-master-list` | 员工正式列表 | `master.data.manage` 或 `system.role_permission.manage` | tenant 内全部员工 |
| `employee-master-selector` | 员工内部选择器 | `master.data.manage` 或 `system.role_permission.manage` | 仅 `AUDITED + enabled` |
| `financial-account-master-list` | 财务账户正式列表 | `master.data.manage` 或 `finance.settle` | tenant 内全部账户 |
| `financial-account-master-selector` | 财务账户内部选择器 | `master.data.manage` 或 `finance.settle` | 仅 `AUDITED + enabled` |
| `financial-account-settlement-selector` | 结算与资金转账最小账户候选 | `finance.settle` 或 `finance.cash_transfer.audit` | 仅 `AUDITED + enabled`；不返回账号、户名、备注和版本，资金转账表单再限定 `CNY/USD`；多页读取强制使用服务端候选全集快照标识 |

- 两个正式列表是 catalog 入口；三个 selector 只供内部选择，不得发布为 catalog 入口。
- OR 权限由后端契约显式声明，不能通过角色名、前端隐藏或给只读角色补 `master.data.manage` 实现。
- selector 的审核/启用条件必须在服务端查询中强制；查询和导出不得依赖前端过滤。
- `financial-account-settlement-selector` 的 `snapshotToken` 绑定当前 tenant、查询条件、页大小、排序和完整候选字段；它只保证分页读取一致性，不是授权凭据，也不能替代保存/审核时的账户资格复验。权限守卫必须先于 token 校验。
- 员工、财务账户都使用真实 tenant 表，不扩展样本行；两个 tenant 可以有相同编码，但列表、详情、选择器不得串数据。
- 未登记的普通/master/selector key 必须在权限、adapter/provider 选择和 JDBC 访问之前返回 `404`。

### 选源单查询

- 选源单候选数据属于正式列表查询协议，统一走 `Controller -> ListQueryService -> ListQueryContractRegistry -> ListQueryAdapter`。
- 选源单 `listKey` 使用 `*-source-selector` 后缀，由 `ListQueryContractRegistry` 登记关键字字段、日期字段、明细视图和 `sourceSelector` adapter。
- 前端只能通过 `fetchSourceSelectorRows` 传递 `keyword`、`columnFilters`、`page`、`pageSize`、`sort`、`dateFrom/dateTo`；单据页面不得再直接调用页面私有候选源单查询协议。
- `fetchSourceSelectorRows` 必须按统一查询协议拉齐当前过滤全集，`SourceSelectorDialog` 只负责本地分页展示和选择语义。
- 单据页必须通过 `useSourceSelectorLifecycle` 接入选源单：页面只提供拉取函数、行唯一键、当前单据已分配数量和回填映射，不得私自维护候选行本地过滤、已选行集合、全选语义或汇总口径。
- 选源单可选量按 `后端正式剩余量 - 当前单据本地已分配量` 计算；当前单据已拉入的同一源单行再次打开时必须从候选集中扣减或隐藏，避免未保存草稿内重复选择同一可用数量。
- 关闭、取消和确认成功后的收口必须调用 `sourceSelector.close()`，由生命周期统一废弃 pending 查询、重置 loading 和清理弹窗消息；页面不得直接改写弹窗 open ref。
- 依赖客户/供应商的选源单入口，客户/供应商过滤作为固定列筛选合并进统一查询，不能在页面外层另算一套候选集。
- 弹窗底部“当前明细、剩余合计”等汇总必须基于统一查询返回后的最终可见行计算，不能只按页面本地关键字结果计算。

## 当前 stub 边界

- 真实业务查询未接入前，纯 stub 列表可在 `pageSize=1000` 时扩展样本行，用于验证前端 1000 行渲染和滚动密度。
- 已接入数据库的主数据/业务列表不得扩展样本行，必须返回真实查询结果；否则会污染选择器、粘贴匹配和业务判断。
- 库存查询未来必须接数据库余额口径，不允许业务结果缓存。
