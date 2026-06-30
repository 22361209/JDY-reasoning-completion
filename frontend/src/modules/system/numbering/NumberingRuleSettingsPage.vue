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
            :disabled="!canManage"
            :data-testid="`numbering-edit-${rule.documentType}`"
            @click="selectRule(rule)"
          >编辑规则</button>
          <code v-else-if="column.key === 'typeCode'">{{ numberingCellValue(rule, column.key) }}</code>
          <span v-else>{{ numberingCellValue(rule, column.key) }}</span>
        </template>
        <template #overlay>
          <div v-if="!rules.length" class="list-state-panel" data-testid="numbering-empty">{{ message || "暂无编号规则。" }}</div>
        </template>
      </TableCore>
    </div>

    <section v-if="selectedRule && draftRule" class="settings-card numbering-editor" data-testid="numbering-rule-editor">
      <div class="settings-card__head">
        <div>
          <h3>{{ selectedRule.label }}</h3>
          <p>系统类型：<code>{{ selectedRule.typeCode || selectedRule.documentType }}</code></p>
        </div>
        <ActionBar :actions="numberingEditorHeadActions" @action="handleAction" />
      </div>
      <div class="settings-form-grid">
        <label>
          编号前缀
          <input v-model.trim="draftRule.prefix" :disabled="!canManage" data-testid="numbering-edit-prefix" />
        </label>
        <label>
          流水位数
          <input v-model.number="draftRule.width" :disabled="!canManage" type="number" min="3" max="12" data-testid="numbering-edit-width" />
        </label>
        <label>
          当前流水
          <input v-model.number="draftRule.lastNumber" :disabled="!canManage" type="number" min="0" data-testid="numbering-edit-last" />
        </label>
        <label class="settings-check">
          <input v-model="draftRule.enabled" :disabled="!canManage" type="checkbox" data-testid="numbering-edit-enabled" />
          启用该规则
        </label>
      </div>
      <p class="settings-hint">修改当前流水会影响下一张新单据编号；已生成的历史单据编号不会被改写。</p>
      <div class="settings-actions">
        <ActionBar :actions="numberingEditorActions" @action="handleAction" />
      </div>
    </section>
    <p v-if="message" class="form-message settings-message" data-testid="numbering-message">{{ message }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import ActionBar from "../../../components/ActionBar.vue";
import { defineAction, type ActionBarItem } from "../../../components/actions/actionRegistry";
import DocumentCommandHeader from "../../../components/DocumentCommandHeader.vue";
import TableCore, { type TableCoreColumn } from "../../../components/table/TableCore.vue";
import { fetchNumberingRules, saveNumberingRule, type NumberingRule } from "../../../services/numberingApi";

const props = defineProps<{
  canManage: boolean;
}>();

const rules = ref<NumberingRule[]>([]);
const selectedRule = ref<NumberingRule | null>(null);
const draftRule = ref<NumberingRule | null>(null);
const message = ref("");
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
const numberingActions = computed<ActionBarItem[]>(() => [
  defineAction("refresh", { enabled: true, testId: "numbering-refresh" })
]);
const numberingEditorHeadActions = computed<ActionBarItem[]>(() => [
  defineAction("closeEditor", {
    label: "关闭",
    order: 60,
    enabled: true,
    testId: "numbering-close-editor"
  })
]);
const numberingEditorActions = computed<ActionBarItem[]>(() => [
  defineAction("save", {
    label: "保存该单据规则",
    enabled: props.canManage,
    testId: "numbering-save-selected"
  })
]);

onMounted(() => {
  void loadRules();
});

async function loadRules() {
  const result = await fetchNumberingRules();
  rules.value = result.rules;
  message.value = result.message;
  if (selectedRule.value) {
    const refreshed = rules.value.find((rule) => rule.documentType === selectedRule.value?.documentType);
    if (refreshed) {
      selectRule(refreshed, false);
    }
  }
}

function handleAction(key: string) {
  const handlers: Record<string, () => void> = {
    refresh: () => { void loadRules(); },
    closeEditor,
    save: () => { void saveSelectedRule(); }
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
  if (key === "typeCode") {
    return row.typeCode || row.documentType;
  }
  const value = row[key as keyof NumberingRule];
  return value == null ? "" : String(value);
}

function selectRule(rule: NumberingRule, clearMessage = true) {
  selectedRule.value = { ...rule };
  draftRule.value = { ...rule };
  if (clearMessage) {
    message.value = "";
  }
}

function closeEditor() {
  selectedRule.value = null;
  draftRule.value = null;
}

async function saveSelectedRule() {
  if (!draftRule.value || !props.canManage) {
    return;
  }
  const result = await saveNumberingRule(draftRule.value);
  if (result.ok) {
    rules.value = result.rules;
    const refreshed = result.rules.find((rule) => rule.documentType === draftRule.value?.documentType);
    if (refreshed) {
      selectRule(refreshed, false);
    }
  }
  message.value = result.message;
}
</script>
