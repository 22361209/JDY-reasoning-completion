<template>
  <TableCore
    kind="entry"
    test-id="production-plan-entry-table-core"
    frame-class="entry-table production-plan-entry-table"
    table-class="entry-native-table"
    :columns="planEntryColumns"
    :rows="lines"
    :min-width="1120"
    :max-resize-width="420"
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
        :resize-test-id="`production-plan-column-resize-${column.key}`"
        :filterable="false"
        :resizable="column.resizable !== false"
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
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import TableCore, { type TableCoreColumn } from "./table/TableCore.vue";
import TableCoreHeaderCell from "./table/TableCoreHeaderCell.vue";

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

const props = defineProps<{
  lines: ProductionPlanEntryLine[];
  isDraft: boolean;
}>();

const emit = defineEmits<{
  markDirty: [];
}>();

const lines = computed(() => props.lines);
const isDraft = computed(() => props.isDraft);
const planEntryColumns = ref<TableCoreColumn[]>([
  { key: "rowNo", title: "序号", width: 48, minWidth: 48, fixed: "left", align: "center", resizable: false, headerClass: "entry-row-no-cell entry-frozen-cell", cellClass: "entry-row-no-cell entry-frozen-cell" },
  { key: "productCode", title: "母件物料编码", width: 150, minWidth: 96 },
  { key: "productName", title: "物料名称", width: 170, minWidth: 96 },
  { key: "spec", title: "规格型号", width: 150, minWidth: 96 },
  { key: "bomCode", title: "BOM", width: 136, minWidth: 96 },
  { key: "bomVersionNo", title: "BOM版本", width: 104, minWidth: 84 },
  { key: "unit", title: "单位", width: 80, minWidth: 64 },
  { key: "qty", title: "数量", width: 104, minWidth: 84, align: "right", headerClass: "entry-number-cell", cellClass: "entry-number-cell" },
  { key: "planDeliveryDate", title: "预计交期", width: 124, minWidth: 96 },
  { key: "inProgressQty", title: "在制未完工", width: 120, minWidth: 96, align: "right", headerClass: "entry-number-cell", cellClass: "entry-number-cell" }
]);

function resizePlanColumn(payload: { column: TableCoreColumn; width: number }) {
  payload.column.width = payload.width;
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
</script>
