# 单据与主数据元数据驱动路线

更新日期：2026-06-28

## 背景

近期在销售报价单、销售订单、发货通知单、销售出库单、采购订单、采购入库单、物料、客户、供应商等页面上反复调整字段、列名、源单列、按钮显隐和分录表交互。问题根因不是单点实现错误，而是当前实现缺少“业务对象元数据层”：

- 列表列定义主要散在 `DataListPage.vue`。
- 单据表头字段和动作按钮分散在各入口表单、`DocumentForm`、`EntryTable` 和 composable。
- 源单关系、列表整单/明细视图区分、客户/供应商/物料字段规则没有统一声明入口。
- 调整一个字段或按钮时，容易同时影响列表、分录、表单、回归脚本和后端 DTO。

云星空字段地图给出的关键启发是：金蝶不是每个页面手写字段，而是以业务对象元数据驱动单据页、列表页、分录体、按钮动作、状态规则和布局方案。本项目不照搬云星空权限、配置、组织、状态复杂度，但要学习“对象定义驱动页面”的结构。

## 证据来源

业务字段地图来自 HW-WIN2019 项目的金蝶云星空探针结果：

- `/Users/linzhenyue/Projects/HW-WIN2019/k3cloud-bill-field-catalog.md`
- `/Users/linzhenyue/Projects/HW-WIN2019/tools/k3cloud_bill_field_catalog_fast.sql`
- `/Users/linzhenyue/Projects/HW-WIN2019/output/k3cloud_bill_field_catalog_fast.out`
- `/Users/linzhenyue/Projects/HW-WIN2019/tools/k3cloud_customer_supplier_summary.sql`
- `/Users/linzhenyue/Projects/HW-WIN2019/output/k3cloud_customer_supplier_summary.out`

其中核心对象包括：物料、客户、供应商、BOM、销售报价单、销售订单、发货通知单、销售出库单、采购订单、收料通知单、其他入库单、生产订单、生产用料清单、生产领料单、生产入库单。

## 目标

建立轻量 `BillDefinition` / `MasterDataDefinition`，让字段、列表、分录、动作、源单关系、状态规则、布局提示从页面实现中抽出，变成可集中维护的定义。

第一阶段不追求做满云星空字段，而是先解决当前最高频调整点：

- 同一字段在整单列表、明细列表、表单、分录中的命名一致。
- 源单列只在有上游来源的单据显示，源头单据不显示。
- 物料编码/物料名称、客户编码/客户名称、客户物料编码、客户订单号、供应商编码等规则集中声明。
- 金额字段全局采用`单价`、`含税单价`、`金额`、`含税金额`四个用户可见文案；旧字段名`priceTaxTotal`可以作为实现字段保留，但 UI 不再显示`价税合计`/`税价合计`。
- 动作条按钮由定义层和权限/状态规则共同决定显示、可用、提示和危险确认。
- 列表和分录都消费共享定义，不再在页面里手工拼一套。

## 建议定义结构

```ts
type BillDefinition = {
  billType: string;
  title: string;
  module: "sales" | "purchase" | "production" | "inventory";
  party?: {
    type: "customer" | "supplier" | "workshop";
    codeLabel: string;
    nameLabel: string;
  };
  sourcePolicy: "none" | "salesQuote" | "salesOrder" | "deliveryNotice" | "purchaseOrder" | "productionTask";
  headerFields: FieldDefinition[];
  entryColumns: EntryColumnDefinition[];
  listViews: {
    header: ListColumnDefinition[];
    detail: ListColumnDefinition[];
  };
  toolbarActions: ActionDefinition[];
  statusRules: StatusRuleDefinition[];
  layoutHints: LayoutHintDefinition;
};
```

主数据采用轻量 `MasterDataDefinition`：

```ts
type MasterDataDefinition = {
  entityType: "material" | "customer" | "supplier" | "warehouse";
  title: string;
  listColumns: ListColumnDefinition[];
  formSections: FormSectionDefinition[];
  selectorColumns: ListColumnDefinition[];
  statusRules: StatusRuleDefinition[];
};
```

## A115 计划分布

### A115-0 资料与路线收口

目标：只做文档，不改代码。

- 记录云星空字段地图证据来源。
- 明确本项目转向元数据驱动单据/主数据页面。
- 把下一批任务拆成可执行阶段。

验收：

- `docs/guides/bill-metadata-roadmap.md` 存在并被 `repository-map`、`docs/09`、`docs/12` 引用。
- `docs/12` 当前批次切换到 A115 元数据驱动路线。

### A115-1 定义层骨架

目标：建立前端定义层，不迁移所有页面。

- 新增 `frontend/src/modules/metadata/` 或同等目录。
- 定义 `BillDefinition`、`MasterDataDefinition`、字段/列/动作/状态类型。
- 抽出共享字段片段：物料字段、客户字段、供应商字段、源单字段、金额字段、库存字段、生产字段。
- 暂不改业务行为。

验收：

- 前端构建通过。
- 现有页面行为不变。
- 定义层有销售报价单和销售订单的样板定义。

预计：0.5-1 天。

### A115-2 销售链迁移

范围：

- 销售报价单
- 销售订单
- 发货通知单
- 销售出库单

目标：

- 列表整单视图、列表明细视图、单据表头、分录列、动作条、源单关系改由定义层驱动。
- 销售报价单 `sourcePolicy=none`，不出现源单列和选源单。
- 销售订单 `sourcePolicy=salesQuote`。
- 发货通知单 `sourcePolicy=salesOrder`。
- 销售出库单 `sourcePolicy=deliveryNotice`。
- 客户编码、客户名称、客户物料编码、客户订单号、预计交期、物料编码、物料名称等规则集中在定义层。

验收：

- 销售链核心回归 `area:sales` 通过。
- 销售报价单/订单/发货通知/出库列表和明细视图字段不串页、不串列。
- 源单列显示规则符合定义。

预计：1-1.5 天。

### A115-3 采购链迁移

范围：

- 采购订单
- 采购入库单
- 采购退货单
- 采购汇总表

目标：

- 采购订单是采购承诺层，默认无上游源单。
- 采购入库单 `sourcePolicy=purchaseOrder`。
- 采购退货单 `sourcePolicy=purchaseIn`，从已审核采购入库单选源；非作废采购退货占用源采购入库行可退数量。
- 供应商编码、供应商名称、物料字段、入库状态等由定义层驱动；采购订单分录每行必须有预计交期。
- 采购模块不加客户订单号/客户物料编码；采购订单使用独立的供应商物料编码，不得和客户物料编码共用字段。
- 采购订单列表显示数量、已入库数量、未入库数量、金额、含税金额；采购入库/采购退货列表显示数量、金额、含税金额。
- 采购汇总表聚合采购数量、入库数量、退货数量、未入库数量、采购金额、入库金额、退货金额和净采购金额。

验收：

- 采购核心回归通过。
- 采购入库选源单、非作废下游占用采购订单剩余量仍有效。
- 采购退货审核扣库存、反审核补回库存，且采购汇总只统计已审核采购订单/入库/退货。

预计：0.75-1 天。

### A115-4 主数据定义化

范围：

- 物料
- 客户
- 供应商
- 仓库

目标：

- 主数据列表、建档页、选择器字段由 `MasterDataDefinition` 驱动。
- 物料是本阶段核心，保留“一物料多业务面”：可采购、可销售、可库存、可自制、可委外、默认仓库、默认供应商、默认领料仓、默认生产车间等。
- 物料定义必须显性区分系统ID和物料编码：列表/建档页可看到只读系统ID，底层关联使用系统ID；选择器、搜索、打印仍以物料编码和物料名称为主，避免把技术主键暴露成业务录入字段。
- 核心单据采用物料显示快照方案 B：新单据保存时落库物料编码、名称、规格等快照；历史列表、详情和打印优先显示快照；点击追溯时再通过系统ID打开当前物料主档。
- 客户/供应商在应收应付、开票、信用、付款、质量准入未深入前只做轻主档：编码、名称、联系人、电话、地址、状态、备注。结算、开票、信用、银行、质量等字段后置。
- 仓库在库存高级策略未深入前只做移仓和单据引用所需字段：编码、名称、类型、仓管员、地址、状态、备注。库存策略、库位、批号、负库存配置暂缓。
- 维护客户/供应商物料号映射的定义入口。

验收：

- 物料、客户、供应商、仓库建档页可用；物料字段明显重于另外三类。
- 单据选择器仍能正常选择并回填。

预计：1-1.5 天。

### A115-5 生产链定义化

范围：

- 生产计划
- 生产任务
- 生产用料快照
- 生产领料
- 产品入库

目标：

- 按本项目第一版轻量生产链定义：自发生产计划 → 生产任务 → 任务用料快照 → 生产领料 → 产品入库。
- 不把销售订单下推生产作为主路径。
- 生产领料和产品入库的字段/动作/源单关系由定义层驱动。

验收：

- `area:production` 通过。
- 生产领料仍按任务用料快照，不运行时直接读标准 BOM。

预计：0.75-1 天。

### A115-6 回归、文档和清理

目标：

- 删除或收缩页面内重复字段定义。
- 更新业务规则、动作按钮规则、字段定义说明。
- 跑前端构建、后端测试、分层回归。

验收：

- `npm --prefix frontend run build` 通过。
- 后端测试通过。
- 按改动范围跑 `smoke`、`area:sales`、`area:purchase`、`area:production` 或 `full`。
- 输出 A115 验收报告。

预计：0.5-1 天。

## 总工期估计

- 只搭骨架并迁销售链：约 2 天。
- 销售、采购、主数据、生产全部进入定义层：约 4-6 天。
- 如果期间继续夹带新业务功能，工期会明显拉长；A115 应尽量限定为结构调整和字段/动作口径统一。

## 执行原则

- 先定义，再迁移；不要边补页面边补规则。
- 每次只迁一组业务对象，迁完跑对应 area 回归。
- 共享定义要能解释页面，不做空壳。
- 业务规则仍在后端 application/domain；定义层只负责字段、动作、状态显示和前端交互结构。
- 不重跑 `build-jdy-feature-approval.mjs`，不手改生成物。
