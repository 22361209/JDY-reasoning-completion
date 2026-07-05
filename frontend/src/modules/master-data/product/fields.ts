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
  { name: "name", label: "物料名称", placeholder: "输入关键字选择名称", section: "基本信息", required: true, suggestions: ["控制臂总成", "悬挂球头", "前下摆臂", "后桥支架", "衬套", "冲压件", "焊接总成", "球销"], strictSuggestions: true },
  { name: "category", label: "物料类别", placeholder: "输入类别编码或名称", section: "基本信息", required: true, suggestions: productCategorySuggestions, lookup: { listKey: "product-category-list", valueField: "name", displayFields: ["code", "name"], searchFields: ["parentCode"] } },
  { name: "spec", label: "规格型号", placeholder: "规格/位置/颜色/处理方式", section: "基本信息" },
  { name: "unit", label: "计量单位", placeholder: "输入单位名称", section: "基本信息", required: true, defaultValue: "PCS", suggestions: unitSuggestions, lookup: { listKey: "unit-master-list", valueField: "code", displayFields: ["code", "decimalPlaces"], searchFields: ["name"] } },
  { name: "netWeight", label: "净重", placeholder: "保留小数点后两位，可空", section: "基本信息", type: "number" },
  { name: "grossWeight", label: "毛重", placeholder: "保留小数点后两位，可空", section: "基本信息", type: "number" },
  { name: "surfaceTreatment", label: "表面处理", placeholder: "输入关键字选择处理方式", section: "基本信息", suggestions: ["本色", "磷化", "达克罗", "本色防锈处理", "磷化防锈处理"], strictSuggestions: true },

  { name: "isSale", label: "可销售", section: "商品特性", type: "checkbox", defaultValue: "true" },
  { name: "isPurchase", label: "可采购", section: "商品特性", type: "checkbox", defaultValue: "false" },
  { name: "isInventory", label: "可库存", section: "商品特性", type: "checkbox", defaultValue: "true" },
  { name: "isProduce", label: "可自制", section: "商品特性", type: "checkbox", defaultValue: "true" },
  { name: "isSubcontract", label: "可委外", section: "商品特性", type: "checkbox", defaultValue: "false" },

  { name: "purchasePrice", label: "采购价", placeholder: "默认采购参考价", section: "价格设置", type: "number" },
  { name: "costPrice", label: "参考成本", placeholder: "暂作为占位参考", section: "价格设置", type: "number" },
  { name: "minSalePrice", label: "最低销售价", placeholder: "低于此价后续可触发审批", section: "价格设置", type: "number" },
  { name: "taxRate", label: "进项/销项税率(%)", placeholder: "13", section: "价格设置", type: "number", defaultValue: "13" },

  { name: "minStockQty", label: "最低库存数量", placeholder: "低于后续可预警", section: "库存预警", type: "number" },
  { name: "safetyStockQty", label: "安全库存数量", placeholder: "安全库存", section: "库存预警", type: "number" },
  { name: "maxStockQty", label: "最高库存数量", placeholder: "高于后续可预警", section: "库存预警", type: "number" },

  { name: "defaultWorkshop", label: "默认生产车间", placeholder: "输入部门编码或名称", section: "生产信息", suggestions: ["冲压车间", "焊接车间", "金工车间", "安装车间", "包装车间"], lookup: { listKey: "production-department-list", valueField: "name", displayFields: ["code", "name"], searchFields: ["manager"] } },

  { name: "defaultWarehouseCode", label: "默认仓库", placeholder: "输入仓库编码或名称", section: "其他信息", lookup: { listKey: "warehouse-master-list", valueField: "code", displayFields: ["code", "name"], searchFields: ["warehouseType", "manager"] } },
  { name: "defaultSupplierCode", label: "默认供应商", placeholder: "输入供应商编码或名称", section: "其他信息", lookup: { listKey: "supplier-master-list", valueField: "code", displayFields: ["code", "name"], searchFields: ["contact", "phone"] } },
  { name: "drawingFileName", label: "图纸(PDF)", placeholder: "上传 1 张 PDF 图纸", section: "附件", type: "file", accept: ".pdf,application/pdf", maxFiles: 1, fileDataName: "drawingFileData", span: 2 },
  { name: "imageFileNames", label: "图片", placeholder: "最多 5 张 PNG/JPG/JPEG", section: "附件", type: "file", accept: ".png,.jpg,.jpeg,image/png,image/jpeg", multiple: true, maxFiles: 5, fileDataName: "imageFileData", span: 2 }
];
