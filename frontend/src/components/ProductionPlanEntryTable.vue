<template>
  <div class="entry-tools production-plan-entry-tools">
    <button
      v-if="isDraft"
      type="button"
      class="primary-action"
      data-testid="production-plan-add-line"
      @click="emit('appendLine')"
    >
      新增型号
    </button>
    <button type="button" data-testid="production-plan-entry-column-settings" @click="columnDialogOpen = true">列设置</button>
  </div>
  <TableCore
    kind="entry"
    test-id="production-plan-entry-table-core"
    frame-class="entry-table production-plan-entry-table"
    table-class="entry-native-table"
    :columns="visiblePlanEntryColumns"
    :rows="lines"
    :min-width="1460"
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
        :filterable="column.key !== 'rowNo' && column.key !== 'actions'"
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
      <div v-else-if="column.key === 'productCode'" class="plan-product-picker">
        <input
          :value="line.productCode"
          readonly
          :disabled="!isDraft"
          :data-testid="`production-plan-product-code-${rowIndex + 1}`"
          placeholder="选择已审核母件"
          @click="isDraft && emit('openProductSelector', rowIndex)"
        />
        <button
          v-if="isDraft"
          type="button"
          :data-testid="`production-plan-select-product-${rowIndex + 1}`"
          @click="emit('openProductSelector', rowIndex)"
        >
          选择
        </button>
      </div>
      <span v-else-if="column.key === 'productName'" class="entry-cell-value">{{ line.productName }}</span>
      <span v-else-if="column.key === 'spec'" class="entry-cell-value">{{ line.spec }}</span>
      <span v-else-if="column.key === 'bomCode'" class="entry-cell-value">{{ line.bomCode }}</span>
      <span v-else-if="column.key === 'bomVersionNo'" class="entry-cell-value">{{ line.bomVersionNo }}</span>
      <span v-else-if="column.key === 'unit'" class="entry-cell-value">{{ line.unit }}</span>
      <input
        v-else-if="column.key === 'warehouseCode'"
        v-model.trim="line.warehouseCode"
        :disabled="!isDraft"
        :data-testid="`production-plan-warehouse-code-${rowIndex + 1}`"
        placeholder="取母件默认仓库"
        @input="emit('markDirty')"
      />
      <input
        v-else-if="column.key === 'departmentCode'"
        v-model.trim="line.departmentCode"
        :disabled="!isDraft"
        :data-testid="`production-plan-department-code-${rowIndex + 1}`"
        placeholder="取默认生产车间"
        @input="emit('markDirty')"
      />
      <input
        v-else-if="column.key === 'qty'"
        v-model.number="line.qty"
        :disabled="!isDraft"
        :data-testid="`production-plan-qty-${rowIndex + 1}`"
        type="number"
        min="0"
        step="1"
        @input="emit('markDirty')"
      />
      <input
        v-else-if="column.key === 'planDeliveryDate'"
        v-model.trim="line.planDeliveryDate"
        :disabled="!isDraft"
        :data-testid="`production-plan-delivery-date-${rowIndex + 1}`"
        placeholder="2026-08-31"
        @input="emit('markDirty')"
      />
      <span v-else-if="column.key === 'inProgressQty'" class="entry-cell-value number-text">{{ line.inProgressQty }}</span>
      <span v-else-if="column.key === 'actions'" class="plan-line-actions">
        <button
          v-if="isDraft"
          type="button"
          :data-testid="`production-plan-insert-line-${rowIndex + 1}`"
          title="在下一行插入型号"
          @click="emit('insertLineAfter', rowIndex)"
        >
          ＋
        </button>
        <button
          v-if="isDraft"
          type="button"
          :disabled="lines.length <= 1"
          :data-testid="`production-plan-remove-line-${rowIndex + 1}`"
          title="删除该型号"
          @click="emit('removeLine', rowIndex)"
        >
          −
        </button>
      </span>
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
  id?: string;
  lineNo?: number;
  productId: string;
  productCode: string;
  productName: string;
  spec: string;
  bomCode: string;
  bomVersionNo: string;
  unit: string;
  warehouseCode: string;
  departmentCode: string;
  qty: number;
  planDeliveryDate: string;
  inProgressQty: string;
  assignedQty: string;
  remainingQty: string;
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
  appendLine: [];
  insertLineAfter: [index: number];
  removeLine: [index: number];
  openProductSelector: [index: number];
}>();

const lines = computed(() => props.lines);
const isDraft = computed(() => props.isDraft);
const columnDialogOpen = ref(false);
const defaultPlanEntryColumns: ProductionPlanEntryColumn[] = [
  { key: "rowNo", title: "序号", width: 48, minWidth: 48, fixed: "left", align: "center", resizable: false, visible: true, configurable: false, headerClass: "entry-row-no-cell entry-frozen-cell", cellClass: "entry-row-no-cell entry-frozen-cell" },
  { key: "productCode", title: "母件物料编码", width: 220, minWidth: 180, visible: true },
  { key: "productName", title: "物料名称", width: 170, minWidth: 96, visible: true },
  { key: "spec", title: "规格型号", width: 150, minWidth: 96, visible: true },
  { key: "bomCode", title: "BOM", width: 136, minWidth: 96, visible: true },
  { key: "bomVersionNo", title: "BOM版本", width: 104, minWidth: 84, visible: true },
  { key: "unit", title: "单位", width: 80, minWidth: 64, visible: true },
  { key: "warehouseCode", title: "完工仓库", width: 140, minWidth: 110, visible: true },
  { key: "departmentCode", title: "生产车间", width: 140, minWidth: 110, visible: true },
  { key: "qty", title: "数量", width: 104, minWidth: 84, align: "right", visible: true, headerClass: "entry-number-cell", cellClass: "entry-number-cell" },
  { key: "planDeliveryDate", title: "预计交期", width: 124, minWidth: 96, visible: true },
  { key: "inProgressQty", title: "在制未完工", width: 120, minWidth: 96, align: "right", visible: true, headerClass: "entry-number-cell", cellClass: "entry-number-cell" },
  { key: "actions", title: "行操作", width: 92, minWidth: 92, fixed: "right", align: "center", resizable: false, visible: true, configurable: false }
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
  if (targetColumn && !["rowNo", "actions"].includes(targetColumn.key)) {
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
    warehouseCode: line.warehouseCode,
    departmentCode: line.departmentCode,
    qty: String(line.qty ?? ""),
    planDeliveryDate: line.planDeliveryDate,
    inProgressQty: line.inProgressQty,
    actions: ""
  };
  return values[key] ?? "";
}
</script>

<style scoped>
.production-plan-entry-tools {
  justify-content: flex-end;
  gap: 8px;
}

.plan-product-picker,
.plan-line-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.plan-product-picker input {
  min-width: 0;
  flex: 1;
}

.plan-product-picker button,
.plan-line-actions button {
  flex: 0 0 auto;
  min-width: 30px;
}
</style>
