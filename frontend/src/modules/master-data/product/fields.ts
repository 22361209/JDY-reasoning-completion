import type { MasterDataField } from "../types";

export const productMasterFields: MasterDataField[] = [
  { name: "id", label: "系统ID", placeholder: "保存后自动生成", section: "基本信息", readonly: true, defaultValue: "保存后生成", span: 2 },
  { name: "code", label: "物料编码", placeholder: "如 CP-200", section: "基本信息", required: true, readonlyWhenEditing: true },
  { name: "name", label: "物料名称", placeholder: "输入关键字选择名称", section: "基本信息", required: true, suggestions: ["控制臂总成", "悬挂球头", "前下摆臂", "后桥支架", "衬套", "冲压件", "焊接总成", "候选商品"] },
  { name: "spec", label: "规格型号", placeholder: "规格/颜色/位置", section: "基本信息" },
  { name: "category", label: "物料分类", placeholder: "输入关键字选择分类", section: "基本信息", required: true, suggestions: ["原材料", "自制半成品", "委外半成品", "产成品", "辅料", "服务"] },
  { name: "productType", label: "物料属性", section: "基本信息", options: ["采购件", "自制件", "委外件", "成品", "半成品", "原材料", "辅料"] },
  { name: "unit", label: "主单位", placeholder: "输入关键字选择单位", section: "基本信息", defaultValue: "只", suggestions: ["只", "件", "套", "PCS", "kg", "米"] },

  { name: "isPurchase", label: "可采购", section: "业务能力", type: "checkbox", defaultValue: "false" },
  { name: "isSale", label: "可销售", section: "业务能力", type: "checkbox", defaultValue: "false" },
  { name: "isInventory", label: "可库存", section: "业务能力", type: "checkbox", defaultValue: "true" },
  { name: "isProduce", label: "可自制", section: "业务能力", type: "checkbox", defaultValue: "false" },
  { name: "isSubcontract", label: "可委外", section: "业务能力", type: "checkbox", defaultValue: "false" },

  { name: "defaultWarehouseCode", label: "默认仓库", placeholder: "如 CK-001", section: "默认业务属性" },
  { name: "defaultWorkshop", label: "默认生产车间", placeholder: "如 焊接车间", section: "默认业务属性", suggestions: ["焊接车间", "冲压车间", "装配车间", "委外车间"] },
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
