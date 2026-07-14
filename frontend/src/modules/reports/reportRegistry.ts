import { financeReportDefinitions } from "./financeReports";
import { inventoryMovementReport } from "./inventoryMovementReport";
import { salesReportDefinitions } from "./salesReports";
import type { ReportDefinition } from "./reportTypes";

const definitions: readonly ReportDefinition[] = [
  inventoryMovementReport,
  ...salesReportDefinitions,
  ...financeReportDefinitions
];
const registry = new Map<string, ReportDefinition>();

for (const definition of definitions) {
  if (registry.has(definition.entryId)) {
    throw new Error(`duplicate report entry id: ${definition.entryId}`);
  }
  registry.set(definition.entryId, definition);
}

export function reportDefinitionForEntryId(entryId: string): ReportDefinition | null {
  return registry.get(entryId) ?? null;
}

export function isRegisteredReportEntry(entryId: string): boolean {
  return registry.has(entryId);
}

export const registeredReportEntryIds = Object.freeze(definitions.map((definition) => definition.entryId));
