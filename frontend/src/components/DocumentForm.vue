<template>
  <StandardDocument
    :title="title"
    :subtitle="subtitle"
    :status-label="statusLabel"
    :status-class="statusClass"
    :locked="locked"
    :lock-message="lockMessage"
    :can-override-lock="canOverrideLock"
    :dirty="dirty"
    :message="message"
    :can-save="isDraft"
    :can-audit="canAudit"
    :can-reverse="canReverse"
    :can-red-reverse="canRedReverse"
    :can-void="canVoid"
    :can-close="canClose"
    :can-unclose="canUnclose"
    :can-freeze="canFreeze"
    :can-unfreeze="canUnfreeze"
    :can-delete="canDelete"
    :can-output="isDocumentForm"
    :show-push-down="showPushDown"
    :can-push-down="canPushDown"
    :push-down-label="pushDownLabel"
    :push-down-test-id="pushDownTestId"
    @create="emit('create')"
    @save="emit('save')"
    @audit="emit('audit')"
    @reverse="emit('reverse')"
    @red-reverse="emit('redReverse')"
    @void-document="emit('voidDocument')"
    @close-document="emit('closeDocument')"
    @unclose-document="emit('uncloseDocument')"
    @freeze-document="emit('freezeDocument')"
    @unfreeze-document="emit('unfreezeDocument')"
    @push-down="emit('pushDown')"
    @delete-document="emit('deleteDocument')"
    @export-document="emit('exportDocument')"
    @print-document="emit('printDocument')"
    @show-existing="emit('showExisting')"
    @override-lock="emit('overrideLock')"
  >
    <div v-if="isDocumentForm" class="form-layout">
      <section class="form-head-fields">
        <div v-if="isStockDocumentForm" class="source-order-field">
          <button type="button" :disabled="!canTraceSourceOrder" data-testid="trace-source-order" @click="emit('traceSourceOrder')">行级源单追溯</button>
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
              :disabled="locked"
              :data-testid="`${testPrefix}-party-code`"
              @focus="emit('searchMasterOptions', partyType, form.partyCode, `${testPrefix}-party`)"
              @input="emit('handleMasterInput', partyType, form.partyCode, `${testPrefix}-party`)"
              @keydown="emit('handleSelectorKeydown', $event, `${testPrefix}-party`)"
            />
            <button
              class="master-selector__open"
              type="button"
              :data-testid="`${testPrefix}-party-open-selector`"
              :disabled="locked"
              title="整列表选择"
              aria-label="整列表选择"
              @mousedown.prevent
              @click="emit('openMasterSelectorDialog', partyType, `${testPrefix}-party`, form.partyCode)"
            >...</button>
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
        <label>
          {{ partyLabel }}名称
          <input :value="form.partyName || ''" :data-testid="`${testPrefix}-party-name`" readonly />
        </label>
        <label>业务日期<input v-model="form.billDate" :disabled="locked" :data-testid="`${testPrefix}-bill-date`" @input="emit('markDirty')" /></label>
        <label>单据编号<input v-model="form.billNo" :disabled="locked" :data-testid="`${testPrefix}-bill-no`" @input="emit('markDirty')" /></label>
        <label>部门<input v-model="form.department" :disabled="locked" :data-testid="`${testPrefix}-department`" @input="emit('markDirty')" /></label>
        <label>录入人<input :value="form.ownerName" :data-testid="`${testPrefix}-owner-name`" readonly /></label>
        <label v-if="showTaxMode" class="tax-mode-field">
          价格口径
          <select :value="isTaxInclusive ? 'tax' : 'net'" :disabled="locked" :data-testid="`${testPrefix}-tax-mode`" @change="emit('update:isTaxInclusive', ($event.target as HTMLSelectElement).value === 'tax')">
            <option value="net">不含税</option>
            <option value="tax">含税</option>
          </select>
        </label>
        <label class="form-head-field-wide">单据备注<textarea v-model="form.remark" :disabled="locked" :data-testid="`${testPrefix}-remark`" @input="emit('markDirty')" /></label>
      </section>

      <EntryTable
        :lines="form.lines"
        :test-prefix="testPrefix"
        :is-draft="isDraft && !locked"
        :batch-warehouse-code="batchWarehouseCode"
        :batch-plan-delivery-date="batchPlanDeliveryDate"
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
        :show-plan-delivery-date-column="showPlanDeliveryDateColumn"
        :show-stock-columns="showStockColumns"
        :enable-sales-price-bulk="enableSalesPriceBulk"
        :sales-price-customer-code="form.partyCode"
        :execution-qty-label="executionQtyLabel"
        :remaining-qty-label="remainingQtyLabel"
        :entry-table-colspan="entryTableColspan"
        :entry-total-colspan="entryTotalColspan"
        :total-amount="totalAmount"
        :is-tax-inclusive="isTaxInclusive"
        :show-tax-columns="showTaxMode"
        @update:batch-warehouse-code="emit('update:batchWarehouseCode', $event)"
        @update:batch-plan-delivery-date="emit('update:batchPlanDeliveryDate', $event)"
        @apply-batch-warehouse="emit('applyBatchWarehouse')"
        @apply-batch-plan-delivery-date="emit('applyBatchPlanDeliveryDate', $event)"
        @mark-dirty="emit('markDirty')"
        @search-master-options="(type, keyword, selectorId) => emit('searchMasterOptions', type, keyword, selectorId)"
        @handle-master-input="(type, keyword, selectorId) => emit('handleMasterInput', type, keyword, selectorId)"
        @handle-selector-keydown="(event, selectorId) => emit('handleSelectorKeydown', event, selectorId)"
        @open-master-selector-dialog="(type, selectorId, keyword) => emit('openMasterSelectorDialog', type, selectorId, keyword)"
        @select-line-product="(option, lineIndex, selectorId) => emit('selectLineProduct', option, lineIndex, selectorId)"
        @select-warehouse-option="(option, lineIndex, selectorId) => emit('selectWarehouseOption', option, lineIndex, selectorId)"
        @select-target-warehouse-option="(option, lineIndex, selectorId) => emit('selectTargetWarehouseOption', option, lineIndex, selectorId)"
        @entry-paste="(event, lineIndex) => emit('entryPaste', event, lineIndex)"
        @trace-source-order="(sourceLineNo, sourceOrderNo) => emit('traceSourceOrder', sourceLineNo, sourceOrderNo)"
        @open-downstream-trace="(line, lineIndex) => emit('openDownstreamTrace', line, lineIndex)"
        @line-drag-start="(event, lineIndex) => emit('lineDragStart', event, lineIndex)"
        @line-drag-over="emit('lineDragOver', $event)"
        @line-drop="emit('lineDrop', $event)"
        @line-drag-end="emit('lineDragEnd')"
        @insert-line-after="emit('insertLineAfter', $event)"
        @remove-line="emit('removeLine', $event)"
        @copy-line="emit('copyLine', $event)"
        @line-lifecycle="(lineNo, action) => emit('lineLifecycle', lineNo, action)"
        @add-line="emit('addLine')"
        @refresh-stock="emit('refreshStock')"
      />
      <MasterSelectorDialog
        :open="masterSelectorDialogOpen"
        :title="masterSelectorDialogTitle"
        :label="masterSelectorDialogLabel"
        :keyword="masterSelectorDialogKeyword"
        :rows="masterSelectorDialogRows"
        :total="masterSelectorDialogTotal"
        :loading="masterSelectorDialogLoading"
        :message="masterSelectorDialogMessage"
        @close="emit('closeMasterSelectorDialog')"
        @search="emit('searchMasterSelectorDialog', $event)"
        @select="emit('selectMasterSelectorDialogRow', $event)"
      />
    </div>
    <div v-else class="empty-shell">该表单正在等待本批次接入，先保留统一工作区和页签行为。</div>
  </StandardDocument>
</template>

<script setup lang="ts">
import EntryTable, { type EntryLine, type MasterOption } from "./EntryTable.vue";
import MasterSelectorDialog from "./MasterSelectorDialog.vue";
import StandardDocument from "./StandardDocument.vue";

interface DocumentFormState {
  billNo: string;
  sourceOrderNo?: string;
  redReverseBillNo?: string;
  redSourceBillNo?: string;
  partyCode: string;
  partyName?: string;
  billDate: string;
  department: string;
  ownerName: string;
  remark?: string;
  status: "DRAFT" | "AUDITED" | "REVERSED" | "VOIDED" | "RED_REVERSED";
  lines: EntryLine[];
}

withDefaults(defineProps<{
  title: string;
  subtitle: string;
  statusLabel: string;
  statusClass: string;
  locked: boolean;
  lockMessage?: string;
  canOverrideLock?: boolean;
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
  canClose?: boolean;
  canUnclose?: boolean;
  canFreeze?: boolean;
  canUnfreeze?: boolean;
  canDelete: boolean;
  showPushDown?: boolean;
  canPushDown?: boolean;
  pushDownLabel?: string;
  pushDownTestId?: string;
  canTraceSourceOrder: boolean;
  showSourceLineColumn: boolean;
  showExecutionColumns: boolean;
  showTargetWarehouseColumn?: boolean;
  showPlanDeliveryDateColumn?: boolean;
  showStockColumns?: boolean;
  enableSalesPriceBulk?: boolean;
  executionQtyLabel?: string;
  remainingQtyLabel?: string;
  entryTableColspan: number;
  entryTotalColspan: number;
  totalAmount: string;
  showTaxMode?: boolean;
  isTaxInclusive?: boolean;
  batchWarehouseCode: string;
  batchPlanDeliveryDate?: string;
  activeSelector: string;
  selectorOptions: MasterOption[];
  selectorCursorIndex: number;
  masterSelectorDialogOpen: boolean;
  masterSelectorDialogType: string;
  masterSelectorDialogTitle: string;
  masterSelectorDialogLabel: string;
  masterSelectorDialogKeyword: string;
  masterSelectorDialogRows: MasterOption[];
  masterSelectorDialogTotal: number;
  masterSelectorDialogLoading: boolean;
  masterSelectorDialogMessage: string;
  knownProductOptions: MasterOption[];
  draggingLineIndex: number | null;
  highlightedSourceBillNo: string;
  highlightedSourceLineNo: number | null;
}>(), {
  lockMessage: "",
  canOverrideLock: false,
  canRedReverse: undefined,
  canClose: false,
  canUnclose: false,
  canFreeze: false,
  canUnfreeze: false,
  showPushDown: false,
  canPushDown: false,
  pushDownLabel: "下推",
  pushDownTestId: "push-down-document",
  enableSalesPriceBulk: false
});

const emit = defineEmits<{
  create: [];
  save: [];
  audit: [];
  reverse: [];
  redReverse: [];
  voidDocument: [];
  closeDocument: [];
  uncloseDocument: [];
  freezeDocument: [];
  unfreezeDocument: [];
  pushDown: [];
  deleteDocument: [];
  exportDocument: [];
  printDocument: [];
  showExisting: [];
  overrideLock: [];
  openRedReverseBill: [];
  openRedSourceBill: [];
  "update:batchWarehouseCode": [value: string];
  "update:batchPlanDeliveryDate": [value: string];
  "update:isTaxInclusive": [value: boolean];
  applyBatchWarehouse: [];
  applyBatchPlanDeliveryDate: [lineIndexes: number[]];
  markDirty: [];
  searchMasterOptions: [type: string, keyword: string, selectorId: string];
  handleMasterInput: [type: string, keyword: string, selectorId: string];
  handleSelectorKeydown: [event: KeyboardEvent, selectorId: string];
  openMasterSelectorDialog: [type: string, selectorId: string, keyword: string];
  closeMasterSelectorDialog: [];
  searchMasterSelectorDialog: [keyword: string];
  selectMasterSelectorDialogRow: [option: MasterOption];
  selectPartyOption: [option: MasterOption];
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
  refreshStock: [];
}>();
</script>
