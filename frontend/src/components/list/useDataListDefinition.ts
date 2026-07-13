import { computed } from "vue";
import { getBillDefinitionByListKey } from "../../modules/metadata/registry";
import { masterDataDefinitions } from "../../modules/master-data/registry";

export interface ListColumn {
  field: string;
  title: string;
  width?: number;
  minWidth?: number;
  fixed?: "" | "left" | "right";
  locked?: boolean;
  reorderable?: boolean;
  align?: "left" | "center" | "right";
  visible: boolean;
}

export interface ListDefinition {
  title: string;
  subtitle: string;
  keywordPlaceholder: string;
  statuses: string[];
  columns: ListColumn[];
  searchFields: string[];
  dateField: string;
  supportsQuickDateFilter: boolean;
  defaultDateRange?: "" | "currentMonth" | "previousMonth" | "currentQuarter" | "currentYear" | "previousYear";
  lifecycleColumns: string[];
}

type RawListDefinition = Omit<ListDefinition, "searchFields" | "dateField" | "supportsQuickDateFilter" | "lifecycleColumns"> & Partial<Pick<ListDefinition, "searchFields" | "dateField" | "supportsQuickDateFilter" | "lifecycleColumns">>;

export type OpenableDocumentType = "salesQuote" | "salesOrder" | "deliveryNotice" | "salesOut" | "salesReturn" | "purchaseOrder" | "purchaseIn" | "purchaseReturn" | "materialIssue" | "productIn" | "otherStockIn" | "otherStockOut" | "stockTransfer" | "stockCount" | "stockCountGain" | "stockCountLoss";

const voidableDocumentListKeys = new Set([
  "sales-quote-form-list",
  "sales-order-form-list",
  "delivery-notice-form-list",
  "sales-out-list",
  "sales-out-form-list",
  "sales-return-form-list",
  "purchase-order-form-list",
  "purchase-in-list",
  "purchase-in-form-list",
  "purchase-return-form-list",
  "production-task-form-list",
  "material-issue-form-list",
  "product-in-form-list",
  "other-in-form-list",
  "other-out-form-list",
  "stock-transfer-form-list",
  "stock-count-form-list",
  "stock-count-gain-form-list",
  "stock-count-loss-form-list"
]);

const masterListDefinitions = Object.fromEntries(
  Object.entries(masterDataDefinitions).map(([listKey, masterDefinition]) => [
    listKey,
    {
      title: masterDefinition.title,
      subtitle: "",
      keywordPlaceholder: masterDefinition.keywordPlaceholder,
      statuses: masterDefinition.statuses,
      columns: masterDefinition.listColumns.map((column) => ({ ...column })),
      searchFields: searchFieldsFromPlaceholder(masterDefinition.keywordPlaceholder, masterDefinition.listColumns.map((column) => column.field)),
      dateField: "updatedAt",
      supportsQuickDateFilter: false,
      lifecycleColumns: ["status", "auditStatus"]
    }
  ])
) as Record<string, ListDefinition>;
const rawDefinitions: Record<string, RawListDefinition> = {
  ...masterListDefinitions,
  "sales-order-form-list": {
    title: "销售订单列表",
    subtitle: "销售订单列表承载查询、批量动作、列设置、页签锁定和分页。",
    keywordPlaceholder: "单据编号、客户、商品",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billNo", title: "单据编号", width: 150, fixed: "left", visible: true },
      { field: "customerCode", title: "客户编码", width: 120, visible: true },
      { field: "customer", title: "客户名称", width: 200, visible: true },
      { field: "billDate", title: "单据日期", width: 130, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "outStatus", title: "出库状态", width: 110, visible: true },
      { field: "qty", title: "数量", width: 110, align: "right", visible: true },
      { field: "shippedQty", title: "已出库数量", width: 120, align: "right", visible: true },
      { field: "remainingQty", title: "未出库数量", width: 120, align: "right", visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true },
      { field: "priceTaxTotal", title: "含税金额", width: 120, align: "right", visible: true },
      { field: "remark", title: "整单备注", width: 180, visible: true },
      { field: "owner", title: "经办人", width: 120, visible: true }
    ]
  },
  "sales-quote-form-list": {
    title: "销售报价单列表",
    subtitle: "销售报价单保存客户报价，审核且有效期内可作为销售订单选源单依据。",
    keywordPlaceholder: "单据编号、客户、商品",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billNo", title: "单据编号", width: 150, fixed: "left", visible: true },
      { field: "customerCode", title: "客户编码", width: 120, visible: true },
      { field: "customer", title: "客户名称", width: 200, visible: true },
      { field: "billDate", title: "单据日期", width: 130, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "validUntil", title: "报价有效期", width: 130, visible: true },
      { field: "validStatus", title: "有效状态", width: 110, visible: true },
      { field: "amount", title: "报价金额", width: 120, align: "right", visible: true },
      { field: "priceTaxTotal", title: "含税金额", width: 120, align: "right", visible: true },
      { field: "remark", title: "整单备注", width: 180, visible: true },
      { field: "owner", title: "经办人", width: 120, visible: true }
    ]
  },
  "purchase-order-form-list": {
    title: "采购订单列表",
    subtitle: "采购订单列表承载供应商、审核状态、入库状态和金额查询。",
    keywordPlaceholder: "单据编号、供应商、商品",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billNo", title: "单据编号", width: 150, fixed: "left", visible: true },
      { field: "supplierCode", title: "供应商编码", width: 130, visible: true },
      { field: "supplier", title: "供应商名称", width: 220, visible: true },
      { field: "billDate", title: "单据日期", width: 130, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "inStatus", title: "入库状态", width: 110, visible: true },
      { field: "qty", title: "数量", width: 110, align: "right", visible: true },
      { field: "receivedQty", title: "已入库数量", width: 120, align: "right", visible: true },
      { field: "remainingQty", title: "未入库数量", width: 120, align: "right", visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true },
      { field: "priceTaxTotal", title: "含税金额", width: 120, align: "right", visible: true },
      { field: "owner", title: "经办人", width: 120, visible: true }
    ]
  },
  "purchase-requisition-list": {
    title: "采购申请单列表",
    subtitle: "采购申请由生产计划下推生成，按供应商汇总待转采购订单数量。",
    keywordPlaceholder: "申请单号、生产计划、供应商、物料",
    statuses: ["已审核", "已关闭"],
    columns: [
      { field: "billNo", title: "申请单号", width: 150, fixed: "left", visible: true },
      { field: "sourcePlanNo", title: "来源计划", width: 160, visible: true },
      { field: "supplierCode", title: "供应商编码", width: 130, visible: true },
      { field: "supplier", title: "供应商名称", width: 220, visible: true },
      { field: "billDate", title: "单据日期", width: 130, visible: true },
      { field: "productCode", title: "物料编码", width: 140, visible: true },
      { field: "productName", title: "物料名称", width: 180, visible: true },
      { field: "unit", title: "单位", width: 80, visible: true },
      { field: "qty", title: "申请数量", width: 110, align: "right", visible: true },
      { field: "orderedQty", title: "已转订单数量", width: 130, align: "right", visible: true },
      { field: "remainingQty", title: "未转订单数量", width: 130, align: "right", visible: true },
      { field: "planDeliveryDate", title: "交期", width: 130, visible: true },
      { field: "status", title: "状态", width: 100, visible: true }
    ]
  },
  "purchase-return-form-list": {
    title: "采购退货单",
    subtitle: "采购退货单从已审核采购入库单选源，审核后扣减库存。",
    keywordPlaceholder: "单据编号、供应商、仓库",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billNo", title: "单据编号", width: 150, fixed: "left", visible: true },
      { field: "supplierCode", title: "供应商编码", width: 130, visible: true },
      { field: "supplier", title: "供应商名称", width: 220, visible: true },
      { field: "billDate", title: "单据日期", width: 130, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "qty", title: "退货数量", width: 110, align: "right", visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true },
      { field: "priceTaxTotal", title: "含税金额", width: 120, align: "right", visible: true },
      { field: "sourceBillNo", title: "源采购入库单", width: 170, visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true },
      { field: "remark", title: "整单备注", width: 180, visible: true },
      { field: "owner", title: "经办人", width: 120, visible: true }
    ]
  },
  "purchase-in-list": {
    title: "采购入库单",
    subtitle: "采购入库单用于验证业务列表的供应商、仓库、金额和状态列。",
    keywordPlaceholder: "单据编号、供应商、仓库",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billNo", title: "单据编号", width: 150, fixed: "left", visible: true },
      { field: "supplierCode", title: "供应商编码", width: 130, visible: true },
      { field: "supplier", title: "供应商名称", width: 220, visible: true },
      { field: "billDate", title: "单据日期", width: 130, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "qty", title: "入库数量", width: 110, align: "right", visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true },
      { field: "priceTaxTotal", title: "含税金额", width: 120, align: "right", visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true }
    ]
  },
  "purchase-in-form-list": {
    title: "采购入库单",
    subtitle: "采购入库单读取真实单据，审核后增加库存。",
    keywordPlaceholder: "单据编号、供应商、仓库",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billNo", title: "单据编号", width: 150, fixed: "left", visible: true },
      { field: "supplierCode", title: "供应商编码", width: 130, visible: true },
      { field: "supplier", title: "供应商名称", width: 220, visible: true },
      { field: "billDate", title: "单据日期", width: 130, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "qty", title: "入库数量", width: 110, align: "right", visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true },
      { field: "priceTaxTotal", title: "含税金额", width: 120, align: "right", visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true }
    ]
  },
  "purchase-summary-report": {
    title: "采购汇总表",
    subtitle: "按供应商和物料汇总采购订单、入库、退货与净采购金额。",
    keywordPlaceholder: "供应商、物料编码、物料名称",
    statuses: ["全部"],
    columns: [
      { field: "supplierCode", title: "供应商编码", width: 130, fixed: "left", visible: true },
      { field: "supplier", title: "供应商名称", width: 200, visible: true },
      { field: "productCode", title: "物料编码", width: 140, visible: true },
      { field: "productName", title: "物料名称", width: 200, visible: true },
      { field: "unit", title: "单位", width: 80, visible: true },
      { field: "netWeight", title: "净重", width: 90, align: "right", visible: false },
      { field: "grossWeight", title: "毛重", width: 90, align: "right", visible: false },
      { field: "orderQty", title: "订单数量", width: 110, align: "right", visible: true },
      { field: "inQty", title: "入库数量", width: 110, align: "right", visible: true },
      { field: "returnQty", title: "退货数量", width: 110, align: "right", visible: true },
      { field: "remainingQty", title: "未入库数量", width: 120, align: "right", visible: true },
      { field: "orderAmount", title: "订单金额", width: 120, align: "right", visible: true },
      { field: "inAmount", title: "入库金额", width: 120, align: "right", visible: true },
      { field: "returnAmount", title: "退货金额", width: 120, align: "right", visible: true },
      { field: "netPurchaseAmount", title: "净采购含税金额", width: 150, align: "right", visible: true }
    ]
  },
  "delivery-notice-form-list": {
    title: "发货通知单",
    subtitle: "发货通知单读取真实单据，审核后锁定库存，不扣减现存量。",
    keywordPlaceholder: "单据编号、客户、仓库",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billNo", title: "单据编号", width: 150, fixed: "left", visible: true },
      { field: "customerCode", title: "客户编码", width: 120, visible: true },
      { field: "customer", title: "客户名称", width: 200, visible: true },
      { field: "billDate", title: "单据日期", width: 130, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true },
      { field: "priceTaxTotal", title: "含税金额", width: 120, align: "right", visible: true },
      { field: "remark", title: "整单备注", width: 180, visible: true },
      { field: "sourceBillNo", title: "源销售订单", width: 160, visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true }
    ]
  },
  "sales-out-list": {
    title: "销售出库单",
    subtitle: "销售出库单读取真实单据，审核后减少库存。",
    keywordPlaceholder: "单据编号、客户、仓库",
    statuses: ["草稿", "已审核", "已反审核", "已红冲", "已作废"],
    columns: [
      { field: "billNo", title: "单据编号", width: 150, fixed: "left", visible: true },
      { field: "customerCode", title: "客户编码", width: 120, visible: true },
      { field: "customer", title: "客户名称", width: 200, visible: true },
      { field: "billDate", title: "单据日期", width: 130, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true },
      { field: "priceTaxTotal", title: "含税金额", width: 120, align: "right", visible: true },
      { field: "remark", title: "整单备注", width: 180, visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true }
    ]
  },
  "sales-out-form-list": {
    title: "销售出库单",
    subtitle: "销售出库单读取真实单据，审核后减少库存。",
    keywordPlaceholder: "单据编号、客户、仓库",
    statuses: ["草稿", "已审核", "已反审核", "已红冲"],
    columns: [
      { field: "billNo", title: "单据编号", width: 150, fixed: "left", visible: true },
      { field: "customerCode", title: "客户编码", width: 120, visible: true },
      { field: "customer", title: "客户名称", width: 200, visible: true },
      { field: "billDate", title: "单据日期", width: 130, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true },
      { field: "priceTaxTotal", title: "含税金额", width: 120, align: "right", visible: true },
      { field: "remark", title: "整单备注", width: 180, visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true }
    ]
  },
  "sales-return-form-list": {
    title: "销售退货单",
    subtitle: "销售退货单从已审核销售出库单选源，审核后回补原出库仓并形成冲应收与待退款事实。",
    keywordPlaceholder: "单据编号、客户、销售出库单、物料",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billNo", title: "单据编号", width: 150, fixed: "left", visible: true },
      { field: "customerCode", title: "客户编码", width: 120, visible: true },
      { field: "customer", title: "客户名称", width: 200, visible: true },
      { field: "billDate", title: "单据日期", width: 130, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "currency", title: "币种", width: 80, visible: true },
      { field: "qty", title: "退货数量", width: 110, align: "right", visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true },
      { field: "priceTaxTotal", title: "含税金额", width: 120, align: "right", visible: true },
      { field: "receivableOffsetAmount", title: "冲应收金额", width: 130, align: "right", visible: true },
      { field: "pendingRefundAmount", title: "待退款金额", width: 130, align: "right", visible: true },
      { field: "sourceBillNo", title: "源销售出库单", width: 170, visible: true },
      { field: "remark", title: "整单备注", width: 180, visible: true },
      { field: "owner", title: "经办人", width: 120, visible: true }
    ]
  },
  "inventory-query-list": {
    title: "库存查询",
    subtitle: "库存查询只展示数据库余额口径的现存量和可用量，不做业务结果缓存。",
    keywordPlaceholder: "物料编码、物料名称、仓库",
    statuses: ["正常", "低库存"],
    columns: [
      { field: "code", title: "物料编码", width: 140, fixed: "left", visible: true },
      { field: "name", title: "物料名称", width: 180, visible: true },
      { field: "spec", title: "规格型号", width: 170, visible: true },
      { field: "unit", title: "单位", width: 80, visible: true },
      { field: "netWeight", title: "净重", width: 90, align: "right", visible: false },
      { field: "grossWeight", title: "毛重", width: 90, align: "right", visible: false },
      { field: "warehouse", title: "仓库", width: 140, visible: true },
      { field: "onHand", title: "现存量", width: 110, align: "right", visible: true },
      { field: "available", title: "可用量", width: 110, align: "right", visible: true },
      { field: "status", title: "状态", width: 100, visible: true }
    ]
  },
  "stock-alert-list": {
    title: "库存预警查询表",
    subtitle: "按物料与仓库的安全库存阈值直查当前库存余额，低于安全库存或高于上限时进入预警列表。",
    keywordPlaceholder: "物料编码、物料名称、仓库",
    statuses: ["低于安全库存", "高于库存上限"],
    columns: [
      { field: "productCode", title: "物料编码", width: 140, fixed: "left", visible: true },
      { field: "productName", title: "物料名称", width: 180, visible: true },
      { field: "productCategory", title: "物料分类", width: 130, visible: true },
      { field: "warehouseName", title: "仓库名称", width: 140, visible: true },
      { field: "spec", title: "规格型号", width: 160, visible: true },
      { field: "unit", title: "基本单位", width: 90, visible: true },
      { field: "netWeight", title: "净重", width: 90, align: "right", visible: false },
      { field: "grossWeight", title: "毛重", width: 90, align: "right", visible: false },
      { field: "available", title: "可用量", width: 100, align: "right", visible: true },
      { field: "safetyQty", title: "最低安全量", width: 120, align: "right", visible: true },
      { field: "maxQty", title: "库存上限", width: 110, align: "right", visible: true },
      { field: "diffQty", title: "预警差量", width: 110, align: "right", visible: true },
      { field: "status", title: "安全库存状况", width: 140, visible: true }
    ]
  },
  "receivable-list": {
    title: "应收单",
    subtitle: "销售出库审核自动生成应收，收款后按未核销、部分核销、已核销展示。",
    keywordPlaceholder: "应收单号、源单号、客户",
    statuses: ["未核销", "部分核销", "已核销"],
    columns: [
      { field: "billNo", title: "应收单号", width: 160, fixed: "left", visible: true },
      { field: "sourceBillNo", title: "源单号", width: 150, visible: true },
      { field: "customer", title: "客户名称", width: 220, visible: true },
      { field: "billDate", title: "日期", width: 120, visible: true },
      { field: "amount", title: "应收金额", width: 120, align: "right", visible: true },
      { field: "receivedAmount", title: "已收金额", width: 120, align: "right", visible: true },
      { field: "status", title: "状态", width: 110, visible: true }
    ]
  },
  "payable-list": {
    title: "应付单",
    subtitle: "采购入库审核自动生成应付，付款后按未核销、部分核销、已核销展示。",
    keywordPlaceholder: "应付单号、源单号、供应商",
    statuses: ["未核销", "部分核销", "已核销"],
    columns: [
      { field: "billNo", title: "应付单号", width: 160, fixed: "left", visible: true },
      { field: "sourceBillNo", title: "源单号", width: 150, visible: true },
      { field: "supplier", title: "供应商名称", width: 220, visible: true },
      { field: "billDate", title: "日期", width: 120, visible: true },
      { field: "amount", title: "应付金额", width: 120, align: "right", visible: true },
      { field: "paidAmount", title: "已付金额", width: 120, align: "right", visible: true },
      { field: "status", title: "状态", width: 110, visible: true }
    ]
  },
  "ar-receipt-form-list": {
    title: "收款单列表",
    subtitle: "正式收款单按草稿保存、审核核销、反审核释放的统一生命周期管理。",
    keywordPlaceholder: "收款单号、客户、来源应收单",
    statuses: ["草稿", "已审核"],
    columns: [
      { field: "billNo", title: "收款单号", width: 160, fixed: "left", visible: true },
      { field: "partyCode", title: "客户编码", width: 130, visible: true },
      { field: "partyName", title: "客户名称", width: 210, visible: true },
      { field: "billDate", title: "日期", width: 120, visible: true },
      { field: "currency", title: "币种", width: 80, visible: true },
      { field: "amount", title: "收款金额", width: 130, align: "right", visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "version", title: "版本", width: 80, align: "right", visible: true },
      { field: "sourceCount", title: "来源数", width: 90, align: "right", visible: true },
      { field: "accountCount", title: "账户数", width: 90, align: "right", visible: true },
      { field: "legacyLabel", title: "数据来源", width: 130, visible: true },
      { field: "remark", title: "备注", width: 180, visible: true }
    ]
  },
  "ap-payment-form-list": {
    title: "付款单列表",
    subtitle: "正式付款单按草稿保存、审核核销、反审核释放的统一生命周期管理。",
    keywordPlaceholder: "付款单号、供应商、来源应付单",
    statuses: ["草稿", "已审核"],
    columns: [
      { field: "billNo", title: "付款单号", width: 160, fixed: "left", visible: true },
      { field: "partyCode", title: "供应商编码", width: 130, visible: true },
      { field: "partyName", title: "供应商名称", width: 210, visible: true },
      { field: "billDate", title: "日期", width: 120, visible: true },
      { field: "currency", title: "币种", width: 80, visible: true },
      { field: "amount", title: "付款金额", width: 130, align: "right", visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "version", title: "版本", width: 80, align: "right", visible: true },
      { field: "sourceCount", title: "来源数", width: 90, align: "right", visible: true },
      { field: "accountCount", title: "账户数", width: 90, align: "right", visible: true },
      { field: "legacyLabel", title: "数据来源", width: 130, visible: true },
      { field: "remark", title: "备注", width: 180, visible: true }
    ]
  },
  "production-plan-list": {
    title: "生产计划",
    subtitle: "生产计划只负责形成自发计划和分解生产任务，不直接领料或入库。",
    keywordPlaceholder: "计划单号、BOM、物料、生产部门",
    statuses: ["草稿", "已审核"],
    columns: [
      { field: "billNo", title: "计划单号", width: 160, fixed: "left", visible: true },
      { field: "bomCode", title: "BOM", width: 120, visible: true },
      { field: "bomVersionNo", title: "BOM版本", width: 90, visible: true },
      { field: "productCode", title: "物料编码", width: 140, visible: true },
      { field: "productName", title: "物料名称", width: 180, visible: true },
      { field: "unit", title: "单位", width: 80, visible: true },
      { field: "netWeight", title: "净重", width: 90, align: "right", visible: false },
      { field: "grossWeight", title: "毛重", width: 90, align: "right", visible: false },
      { field: "warehouse", title: "完工仓库", width: 130, visible: true },
      { field: "departmentCode", title: "生产部门", width: 120, visible: true },
      { field: "qty", title: "计划数", width: 100, align: "right", visible: true },
      { field: "planDeliveryDate", title: "交期", width: 120, visible: true },
      { field: "inProgressQty", title: "在制未完工", width: 120, align: "right", visible: true },
      { field: "assignedQty", title: "已分解数", width: 110, align: "right", visible: true },
      { field: "remainingQty", title: "未分解数", width: 110, align: "right", visible: true },
      { field: "sourceType", title: "计划来源", width: 110, visible: true },
      { field: "status", title: "状态", width: 100, visible: true }
    ]
  },
  "kit-analysis-list": {
    title: "齐套分析",
    subtitle: "齐套分析按已审核生产计划和 BOM 快照查看材料需用、可用与缺料。",
    keywordPlaceholder: "计划单号、BOM、成品、子件",
    statuses: ["齐套", "缺料"],
    columns: [
      { field: "planNo", title: "计划单号", width: 160, fixed: "left", visible: true },
      { field: "bomCode", title: "BOM", width: 120, visible: true },
      { field: "productCode", title: "成品编码", width: 140, visible: true },
      { field: "productName", title: "成品名称", width: 180, visible: true },
      { field: "materialCode", title: "子件编码", width: 140, visible: true },
      { field: "materialName", title: "子件名称", width: 180, visible: true },
      { field: "unit", title: "单位", width: 80, visible: true },
      { field: "requiredQty", title: "需求数量", width: 110, align: "right", visible: true },
      { field: "availableQty", title: "可用库存", width: 110, align: "right", visible: true },
      { field: "shortageQty", title: "缺料数量", width: 110, align: "right", visible: true },
      { field: "status", title: "齐套状态", width: 100, visible: true }
    ]
  },
  "production-task-form-list": {
    title: "生产任务单",
    subtitle: "生产任务展示 BOM、计划数、已领套数、完工数和执行状态。",
    keywordPlaceholder: "任务单号、生产计划、BOM、物料",
    statuses: ["草稿", "未领料", "部分领料", "完全领料", "已完工", "已关闭", "已冻结", "已作废"],
    columns: [
      { field: "billNo", title: "任务单号", width: 160, fixed: "left", visible: true },
      { field: "planNo", title: "来源计划", width: 160, visible: true },
      { field: "bomCode", title: "BOM", width: 120, visible: true },
      { field: "productCode", title: "物料编码", width: 130, visible: true },
      { field: "productName", title: "物料名称", width: 180, visible: true },
      { field: "unit", title: "单位", width: 80, visible: true },
      { field: "netWeight", title: "净重", width: 90, align: "right", visible: false },
      { field: "grossWeight", title: "毛重", width: 90, align: "right", visible: false },
      { field: "warehouse", title: "完工仓库", width: 130, visible: true },
      { field: "qty", title: "计划数", width: 100, align: "right", visible: true },
      { field: "issuedQty", title: "已领套数", width: 110, align: "right", visible: true },
      { field: "completedQty", title: "完工数", width: 100, align: "right", visible: true },
      { field: "status", title: "状态", width: 100, visible: true }
    ]
  },
  "material-issue-form-list": {
    title: "生产领料单",
    subtitle: "生产领料单展示来源任务、领料仓库、金额和审核/冲销状态。",
    keywordPlaceholder: "领料单号、生产任务单、仓库",
    statuses: ["草稿", "已审核", "已反审核", "已红冲"],
    columns: [
      { field: "billNo", title: "单据编号", width: 160, fixed: "left", visible: true },
      { field: "sourceOrderNo", title: "生产任务单", width: 170, visible: true },
      { field: "billDate", title: "日期", width: 120, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true }
    ]
  },
  "product-in-form-list": {
    title: "产品入库单",
    subtitle: "产品入库单展示来源任务、入库仓库、金额和审核/冲销状态。",
    keywordPlaceholder: "入库单号、生产任务单、仓库",
    statuses: ["草稿", "已审核", "已反审核", "已红冲", "已作废"],
    columns: [
      { field: "billNo", title: "单据编号", width: 160, fixed: "left", visible: true },
      { field: "sourceOrderNo", title: "生产任务单", width: 170, visible: true },
      { field: "billDate", title: "日期", width: 120, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true }
    ]
  },
  "outsourcing-work-order-list": {
    title: "委外加工单",
    subtitle: "委外加工单是 A118 委外闭环主单，后续将承载供应商、母件、BOM 子件需求和下推发料。",
    keywordPlaceholder: "委外加工单号、供应商、母件物料",
    statuses: ["草稿", "已审核", "已关闭", "已作废"],
    columns: [
      { field: "billNo", title: "单据编号", width: 170, fixed: "left", visible: true },
      { field: "sourceBillNo", title: "源产品入库单", width: 170, visible: true },
      { field: "supplierCode", title: "供应商编码", width: 130, visible: true },
      { field: "supplierName", title: "供应商名称", width: 180, visible: true },
      { field: "productCode", title: "母件物料编码", width: 150, visible: true },
      { field: "productName", title: "母件物料名称", width: 190, visible: true },
      { field: "bomCode", title: "BOM", width: 120, visible: true },
      { field: "bomVersion", title: "BOM版本", width: 110, visible: true },
      { field: "unit", title: "单位", width: 80, visible: true },
      { field: "qty", title: "委外数量", width: 110, align: "right", visible: true },
      { field: "issuedQty", title: "已发料数", width: 110, align: "right", visible: true },
      { field: "receivedQty", title: "已入库数", width: 110, align: "right", visible: true },
      { field: "planDeliveryDate", title: "预计交期", width: 120, visible: true },
      { field: "status", title: "状态", width: 100, visible: true }
    ]
  },
  "outsourcing-issue-list": {
    title: "委外发料单",
    subtitle: "委外发料单由委外加工单下推，审核后按 BOM 子件从默认仓库发出。",
    keywordPlaceholder: "委外发料单号、委外加工单、供应商、子件物料",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billNo", title: "单据编号", width: 170, fixed: "left", visible: true },
      { field: "sourceOrderNo", title: "委外加工单", width: 170, visible: true },
      { field: "supplierName", title: "供应商名称", width: 180, visible: true },
      { field: "productCode", title: "子件物料编码", width: 150, visible: true },
      { field: "productName", title: "子件物料名称", width: 190, visible: true },
      { field: "warehouse", title: "发料仓库", width: 130, visible: true },
      { field: "unit", title: "单位", width: 80, visible: true },
      { field: "qty", title: "发料数量", width: 110, align: "right", visible: true },
      { field: "status", title: "状态", width: 100, visible: true }
    ]
  },
  "outsourcing-receipt-list": {
    title: "委外产品入库单",
    subtitle: "委外产品入库单从委外加工链路选源，审核后母件入默认仓库。",
    keywordPlaceholder: "委外入库单号、委外加工单、供应商、母件物料",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billNo", title: "单据编号", width: 170, fixed: "left", visible: true },
      { field: "sourceOrderNo", title: "委外加工单", width: 170, visible: true },
      { field: "supplierName", title: "供应商名称", width: 180, visible: true },
      { field: "productCode", title: "母件物料编码", width: 150, visible: true },
      { field: "productName", title: "母件物料名称", width: 190, visible: true },
      { field: "warehouse", title: "入库仓库", width: 130, visible: true },
      { field: "unit", title: "单位", width: 80, visible: true },
      { field: "qty", title: "入库数量", width: 110, align: "right", visible: true },
      { field: "status", title: "状态", width: 100, visible: true }
    ]
  },
  "outsourcing-return-list": {
    title: "委外产品退货单",
    subtitle: "委外产品退货单来源于已审核委外产品入库单，用于不良品退回供应商。",
    keywordPlaceholder: "委外退货单号、委外入库单、供应商、母件物料",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billNo", title: "单据编号", width: 170, fixed: "left", visible: true },
      { field: "sourceOrderNo", title: "委外入库单", width: 170, visible: true },
      { field: "supplierName", title: "供应商名称", width: 180, visible: true },
      { field: "productCode", title: "母件物料编码", width: 150, visible: true },
      { field: "productName", title: "母件物料名称", width: 190, visible: true },
      { field: "warehouse", title: "退货仓库", width: 130, visible: true },
      { field: "unit", title: "单位", width: 80, visible: true },
      { field: "qty", title: "退货数量", width: 110, align: "right", visible: true },
      { field: "status", title: "状态", width: 100, visible: true }
    ]
  },
  "outsourcing-scrap-list": {
    title: "委外产品报废单",
    subtitle: "委外产品报废单来源于已审核委外产品入库单，用于确认无法退回或需内部报废的不良品。",
    keywordPlaceholder: "委外报废单号、委外入库单、供应商、母件物料",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billNo", title: "单据编号", width: 170, fixed: "left", visible: true },
      { field: "sourceOrderNo", title: "委外入库单", width: 170, visible: true },
      { field: "supplierName", title: "供应商名称", width: 180, visible: true },
      { field: "productCode", title: "母件物料编码", width: 150, visible: true },
      { field: "productName", title: "母件物料名称", width: 190, visible: true },
      { field: "warehouse", title: "报废仓库", width: 130, visible: true },
      { field: "unit", title: "单位", width: 80, visible: true },
      { field: "qty", title: "报废数量", width: 110, align: "right", visible: true },
      { field: "status", title: "状态", width: 100, visible: true }
    ]
  },
  "other-in-form-list": {
    title: "其他入库单列表",
    subtitle: "其他入库单按库存业务列表范式展示，审核后只增加库存数量。",
    keywordPlaceholder: "单据编号、物料编码、物料名称、仓库",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billDate", title: "单据日期", width: 120, visible: true },
      { field: "billNo", title: "单据编号", width: 220, visible: true },
      { field: "businessType", title: "业务类型", width: 120, visible: true },
      { field: "status", title: "审核状态", width: 100, visible: true },
      { field: "department", title: "部门", width: 120, visible: true },
      { field: "productCode", title: "物料编码", width: 130, visible: true },
      { field: "productName", title: "物料名称", width: 180, visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true },
      { field: "unit", title: "单位", width: 80, visible: true },
      { field: "netWeight", title: "净重", width: 90, align: "right", visible: false },
      { field: "grossWeight", title: "毛重", width: 90, align: "right", visible: false },
      { field: "qty", title: "数量", width: 100, align: "right", visible: true },
      { field: "unitCost", title: "单位成本", width: 110, align: "right", visible: true },
      { field: "inCost", title: "入库成本", width: 120, align: "right", visible: true }
    ]
  },
  "other-out-form-list": {
    title: "其他出库单列表",
    subtitle: "其他出库单按库存业务列表范式展示，审核后只减少库存数量。",
    keywordPlaceholder: "单据编号、物料编码、物料名称、仓库",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billDate", title: "单据日期", width: 120, visible: true },
      { field: "billNo", title: "单据编号", width: 220, visible: true },
      { field: "businessType", title: "业务类型", width: 120, visible: true },
      { field: "status", title: "审核状态", width: 100, visible: true },
      { field: "department", title: "部门", width: 120, visible: true },
      { field: "productCode", title: "物料编码", width: 130, visible: true },
      { field: "productName", title: "物料名称", width: 180, visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true },
      { field: "unit", title: "单位", width: 80, visible: true },
      { field: "netWeight", title: "净重", width: 90, align: "right", visible: false },
      { field: "grossWeight", title: "毛重", width: 90, align: "right", visible: false },
      { field: "qty", title: "数量", width: 100, align: "right", visible: true },
      { field: "unitCost", title: "单位成本", width: 110, align: "right", visible: true },
      { field: "outCost", title: "出库成本", width: 120, align: "right", visible: true }
    ]
  },
  "stock-transfer-form-list": {
    title: "调拨单列表",
    subtitle: "调拨单按库存业务列表范式展示，审核后源仓减少、目标仓增加。",
    keywordPlaceholder: "单据编号、物料编码、物料名称、源仓、目标仓",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billDate", title: "单据日期", width: 120, visible: true },
      { field: "billNo", title: "单据编号", width: 220, visible: true },
      { field: "businessType", title: "业务类型", width: 120, visible: true },
      { field: "status", title: "审核状态", width: 100, visible: true },
      { field: "department", title: "部门", width: 120, visible: true },
      { field: "productCode", title: "物料编码", width: 130, visible: true },
      { field: "productName", title: "物料名称", width: 180, visible: true },
      { field: "sourceWarehouse", title: "源仓库", width: 140, visible: true },
      { field: "targetWarehouse", title: "目标仓库", width: 140, visible: true },
      { field: "unit", title: "单位", width: 80, visible: true },
      { field: "netWeight", title: "净重", width: 90, align: "right", visible: false },
      { field: "grossWeight", title: "毛重", width: 90, align: "right", visible: false },
      { field: "qty", title: "数量", width: 100, align: "right", visible: true }
    ]
  },
  "stock-count-form-list": {
    title: "盘点单列表",
    subtitle: "盘点单展示系统库存、实盘数量和差异，审核后生成盘盈/盘亏草稿。",
    keywordPlaceholder: "单据编号、物料编码、物料名称、仓库",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billDate", title: "单据日期", width: 120, visible: true },
      { field: "billNo", title: "单据编号", width: 220, visible: true },
      { field: "businessType", title: "业务类型", width: 120, visible: true },
      { field: "status", title: "审核状态", width: 100, visible: true },
      { field: "department", title: "部门", width: 120, visible: true },
      { field: "productCode", title: "物料编码", width: 130, visible: true },
      { field: "productName", title: "物料名称", width: 180, visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true },
      { field: "unit", title: "单位", width: 80, visible: true },
      { field: "netWeight", title: "净重", width: 90, align: "right", visible: false },
      { field: "grossWeight", title: "毛重", width: 90, align: "right", visible: false },
      { field: "systemQty", title: "系统库存", width: 110, align: "right", visible: true },
      { field: "countedQty", title: "实盘数量", width: 110, align: "right", visible: true },
      { field: "diffQty", title: "差异", width: 100, align: "right", visible: true }
    ]
  },
  "stock-count-gain-form-list": {
    title: "盘盈单列表",
    subtitle: "盘盈单按库存业务列表范式展示，审核后增加库存数量。",
    keywordPlaceholder: "单据编号、源盘点单、物料编码、仓库",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billDate", title: "单据日期", width: 120, visible: true },
      { field: "billNo", title: "单据编号", width: 220, visible: true },
      { field: "sourceBillNo", title: "源盘点单", width: 180, visible: true },
      { field: "status", title: "审核状态", width: 100, visible: true },
      { field: "productCode", title: "物料编码", width: 130, visible: true },
      { field: "productName", title: "物料名称", width: 180, visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true },
      { field: "unit", title: "单位", width: 80, visible: true },
      { field: "netWeight", title: "净重", width: 90, align: "right", visible: false },
      { field: "grossWeight", title: "毛重", width: 90, align: "right", visible: false },
      { field: "qty", title: "盘盈数量", width: 110, align: "right", visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true }
    ]
  },
  "stock-count-loss-form-list": {
    title: "盘亏单列表",
    subtitle: "盘亏单按库存业务列表范式展示，审核后减少库存数量。",
    keywordPlaceholder: "单据编号、源盘点单、物料编码、仓库",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billDate", title: "单据日期", width: 120, visible: true },
      { field: "billNo", title: "单据编号", width: 220, visible: true },
      { field: "sourceBillNo", title: "源盘点单", width: 180, visible: true },
      { field: "status", title: "审核状态", width: 100, visible: true },
      { field: "productCode", title: "物料编码", width: 130, visible: true },
      { field: "productName", title: "物料名称", width: 180, visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true },
      { field: "unit", title: "单位", width: 80, visible: true },
      { field: "netWeight", title: "净重", width: 90, align: "right", visible: false },
      { field: "grossWeight", title: "毛重", width: 90, align: "right", visible: false },
      { field: "qty", title: "盘亏数量", width: 110, align: "right", visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true }
    ]
  },
  "bom-list": {
    title: "BOM维护",
    subtitle: "BOM 维护以已审核、启用、当前版本作为生产计划可用口径。",
    keywordPlaceholder: "BOM编码、母件物料编码、物料名称、BOM分类",
    statuses: ["启用", "禁用"],
    columns: [
      { field: "code", title: "BOM编码", width: 150, fixed: "left", visible: true },
      { field: "bomCategory", title: "BOM分类", width: 120, visible: true },
      { field: "productCode", title: "母件编码", width: 140, visible: true },
      { field: "productName", title: "母件名称", width: 200, visible: true },
      { field: "spec", title: "规格型号", width: 160, visible: true },
      { field: "unit", title: "单位", width: 80, visible: true },
      { field: "netWeight", title: "净重", width: 90, align: "right", visible: false },
      { field: "grossWeight", title: "毛重", width: 90, align: "right", visible: false },
      { field: "qty", title: "母件数量", width: 100, align: "right", visible: true },
      { field: "versionNo", title: "版本号", width: 90, align: "right", visible: true },
      { field: "isCurrent", title: "当前版本", width: 90, visible: true },
      { field: "auditStatus", title: "审核状态", width: 100, visible: true },
      { field: "status", title: "启用状态", width: 100, visible: true },
      { field: "updatedBy", title: "最后修改人", width: 120, visible: true },
      { field: "updatedAt", title: "最后修改时间", width: 150, visible: true },
      { field: "remark", title: "BOM备注", width: 220, visible: false }
    ]
  },
  "user-role-list": {
    title: "用户角色",
    subtitle: "角色和权限码以最小 RBAC 口径展示，后续可扩展到授权矩阵。",
    keywordPlaceholder: "角色编码、角色名称、权限码",
    statuses: ["启用", "禁用"],
    columns: [
      { field: "code", title: "角色编码", width: 150, fixed: "left", visible: true },
      { field: "name", title: "角色名称", width: 160, visible: true },
      { field: "permissions", title: "权限码", width: 520, visible: true },
      { field: "status", title: "状态", width: 100, visible: true }
    ]
  },
  "operation-log-list": {
    title: "操作日志",
    subtitle: "关键审核、冲销、核销、生产动作写入操作日志，供追溯审计。",
    keywordPlaceholder: "模块、动作、对象、时间",
    statuses: ["成功", "失败"],
    columns: [
      { field: "id", title: "日志ID", width: 280, visible: false },
      { field: "operatedAt", title: "操作时间", width: 170, visible: true },
      { field: "module", title: "模块", width: 120, visible: true },
      { field: "action", title: "动作", width: 160, visible: true },
      { field: "actorType", title: "主体类型", width: 150, visible: true },
      { field: "actorUsername", title: "操作人账号", width: 150, visible: false },
      { field: "actorDisplayName", title: "操作时姓名", width: 150, visible: false },
      { field: "accountSetId", title: "账套ID", width: 280, visible: false },
      { field: "accountSetCode", title: "账套编码", width: 120, visible: true },
      { field: "accountSetName", title: "账套名称", width: 150, visible: true },
      { field: "targetType", title: "对象类型", width: 160, visible: true },
      { field: "targetNo", title: "业务单号", width: 210, visible: true },
      { field: "operator", title: "操作人", width: 120, visible: true },
      { field: "targetId", title: "对象ID", width: 250, visible: false },
      { field: "status", title: "状态", width: 90, visible: true },
      { field: "reason", title: "失败原因", width: 180, visible: true }
    ]
  },
  "task-track-report": {
    title: "生产任务跟踪表",
    subtitle: "生产任务跟踪表只读展示任务来源、BOM、计划数、已领套数、完工数和状态。",
    keywordPlaceholder: "任务单号、生产计划、BOM、物料",
    statuses: ["未领料", "部分领料", "完全领料", "已完工"],
    columns: [
      { field: "billNo", title: "任务单号", width: 160, fixed: "left", visible: true },
      { field: "planNo", title: "来源计划", width: 160, visible: true },
      { field: "bomCode", title: "BOM", width: 120, visible: true },
      { field: "productCode", title: "物料编码", width: 130, visible: true },
      { field: "productName", title: "物料名称", width: 180, visible: true },
      { field: "unit", title: "单位", width: 80, visible: true },
      { field: "warehouse", title: "完工仓库", width: 130, visible: true },
      { field: "qty", title: "计划数", width: 100, align: "right", visible: true },
      { field: "issuedQty", title: "已领套数", width: 110, align: "right", visible: true },
      { field: "completedQty", title: "完工数", width: 100, align: "right", visible: true },
      { field: "status", title: "状态", width: 100, visible: true }
    ]
  }
};

const unavailableDefinition: ListDefinition = {
  title: "列表不可用",
  subtitle: "当前列表未定义或尚未开放。",
  keywordPlaceholder: "",
  statuses: [],
  columns: [],
  searchFields: [],
  dateField: "",
  supportsQuickDateFilter: false,
  lifecycleColumns: []
};

const definitions: Record<string, ListDefinition> = Object.fromEntries(
  Object.entries(rawDefinitions).map(([listKey, definition]) => [listKey, normalizeListDefinition(listKey, definition)])
);

function normalizeListDefinition(listKey: string, definition: RawListDefinition): ListDefinition {
  const columns = withLifecycleDisplayColumns(listKey, definition);
  const fields = columns.map((column) => column.field);
  return {
    ...definition,
    columns,
    searchFields: definition.searchFields?.length ? definition.searchFields : searchFieldsFromPlaceholder(definition.keywordPlaceholder, fields),
    dateField: definition.dateField ?? defaultDateField(listKey, fields),
    supportsQuickDateFilter: definition.supportsQuickDateFilter ?? defaultSupportsDateFilter(listKey, fields),
    lifecycleColumns: definition.lifecycleColumns ?? defaultLifecycleColumns(fields)
  };
}

function withLifecycleDisplayColumns(listKey: string, definition: RawListDefinition): ListColumn[] {
  const columns = definition.columns.map((column) => (
    listKey === "production-task-form-list" && column.field === "status"
      ? { ...column, title: "领料状态" }
      : { ...column }
  ));
  const hasColumn = (field: string) => columns.some((column) => column.field === field);
  const insertAfterStatus = (column: ListColumn) => {
    if (hasColumn(column.field)) {
      return;
    }
    const statusIndex = columns.findIndex((item) => item.field === "status");
    columns.splice(statusIndex >= 0 ? statusIndex + 1 : columns.length, 0, column);
  };
  if (listKey === "production-task-form-list") {
    [
      { field: "auditStatus", title: "审核状态", width: 100, visible: true },
      { field: "closeStatusLabel", title: "关闭状态", width: 100, visible: true },
      { field: "frozenStatusLabel", title: "冻结状态", width: 100, visible: true },
      { field: "voidStatus", title: "作废状态", width: 100, visible: true }
    ].reverse().forEach(insertAfterStatus);
    return columns;
  }
  if (definition.statuses.includes("已作废") || voidableDocumentListKeys.has(listKey)) {
    insertAfterStatus({ field: "voidStatus", title: "作废状态", width: 100, visible: true });
  }
  return columns;
}

function searchFieldsFromPlaceholder(placeholder: string, fields: string[]) {
  const aliases: Record<string, string[]> = {
    编码: ["code", "billNo", "productCode", "customerCode", "supplierCode", "warehouseCode"],
    名称: ["name", "productName", "customer", "supplier", "partner"],
    单据编号: ["billNo"],
    单号: ["billNo", "sourceBillNo"],
    客户: ["customer", "customerCode", "partner"],
    供应商: ["supplier", "supplierCode", "partner"],
    商品: ["productCode", "productName", "spec"],
    物料: ["productCode", "productName", "spec", "materialCode", "materialName"],
    仓库: ["warehouse", "warehouseCode", "warehouseName"],
    BOM: ["bomNo", "bomCode", "bomName"],
    模块: ["module"],
    动作: ["action"],
    对象: ["targetType", "targetNo"],
    时间: ["operatedAt", "billDate"]
  };
  const selected = new Set<string>();
  Object.entries(aliases).forEach(([token, mappedFields]) => {
    if (placeholder.includes(token)) {
      mappedFields.filter((field) => fields.includes(field)).forEach((field) => selected.add(field));
    }
  });
  if (!selected.size) {
    ["billNo", "code", "name", "customer", "supplier", "partner", "productCode", "productName", "spec"]
      .filter((field) => fields.includes(field))
      .forEach((field) => selected.add(field));
  }
  return Array.from(selected);
}

function defaultDateField(listKey: string, fields: string[]) {
  if (listKey === "operation-log-list" && fields.includes("operatedAt")) {
    return "operatedAt";
  }
  if (fields.includes("billDate")) {
    return "billDate";
  }
  if (fields.includes("operatedAt")) {
    return "operatedAt";
  }
  if (fields.includes("updatedAt")) {
    return "updatedAt";
  }
  return "";
}

function defaultSupportsDateFilter(listKey: string, fields: string[]) {
  if (listKey.endsWith("-master-list") || ["product-category-list", "unit-master-list", "role-list", "user-role-list"].includes(listKey)) {
    return false;
  }
  return Boolean(defaultDateField(listKey, fields));
}

function defaultLifecycleColumns(fields: string[]) {
  return ["status", "auditStatus", "closeStatusLabel", "frozenStatusLabel", "voidStatus"].filter((field) => fields.includes(field));
}

export function useDataListDefinition(listKey: () => string) {
  const billDefinition = computed(() => getBillDefinitionByListKey(listKey()));
  const definition = computed(() => {
    const metadataDefinition = billDefinition.value;
    if (metadataDefinition) {
      return normalizeListDefinition(listKey(), {
        title: `${metadataDefinition.title}列表`,
        subtitle: metadataDefinition.subtitle,
        keywordPlaceholder: metadataDefinition.keywordPlaceholder,
        statuses: metadataDefinition.statuses,
        columns: metadataDefinition.listViews.header,
        searchFields: searchFieldsFromPlaceholder(metadataDefinition.keywordPlaceholder, metadataDefinition.listViews.header.map((column) => column.field))
      });
    }
    return definitions[listKey()] ?? unavailableDefinition;
  });
  function detailColumnsForList(): ListColumn[] {
    if (!billDefinition.value && !definitions[listKey()]) {
      return [];
    }
    if (listKey() === "purchase-summary-report") {
      return definition.value.columns.map((column) => ({ ...column }));
    }
    if (listKey() === "sales-return-form-list") {
      return [
        { field: "billNo", title: "单据编号", width: 170, fixed: "left", visible: true },
        { field: "customerCode", title: "客户编码", width: 120, visible: true },
        { field: "partner", title: "客户名称", width: 180, visible: true },
        { field: "billDate", title: "单据日期", width: 120, visible: true },
        { field: "status", title: "审核状态", width: 100, visible: true },
        { field: "currency", title: "币种", width: 80, visible: true },
        { field: "receivableOffsetAmount", title: "冲应收金额", width: 130, align: "right", visible: true },
        { field: "pendingRefundAmount", title: "待退款金额", width: 130, align: "right", visible: true },
        { field: "lineNo", title: "行号", width: 80, align: "right", visible: true },
        { field: "sourceBillNo", title: "源销售出库单", width: 170, visible: true },
        { field: "sourceLineNo", title: "源行号", width: 90, align: "right", visible: true },
        { field: "productCode", title: "物料编码", width: 130, visible: true },
        { field: "productName", title: "物料名称", width: 180, visible: true },
        { field: "spec", title: "规格型号", width: 150, visible: true },
        { field: "unit", title: "单位", width: 80, visible: true },
        { field: "netWeight", title: "净重", width: 90, align: "right", visible: true },
        { field: "grossWeight", title: "毛重", width: 90, align: "right", visible: true },
        { field: "warehouse", title: "原出库仓", width: 150, visible: true },
        { field: "qty", title: "退货数量", width: 110, align: "right", visible: true },
        { field: "unitPrice", title: "单价", width: 120, align: "right", visible: true },
        { field: "taxInclusiveUnitPrice", title: "含税单价", width: 120, align: "right", visible: true },
        { field: "amount", title: "金额", width: 120, align: "right", visible: true },
        { field: "priceTaxTotal", title: "含税金额", width: 120, align: "right", visible: true },
        { field: "lineRemark", title: "行备注", width: 180, visible: true }
      ];
    }
    const metadataDefinition = billDefinition.value;
    if (metadataDefinition) {
      return metadataDefinition.listViews.detail.map((column) => ({ ...column }));
    }
    const isPurchase = listKey().includes("purchase");
    const isSales = ["sales-quote-form-list", "sales-order-form-list", "delivery-notice-form-list", "sales-out-list", "sales-out-form-list"].includes(listKey());
    const showsSourceColumns = [
      "sales-order-form-list",
      "delivery-notice-form-list",
      "sales-out-list",
      "sales-out-form-list",
      "purchase-in-list",
      "purchase-in-form-list",
      "purchase-return-form-list"
    ].includes(listKey());
    const partyCodeColumn: ListColumn[] = isPurchase || isSales
      ? [{ field: isPurchase ? "supplierCode" : "customerCode", title: isPurchase ? "供应商编码" : "客户编码", width: 120, visible: true }]
      : [];
    const customerOnlyColumns: ListColumn[] = isSales
      ? [
          { field: "customerMaterialCode", title: "客户物料编码", width: 150, visible: true },
          { field: "customerOrderNo", title: "客户订单号", width: 150, visible: true },
          { field: "planDeliveryDate", title: "预计交期", width: 120, visible: true }
        ]
      : [];
    const supplierOnlyColumns: ListColumn[] = listKey() === "purchase-order-form-list"
      ? [
          { field: "supplierMaterialCode", title: "供应商物料编码", width: 150, visible: true },
          { field: "planDeliveryDate", title: "预计交期", width: 120, visible: true }
        ]
      : [];
    const sourceColumns: ListColumn[] = showsSourceColumns
      ? [
          { field: "sourceBillNo", title: "源单号", width: 170, visible: true },
          { field: "sourceLineNo", title: "源行号", width: 90, align: "right", visible: true }
        ]
      : [];
    return [
      { field: "billNo", title: "单据编号", width: 170, fixed: "left", visible: true },
      ...partyCodeColumn,
      { field: "partner", title: isPurchase ? "供应商名称" : "客户名称", width: 180, visible: true },
      ...customerOnlyColumns.slice(0, 2),
      { field: "billDate", title: "单据日期", width: 120, visible: true },
      ...customerOnlyColumns.slice(2),
      ...supplierOnlyColumns,
      { field: "status", title: "审核状态", width: 100, visible: true },
      { field: "lineNo", title: "行号", width: 80, align: "right", visible: true },
      { field: "productCode", title: "物料编码", width: 130, visible: true },
      { field: "productName", title: "物料名称", width: 180, visible: true },
      { field: "spec", title: "规格型号", width: 150, visible: true },
      { field: "unit", title: "单位", width: 80, visible: true },
      { field: "netWeight", title: "净重", width: 90, align: "right", visible: true },
      { field: "grossWeight", title: "毛重", width: 90, align: "right", visible: true },
      { field: "warehouse", title: "仓库", width: 150, visible: true },
      { field: "qty", title: "数量", width: 110, align: "right", visible: true },
      ...(listKey() === "sales-order-form-list" ? [
        { field: "shippedQty", title: "已出库数量", width: 120, align: "right", visible: true },
        { field: "remainingQty", title: "未出库数量", width: 120, align: "right", visible: true }
      ] satisfies ListColumn[] : []),
      ...(listKey() === "purchase-order-form-list" ? [
        { field: "receivedQty", title: "已入库数量", width: 120, align: "right", visible: true },
        { field: "remainingQty", title: "未入库数量", width: 120, align: "right", visible: true }
      ] satisfies ListColumn[] : []),
      { field: "unitPrice", title: "单价", width: 120, align: "right", visible: true },
      { field: "taxInclusiveUnitPrice", title: "含税单价", width: 120, align: "right", visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true },
      { field: "priceTaxTotal", title: "含税金额", width: 120, align: "right", visible: true },
      { field: "lineRemark", title: "行备注", width: 180, visible: true },
      ...sourceColumns
    ];
  }

  return {
    billDefinition,
    definition,
    detailColumnsForList
  };
}
