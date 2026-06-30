<template>
  <div class="entry-tools">
    <button type="button" data-testid="production-plan-entry-column-settings" @click="columnDialogOpen = true">列设置</button>
  </div>
  <TableCore
    kind="entry"
    test-id="production-plan-entry-table-core"
    frame-class="entry-table production-plan-entry-table"
    table-class="entry-native-table"
    :columns="visiblePlanEntryColumns"
    :rows="lines"
    :min-width="1120"
    :max-resize-width="420"
    :row-visible="rowMatchesFilters"
    :row-attrs="planRowAttrs"
    :cell-attrs="planCellAttrs"
    :row-draggable="false"
    @column-resize="resizePlanColumn"
  >
    <template #header-cell="{ column, startResize }">
      <TableCoreHeaderCell
        :title="column.title"
        :column-key="column.key"
        :test-id="`production-plan-column-drag-${column.key}`"
        :filter-test-id="`production-plan-column-filter-${column.key}`"
        :resize-test-id="`production-plan-column-resize-${column.key}`"
        :filterable="column.key !== 'rowNo'"
        :filter-active="isFilterActive(column.key)"
        :resizable="column.resizable !== false"
        @filter="openPlanColumnFilter(column, $event)"
        @resize-start="startResize(column, $event)"
      />
    </template>
    <template #cell="{ row: line, column, rowIndex }">
      <span v-if="column.key === 'rowNo'" class="entry-row-no">
        <span class="entry-row-no__value">{{ rowIndex + 1 }}</span>
      </span>
      <input
        v-else-if="column.key === 'productCode'"
        v-model.trim="line.productCode"
        :disabled="!isDraft"
        data-testid="production-plan-product-code"
        placeholder="输入母件编码"
        @input="emit('markDirty')"
      />
      <span v-else-if="column.key === 'productName'" class="entry-cell-value">{{ line.productName }}</span>
      <span v-else-if="column.key === 'spec'" class="entry-cell-value">{{ line.spec }}</span>
      <span v-else-if="column.key === 'bomCode'" class="entry-cell-value">{{ line.bomCode }}</span>
      <span v-else-if="column.key === 'bomVersionNo'" class="entry-cell-value">{{ line.bomVersionNo }}</span>
      <span v-else-if="column.key === 'unit'" class="entry-cell-value">{{ line.unit }}</span>
      <input
        v-else-if="column.key === 'qty'"
        v-model.number="line.qty"
        :disabled="!isDraft"
        data-testid="production-plan-qty"
        type="number"
        min="0"
        step="1"
        @input="emit('markDirty')"
      />
      <input
        v-else-if="column.key === 'planDeliveryDate'"
        v-model.trim="line.planDeliveryDate"
        :disabled="!isDraft"
        data-testid="production-plan-delivery-date"
        placeholder="2026-06-30"
        @input="emit('markDirty')"
      />
      <span v-else-if="column.key === 'inProgressQty'" class="entry-cell-value number-text">{{ line.inProgressQty }}</span>
    </template>
  </TableCore>

  <ColumnSettingsDialog
    :open="columnDialogOpen"
    title="列设置"
    :columns="configurablePlanEntryColumns"
    dialog-test-id="production-plan-entry-column-settings-dialog"
    ok-test-id="production-plan-entry-column-settings-ok"
    @reset="resetPlanColumns"
    @confirm="columnDialogOpen = false"
  />

  <ColumnFilterPopover
    :open="filterDialogOpen && Boolean(activeFilterColumn)"
    :operators="tableFilterOperators"
    :operator="activeFilterOperator"
    :value="activeFilterValue"
    :left="filterPopoverLeft"
    :top="filterPopoverTop"
    test-id="production-plan-entry-column-filter-dialog"
    @update:operator="activeFilterOperator = $event"
    @update:value="activeFilterValue = $event"
    @apply="applyColumnFilter"
    @clear="clearColumnFilter"
  />
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import ColumnFilterPopover from "./table/ColumnFilterPopover.vue";
import ColumnSettingsDialog from "./table/ColumnSettingsDialog.vue";
import TableCore, { type TableCoreColumn } from "./table/TableCore.vue";
import TableCoreHeaderCell from "./table/TableCoreHeaderCell.vue";
import { tableFilterOperators, useColumnFilters } from "./table/useColumnFilters";

export interface ProductionPlanEntryLine {
  localId: string;
  productCode: string;
  productName: string;
  spec: string;
  bomCode: string;
  bomVersionNo: string;
  unit: string;
  qty: number;
  planDeliveryDate: string;
  inProgressQty: string;
}

interface ProductionPlanEntryColumn extends TableCoreColumn {
  visible: boolean;
  configurable?: boolean;
}

const props = defineProps<{
  lines: ProductionPlanEntryLine[];
  isDraft: boolean;
}>();

const emit = defineEmits<{
  markDirty: [];
}>();

const lines = computed(() => props.lines);
const isDraft = computed(() => props.isDraft);
const columnDialogOpen = ref(false);
const defaultPlanEntryColumns: ProductionPlanEntryColumn[] = [
  { key: "rowNo", title: "序号", width: 48, minWidth: 48, fixed: "left", align: "center", resizable: false, visible: true, configurable: false, headerClass: "entry-row-no-cell entry-frozen-cell", cellClass: "entry-row-no-cell entry-frozen-cell" },
  { key: "productCode", title: "母件物料编码", width: 150, minWidth: 96, visible: true },
  { key: "productName", title: "物料名称", width: 170, minWidth: 96, visible: true },
  { key: "spec", title: "规格型号", width: 150, minWidth: 96, visible: true },
  { key: "bomCode", title: "BOM", width: 136, minWidth: 96, visible: true },
  { key: "bomVersionNo", title: "BOM版本", width: 104, minWidth: 84, visible: true },
  { key: "unit", title: "单位", width: 80, minWidth: 64, visible: true },
  { key: "qty", title: "数量", width: 104, minWidth: 84, align: "right", visible: true, headerClass: "entry-number-cell", cellClass: "entry-number-cell" },
  { key: "planDeliveryDate", title: "预计交期", width: 124, minWidth: 96, visible: true },
  { key: "inProgressQty", title: "在制未完工", width: 120, minWidth: 96, align: "right", visible: true, headerClass: "entry-number-cell", cellClass: "entry-number-cell" }
];
const planEntryColumns = ref<ProductionPlanEntryColumn[]>(defaultPlanEntryColumns.map((column) => ({ ...column })));
const visiblePlanEntryColumns = computed(() => planEntryColumns.value.filter((column) => column.visible));
const configurablePlanEntryColumns = computed(() => planEntryColumns.value.filter((column) => column.configurable !== false));
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
} = useColumnFilters<ProductionPlanEntryColumn>(planEntryColumnValue);

function resizePlanColumn(payload: { column: TableCoreColumn; width: number }) {
  payload.column.width = payload.width;
}

function resetPlanColumns() {
  planEntryColumns.value = defaultPlanEntryColumns.map((column) => ({ ...column }));
}

function openPlanColumnFilter(column: TableCoreColumn, event: MouseEvent) {
  const targetColumn = planEntryColumns.value.find((item) => item.key === column.key);
  if (targetColumn && targetColumn.key !== "rowNo") {
    openColumnFilter(targetColumn, event);
  }
}

function planRowAttrs(_line: ProductionPlanEntryLine, index: number) {
  return { "data-testid": `production-plan-entry-row-${index + 1}` };
}

function planCellAttrs(_line: ProductionPlanEntryLine, column: TableCoreColumn) {
  return {
    class: {
      "entry-row-no-cell": column.key === "rowNo",
      "entry-frozen-cell": column.key === "rowNo"
    }
  };
}

function planEntryColumnValue(row: unknown, rowIndex: number, key: string) {
  const line = row as ProductionPlanEntryLine;
  const values: Record<string, string> = {
    rowNo: String(rowIndex + 1),
    productCode: line.productCode,
    productName: line.productName,
    spec: line.spec,
    bomCode: line.bomCode,
    bomVersionNo: line.bomVersionNo,
    unit: line.unit,
    qty: String(line.qty ?? ""),
    planDeliveryDate: line.planDeliveryDate,
    inProgressQty: line.inProgressQty
  };
  return values[key] ?? "";
}
</script>
