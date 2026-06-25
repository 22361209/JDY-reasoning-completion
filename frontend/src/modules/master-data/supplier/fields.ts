import type { MasterDataField } from "../types";

export const supplierMasterFields: MasterDataField[] = [
  { name: "code", label: "供应商编码", placeholder: "如 GYS-010" },
  { name: "name", label: "供应商名称", placeholder: "供应商名称" },
  { name: "contact", label: "联系人", placeholder: "联系人" },
  { name: "phone", label: "电话", placeholder: "联系电话" },
  { name: "status", label: "状态", options: ["启用", "禁用"] }
];
