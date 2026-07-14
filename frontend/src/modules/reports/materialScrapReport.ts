import type { ReportDefinition } from "./reportTypes";

/**
 * F061 is a quantity-only report. The server groups by workshop identity,
 * product identity and unit snapshot; the browser never invents currency or
 * adds quantities across different units.
 */
export const materialScrapReport: ReportDefinition = {
  entryId: "material-scrap-summary",
  reportKey: "material-scrap-summary",
  title: "材料报废统计表",
  module: "生产管理",
  permission: "production.document.audit",
  description: "只统计已审核材料报废单；按生产车间、商品和单位快照汇总，不跨单位合计。",
  defaultSortField: "workshopCode",
  defaultSortOrder: "asc",
  filters: [
    {
      parameter: "businessType",
      label: "业务类型",
      kind: "select",
      options: [{ value: "PRODUCTION_SCRAP", label: "生产材料报废" }]
    },
    { parameter: "workshopId", label: "生产车间 ID", placeholder: "输入生产车间 UUID" },
    { parameter: "productId", label: "商品 ID", placeholder: "输入商品 UUID" },
    { parameter: "scrapReason", label: "报废原因", placeholder: "输入原因关键词" }
  ],
  totals: {
    groupKeys: ["unit"],
    valueKeys: ["scrapQty"]
  },
  columns: [
    { key: "businessType", title: "业务类型", width: 132, minWidth: 112, fixed: "left", configurable: false },
    { key: "workshopCode", title: "车间编码", width: 128, minWidth: 108, fixed: "left", sortField: "workshopCode" },
    { key: "workshopName", title: "生产车间", width: 180, minWidth: 132, sortField: "workshopName" },
    { key: "productCode", title: "商品编码", width: 140, minWidth: 112, sortField: "productCode" },
    { key: "productName", title: "商品名称", width: 190, minWidth: 140, sortField: "productName" },
    { key: "productSpec", title: "规格型号", width: 160, minWidth: 120 },
    { key: "unit", title: "单位", width: 86, minWidth: 72, align: "center", sortField: "unit" },
    { key: "scrapQty", title: "报废数量", width: 132, minWidth: 108, align: "right", sortField: "scrapQty", format: "quantity" }
  ]
};
