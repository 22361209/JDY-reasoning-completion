<template>
  <div v-if="open" class="modal-mask" :data-testid="`${testPrefix}-source-selector-dialog`">
    <div class="dialog source-selector-dialog">
      <h3>{{ title }}</h3>
      <p>{{ description }}</p>
      <div class="source-selector-toolbar">
        <input
          v-model="draftKeyword"
          :data-testid="`${testPrefix}-source-selector-search`"
          :placeholder="searchPlaceholder"
          @keydown.enter.prevent="applyKeyword"
        />
        <button type="button" :data-testid="`${testPrefix}-source-selector-query`" @click="applyKeyword">查询</button>
        <button v-if="showSelectAll" type="button" :data-testid="`${testPrefix}-source-selector-select-all`" @click="emit('selectAll')">全选</button>
        <button v-if="showColumnSettings" type="button" :data-testid="`${testPrefix}-source-selector-column-settings`" @click="columnDialogOpen = true">列设置</button>
        <strong :data-testid="`${testPrefix}-source-selector-count`">{{ countLabel }}</strong>
      </div>
      <div class="source-selector-table">
        <TableCore
          kind="list"
          :test-id="`${testPrefix}-source-selector-table-core`"
          frame-class="vxe-wrap source-selector-table-core"
          inner-class="table-core-vxe-inner"
          table-class="vxe-table data-list-native-table"
          header-wrapper-class="vxe-table--header-wrapper body--wrapper"
          body-wrapper-class="vxe-table--body-wrapper body--wrapper"
          header-row-class="vxe-header--row"
          row-class="vxe-body--row"
          :columns="tableColumns"
          :rows="rows"
          :min-width="sourceSelectorMinWidth"
          :row-key="rowKey"
          :cell-title="sourceSelectorCellTitle"
        >
          <template #cell="{ row, column }">
            <input
              v-if="column.key === selectionKey"
              type="checkbox"
              :checked="Boolean(selected[rowKey(row)])"
              :data-testid="`${testPrefix}-source-line-${rowKey(row)}`"
              @change="emit('toggle', row, ($event.target as HTMLInputElement).checked)"
            />
            <span v-else>{{ formatCell(row, column.key) }}</span>
          </template>
          <template #overlay>
            <div v-if="loading" class="list-state-panel">加载中...</div>
            <div v-else-if="rows.length === 0" class="list-state-panel">{{ emptyText }}</div>
          </template>
        </TableCore>
      </div>
      <div class="source-selector-summary" :data-testid="`${testPrefix}-source-selector-summary`">
        <span v-for="item in effectiveSummaryItems" :key="item.key" :class="{ strong: item.strong }">
          {{ item.label }}：{{ item.value }}
        </span>
      </div>
      <p v-if="message" class="form-error" :data-testid="`${testPrefix}-source-selector-message`">{{ message }}</p>
      <div class="dialog-actions">
        <button type="button" :data-testid="`${testPrefix}-source-selector-cancel`" @click="emit('close')">取消</button>
        <button class="primary-action" type="button" :data-testid="`${testPrefix}-source-selector-ok`" @click="emit('confirm')">确定</button>
      </div>
    </div>
  </div>

  <ColumnSettingsDialog
    v-if="showColumnSettings"
    :open="columnDialogOpen"
    title="列设置"
    :columns="localColumns"
    :dialog-test-id="`${testPrefix}-source-selector-column-settings-dialog`"
    :ok-test-id="`${testPrefix}-source-selector-column-settings-ok`"
    @reset="resetColumns"
    @confirm="columnDialogOpen = false"
  />
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import ColumnSettingsDialog from "./table/ColumnSettingsDialog.vue";
import TableCore, { type TableCoreColumn } from "./table/TableCore.vue";

export interface SourceSelectorColumn {
  key: string;
  title: string;
  width?: number;
  visible: boolean;
  fixed?: "" | "left" | "right";
  configurable?: boolean;
  align?: "left" | "center" | "right";
}

export interface SourceSelectorSummaryItem {
  key: string;
  label: string;
  value: string | number;
  strong?: boolean;
}

const props = withDefaults(defineProps<{
  open: boolean;
  testPrefix: string;
  title: string;
  description: string;
  keyword: string;
  searchPlaceholder: string;
  loading: boolean;
  rows: unknown[];
  columns: SourceSelectorColumn[];
  selected: Record<string, boolean>;
  countLabel: string;
  message: string;
  rowKey: (row: unknown) => string;
  formatCell: (row: unknown, columnKey: string) => string | number;
  emptyText?: string;
  selectionKey?: string;
  summaryItems?: SourceSelectorSummaryItem[];
  showColumnSettings?: boolean;
  showSelectAll?: boolean;
}>(), {
  emptyText: "暂无可选明细",
  selectionKey: "selection",
  summaryItems: () => [],
  showColumnSettings: true,
  showSelectAll: true
});

const emit = defineEmits<{
  "update:keyword": [value: string];
  search: [value: string];
  selectAll: [];
  toggle: [row: unknown, checked: boolean];
  close: [];
  confirm: [];
  resetColumns: [];
}>();

const columnDialogOpen = ref(false);
const draftKeyword = ref(props.keyword);
const localColumns = ref<SourceSelectorColumn[]>([]);
const visibleColumns = computed(() => localColumns.value.filter((column) => column.visible !== false));
const selectedCount = computed(() => Object.values(props.selected).filter(Boolean).length);
const effectiveSummaryItems = computed<SourceSelectorSummaryItem[]>(() => {
  if (props.summaryItems.length > 0) {
    return props.summaryItems;
  }
  return [
    { key: "visibleRows", label: "当前明细", value: `${props.rows.length} 行`, strong: true },
    { key: "selectedRows", label: "已选", value: `${selectedCount.value} 行` }
  ];
});
const tableColumns = computed<TableCoreColumn[]>(() => visibleColumns.value.map((column) => ({
  key: column.key,
  title: column.title,
  width: column.width,
  minWidth: column.key === props.selectionKey ? 48 : 84,
  align: column.align,
  fixed: column.fixed,
  filterable: false,
  resizable: false,
  headerClass: column.align === "right" ? "entry-number-cell" : undefined,
  cellClass: column.align === "right" ? "entry-number-cell" : undefined
})));
const sourceSelectorMinWidth = computed(() => Math.max(1320, tableColumns.value.reduce((sum, column) => sum + Number(column.width ?? column.minWidth ?? 100), 0)));

function sourceSelectorCellTitle(row: unknown, column: TableCoreColumn) {
  if (column.key === props.selectionKey) {
    return undefined;
  }
  return String(props.formatCell(row, column.key));
}

function resetColumns() {
  localColumns.value.forEach((column) => {
    column.visible = true;
    column.fixed = "";
  });
  emit("resetColumns");
}

function applyKeyword() {
  const keyword = draftKeyword.value.trim();
  emit("update:keyword", keyword);
  emit("search", keyword);
}

watch(() => props.keyword, (value) => {
  draftKeyword.value = value;
});

watch(() => props.open, (open) => {
  if (open) {
    draftKeyword.value = props.keyword;
  }
});

watch(() => props.columns, (columns) => {
  localColumns.value = columns.map((column) => ({ ...column, fixed: column.fixed ?? "" }));
}, { deep: true, immediate: true });
</script>
