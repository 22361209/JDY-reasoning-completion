# BLD 页面统一协议

本文件定义 BLD ERP 自研系统的页面统一目标。它不是 JDY 复刻阶段的临时说法，而是后续所有列表、单据、表头、表体、动作按钮、字段渲染的产品协议。

## 目标

销售模块已经打磨出第一版可接受的视觉和操作手感。后续模块不得继续各自发明页面、表格、动作条和输入框。业务差异只能体现在字段定义、列定义、动作定义和 handler；不能体现在每个页面重新写一套 UI。

统一目标分三部分：

1. BLD 页面统一协议
2. 动作按钮注册表
3. 表格/表体硬约束

## 基本原则

- 销售订单、采购订单是第一版页面样板。
- 新增页面先找统一协议和共享组件，再写入口逻辑。
- 能由配置表达的差异，不写成局部模板。
- 组件外观、按钮位置、禁用态、确认弹窗、错误提示、行高、列头、筛选、列设置、输入态必须全局一致。
- 业务差异交给当前单据的业务服务或 handler，不把差异写进共享 UI。

## 页面协议

### 列表页

列表页必须统一：

- 页面标题与工具区布局
- 查询区字段密度
- 视图切换位置
- 列设置按钮位置
- 更新/刷新按钮位置
- 批量动作区顺序
- 表格行高、字号、列头、筛选按钮、列宽拖拽、固定列
- 分页、每页条数、合计行
- 空态、加载态、错误态

实现要求：

- 正式业务列表优先走 `DataListPage` 或后续拆出的 ListPage 协议组件。
- 不允许在业务模块里直接写另一套列表表格。
- 如果列表需要新增能力，先扩共享列表协议，再让入口配置使用。

### 单据页

单据页必须统一：

- 标题栏
- 状态章
- 动作条
- 未保存提示
- 表头字段布局
- 分录表体
- 合计行
- 消息反馈
- 审核后只读态
- 删除、反审核、作废等危险动作确认

实现要求：

- 正式单据页默认走 `StandardDocument`。
- 非标准单据或主数据页需要动作条时走 `DocumentCommandHeader`，但不能自建另一套按钮视觉。
- 表头字段后续应收口到统一 FieldRenderer，不再每页手写输入框。

### 主数据页

主数据页可以不是完整单据页，但必须统一：

- 动作条视觉
- 新增、保存、审核、反审核、启用、禁用、删除、复制规则
- 查看态/编辑态
- 字段输入密度
- 选择器样式
- 列表点击编码打开唯一资料页签

主数据的特殊性只体现在状态和字段，不体现在外观另起一套。

## 动作按钮注册表

动作按钮要拆成三层。

单据生命周期按钮还必须额外服从 `docs/guides/bill-lifecycle-unification-protocol.md`：页面动作条只负责渲染和触发，单据是否支持关闭、冻结、红冲、作废由统一生命周期能力表决定。详情页和列表页必须读取同一份口径，不能让某张单据在详情页隐藏关闭按钮、列表页却能批量关闭。

### 1. 外观和交互，全局统一

包括：

- 按钮位置
- 按钮顺序
- 按钮样式
- hover/disabled/loading
- 危险动作颜色
- 确认弹窗样式
- 成功/失败提示位置

这些一处修改，全局生效。

### 2. 语义和状态规则，默认全局统一

例如：

- 未保存单据不能删除
- 草稿才能保存
- 审核后才能下推
- 未审核源单不能被选源或执行
- 只有连续执行类单据显示关闭/反关闭、冻结/解冻
- 只有库存/执行事实类单据显示红冲
- 有下游时不能反审核
- 已审核资料默认不可编辑
- 权限不足时可见但禁用，或按权限隐藏

这些默认由通用规则提供，单据只在确有业务差异时覆盖。

### 3. 按钮是否存在和业务效果，按单据配置

例如：

- 销售订单有“选源单”，销售报价单没有。
- 销售出库审核扣库存，销售订单审核不扣库存。
- 生产任务审核生成用料快照，采购订单审核形成供应承诺。

按钮长相和状态入口统一，点击后的业务效果由当前单据 handler 处理。

### ActionDefinition 模型

后续动作按钮应向注册表收口：

```ts
type ActionDefinition = {
  key: "create" | "save" | "audit" | "reverse" | "delete" | "sourceSelect" | "pushDown" | string;
  label: string;
  order: number;
  danger?: boolean;
  visibleRule?: string;
  enabledRule?: string;
  confirmRule?: string;
  handlerKey: string;
};
```

页面只声明动作：

```ts
actions: ["create", "save", "audit", "reverse", "sourceSelect", "delete", "export", "print"]
```

统一 ActionBar 负责渲染外观、顺序、禁用、确认和提示；当前单据提供 handler。

### 改按钮时的生效范围

| 改动类型 | 生效范围 |
| --- | --- |
| 改按钮颜色、尺寸、顺序、禁用样式 | 全局 |
| 改确认弹窗、loading、成功失败提示 | 全局 |
| 改“审核前必须已保存”等通用规则 | 默认全局 |
| 改某张单据审核后的业务影响 | 仅该单据 handler |
| 给某类单据新增按钮 | 声明该 action 的单据生效 |
| 某张单据不需要某按钮 | 该单据 actions 不声明 |

生命周期相关按钮的新增或调整必须同时检查三处：后端 `BillLifecyclePolicy`、前端 `documentLifecyclePolicy.ts`、列表/详情页动作声明。只改按钮文案或外观属于全局 UI 改动；改某类单据是否允许关闭、冻结、红冲属于生命周期协议改动，必须更新业务规则和验收报告。

新增正式单据时，还必须执行 `docs/guides/bill-lifecycle-unification-protocol.md` 的“新增单据生命周期接入门禁”，并运行 `node scripts/a124-lifecycle-contract-scan.mjs`。页面协议只保证外观和交互一致，生命周期协议负责防止按钮、状态和后端规则分叉。

## 表格/表体硬约束

### 共享表格外观

所有正式业务表格必须统一：

- 行高
- 字号
- 列头高度
- 列头背景
- 筛选按钮位置
- 批量填充按钮位置
- 列宽拖拽热区
- 单元格输入框边距
- 查看态/编辑态边框
- 固定列阴影和滚动表现
- 合计行位置和样式

### 列表表格

列表表格使用共享列表协议，不允许业务模块里另写一套高密度列表。

必须支持：

- 列设置
- 列宽调整
- 列顺序调整
- 列筛选
- 查询
- 分页
- 合计行
- 整单/明细视图状态记忆

### 单据表体

普通业务单据分录默认使用 `EntryTable`。

必须支持：

- 行加号/减号
- 物料匹配带出
- 仓库匹配带出
- 单位、净重、毛重等物料快照带出
- 数量、单价、含税单价、金额、含税金额统一文案
- 日期录入
- 行备注
- 键盘连续录入
- 审核后只读
- 列设置
- 列筛选
- 列宽调整
- 底部汇总

### 专用表体

BOM、生产计划这类表体可以保留专用组件，但必须接入共享表格合同：

- `TableCoreHeaderCell`
- `ColumnSettingsDialog`
- `ColumnFilterPopover`
- `useColumnFilters`
- 统一行高/字号/输入框/列宽拖拽/筛选按钮样式
- 如有行级新增/删除，必须使用与 `EntryTable` 同一套行按钮视觉

专用表体不得成为“另一套 UI”。

### 主数据选择弹窗

分录表、单头字段和表单字段里的“整列表选择”属于共享选择器协议，不属于某个单据页面的局部 UI。

必须支持：

- 统一大弹窗结构：标题、搜索区、可选 facet 区、共享表格、分页/每页条数、底部操作区。
- 表格能力复用共享选择弹窗表格合同：`TableCore`、`TableCoreHeaderCell`、`ColumnSettingsDialog`、`ColumnFilterPopover`、`useColumnFilters`、列宽调整、列设置、列筛选、空态、加载态和统一 `queryChange`。
- 候选列来自主数据元数据 `MasterDataDefinition.selectorColumns`，不得在弹窗里硬编码商品、客户、仓库各自的列。
- 候选行保留接口返回完整字段；选择器表格按列 key 取值，回填逻辑只在选中后抽取标准字段。
- 商品类别、启用/审核状态、最近使用等筛选必须作为选择器协议的 facet/filter 输入，由选择器服务统一转成列表查询参数；单据模块不得直接加载类别或散写筛选参数。
- 分页必须真实可操作。若接口返回 `total > rows.length`，弹窗必须显示分页控件或继续加载机制；不得只显示总数却只能访问第一页。
- 异步查询必须防串场。关键词、类别、分页、选择器类型切换时，旧请求不得覆盖新弹窗状态。

禁止：

- 在 `MasterSelectorDialog` 内直接复制 `SourceSelectorDialog` 的表格、列宽、筛选、分页逻辑。
- 为主数据选择器新建独立 localStorage 列宽键，绕开共享列设置/列偏好协议。
- 在 `useDocumentModule`、`useSalesOutDocument` 等单据 composable 中维护商品类别列表或选择器查询细节。

## 字段渲染协议

A123 已建立 FieldRenderer 第一阶段，让主数据建档/编辑类字段先由字段类型决定渲染方式；A124 已把 FieldRenderer 扩展到 `DocumentForm` 单据表头字段。后续单据表头新增字段时，应优先增加字段定义、选项、校验和 handler，不再直接手写一套 `<label><input>`。

| 字段类型 | 统一表现 |
| --- | --- |
| 文本 | 下划线式输入，查看态无输入框边 |
| 数量 | 右对齐，小数规则由字段定义 |
| 金额 | 右对齐，金额文案遵守全局术语 |
| 日期 | 支持键盘输入和日期选择 |
| 物料 | 编码/名称匹配选择，带出快照 |
| 客户/供应商 | 编码/名称匹配选择 |
| 仓库 | 编码/名称匹配选择 |
| 状态 | 状态章或统一 tag |
| 布尔 | 勾选即是，不额外显示“是/否” |

## 不允许的做法

- 新页面手写动作条。
- 新页面手写另一套表格列头。
- 新页面手写另一套筛选按钮。
- 新页面为了局部方便直接改共享 CSS。
- 同一按钮在不同页面文案、顺序、禁用态不一致。
- 保存、审核、反审核、删除、下推规则散落在页面模板里。
- 为了某一页先绕开共享组件，事后不回收。

## 当前落地状态（2026-06-30）

本轮已把协议第一层落到代码，并完成 A124 的单据表头字段协议与动作规则收口：

- 新增 `frontend/src/components/actions/actionRegistry.ts`，统一维护动作 key、默认文案、顺序、危险态和 test id。
- 新增 `frontend/src/components/ActionBar.vue`，统一渲染按钮外观、顺序、禁用态和事件分发。
- 新增 `frontend/src/components/actions/documentActionRules.ts`，集中 `StandardDocument` 生命周期动作的可见性、禁用态和旧 test id 映射；动作 handler 仍由当前单据业务提供。
- `StandardDocument` 已改为通过 ActionBar 渲染单据动作条，保留旧 test id 兼容现有回归脚本。
- `DocumentForm` 的客户/供应商编码、名称、业务日期、报价有效期、单据编号、部门、录入人、价格口径、备注等表头字段已改为通过 `FieldRenderer` 渲染。
- `DataListPage` 的列表动作条和“更多”菜单已改为 ActionBar，避免列表按钮继续散写。
- A121 已把 `DataListPage` 内部定义、列偏好、选择状态、合计逻辑拆到 `frontend/src/components/list/*`，外部列表协议保持不变。
- A122 已把 `EntryTable` 内部列定义、计算、测试 ID 拆到 `frontend/src/components/entry-table/*`，外部 props/events/test id 保持不变。
- A123 已新增 `frontend/src/components/fields/FieldRenderer.vue` 和字段协议类型，主数据详情页与旧建档弹窗已统一使用该组件渲染 select、lookup、file、textarea、checkbox 和普通输入框。
- A124 最终已通过前端构建、smoke 10/10、全量回归 99/99，结果见 `verification/regression-tier-full-continue-latest.json`。
- 主数据、库存期初、编号规则、用户、权限、安全、通知、账套、生产任务、委外表面处理等页面动作条已接入 ActionBar。
- `SourceSelectorDialog`、`MasterSelectorDialog`、`OpeningStockPage`、`NumberingRuleSettingsPage`、委外子件需求明细已接入 `TableCore`。
- `SourceSelectorDialog` 已去掉旧 raw table 的局部 `th/td` 覆盖，外层只负责弹窗滚动，内部表格遵守共享表格合同。
- `SourceSelectorDialog` 的查询只发出统一 `queryChange` 协议，由页面调用 `fetchSourceSelectorRows` 进入 `ListQueryService`；页面不得在弹窗外私自维护另一套源单查询协议。
- 支持批量选择的选源单弹窗，列头复选框语义固定为：勾选时选择当前过滤结果内全部候选行；取消时清空全部已选行，包括当前页外和当前过滤外隐藏的已选行。`fetchSourceSelectorRows` 负责把当前过滤全集拉齐后交给弹窗本地分页，该语义不同于普通列表跨页选择，需要在弹窗协议内保持清晰。
- 选源单生命周期统一由 `useSourceSelectorLifecycle` 承载：正式剩余量来自 `ListQueryService`，当前单据未保存前的本地分配量由生命周期按源单行扣减；确认回填分录后必须调用 `sourceSelector.commitLocalAllocation()` 立即刷新本地可选量，再次打开选源单不得重复选到已被当前单据拉入的数量。页面只保留源单行到当前单据分录的业务映射。

当前允许保留的例外：

- `DocumentDialogs.vue` 内的零值确认表和下游影响表属于二级确认/提示，不是正式业务列表或分录表体。
- `DataListPage` 内库存预警设置弹窗仍有一张轻量配置表，属于次级设置面板，后续若高频使用再迁入 `TableCore`。
- `App.vue` 内打印/追溯 HTML 字符串中的 `<table>` 是输出模板，不是应用内交互表格。
- FieldRenderer 当前覆盖主数据/表单字段第一阶段和 `DocumentForm` 单据表头字段，尚未替换 `EntryTable` 分录单元格渲染。

后续新增页面或改造页面，默认不得再新增正式业务 raw table；如果必须例外，需要在验收报告中说明原因和后续回收条件。

## 验收门禁

新增或改造页面时，至少检查：

1. 是否使用统一动作条或动作注册表。
2. 是否使用 `StandardDocument` / `DocumentCommandHeader`。
3. 普通分录是否使用 `EntryTable`。
4. 专用表体是否接入共享表格合同。
5. 是否复用已有按钮、字段、选择器、列设置和筛选组件。
6. 是否没有新增局部表格视觉规则。
7. 是否在报告中说明业务差异来自配置/handler，而非自建 UI。

这份协议优先于临时页面实现。后续如果协议和现有代码冲突，以协议为目标逐步收口。
