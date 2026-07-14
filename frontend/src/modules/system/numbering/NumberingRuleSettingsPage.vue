<template>
  <section class="role-permission-page settings-page" data-testid="numbering-rule-settings-page">
    <DocumentCommandHeader
      title="单据编号规则"
      subtitle="所有单据在这里总览。未单独编辑时使用系统默认规则；变更规则必须先点开单个单据，避免误改整表。"
      show-subtitle
      status-label="设置"
      status-class="draft"
    >
      <template #actions>
        <ActionBar :actions="numberingActions" @action="handleAction" />
      </template>
    </DocumentCommandHeader>
    <div class="settings-table">
      <TableCore
        kind="list"
        test-id="numbering-rule-table-core"
        frame-class="vxe-wrap numbering-rule-table"
        inner-class="table-core-vxe-inner"
        table-class="vxe-table data-list-native-table"
        header-wrapper-class="vxe-table--header-wrapper body--wrapper"
        body-wrapper-class="vxe-table--body-wrapper body--wrapper"
        header-row-class="vxe-header--row"
        :columns="numberingTableColumns"
        :rows="rules"
        :min-width="980"
        :row-key="numberingRowKey"
        :row-class="numberingRowClass"
        :cell-title="numberingCellTitle"
        @column-resize="resizeNumberingColumn"
      >
        <template #cell="{ row: rule, column }">
          <label v-if="column.key === 'enabled'" class="settings-check compact">
            <input :checked="rule.enabled" disabled type="checkbox" :data-testid="`numbering-enabled-${rule.documentType}`" />
          </label>
          <button
            v-else-if="column.key === 'operation'"
            type="button"
            :disabled="!canManage || loading || saving"
            :data-testid="`numbering-edit-${rule.documentType}`"
            @click="requestSelectRule(rule)"
          >编辑规则</button>
          <code v-else-if="column.key === 'typeCode'">{{ numberingCellValue(rule, column.key) }}</code>
          <span v-else>{{ numberingCellValue(rule, column.key) }}</span>
        </template>
        <template #overlay>
          <div v-if="loading || !rules.length" class="list-state-panel" data-testid="numbering-empty">
            {{ loading ? "正在加载编号规则…" : message || "暂无编号规则。" }}
          </div>
        </template>
      </TableCore>
    </div>

    <section v-if="selectedRule && draftRule" class="settings-card numbering-editor" data-testid="numbering-rule-editor">
      <div class="settings-card__head">
        <div>
          <h3>{{ selectedRule.label }}</h3>
          <p>系统类型：<code>{{ selectedRule.typeCode }}</code> · 版本 v{{ selectedRule.version }}</p>
        </div>
        <ActionBar :actions="numberingEditorHeadActions" @action="handleAction" />
      </div>
      <div class="settings-form-grid">
        <label>
          编号前缀
          <input
            ref="prefixInput"
            v-model.trim="draftRule.prefix"
            :aria-invalid="errorField === 'prefix'"
            :disabled="!canManage || saving"
            maxlength="24"
            data-testid="numbering-edit-prefix"
          />
        </label>
        <label>
          流水位数
          <input
            ref="widthInput"
            v-model.number="draftRule.width"
            :aria-invalid="errorField === 'width'"
            :disabled="!canManage || saving"
            type="number"
            min="3"
            max="12"
            data-testid="numbering-edit-width"
          />
        </label>
        <label>
          当前流水
          <input
            ref="lastNumberInput"
            v-model="draftRule.lastNumber"
            :aria-invalid="errorField === 'lastNumber'"
            :disabled="!canManage || saving"
            type="text"
            inputmode="numeric"
            maxlength="12"
            pattern="[0-9]*"
            data-testid="numbering-edit-last"
          />
        </label>
        <label class="settings-check">
          <input v-model="draftRule.enabled" :disabled="!canManage || saving" type="checkbox" data-testid="numbering-edit-enabled" />
          启用该规则
        </label>
      </div>
      <p class="settings-hint">
        当前流水只能上调；取号后即使草稿被放弃或删除也不会复用。禁用后将阻止该单据生成新编号。
      </p>
      <div class="settings-actions">
        <ActionBar :actions="numberingEditorActions" @action="handleAction" />
      </div>
    </section>
    <p v-if="message" class="form-message settings-message" data-testid="numbering-message" role="status">{{ message }}</p>

    <div v-if="pendingDialog" class="modal-mask" data-testid="numbering-confirm-dialog">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="numbering-confirm-title">
        <h3 id="numbering-confirm-title">{{ pendingDialogTitle }}</h3>
        <p>{{ pendingDialogMessage }}</p>
        <div class="dialog-actions">
          <button type="button" :disabled="saving" data-testid="numbering-confirm-cancel" @click="cancelDialog">取消</button>
          <button
            class="danger-action"
            type="button"
            :disabled="saving"
            data-testid="numbering-confirm-accept"
            @click="confirmDialog"
          >{{ pendingDialog === "save" ? "确认保存" : "不保存" }}</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import ActionBar from "../../../components/ActionBar.vue";
import { defineAction, type ActionBarItem } from "../../../components/actions/actionRegistry";
import DocumentCommandHeader from "../../../components/DocumentCommandHeader.vue";
import TableCore, { type TableCoreColumn } from "../../../components/table/TableCore.vue";
import { fetchNumberingRules, saveNumberingRule, type NumberingRule } from "../../../services/numberingApi";

const props = defineProps<{
  canManage: boolean;
}>();
const emit = defineEmits<{
  dirtyChange: [dirty: boolean];
}>();

type PendingDialog = "save" | "discardClose" | "discardRefresh" | "discardSelect";
type ErrorField = "prefix" | "width" | "lastNumber" | "";

const rules = ref<NumberingRule[]>([]);
const selectedRule = ref<NumberingRule | null>(null);
const draftRule = ref<NumberingRule | null>(null);
const pendingSelection = ref<NumberingRule | null>(null);
const pendingDialog = ref<PendingDialog | null>(null);
const message = ref("");
const loading = ref(false);
const saving = ref(false);
const errorField = ref<ErrorField>("");
const prefixInput = ref<HTMLInputElement | null>(null);
const widthInput = ref<HTMLInputElement | null>(null);
const lastNumberInput = ref<HTMLInputElement | null>(null);
const numberingTableColumns = ref<TableCoreColumn[]>([
  { key: "label", title: "单据名称", width: 180, minWidth: 120, filterable: false },
  { key: "typeCode", title: "系统类型", width: 170, minWidth: 120, filterable: false },
  { key: "prefix", title: "前缀", width: 100, minWidth: 80, filterable: false },
  { key: "width", title: "流水位数", width: 96, minWidth: 80, align: "right", filterable: false, headerClass: "entry-number-cell", cellClass: "entry-number-cell" },
  { key: "lastNumber", title: "当前流水", width: 110, minWidth: 86, align: "right", filterable: false, headerClass: "entry-number-cell", cellClass: "entry-number-cell" },
  { key: "enabled", title: "启用", width: 72, minWidth: 64, align: "center", filterable: false },
  { key: "updatedAt", title: "更新时间", width: 160, minWidth: 120, filterable: false },
  { key: "operation", title: "操作", width: 96, minWidth: 86, align: "center", filterable: false, resizable: false }
]);

const dirty = computed(() => {
  if (!selectedRule.value || !draftRule.value) return false;
  return draftRule.value.prefix !== selectedRule.value.prefix
    || draftRule.value.width !== selectedRule.value.width
    || draftRule.value.lastNumber !== selectedRule.value.lastNumber
    || draftRule.value.enabled !== selectedRule.value.enabled;
});
const maximumLastNumber = computed(() => {
  const width = Number(draftRule.value?.width);
  if (!Number.isInteger(width) || width < 3 || width > 12) return "";
  return (10n ** BigInt(width) - 1n).toString();
});
const numberingActions = computed<ActionBarItem[]>(() => [
  defineAction("refresh", { enabled: !loading.value && !saving.value, testId: "numbering-refresh" })
]);
const numberingEditorHeadActions = computed<ActionBarItem[]>(() => [
  defineAction("closeEditor", {
    label: "关闭",
    order: 60,
    enabled: !saving.value,
    testId: "numbering-close-editor"
  })
]);
const numberingEditorActions = computed<ActionBarItem[]>(() => [
  defineAction("save", {
    label: saving.value ? "保存中…" : "保存该单据规则",
    enabled: props.canManage && dirty.value && !saving.value,
    testId: "numbering-save-selected"
  })
]);
const pendingDialogTitle = computed(() => pendingDialog.value === "save" ? "确认修改编号规则" : "放弃未保存修改");
const pendingDialogMessage = computed(() => {
  if (pendingDialog.value === "save") {
    return `修改「${selectedRule.value?.label || "当前单据"}」的编号规则会影响之后生成的单据编号，确定保存吗？`;
  }
  if (pendingDialog.value === "discardRefresh") return "刷新会丢失当前未保存的编号规则修改，确定继续吗？";
  if (pendingDialog.value === "discardSelect") return "切换到其他单据会丢失当前未保存的编号规则修改，确定继续吗？";
  return "关闭编辑区会丢失当前未保存的编号规则修改，确定继续吗？";
});

watch(dirty, (value) => emit("dirtyChange", value), { immediate: true });

onMounted(() => {
  void loadRules();
});

async function loadRules() {
  if (loading.value) return;
  loading.value = true;
  message.value = "";
  const result = await fetchNumberingRules();
  loading.value = false;
  if (!result.ok) {
    rules.value = [];
    message.value = result.message;
    return;
  }
  rules.value = result.rules;
  if (selectedRule.value) {
    const refreshed = result.rules.find((rule) => rule.documentType === selectedRule.value?.documentType);
    if (refreshed) selectRule(refreshed);
    else closeEditorNow();
  }
}

function handleAction(key: string) {
  const handlers: Record<string, () => void> = {
    refresh: requestRefresh,
    closeEditor: requestCloseEditor,
    save: requestSave
  };
  handlers[key]?.();
}

function resizeNumberingColumn(payload: { column: TableCoreColumn; width: number }) {
  payload.column.width = payload.width;
}

function numberingRowKey(row: NumberingRule) {
  return row.documentType;
}

function numberingRowClass(row: NumberingRule) {
  return ["vxe-body--row", { active: selectedRule.value?.documentType === row.documentType }];
}

function numberingCellTitle(row: NumberingRule, column: TableCoreColumn) {
  return numberingCellValue(row, column.key);
}

function numberingCellValue(row: NumberingRule, key: string) {
  const value = row[key as keyof NumberingRule];
  return value == null ? "" : String(value);
}

function requestSelectRule(rule: NumberingRule) {
  if (saving.value) return;
  if (dirty.value && selectedRule.value?.documentType === rule.documentType) {
    message.value = "当前规则有未保存修改，已为你保留。";
    void nextTick(() => prefixInput.value?.focus());
    return;
  }
  if (dirty.value && selectedRule.value?.documentType !== rule.documentType) {
    pendingSelection.value = { ...rule };
    pendingDialog.value = "discardSelect";
    return;
  }
  selectRule(rule);
}

function selectRule(rule: NumberingRule) {
  selectedRule.value = { ...rule };
  draftRule.value = { ...rule };
  pendingSelection.value = null;
  errorField.value = "";
  message.value = "";
}

function requestCloseEditor() {
  if (saving.value) return;
  if (dirty.value) {
    pendingDialog.value = "discardClose";
    return;
  }
  closeEditorNow();
}

function closeEditorNow() {
  selectedRule.value = null;
  draftRule.value = null;
  pendingSelection.value = null;
  errorField.value = "";
}

function requestRefresh() {
  if (loading.value || saving.value) return;
  if (dirty.value) {
    pendingDialog.value = "discardRefresh";
    return;
  }
  void loadRules();
}

function requestSave() {
  if (!props.canManage || saving.value || !dirty.value || !validateDraft()) return;
  pendingDialog.value = "save";
}

function validateDraft() {
  const draft = draftRule.value;
  if (!draft) return false;
  if (!/^[A-Za-z0-9_-]{1,24}$/.test(draft.prefix)) {
    return validationFailure("prefix", "编号前缀只能使用 1-24 位字母、数字、下划线或短横线。");
  }
  if (!Number.isInteger(draft.width) || draft.width < 3 || draft.width > 12) {
    return validationFailure("width", "流水位数需在 3-12 位之间。");
  }
  if (!/^(0|[1-9][0-9]*)$/.test(draft.lastNumber)) {
    return validationFailure("lastNumber", "当前流水必须是非负整数，不能包含小数、符号或前导零。");
  }
  if (BigInt(draft.lastNumber) > 10n ** BigInt(draft.width) - 1n) {
    return validationFailure("lastNumber", `当前流水不能超过 ${draft.width} 位流水上限 ${maximumLastNumber.value}。`);
  }
  errorField.value = "";
  return true;
}

function validationFailure(field: ErrorField, errorMessage: string) {
  errorField.value = field;
  message.value = errorMessage;
  void nextTick(() => focusField(field));
  return false;
}

function focusField(field: ErrorField) {
  if (field === "prefix") prefixInput.value?.focus();
  if (field === "width") widthInput.value?.focus();
  if (field === "lastNumber") lastNumberInput.value?.focus();
}

function cancelDialog() {
  if (saving.value) return;
  pendingDialog.value = null;
  pendingSelection.value = null;
}

function confirmDialog() {
  const action = pendingDialog.value;
  pendingDialog.value = null;
  if (action === "save") {
    void persistSelectedRule();
    return;
  }
  if (action === "discardClose") {
    closeEditorNow();
    return;
  }
  if (action === "discardRefresh") {
    if (selectedRule.value) draftRule.value = { ...selectedRule.value };
    void loadRules();
    return;
  }
  if (action === "discardSelect" && pendingSelection.value) {
    const nextRule = pendingSelection.value;
    pendingSelection.value = null;
    selectRule(nextRule);
  }
}

async function persistSelectedRule() {
  if (!draftRule.value || !props.canManage || saving.value || !validateDraft()) return;
  saving.value = true;
  message.value = "正在保存编号规则…";
  const result = await saveNumberingRule({ ...draftRule.value });
  saving.value = false;
  if (!result.ok || !result.rule) {
    message.value = result.message;
    if (result.status === 400) focusApiError(result.message);
    return;
  }
  const persisted = result.rule;
  const index = rules.value.findIndex((rule) => rule.documentType === persisted.documentType);
  if (index >= 0) rules.value.splice(index, 1, persisted);
  else rules.value.push(persisted);
  selectedRule.value = { ...persisted };
  draftRule.value = { ...persisted };
  errorField.value = "";
  message.value = result.message;
}

function focusApiError(errorMessage: string) {
  if (errorMessage.includes("前缀")) validationFailure("prefix", errorMessage);
  else if (errorMessage.includes("位数")) validationFailure("width", errorMessage);
  else if (errorMessage.includes("流水")) validationFailure("lastNumber", errorMessage);
}
</script>
