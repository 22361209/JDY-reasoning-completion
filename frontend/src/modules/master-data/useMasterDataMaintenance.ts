import { computed, type Ref } from "vue";
import {
  auditMasterData,
  deleteMasterData,
  reverseAuditMasterData,
  setMasterDataStatus
} from "../../services/listApi";
import { masterDataDefinitions } from "./registry";

export function useMasterDataMaintenance(
  listKey: Ref<string>,
  rows: Ref<Record<string, unknown>[]>,
  selectedRows: Ref<Record<string, unknown>[]>,
  reload: () => Promise<void>
) {
  const definition = computed(() => masterDataDefinitions[listKey.value] ?? null);
  const isMasterList = computed(() => Boolean(definition.value));

  async function submitStatus(enabled: boolean) {
    const masterDefinition = definition.value;
    if (!masterDefinition) {
      return false;
    }
    for (const row of actionRows()) {
      await setMasterDataStatus(masterDefinition.type, String(row.code), enabled);
    }
    await reload();
    return true;
  }

  async function submitAudit(audit: boolean) {
    const masterDefinition = definition.value;
    if (!masterDefinition) {
      return false;
    }
    const submit = audit ? auditMasterData : reverseAuditMasterData;
    for (const row of actionRows()) {
      await submit(masterDefinition.type, String(row.code));
    }
    await reload();
    return true;
  }

  async function submitDelete() {
    const masterDefinition = definition.value;
    if (!masterDefinition) {
      return false;
    }
    for (const row of actionRows()) {
      await deleteMasterData(masterDefinition.type, String(row.code));
    }
    await reload();
    return true;
  }

  function actionRows() {
    const visibleCodes = new Set(rows.value.map((row) => String(row.code ?? "")));
    const currentSelections = selectedRows.value.filter((row) => visibleCodes.has(String(row.code ?? "")));
    if (currentSelections.length) {
      return currentSelections;
    }
    if (rows.value.length === 1 && selectedRows.value.length === 1) {
      return rows.value;
    }
    return currentSelections;
  }

  return {
    isMasterList,
    submitAudit,
    submitStatus,
    submitDelete
  };
}
