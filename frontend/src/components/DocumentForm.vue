<template>
  <StandardDocument
    :title="title"
    :subtitle="subtitle"
    :status-label="statusLabel"
    :status-class="statusClass"
    :locked="locked"
    :dirty="dirty"
    :message="message"
    :can-save="isDraft"
    :can-audit="canAudit"
    :can-reverse="canReverse"
    :can-red-reverse="canRedReverse"
    :can-void="canVoid"
    :can-delete="canDelete"
    :can-output="isDocumentForm"
    @create="emit('create')"
    @save="emit('save')"
    @audit="emit('audit')"
    @reverse="emit('reverse')"
    @red-reverse="emit('redReverse')"
    @void-document="emit('voidDocument')"
    @delete-document="emit('deleteDocument')"
    @export-document="emit('exportDocument')"
    @print-document="emit('printDocument')"
    @show-existing="emit('showExisting')"
  >
    <div v-if="isDocumentForm" class="form-layout">
      <section class="form-head-fields">
        <div v-if="isStockDocumentForm" class="source-order-field">
          <label>源订单号<input v-model="form.sourceOrderNo" :data-testid="`${testPrefix}-source-order-no`" @input="emit('markDirty')" /></label>
          <button type="button" :disabled="!canTraceSourceOrder" data-testid="trace-source-order" @click="emit('traceSourceOrder')">追踪源单</button>
          <button v-if="form.redReverseBillNo" class="red-reverse-link" type="button" data-testid="open-red-reverse-bill" @click="emit('openRedReverseBill')">红字单 {{ form.redReverseBillNo }}</button>
          <button v-if="form.redSourceBillNo" class="red-reverse-link" type="button" data-testid="open-red-source-bill" @click="emit('openRedSourceBill')">来源原单 {{ form.redSourceBillNo }}</button>
        </div>
        <div v-else-if="form.redReverseBillNo || form.redSourceBillNo" class="source-order-field source-order-field--links">
          <button v-if="form.redReverseBillNo" class="red-reverse-link" type="button" data-testid="open-red-reverse-bill" @click="emit('openRedReverseBill')">红字单 {{ form.redReverseBillNo }}</button>
          <button v-if="form.redSourceBillNo" class="red-reverse-link" type="button" data-testid="open-red-source-bill" @click="emit('openRedSourceBill')">来源原单 {{ form.redSourceBillNo }}</button>
        </div>
        <label>
          {{ partyLabel }}编码
          <span class="master-selector">
            <input
              v-model="form.partyCode"
              :data-testid="`${testPrefix}-party-code`"
              @focus="emit('searchMasterOptions', partyType, form.partyCode, `${testPrefix}-party`)"
              @input="emit('handleMasterInput', partyType, form.partyCode, `${testPrefix}-party`)"
              @keydown="emit('handleSelectorKeydown', $event, `${testPrefix}-party`)"
            />
            <span v-if="activeSelector === `${testPrefix}-party`" class="master-selector__menu">
              <button
                v-for="(option, optionIndex) in selectorOptions"
                :key="option.code"
                type="button"
                :class="{ selected: selectorCursorIndex === optionIndex }"
                @mousedown.prevent="emit('selectPartyOption', option)"
              >
                <strong>{{ option.code }}</strong>
                <span>{{ option.name }}</span>
              </button>
            </span>
          </span>
        </label>
        <label>业务日期<input v-model="form.billDate" :data-testid="`${testPrefix}-bill-date`" @input="emit('markDirty')" /></label>
        <label>单据编号<input v-model="form.billNo" :data-testid="`${testPrefix}-bill-no`" @input="emit('markDirty')" /></label>
        <label>部门<input v-model="form.department" :data-testid="`${testPrefix}-department`" @input="emit('markDirty')" /></label>
      </section>

      <EntryTable
        :lines="form.lines"
        :test-prefix="testPrefix"
        :is-draft="isDraft"
        :batch-warehouse-code="batchWarehouseCode"
        :active-selector="activeSelector"
        :selector-options="selectorOptions"
        :selector-cursor-index="selectorCursorIndex"
        :known-product-options="knownProductOptions"
        :dragging-line-index="draggingLineIndex"
        :highlighted-source-bill-no="highlightedSourceBillNo"
        :highlighted-source-line-no="highlightedSourceLineNo"
        :current-bill-no="form.billNo"
        :show-source-line-column="showSourceLineColumn"
        :show-execution-columns="showExecutionColumns"
        :show-target-warehouse-column="showTargetWarehouseColumn"
        :entry-table-colspan="entryTableColspan"
        :entry-total-colspan="entryTotalColspan"
        :total-amount="totalAmount"
        @update:batch-warehouse-code="emit('update:batchWarehouseCode', $event)"
        @apply-batch-warehouse="emit('applyBatchWarehouse')"
        @mark-dirty="emit('markDirty')"
        @search-master-options="(type, keyword, selectorId) => emit('searchMasterOptions', type, keyword, selectorId)"
        @handle-master-input="(type, keyword, selectorId) => emit('handleMasterInput', type, keyword, selectorId)"
        @handle-selector-keydown="(event, selectorId) => emit('handleSelectorKeydown', event, selectorId)"
        @select-line-product="(option, lineIndex, selectorId) => emit('selectLineProduct', option, lineIndex, selectorId)"
        @select-warehouse-option="(option, lineIndex, selectorId) => emit('selectWarehouseOption', option, lineIndex, selectorId)"
        @select-target-warehouse-option="(option, lineIndex, selectorId) => emit('selectTargetWarehouseOption', option, lineIndex, selectorId)"
        @entry-paste="(event, lineIndex) => emit('entryPaste', event, lineIndex)"
        @trace-source-order="emit('traceSourceOrder', $event)"
        @open-downstream-trace="(line, lineIndex) => emit('openDownstreamTrace', line, lineIndex)"
        @line-drag-start="(event, lineIndex) => emit('lineDragStart', event, lineIndex)"
        @line-drag-over="emit('lineDragOver', $event)"
        @line-drop="emit('lineDrop', $event)"
        @line-drag-end="emit('lineDragEnd')"
        @insert-line-after="emit('insertLineAfter', $event)"
        @remove-line="emit('removeLine', $event)"
        @copy-line="emit('copyLine', $event)"
        @add-line="emit('addLine')"
      />
    </div>
    <div v-else class="empty-shell">该表单正在等待本批次接入，先保留统一工作区和页签行为。</div>
  </StandardDocument>
</template>

<script setup lang="ts">
import EntryTable, { type EntryLine, type MasterOption } from "./EntryTable.vue";
import StandardDocument from "./StandardDocument.vue";

interface DocumentFormState {
  billNo: string;
  sourceOrderNo?: string;
  redReverseBillNo?: string;
  redSourceBillNo?: string;
  partyCode: string;
  billDate: string;
  department: string;
  ownerName: string;
  status: "DRAFT" | "AUDITED" | "REVERSED" | "VOIDED" | "RED_REVERSED";
  lines: EntryLine[];
}

withDefaults(defineProps<{
  title: string;
  subtitle: string;
  statusLabel: string;
  statusClass: string;
  locked: boolean;
  dirty: boolean;
  message: string;
  form: DocumentFormState;
  testPrefix: string;
  partyLabel: string;
  partyType: string;
  isDocumentForm: boolean;
  isStockDocumentForm: boolean;
  isDraft: boolean;
  canAudit: boolean;
  canReverse: boolean;
  canRedReverse?: boolean;
  canVoid: boolean;
  canDelete: boolean;
  canTraceSourceOrder: boolean;
  showSourceLineColumn: boolean;
  showExecutionColumns: boolean;
  showTargetWarehouseColumn?: boolean;
  entryTableColspan: number;
  entryTotalColspan: number;
  totalAmount: string;
  batchWarehouseCode: string;
  activeSelector: string;
  selectorOptions: MasterOption[];
  selectorCursorIndex: number;
  knownProductOptions: MasterOption[];
  draggingLineIndex: number | null;
  highlightedSourceBillNo: string;
  highlightedSourceLineNo: number | null;
}>(), {
  canRedReverse: undefined
});

const emit = defineEmits<{
  create: [];
  save: [];
  audit: [];
  reverse: [];
  redReverse: [];
  voidDocument: [];
  deleteDocument: [];
  exportDocument: [];
  printDocument: [];
  showExisting: [];
  openRedReverseBill: [];
  openRedSourceBill: [];
  "update:batchWarehouseCode": [value: string];
  applyBatchWarehouse: [];
  markDirty: [];
  searchMasterOptions: [type: string, keyword: string, selectorId: string];
  handleMasterInput: [type: string, keyword: string, selectorId: string];
  handleSelectorKeydown: [event: KeyboardEvent, selectorId: string];
  selectPartyOption: [option: MasterOption];
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
</script>
