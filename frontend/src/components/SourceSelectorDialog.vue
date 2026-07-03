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
          @compositionstart="keywordComposing = true"
          @compositionend="keywordComposing = false"
          @keydown.enter="handleKeywordEnter"
        />
        <button type="button" :data-testid="`${testPrefix}-source-selector-query`" @click="applyKeyword">查询</button>
        <button v-if="showColumnSettings" type="button" :data-testid="`${testPrefix}-source-selector-column-settings`" @click="columnDialogOpen = true">列设置</button>
        <strong :data-testid="`${testPrefix}-source-selector-count`">{{ countLabel }}</strong>
      </div>
      <div class="source-selector-content" :class="{ 'has-sidebar': Boolean($slots.sidebar) }">
        <aside v-if="$slots.sidebar" class="source-selector-sidebar">
          <slot name="sidebar" />
        </aside>
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
            :rows="displayedRows"
            :min-width="sourceSelectorMinWidth"
            :row-key="rowKey"
            :row-attrs="sourceRowAttrs"
            :cell-title="sourceSelectorCellTitle"
            @column-resize="resizeSourceColumn"
            @column-resize-end="resizeSourceColumn"
          >
            <template #header-cell="{ column, startResize }">
              <label v-if="column.key === selectionKey && showSelectAll" class="source-selector-select-all">
                <input
                  type="checkbox"
                  :checked="visibleSelectionChecked"
                  :indeterminate.prop="visibleSelectionIndeterminate"
                  :data-testid="`${testPrefix}-source-selector-select-all`"
                  @change="toggleVisibleSelection(($event.target as HTMLInputElement).checked)"
                />
              </label>
              <TableCoreHeaderCell
                v-else-if="column.key !== selectionKey"
                :title="column.title"
                :column-key="column.key"
                :filter-test-id="column.filterTestId"
                :resize-test-id="column.resizeTestId"
                :filterable="column.filterable !== false"
                :resizable="column.resizable !== false"
                :filter-active="Boolean(column.filterActive)"
                @filter="openColumnFilter(column, $event)"
                @resize-start="startResize(column, $event)"
              />
            </template>
            <template #cell="{ row, column }">
              <input
                v-if="column.key === selectionKey"
                type="checkbox"
                :checked="Boolean(selected[rowKey(row)])"
                :data-testid="`${testPrefix}-source-line-${rowKey(row)}`"
                @change="emit('toggle', row, ($event.target as HTMLInputElement).checked)"
              />
              <div v-else class="vxe-cell">
                <span>{{ formatCell(row, column.key) }}</span>
              </div>
            </template>
            <template #overlay>
              <div v-if="loading" class="list-state-panel">加载中...</div>
              <div v-else-if="displayedRows.length === 0" class="list-state-panel">{{ emptyText }}</div>
            </template>
          </TableCore>
        </div>
      </div>
      <div class="source-selector-footer">
        <div class="source-selector-summary" :data-testid="`${testPrefix}-source-selector-summary`">
          <span v-for="item in effectiveSummaryItems" :key="item.key" :class="{ strong: item.strong }">
            {{ item.label }}：{{ item.value }}
          </span>
        </div>
        <div class="source-selector-pagination" :data-testid="`${testPrefix}-source-selector-pagination`">
          <span>共 {{ effectivePagination.total }} 条</span>
          <select
            v-model.number="localPageSize"
            :data-testid="`${testPrefix}-source-selector-page-size`"
            @change="changePageSize"
          >
            <option v-for="option in pageSizeOptions" :key="option" :value="option">{{ option }}条/页</option>
          </select>
          <button type="button" :disabled="!canPagePrev" @click="goPage(effectivePagination.page - 1)">上一页</button>
          <span>第 {{ effectivePagination.page }} / {{ effectivePageCount }} 页</span>
          <button type="button" :disabled="!canPageNext" @click="goPage(effectivePagination.page + 1)">下一页</button>
        </div>
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

  <ColumnFilterPopover
    :open="filterDialogOpen && Boolean(activeFilterColumn)"
    :operators="tableFilterOperators"
    :operator="activeFilterOperator"
    :value="activeFilterValue"
    :left="filterPopoverLeft"
    :top="filterPopoverTop"
    :test-id="`${testPrefix}-source-selector-column-filter-dialog`"
    @update:operator="activeFilterOperator = $event"
    @update:value="activeFilterValue = $event"
    @apply="applySourceColumnFilter"
    @clear="clearSourceColumnFilter"
  />
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import ColumnSettingsDialog from "./table/ColumnSettingsDialog.vue";
import ColumnFilterPopover from "./table/ColumnFilterPopover.vue";
import TableCore, { type TableCoreColumn } from "./table/TableCore.vue";
import TableCoreHeaderCell from "./table/TableCoreHeaderCell.vue";
import { tableFilterOperators, useColumnFilters } from "./table/useColumnFilters";

export interface SourceSelectorColumn {
  key: string;
  title: string;
  width?: number;
  visible: boolean;
  fixed?: "" | "left" | "right";
  configurable?: boolean;
  align?: "left" | "center" | "right";
  filterable?: boolean;
  resizable?: boolean;
}

export interface SourceSelectorSummaryItem {
  key: string;
  label: string;
  value: string | number;
  strong?: boolean;
}

export interface SourceSelectorPagination {
  total: number;
  page: number;
  pageSize: number;
}

export interface SourceSelectorQueryChange {
  keyword: string;
  columnFilters: Record<string, { operator: string; value: string }>;
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
  pagination?: SourceSelectorPagination | null;
  pageSizeOptions?: number[];
  showColumnSettings?: boolean;
  showSelectAll?: boolean;
  rowClickable?: boolean;
}>(), {
  emptyText: "暂无可选明细",
  selectionKey: "selection",
  summaryItems: () => [],
  pagination: null,
  pageSizeOptions: () => [200, 500, 1000],
  showColumnSettings: true,
  showSelectAll: true,
  rowClickable: false
});

const emit = defineEmits<{
  "update:keyword": [value: string];
  search: [value: string];
  queryChange: [query: SourceSelectorQueryChange];
  selectAll: [checked: boolean, rows: unknown[]];
  pageChange: [page: number];
  pageSizeChange: [pageSize: number];
  toggle: [row: unknown, checked: boolean];
  rowClick: [row: unknown];
  close: [];
  confirm: [];
  resetColumns: [];
}>();

const columnDialogOpen = ref(false);
const draftKeyword = ref(props.keyword);
const keywordComposing = ref(false);
const localPage = ref(1);
const localPageSize = ref(props.pagination?.pageSize ?? props.pageSizeOptions[0] ?? 200);
const localColumns = ref<SourceSelectorColumn[]>([]);
const visibleColumns = computed(() => localColumns.value.filter((column) => column.visible !== false));
const selectedCount = computed(() => Object.values(props.selected).filter(Boolean).length);
const {
  columnFilters,
  activeFilterColumn,
  filterDialogOpen,
  activeFilterOperator,
  activeFilterValue,
  filterPopoverLeft,
  filterPopoverTop,
  openColumnFilter,
  applyColumnFilter,
  clearColumnFilter,
  isFilterActive
} = useColumnFilters<TableCoreColumn>((row, _rowIndex, columnKey) => String(props.formatCell(row, columnKey) ?? ""));
const internalPageCount = computed(() => Math.max(1, Math.ceil(props.rows.length / Math.max(localPageSize.value, 1))));
const effectivePagination = computed<SourceSelectorPagination>(() => props.pagination ?? {
  total: props.rows.length,
  page: Math.min(localPage.value, internalPageCount.value),
  pageSize: localPageSize.value
});
const effectivePageCount = computed(() => Math.max(1, Math.ceil(effectivePagination.value.total / Math.max(effectivePagination.value.pageSize, 1))));
const displayedRows = computed(() => {
  if (props.pagination) {
    return props.rows;
  }
  const start = (effectivePagination.value.page - 1) * effectivePagination.value.pageSize;
  return props.rows.slice(start, start + effectivePagination.value.pageSize);
});
const filteredSelectedCount = computed(() => props.rows.filter((row) => Boolean(props.selected[props.rowKey(row)])).length);
const visibleSelectionChecked = computed(() => props.rows.length > 0 && filteredSelectedCount.value === props.rows.length);
const visibleSelectionIndeterminate = computed(() => selectedCount.value > 0 && !visibleSelectionChecked.value);
const canPagePrev = computed(() => effectivePagination.value.page > 1);
const canPageNext = computed(() => effectivePagination.value.page < effectivePageCount.value);
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
  filterable: column.key !== props.selectionKey && column.filterable !== false,
  resizable: column.key !== props.selectionKey && column.resizable !== false,
  filterActive: isFilterActive(column.key),
  filterTestId: `${props.testPrefix}-source-selector-column-filter-${column.key}`,
  resizeTestId: `${props.testPrefix}-source-selector-column-resize-${column.key}`,
  headerClass: ["vxe-header--column", column.align === "right" ? "entry-number-cell" : ""],
  cellClass: ["vxe-body--column", column.align === "right" ? "entry-number-cell" : ""]
})));
const sourceSelectorMinWidth = computed(() => Math.max(1320, tableColumns.value.reduce((sum, column) => sum + Number(column.width ?? column.minWidth ?? 100), 0)));

function sourceSelectorCellTitle(row: unknown, column: TableCoreColumn) {
  if (column.key === props.selectionKey) {
    return undefined;
  }
  return String(props.formatCell(row, column.key));
}

function sourceRowAttrs(row: unknown) {
  if (!props.rowClickable) {
    return {};
  }
  return {
    tabindex: 0,
    onClick: () => emit("rowClick", row),
    onKeydown: (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        emit("rowClick", row);
      }
    }
  };
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
  emitQueryChange(keyword);
  localPage.value = 1;
}

function applySourceColumnFilter() {
  applyColumnFilter();
  localPage.value = 1;
  emitQueryChange(draftKeyword.value.trim());
}

function clearSourceColumnFilter() {
  clearColumnFilter();
  localPage.value = 1;
  emitQueryChange(draftKeyword.value.trim());
}

function handleKeywordEnter(event: KeyboardEvent) {
  if (event.isComposing || keywordComposing.value) {
    return;
  }
  event.preventDefault();
  applyKeyword();
}

function toggleVisibleSelection(checked: boolean) {
  emit("selectAll", checked, checked ? props.rows : []);
}

function goPage(page: number) {
  const normalizedPage = Math.min(Math.max(1, page), effectivePageCount.value);
  if (props.pagination) {
    emit("pageChange", normalizedPage);
    return;
  }
  localPage.value = normalizedPage;
}

function changePageSize() {
  localPage.value = 1;
  emit("pageSizeChange", localPageSize.value);
}

watch(() => props.keyword, (value) => {
  draftKeyword.value = value;
});

watch(() => props.open, (open) => {
  if (open) {
    draftKeyword.value = props.keyword;
    localPage.value = 1;
    clearAllColumnFilters();
  }
});

watch(() => props.pagination?.pageSize, (pageSize) => {
  if (pageSize) {
    localPageSize.value = pageSize;
  }
});

watch(() => props.rows.length, () => {
  localPage.value = Math.min(localPage.value, internalPageCount.value);
});

watch(() => Object.keys(columnFilters).join("|"), () => {
  localPage.value = 1;
});

watch(() => props.columns, (columns) => {
  localColumns.value = columns.map((column) => ({ ...column, fixed: column.fixed ?? "" }));
}, { deep: true, immediate: true });

function resizeSourceColumn(payload: { column: TableCoreColumn; width: number }) {
  const target = localColumns.value.find((column) => column.key === payload.column.key);
  if (target) {
    target.width = payload.width;
  }
}

function clearAllColumnFilters() {
  Object.keys(columnFilters).forEach((key) => delete columnFilters[key]);
  activeFilterColumn.value = null;
  filterDialogOpen.value = false;
  activeFilterOperator.value = "包含";
  activeFilterValue.value = "";
}

function emitQueryChange(keyword: string) {
  emit("queryChange", {
    keyword,
    columnFilters: Object.fromEntries(Object.entries(columnFilters).map(([key, filter]) => [key, { ...filter }]))
  });
}
</script>
