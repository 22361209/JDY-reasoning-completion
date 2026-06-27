<template>
  <TableCoreFrame :class="frameClass" :kind="kind" :test-id="testId">
    <div class="table-core-inner" :class="innerClass" :style="tableStyle">
      <div class="table-core-native-table" :class="tableClass">
        <div class="table-core-header-wrapper" :class="headerWrapperClass">
          <table :style="tableStyle">
            <colgroup>
              <col v-for="column in columns" :key="column.key" :style="{ width: `${columnWidth(column)}px` }" />
            </colgroup>
            <thead>
              <tr :class="headerRowClass">
                <th
                  v-for="column in columns"
                  :key="column.key"
                  :class="headerCellClass(column)"
                  :style="cellStyle(column)"
                  @mousedown.left="emit('columnDragStart', column, $event)"
                >
                  <slot name="header-cell" :column="column" :start-resize="startColumnResize">
                    <TableCoreHeaderCell
                      :title="column.title"
                      :column-key="column.key"
                      :test-id="column.dragTestId"
                      :filter-test-id="column.filterTestId"
                      :resize-test-id="column.resizeTestId"
                      :filterable="column.filterable !== false"
                      :resizable="column.resizable !== false"
                      :filter-active="Boolean(column.filterActive)"
                      :dragging="Boolean(column.dragging)"
                      :drag-over="Boolean(column.dragOver)"
                      @drag-start="emit('columnDragStart', column, $event)"
                      @filter="emit('columnFilter', column, $event)"
                      @resize-start="startColumnResize(column, $event)"
                    />
                  </slot>
                </th>
              </tr>
            </thead>
          </table>
        </div>
        <div class="table-core-body-wrapper" :class="bodyWrapperClass">
          <table :style="tableStyle">
            <colgroup>
              <col v-for="column in columns" :key="column.key" :style="{ width: `${columnWidth(column)}px` }" />
            </colgroup>
            <tbody>
              <tr
                v-for="(row, rowIndex) in rows"
                :key="rowKey(row, rowIndex)"
                v-show="rowVisible(row, rowIndex)"
                v-bind="rowAttrs(row, rowIndex)"
                :class="rowClass(row, rowIndex)"
                :draggable="rowDraggable(row, rowIndex)"
                @contextmenu="emit('rowContextmenu', row, rowIndex, $event)"
                @dragstart="emit('rowDragstart', row, rowIndex, $event)"
                @dragover="emit('rowDragover', row, rowIndex, $event)"
                @drop="emit('rowDrop', row, rowIndex, $event)"
                @dragend="emit('rowDragend', row, rowIndex, $event)"
              >
                <td
                  v-for="column in columns"
                  :key="column.key"
                  :class="bodyCellClass(column)"
                  :style="cellStyle(column)"
                  :title="cellTitle(row, column, rowIndex)"
                  v-bind="cellAttrs(row, column, rowIndex)"
                >
                  <slot name="cell" :row="row" :column="column" :row-index="rowIndex" />
                </td>
              </tr>
              <slot name="body-extra" />
            </tbody>
          </table>
        </div>
        <div v-if="$slots.footer" class="table-core-footer-wrapper">
          <table :style="tableStyle">
            <colgroup>
              <col v-for="column in columns" :key="column.key" :style="{ width: `${columnWidth(column)}px` }" />
            </colgroup>
            <tfoot>
              <slot name="footer" />
            </tfoot>
          </table>
        </div>
      </div>
    </div>
    <slot name="overlay" />
  </TableCoreFrame>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import TableCoreFrame from "./TableCoreFrame.vue";
import TableCoreHeaderCell from "./TableCoreHeaderCell.vue";

type ClassValue = string | string[] | Record<string, boolean> | Array<string | Record<string, boolean>>;

export interface TableCoreColumn {
  key: string;
  title: string;
  width?: number;
  minWidth?: number;
  align?: "left" | "center" | "right";
  fixed?: "" | "left" | "right";
  filterable?: boolean;
  resizable?: boolean;
  filterActive?: boolean;
  dragging?: boolean;
  dragOver?: boolean;
  dragTestId?: string;
  filterTestId?: string;
  resizeTestId?: string;
  headerClass?: ClassValue;
  cellClass?: ClassValue;
}

type Row = any;

const props = withDefaults(defineProps<{
  kind?: "list" | "entry";
  testId: string;
  frameClass?: string;
  innerClass?: string;
  tableClass?: string;
  headerWrapperClass?: string;
  bodyWrapperClass?: string;
  headerRowClass?: string;
  rowClass?: ClassValue | ((row: Row, rowIndex: number) => ClassValue);
  rowKey?: (row: Row, rowIndex: number) => string | number;
  rowVisible?: (row: Row, rowIndex: number) => boolean;
  rowAttrs?: (row: Row, rowIndex: number) => Record<string, unknown>;
  rowDraggable?: boolean | ((row: Row, rowIndex: number) => boolean);
  cellAttrs?: (row: Row, column: TableCoreColumn, rowIndex: number) => Record<string, unknown>;
  cellTitle?: (row: Row, column: TableCoreColumn, rowIndex: number) => string | undefined;
  columns: TableCoreColumn[];
  rows: Row[];
  minWidth?: number;
  maxResizeWidth?: number;
}>(), {
  kind: "list",
  minWidth: 960,
  maxResizeWidth: 9999
});

const emit = defineEmits<{
  columnDragStart: [column: TableCoreColumn, event: MouseEvent];
  columnFilter: [column: TableCoreColumn, event: MouseEvent];
  columnResize: [payload: { column: TableCoreColumn; width: number }];
  columnResizeEnd: [payload: { column: TableCoreColumn; width: number }];
  rowContextmenu: [row: Row, rowIndex: number, event: MouseEvent];
  rowDragstart: [row: Row, rowIndex: number, event: DragEvent];
  rowDragover: [row: Row, rowIndex: number, event: DragEvent];
  rowDrop: [row: Row, rowIndex: number, event: DragEvent];
  rowDragend: [row: Row, rowIndex: number, event: DragEvent];
}>();

const resizingColumn = ref<TableCoreColumn | null>(null);
const resizeStartX = ref(0);
const resizeStartWidth = ref(0);
const latestResizeWidth = ref(0);

const tableWidth = computed(() => Math.max(
  props.minWidth,
  props.columns.reduce((sum, column) => sum + columnWidth(column), 0)
));
const tableStyle = computed(() => ({ width: `${tableWidth.value}px`, minWidth: `${tableWidth.value}px` }));

onBeforeUnmount(() => {
  window.removeEventListener("mousemove", trackColumnResize);
  window.removeEventListener("mouseup", finishColumnResize);
});

function columnWidth(column: TableCoreColumn) {
  return Math.max(column.minWidth ?? 48, Number(column.width ?? column.minWidth ?? 120));
}

function headerCellClass(column: TableCoreColumn) {
  return [
    column.headerClass,
    `col--align-${column.align || "left"}`,
    { "col--fixed": column.fixed, "col--left": column.fixed === "left", "col--right": column.fixed === "right" }
  ];
}

function bodyCellClass(column: TableCoreColumn) {
  return [
    column.cellClass,
    `col--align-${column.align || "left"}`,
    { "col--fixed": column.fixed, "col--left": column.fixed === "left", "col--right": column.fixed === "right" }
  ];
}

function cellStyle(column: TableCoreColumn) {
  const width = `${columnWidth(column)}px`;
  return { width, minWidth: width, maxWidth: width };
}

function rowKey(row: Row, rowIndex: number) {
  return props.rowKey?.(row, rowIndex) ?? rowIndex;
}

function rowVisible(row: Row, rowIndex: number) {
  return props.rowVisible?.(row, rowIndex) ?? true;
}

function rowAttrs(row: Row, rowIndex: number) {
  return props.rowAttrs?.(row, rowIndex) ?? {};
}

function rowClass(row: Row, rowIndex: number) {
  return typeof props.rowClass === "function" ? props.rowClass(row, rowIndex) : props.rowClass;
}

function rowDraggable(row: Row, rowIndex: number) {
  return typeof props.rowDraggable === "function" ? props.rowDraggable(row, rowIndex) : Boolean(props.rowDraggable);
}

function cellAttrs(row: Row, column: TableCoreColumn, rowIndex: number) {
  return props.cellAttrs?.(row, column, rowIndex) ?? {};
}

function cellTitle(row: Row, column: TableCoreColumn, rowIndex: number) {
  return props.cellTitle?.(row, column, rowIndex);
}

function startColumnResize(column: TableCoreColumn, event: MouseEvent) {
  if (column.resizable === false) {
    return;
  }
  resizingColumn.value = column;
  resizeStartX.value = event.clientX;
  resizeStartWidth.value = columnWidth(column);
  latestResizeWidth.value = resizeStartWidth.value;
  window.addEventListener("mousemove", trackColumnResize);
  window.addEventListener("mouseup", finishColumnResize, { once: true });
}

function trackColumnResize(event: MouseEvent) {
  const column = resizingColumn.value;
  if (!column) {
    return;
  }
  const width = Math.max(
    column.minWidth ?? 64,
    Math.min(props.maxResizeWidth, Math.round(resizeStartWidth.value + event.clientX - resizeStartX.value))
  );
  latestResizeWidth.value = width;
  emit("columnResize", { column, width });
}

function finishColumnResize() {
  const column = resizingColumn.value;
  window.removeEventListener("mousemove", trackColumnResize);
  if (column) {
    emit("columnResizeEnd", { column, width: latestResizeWidth.value });
  }
  resizingColumn.value = null;
}
</script>
