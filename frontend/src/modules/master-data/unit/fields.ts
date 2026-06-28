import type { MasterDataField } from "../types";
import { unitSuggestions } from "../product/fields";

export const unitMasterFields: MasterDataField[] = [
  { name: "code", label: "单位名称", placeholder: "如 PCS、KGS、只", section: "基本信息", required: true, readonlyWhenEditing: true, suggestions: unitSuggestions },
  { name: "decimalPlaces", label: "数量小数位", placeholder: "如 0、2、3", section: "基本信息", type: "number", defaultValue: "0" },
  { name: "sortNo", label: "排序", placeholder: "数字越小越靠前", section: "基本信息", type: "number", defaultValue: "0" },
  { name: "status", label: "状态", section: "状态", options: ["启用", "禁用"] },
  { name: "remark", label: "备注", placeholder: "单位用途说明", section: "状态", type: "textarea", span: 2 }
];
