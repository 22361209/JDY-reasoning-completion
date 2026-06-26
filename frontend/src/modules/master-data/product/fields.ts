import type { MasterDataField } from "../types";

export const productMasterFields: MasterDataField[] = [
  { name: "code", label: "商品编码", placeholder: "如 CP-200" },
  { name: "name", label: "商品名称", placeholder: "如 前摆臂总成" },
  { name: "spec", label: "规格型号", placeholder: "规格/颜色/位置" },
  { name: "category", label: "商品类别", placeholder: "成品总成/零配件" },
  { name: "unit", label: "单位", placeholder: "只/件" },
  { name: "defaultSalePrice", label: "默认销售价", placeholder: "无成交记录时使用" },
  { name: "status", label: "状态", options: ["启用", "禁用"] }
];
