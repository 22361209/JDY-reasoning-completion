import type { MasterDataField } from "../types";
import { productCategorySuggestions } from "../product/fields";

export const productCategoryFields: MasterDataField[] = [
  { name: "code", label: "类别编码", placeholder: "如 QT", section: "基本信息", required: true, readonlyWhenEditing: true },
  { name: "name", label: "类别名称", placeholder: "如 球头", section: "基本信息", required: true, suggestions: productCategorySuggestions },
  { name: "parentCode", label: "上级类别编码", placeholder: "为空表示一级类别", section: "基本信息" },
  { name: "sortNo", label: "排序", placeholder: "数字越小越靠前", section: "基本信息", type: "number", defaultValue: "0" },
  { name: "status", label: "状态", section: "状态", options: ["启用", "禁用"] },
  { name: "remark", label: "备注", placeholder: "类别用途说明", section: "状态", type: "textarea", span: 2 }
];
