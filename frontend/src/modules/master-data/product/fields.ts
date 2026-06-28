import type { MasterDataField } from "../types";

export const productMasterFields: MasterDataField[] = [
  { name: "code", label: "物料编码", placeholder: "如 CP-200", section: "基本信息", required: true, readonlyWhenEditing: true },
  { name: "name", label: "物料名称", placeholder: "如 前摆臂总成", section: "基本信息", required: true },
  { name: "spec", label: "规格型号", placeholder: "规格/颜色/位置", section: "基本信息" },
  { name: "category", label: "物料分类", placeholder: "原材料/半成品/产成品", section: "基本信息" },
  { name: "unit", label: "主单位", placeholder: "只/件", section: "基本信息", defaultValue: "只" },
  { name: "shortName", label: "简称", placeholder: "用于快速检索", section: "基本信息" },
  { name: "barcode", label: "条码", placeholder: "扫码/外部编码", section: "基本信息" },
  { name: "productType", label: "物料形态", section: "基本信息", options: ["产成品", "自制半成品", "委外半成品", "原材料", "辅料", "服务"] },

  { name: "isPurchase", label: "可采购", section: "业务能力", type: "checkbox", defaultValue: "false" },
  { name: "isSale", label: "可销售", section: "业务能力", type: "checkbox", defaultValue: "false" },
  { name: "isInventory", label: "可库存", section: "业务能力", type: "checkbox", defaultValue: "true" },
  { name: "isProduce", label: "可生产", section: "业务能力", type: "checkbox", defaultValue: "false" },
  { name: "isSubcontract", label: "可委外", section: "业务能力", type: "checkbox", defaultValue: "false" },

  { name: "defaultWarehouseCode", label: "默认仓库", placeholder: "如 CK-001", section: "默认业务属性" },
  { name: "saleUnit", label: "销售单位", placeholder: "默认同主单位", section: "默认业务属性" },
  { name: "purchaseUnit", label: "采购单位", placeholder: "默认同主单位", section: "默认业务属性" },
  { name: "bomUnit", label: "生产/BOM单位", placeholder: "默认同主单位", section: "默认业务属性" },
  { name: "defaultSupplierCode", label: "默认供应商", placeholder: "如 GYS-001", section: "默认业务属性" },
  { name: "issueWarehouseCode", label: "默认领料仓", placeholder: "生产领料默认仓", section: "默认业务属性" },
  { name: "issueMethod", label: "发料方式", section: "默认业务属性", options: ["按单领料", "倒冲领料", "手工领料"] },

  { name: "taxRate", label: "税率(%)", placeholder: "13", section: "计价资料", type: "number", defaultValue: "13" },
  { name: "defaultSalePrice", label: "默认销售价", placeholder: "无成交记录时使用", section: "计价资料", type: "number" },
  { name: "minSalePrice", label: "最低销售价", placeholder: "低于此价后续可触发审批", section: "计价资料", type: "number" },
  { name: "costPrice", label: "成本价", placeholder: "暂作为占位参考", section: "计价资料", type: "number" },
  { name: "status", label: "状态", section: "状态", options: ["启用", "禁用"] },
  { name: "remark", label: "备注", placeholder: "包装、替代件、适配车型等说明", section: "状态", type: "textarea", span: 2 }
];
