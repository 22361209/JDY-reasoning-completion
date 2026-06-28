import type { MasterDataField } from "../types";

export const customerMasterFields: MasterDataField[] = [
  { name: "code", label: "客户编码", placeholder: "如 KH-010", section: "基本信息", required: true, readonlyWhenEditing: true },
  { name: "name", label: "客户名称", placeholder: "客户全称", section: "基本信息", required: true },
  { name: "shortName", label: "客户简称", placeholder: "列表和搜索使用", section: "基本信息" },
  { name: "customerLevel", label: "客户等级", section: "基本信息", options: ["普通客户", "重点客户", "战略客户", "临时客户"] },
  { name: "contact", label: "联系人", placeholder: "联系人", section: "联系方式" },
  { name: "phone", label: "电话", placeholder: "联系电话", section: "联系方式" },
  { name: "region", label: "地区", placeholder: "省市", section: "联系方式" },
  { name: "address", label: "地址", placeholder: "发货/开票地址", section: "联系方式", span: 2 },
  { name: "taxNo", label: "税号", placeholder: "纳税识别号", section: "交易资料" },
  { name: "settlementMethod", label: "结算方式", section: "交易资料", options: ["月结", "现结", "预付款", "货到付款"] },
  { name: "creditLimit", label: "信用额度", placeholder: "0.00", section: "交易资料", type: "number" },
  { name: "ownerName", label: "负责业务员", placeholder: "本地管理员", section: "交易资料" },
  { name: "status", label: "状态", section: "状态", options: ["启用", "禁用"] },
  { name: "remark", label: "备注", placeholder: "客户偏好、对账要求、收货注意事项", section: "状态", type: "textarea", span: 2 }
];
