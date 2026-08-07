<template>
  <div class="entry-tools purchase-planning-entry-tools">
    <button
      type="button"
      :data-testid="`${testPrefix}-entry-column-settings`"
      @click="columnDialogOpen = true"
    >列设置</button>
  </div>

  <TableCore
    kind="entry"
    :test-id="`${testPrefix}-entry-table-core`"
    :frame-class="`entry-table purchase-planning-entry-table ${testPrefix}-entry-table`"
    table-class="entry-native-table"
    :columns="visibleColumns"
    :rows="lines"
    :min-width="mode === 'requisition' ? 1900 : 1180"
    :max-resize-width="420"
    :row-key="rowKey"
    :row-visible="rowMatchesFilters"
    :row-attrs="rowAttrs"
    :cell-attrs="cellAttrs"
    :row-draggable="false"
    @column-resize="resizeColumn"
  >
    <template #header-cell="{ column, startResize }">
      <TableCoreHeaderCell
        :title="column.title"
        :column-key="column.key"
        :test-id="`${testPrefix}-column-drag-${column.key}`"
        :filter-test-id="`${testPrefix}-column-filter-${column.key}`"
        :resize-test-id="`${testPrefix}-column-resize-${column.key}`"
        :filterable="column.key !== 'rowNo'"
        :filter-active="isFilterActive(column.key)"
        :resizable="column.resizable !== false"
        @filter="openPlanningColumnFilter(column, $event)"
        @resize-start="startResize(column, $event)"
      />
    </template>

    <template #cell="{ row: line, column, rowIndex }">
      <span v-if="column.key === 'rowNo'" class="purchase-planning-row-no">
        <span>{{ rowIndex + 1 }}</span>
        <button
          v-if="mode === 'requisition' && isDraft"
          type="button"
          class="purchase-planning-remove-line"
          :data-testid="`purchase-requisition-remove-line-${rowIndex + 1}`"
          title="删除本行"
          aria-label="删除本行"
          @click.stop="emit('removeLine', rowIndex)"
        >−</button>
      </span>
      <span v-else-if="column.key === 'sourceRequisitionLineNo'" class="entry-cell-value">
        {{ displayValue(line.sourceRequisitionLineNo) }}
      </span>
      <span v-else-if="column.key === 'sourceLevel'" class="entry-cell-value number-text">
        {{ displayValue(line.sourceLevel) }}
      </span>
      <span v-else-if="column.key === 'sourceBomCode'" class="entry-cell-value">
        {{ displayValue(line.sourceBomCode) }}
      </span>
      <span v-else-if="column.key === 'sourceBomLineNo'" class="entry-cell-value number-text">
        {{ displayValue(line.sourceBomLineNo) }}
      </span>
      <span v-else-if="column.key === 'productCode'" class="entry-cell-value">{{ line.productCode }}</span>
      <span v-else-if="column.key === 'productName'" class="entry-cell-value">{{ line.productName }}</span>
      <span v-else-if="column.key === 'spec'" class="entry-cell-value">{{ line.spec }}</span>
      <span v-else-if="column.key === 'unit'" class="entry-cell-value">{{ line.unit }}</span>
      <input
        v-else-if="column.key === 'qty' && mode === 'requisition'"
        v-model.number="line.qty"
        :disabled="!isDraft"
        :data-testid="`purchase-requisition-qty-${rowIndex + 1}`"
        type="number"
        min="0"
        step="0.0001"
        @input="emit('markDirty')"
      />
      <span
        v-else-if="column.key === 'qty'"
        class="entry-cell-value number-text"
        :data-testid="`purchase-plan-line-qty-${rowIndex + 1}`"
      >{{ displayValue(line.qty) }}</span>
      <span v-else-if="column.key === 'orderedQty'" class="entry-cell-value number-text">
        {{ displayValue(line.orderedQty) }}
      </span>
      <span v-else-if="column.key === 'plannedQty'" class="entry-cell-value number-text">
        {{ displayValue(line.plannedQty) }}
      </span>
      <span v-else-if="column.key === 'remainingQty'" class="entry-cell-value number-text">
        {{ displayValue(line.remainingQty) }}
      </span>
      <span v-else-if="column.key === 'warehouseCode'" class="entry-cell-value">{{ line.warehouseCode }}</span>
      <span v-else-if="column.key === 'planDeliveryDate'" class="entry-cell-value">{{ line.planDeliveryDate }}</span>
      <span v-else-if="column.key === 'supplierCode'" class="master-selector in-cell">
        <input
          v-model.trim="line.supplierCode"
          :disabled="mode !== 'requisition' || !isDraft"
          :data-testid="`purchase-requisition-supplier-code-${rowIndex + 1}`"
          placeholder="输入编码或名称"
          autocomplete="off"
          @focus="emit('searchSupplierOptions', line.supplierCode, rowIndex)"
          @input="emit('handleSupplierInput', line.supplierCode, rowIndex)"
          @keydown="emit('handleSupplierKeydown', $event, rowIndex)"
          @blur="emit('closeSupplierLookupLater')"
        />
        <button
          class="master-selector__open"
          type="button"
          :disabled="mode !== 'requisition' || !isDraft"
          :data-testid="`purchase-requisition-supplier-open-selector-${rowIndex + 1}`"
          title="整列表选择"
          aria-label="整列表选择"
          @mousedown.prevent
          @click="emit('openSupplierSelector', rowIndex)"
        >...</button>
        <span
          v-if="activeSupplierLookupIndex === rowIndex"
          class="master-selector__menu"
          :data-testid="`purchase-requisition-supplier-suggestions-${rowIndex + 1}`"
        >
          <button
            v-for="(option, optionIndex) in supplierOptions"
            :key="option.id || option.code"
            type="button"
            :class="{ selected: supplierLookupCursor === optionIndex }"
            :data-testid="`purchase-requisition-supplier-option-${rowIndex + 1}-${optionIndex + 1}`"
            @mousedown.prevent="emit('selectSupplierOption', option, rowIndex)"
          >
            <strong>{{ option.code }}</strong>
            <span>{{ option.name }}</span>
          </button>
          <em v-if="supplierOptions.length === 0">没有匹配的已审核启用供应商</em>
        </span>
      </span>
      <span
        v-else-if="column.key === 'supplierName'"
        class="entry-cell-value"
        :data-testid="`purchase-requisition-supplier-name-${rowIndex + 1}`"
      >{{ line.supplierName }}</span>
    </template>
  </TableCore>

  <ColumnSettingsDialog
    :open="columnDialogOpen"
    title="列设置"
    :columns="configurableColumns"
    :dialog-test-id="`${testPrefix}-entry-column-settings-dialog`"
    :ok-test-id="`${testPrefix}-entry-column-settings-ok`"
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
    :test-id="`${testPrefix}-entry-column-filter-dialog`"
    @update:operator="activeFilterOperator = $event"
    @update:value="activeFilterValue = $event"
    @apply="applyColumnFilter"
    @clear="clearColumnFilter"
  />
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { MasterOption } from "../../../components/entry-table/types";
import ColumnFilterPopover from "../../../components/table/ColumnFilterPopover.vue";
import ColumnSettingsDialog from "../../../components/table/ColumnSettingsDialog.vue";
import TableCore, { type TableCoreColumn } from "../../../components/table/TableCore.vue";
import TableCoreHeaderCell from "../../../components/table/TableCoreHeaderCell.vue";
import { tableFilterOperators, useColumnFilters } from "../../../components/table/useColumnFilters";

export interface PurchasePlanningEntryLine {
  localId: string;
  id: string;
  lineNo: number | string;
  sourceRequisitionLineNo?: number | string;
  sourceLevel?: number | string;
  sourceBomCode?: string;
  sourceBomLineNo?: number | string;
  productCode: string;
  productName: string;
  spec: string;
  unit: string;
  qty: number;
  orderedQty?: number | string;
  plannedQty?: number | string;
  remainingQty?: number | string;
  warehouseCode: string;
  planDeliveryDate: string;
  supplierCode: string;
  supplierName: string;
}

interface PurchasePlanningColumn extends TableCoreColumn {
  visible: boolean;
  configurable?: boolean;
}

const props = defineProps<{
  mode: "requisition" | "plan";
  lines: PurchasePlanningEntryLine[];
  isDraft: boolean;
  supplierOptions: MasterOption[];
  activeSupplierLookupIndex: number | null;
  supplierLookupCursor: number;
}>();

const emit = defineEmits<{
  markDirty: [];
  removeLine: [index: number];
  openSupplierSelector: [index: number];
  searchSupplierOptions: [keyword: string, index: number];
  handleSupplierInput: [keyword: string, index: number];
  handleSupplierKeydown: [event: KeyboardEvent, index: number];
  closeSupplierLookupLater: [];
  selectSupplierOption: [option: MasterOption, index: number];
}>();

const lines = computed(() => props.lines);
const isDraft = computed(() => props.isDraft);
const mode = computed(() => props.mode);
const testPrefix = computed(() => props.mode === "requisition" ? "purchase-requisition" : "purchase-plan");
const columnDialogOpen = ref(false);
const planningColumns = ref<PurchasePlanningColumn[]>(defaultColumns(props.mode));
const visibleColumns = computed(() => planningColumns.value.filter((column) => column.visible));
const configurableColumns = computed(() => planningColumns.value.filter((column) => column.configurable !== false));
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
} = useColumnFilters<PurchasePlanningColumn>(columnValue);

function defaultColumns(currentMode: "requisition" | "plan"): PurchasePlanningColumn[] {
  const common: PurchasePlanningColumn[] = [
    { key: "rowNo", title: "序号", width: 48, minWidth: 48, fixed: "left", align: "center", resizable: false, visible: true, configurable: false, headerClass: "entry-row-no-cell entry-frozen-cell", cellClass: "entry-row-no-cell entry-frozen-cell" },
    ...(currentMode === "plan"
      ? [{ key: "sourceRequisitionLineNo", title: "来源申请行", width: 112, minWidth: 96, align: "right" as const, visible: true }]
      : [
          { key: "sourceLevel", title: "来源层级", width: 92, minWidth: 82, align: "right" as const, visible: true },
          { key: "sourceBomCode", title: "来源 BOM", width: 140, minWidth: 110, visible: true },
          { key: "sourceBomLineNo", title: "BOM 行号", width: 96, minWidth: 82, align: "right" as const, visible: true }
        ]),
    { key: "productCode", title: "物料编码", width: 150, minWidth: 120, visible: true },
    { key: "productName", title: "物料名称", width: 180, minWidth: 120, visible: true },
    { key: "spec", title: "规格型号", width: 150, minWidth: 96, visible: true },
    { key: "unit", title: "单位", width: 72, minWidth: 60, visible: true },
    { key: "qty", title: currentMode === "requisition" ? "申请数量" : "计划数量", width: 108, minWidth: 88, align: "right", visible: true, headerClass: "entry-number-cell", cellClass: "entry-number-cell" },
    ...(currentMode === "requisition"
      ? [
          { key: "plannedQty", title: "已计划数量", width: 112, minWidth: 96, align: "right" as const, visible: true, headerClass: "entry-number-cell", cellClass: "entry-number-cell" },
          { key: "remainingQty", title: "剩余可计划", width: 118, minWidth: 100, align: "right" as const, visible: true, headerClass: "entry-number-cell", cellClass: "entry-number-cell" },
          { key: "orderedQty", title: "已订购数量", width: 112, minWidth: 96, align: "right" as const, visible: true, headerClass: "entry-number-cell", cellClass: "entry-number-cell" }
        ]
      : []),
    { key: "warehouseCode", title: "仓库编码", width: 128, minWidth: 100, visible: true },
    { key: "planDeliveryDate", title: "计划交期", width: 120, minWidth: 96, visible: true },
    ...(currentMode === "requisition"
      ? [
          { key: "supplierCode", title: "供应商编码", width: 170, minWidth: 140, visible: true },
          { key: "supplierName", title: "供应商名称", width: 200, minWidth: 140, visible: true }
        ]
      : [])
  ];
  return common.map((column) => ({ ...column }));
}

function resizeColumn(payload: { column: TableCoreColumn; width: number }) {
  payload.column.width = payload.width;
}

function resetColumns() {
  planningColumns.value = defaultColumns(props.mode);
}

function openPlanningColumnFilter(column: TableCoreColumn, event: MouseEvent) {
  const targetColumn = planningColumns.value.find((item) => item.key === column.key);
  if (targetColumn && targetColumn.key !== "rowNo") {
    openColumnFilter(targetColumn, event);
  }
}

function rowKey(line: PurchasePlanningEntryLine) {
  return line.localId;
}

function rowAttrs(_line: PurchasePlanningEntryLine, index: number) {
  return {
    "data-testid": `${testPrefix.value}-entry-row`,
    "data-line-no": index + 1
  };
}

function cellAttrs(_line: PurchasePlanningEntryLine, column: TableCoreColumn) {
  return {
    class: {
      "entry-row-no-cell": column.key === "rowNo",
      "entry-frozen-cell": column.key === "rowNo"
    }
  };
}

function columnValue(row: unknown, rowIndex: number, key: string) {
  const line = row as PurchasePlanningEntryLine;
  const values: Record<string, unknown> = {
    rowNo: rowIndex + 1,
    sourceRequisitionLineNo: line.sourceRequisitionLineNo,
    sourceLevel: line.sourceLevel,
    sourceBomCode: line.sourceBomCode,
    sourceBomLineNo: line.sourceBomLineNo,
    productCode: line.productCode,
    productName: line.productName,
    spec: line.spec,
    unit: line.unit,
    qty: line.qty,
    orderedQty: line.orderedQty,
    plannedQty: line.plannedQty,
    remainingQty: line.remainingQty,
    warehouseCode: line.warehouseCode,
    planDeliveryDate: line.planDeliveryDate,
    supplierCode: line.supplierCode,
    supplierName: line.supplierName
  };
  return text(values[key]);
}

function displayValue(value: unknown) {
  return value == null || value === "" ? "-" : String(value);
}

function text(value: unknown) {
  return value == null ? "" : String(value);
}
</script>

<style scoped>
.purchase-planning-entry-tools {
  justify-content: flex-end;
  gap: 8px;
}

.purchase-planning-row-no {
  min-height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
}

.purchase-planning-remove-line {
  width: 15px;
  height: 15px;
  display: inline-grid;
  place-items: center;
  border: 0;
  border-radius: 50%;
  background: #ef5350;
  padding: 0;
  color: #ffffff;
  font-size: 14px;
  line-height: 14px;
}

:deep(.purchase-planning-entry-table .master-selector__menu em) {
  display: block;
  padding: 7px;
  color: #7b8da1;
  font-size: 12px;
  font-style: normal;
}
</style>
