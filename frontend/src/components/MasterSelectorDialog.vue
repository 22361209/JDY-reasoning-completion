<template>
  <div v-if="open" class="modal-mask" data-testid="master-selector-dialog">
    <div class="dialog master-selector-dialog">
      <h3>{{ title }}</h3>
      <div class="master-selector-dialog__toolbar">
        <label>
          搜索
          <input
            v-model="draftKeyword"
            data-testid="master-selector-search"
            :placeholder="`${label}编码、名称`"
            @keydown.enter.prevent="emit('search', draftKeyword)"
          />
        </label>
        <button type="button" data-testid="master-selector-search-button" @click="emit('search', draftKeyword)">搜索</button>
        <button type="button" data-testid="master-selector-new" disabled>新增</button>
      </div>
      <div class="master-selector-dialog__body">
        <aside class="master-selector-dialog__tree">
          <strong>全部{{ label }}</strong>
          <span>启用资料</span>
          <span>最近使用</span>
        </aside>
        <div class="master-selector-dialog__table">
          <TableCore
            kind="list"
            test-id="master-selector-table-core"
            frame-class="vxe-wrap master-selector-table-core"
            inner-class="table-core-vxe-inner"
            table-class="vxe-table data-list-native-table"
            header-wrapper-class="vxe-table--header-wrapper body--wrapper"
            body-wrapper-class="vxe-table--body-wrapper body--wrapper"
            header-row-class="vxe-header--row"
            row-class="vxe-body--row"
            :columns="selectorColumns"
            :rows="rows"
            :min-width="620"
            :row-key="selectorRowKey"
            :row-attrs="selectorRowAttrs"
            :cell-title="selectorCellTitle"
          >
            <template #cell="{ row, column }">
              <span v-if="column.key === 'selection'" class="selector-row-radio" />
              <strong v-else-if="column.key === 'code'">{{ selectorCellValue(row, column.key) }}</strong>
              <span v-else>{{ selectorCellValue(row, column.key) }}</span>
            </template>
            <template #overlay>
              <div v-if="loading" class="list-state-panel">加载中...</div>
              <div v-else-if="rows.length === 0" class="list-state-panel">暂无可选资料</div>
            </template>
          </TableCore>
        </div>
      </div>
      <div class="master-selector-dialog__summary">
        <span data-testid="master-selector-total">共 {{ total }} 条</span>
        <span>点击行即回填当前字段</span>
      </div>
      <p v-if="message" class="form-error" data-testid="master-selector-message">{{ message }}</p>
      <div class="dialog-actions">
        <button type="button" data-testid="master-selector-cancel" @click="emit('close')">取消</button>
        <button class="primary-action" type="button" data-testid="master-selector-confirm" @click="emit('close')">确定</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import type { MasterOption } from "./EntryTable.vue";
import TableCore, { type TableCoreColumn } from "./table/TableCore.vue";

const props = defineProps<{
  open: boolean;
  title: string;
  label: string;
  keyword: string;
  rows: MasterOption[];
  total: number;
  loading: boolean;
  message: string;
}>();

const emit = defineEmits<{
  close: [];
  search: [keyword: string];
  select: [option: MasterOption];
}>();

const draftKeyword = ref(props.keyword);
const selectorColumns: TableCoreColumn[] = [
  { key: "selection", title: "选择", width: 48, minWidth: 48, align: "center", resizable: false, filterable: false, headerClass: "selector-pick-col", cellClass: "selector-pick-col" },
  { key: "code", title: `${props.label}编码`, width: 150, minWidth: 96, filterable: false },
  { key: "name", title: `${props.label}名称`, width: 180, minWidth: 120, filterable: false },
  { key: "spec", title: "规格", width: 140, minWidth: 96, filterable: false },
  { key: "unit", title: "单位", width: 80, minWidth: 64, filterable: false }
];

function selectorRowKey(row: MasterOption) {
  return row.code;
}

function selectorRowAttrs(row: MasterOption) {
  return {
    tabindex: 0,
    "data-testid": `master-selector-row-${row.code}`,
    onClick: () => emit("select", row),
    onKeydown: (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        emit("select", row);
      }
    }
  };
}

function selectorCellTitle(row: MasterOption, column: TableCoreColumn) {
  return selectorCellValue(row, column.key);
}

function selectorCellValue(row: MasterOption, key: string) {
  const value = row[key as keyof MasterOption];
  return value == null || value === "" ? "-" : String(value);
}

watch(() => props.keyword, (value) => {
  draftKeyword.value = value;
});

watch(() => props.open, (open) => {
  if (open) {
    draftKeyword.value = props.keyword;
  }
});
</script>
