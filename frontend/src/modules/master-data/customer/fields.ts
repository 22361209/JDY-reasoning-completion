import type { MasterDataField } from "../types";

export const customerMasterFields: MasterDataField[] = [
  { name: "code", label: "客户编码", placeholder: "如 KH-010" },
  { name: "name", label: "客户名称", placeholder: "客户名称" },
  { name: "contact", label: "联系人", placeholder: "联系人" },
  { name: "phone", label: "电话", placeholder: "联系电话" },
  { name: "region", label: "地区", placeholder: "省市" },
  { name: "status", label: "状态", options: ["启用", "禁用"] }
];
