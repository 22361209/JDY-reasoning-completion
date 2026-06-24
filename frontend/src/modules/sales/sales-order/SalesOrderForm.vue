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
    :can-void="canVoid"
    :can-delete="canDelete"
    :can-output="true"
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
    <div class="form-layout">
      <section class="form-head-fields">
        <div v-if="form.redReverseBillNo || form.redSourceBillNo" class="source-order-field source-order-field--links">
          <button v-if="form.redReverseBillNo" class="red-reverse-link" type="button" data-testid="open-red-reverse-bill" @click="emit('openRedReverseBill')">红字单 {{ form.redReverseBillNo }}</button>
          <button v-if="form.redSourceBillNo" class="red-reverse-link" type="button" data-testid="open-red-source-bill" @click="emit('openRedSourceBill')">来源原单 {{ form.redSourceBillNo }}</button>
        </div>
        <label>
          客户编码
          <span class="master-selector">
            <input
              v-model="form.partyCode"
              data-testid="sales-party-code"
              @focus="emit('searchMasterOptions', 'customer', form.partyCode, 'sales-party')"
              @input="emit('handleMasterInput', 'customer', form.partyCode, 'sales-party')"
              @keydown="emit('handleSelectorKeydown', $event, 'sales-party')"
            />
            <span v-if="activeSelector === 'sales-party'" class="master-selector__menu">
              <button
                v-for="(option, optionIndex) in selectorOptions"
                :key="option.code"
                type="button"
                :class="{ selected: selectorCursorIndex === optionIndex }"
                @mousedown.prevent="emit('selectPartyOption', option, 'sales-party')"
              >
                <strong>{{ option.code }}</strong>
                <span>{{ option.name }}</span>
              </button>
            </span>
          </span>
        </label>
        <label>业务日期<input v-model="form.billDate" data-testid="sales-bill-date" @input="emit('markDirty')" /></label>
        <label>单据编号<input v-model="form.billNo" data-testid="sales-bill-no" @input="emit('markDirty')" /></label>
        <label>部门<input v-model="form.department" data-testid="sales-department" @input="emit('markDirty')" /></label>
      </section>

      <EntryTable
        :lines="form.lines"
        test-prefix="sales"
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
        :show-source-line-column="false"
        :show-execution-columns="showExecutionColumns"
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
  </StandardDocument>
</template>

<script setup lang="ts">
import EntryTable, { type EntryLine, type MasterOption } from "../../../components/EntryTable.vue";
import StandardDocument from "../../../components/StandardDocument.vue";

interface SalesOrderFormState {
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

defineProps<{
  title: string;
  subtitle: string;
  statusLabel: string;
  statusClass: string;
  locked: boolean;
  dirty: boolean;
  message: string;
  form: SalesOrderFormState;
  isDraft: boolean;
  canAudit: boolean;
  canReverse: boolean;
  canVoid: boolean;
  canDelete: boolean;
  showExecutionColumns: boolean;
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
}>();

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
  selectPartyOption: [option: MasterOption, selectorId: string];
  selectLineProduct: [option: MasterOption, lineIndex: number, selectorId: string];
  selectWarehouseOption: [option: MasterOption, lineIndex: number, selectorId: string];
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
