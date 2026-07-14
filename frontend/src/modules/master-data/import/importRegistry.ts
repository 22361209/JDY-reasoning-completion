export const masterDataImportDefinitions = [
  { type: "productCategory", listKey: "product-category-list", label: "物料类别" },
  { type: "unit", listKey: "unit-master-list", label: "计量单位" },
  { type: "customer", listKey: "customer-master-list", label: "客户" },
  { type: "supplier", listKey: "supplier-master-list", label: "供应商" },
  { type: "warehouse", listKey: "warehouse-master-list", label: "仓库" },
  { type: "employee", listKey: "employee-master-list", label: "员工" },
  { type: "financialAccount", listKey: "financial-account-master-list", label: "账户资料" },
  { type: "product", listKey: "product-master-list", label: "物料资料" }
] as const;

export type MasterDataImportType = typeof masterDataImportDefinitions[number]["type"];

const definitionByType = new Map<MasterDataImportType, typeof masterDataImportDefinitions[number]>(
  masterDataImportDefinitions.map((definition) => [definition.type, definition] as const)
);
const definitionByListKey = new Map<string, typeof masterDataImportDefinitions[number]>(
  masterDataImportDefinitions.map((definition) => [definition.listKey, definition] as const)
);

export const masterDataImportListKeys: ReadonlySet<string> = new Set(
  masterDataImportDefinitions.map((definition) => definition.listKey)
);

export function isMasterDataImportType(value: unknown): value is MasterDataImportType {
  return typeof value === "string" && definitionByType.has(value as MasterDataImportType);
}

export function masterDataImportDefinition(type: MasterDataImportType) {
  return definitionByType.get(type) ?? masterDataImportDefinitions[0];
}

export function masterDataImportDefinitionForList(listKey: string) {
  return definitionByListKey.get(listKey) ?? null;
}

export function masterDataImportTypeForList(listKey: string): MasterDataImportType | null {
  return masterDataImportDefinitionForList(listKey)?.type ?? null;
}
