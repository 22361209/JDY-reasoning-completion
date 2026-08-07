import type { MasterDataField } from "../types";

export const productNameFields: MasterDataField[] = [
  { name: "code", label: "物料名称", hidden: true },
  { name: "name", label: "物料名称", placeholder: "如 焊接总成", section: "基本信息", required: true },
  { name: "remark", label: "备注", placeholder: "可空", section: "基本信息", type: "textarea" }
];
