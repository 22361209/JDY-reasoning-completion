import type { MasterDataField } from "../types";

export const warehouseMasterFields: MasterDataField[] = [
  { name: "code", label: "仓库编码", placeholder: "如 CK-010" },
  { name: "name", label: "仓库名称", placeholder: "仓库名称" },
  { name: "stockPolicy", label: "库存策略", options: ["不允许负库存", "允许负库存"] },
  { name: "status", label: "状态", options: ["启用", "禁用"] }
];
