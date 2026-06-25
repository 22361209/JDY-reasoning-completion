<template>
  <StandardDocument
    :title="title"
    :subtitle="subtitle"
    :status-label="document.statusLabel.value"
    :status-class="statusClass"
    :locked="locked"
    :dirty="dirty"
    :message="document.message.value"
    :can-save="document.isDraft.value"
    :can-audit="document.canAudit.value"
    :can-reverse="document.canReverse.value"
    :can-void="document.canVoid.value"
    :can-delete="document.canDelete.value"
    :can-output="true"
    @create="document.startNew"
    @save="document.save()"
    @audit="document.audit"
    @reverse="document.openRiskyAction('reverse')"
    @red-reverse="document.openRiskyAction('redReverse')"
    @void-document="document.voidCurrent"
    @delete-document="noop"
    @export-document="document.exportCurrent"
    @print-document="document.printCurrent"
    @show-existing="emit('showExisting')"
  >
    <div class="form-layout">
      <section class="form-head-fields">
        <div v-if="document.form.redReverseBillNo || document.form.redSourceBillNo" class="source-order-field source-order-field--links">
          <button v-if="document.form.redReverseBillNo" class="red-reverse-link" type="button" data-testid="open-red-reverse-bill" @click="document.openRedReverseBill">红字单 {{ document.form.redReverseBillNo }}</button>
          <button v-if="document.form.redSourceBillNo" class="red-reverse-link" type="button" data-testid="open-red-source-bill" @click="document.openRedSourceBill">来源原单 {{ document.form.redSourceBillNo }}</button>
        </div>
        <div class="source-order-field">
          <label>源订单号<input v-model="document.form.sourceOrderNo" data-testid="sales-out-source-order-no" @input="document.markDirty" /></label>
          <button type="button" :disabled="!document.canTraceSourceOrder.value" data-testid="trace-source-order" @click="document.traceSourceOrder()">{{ document.form.sourceOrderNo || "追踪源单" }}</button>
        </div>
        <label>
          客户编码
          <span class="master-selector">
            <input
              v-model="document.form.partyCode"
              data-testid="sales-out-party-code"
              @focus="document.searchMasterOptions('customer', document.form.partyCode, 'sales-out-party')"
              @input="document.handleMasterInput('customer', document.form.partyCode, 'sales-out-party')"
              @keydown="document.handleSelectorKeydown($event, 'sales-out-party')"
            />
            <span v-if="document.activeSelector.value === 'sales-out-party'" class="master-selector__menu">
              <button
                v-for="(option, optionIndex) in document.selectorOptions.value"
                :key="option.code"
                type="button"
                :class="{ selected: document.selectorCursorIndex.value === optionIndex }"
                @mousedown.prevent="document.selectPartyOption(option, 'sales-out-party')"
              >
                <strong>{{ option.code }}</strong>
                <span>{{ option.name }}</span>
              </button>
            </span>
          </span>
        </label>
        <label>业务日期<input v-model="document.form.billDate" data-testid="sales-out-bill-date" @input="document.markDirty" /></label>
        <label>单据编号<input v-model="document.form.billNo" data-testid="sales-out-bill-no" @input="document.markDirty" /></label>
        <label>部门<input v-model="document.form.department" data-testid="sales-out-department" @input="document.markDirty" /></label>
      </section>

      <EntryTable
        :lines="document.form.lines"
        test-prefix="sales-out"
        :is-draft="document.isDraft.value"
        :batch-warehouse-code="document.batchWarehouseCode.value"
        :active-selector="document.activeSelector.value"
        :selector-options="document.selectorOptions.value"
        :selector-cursor-index="document.selectorCursorIndex.value"
        :known-product-options="knownProductOptions"
        :dragging-line-index="document.draggingLineIndex.value"
        :highlighted-source-bill-no="document.highlightedSourceBillNo.value"
        :highlighted-source-line-no="document.highlightedSourceLineNo.value"
        :current-bill-no="document.form.billNo"
        :show-source-line-column="document.showSourceLineColumn.value"
        :show-execution-columns="false"
        :entry-table-colspan="document.entryTableColspan.value"
        :entry-total-colspan="document.entryTotalColspan.value"
        :total-amount="document.totalAmount.value"
        @update:batch-warehouse-code="document.batchWarehouseCode.value = $event"
        @apply-batch-warehouse="document.applyBatchWarehouse"
        @mark-dirty="document.markDirty"
        @search-master-options="document.searchMasterOptions"
        @handle-master-input="document.handleMasterInput"
        @handle-selector-keydown="document.handleSelectorKeydown"
        @select-line-product="document.selectLineProduct"
        @select-warehouse-option="document.selectWarehouseOption"
        @entry-paste="document.handleEntryPaste"
        @trace-source-order="document.traceSourceOrder"
        @open-downstream-trace="document.openDownstreamTrace"
        @line-drag-start="document.handleLineDragStart"
        @line-drag-over="document.handleLineDragOver"
        @line-drop="document.handleLineDrop"
        @line-drag-end="document.draggingLineIndex.value = null"
        @insert-line-after="document.insertLineAfter"
        @remove-line="document.removeLine"
        @copy-line="document.copyLine"
        @add-line="document.addLine"
      />
    </div>
  </StandardDocument>

  <DocumentDialogs
    :pending-zero-entry-save="document.pendingZeroEntrySave.value"
    :zero-reason-options="document.zeroReasonOptions"
    :downstream-trace="document.downstreamTrace.value"
    :pending-risky-document-action="document.pendingRiskyDocumentAction.value"
    :pending-entry-paste="document.pendingEntryPaste.value"
    :pending-push-down="null"
    :current-bill-no="document.form.billNo"
    :current-order-status-label="document.statusLabel.value"
    :red-reverse-bill-no="document.redReverseBillNo.value"
    :risky-action-title="document.riskyActionTitle.value"
    :risky-action-summary="document.riskyActionSummary.value"
    :risky-action-impact="document.riskyActionImpact.value"
    :risky-action-verb="document.riskyActionVerb.value"
    :entry-paste-conflicts-resolved="document.entryPasteConflictsResolved.value"
    :push-confirm-ratio="0"
    :push-confirm-warehouse-code="''"
    :push-confirm-selection-summary="''"
    :all-push-down-lines-selected="false"
    :pending-push-down-total="'0.00'"
    :push-confirm-error="''"
    :format-qty="document.formatQty"
    :format-amount="document.formatAmount"
    :zero-reason-test-id="document.zeroReasonTestId"
    :downstream-type-label="document.downstreamTypeLabel"
    :backend-status-label="document.backendStatusLabel"
    :downstream-reverse-impact="document.downstreamReverseImpact"
    :downstream-red-reverse-impact="document.downstreamRedReverseImpact"
    :downstream-doc-test-id="document.downstreamDocTestId"
    :entry-paste-candidate-test-id="document.entryPasteCandidateTestId"
    :is-entry-paste-candidate-active="document.isEntryPasteCandidateActive"
    :push-confirm-select-test-id="stubPushTestId"
    :push-confirm-warehouse-test-id="stubPushTestId"
    :push-confirm-qty-test-id="stubPushTestId"
    @cancel-zero-entry-save="document.cancelZeroEntrySave"
    @confirm-zero-entry-save="document.confirmZeroEntrySave"
    @close-downstream-trace="document.downstreamTrace.value = null"
    @open-downstream-document="document.openDownstreamDocument"
    @cancel-risky-document-action="document.cancelRiskyAction"
    @confirm-risky-document-action="document.confirmRiskyAction"
    @handle-entry-paste-conflict-keydown="document.handleEntryPasteConflictKeydown"
    @select-entry-paste-candidate="document.selectEntryPasteCandidate"
    @cancel-pending-entry-paste="document.cancelPendingEntryPaste"
    @confirm-pending-entry-paste="document.confirmPendingEntryPaste"
    @update:push-confirm-ratio="noop"
    @update:push-confirm-warehouse-code="noop"
    @clear-push-down-qtys="noop"
    @fill-all-remaining-qtys="noop"
    @invert-push-down-selection="noop"
    @apply-push-down-ratio="noop"
    @apply-push-down-warehouse="noop"
    @toggle-all-push-down-lines-from-event="noop"
    @cancel-push-down="noop"
    @confirm-push-down="noop"
  />
</template>

<script setup lang="ts">
import EntryTable from "../../../components/EntryTable.vue";
import StandardDocument from "../../../components/StandardDocument.vue";
import DocumentDialogs from "../../../components/DocumentDialogs.vue";
import { knownProductOptions, type PendingPushLine } from "../../../app/documentModel";
import type { DocumentDetail, OpenableDocumentType } from "../../../services/documentApi";
import { useSalesOutDocument, type SalesOutPushDownDraft } from "./useSalesOutDocument";

const props = defineProps<{
  title: string;
  subtitle: string;
  statusClass: string;
  locked: boolean;
  dirty: boolean;
  userName: string;
  hasPermission: (permission: string) => boolean;
}>();

const emit = defineEmits<{
  markDirty: [];
  clearDirty: [];
  showExisting: [];
  requestOpenDocument: [payload: { type: OpenableDocumentType; billNo: string; sourceLineNo?: number | null }];
}>();

const document = useSalesOutDocument({
  userName: () => props.userName,
  hasPermission: props.hasPermission,
  markDirty: () => emit("markDirty"),
  clearDirty: () => emit("clearDirty"),
  requestOpenDocument: (payload) => emit("requestOpenDocument", payload)
});

function noop() {
}

function stubPushTestId() {
  return "sales-out-no-push-dialog";
}

async function loadByBillNo(billNo: string) {
  await document.loadByBillNo(billNo);
}

function startNew() {
  document.startNew();
}

function applyPushDownDraft(draft: Omit<SalesOutPushDownDraft, "lines"> & { lines: PendingPushLine[] }) {
  document.applyPushDownDraft(draft);
}

function applyDetail(detail: DocumentDetail, message = "", sourceLineNo: number | null = null) {
  document.applyDetail(detail, message, sourceLineNo);
}

defineExpose({
  loadByBillNo,
  startNew,
  applyPushDownDraft,
  applyDetail
});
</script>
