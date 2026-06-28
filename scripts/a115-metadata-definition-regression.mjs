import { readFileSync } from "node:fs";

const source = readFileSync("frontend/src/modules/metadata/bills/sales.ts", "utf8");
const fragments = readFileSync("frontend/src/modules/metadata/fragments.ts", "utf8");
const entryTable = readFileSync("frontend/src/components/EntryTable.vue", "utf8");
const dataListPage = readFileSync("frontend/src/components/DataListPage.vue", "utf8");
const documentModule = readFileSync("frontend/src/modules/documents/useDocumentModule.ts", "utf8");
const masterDataRegistry = readFileSync("frontend/src/modules/master-data/registry.ts", "utf8");
const masterDataTypes = readFileSync("frontend/src/modules/master-data/types.ts", "utf8");
const masterDataRecordPage = readFileSync("frontend/src/modules/master-data/MasterDataRecordPage.vue", "utf8");
const productMasterFields = readFileSync("frontend/src/modules/master-data/product/fields.ts", "utf8");
const customerMasterFields = readFileSync("frontend/src/modules/master-data/customer/fields.ts", "utf8");
const supplierMasterFields = readFileSync("frontend/src/modules/master-data/supplier/fields.ts", "utf8");
const warehouseMasterFields = readFileSync("frontend/src/modules/master-data/warehouse/fields.ts", "utf8");
const purchaseOrderForm = readFileSync("frontend/src/modules/purchase/purchase-order/PurchaseOrderForm.vue", "utf8");
const purchaseOrderDocument = readFileSync("frontend/src/modules/purchase/purchase-order/usePurchaseOrderDocument.ts", "utf8");
const listStubController = readFileSync("backend/src/main/java/com/jdy/erp/system/api/ListStubController.java", "utf8");
const purchaseOrderAppService = readFileSync("backend/src/main/java/com/jdy/erp/purchase/application/PurchaseOrderAppService.java", "utf8");
const priceTaxBackfillMigration = readFileSync("backend/src/main/resources/db/migration/V63__backfill_price_tax_totals.sql", "utf8");
const purchaseOrderSupplierMaterialMigration = readFileSync("backend/src/main/resources/db/migration/V65__purchase_order_supplier_material_and_delivery_date.sql", "utf8");
const productDisplaySnapshotMigration = readFileSync("backend/src/main/resources/db/migration/V66__product_display_snapshots.sql", "utf8");
const productSnapshotService = readFileSync("backend/src/main/java/com/jdy/erp/shared/application/ProductSnapshotService.java", "utf8");
const documentOutputController = readFileSync("backend/src/main/java/com/jdy/erp/reports/api/DocumentOutputController.java", "utf8");
const conversionService = readFileSync("backend/src/main/java/com/jdy/erp/shared/application/ConversionService.java", "utf8");
const productSnapshotWriteServices = [
  "backend/src/main/java/com/jdy/erp/sales/application/SalesQuoteAppService.java",
  "backend/src/main/java/com/jdy/erp/sales/application/SalesOrderAppService.java",
  "backend/src/main/java/com/jdy/erp/sales/application/DeliveryNoticeAppService.java",
  "backend/src/main/java/com/jdy/erp/sales/application/SalesOutAppService.java",
  "backend/src/main/java/com/jdy/erp/purchase/application/PurchaseOrderAppService.java",
  "backend/src/main/java/com/jdy/erp/purchase/application/PurchaseInAppService.java",
  "backend/src/main/java/com/jdy/erp/purchase/application/PurchaseReturnAppService.java",
  "backend/src/main/java/com/jdy/erp/inventory/application/OtherStockInAppService.java",
  "backend/src/main/java/com/jdy/erp/inventory/application/OtherStockOutAppService.java",
  "backend/src/main/java/com/jdy/erp/inventory/application/StockTransferAppService.java",
  "backend/src/main/java/com/jdy/erp/inventory/application/StockCountAppService.java",
  "backend/src/main/java/com/jdy/erp/inventory/application/StockCountGainAppService.java",
  "backend/src/main/java/com/jdy/erp/inventory/application/StockCountLossAppService.java",
  "backend/src/main/java/com/jdy/erp/production/application/ProductionTaskAppService.java",
  "backend/src/main/java/com/jdy/erp/production/application/MaterialIssueAppService.java",
  "backend/src/main/java/com/jdy/erp/production/application/ProductInAppService.java"
].map((path) => readFileSync(path, "utf8")).join("\n");

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
assertContains(
  masterDataTypes,
  /interface MasterDataField[\s\S]*?readonly\?:\s*boolean[\s\S]*?interface MasterDataDefinition[\s\S]*?listColumns:\s*ListColumnDefinition\[\][\s\S]*?selectorColumns:\s*ListColumnDefinition\[\]/,
  "主数据定义必须集中维护列表列和选择器列，并支持全程只读字段"
);
assertContains(
  dataListPage,
  /masterListDefinitions[\s\S]*?Object\.entries\(masterDataDefinitions\)[\s\S]*?columns:\s*masterDefinition\.listColumns/,
  "主数据列表必须从 MasterDataDefinition 读取列定义，不能继续在 DataListPage 里散写四套列"
);
assertContains(
  masterDataRegistry,
  /"product-master-list"[\s\S]*?title:\s*"物料资料"[\s\S]*?field:\s*"code",\s*title:\s*"物料编码"[\s\S]*?field:\s*"id",\s*title:\s*"系统ID"[\s\S]*?field:\s*"productType",\s*title:\s*"物料属性"[\s\S]*?field:\s*"isPurchase",\s*title:\s*"可采购"[\s\S]*?field:\s*"isProduce",\s*title:\s*"可自制"[\s\S]*?field:\s*"defaultWorkshop",\s*title:\s*"默认生产车间"[\s\S]*?field:\s*"defaultSupplierCode",\s*title:\s*"默认供应商"/,
  "物料资料必须是本批核心主数据，包含系统ID、物料属性、业务能力和默认业务属性"
);
assertContains(
  productMasterFields,
  /label:\s*"系统ID"[\s\S]*?readonly:\s*true[\s\S]*?label:\s*"物料编码"[\s\S]*?label:\s*"物料属性"[\s\S]*?label:\s*"可采购"[\s\S]*?label:\s*"可销售"[\s\S]*?label:\s*"可库存"[\s\S]*?label:\s*"可自制"[\s\S]*?label:\s*"可委外"[\s\S]*?label:\s*"默认生产车间"[\s\S]*?label:\s*"成本价"/,
  "物料建档页必须包含只读系统ID和一物料多业务面的核心字段"
);
assertContains(
  masterDataRecordPage,
  /:disabled="field\.readonly \|\| \(editing && field\.readonlyWhenEditing\)"/,
  "主数据建档页必须让 readonly 字段全程不可编辑"
);
assertContains(
  masterDataRegistry,
  /selectorColumns:\s*\[\s*\{ field:\s*"code",\s*title:\s*"物料编码"/,
  "物料选择器必须以物料编码开头，系统ID不得成为用户选择物料的主要字段"
);
assertNotContains(
  masterDataRegistry,
  /selectorColumns:\s*\[[\s\S]*?\{ field:\s*"id",\s*title:\s*"系统ID"/,
  "物料选择器不得暴露系统ID，搜索显示仍以物料编码/物料名称为主"
);
for (const tableName of [
  "sales_quote_line",
  "sales_order_line",
  "delivery_notice_line",
  "sales_out_line",
  "purchase_order_line",
  "purchase_in_line",
  "purchase_return_line",
  "other_stock_in_line",
  "other_stock_out_line",
  "stock_transfer_line",
  "stock_count_line",
  "stock_count_gain_line",
  "stock_count_loss_line",
  "production_plan",
  "production_task",
  "production_task_material_snapshot",
  "production_material_issue_line",
  "production_completion_line"
]) {
  assertContains(
    productDisplaySnapshotMigration,
    new RegExp(`ALTER TABLE ${tableName}[\\s\\S]*?product_code_snapshot[\\s\\S]*?product_name_snapshot[\\s\\S]*?product_spec_snapshot[\\s\\S]*?UPDATE ${tableName}`),
    `${tableName} 必须落库并回填物料编码/名称/规格显示快照`
  );
}
assertContains(
  productSnapshotService,
  /resolve\(String productId,\s*String productCode[\s\S]*?return byId\(productId\.trim\(\), label\)[\s\S]*?return byCode\(productCode\.trim\(\), label\)[\s\S]*?WHERE id = \?::uuid/,
  "ProductSnapshotService 必须优先用系统ID解析物料快照，并兼容旧编码录入"
);
assertContains(
  documentModule,
  /documentLines:\s*\{[\s\S]*?productId\?:\s*string[\s\S]*?productId:\s*String\(line\.productId[\s\S]*?productId:\s*String\(line\.productId \?\? ""\)\.trim\(\) \|\| undefined/,
  "共享单据模块保存分录必须携带 productId，不能只传 productCode"
);
assertContains(
  `${listStubController}\n${documentOutputController}`,
  /COALESCE\(l\.product_code_snapshot,\s*p\.code\) AS "productCode"[\s\S]*?COALESCE\(l\.product_name_snapshot,\s*p\.name\) AS "productName"[\s\S]*?COALESCE\(l\.product_spec_snapshot,\s*p\.spec,\s*''\) AS spec/,
  "列表、详情和打印必须优先显示单据行保存时的物料快照"
);
assertContains(
  productSnapshotWriteServices,
  /ProductSnapshotService[\s\S]*?productSnapshotService\.resolve[\s\S]*?product_code_snapshot[\s\S]*?product_name_snapshot[\s\S]*?product_spec_snapshot/,
  "单据保存服务必须通过 ProductSnapshotService 写入物料显示快照"
);
for (const tableName of [
  "sales_quote_line",
  "sales_order_line",
  "delivery_notice_line",
  "sales_out_line",
  "purchase_order_line",
  "purchase_in_line",
  "purchase_return_line",
  "other_stock_in_line",
  "other_stock_out_line",
  "stock_transfer_line",
  "stock_count_line",
  "stock_count_gain_line",
  "stock_count_loss_line",
  "production_plan",
  "production_task",
  "production_task_material_snapshot",
  "production_material_issue_line",
  "production_completion_line"
]) {
  assertContains(
    productSnapshotWriteServices,
    new RegExp(`INSERT INTO ${tableName}[\\s\\S]*?product_code_snapshot[\\s\\S]*?product_name_snapshot[\\s\\S]*?product_spec_snapshot`),
    `${tableName} 新增/保存时必须写入物料显示快照`
  );
}
assertContains(
  conversionService,
  /product_code_snapshot[\s\S]*?product_name_snapshot[\s\S]*?product_spec_snapshot[\s\S]*?INSERT INTO %s[\s\S]*?product_code_snapshot[\s\S]*?product_name_snapshot[\s\S]*?product_spec_snapshot/,
  "盘点下推生成盘盈/盘亏时必须复制源盘点行物料快照"
);
assertContains(
  customerMasterFields,
  /客户编码[\s\S]*?客户名称[\s\S]*?联系人[\s\S]*?电话[\s\S]*?地区[\s\S]*?地址[\s\S]*?状态[\s\S]*?备注/,
  "客户资料本批只做轻主档字段"
);
assertNotContains(
  customerMasterFields,
  /信用额度|结算方式|税号|客户等级|负责业务员/,
  "客户资料在应收应付未深入前不能暴露信用、结算、税务等后置项"
);
assertContains(
  supplierMasterFields,
  /供应商编码[\s\S]*?供应商名称[\s\S]*?联系人[\s\S]*?电话[\s\S]*?地址[\s\S]*?状态[\s\S]*?备注/,
  "供应商资料本批只做轻主档字段"
);
assertNotContains(
  supplierMasterFields,
  /银行账号|结算方式|税号|供应商等级|采购负责人/,
  "供应商资料在应付、付款和质量准入未深入前不能暴露银行、结算、税务等后置项"
);
assertContains(
  warehouseMasterFields,
  /仓库编码[\s\S]*?仓库名称[\s\S]*?仓库类型[\s\S]*?仓管员[\s\S]*?仓库地址[\s\S]*?状态[\s\S]*?备注/,
  "仓库资料本批只做新建、状态管理和移仓引用所需字段"
);
assertNotContains(
  warehouseMasterFields,
  /库存策略|允许负库存/,
  "仓库资料暂不暴露库存策略和负库存配置"
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
