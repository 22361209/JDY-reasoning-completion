import type { ReportDefinition } from "./reportTypes";

export const inventoryMovementReport: ReportDefinition = {
  entryId: "inventory-movement-detail",
  reportKey: "inventory-movement-detail",
  title: "商品收发明细",
  module: "库存管理",
  permission: "inventory.stock.view",
  description: "按业务日期查询正式库存流水；历史业务日期缺失时明确标注记账日期降级。",
  defaultSortField: "businessDate",
  defaultSortOrder: "desc",
  filters: [
    { parameter: "sourceType", label: "来源类型", placeholder: "如 SALES_OUT" },
    { parameter: "sourceBillNo", label: "来源单号", placeholder: "输入完整或部分单号" },
    { parameter: "product", label: "商品", placeholder: "商品编码、名称或规格" },
    { parameter: "warehouse", label: "仓库", placeholder: "仓库编码或名称" }
  ],
  totals: {
    groupKeys: ["productCode", "productName", "unit"],
    valueKeys: ["inboundQty", "outboundQty"]
  },
  columns: [
    { key: "businessDate", title: "业务日期", width: 128, minWidth: 112, fixed: "left", configurable: false, sortField: "businessDate", format: "date-basis" },
    { key: "productCode", title: "商品编码", width: 132, minWidth: 108, fixed: "left", sortField: "productCode" },
    { key: "productName", title: "商品名称", width: 180, minWidth: 130 },
    { key: "productSpec", title: "规格型号", width: 150, minWidth: 110 },
    { key: "unit", title: "单位", width: 76, minWidth: 64, align: "center" },
    { key: "warehouseCode", title: "仓库编码", width: 112, minWidth: 96, sortField: "warehouseCode" },
    { key: "warehouseName", title: "仓库名称", width: 150, minWidth: 110 },
    { key: "inboundQty", title: "入库数量", width: 112, minWidth: 96, align: "right", format: "quantity" },
    { key: "outboundQty", title: "出库数量", width: 112, minWidth: 96, align: "right", format: "quantity" },
    { key: "qtyOnHandAfter", title: "结存数量", width: 180, minWidth: 150, align: "right", format: "quantity" },
    { key: "sourceTypeLabel", title: "来源类型", width: 126, minWidth: 104 },
    { key: "sourceBillNo", title: "来源单号", width: 168, minWidth: 130, sortField: "sourceBillNo", format: "source-link" },
    { key: "postingAction", title: "过账动作", width: 108, minWidth: 92, align: "center", format: "posting-action" },
    { key: "traceQuality", title: "追溯状态", width: 126, minWidth: 104, align: "center", format: "trace-quality" },
    { key: "occurredAt", title: "记账时间", width: 176, minWidth: 150, visible: false, sortField: "occurredAt", format: "text" }
  ]
};
