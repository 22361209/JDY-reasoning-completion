<template>
  <div class="entry-tools">
    <label>
      批量仓库
      <input
        :value="batchWarehouseCode"
        :disabled="!isDraft"
        data-testid="batch-warehouse-code"
        @input="emit('update:batchWarehouseCode', ($event.target as HTMLInputElement).value)"
        @keydown.enter="emit('applyBatchWarehouse')"
      />
    </label>
    <button type="button" :disabled="!isDraft" data-testid="apply-batch-warehouse" @click="emit('applyBatchWarehouse')">应用</button>
    <template v-if="showPlanDeliveryDateColumn">
      <label>
        批量交期
        <input
          :value="batchPlanDeliveryDate"
          :disabled="!isDraft"
          type="date"
          data-testid="batch-plan-delivery-date"
          @input="emit('update:batchPlanDeliveryDate', ($event.target as HTMLInputElement).value)"
          @keydown.enter="emit('applyBatchPlanDeliveryDate', selectedLineIndexes())"
        />
      </label>
      <button type="button" :disabled="!isDraft" data-testid="apply-batch-plan-delivery-date" @click="emit('applyBatchPlanDeliveryDate', selectedLineIndexes())">应用交期</button>
    </template>
    <button type="button" data-testid="entry-column-settings" @click="columnDialogOpen = true">列设置</button>
  </div>
  <div class="entry-table">
    <table :style="{ width: `${entryTableWidth}px`, minWidth: `${entryTableWidth}px` }">
      <colgroup>
        <col v-for="column in visibleColumns" :key="column.key" :style="{ width: `${column.width}px` }" />
      </colgroup>
      <thead>
        <tr>
          <th v-for="column in visibleColumns" :key="column.key" :class="columnClass(column)">
            <div
              class="column-header-cell entry-column-header"
              :class="{ dragging: draggingColumnKey === column.key, 'drag-over': dragOverColumnKey === column.key }"
              :data-testid="`entry-column-drag-${column.key}`"
              :data-column-field="column.key"
              @mousedown.left="startColumnMouseDrag(column, $event)"
            >
              <span class="column-header-title">{{ column.title }}</span>
              <button
                v-if="column.configurable !== false"
                class="column-filter-button"
                type="button"
                :class="{ active: Boolean(columnFilters[column.key]?.value) || ['为空', '不为空'].includes(columnFilters[column.key]?.operator ?? '') }"
                :title="`${column.title}过滤`"
                :data-testid="`entry-column-filter-${column.key}`"
                @mousedown.stop
                @click.stop="openColumnFilter(column, $event)"
              >
                ⌄
              </button>
              <span
                v-if="column.configurable !== false"
                class="entry-column-resizer"
                :data-testid="`entry-column-resize-${column.key}`"
                @mousedown.stop.prevent="startColumnResize(column, $event)"
              />
            </div>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(line, lineIndex) in lines"
          :key="lineIndex"
          v-show="lineMatchesFilters(line, lineIndex)"
          :class="{ 'is-dragging': draggingLineIndex === lineIndex, 'is-source-target': isHighlightedSourceLine(line, lineIndex) }"
          :draggable="isDraft"
          :data-testid="`${testPrefix}-entry-row`"
          :data-line-no="lineLineNo(line, lineIndex)"
          @contextmenu.prevent="openRowMenu(lineIndex, $event)"
          @dragstart="emit('lineDragStart', $event, lineIndex)"
          @dragover.prevent="emit('lineDragOver', $event)"
          @drop.prevent="emit('lineDrop', lineIndex)"
          @dragend="emit('lineDragEnd')"
        >
          <td v-for="column in visibleColumns" :key="column.key" :class="columnClass(column)" :data-testid="columnCellTestId(column.key, lineIndex)">
            <template v-if="column.key === 'productCode'">
              <span class="master-selector in-cell">
                <input
                  v-model="line.productCode"
                  :disabled="!isDraft"
                  :data-testid="lineProductTestId(lineIndex)"
                  @focus="emit('searchMasterOptions', 'product', line.productCode, selectorIdForLine(lineIndex, 'product'))"
                  @input="emit('handleMasterInput', 'product', line.productCode, selectorIdForLine(lineIndex, 'product'))"
                  @keydown="handleLineCellKeydown($event, lineIndex, 'product', selectorIdForLine(lineIndex, 'product'))"
                  @paste="emit('entryPaste', $event, lineIndex)"
                />
                <button
                  class="master-selector__open"
                  type="button"
                  :disabled="!isDraft"
                  :data-testid="`${lineProductTestId(lineIndex)}-open-selector`"
                  title="整列表选择"
                  aria-label="整列表选择"
                  @mousedown.prevent
                  @click="emit('openMasterSelectorDialog', 'product', selectorIdForLine(lineIndex, 'product'), line.productCode)"
                >...</button>
                <span v-if="activeSelector === selectorIdForLine(lineIndex, 'product')" class="master-selector__menu">
                  <button
                    v-for="(option, optionIndex) in selectorOptions"
                    :key="option.code"
                    type="button"
                    :class="{ selected: selectorCursorIndex === optionIndex }"
                    @mousedown.prevent="emit('selectLineProduct', option, lineIndex, selectorIdForLine(lineIndex, 'product'))"
                  >
                    <strong>{{ option.code }}</strong>
                    <span>{{ option.name }}</span>
                  </button>
                </span>
              </span>
            </template>
            <template v-else-if="column.key === 'selection'">
              <input
                v-model="selectedLines[lineIndex]"
                type="checkbox"
                :disabled="!isDraft"
                :data-testid="lineSelectTestId(lineIndex)"
              />
            </template>
            <span v-else-if="column.key === 'productName'" class="entry-cell-text">{{ productInfo(line).name }}</span>
            <span v-else-if="column.key === 'spec'" class="entry-cell-text">{{ productInfo(line).spec }}</span>
            <template v-else-if="column.key === 'warehouse'">
              <span class="master-selector in-cell">
                <input
                  v-model="line.warehouseCode"
                  :disabled="!isDraft"
                  :data-testid="lineWarehouseTestId(lineIndex)"
                  @focus="emit('searchMasterOptions', 'warehouse', line.warehouseCode, selectorIdForLine(lineIndex, 'warehouse'))"
                  @input="emit('handleMasterInput', 'warehouse', line.warehouseCode, selectorIdForLine(lineIndex, 'warehouse'))"
                  @keydown="handleLineCellKeydown($event, lineIndex, 'warehouse', selectorIdForLine(lineIndex, 'warehouse'))"
                  @paste="emit('entryPaste', $event, lineIndex)"
                />
                <button
                  class="master-selector__open"
                  type="button"
                  :disabled="!isDraft"
                  :data-testid="`${lineWarehouseTestId(lineIndex)}-open-selector`"
                  title="整列表选择"
                  aria-label="整列表选择"
                  @mousedown.prevent
                  @click="emit('openMasterSelectorDialog', 'warehouse', selectorIdForLine(lineIndex, 'warehouse'), line.warehouseCode)"
                >...</button>
                <span v-if="activeSelector === selectorIdForLine(lineIndex, 'warehouse')" class="master-selector__menu">
                  <button
                    v-for="(option, optionIndex) in selectorOptions"
                    :key="option.code"
                    type="button"
                    :class="{ selected: selectorCursorIndex === optionIndex }"
                    @mousedown.prevent="emit('selectWarehouseOption', option, lineIndex, selectorIdForLine(lineIndex, 'warehouse'))"
                  >
                    <strong>{{ option.code }}</strong>
                    <span>{{ option.name }}</span>
                  </button>
                </span>
              </span>
            </template>
            <template v-else-if="column.key === 'targetWarehouse'">
              <span class="master-selector in-cell">
                <input
                  v-model="line.targetWarehouseCode"
                  :disabled="!isDraft"
                  :data-testid="lineTargetWarehouseTestId(lineIndex)"
                  @focus="emit('searchMasterOptions', 'warehouse', line.targetWarehouseCode || '', selectorIdForLine(lineIndex, 'target-warehouse'))"
                  @input="emit('handleMasterInput', 'warehouse', line.targetWarehouseCode || '', selectorIdForLine(lineIndex, 'target-warehouse'))"
                  @keydown="handleLineCellKeydown($event, lineIndex, 'target-warehouse', selectorIdForLine(lineIndex, 'target-warehouse'))"
                  @paste="emit('entryPaste', $event, lineIndex)"
                />
                <button
                  class="master-selector__open"
                  type="button"
                  :disabled="!isDraft"
                  :data-testid="`${lineTargetWarehouseTestId(lineIndex)}-open-selector`"
                  title="整列表选择"
                  aria-label="整列表选择"
                  @mousedown.prevent
                  @click="emit('openMasterSelectorDialog', 'warehouse', selectorIdForLine(lineIndex, 'target-warehouse'), line.targetWarehouseCode || '')"
                >...</button>
                <span v-if="activeSelector === selectorIdForLine(lineIndex, 'target-warehouse')" class="master-selector__menu">
                  <button
                    v-for="(option, optionIndex) in selectorOptions"
                    :key="option.code"
                    type="button"
                    :class="{ selected: selectorCursorIndex === optionIndex }"
                    @mousedown.prevent="emit('selectTargetWarehouseOption', option, lineIndex, selectorIdForLine(lineIndex, 'target-warehouse'))"
                  >
                    <strong>{{ option.code }}</strong>
                    <span>{{ option.name }}</span>
                  </button>
                </span>
              </span>
            </template>
            <template v-else-if="column.key === 'sourceOrderNo'">
              <button
                v-if="line.sourceOrderNo"
                class="source-line-link"
                type="button"
                :data-testid="`${lineSourceOrderNoTestId(lineIndex)}-open`"
                @click="emit('traceSourceOrder', line.sourceLineNo, line.sourceOrderNo)"
              >
                {{ line.sourceOrderNo }}
              </button>
              <span v-else>-</span>
            </template>
            <template v-else-if="column.key === 'sourceLineNo'">
              <button
                v-if="line.sourceOrderNo && line.sourceLineNo"
                class="source-line-link"
                type="button"
                :data-testid="lineSourceTraceTestId(lineIndex)"
                @click="emit('traceSourceOrder', line.sourceLineNo, line.sourceOrderNo)"
              >
                {{ lineSourceLineNo(line) }}
              </button>
              <span v-else>-</span>
            </template>
            <input
              v-else-if="column.key === 'qty'"
              v-model.number="line.qty"
              class="entry-number-input"
              :disabled="!isDraft"
              :data-testid="lineQtyTestId(lineIndex)"
              @input="emit('markDirty')"
              @keydown="handleLineCellKeydown($event, lineIndex, 'qty')"
              @paste="emit('entryPaste', $event, lineIndex)"
            />
            <template v-else-if="column.key === 'executedQty'">
              <button
                v-if="line.downstreamDocs?.length"
                class="source-line-link"
                type="button"
                :data-testid="lineDownstreamTraceTestId(lineIndex)"
                @click="emit('openDownstreamTrace', line, lineIndex)"
              >
                {{ lineExecutedQty(line) }}
              </button>
              <span v-else>{{ lineExecutedQty(line) }}</span>
            </template>
            <span v-else-if="column.key === 'remainingQty'" class="line-lifecycle-state">
              {{ lineRemainingQty(line) }}
              <small v-if="line.lineCloseStatus === 'CLOSED'">已关闭</small>
              <small v-if="line.lineFrozenStatus === 'FROZEN'">已冻结</small>
            </span>
            <input
              v-else-if="column.key === 'unitPrice'"
              v-model.number="line.unitPrice"
              class="entry-number-input"
              :disabled="!isDraft"
              :data-testid="linePriceTestId(lineIndex)"
              @input="emit('markDirty')"
              @keydown="handleLineCellKeydown($event, lineIndex, 'price')"
              @paste="emit('entryPaste', $event, lineIndex)"
            />
            <input
              v-else-if="column.key === 'taxRate'"
              v-model.number="line.taxRate"
              class="entry-number-input"
              :disabled="!isDraft"
              :data-testid="lineTaxRateTestId(lineIndex)"
              @input="emit('markDirty')"
              @keydown="handleLineCellKeydown($event, lineIndex, 'taxRate')"
            />
            <span v-else-if="column.key === 'amount'" :data-testid="lineAmountTestId(lineIndex)">{{ lineAmount(line) }}</span>
            <span v-else-if="column.key === 'taxAmount'" :data-testid="lineTaxAmountTestId(lineIndex)">{{ lineTaxAmount(line) }}</span>
            <span v-else-if="column.key === 'priceTaxTotal'" :data-testid="linePriceTaxTotalTestId(lineIndex)">{{ linePriceTaxTotal(line) }}</span>
            <input
              v-else-if="column.key === 'planDeliveryDate'"
              v-model="line.planDeliveryDate"
              type="date"
              :disabled="!isDraft"
              :data-testid="linePlanDeliveryDateTestId(lineIndex)"
              @input="emit('markDirty')"
            />
            <input v-else-if="column.key === 'remark'" v-model="line.lineRemark" :disabled="!isDraft" :data-testid="lineRemarkTestId(lineIndex)" @input="emit('markDirty')" />
            <div v-else-if="column.key === 'actions'" class="entry-row-actions">
              <button class="line-action line-menu-trigger" type="button" :data-testid="lineMenuTestId(lineIndex)" title="行操作" @click="toggleRowMenu(lineIndex, $event)">⋮</button>
              <div v-if="openMenuLineIndex === lineIndex" class="line-action-menu" :style="rowMenuStyle" data-testid="entry-line-action-menu">
                <button class="line-action drag-handle" type="button" :disabled="!isDraft" :data-testid="lineDragHandleTestId(lineIndex)" title="拖拽调整行顺序">↕ 调整顺序</button>
                <button class="line-action" type="button" :disabled="!isDraft" :data-testid="lineInsertTestId(lineIndex)" @click="runLineAction('insert', lineIndex)">插入</button>
                <button class="line-action" type="button" :disabled="!isDraft || lines.length <= 1" :data-testid="lineDeleteTestId(lineIndex)" @click="runLineAction('delete', lineIndex)">删除</button>
                <button class="line-action" type="button" :disabled="!isDraft" :data-testid="lineCopyTestId(lineIndex)" @click="runLineAction('copy', lineIndex)">复制</button>
                <button class="line-action" type="button" :disabled="isDraft" :data-testid="lineCloseTestId(lineIndex)" @click="emit('lineLifecycle', lineLineNo(line, lineIndex), line.lineCloseStatus === 'CLOSED' ? 'unclose' : 'close')">{{ line.lineCloseStatus === 'CLOSED' ? '反关闭行' : '关闭行' }}</button>
                <button class="line-action" type="button" :disabled="isDraft" :data-testid="lineFreezeTestId(lineIndex)" @click="emit('lineLifecycle', lineLineNo(line, lineIndex), line.lineFrozenStatus === 'FROZEN' ? 'unfreeze' : 'freeze')">{{ line.lineFrozenStatus === 'FROZEN' ? '解冻行' : '冻结行' }}</button>
              </div>
            </div>
          </td>
        </tr>
        <tr class="entry-total-row">
          <td v-for="column in visibleColumns" :key="column.key" :class="columnClass(column)" :data-testid="column.key === totalAmountColumnKey ? 'document-total-amount' : undefined">
            <template v-if="column.key === firstVisibleColumnKey">合计</template>
            <template v-else-if="column.key === 'qty'">{{ totalQty }}</template>
            <template v-else-if="column.key === 'amount'">{{ totalNetAmount }}</template>
            <template v-else-if="column.key === 'taxAmount'">{{ totalTaxAmount }}</template>
            <template v-else-if="column.key === 'priceTaxTotal'">{{ totalAmount }}</template>
          </td>
        </tr>
        <tr>
          <td :colspan="visibleColumns.length" class="add-line">
            <button type="button" :disabled="!isDraft" aria-label="+ 增加明细行" data-testid="add-document-line" @click="emit('addLine')">+ 增加明细</button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <ColumnSettingsDialog
    :open="columnDialogOpen"
    title="列设置"
    :columns="columns"
    dialog-test-id="entry-column-settings-dialog"
    ok-test-id="entry-column-settings-ok"
    @reset="resetColumnsToDefault"
    @confirm="closeColumnSettings"
  />

  <ColumnFilterPopover
    :open="filterDialogOpen && Boolean(activeFilterColumn)"
    :operators="filterOperators"
    :operator="activeFilterOperator"
    :value="activeFilterValue"
    :left="filterPopoverLeft"
    :top="filterPopoverTop"
    test-id="entry-column-filter-dialog"
    @update:operator="activeFilterOperator = $event"
    @update:value="activeFilterValue = $event"
    @apply="applyColumnFilter"
    @clear="clearColumnFilter"
  />

  <div
    v-if="draggingColumnKey"
    class="column-drag-ghost"
    :style="{ left: `${dragGhostLeft}px`, top: `${dragGhostTop}px` }"
    data-testid="entry-column-drag-ghost"
  >
    {{ draggingColumnTitle }}
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from "vue";
import { taxAmounts } from "../app/taxAmounts";
import ColumnFilterPopover from "./table/ColumnFilterPopover.vue";
import ColumnSettingsDialog from "./table/ColumnSettingsDialog.vue";

export interface EntryLine {
  lineNo?: number;
  productCode: string;
  productName?: string;
  spec?: string;
  warehouseCode: string;
  targetWarehouseCode?: string;
  sourceOrderNo?: string;
  sourceLineNo?: number;
  qty: number;
  executedQty?: number;
  remainingQty?: number;
  lineCloseStatus?: string;
  lineFrozenStatus?: string;
  unitPrice: number;
  taxRate?: number;
  taxAmount?: number | string;
  priceTaxTotal?: number | string;
  lineRemark?: string;
  planDeliveryDate?: string;
  downstreamDocs?: any[];
}

export interface MasterOption {
  code: string;
  name: string;
  spec?: string;
  unit?: string;
}

type EntryColumnKey = "selection" | "productCode" | "productName" | "spec" | "warehouse" | "targetWarehouse" | "sourceOrderNo" | "sourceLineNo" | "qty" | "executedQty" | "remainingQty" | "unitPrice" | "taxRate" | "amount" | "taxAmount" | "priceTaxTotal" | "planDeliveryDate" | "remark" | "actions";
interface EntryColumn {
  key: EntryColumnKey;
  title: string;
  width: number;
  visible: boolean;
  fixed?: "" | "left" | "right";
  configurable?: boolean;
  numeric?: boolean;
}

interface ColumnFilter {
  operator: string;
  value: string;
}

const props = defineProps<{
  lines: EntryLine[];
  testPrefix: string;
  isDraft: boolean;
  batchWarehouseCode: string;
  batchPlanDeliveryDate?: string;
  activeSelector: string;
  selectorOptions: MasterOption[];
  selectorCursorIndex: number;
  knownProductOptions: MasterOption[];
  draggingLineIndex: number | null;
  highlightedSourceBillNo: string;
  highlightedSourceLineNo: number | null;
  currentBillNo: string;
  showSourceLineColumn: boolean;
  showExecutionColumns: boolean;
  showTargetWarehouseColumn?: boolean;
  showPlanDeliveryDateColumn?: boolean;
  executionQtyLabel?: string;
  remainingQtyLabel?: string;
  entryTableColspan: number;
  entryTotalColspan: number;
  totalAmount: string;
  isTaxInclusive?: boolean;
  showTaxColumns?: boolean;
}>();

const emit = defineEmits<{
  "update:batchWarehouseCode": [value: string];
  "update:batchPlanDeliveryDate": [value: string];
  applyBatchWarehouse: [];
  applyBatchPlanDeliveryDate: [lineIndexes: number[]];
  markDirty: [];
  searchMasterOptions: [type: string, keyword: string, selectorId: string];
  handleMasterInput: [type: string, keyword: string, selectorId: string];
  handleSelectorKeydown: [event: KeyboardEvent, selectorId: string];
  openMasterSelectorDialog: [type: string, selectorId: string, keyword: string];
  selectLineProduct: [option: MasterOption, lineIndex: number, selectorId: string];
  selectWarehouseOption: [option: MasterOption, lineIndex: number, selectorId: string];
  selectTargetWarehouseOption: [option: MasterOption, lineIndex: number, selectorId: string];
  entryPaste: [event: ClipboardEvent, lineIndex: number];
  traceSourceOrder: [sourceLineNo?: number, sourceOrderNo?: string];
  openDownstreamTrace: [line: EntryLine, lineIndex: number];
  lineDragStart: [event: DragEvent, lineIndex: number];
  lineDragOver: [event: DragEvent];
  lineDrop: [lineIndex: number];
  lineDragEnd: [];
  insertLineAfter: [lineIndex: number];
  removeLine: [lineIndex: number];
  copyLine: [lineIndex: number];
  lineLifecycle: [lineNo: number, action: "close" | "unclose" | "freeze" | "unfreeze"];
  addLine: [];
}>();

const columnDialogOpen = ref(false);
const filterDialogOpen = ref(false);
const openMenuLineIndex = ref<number | null>(null);
const rowMenuLeft = ref(0);
const rowMenuTop = ref(0);
const columns = ref<EntryColumn[]>([]);
const selectedLines = ref<Record<number, boolean>>({});
const columnFilters = reactive<Record<string, ColumnFilter>>({});
const activeFilterColumn = ref<EntryColumn | null>(null);
const activeFilterOperator = ref("包含");
const activeFilterValue = ref("");
const filterPopoverLeft = ref(0);
const filterPopoverTop = ref(0);
const resizingColumnKey = ref<EntryColumnKey | null>(null);
const resizeStartX = ref(0);
const resizeStartWidth = ref(0);
const draggingColumnKey = ref<EntryColumnKey | "">("");
const dragOverColumnKey = ref<EntryColumnKey | "">("");
const dragGhostLeft = ref(0);
const dragGhostTop = ref(0);
const filterOperators = ["包含", "不包含", "等于", "不等于", "以……开始", "以……结束", "为空", "不为空"];
const numericColumns = new Set<EntryColumnKey>(["qty", "executedQty", "remainingQty", "unitPrice", "taxRate", "amount", "taxAmount", "priceTaxTotal"]);

const defaultColumns = computed<EntryColumn[]>(() => [
  { key: "selection", title: "选", width: 48, visible: Boolean(props.showPlanDeliveryDateColumn), configurable: false },
  { key: "productCode", title: "商品编码", width: 140, visible: true },
  { key: "productName", title: "商品名称", width: 170, visible: true },
  { key: "spec", title: "规格型号", width: 150, visible: true },
  { key: "warehouse", title: "仓库", width: 130, visible: true },
  { key: "targetWarehouse", title: "目标仓库", width: 130, visible: Boolean(props.showTargetWarehouseColumn) },
  { key: "sourceOrderNo", title: "源单号", width: 142, visible: props.showSourceLineColumn },
  { key: "sourceLineNo", title: "源单行号", width: 86, visible: props.showSourceLineColumn },
  { key: "qty", title: "数量", width: 104, visible: true, numeric: true },
  { key: "executedQty", title: props.executionQtyLabel || "已执行", width: 104, visible: props.showExecutionColumns, numeric: true },
  { key: "remainingQty", title: props.remainingQtyLabel || "剩余", width: 104, visible: props.showExecutionColumns, numeric: true },
  { key: "unitPrice", title: "单价", width: 104, visible: true, numeric: true },
  { key: "taxRate", title: "税率%", width: 88, visible: Boolean(props.showTaxColumns), numeric: true },
  { key: "amount", title: "金额", width: 116, visible: true, numeric: true },
  { key: "taxAmount", title: "税额", width: 104, visible: Boolean(props.showTaxColumns), numeric: true },
  { key: "priceTaxTotal", title: "价税合计", width: 124, visible: Boolean(props.showTaxColumns), numeric: true },
  { key: "planDeliveryDate", title: "交期", width: 142, visible: Boolean(props.showPlanDeliveryDateColumn) },
  { key: "remark", title: "备注", width: 210, visible: true },
  { key: "actions", title: "操作", width: 56, visible: true, configurable: false }
]);

const visibleColumns = computed(() => columns.value.filter((column) => isColumnAvailable(column) && column.visible));
const configurableColumns = computed(() => columns.value.filter((column) => column.configurable !== false && isColumnAvailable(column)));
const entryTableWidth = computed(() => Math.max(1180, visibleColumns.value.reduce((sum, column) => sum + Math.max(48, Number(column.width) || 96), 0)));
const firstVisibleColumnKey = computed(() => visibleColumns.value[0]?.key ?? "productCode");
const rowMenuStyle = computed(() => ({ left: `${rowMenuLeft.value}px`, top: `${rowMenuTop.value}px` }));
const totalQty = computed(() => formatQty(props.lines.reduce((sum, line) => sum + Number(line.qty || 0), 0)));
const totalNetAmount = computed(() => props.lines.reduce((sum, line) => sum + taxForLine(line).amount, 0).toFixed(2));
const totalTaxAmount = computed(() => props.lines.reduce((sum, line) => sum + taxForLine(line).taxAmount, 0).toFixed(2));
const totalAmountColumnKey = computed<EntryColumnKey>(() => props.showTaxColumns ? "priceTaxTotal" : "amount");
const draggingColumnTitle = computed(() => columns.value.find((column) => column.key === draggingColumnKey.value)?.title ?? "");

watch(() => [
  props.testPrefix,
  props.showSourceLineColumn,
  props.showExecutionColumns,
  props.showTargetWarehouseColumn,
  props.showPlanDeliveryDateColumn,
  props.showTaxColumns,
  props.executionQtyLabel,
  props.remainingQtyLabel
], resetColumns, { immediate: true });

onBeforeUnmount(() => {
  document.removeEventListener("click", closeRowMenu);
  window.removeEventListener("mousemove", trackColumnResize);
  window.removeEventListener("mouseup", finishColumnResize);
  window.removeEventListener("mousemove", trackColumnMouseDrag);
  window.removeEventListener("mouseup", finishColumnMouseDrag);
});

function resetColumns() {
  const defaults = defaultColumns.value;
  const saved = loadColumnPreferences();
  const defaultByKey = new Map(defaults.map((column) => [column.key, column]));
  if (!saved.length) {
    columns.value = defaults.map((column) => ({ ...column }));
    return;
  }
  const restored: EntryColumn[] = [];
  saved.forEach((savedColumn) => {
    const current = defaultByKey.get(savedColumn.key);
    if (!current) {
      return;
    }
    restored.push({
      ...current,
      width: Number.isFinite(savedColumn.width) ? savedColumn.width : current.width,
      visible: savedColumn.visible,
      fixed: savedColumn.fixed ?? ""
    });
  });
  const restoredKeys = new Set(restored.map((column) => column.key));
  columns.value = [
    ...restored,
    ...defaults.filter((column) => !restoredKeys.has(column.key)).map((column) => ({ ...column }))
  ];
}

function isColumnAvailable(column: EntryColumn) {
  if (column.key === "targetWarehouse") {
    return Boolean(props.showTargetWarehouseColumn);
  }
  if (column.key === "selection" || column.key === "planDeliveryDate") {
    return Boolean(props.showPlanDeliveryDateColumn);
  }
  if (column.key === "taxRate" || column.key === "taxAmount" || column.key === "priceTaxTotal") {
    return Boolean(props.showTaxColumns);
  }
  if (column.key === "sourceLineNo") {
    return props.showSourceLineColumn;
  }
  if (column.key === "sourceOrderNo") {
    return props.showSourceLineColumn;
  }
  if (column.key === "executedQty" || column.key === "remainingQty") {
    return props.showExecutionColumns;
  }
  return true;
}

function closeColumnSettings() {
  persistColumnPreferences();
  columnDialogOpen.value = false;
}

function resetColumnsToDefault() {
  localStorage.removeItem(columnPreferenceKey());
  columns.value = defaultColumns.value.map((column) => ({ ...column }));
}

function moveColumn(key: EntryColumnKey, direction: -1 | 1) {
  const index = columns.value.findIndex((column) => column.key === key);
  const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= columns.value.length) {
    return;
  }
  const next = [...columns.value];
  const [column] = next.splice(index, 1);
  next.splice(targetIndex, 0, column);
  columns.value = next;
}

function loadColumnPreferences(): EntryColumn[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(columnPreferenceKey()) || "[]") as EntryColumn[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistColumnPreferences() {
  localStorage.setItem(columnPreferenceKey(), JSON.stringify(columns.value.map((column) => ({
    key: column.key,
    width: Math.max(64, Number(column.width) || 64),
    visible: column.visible,
    fixed: column.fixed ?? ""
  }))));
}

function columnPreferenceKey() {
  return `jdy:entry-columns:${props.testPrefix}`;
}

function columnClass(column: EntryColumn) {
  return {
    "entry-number-cell": numericColumns.has(column.key),
    "readonly-qty": ["sourceLineNo", "executedQty", "remainingQty"].includes(column.key),
    "amount-cell": column.key === "amount" || column.key === "taxAmount" || column.key === "priceTaxTotal",
    "tax-cell": column.key === "taxRate" || column.key === "taxAmount" || column.key === "priceTaxTotal",
    "entry-actions-cell": column.key === "actions",
    "remark-cell": column.key === "remark",
    "entry-selection-cell": column.key === "selection"
  };
}

function selectedLineIndexes() {
  return props.lines
    .map((_, index) => index)
    .filter((index) => selectedLines.value[index]);
}

function openColumnFilter(column: EntryColumn, event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  activeFilterColumn.value = column;
  activeFilterOperator.value = columnFilters[column.key]?.operator ?? "包含";
  activeFilterValue.value = columnFilters[column.key]?.value ?? "";
  filterPopoverLeft.value = Math.min(rect.right - 136, window.innerWidth - 150);
  filterPopoverTop.value = Math.min(rect.bottom + 4, window.innerHeight - 260);
  filterDialogOpen.value = true;
}

function applyColumnFilter() {
  const column = activeFilterColumn.value;
  if (!column) {
    return;
  }
  const value = activeFilterValue.value.trim();
  if (value || ["为空", "不为空"].includes(activeFilterOperator.value)) {
    columnFilters[column.key] = { operator: activeFilterOperator.value, value };
  } else {
    delete columnFilters[column.key];
  }
  filterDialogOpen.value = false;
}

function clearColumnFilter() {
  if (activeFilterColumn.value) {
    delete columnFilters[activeFilterColumn.value.key];
  }
  activeFilterValue.value = "";
  filterDialogOpen.value = false;
}

function lineMatchesFilters(line: EntryLine, index: number) {
  return Object.entries(columnFilters).every(([key, filter]) => matchesColumnFilter(entryColumnValue(line, index, key as EntryColumnKey), filter));
}

function matchesColumnFilter(rawValue: string, filter: ColumnFilter) {
  const source = rawValue.trim().toLowerCase();
  const value = filter.value.trim().toLowerCase();
  switch (filter.operator) {
    case "不包含":
      return !source.includes(value);
    case "等于":
      return source === value;
    case "不等于":
      return source !== value;
    case "以……开始":
      return source.startsWith(value);
    case "以……结束":
      return source.endsWith(value);
    case "为空":
      return !source;
    case "不为空":
      return Boolean(source);
    case "包含":
    default:
      return source.includes(value);
  }
}

function entryColumnValue(line: EntryLine, index: number, key: EntryColumnKey) {
  switch (key) {
    case "selection":
      return selectedLines.value[index] ? "已选" : "";
    case "productCode":
      return line.productCode;
    case "productName":
      return productInfo(line).name;
    case "spec":
      return productInfo(line).spec;
    case "warehouse":
      return line.warehouseCode;
    case "targetWarehouse":
      return line.targetWarehouseCode ?? "";
    case "sourceOrderNo":
      return line.sourceOrderNo ?? "";
    case "sourceLineNo":
      return lineSourceLineNo(line);
    case "qty":
      return formatQty(line.qty);
    case "executedQty":
      return lineExecutedQty(line);
    case "remainingQty":
      return lineRemainingQty(line);
    case "unitPrice":
      return formatQty(line.unitPrice);
    case "taxRate":
      return formatQty(line.taxRate ?? 0);
    case "amount":
      return lineAmount(line);
    case "taxAmount":
      return lineTaxAmount(line);
    case "priceTaxTotal":
      return linePriceTaxTotal(line);
    case "planDeliveryDate":
      return line.planDeliveryDate ?? "";
    case "remark":
      return line.lineRemark ?? "";
    case "actions":
    default:
      return "";
  }
}

function startColumnResize(column: EntryColumn, event: MouseEvent) {
  resizingColumnKey.value = column.key;
  resizeStartX.value = event.clientX;
  resizeStartWidth.value = Number(column.width) || 96;
  window.addEventListener("mousemove", trackColumnResize);
  window.addEventListener("mouseup", finishColumnResize, { once: true });
}

function startColumnMouseDrag(column: EntryColumn, event: MouseEvent) {
  const target = event.target as HTMLElement;
  if (target.closest("button") || target.closest(".entry-column-resizer")) {
    return;
  }
  if (column.configurable === false) {
    return;
  }
  event.preventDefault();
  draggingColumnKey.value = column.key;
  dragOverColumnKey.value = column.key;
  dragGhostLeft.value = event.clientX + 10;
  dragGhostTop.value = event.clientY + 10;
  window.addEventListener("mousemove", trackColumnMouseDrag);
  window.addEventListener("mouseup", finishColumnMouseDrag, { once: true });
}

function trackColumnMouseDrag(event: MouseEvent) {
  if (!draggingColumnKey.value) {
    return;
  }
  dragGhostLeft.value = event.clientX + 10;
  dragGhostTop.value = event.clientY + 10;
  const element = document.elementFromPoint(event.clientX, event.clientY);
  const header = element?.closest<HTMLElement>(".entry-column-header");
  const key = header?.dataset.columnField as EntryColumnKey | undefined;
  if (key && columns.value.some((column) => column.key === key && column.configurable !== false)) {
    dragOverColumnKey.value = key;
  }
}

function finishColumnMouseDrag() {
  const sourceKey = draggingColumnKey.value;
  const targetKey = dragOverColumnKey.value;
  if (!sourceKey || !targetKey || sourceKey === targetKey) {
    finishColumnDrag();
    return;
  }
  const sourceIndex = columns.value.findIndex((column) => column.key === sourceKey);
  const targetIndex = columns.value.findIndex((column) => column.key === targetKey);
  if (sourceIndex < 0 || targetIndex < 0) {
    finishColumnDrag();
    return;
  }
  const next = [...columns.value];
  const [sourceColumn] = next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, sourceColumn);
  columns.value = next;
  persistColumnPreferences();
  finishColumnDrag();
}

function finishColumnDrag() {
  window.removeEventListener("mousemove", trackColumnMouseDrag);
  draggingColumnKey.value = "";
  dragOverColumnKey.value = "";
}

function trackColumnResize(event: MouseEvent) {
  if (!resizingColumnKey.value) {
    return;
  }
  const target = columns.value.find((column) => column.key === resizingColumnKey.value);
  if (!target) {
    return;
  }
  target.width = Math.max(64, Math.min(420, resizeStartWidth.value + event.clientX - resizeStartX.value));
}

function finishColumnResize() {
  if (resizingColumnKey.value) {
    persistColumnPreferences();
  }
  resizingColumnKey.value = null;
  window.removeEventListener("mousemove", trackColumnResize);
}

function openRowMenu(lineIndex: number, event: MouseEvent) {
  if (!props.isDraft) {
    return;
  }
  openMenuLineIndex.value = lineIndex;
  rowMenuLeft.value = Math.min(event.clientX, window.innerWidth - 150);
  rowMenuTop.value = Math.min(event.clientY, window.innerHeight - 160);
  document.addEventListener("click", closeRowMenu, { once: true });
}

function toggleRowMenu(lineIndex: number, event: MouseEvent) {
  event.stopPropagation();
  if (openMenuLineIndex.value === lineIndex) {
    closeRowMenu();
    return;
  }
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  openRowMenu(lineIndex, new MouseEvent("contextmenu", { clientX: rect.left, clientY: rect.bottom + 4 }));
}

function closeRowMenu() {
  openMenuLineIndex.value = null;
  document.removeEventListener("click", closeRowMenu);
}

function runLineAction(action: "insert" | "delete" | "copy", lineIndex: number) {
  closeRowMenu();
  if (action === "insert") {
    emit("insertLineAfter", lineIndex);
  } else if (action === "delete") {
    emit("removeLine", lineIndex);
  } else {
    emit("copyLine", lineIndex);
  }
}

function selectorIdForLine(lineIndex: number, field: "product" | "warehouse" | "target-warehouse") {
  return `${props.testPrefix}-line-${lineIndex}-${field}`;
}

function lineAmount(line: EntryLine) {
  return taxForLine(line).amount.toFixed(2);
}

function lineTaxAmount(line: EntryLine) {
  return taxForLine(line).taxAmount.toFixed(2);
}

function linePriceTaxTotal(line: EntryLine) {
  return taxForLine(line).priceTaxTotal.toFixed(2);
}

function taxForLine(line: EntryLine) {
  return taxAmounts(line.qty, line.unitPrice, line.taxRate, Boolean(props.isTaxInclusive));
}

function lineExecutedQty(line: EntryLine) {
  return formatQty(line.executedQty ?? 0);
}

function lineRemainingQty(line: EntryLine) {
  return formatQty(line.remainingQty ?? Math.max(0, Number(line.qty || 0) - Number(line.executedQty || 0)));
}

function lineSourceLineNo(line: EntryLine) {
  return line.sourceLineNo ? `#${line.sourceLineNo}` : "-";
}

function lineLineNo(line: EntryLine, index: number) {
  return line.lineNo ?? index + 1;
}

function isHighlightedSourceLine(line: EntryLine, index: number) {
  return Boolean(
    props.highlightedSourceLineNo
    && props.currentBillNo === props.highlightedSourceBillNo
    && lineLineNo(line, index) === props.highlightedSourceLineNo
  );
}

function formatQty(value: number | string | undefined) {
  const qty = Number(value ?? 0);
  if (!Number.isFinite(qty)) {
    return "0";
  }
  return Number.isInteger(qty) ? String(qty) : qty.toFixed(2);
}

function productInfo(line: EntryLine) {
  if (line.productName || line.spec) {
    return { name: line.productName ?? "", spec: line.spec ?? "", unit: "" };
  }
  const product = props.selectorOptions.find((option) => option.code === line.productCode)
    ?? props.knownProductOptions.find((option) => option.code === line.productCode);
  return product ? { name: product.name, spec: product.spec ?? "", unit: product.unit ?? "" } : { name: "", spec: "", unit: "" };
}

function lineProductTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-product` : `${props.testPrefix}-line-product-${index + 1}`;
}

function lineWarehouseTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-warehouse` : `${props.testPrefix}-line-warehouse-${index + 1}`;
}

function lineTargetWarehouseTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-target-warehouse` : `${props.testPrefix}-line-target-warehouse-${index + 1}`;
}

function lineQtyTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-qty` : `${props.testPrefix}-line-qty-${index + 1}`;
}

function lineSourceLineNoTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-source-line-no` : `${props.testPrefix}-line-source-line-no-${index + 1}`;
}

function lineSourceOrderNoTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-source-order-no` : `${props.testPrefix}-line-source-order-no-${index + 1}`;
}

function lineSourceTraceTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-source-trace` : `${props.testPrefix}-line-source-trace-${index + 1}`;
}

function lineDownstreamTraceTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-downstream-trace` : `${props.testPrefix}-line-downstream-trace-${index + 1}`;
}

function lineExecutedQtyTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-executed-qty` : `${props.testPrefix}-line-executed-qty-${index + 1}`;
}

function lineRemainingQtyTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-remaining-qty` : `${props.testPrefix}-line-remaining-qty-${index + 1}`;
}

function linePriceTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-price` : `${props.testPrefix}-line-price-${index + 1}`;
}

function lineTaxRateTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-tax-rate` : `${props.testPrefix}-line-tax-rate-${index + 1}`;
}

function lineAmountTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-amount` : `${props.testPrefix}-line-amount-${index + 1}`;
}

function lineTaxAmountTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-tax-amount` : `${props.testPrefix}-line-tax-amount-${index + 1}`;
}

function linePriceTaxTotalTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-price-tax-total` : `${props.testPrefix}-line-price-tax-total-${index + 1}`;
}

function lineRemarkTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-remark` : `${props.testPrefix}-line-remark-${index + 1}`;
}

function linePlanDeliveryDateTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-plan-delivery-date` : `${props.testPrefix}-line-plan-delivery-date-${index + 1}`;
}

function lineSelectTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-select` : `${props.testPrefix}-line-select-${index + 1}`;
}

function lineDeleteTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-delete` : `${props.testPrefix}-line-delete-${index + 1}`;
}

function lineInsertTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-insert` : `${props.testPrefix}-line-insert-${index + 1}`;
}

function lineCopyTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-copy` : `${props.testPrefix}-line-copy-${index + 1}`;
}

function lineCloseTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-close` : `${props.testPrefix}-line-close-${index + 1}`;
}

function lineFreezeTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-freeze` : `${props.testPrefix}-line-freeze-${index + 1}`;
}

function lineDragHandleTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-drag` : `${props.testPrefix}-line-drag-${index + 1}`;
}

function lineMenuTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-menu` : `${props.testPrefix}-line-menu-${index + 1}`;
}

function columnCellTestId(key: EntryColumnKey, index: number) {
  if (key === "sourceLineNo") {
    return lineSourceLineNoTestId(index);
  }
  if (key === "sourceOrderNo") {
    return lineSourceOrderNoTestId(index);
  }
  if (key === "executedQty") {
    return lineExecutedQtyTestId(index);
  }
  if (key === "remainingQty") {
    return lineRemainingQtyTestId(index);
  }
  return undefined;
}

type EditableLineCell = "product" | "warehouse" | "target-warehouse" | "qty" | "price" | "taxRate";

function handleLineCellKeydown(event: KeyboardEvent, lineIndex: number, cell: EditableLineCell, selectorId = "") {
  const selectorWasOpen = Boolean(selectorId && props.activeSelector === selectorId && props.selectorOptions.length > 0);
  if (selectorId) {
    emit("handleSelectorKeydown", event, selectorId);
  }
  if (!props.isDraft || selectorWasOpen || event.defaultPrevented) {
    return;
  }
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    emit("insertLineAfter", lineIndex);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    advanceLineCellOnEnter(lineIndex, cell);
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    void focusLineCell(Math.min(lineIndex + 1, props.lines.length - 1), cell);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    void focusLineCell(Math.max(lineIndex - 1, 0), cell);
  }
}

function advanceLineCellOnEnter(lineIndex: number, cell: EditableLineCell) {
  if (cell === "qty") {
    void focusLineCell(lineIndex, "price");
    return;
  }
  if (cell === "price" && props.showTaxColumns) {
    void focusLineCell(lineIndex, "taxRate");
    return;
  }
  if (cell === "price" || cell === "taxRate") {
    emit("insertLineAfter", lineIndex);
    return;
  }
  void focusLineCell(Math.min(lineIndex + 1, props.lines.length - 1), cell);
}

async function focusLineCell(lineIndex: number, cell: EditableLineCell) {
  await nextTick();
  const input = document.querySelector<HTMLInputElement>(`[data-testid="${lineCellTestId(lineIndex, cell)}"]`);
  input?.focus();
  input?.select();
}

function lineCellTestId(lineIndex: number, cell: EditableLineCell) {
  switch (cell) {
    case "target-warehouse":
      return lineTargetWarehouseTestId(lineIndex);
    case "warehouse":
      return lineWarehouseTestId(lineIndex);
    case "qty":
      return lineQtyTestId(lineIndex);
    case "price":
      return linePriceTestId(lineIndex);
    case "taxRate":
      return lineTaxRateTestId(lineIndex);
    case "product":
    default:
      return lineProductTestId(lineIndex);
  }
}
</script>
