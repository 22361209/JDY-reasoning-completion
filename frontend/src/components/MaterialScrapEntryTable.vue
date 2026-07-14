<template>
  <div class="entry-tools material-scrap-entry-tools">
    <span class="material-scrap-entry-tools__hint">数量为 0 的草稿可保存；审核前每行必须大于 0 并填写原因。</span>
    <button type="button" data-testid="material-scrap-entry-column-settings" @click="columnDialogOpen = true">列设置</button>
  </div>

  <TableCore
    kind="entry"
    test-id="material-scrap-entry-table-core"
    frame-class="entry-table material-scrap-entry-table"
    table-class="entry-native-table"
    :columns="coreColumns"
    :rows="lines"
    :min-width="1760"
    :max-resize-width="420"
    :row-visible="rowMatchesFilters"
    :row-attrs="rowAttrs"
    :cell-attrs="cellAttrs"
    :row-draggable="false"
    @column-drag-start="startColumnDrag"
    @column-resize="resizeColumn"
    @column-resize-end="finishColumnResize"
  >
    <template #header-cell="{ column, startResize }">
      <TableCoreHeaderCell
        :title="column.title"
        :column-key="column.key"
        :test-id="`material-scrap-column-drag-${column.key}`"
        :filter-test-id="`material-scrap-column-filter-${column.key}`"
        :bulk-fill-test-id="`material-scrap-column-bulk-${column.key}`"
        :resize-test-id="`material-scrap-column-resize-${column.key}`"
        :filterable="column.key !== 'rowNo'"
        :filter-active="isFilterActive(column.key)"
        :bulk-fillable="Boolean(column.bulkFillable) && editable"
        :bulk-fill-active="bulkFillColumnKey === column.key"
        :resizable="column.resizable !== false"
        :dragging="Boolean(column.dragging)"
        :drag-over="Boolean(column.dragOver)"
        @drag-start="startColumnDrag(column, $event)"
        @filter="openEntryColumnFilter(column, $event)"
        @bulk-fill="openBulkFill(column, $event)"
        @resize-start="startResize(column, $event)"
      />
    </template>

    <template #cell="{ row: line, column, rowIndex }">
      <span v-if="column.key === 'rowNo'" class="entry-row-no">{{ rowIndex + 1 }}</span>
      <span v-else-if="column.key === 'productCode'" class="entry-cell-value">{{ line.productCode }}</span>
      <span v-else-if="column.key === 'productName'" class="entry-cell-value">{{ line.productName }}</span>
      <span v-else-if="column.key === 'spec'" class="entry-cell-value">{{ line.spec }}</span>
      <span v-else-if="column.key === 'unit'" class="entry-cell-value">{{ line.unit }}</span>
      <span v-else-if="column.key === 'sourceWarehouseCode'" class="entry-cell-value">{{ line.sourceWarehouseCode }}</span>
      <span v-else-if="column.key === 'issueQty'" class="entry-cell-value number-text">{{ formatQuantity(line.issueQty) }}</span>
      <span v-else-if="column.key === 'availableScrapQty'" class="entry-cell-value number-text">{{ formatQuantity(line.availableScrapQty) }}</span>
      <input
        v-else-if="column.key === 'scrapQty'"
        v-model.trim="line.scrapQty"
        :disabled="!editable"
        inputmode="decimal"
        min="0"
        :data-testid="`material-scrap-line-qty-${rowIndex + 1}`"
        @input="markDirty"
      />
      <input
        v-else-if="column.key === 'scrapReason'"
        v-model.trim="line.scrapReason"
        :disabled="!editable"
        :data-testid="`material-scrap-line-reason-${rowIndex + 1}`"
        placeholder="审核时必填"
        @input="markDirty"
      />
      <input
        v-else-if="column.key === 'reissueQty'"
        v-model.trim="line.reissueQty"
        :disabled="!editable"
        inputmode="decimal"
        min="0"
        :data-testid="`material-scrap-line-reissue-${rowIndex + 1}`"
        @input="markDirty"
      />
      <label v-else-if="column.key === 'isStockIn'" class="material-scrap-checkbox">
        <input
          v-model="line.isStockIn"
          type="checkbox"
          :disabled="!editable"
          :data-testid="`material-scrap-line-stock-in-${rowIndex + 1}`"
          @change="toggleStockIn(line)"
        />
        <span>{{ line.isStockIn ? "是" : "否" }}</span>
      </label>
      <input
        v-else-if="column.key === 'targetWarehouseCode'"
        v-model.trim="line.targetWarehouseCode"
        :disabled="!editable || !line.isStockIn"
        :data-testid="`material-scrap-line-target-warehouse-${rowIndex + 1}`"
        :placeholder="line.isStockIn ? '目标报废仓' : '无需入库'"
        @input="markDirty"
      />
      <span v-else-if="column.key === 'stockInStatus'" class="entry-cell-value">{{ stockInStatusLabel(line.stockInStatus) }}</span>
    </template>
  </TableCore>

  <ColumnSettingsDialog
    :open="columnDialogOpen"
    title="材料报废分录列设置"
    :columns="configurableColumns"
    dialog-test-id="material-scrap-entry-column-settings-dialog"
    ok-test-id="material-scrap-entry-column-settings-ok"
    @reset="resetColumns"
    @confirm="closeColumnSettings"
  />

  <ColumnFilterPopover
    :open="filterDialogOpen && Boolean(activeFilterColumn)"
    :operators="tableFilterOperators"
    :operator="activeFilterOperator"
    :value="activeFilterValue"
    :left="filterPopoverLeft"
    :top="filterPopoverTop"
    test-id="material-scrap-entry-column-filter-dialog"
    @update:operator="activeFilterOperator = $event"
    @update:value="activeFilterValue = $event"
    @apply="applyColumnFilter"
    @clear="clearColumnFilter"
  />

  <div
    v-if="bulkFillColumnKey"
    class="material-scrap-bulk-fill"
    :style="{ left: `${bulkFillLeft}px`, top: `${bulkFillTop}px` }"
    data-testid="material-scrap-entry-bulk-fill"
    @click.stop
  >
    <strong>批量填充：{{ columnTitle(bulkFillColumnKey) }}</strong>
    <select v-if="bulkFillColumnKey === 'isStockIn'" v-model="bulkFillValue" data-testid="material-scrap-bulk-value">
      <option value="false">否</option>
      <option value="true">是</option>
    </select>
    <input
      v-else
      v-model.trim="bulkFillValue"
      data-testid="material-scrap-bulk-value"
      :inputmode="bulkFillColumnKey === 'scrapQty' || bulkFillColumnKey === 'reissueQty' ? 'decimal' : 'text'"
    />
    <p v-if="bulkFillMessage" class="form-message">{{ bulkFillMessage }}</p>
    <div class="dialog-actions">
      <button type="button" @click="closeBulkFill">取消</button>
      <button class="primary-action" type="button" :disabled="!editable" data-testid="material-scrap-bulk-apply" @click="applyBulkFill">应用到全部分录</button>
    </div>
  </div>

  <div
    v-if="columnReorder.draggingKey.value"
    class="column-drag-ghost"
    :style="{ left: `${columnReorder.dragGhostLeft.value}px`, top: `${columnReorder.dragGhostTop.value}px` }"
    data-testid="material-scrap-entry-column-drag-ghost"
  >
    {{ columnReorder.draggingTitle.value }}
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import type { MaterialScrapLine } from "../services/productionApi";
import ColumnFilterPopover from "./table/ColumnFilterPopover.vue";
import ColumnSettingsDialog from "./table/ColumnSettingsDialog.vue";
import TableCore, { type TableCoreColumn } from "./table/TableCore.vue";
import TableCoreHeaderCell from "./table/TableCoreHeaderCell.vue";
import { tableFilterOperators, useColumnFilters } from "./table/useColumnFilters";
import { canReorderColumn, useColumnReorder } from "./table/useColumnReorder";

interface MaterialScrapColumn extends TableCoreColumn {
  visible: boolean;
  configurable?: boolean;
}

const props = defineProps<{
  lines: MaterialScrapLine[];
  editable: boolean;
}>();

const emit = defineEmits<{
  markDirty: [];
}>();

const preferenceKey = "jdy:material-scrap-entry-columns:v1";
const defaultColumns: MaterialScrapColumn[] = [
  { key: "rowNo", title: "序号", width: 48, minWidth: 48, fixed: "left", align: "center", resizable: false, visible: true, configurable: false, headerClass: "entry-row-no-cell entry-frozen-cell", cellClass: "entry-row-no-cell entry-frozen-cell" },
  { key: "productCode", title: "商品编码", width: 140, minWidth: 104, visible: true },
  { key: "productName", title: "商品名称", width: 180, minWidth: 120, visible: true },
  { key: "spec", title: "规格型号", width: 150, minWidth: 104, visible: true },
  { key: "unit", title: "单位", width: 76, minWidth: 64, align: "center", visible: true },
  { key: "sourceWarehouseCode", title: "来源仓库", width: 118, minWidth: 96, visible: true },
  { key: "issueQty", title: "领料数量", width: 108, minWidth: 88, align: "right", visible: true },
  { key: "availableScrapQty", title: "可报废数量", width: 118, minWidth: 96, align: "right", visible: true },
  { key: "scrapQty", title: "报废数量", width: 112, minWidth: 94, align: "right", bulkFillable: true, visible: true },
  { key: "scrapReason", title: "报废原因", width: 190, minWidth: 130, bulkFillable: true, visible: true },
  { key: "reissueQty", title: "报废重发数量", width: 132, minWidth: 110, align: "right", bulkFillable: true, visible: true },
  { key: "isStockIn", title: "是否入库", width: 102, minWidth: 88, align: "center", bulkFillable: true, visible: true },
  { key: "targetWarehouseCode", title: "目标报废仓", width: 142, minWidth: 110, bulkFillable: true, visible: true },
  { key: "stockInStatus", title: "入库状态", width: 118, minWidth: 96, align: "center", visible: true }
];

const lines = computed(() => props.lines);
const editable = computed(() => props.editable);
const columnDialogOpen = ref(false);
const columns = ref<MaterialScrapColumn[]>(loadColumnPreferences());
const visibleColumns = computed(() => columns.value.filter((column) => column.visible));
const configurableColumns = computed(() => columns.value.filter((column) => column.configurable !== false));
const bulkFillColumnKey = ref("");
const bulkFillValue = ref("");
const bulkFillMessage = ref("");
const bulkFillLeft = ref(0);
const bulkFillTop = ref(0);

const columnReorder = useColumnReorder<MaterialScrapColumn>({
  getColumns: () => columns.value,
  setColumns: (nextColumns) => { columns.value = nextColumns; },
  getKey: (column) => column.key,
  getTitle: (column) => column.title,
  normalize: normalizeColumns,
  canReorder: (column) => column.configurable !== false && canReorderColumn(column),
  onReorder: persistColumnPreferences
});

const {
  activeFilterColumn,
  filterDialogOpen,
  activeFilterOperator,
  activeFilterValue,
  filterPopoverLeft,
  filterPopoverTop,
  openColumnFilter,
  applyColumnFilter,
  clearColumnFilter,
  rowMatchesFilters,
  isFilterActive
} = useColumnFilters<MaterialScrapColumn>(columnValue);

const coreColumns = computed<TableCoreColumn[]>(() => visibleColumns.value.map((column) => ({
  ...column,
  filterable: column.key !== "rowNo",
  filterActive: isFilterActive(column.key),
  bulkFillable: Boolean(column.bulkFillable),
  bulkFillActive: bulkFillColumnKey.value === column.key,
  dragging: columnReorder.draggingKey.value === column.key,
  dragOver: columnReorder.dragOverKey.value === column.key
})));

onBeforeUnmount(() => document.removeEventListener("click", closeBulkFill));

function markDirty() {
  emit("markDirty");
}

function toggleStockIn(line: MaterialScrapLine) {
  if (!line.isStockIn) {
    line.targetWarehouseCode = "";
    line.stockInStatus = "NOT_REQUIRED";
  } else {
    line.stockInStatus = "PENDING";
  }
  markDirty();
}

function rowAttrs(_line: MaterialScrapLine, rowIndex: number) {
  return {
    "data-testid": "material-scrap-entry-row",
    "data-row-index": String(rowIndex + 1)
  };
}

function cellAttrs(_line: MaterialScrapLine, column: TableCoreColumn, rowIndex: number) {
  return { "data-testid": `material-scrap-cell-${column.key}-${rowIndex + 1}` };
}

function startColumnDrag(column: TableCoreColumn, event: MouseEvent) {
  const target = findColumn(column.key);
  if (target) {
    columnReorder.start(target, event);
  }
}

function resizeColumn({ column, width }: { column: TableCoreColumn; width: number }) {
  const target = findColumn(column.key);
  if (target) {
    target.width = Math.max(target.minWidth ?? 64, Math.min(420, width));
  }
}

function finishColumnResize(payload: { column: TableCoreColumn; width: number }) {
  resizeColumn(payload);
  persistColumnPreferences();
}

function openEntryColumnFilter(column: TableCoreColumn, event: MouseEvent) {
  const target = findColumn(column.key);
  if (target && target.key !== "rowNo") {
    openColumnFilter(target, event);
  }
}

function openBulkFill(column: TableCoreColumn, event: MouseEvent) {
  const target = findColumn(column.key);
  if (!editable.value || !target?.bulkFillable) {
    return;
  }
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  bulkFillColumnKey.value = target.key;
  bulkFillValue.value = target.key === "isStockIn" ? "false" : "";
  bulkFillMessage.value = "";
  bulkFillLeft.value = Math.min(rect.left, window.innerWidth - 360);
  bulkFillTop.value = Math.min(rect.bottom + 4, window.innerHeight - 220);
  document.removeEventListener("click", closeBulkFill);
  window.setTimeout(() => document.addEventListener("click", closeBulkFill, { once: true }));
}

function closeBulkFill() {
  bulkFillColumnKey.value = "";
  bulkFillMessage.value = "";
  document.removeEventListener("click", closeBulkFill);
}

function applyBulkFill() {
  if (!editable.value) {
    bulkFillMessage.value = "单据状态或编辑锁已变化，不能批量填充。";
    return;
  }
  const key = bulkFillColumnKey.value;
  if (!key || !props.lines.length) {
    return;
  }
  if (key === "scrapQty" || key === "reissueQty") {
    const value = decimalValue(bulkFillValue.value);
    if (value == null || value < 0) {
      bulkFillMessage.value = "请输入不小于 0 的数量。";
      return;
    }
    if (key === "scrapQty" && props.lines.some((line) => {
      const reissueQty = decimalValue(line.reissueQty);
      return reissueQty == null || reissueQty > value;
    })) {
      bulkFillMessage.value = "已有报废重发数量大于本次报废数量，不能批量覆盖。";
      return;
    }
    if (key === "reissueQty" && props.lines.some((line) => value > (decimalValue(line.scrapQty) ?? 0))) {
      bulkFillMessage.value = "报废重发数量不能超过任一行的报废数量。";
      return;
    }
    props.lines.forEach((line) => { line[key] = bulkFillValue.value; });
  } else if (key === "scrapReason") {
    props.lines.forEach((line) => { line.scrapReason = bulkFillValue.value; });
  } else if (key === "isStockIn") {
    const enabled = bulkFillValue.value === "true";
    props.lines.forEach((line) => {
      line.isStockIn = enabled;
      line.stockInStatus = enabled ? "PENDING" : "NOT_REQUIRED";
      if (!enabled) line.targetWarehouseCode = "";
    });
  } else if (key === "targetWarehouseCode") {
    const warehouse = bulkFillValue.value.trim();
    if (!warehouse) {
      bulkFillMessage.value = "目标报废仓不能为空。";
      return;
    }
    const targets = props.lines.filter((line) => line.isStockIn);
    if (!targets.length) {
      bulkFillMessage.value = "没有勾选“是否入库”的分录。";
      return;
    }
    targets.forEach((line) => { line.targetWarehouseCode = warehouse; });
  }
  markDirty();
  closeBulkFill();
}

function columnValue(row: unknown, rowIndex: number, key: string) {
  const line = row as MaterialScrapLine;
  const values: Record<string, string> = {
    rowNo: String(rowIndex + 1),
    productCode: line.productCode,
    productName: line.productName,
    spec: line.spec,
    unit: line.unit,
    sourceWarehouseCode: line.sourceWarehouseCode,
    issueQty: String(line.issueQty ?? ""),
    availableScrapQty: String(line.availableScrapQty ?? ""),
    scrapQty: String(line.scrapQty ?? ""),
    scrapReason: line.scrapReason,
    reissueQty: String(line.reissueQty ?? ""),
    isStockIn: line.isStockIn ? "是" : "否",
    targetWarehouseCode: line.targetWarehouseCode,
    stockInStatus: stockInStatusLabel(line.stockInStatus)
  };
  return values[key] ?? "";
}

function findColumn(key: string) {
  return columns.value.find((column) => column.key === key);
}

function columnTitle(key: string) {
  return findColumn(key)?.title ?? key;
}

function resetColumns() {
  localStorage.removeItem(preferenceKey);
  columns.value = normalizeColumns(defaultColumns.map((column) => ({ ...column })));
}

function closeColumnSettings() {
  persistColumnPreferences();
  columnDialogOpen.value = false;
}

function normalizeColumns(nextColumns: MaterialScrapColumn[]) {
  return [
    ...nextColumns.filter((column) => column.key === "rowNo").map((column) => ({ ...column, fixed: "left" as const, visible: true, configurable: false })),
    ...nextColumns.filter((column) => column.key !== "rowNo").map((column) => ({ ...column, fixed: "" as const }))
  ];
}

function loadColumnPreferences() {
  const defaults = defaultColumns.map((column) => ({ ...column }));
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey) || "[]") as Array<{ key?: string; width?: number; visible?: boolean }>;
    const defaultsByKey = new Map(defaults.map((column) => [column.key, column]));
    const restored = saved.flatMap((item) => {
      const current = defaultsByKey.get(String(item.key ?? ""));
      return current ? [{
        ...current,
        width: Number.isFinite(item.width) ? Number(item.width) : current.width,
        visible: current.configurable === false ? true : item.visible !== false
      }] : [];
    });
    const restoredKeys = new Set(restored.map((column) => column.key));
    return normalizeColumns([...restored, ...defaults.filter((column) => !restoredKeys.has(column.key))]);
  } catch {
    return normalizeColumns(defaults);
  }
}

function persistColumnPreferences() {
  localStorage.setItem(preferenceKey, JSON.stringify(columns.value.map((column) => ({
    key: column.key,
    width: column.width,
    visible: column.configurable === false ? true : column.visible
  }))));
}

function formatQuantity(value: number | string) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return String(value ?? "");
  return Number.isInteger(parsed) ? String(parsed) : parsed.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function decimalValue(value: number | string) {
  if (String(value ?? "").trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stockInStatusLabel(value: string) {
  return ({
    NOT_REQUIRED: "无需入库",
    PENDING: "待报废入库",
    STOCKED_IN: "已报废入库",
    REVERSED: "已撤销入库"
  } as Record<string, string>)[value] ?? value;
}
</script>

<style scoped>
.material-scrap-entry-tools {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.material-scrap-entry-tools__hint {
  color: #64748b;
  font-size: 12px;
}

.material-scrap-checkbox {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
}

.material-scrap-bulk-fill {
  position: fixed;
  z-index: 80;
  display: grid;
  width: 330px;
  gap: 12px;
  padding: 14px;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 14px 34px rgb(15 23 42 / 18%);
}

.material-scrap-bulk-fill input,
.material-scrap-bulk-fill select {
  width: 100%;
}
</style>
