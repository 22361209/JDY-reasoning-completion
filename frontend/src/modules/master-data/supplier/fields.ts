import type { MasterDataField } from "../types";

export const supplierMasterFields: MasterDataField[] = [
  { name: "code", label: "供应商编码", placeholder: "如 GYS-010", section: "基本信息", required: true, readonlyWhenEditing: true },
  { name: "name", label: "供应商名称", placeholder: "供应商全称", section: "基本信息", required: true },
  { name: "shortName", label: "供应商简称", placeholder: "列表和搜索使用", section: "基本信息" },
  { name: "supplierLevel", label: "供应商等级", section: "基本信息", options: ["普通供应商", "核心供应商", "临时供应商", "加工商"] },
  { name: "contact", label: "联系人", placeholder: "联系人", section: "联系方式" },
  { name: "phone", label: "电话", placeholder: "联系电话", section: "联系方式" },
  { name: "address", label: "地址", placeholder: "收货/对账地址", section: "联系方式", span: 2 },
  { name: "taxNo", label: "税号", placeholder: "纳税识别号", section: "交易资料" },
  { name: "bankAccount", label: "银行账号", placeholder: "开户行 / 账号", section: "交易资料" },
  { name: "settlementMethod", label: "结算方式", section: "交易资料", options: ["月结", "现结", "预付款", "票到付款"] },
  { name: "ownerName", label: "采购负责人", placeholder: "本地管理员", section: "交易资料" },
  { name: "status", label: "状态", section: "状态", options: ["启用", "禁用"] },
  { name: "remark", label: "备注", placeholder: "供货范围、交期、质量注意事项", section: "状态", type: "textarea", span: 2 }
];
