import { readFileSync } from "node:fs";

const source = readFileSync("frontend/src/modules/metadata/bills/sales.ts", "utf8");
const fragments = readFileSync("frontend/src/modules/metadata/fragments.ts", "utf8");
const entryTable = readFileSync("frontend/src/components/EntryTable.vue", "utf8");
const dataListPage = readFileSync("frontend/src/components/DataListPage.vue", "utf8");
const documentModule = readFileSync("frontend/src/modules/documents/useDocumentModule.ts", "utf8");
const purchaseOrderForm = readFileSync("frontend/src/modules/purchase/purchase-order/PurchaseOrderForm.vue", "utf8");
const purchaseOrderDocument = readFileSync("frontend/src/modules/purchase/purchase-order/usePurchaseOrderDocument.ts", "utf8");
const listStubController = readFileSync("backend/src/main/java/com/jdy/erp/system/api/ListStubController.java", "utf8");
const purchaseOrderAppService = readFileSync("backend/src/main/java/com/jdy/erp/purchase/application/PurchaseOrderAppService.java", "utf8");
const priceTaxBackfillMigration = readFileSync("backend/src/main/resources/db/migration/V63__backfill_price_tax_totals.sql", "utf8");
const purchaseOrderSupplierMaterialMigration = readFileSync("backend/src/main/resources/db/migration/V65__purchase_order_supplier_material_and_delivery_date.sql", "utf8");

function assertContains(text, pattern, message) {
  if (!pattern.test(text)) {
    throw new Error(message);
  }
}

function assertNotContains(text, pattern, message) {
  if (pattern.test(text)) {
    throw new Error(message);
  }
}

assertContains(
  source,
  /salesQuoteBillDefinition[\s\S]*?sourcePolicy:\s*"none"/,
  "销售报价单必须声明 sourcePolicy=none"
);
assertContains(
  source,
  /salesQuoteBillDefinition[\s\S]*?entryColumns:\s*salesQuoteEntryColumns[\s\S]*?detail:\s*salesQuoteDetailColumns[\s\S]*?toolbarActions/,
  "销售报价单必须使用不含预计交期/源单列的报价单分录与明细定义"
);
assertContains(
  source,
  /salesOrderBillDefinition[\s\S]*?sourcePolicy:\s*"salesQuote"/,
  "销售订单必须声明 sourcePolicy=salesQuote"
);
assertContains(
  source,
  /salesOrderBillDefinition[\s\S]*?detail:\s*\[\.\.\.salesOrderDetailColumns,\s*\.\.\.sourceDetailColumns\]/,
  "销售订单明细视图应显示源单列"
);
assertContains(
  source,
  /key:\s*"sourceSelect"[\s\S]*?sourcePolicy:\s*"salesQuote"/,
  "销售订单选源单动作必须指向销售报价单"
);
assertContains(
  source,
  /salesOrderBillDefinition[\s\S]*?header:\s*\[[\s\S]*?field:\s*"remark",\s*title:\s*"整单备注"[\s\S]*?owner/,
  "销售订单整单视图必须显示整单备注"
);
assertContains(
  source,
  /salesOrderBillDefinition[\s\S]*?header:\s*\[[\s\S]*?identityListColumns\[1\][\s\S]*?status[\s\S]*?outStatus[\s\S]*?field:\s*"qty",\s*title:\s*"数量"[\s\S]*?field:\s*"shippedQty",\s*title:\s*"已出库数量"[\s\S]*?field:\s*"remainingQty",\s*title:\s*"未出库数量"[\s\S]*?amountListColumns[\s\S]*?priceTaxTotalListColumn[\s\S]*?remark[\s\S]*?owner[\s\S]*?\]/,
  "销售订单整单视图必须显示数量/已出库数量/未出库数量/金额/含税金额，且不显示预计交期"
);
assertContains(
  fragments,
  /salesDetailBaseColumns[\s\S]*?field:\s*"customerMaterialCode",\s*title:\s*"客户物料编码"[\s\S]*?field:\s*"customerOrderNo",\s*title:\s*"客户订单号"[\s\S]*?field:\s*"unitPrice",\s*title:\s*"单价"[\s\S]*?field:\s*"taxInclusiveUnitPrice",\s*title:\s*"含税单价"[\s\S]*?field:\s*"priceTaxTotal",\s*title:\s*"含税金额"[\s\S]*?field:\s*"lineRemark",\s*title:\s*"行备注"/,
  "销售明细视图必须同时包含客户物料编码、客户订单号、单价、含税单价、含税金额、行备注"
);
assertContains(
  fragments,
  /salesEntryColumns[\s\S]*?field:\s*"customerMaterialCode",\s*title:\s*"客户物料编码"[\s\S]*?field:\s*"customerOrderNo",\s*title:\s*"客户订单号"[\s\S]*?field:\s*"unitPrice",\s*title:\s*"单价"[\s\S]*?field:\s*"taxInclusiveUnitPrice",\s*title:\s*"含税单价"[\s\S]*?field:\s*"priceTaxTotal",\s*title:\s*"含税金额"[\s\S]*?field:\s*"planDeliveryDate",\s*title:\s*"预计交期"[\s\S]*?field:\s*"lineRemark",\s*title:\s*"行备注"/,
  "销售分录列必须统一客户物料编码、客户订单号、单价、含税单价、含税金额、预计交期、行备注文案"
);
assertContains(
  fragments,
  /salesQuoteEntryColumns[\s\S]*?filter\(\(column\)\s*=>\s*column\.field\s*!==\s*"planDeliveryDate"\)/,
  "销售报价单分录不能显示预计交期"
);
assertContains(
  entryTable,
  /showPartyCodeColumn[\s\S]*?showCustomerMaterialCodeColumn[\s\S]*?showSupplierMaterialCodeColumn[\s\S]*?showCustomerOrderNoColumn[\s\S]*?title:\s*"客户物料编码"[\s\S]*?title:\s*"供应商物料编码"[\s\S]*?title:\s*"客户订单号"[\s\S]*?title:\s*"单价"[\s\S]*?title:\s*"含税单价"/,
  "共享分录表必须支持隐藏客户编码，并区分客户物料编码/供应商物料编码/客户订单号/双单价"
);
assertContains(
  entryTable,
  /:columns="configurableColumns"[\s\S]*?const configurableColumns = computed\(\(\) => columns\.value\.filter\(\(column\) => column\.configurable !== false && isColumnAvailable\(column\)\)\)/,
  "分录列设置只能展示当前单据真实可用列，避免勾选项和实际表格不一致"
);
assertContains(
  entryTable,
  /function advanceLineCellOnEnter[\s\S]*?editableCellOrder\(\)[\s\S]*?emit\("insertLineAfter", lineIndex\)/,
  "分录回车导航必须按可编辑列顺序完成后才新增/进入下一行"
);
assertContains(
  dataListPage,
  /listSummaryFields[\s\S]*?"qty"[\s\S]*?"shippedQty"[\s\S]*?"receivedQty"[\s\S]*?"remainingQty"[\s\S]*?"amount"[\s\S]*?"priceTaxTotal"[\s\S]*?hasListSummary/,
  "列表汇总必须是通用能力，覆盖数量/已出库/已入库/未出库或未入库/金额/含税金额"
);
assertContains(
  dataListPage,
  /listSummaryFooterValue\(column\.key\)[\s\S]*?function listSummaryFooterValue[\s\S]*?listSummaryTotals/,
  "列表汇总行必须调用通用 footer 取值函数"
);
assertContains(
  dataListPage,
  /"purchase-order-form-list"[\s\S]*?field:\s*"qty",\s*title:\s*"数量"[\s\S]*?field:\s*"receivedQty",\s*title:\s*"已入库数量"[\s\S]*?field:\s*"remainingQty",\s*title:\s*"未入库数量"[\s\S]*?field:\s*"amount",\s*title:\s*"金额"[\s\S]*?field:\s*"priceTaxTotal",\s*title:\s*"含税金额"[\s\S]*?"purchase-return-form-list"[\s\S]*?field:\s*"qty",\s*title:\s*"退货数量"[\s\S]*?field:\s*"priceTaxTotal",\s*title:\s*"含税金额"[\s\S]*?"purchase-in-list"[\s\S]*?field:\s*"qty",\s*title:\s*"入库数量"[\s\S]*?field:\s*"amount",\s*title:\s*"金额"[\s\S]*?field:\s*"priceTaxTotal",\s*title:\s*"含税金额"/,
  "采购订单列表必须显示数量/已入库/未入库，采购入库和采购退货列表必须显示数量/金额/含税金额"
);
assertContains(
  dataListPage,
  /props\.listKey\s*===\s*"purchase-order-form-list"[\s\S]*?field:\s*"receivedQty",\s*title:\s*"已入库数量"[\s\S]*?field:\s*"remainingQty",\s*title:\s*"未入库数量"/,
  "采购订单明细视图必须显示已入库数量和未入库数量"
);
assertContains(
  dataListPage,
  /props\.listKey\s*===\s*"purchase-order-form-list"[\s\S]*?field:\s*"supplierMaterialCode",\s*title:\s*"供应商物料编码"[\s\S]*?field:\s*"planDeliveryDate",\s*title:\s*"预计交期"/,
  "采购订单明细视图必须显示供应商物料编码和预计交期"
);
assertContains(
  dataListPage,
  /function toggleDetailView\(\)[\s\S]*?saveDetailViewPreference\(\)[\s\S]*?function detailViewPreferenceKey\(\)[\s\S]*?jdy:list-view:\$\{props\.listKey\}[\s\S]*?function loadDetailViewPreference\(\)/,
  "整单/明细视图切换必须按列表入口记忆"
);
assertContains(
  `${documentModule}\n${purchaseOrderForm}\n${purchaseOrderDocument}`,
  /showSupplierMaterialCodeColumn[\s\S]*?showPlanDeliveryDateColumn[\s\S]*?purchaseOrder[\s\S]*?documentType:\s*"purchaseOrder"[\s\S]*?showSupplierMaterialCodeColumn:\s*true/,
  "采购订单表单必须开启供应商物料编码列，并支持采购订单分录预计交期"
);
assertContains(
  listStubController,
  /documentDetailRows[\s\S]*?sales-quote-form-list[\s\S]*?AS "priceTaxTotal"[\s\S]*?sales-order-form-list[\s\S]*?AS "priceTaxTotal"[\s\S]*?purchase-order-form-list[\s\S]*?AS "priceTaxTotal"[\s\S]*?sales-out-list[\s\S]*?AS "priceTaxTotal"[\s\S]*?delivery-notice-form-list[\s\S]*?AS "priceTaxTotal"[\s\S]*?purchase-in-list[\s\S]*?AS "priceTaxTotal"/,
  "核心单据明细列表 API 必须返回含税金额 priceTaxTotal"
);
assertContains(
  listStubController,
  /purchase-order-form-list[\s\S]*?AS "supplierMaterialCode"[\s\S]*?AS "taxInclusiveUnitPrice"[\s\S]*?AS "taxRate"[\s\S]*?AS "priceTaxTotal"/,
  "采购订单明细列表 API 必须返回供应商物料编码、含税单价、税率和含税金额"
);
assertContains(
  listStubController,
  /purchase-order-form-list[\s\S]*?AS qty[\s\S]*?AS "receivedQty"[\s\S]*?AS "remainingQty"[\s\S]*?AS "unitPrice"/,
  "采购订单明细列表 API 必须返回数量/已入库数量/未入库数量"
);
assertContains(
  listStubController,
  /purchaseOrderRows[\s\S]*?AS qty[\s\S]*?AS "receivedQty"[\s\S]*?AS "remainingQty"[\s\S]*?AS amount/,
  "采购订单整单列表 API 必须返回数量/已入库数量/未入库数量"
);
assertContains(
  listStubController,
  /purchaseInRows[\s\S]*?AS qty[\s\S]*?AS amount[\s\S]*?AS "priceTaxTotal"[\s\S]*?purchaseReturnRows[\s\S]*?AS qty[\s\S]*?AS amount[\s\S]*?AS "priceTaxTotal"/,
  "采购入库/采购退货整单列表 API 必须返回数量/金额/含税金额"
);
assertContains(
  listStubController,
  /purchaseSummaryRows[\s\S]*?order_lines[\s\S]*?in_lines[\s\S]*?return_lines[\s\S]*?"netPurchaseAmount"/,
  "采购汇总表必须聚合采购订单、采购入库和采购退货"
);
assertContains(
  dataListPage,
  /"purchase-summary-report"[\s\S]*?field:\s*"orderQty"[\s\S]*?field:\s*"inQty"[\s\S]*?field:\s*"returnQty"[\s\S]*?field:\s*"netPurchaseAmount"/,
  "采购汇总表前端必须显示订单/入库/退货/净采购金额字段"
);
assertContains(
  listStubController,
  /salesRows[\s\S]*?AS "priceTaxTotal"[\s\S]*?purchaseOrderRows[\s\S]*?AS "priceTaxTotal"[\s\S]*?salesQuoteRows[\s\S]*?AS "priceTaxTotal"[\s\S]*?purchaseInRows[\s\S]*?AS "priceTaxTotal"[\s\S]*?salesOutRows[\s\S]*?AS "priceTaxTotal"[\s\S]*?deliveryNoticeRows[\s\S]*?AS "priceTaxTotal"/,
  "核心单据整单列表 API 必须返回含税金额 priceTaxTotal"
);
assertContains(
  priceTaxBackfillMigration,
  /UPDATE sales_quote_line[\s\S]*?price_tax_total[\s\S]*?UPDATE sales_order_line[\s\S]*?price_tax_total[\s\S]*?UPDATE delivery_notice_line[\s\S]*?price_tax_total[\s\S]*?UPDATE sales_out_line[\s\S]*?price_tax_total[\s\S]*?UPDATE purchase_order_line[\s\S]*?price_tax_total[\s\S]*?UPDATE purchase_in_line[\s\S]*?price_tax_total/,
  "V63 必须回填核心单据历史分录含税金额"
);
assertContains(
  purchaseOrderSupplierMaterialMigration,
  /ALTER TABLE purchase_order_line[\s\S]*?supplier_material_code[\s\S]*?plan_delivery_date/,
  "采购订单分录必须落库供应商物料编码和预计交期"
);
assertContains(
  purchaseOrderAppService,
  /supplier_material_code[\s\S]*?"supplierMaterialCode"[\s\S]*?plan_delivery_date[\s\S]*?"planDeliveryDate"[\s\S]*?INSERT INTO purchase_order_line[\s\S]*?supplier_material_code[\s\S]*?plan_delivery_date/,
  "采购订单详情、选源和保存必须贯通供应商物料编码与预计交期"
);
assertContains(
  dataListPage,
  /class="list-table-tools"[\s\S]*?data-testid="list-detail-view-toggle"[\s\S]*?data-testid="column-settings"[\s\S]*?data-testid="list-refresh-stock"/,
  "整单/明细视图切换、列设置、更新库存必须集中在列表右侧工具区"
);
assertNotContains(
  `${source}\n${fragments}\n${entryTable}`,
  /不含税单价/,
  "销售单据默认单价文案不得再使用“不含税单价”，应统一为“单价”"
);
assertNotContains(
  `${source}\n${fragments}\n${entryTable}`,
  /价税合计/,
  "销售单据金额文案不得再使用“价税合计”，应统一为“含税金额”"
);

console.log("A115 metadata definition regression passed");
