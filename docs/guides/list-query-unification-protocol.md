# A128 列表查询协议统一

本文定义普通高密度列表页的统一查询协议。它约束 `DataListPage`、`/api/lists/{listKey}`、列表定义元数据、筛选预设、导出和生命周期边界。后续新增列表必须接入本协议，不允许重新写一套顶部筛选栏或查询参数。

## 目标

- 关键字支持多条件查询：空白分词后按多词 AND、字段内 OR 匹配。
- 顶部状态筛选退役：状态、关闭状态、冻结状态统一通过列头筛选。
- 日期过滤统一：常用日期和任意日期范围都落到 `dateFrom/dateTo`。
- 查询状态统一：查询、重置、分页、排序、列筛选、导出使用同一组参数。
- 整单/明细视图统一：整单视图可以被明细字段命中，但结果仍显示命中单据；明细视图才显示分录行。
- 生命周期边界清楚：列表过滤只影响结果集，不影响按钮能力判断。
- 选源单查询统一：候选源单仍走 `ListQueryService`，当前单据本地分配量由 `useSourceSelectorLifecycle` 扣减，不允许页面私写候选过滤和选择协议。

## 统一筛选条

普通列表顶部筛选条只保留：

| 控件 | 行为 |
| --- | --- |
| 关键字 | 写入 `keyword`，回车执行查询。 |
| 常用过滤条件 | 选择 `本月`、`上月`、`本季度`、`上季度`、`本年度`、`上年度`，计算后写入 `dateFrom/dateTo`。 |
| 日期范围 | 弹出日期范围选择，确认后写入 `dateFrom/dateTo`。 |
| 查询 | 使用当前查询状态重新加载第一页。 |
| 重置 | 清空 `keyword`、`dateFrom/dateTo`、列头筛选和旧兼容 `status`。 |

普通列表不得再显示顶部 `状态` 下拉，也不得保留只读的 `日期`、`经办人` 占位。客户、供应商、物料、状态、关闭状态、冻结状态、经办人等条件都通过列头筛选完成。

操作日志可以保留模块、动作、操作人、对象类型等扩展字段，但这些字段必须作为列表契约的扩展过滤项由统一查询栏渲染和保存预设，不允许页面组件私写。

## 查询协议

前端统一调用：

```http
GET /api/lists/{listKey}
```

核心参数：

| 参数 | 来源 | 说明 |
| --- | --- | --- |
| `keyword` | 关键字输入框 | 空白分词，多词 AND。 |
| `dateFrom` | 常用过滤条件或日期范围 | 作用到列表定义的 `dateField`。 |
| `dateTo` | 常用过滤条件或日期范围 | 作用到列表定义的 `dateField`。 |
| `columnFilters` | 列头筛选 | 所有列条件，包括状态列。 |
| `sortField/sortOrder` | 列头排序 | 必须是当前列表已知字段。 |
| `page/pageSize` | 分页器 | `page` 从 1 开始。 |
| `view` | 整单/明细视图 | 明细视图也必须复用同一查询协议。 |

旧 `status` 参数仅为兼容旧链接和旧预设保留。新前端不得生成；后端收到后必须转换为 `columnFilters.status = 等于` 的等价条件。

## 后端查询服务

列表读取和导出必须统一经过：

```text
Controller -> ListQueryService -> ListQueryContractRegistry -> ListQueryAdapter
```

职责边界：

| 层 | 职责 |
| --- | --- |
| Controller | 只负责 HTTP 参数和返回，不写搜索字段、日期字段、状态兼容等规则。 |
| ListQueryService | 负责分词、旧 `status` 兼容、日期、列筛选、排序、分页和导出复用。 |
| ListQueryContractRegistry | 登记 `listKey` 的搜索字段、日期字段、生命周期列、扩展过滤和整单/明细视图语义。 |
| ListQueryAdapter | 按契约生成真实 SQL 或 stub 查询。已接库业务列表必须把关键字、日期、状态等高选择性条件下推到数据库。 |

同一次请求只能形成一份查询计划。禁止为了判断 `searchFields`、`dateField` 和结果集重复读取 `seedRows`。

## 选源单生命周期

选源单是列表查询协议的派生场景，查询链路仍为：

```text
SourceSelectorDialog -> fetchSourceSelectorRows -> ListQueryService -> ListQueryAdapter
```

要求：

- 后端 adapter 返回正式剩余量，只处理已审核源单、关闭/冻结/作废状态、跨单正式执行量和跨单超量阻断。
- 前端页面必须通过 `useSourceSelectorLifecycle` 接入弹窗，不得保留 `filteredSourceSelectorLines`、页面私有 `sourceLineSearchText`、页面私有已选集合或页面私有全选语义。
- 可选量统一按 `后端正式剩余量 - 当前单据本地已分配量` 计算。保存草稿不产生正式全局占用，但同一草稿再次打开选源单时，已拉入的源单行数量必须被扣减，扣完为 0 的候选行不再展示。
- 页面只提供四类业务差异：`fetchRows`、`rowKey`、当前单据已分配量计算、源单行到当前单据分录的回填映射。
- 多选弹窗列头复选框语义固定为：勾选当前过滤全集；取消清空全部已选行，包括当前页外和当前过滤外隐藏行。单选弹窗必须声明单选语义。
- 确认选源并回填当前单据分录后，页面必须调用 `sourceSelector.commitLocalAllocation()`，由生命周期立即按当前表体重新扣减本地可选量；不得等保存后才依赖后端正式执行量刷新。
- 关闭、取消和确认成功后的收口必须调用 `sourceSelector.close()`，不得由页面直接写 `sourceSelectorOpen.value = false` 或 `sourcePickerOpen.value = false`。

## 整单视图命中明细字段

单据类列表允许声明：

```text
lineMatchPolicy=exists
returnShape=header
```

旧资料里的 `headerMatch=existsLine` 只作为语义别名保留，不作为新代码字段。

语义：

- `view=header` 返回一张单据一行。
- `keyword` 可以命中分录字段，如物料编码、物料名称、规格、客户物料编码、客户订单号、行备注。
- 命中后只显示订单，不展开明细行。
- 后端必须用 `EXISTS` 或等价 join 参与过滤，不把明细字段拼进整单返回行。
- `view=detail` 才返回分录行。

## 列表定义

每个 `ListDefinition` 必须登记：

| 字段 | 要求 |
| --- | --- |
| `keywordPlaceholder` | 只描述搜索范围，不写语法说明。 |
| `searchFields` | 关键字命中的字段列表。 |
| `dateField` | 日期范围默认作用字段。 |
| `supportsQuickDateFilter` | 是否显示常用日期和日期范围按钮。 |
| `defaultDateRange` | 默认日期范围；第一版默认不启用。 |
| `lifecycleColumns` | 生命周期展示列，仅用于列筛选和展示。 |
| `headerMatch` | 整单视图是否允许用明细字段命中单据；单据类通常为 `existsLine`，主数据为 `rowOnly`。 |

主数据列表可设置 `supportsQuickDateFilter=false`。业务单据列表通常使用 `billDate`。操作日志使用 `operatedAt`。

## 生命周期边界

列表查询协议不新增生命周期状态源。正式单据生命周期仍只认：

- `status`
- `close_status`
- `close_mode`
- `frozen_status`

状态、关闭状态、冻结状态在列表中只是展示字段和过滤字段。批量审核、反审核、作废、关闭、冻结、红冲、删除、下推等动作必须继续由前端 `documentLifecyclePolicy.ts` 和后端 `BillLifecyclePolicy` / `BillLifecycleService` 决定。不得用 `outStatus`、`inStatus`、列头过滤条件或顶部查询状态判断动作是否合法。

## 预设迁移

旧预设可能包含 `query.status`。应用旧预设时：

1. 如果 `query.status` 非空，迁移为 `columnFilters.status = { operator: "等于", value: query.status }`。
2. 清空迁移后的 `query.status`。
3. 保存新预设时不得再写入 `query.status`。

操作日志预设继续保存模块、动作、操作人、对象类型和日期范围，但状态仍走 `columnFilters.status`。

预设创建者合同：

- PERSONAL scope 由后端按当前 immutable username + role 固定，忽略客户端传入的 `userName/role`；ROLE/GENERAL 的保存与删除继续要求共享预设管理权限。
- 读取优先级保持 PERSONAL → ROLE → GENERAL，再按 default 与更新时间排序；`shared=true` 不突破 user/role scope，不等于全局可见。
- 新建预设的 `created_by` 由后端从当前认证 session 取得不可变用户 UUID；请求体不得指定或覆盖创建者。
- 更新已有预设时必须保留原 `created_by`。历史行为创建的 `created_by IS NULL` 行继续为 NULL，普通更新不得顺便回填。
- 不根据名称、账套、最近操作人或其他弱证据推断 legacy 行所有者。A135 验证基线为 136 条 legacy 预设、迁移 0 条。
- `account_set_code` 表示账套归属，`created_by` 表示创建者归属，两者不得互相替代。

## 落地顺序

1. 更新 `docs/13-列表API契约.md` 和本文。
2. 后端建立 `ListQueryContractRegistry`、`ListQueryService`、`ListQueryAdapter`。
3. 销售订单整单/明细视图迁入查询 adapter，整单视图用 `existsLine` 支持明细字段命中。
4. 导出接口切到同一查询服务。
5. 前端抽出统一查询栏，普通列表不再生成 `status`。
6. 操作日志扩展过滤接入统一查询栏和预设结构。
7. A128 回归覆盖整单视图、明细视图、导出和视觉一致性。
8. 跑静态门禁、核心生命周期门禁、构建、后端验证和浏览器回归。
9. 输出验收报告。

## 测试方法

静态门禁：

```bash
node scripts/a128-list-query-contract-scan.mjs
node scripts/a124-lifecycle-contract-scan.mjs
```

浏览器回归：

```bash
node scripts/a128-list-query-unification-regression.mjs
```

人工验收重点：

- 销售订单列表顶部没有状态下拉。
- 输入 `广州 CP-001` 只返回同时命中两个词的数据。
- 输入 `广州 不存在词` 返回空态。
- `常用过滤条件 -> 本月` 后列表、分页、导出都使用同一日期范围。
- `日期范围` 自选起止日期后结果符合范围。
- 整单视图输入 `CP-001` 这类明细字段，显示命中的订单而不是明细行。
- 明细视图输入 `CP-001` 显示命中的分录行。
- 状态列列头筛选 `已审核` 生效。
- 关键字、日期范围、列头状态、排序、分页、导出组合一致。
- 操作日志扩展字段和预设仍可用。
- 生命周期按钮能力不因筛选条件变化。
- 选源单确认后再次打开，同一当前单据已拉入的源单数量不会被重复展示为可选数量。

## 验收标准

- 普通列表顶部不再出现 `状态` 下拉。
- 普通列表不再出现旧的只读 `日期` / `经办人` 展开过滤占位。
- 普通列表筛选区由 `DataListPage` 统一渲染。
- `keyword` 支持空格多条件查询，并符合多词 AND、字段内 OR。
- 常用日期和任意日期范围都落到 `dateFrom/dateTo`。
- 状态筛选只通过 `columnFilters` 完成。
- 查询、重置、分页、排序、列筛选、导出结果一致。
- 旧 `query.status` 预设可继续应用，新保存预设不再写顶部 `status`。
- 新建预设记录当前认证用户的不可变 UUID；更新保持原创建者，legacy NULL 不回填，136 条基线数据零迁移。
- A128 静态扫描能阻止后续页面私写筛选栏。
- A124 生命周期扫描通过，证明查询协议没有污染生命周期能力判断。
- 选源单页面统一接入 `useSourceSelectorLifecycle`，A128 静态扫描禁止新增页面私有源单过滤、选择、汇总协议。
- 选源单页面关闭、取消和确认成功后统一调用 `sourceSelector.close()`，A128 静态扫描禁止页面直接改写弹窗 open ref。
- 查询栏按钮必须与同区按钮共享高度、边框、背景、字号、hover 和禁用态；日期弹层可专用，触发按钮不可另造视觉系统。
