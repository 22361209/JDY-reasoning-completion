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
  </div>
  <div class="entry-table">
    <table>
      <thead>
        <tr>
          <th>商品编码</th>
          <th>商品名称</th>
          <th>规格型号</th>
          <th>仓库</th>
          <th v-if="showTargetWarehouseColumn">目标仓库</th>
          <th v-if="showSourceLineColumn">源行号</th>
          <th>数量</th>
          <th v-if="showExecutionColumns">{{ executionQtyLabel || "已执行" }}</th>
          <th v-if="showExecutionColumns">{{ remainingQtyLabel || "剩余" }}</th>
          <th>单价</th>
          <th>金额</th>
          <th>备注</th>
          <th>操作</th>
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
          @dragstart="emit('lineDragStart', $event, lineIndex)"
          @dragover.prevent="emit('lineDragOver', $event)"
          @drop.prevent="emit('lineDrop', lineIndex)"
          @dragend="emit('lineDragEnd')"
        >
          <td>
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
          </td>
          <td v-if="showTargetWarehouseColumn">
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
          </td>
          <td>{{ productInfo(line).name }}</td>
          <td>{{ productInfo(line).spec }}</td>
          <td>
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
          </td>
          <td v-if="showSourceLineColumn" class="readonly-qty" :data-testid="lineSourceLineNoTestId(lineIndex)">
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
          </td>
          <td>
            <input
              v-model.number="line.qty"
              :disabled="!isDraft"
              :data-testid="lineQtyTestId(lineIndex)"
              @input="emit('markDirty')"
              @keydown="handleLineCellKeydown($event, lineIndex, 'qty')"
              @paste="emit('entryPaste', $event, lineIndex)"
            />
          </td>
          <td v-if="showExecutionColumns" class="readonly-qty" :data-testid="lineExecutedQtyTestId(lineIndex)">
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
          </td>
          <td v-if="showExecutionColumns" class="readonly-qty" :data-testid="lineRemainingQtyTestId(lineIndex)">{{ lineRemainingQty(line) }}</td>
          <td>
            <input
              v-model.number="line.unitPrice"
              :disabled="!isDraft"
              :data-testid="linePriceTestId(lineIndex)"
              @input="emit('markDirty')"
              @keydown="handleLineCellKeydown($event, lineIndex, 'price')"
              @paste="emit('entryPaste', $event, lineIndex)"
            />
          </td>
          <td class="amount-cell" :data-testid="lineAmountTestId(lineIndex)">{{ lineAmount(line) }}</td>
          <td class="remark-cell"><input v-model="line.lineRemark" :disabled="!isDraft" :data-testid="lineRemarkTestId(lineIndex)" @input="emit('markDirty')" /></td>
          <td>
            <button class="line-action drag-handle" type="button" :disabled="!isDraft" :data-testid="lineDragHandleTestId(lineIndex)" title="拖拽调整行顺序">↕</button>
            <button class="line-action" type="button" :disabled="!isDraft" :data-testid="lineInsertTestId(lineIndex)" @click="emit('insertLineAfter', lineIndex)">插入</button>
            <button class="line-action" type="button" :disabled="!isDraft || lines.length <= 1" :data-testid="lineDeleteTestId(lineIndex)" @click="emit('removeLine', lineIndex)">删除</button>
            <button class="line-action" type="button" :disabled="!isDraft" :data-testid="lineCopyTestId(lineIndex)" @click="emit('copyLine', lineIndex)">复制</button>
          </td>
        </tr>
        <tr>
          <td :colspan="entryTotalColspan" class="total-cell">合计</td>
          <td class="amount-cell" data-testid="document-total-amount">{{ totalAmount }}</td>
        </tr>
        <tr>
          <td :colspan="entryTableColspan" class="add-line">
            <button type="button" :disabled="!isDraft" data-testid="add-document-line" @click="emit('addLine')">+ 增加明细行</button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup lang="ts">
import { nextTick } from "vue";

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
