<template>
  <DocumentForm
    :title="title"
    :subtitle="subtitle"
    :status-label="document.statusLabel.value"
    :status-class="statusClass"
    :locked="locked"
    :lock-message="lockMessage"
    :can-override-lock="canOverrideLock"
    :dirty="dirty"
    :message="document.message.value"
    :form="document.form"
    test-prefix="sales-quote"
    :party-label="partyLabel"
    party-type="customer"
    :is-document-form="true"
    :is-stock-document-form="false"
    :is-draft="document.isDraft.value"
    :can-audit="document.canAudit.value"
    :can-reverse="document.canReverse.value"
    :can-red-reverse="false"
    :can-void="document.canVoid.value"
    :show-red-reverse="false"
    :can-close="false"
    :can-unclose="false"
    :can-freeze="false"
    :can-unfreeze="false"
    :show-close="false"
    :show-unclose="false"
    :show-freeze="false"
    :show-unfreeze="false"
    :show-source-select="showSourceSelect"
    :show-extra-action="document.form.status === 'AUDITED' && !isExpired"
    :can-extra-action="document.form.status === 'AUDITED' && !isExpired"
    :extra-action-label="document.form.enabled === false ? '设为有效' : '设为失效'"
    extra-action-test-id="sales-quote-toggle-valid"
    :show-delete="document.showDelete.value"
    :can-delete="document.canDelete.value"
    :can-trace-source-order="showSourceLineColumn"
    :show-source-line-column="showSourceLineColumn"
    :show-party-code-column="false"
    :show-customer-material-code-column="true"
    :show-customer-order-no-column="true"
    :show-execution-columns="false"
    :show-plan-delivery-date-column="false"
    :show-stock-columns="false"
    :enable-sales-price-bulk="false"
    :entry-table-colspan="document.entryTableColspan.value"
    :entry-total-colspan="document.entryTotalColspan.value"
    :total-amount="document.totalAmount.value"
    :show-tax-mode="document.showTaxMode.value"
    :show-valid-until="true"
    :is-tax-inclusive="Boolean(document.form.isTaxInclusive)"
    :batch-warehouse-code="document.batchWarehouseCode.value"
    :batch-plan-delivery-date="document.batchPlanDeliveryDate.value"
    :active-selector="document.activeSelector.value"
    :selector-options="document.selectorOptions.value"
    :selector-cursor-index="document.selectorCursorIndex.value"
    :master-selector-dialog-open="document.masterSelectorDialogOpen.value"
    :master-selector-dialog-type="document.masterSelectorDialogType.value"
    :master-selector-dialog-title="document.masterSelectorDialogTitle.value"
    :master-selector-dialog-label="document.masterSelectorDialogLabel.value"
    :master-selector-dialog-keyword="document.masterSelectorDialogKeyword.value"
    :known-product-options="document.knownProductOptions"
    :dragging-line-index="document.draggingLineIndex.value"
    :highlighted-source-bill-no="document.highlightedSourceBillNo.value"
    :highlighted-source-line-no="document.highlightedSourceLineNo.value"
    @create="document.startNew"
    @save="document.save()"
    @audit="document.audit"
    @reverse="document.openRiskyAction('reverse')"
    @red-reverse="document.openRiskyAction('redReverse')"
    @void-document="document.openLifecycleAction('void')"
    @extra-action="toggleEnabled"
    @delete-document="document.deleteCurrent"
    @export-document="document.exportCurrent"
    @print-document="document.printCurrent"
    @show-existing="emit('showExisting')"
    @override-lock="emit('overrideLock')"
    @update:batch-warehouse-code="document.batchWarehouseCode.value = $event"
    @update:batch-plan-delivery-date="document.batchPlanDeliveryDate.value = $event"
    @update:is-tax-inclusive="document.form.isTaxInclusive = $event; document.markDirty()"
    @apply-batch-warehouse="document.applyBatchWarehouse"
    @apply-batch-plan-delivery-date="document.applyBatchPlanDeliveryDate"
    @mark-dirty="document.markDirty"
    @search-master-options="document.searchMasterOptions"
    @handle-master-input="document.handleMasterInput"
    @handle-selector-keydown="document.handleSelectorKeydown"
    @open-master-selector-dialog="document.openMasterSelectorDialog"
    @close-master-selector-dialog="document.closeMasterSelectorDialog"
    @select-master-selector-dialog-row="document.selectMasterSelectorDialogRow"
    @select-party-option="document.selectPartyOption($event, 'sales-quote-party')"
    @select-line-product="document.selectLineProduct"
    @select-warehouse-option="document.selectWarehouseOption"
    @entry-paste="document.handleEntryPaste"
    @open-downstream-trace="document.openDownstreamTrace"
    @line-drag-start="document.handleLineDragStart"
    @line-drag-over="document.handleLineDragOver"
    @line-drop="document.handleLineDrop"
    @line-drag-end="document.draggingLineIndex.value = null"
    @insert-line-after="document.insertLineAfter"
    @remove-line="document.removeLine"
    @copy-line="document.copyLine"
    @line-lifecycle="(lineNo, action) => document.openLifecycleAction(action, lineNo)"
    @add-line="document.addLine"
  />
  <DocumentDialogs v-bind="dialogBindings" v-on="dialogHandlers" />
</template>

<script setup lang="ts">
import { computed } from "vue";
import DocumentDialogs from "../../../components/DocumentDialogs.vue";
import DocumentForm from "../../../components/DocumentForm.vue";
import { getBillDefinition } from "../../metadata/registry";
import type { DocumentDetail, OpenableDocumentType } from "../../../services/documentApi";
import { setSalesQuoteValid } from "../../../services/salesQuoteApi";
import { useSalesQuoteDocument } from "./useSalesQuoteDocument";

const billDefinition = getBillDefinition("salesQuote");
const partyLabel = billDefinition?.party?.codeLabel.replace(/编码$/, "") ?? "客户";
const showSourceSelect = billDefinition ? billDefinition.sourcePolicy !== "none" : false;
const showSourceLineColumn = billDefinition ? billDefinition.sourcePolicy !== "none" : false;

const props = defineProps<{
  title: string;
  subtitle: string;
  statusClass: string;
  locked: boolean;
  lockMessage?: string;
  canOverrideLock?: boolean;
  dirty: boolean;
  userName: string;
  hasPermission: (permission: string) => boolean;
}>();

const emit = defineEmits<{
  markDirty: [];
  clearDirty: [];
  showExisting: [];
  overrideLock: [];
  requestOpenDocument: [payload: { type: OpenableDocumentType; billNo: string; sourceLineNo?: number | null }];
}>();

const document = useSalesQuoteDocument({
  userName: () => props.userName,
  hasPermission: props.hasPermission,
  markDirty: () => emit("markDirty"),
  clearDirty: () => emit("clearDirty"),
  requestOpenDocument: (payload) => emit("requestOpenDocument", payload)
});

const isExpired = computed(() => Boolean(document.form.validUntil && document.form.validUntil < todayText()));

const dialogBindings = computed(() => ({
  pendingZeroEntrySave: document.pendingZeroEntrySave.value,
  zeroReasonOptions: document.zeroReasonOptions,
  downstreamTrace: document.downstreamTrace.value,
  pendingRiskyDocumentAction: document.pendingRiskyDocumentAction.value,
  pendingLifecycleAction: document.pendingLifecycleAction.value,
  pendingDeleteDocument: document.pendingDeleteDocument.value,
  pendingLifecycleLineNo: document.pendingLifecycleLineNo.value,
  pendingEntryPaste: document.pendingEntryPaste.value,
  currentBillNo: document.form.billNo,
  currentOrderStatusLabel: document.statusLabel.value,
  redReverseBillNo: document.redReverseBillNo.value,
  riskyActionTitle: document.riskyActionTitle.value,
  riskyActionSummary: document.riskyActionSummary.value,
  riskyActionImpact: document.riskyActionImpact.value,
  riskyActionVerb: document.riskyActionVerb.value,
  lifecycleReason: document.lifecycleReason.value,
  voidUsername: document.voidUsername.value,
  voidPassword: document.voidPassword.value,
  entryPasteConflictsResolved: document.entryPasteConflictsResolved.value,
  formatQty: document.formatQty,
  formatAmount: document.formatAmount,
  zeroReasonTestId: document.zeroReasonTestId,
  downstreamTypeLabel: document.downstreamTypeLabel,
  backendStatusLabel: document.backendStatusLabel,
  downstreamReverseImpact: document.downstreamReverseImpact,
  downstreamRedReverseImpact: document.downstreamRedReverseImpact,
  downstreamDocTestId: document.downstreamDocTestId,
  entryPasteCandidateTestId: document.entryPasteCandidateTestId,
  isEntryPasteCandidateActive: document.isEntryPasteCandidateActive,
}));

const dialogHandlers = {
  cancelZeroEntrySave: document.cancelZeroEntrySave,
  confirmZeroEntrySave: document.confirmZeroEntrySave,
  closeDownstreamTrace: () => { document.downstreamTrace.value = null; },
  openDownstreamDocument: document.openDownstreamDocument,
  cancelRiskyDocumentAction: document.cancelRiskyAction,
  confirmRiskyDocumentAction: document.confirmRiskyAction,
  cancelLifecycleAction: document.cancelLifecycleAction,
  confirmLifecycleAction: document.confirmLifecycleAction,
  cancelDeleteDocument: document.cancelDeleteDocument,
  confirmDeleteDocument: document.confirmDeleteDocument,
  updateLifecycleReason: (value: string) => { document.lifecycleReason.value = value; },
  updateVoidUsername: (value: string) => { document.voidUsername.value = value; },
  updateVoidPassword: (value: string) => { document.voidPassword.value = value; },
  handleEntryPasteConflictKeydown: document.handleEntryPasteConflictKeydown,
  selectEntryPasteCandidate: document.selectEntryPasteCandidate,
  cancelPendingEntryPaste: document.cancelPendingEntryPaste,
  confirmPendingEntryPaste: document.confirmPendingEntryPaste
};

async function toggleEnabled() {
  const nextEnabled = document.form.enabled === false;
  const result = await setSalesQuoteValid(document.form.billNo, nextEnabled);
  document.message.value = result.ok ? `销售报价单已${nextEnabled ? "设为有效" : "设为失效"}` : result.message;
  if (result.ok) {
    document.form.enabled = nextEnabled;
  }
}

function todayText() {
  const today = new Date();
  return [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0")
  ].join("-");
}

async function loadByBillNo(billNo: string) {
  await document.loadByBillNo(billNo);
}

function startNew() {
  document.startNew();
}

function applyDetail(detail: DocumentDetail, message = "", sourceLineNo: number | null = null) {
  document.applyDetail(detail, message, sourceLineNo);
}

defineExpose({ loadByBillNo, startNew, applyDetail });
</script>
