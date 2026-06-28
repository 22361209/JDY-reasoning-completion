import type { MasterDataField } from "../types";

export const productCategorySuggestions = [
  "成品总成",
  "原材料",
  "自制半成品",
  "委外半成品",
  "冲压材料",
  "物料容器",
  "支架",
  "装配管件",
  "摆臂",
  "衬套",
  "球头",
  "标准件",
  "包装辅料",
  "辅料"
];

export const unitSuggestions = ["PCS", "只", "件", "套", "个", "条", "箱", "KGS", "kg", "米"];

export const productMasterFields: MasterDataField[] = [
  { name: "systemNo", label: "系统编号", placeholder: "保存后自动生成", section: "基本信息", readonly: true, defaultValue: "保存后生成" },
  { name: "code", label: "物料编码", placeholder: "如 QD8029-1", section: "基本信息", required: true, readonlyWhenEditing: true },
  { name: "name", label: "物料名称", placeholder: "如 球销、控制臂总成", section: "基本信息", required: true, suggestions: ["控制臂总成", "悬挂球头", "前下摆臂", "后桥支架", "衬套", "冲压件", "焊接总成", "球销"] },
  { name: "category", label: "物料类别", placeholder: "输入关键字选择类别", section: "基本信息", required: true, suggestions: productCategorySuggestions },
  { name: "productType", label: "商品类型", section: "基本信息", options: ["普通", "服务", "备件", "辅料"] },
  { name: "spec", label: "规格型号", placeholder: "规格/位置/颜色/处理方式", section: "基本信息" },
  { name: "unit", label: "计量单位", placeholder: "输入关键字选择单位", section: "基本信息", required: true, defaultValue: "PCS", suggestions: unitSuggestions },
  { name: "netWeight", label: "净重", placeholder: "保留小数点后两位，可空", section: "基本信息", type: "number" },
  { name: "grossWeight", label: "毛重", placeholder: "保留小数点后两位，可空", section: "基本信息", type: "number" },
  { name: "oeNo", label: "OE NO.", placeholder: "客户或车型相关 OE 号", section: "基本信息" },
  { name: "positionName", label: "位置", placeholder: "如 左前、右后", section: "基本信息" },
  { name: "surfaceTreatment", label: "表面处理", placeholder: "如 本色、磷化、达克罗", section: "基本信息", suggestions: ["本色", "磷化", "达克罗", "本色防锈处理", "磷化防锈处理"] },

  { name: "isSale", label: "可销售", section: "商品特性", type: "checkbox", defaultValue: "false" },
  { name: "isPurchase", label: "可采购", section: "商品特性", type: "checkbox", defaultValue: "false" },
  { name: "isInventory", label: "可库存", section: "商品特性", type: "checkbox", defaultValue: "true" },
  { name: "isProduce", label: "可自制", section: "商品特性", type: "checkbox", defaultValue: "false" },
  { name: "isSubcontract", label: "可委外", section: "商品特性", type: "checkbox", defaultValue: "false" },

  { name: "purchasePrice", label: "采购价", placeholder: "默认采购参考价", section: "价格设置", type: "number" },
  { name: "maxPurchasePrice", label: "最高采购价", placeholder: "超过后后续可预警", section: "价格设置", type: "number" },
  { name: "subcontractPrice", label: "委外价", placeholder: "委外加工参考价", section: "价格设置", type: "number" },
  { name: "costPrice", label: "参考成本", placeholder: "暂作为占位参考", section: "价格设置", type: "number" },
  { name: "defaultSalePrice", label: "批发价", placeholder: "默认销售参考价", section: "价格设置", type: "number" },
  { name: "retailPrice", label: "零售价", placeholder: "零售参考价", section: "价格设置", type: "number" },
  { name: "minSalePrice", label: "最低销售价", placeholder: "低于此价后续可触发审批", section: "价格设置", type: "number" },
  { name: "taxRate", label: "进项/销项税率(%)", placeholder: "13", section: "价格设置", type: "number", defaultValue: "13" },

  { name: "minStockQty", label: "最低库存数量", placeholder: "低于后续可预警", section: "库存预警", type: "number" },
  { name: "safetyStockQty", label: "安全库存数量", placeholder: "安全库存", section: "库存预警", type: "number" },
  { name: "maxStockQty", label: "最高库存数量", placeholder: "高于后续可预警", section: "库存预警", type: "number" },

  { name: "defaultWorkshop", label: "默认生产车间", placeholder: "如 焊接车间", section: "生产信息", suggestions: ["焊接车间", "冲压车间", "装配车间", "委外车间"] },
  { name: "issueWarehouseCode", label: "默认领料仓", placeholder: "生产领料默认仓", section: "生产信息" },
  { name: "issueMethod", label: "发料方式", section: "生产信息", options: ["按单领料", "倒冲领料", "手工领料"] },

  { name: "defaultWarehouseCode", label: "默认仓库", placeholder: "如 CK-001", section: "其他信息" },
  { name: "defaultSupplierCode", label: "默认供应商", placeholder: "如 GYS-001", section: "其他信息" },
  { name: "status", label: "状态", section: "其他信息", options: ["启用", "禁用"] },
  { name: "remark", label: "备注", placeholder: "包装、替代件、适配车型等说明", section: "其他信息", type: "textarea", span: 2 }
];
