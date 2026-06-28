import type { MasterDataField } from "../types";

export const customerMasterFields: MasterDataField[] = [
  { name: "systemNo", label: "系统编号", placeholder: "保存后自动生成", section: "基本信息", readonly: true, defaultValue: "保存后生成", span: 2 },
  { name: "code", label: "客户编码", placeholder: "如 KH-010", section: "基本信息", required: true, readonlyWhenEditing: true },
  { name: "name", label: "客户名称", placeholder: "客户全称", section: "基本信息", required: true },
  { name: "contact", label: "联系人", placeholder: "联系人", section: "联系方式" },
  { name: "phone", label: "电话", placeholder: "联系电话", section: "联系方式" },
  { name: "region", label: "地区", placeholder: "省市", section: "联系方式" },
  { name: "address", label: "地址", placeholder: "收货地址/联系地址", section: "联系方式", span: 2 },
  { name: "status", label: "状态", section: "状态", options: ["启用", "禁用"] },
  { name: "remark", label: "备注", placeholder: "收货注意事项、客户偏好", section: "状态", type: "textarea", span: 2 }
];
