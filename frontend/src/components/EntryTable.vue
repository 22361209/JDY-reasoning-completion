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
    <button type="button" data-testid="entry-column-settings" @click="columnDialogOpen = true">列设置</button>
  </div>
  <div class="entry-table">
    <table>
      <colgroup>
        <col v-for="column in visibleColumns" :key="column.key" :style="{ width: `${column.width}px` }" />
      </colgroup>
      <thead>
        <tr>
          <th v-for="column in visibleColumns" :key="column.key" :class="columnClass(column)">{{ column.title }}</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(line, lineIndex) in lines"
          :key="lineIndex"
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
            <template v-else-if="column.key === 'sourceLineNo'">
              <button
                v-if="line.sourceLineNo"
                class="source-line-link"
                type="button"
                :data-testid="lineSourceTraceTestId(lineIndex)"
                @click="emit('traceSourceOrder', line.sourceLineNo)"
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
            <span v-else-if="column.key === 'remainingQty'">{{ lineRemainingQty(line) }}</span>
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
            <span v-else-if="column.key === 'amount'" :data-testid="lineAmountTestId(lineIndex)">{{ lineAmount(line) }}</span>
            <input v-else-if="column.key === 'remark'" v-model="line.lineRemark" :disabled="!isDraft" :data-testid="lineRemarkTestId(lineIndex)" @input="emit('markDirty')" />
            <div v-else-if="column.key === 'actions'" class="entry-row-actions">
              <button class="line-action line-menu-trigger" type="button" :disabled="!isDraft" :data-testid="lineMenuTestId(lineIndex)" title="行操作" @click="toggleRowMenu(lineIndex, $event)">⋮</button>
              <div v-if="openMenuLineIndex === lineIndex" class="line-action-menu" :style="rowMenuStyle" data-testid="entry-line-action-menu">
                <button class="line-action drag-handle" type="button" :disabled="!isDraft" :data-testid="lineDragHandleTestId(lineIndex)" title="拖拽调整行顺序">↕ 调整顺序</button>
                <button class="line-action" type="button" :disabled="!isDraft" :data-testid="lineInsertTestId(lineIndex)" @click="runLineAction('insert', lineIndex)">插入</button>
                <button class="line-action" type="button" :disabled="!isDraft || lines.length <= 1" :data-testid="lineDeleteTestId(lineIndex)" @click="runLineAction('delete', lineIndex)">删除</button>
                <button class="line-action" type="button" :disabled="!isDraft" :data-testid="lineCopyTestId(lineIndex)" @click="runLineAction('copy', lineIndex)">复制</button>
              </div>
            </div>
          </td>
        </tr>
        <tr class="entry-total-row">
          <td v-for="column in visibleColumns" :key="column.key" :class="columnClass(column)" :data-testid="column.key === 'amount' ? 'document-total-amount' : undefined">
            <template v-if="column.key === firstVisibleColumnKey">合计</template>
            <template v-else-if="column.key === 'qty'">{{ totalQty }}</template>
            <template v-else-if="column.key === 'amount'">{{ totalAmount }}</template>
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

  <div v-if="columnDialogOpen" class="modal-mask" data-testid="entry-column-settings-dialog">
    <div class="dialog column-dialog">
      <h3>分录列设置</h3>
      <div class="column-setting-list">
        <div v-for="(column, index) in configurableColumns" :key="column.key" class="column-setting-row">
          <label><input v-model="column.visible" type="checkbox" /> {{ column.title }}</label>
          <input v-model.number="column.width" class="column-width-input" type="number" min="64" max="360" />
          <button type="button" :disabled="index === 0" @click="moveColumn(column.key, -1)">上移</button>
          <button type="button" :disabled="index === configurableColumns.length - 1" @click="moveColumn(column.key, 1)">下移</button>
        </div>
      </div>
      <div class="dialog-actions">
        <button type="button" @click="resetColumnsToDefault">恢复默认</button>
        <button class="primary-action" type="button" data-testid="entry-column-settings-ok" @click="closeColumnSettings">确定</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

export interface EntryLine {
  lineNo?: number;
  productCode: string;
  productName?: string;
  spec?: string;
  warehouseCode: string;
  targetWarehouseCode?: string;
  sourceLineNo?: number;
  qty: number;
  executedQty?: number;
  remainingQty?: number;
  unitPrice: number;
  lineRemark?: string;
  downstreamDocs?: any[];
}

export interface MasterOption {
  code: string;
  name: string;
  spec?: string;
  unit?: string;
}

type EntryColumnKey = "productCode" | "productName" | "spec" | "warehouse" | "targetWarehouse" | "sourceLineNo" | "qty" | "executedQty" | "remainingQty" | "unitPrice" | "amount" | "remark" | "actions";
interface EntryColumn {
  key: EntryColumnKey;
  title: string;
  width: number;
  visible: boolean;
  configurable?: boolean;
  numeric?: boolean;
}

const props = defineProps<{
  lines: EntryLine[];
  testPrefix: string;
  isDraft: boolean;
  batchWarehouseCode: string;
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
  executionQtyLabel?: string;
  remainingQtyLabel?: string;
  entryTableColspan: number;
  entryTotalColspan: number;
  totalAmount: string;
}>();

const emit = defineEmits<{
  "update:batchWarehouseCode": [value: string];
  applyBatchWarehouse: [];
  markDirty: [];
  searchMasterOptions: [type: string, keyword: string, selectorId: string];
  handleMasterInput: [type: string, keyword: string, selectorId: string];
  handleSelectorKeydown: [event: KeyboardEvent, selectorId: string];
  selectLineProduct: [option: MasterOption, lineIndex: number, selectorId: string];
  selectWarehouseOption: [option: MasterOption, lineIndex: number, selectorId: string];
  selectTargetWarehouseOption: [option: MasterOption, lineIndex: number, selectorId: string];
  entryPaste: [event: ClipboardEvent, lineIndex: number];
  traceSourceOrder: [sourceLineNo?: number];
  openDownstreamTrace: [line: EntryLine, lineIndex: number];
  lineDragStart: [event: DragEvent, lineIndex: number];
  lineDragOver: [event: DragEvent];
  lineDrop: [lineIndex: number];
  lineDragEnd: [];
  insertLineAfter: [lineIndex: number];
  removeLine: [lineIndex: number];
  copyLine: [lineIndex: number];
  addLine: [];
}>();

const columnDialogOpen = ref(false);
const openMenuLineIndex = ref<number | null>(null);
const rowMenuLeft = ref(0);
const rowMenuTop = ref(0);
const columns = ref<EntryColumn[]>([]);
const numericColumns = new Set<EntryColumnKey>(["qty", "executedQty", "remainingQty", "unitPrice", "amount"]);

const defaultColumns = computed<EntryColumn[]>(() => [
  { key: "productCode", title: "商品编码", width: 140, visible: true },
  { key: "productName", title: "商品名称", width: 170, visible: true },
  { key: "spec", title: "规格型号", width: 150, visible: true },
  { key: "warehouse", title: "仓库", width: 130, visible: true },
  { key: "targetWarehouse", title: "目标仓库", width: 130, visible: Boolean(props.showTargetWarehouseColumn) },
  { key: "sourceLineNo", title: "源行号", width: 88, visible: props.showSourceLineColumn },
  { key: "qty", title: "数量", width: 104, visible: true, numeric: true },
  { key: "executedQty", title: props.executionQtyLabel || "已执行", width: 104, visible: props.showExecutionColumns, numeric: true },
  { key: "remainingQty", title: props.remainingQtyLabel || "剩余", width: 104, visible: props.showExecutionColumns, numeric: true },
  { key: "unitPrice", title: "单价", width: 104, visible: true, numeric: true },
  { key: "amount", title: "金额", width: 116, visible: true, numeric: true },
  { key: "remark", title: "备注", width: 210, visible: true },
  { key: "actions", title: "操作", width: 56, visible: true, configurable: false }
]);

const visibleColumns = computed(() => columns.value.filter((column) => isColumnAvailable(column) && column.visible));
const configurableColumns = computed(() => columns.value.filter((column) => column.configurable !== false && isColumnAvailable(column)));
const firstVisibleColumnKey = computed(() => visibleColumns.value[0]?.key ?? "productCode");
const rowMenuStyle = computed(() => ({ left: `${rowMenuLeft.value}px`, top: `${rowMenuTop.value}px` }));
const totalQty = computed(() => formatQty(props.lines.reduce((sum, line) => sum + Number(line.qty || 0), 0)));

watch(() => [
  props.testPrefix,
  props.showSourceLineColumn,
  props.showExecutionColumns,
  props.showTargetWarehouseColumn,
  props.executionQtyLabel,
  props.remainingQtyLabel
], resetColumns, { immediate: true });

onBeforeUnmount(() => {
  document.removeEventListener("click", closeRowMenu);
});

function resetColumns() {
  const defaults = defaultColumns.value;
  const saved = loadColumnPreferences();
  const defaultByKey = new Map(defaults.map((column) => [column.key, column]));
  if (!saved.length) {
    columns.value = defaults.map((column) => ({ ...column }));
    return;
  }
  const restored = saved
    .map((savedColumn) => {
      const current = defaultByKey.get(savedColumn.key);
      if (!current) {
        return null;
      }
      return {
        ...current,
        width: Number.isFinite(savedColumn.width) ? savedColumn.width : current.width,
        visible: savedColumn.visible
      };
    })
    .filter((column): column is EntryColumn => Boolean(column));
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
  if (column.key === "sourceLineNo") {
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
    visible: column.visible
  }))));
}

function columnPreferenceKey() {
  return `jdy:entry-columns:${props.testPrefix}`;
}

function columnClass(column: EntryColumn) {
  return {
    "entry-number-cell": numericColumns.has(column.key),
    "readonly-qty": ["sourceLineNo", "executedQty", "remainingQty"].includes(column.key),
    "amount-cell": column.key === "amount",
    "entry-actions-cell": column.key === "actions",
    "remark-cell": column.key === "remark"
  };
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
  return (Number(line.qty || 0) * Number(line.unitPrice || 0)).toFixed(2);
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

function lineAmountTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-amount` : `${props.testPrefix}-line-amount-${index + 1}`;
}

function lineRemarkTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-remark` : `${props.testPrefix}-line-remark-${index + 1}`;
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
  if (key === "executedQty") {
    return lineExecutedQtyTestId(index);
  }
  if (key === "remainingQty") {
    return lineRemainingQtyTestId(index);
  }
  return undefined;
}

function handleLineCellKeydown(event: KeyboardEvent, lineIndex: number, cell: "product" | "warehouse" | "target-warehouse" | "qty" | "price", selectorId = "") {
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

function advanceLineCellOnEnter(lineIndex: number, cell: "product" | "warehouse" | "target-warehouse" | "qty" | "price") {
  if (cell === "qty") {
    void focusLineCell(lineIndex, "price");
    return;
  }
  if (cell === "price") {
    emit("insertLineAfter", lineIndex);
    return;
  }
  void focusLineCell(Math.min(lineIndex + 1, props.lines.length - 1), cell);
}

async function focusLineCell(lineIndex: number, cell: "product" | "warehouse" | "target-warehouse" | "qty" | "price") {
  await nextTick();
  const input = document.querySelector<HTMLInputElement>(`[data-testid="${lineCellTestId(lineIndex, cell)}"]`);
  input?.focus();
  input?.select();
}

function lineCellTestId(lineIndex: number, cell: "product" | "warehouse" | "target-warehouse" | "qty" | "price") {
  switch (cell) {
    case "target-warehouse":
      return lineTargetWarehouseTestId(lineIndex);
    case "warehouse":
      return lineWarehouseTestId(lineIndex);
    case "qty":
      return lineQtyTestId(lineIndex);
    case "price":
      return linePriceTestId(lineIndex);
    case "product":
    default:
      return lineProductTestId(lineIndex);
  }
}
</script>
