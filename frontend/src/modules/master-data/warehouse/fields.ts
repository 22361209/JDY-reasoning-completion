import type { MasterDataField } from "../types";

export const warehouseMasterFields: MasterDataField[] = [
  { name: "code", label: "仓库编码", placeholder: "如 CK-010", section: "基本信息", required: true, readonlyWhenEditing: true },
  { name: "name", label: "仓库名称", placeholder: "仓库名称", section: "基本信息", required: true },
  { name: "warehouseType", label: "仓库类型", section: "基本信息", options: ["普通仓", "成品仓", "原料仓", "半成品仓", "不良品仓", "虚拟仓"] },
  { name: "stockPolicy", label: "库存策略", section: "库存控制", options: ["不允许负库存", "允许负库存"] },
  { name: "manager", label: "仓管员", placeholder: "负责人", section: "联系方式" },
  { name: "phone", label: "联系电话", placeholder: "联系电话", section: "联系方式" },
  { name: "address", label: "仓库地址", placeholder: "仓库位置", section: "联系方式", span: 2 },
  { name: "status", label: "状态", section: "状态", options: ["启用", "禁用"] },
  { name: "remark", label: "备注", placeholder: "库区规则、盘点说明、特殊限制", section: "状态", type: "textarea", span: 2 }
];
