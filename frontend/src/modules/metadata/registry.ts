import { salesBillDefinitions } from "./bills/sales";
import type { BillDefinition } from "./types";

export const billDefinitions = Object.fromEntries(
  salesBillDefinitions.map((definition) => [definition.billType, definition])
) as Record<string, BillDefinition>;

export const billDefinitionsByListKey = Object.fromEntries(
  salesBillDefinitions.map((definition) => [definition.listKey, definition])
) as Record<string, BillDefinition>;

export function getBillDefinition(billType: string) {
  return billDefinitions[billType] ?? null;
}

export function getBillDefinitionByListKey(listKey: string) {
  return billDefinitionsByListKey[listKey] ?? null;
}

export function sourceSelectAction(definition: BillDefinition) {
  return definition.toolbarActions.find((action) => action.key === "sourceSelect") ?? null;
}

export function pushDownAction(definition: BillDefinition) {
  return definition.toolbarActions.find((action) => action.key === "pushDown") ?? null;
}
