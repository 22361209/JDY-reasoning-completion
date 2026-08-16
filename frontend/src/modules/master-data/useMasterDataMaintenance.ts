import { computed, type Ref } from "vue";
import {
  auditMasterData,
  deleteMasterData,
  reverseAuditMasterData,
  setMasterDataStatus
} from "../../services/listApi";
import { masterDataDefinitions } from "./registry";

export interface MasterDataMaintenanceResult {
  ok: boolean;
  attempted: number;
  succeeded: number;
  failed: number;
  message: string;
}

export function useMasterDataMaintenance(
  listKey: Ref<string>,
  rows: Ref<Record<string, unknown>[]>,
  selectedRows: Ref<Record<string, unknown>[]>,
  reload: () => Promise<void>
) {
  const definition = computed(() => masterDataDefinitions[listKey.value] ?? null);
  const isMasterList = computed(() => Boolean(definition.value));
  const usesSparsePatch = computed(() => Boolean(definition.value?.sparsePatch));
  const canDelete = computed(() => Boolean(definition.value) && definition.value?.allowDelete !== false);

  async function submitStatus(enabled: boolean) {
    const masterDefinition = definition.value;
    if (!masterDefinition) {
      return emptyResult();
    }
    return runBatch(enabled ? "启用" : "禁用", (code) => setMasterDataStatus(masterDefinition.type, code, enabled));
  }

  async function submitAudit(audit: boolean) {
    const masterDefinition = definition.value;
    if (!masterDefinition) {
      return emptyResult();
    }
    const submit = audit ? auditMasterData : reverseAuditMasterData;
    return runBatch(audit ? "审核" : "反审核", (code) => submit(masterDefinition.type, code));
  }

  async function submitDelete() {
    const masterDefinition = definition.value;
    if (!masterDefinition || masterDefinition.allowDelete === false) {
      return emptyResult();
    }
    return runBatch("删除", (code) => deleteMasterData(masterDefinition.type, code));
  }

  async function runBatch(
    actionLabel: string,
    submit: (code: string) => Promise<{ ok: boolean; message: string }>
  ): Promise<MasterDataMaintenanceResult> {
    const targets = actionRows();
    if (!targets.length) {
      return { ok: false, attempted: 0, succeeded: 0, failed: 0, message: `请选择要${actionLabel}的资料。` };
    }
    let succeeded = 0;
    const failureMessages: string[] = [];
    for (const row of targets) {
      const result = await submit(String(row.code));
      if (result.ok) {
        succeeded += 1;
      } else {
        failureMessages.push(result.message || `${actionLabel}失败`);
      }
    }
    await reload();
    const failed = targets.length - succeeded;
    return {
      ok: failed === 0,
      attempted: targets.length,
      succeeded,
      failed,
      message: failed === 0
        ? `已${actionLabel} ${succeeded} 条资料。`
        : `${actionLabel}完成 ${succeeded}/${targets.length}，失败 ${failed}：${failureMessages[0]}`
    };
  }

  function emptyResult(): MasterDataMaintenanceResult {
    return { ok: false, attempted: 0, succeeded: 0, failed: 0, message: "当前列表不支持该操作。" };
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
    usesSparsePatch,
    canDelete,
    submitAudit,
    submitStatus,
    submitDelete
  };
}
