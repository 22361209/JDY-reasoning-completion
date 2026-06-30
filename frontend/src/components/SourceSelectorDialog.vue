<template>
  <div v-if="open" class="modal-mask" :data-testid="`${testPrefix}-source-selector-dialog`">
    <div class="dialog source-selector-dialog">
      <h3>{{ title }}</h3>
      <p>{{ description }}</p>
      <div class="source-selector-toolbar">
        <input
          :value="keyword"
          :data-testid="`${testPrefix}-source-selector-search`"
          :placeholder="searchPlaceholder"
          @input="emit('update:keyword', ($event.target as HTMLInputElement).value)"
        />
        <button v-if="showSelectAll" type="button" :data-testid="`${testPrefix}-source-selector-select-all`" @click="emit('selectAll')">全选</button>
        <button v-if="showColumnSettings" type="button" :data-testid="`${testPrefix}-source-selector-column-settings`" @click="columnDialogOpen = true">列设置</button>
        <strong :data-testid="`${testPrefix}-source-selector-count`">{{ countLabel }}</strong>
      </div>
      <div class="source-selector-table">
        <table>
          <thead>
            <tr>
              <th v-for="column in visibleColumns" :key="column.key" :style="columnStyle(column)">{{ column.title }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading">
              <td :colspan="visibleColumns.length">加载中...</td>
            </tr>
            <tr v-else-if="rows.length === 0">
              <td :colspan="visibleColumns.length">{{ emptyText }}</td>
            </tr>
            <template v-else>
              <tr v-for="row in rows" :key="rowKey(row)">
                <td v-for="column in visibleColumns" :key="column.key" :class="{ 'source-selector-cell--number': column.align === 'right' }">
                  <input
                    v-if="column.key === selectionKey"
                    type="checkbox"
                    :checked="Boolean(selected[rowKey(row)])"
                    :data-testid="`${testPrefix}-source-line-${rowKey(row)}`"
                    @change="emit('toggle', row, ($event.target as HTMLInputElement).checked)"
                  />
                  <span v-else>{{ formatCell(row, column.key) }}</span>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
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
    :columns="columns"
    :dialog-test-id="`${testPrefix}-source-selector-column-settings-dialog`"
    :ok-test-id="`${testPrefix}-source-selector-column-settings-ok`"
    @reset="emit('resetColumns')"
    @confirm="columnDialogOpen = false"
  />
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import ColumnSettingsDialog from "./table/ColumnSettingsDialog.vue";

export interface SourceSelectorColumn {
  key: string;
  title: string;
  width?: number;
  visible: boolean;
  configurable?: boolean;
  align?: "left" | "center" | "right";
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
  showColumnSettings?: boolean;
  showSelectAll?: boolean;
}>(), {
  emptyText: "暂无可选明细",
  selectionKey: "selection",
  showColumnSettings: false,
  showSelectAll: true
});

const emit = defineEmits<{
  "update:keyword": [value: string];
  selectAll: [];
  toggle: [row: unknown, checked: boolean];
  close: [];
  confirm: [];
  resetColumns: [];
}>();

const columnDialogOpen = ref(false);
const visibleColumns = computed(() => props.columns.filter((column) => column.visible !== false));

function columnStyle(column: SourceSelectorColumn) {
  return column.width ? { width: `${column.width}px` } : {};
}
</script>
