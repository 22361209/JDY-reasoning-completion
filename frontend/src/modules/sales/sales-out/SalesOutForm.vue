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
          <label>源订单号<input v-model="document.form.sourceOrderNo" data-testid="sales-out-source-order-no" @input="document.markDirty" @change="document.loadSourceOrderNo" @keydown.enter.prevent="document.loadSourceOrderNo" /></label>
          <button type="button" data-testid="sales-out-load-source-order" @click="document.loadSourceOrderNo">拉入明细</button>
          <button type="button" :disabled="!document.canTraceSourceOrder.value" data-testid="trace-source-order" @click="document.traceSourceOrder()">{{ document.form.sourceOrderNo || "追踪源单" }}</button>
        </div>
        <div class="form-head-field form-head-field-with-action">
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
          <button class="inline-pick-button" type="button" data-testid="sales-out-open-source-selector" @click="document.openCustomerSourceSelector">选单</button>
        </div>
        <label>客户名称<input :value="document.form.partyName || ''" data-testid="sales-out-party-name" readonly /></label>
        <label>业务日期<input v-model="document.form.billDate" data-testid="sales-out-bill-date" @input="document.markDirty" /></label>
        <label>单据编号<input v-model="document.form.billNo" data-testid="sales-out-bill-no" @input="document.markDirty" /></label>
        <label>部门<input v-model="document.form.department" data-testid="sales-out-department" @input="document.markDirty" /></label>
        <label>录入人<input :value="document.form.ownerName" data-testid="sales-out-owner-name" readonly /></label>
        <label class="tax-mode-field">
          价格口径
          <select v-model="taxMode" data-testid="sales-out-tax-mode" @change="document.markDirty">
            <option value="net">不含税</option>
            <option value="tax">含税</option>
          </select>
        </label>
        <label class="form-head-field-wide">单据备注<input v-model="document.form.remark" data-testid="sales-out-remark" @input="document.markDirty" /></label>
      </section>

      <EntryTable
        :lines="document.form.lines"
        test-prefix="sales-out"
        :is-draft="document.isDraft.value"
        :batch-warehouse-code="document.batchWarehouseCode.value"
        :batch-plan-delivery-date="document.batchPlanDeliveryDate.value"
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
        :show-plan-delivery-date-column="true"
        :entry-table-colspan="document.entryTableColspan.value"
        :entry-total-colspan="document.entryTotalColspan.value"
        :total-amount="document.totalAmount.value"
        :is-tax-inclusive="Boolean(document.form.isTaxInclusive)"
        :show-tax-columns="true"
        @update:batch-warehouse-code="document.batchWarehouseCode.value = $event"
        @update:batch-plan-delivery-date="document.batchPlanDeliveryDate.value = $event"
        @apply-batch-warehouse="document.applyBatchWarehouse"
        @apply-batch-plan-delivery-date="document.applyBatchPlanDeliveryDate"
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

  <div v-if="document.sourceSelectorOpen.value" class="modal-mask" data-testid="sales-out-source-selector-dialog">
    <div class="dialog source-selector-dialog">
      <h3>选择销售订单</h3>
      <p>{{ document.form.partyCode }} {{ document.form.partyName || '' }} 已下单且有剩余可出数量的销售订单明细。</p>
      <div class="source-selector-toolbar">
        <span>勾选同一张销售订单的一行或多行明细，确认后带入销售出库单。</span>
        <strong data-testid="sales-out-source-selector-count">{{ selectedSourceLineCount }}</strong>
      </div>
      <div class="source-selector-table">
        <table>
          <thead>
            <tr>
              <th></th>
              <th>销售订单</th>
              <th>行号</th>
              <th>日期</th>
              <th>商品编码</th>
              <th>商品名称</th>
              <th>仓库</th>
              <th>订单数量</th>
              <th>已出库</th>
              <th>剩余可出</th>
              <th>单价</th>
              <th>交期</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="document.sourceSelectorLoading.value">
              <td colspan="12">加载中...</td>
            </tr>
            <tr v-else-if="document.sourceSelectorLines.value.length === 0">
              <td colspan="12">暂无可选明细</td>
            </tr>
            <template v-else>
              <tr v-for="line in document.sourceSelectorLines.value" :key="document.sourceSelectorLineKey(line)">
                <td>
                  <input
                    type="checkbox"
                    :checked="Boolean(document.sourceSelectorSelected.value[document.sourceSelectorLineKey(line)])"
                    :data-testid="`sales-out-source-line-${document.sourceSelectorLineKey(line)}`"
                    @change="document.toggleSourceSelectorLine(line, ($event.target as HTMLInputElement).checked)"
                  />
                </td>
                <td>{{ line.billNo }}</td>
                <td>#{{ line.lineNo }}</td>
                <td>{{ line.billDate }}</td>
                <td>{{ line.productCode }}</td>
                <td>{{ line.productName || line.spec || '-' }}</td>
                <td>{{ line.warehouseCode }}</td>
                <td>{{ document.formatQty(line.sourceQty) }}</td>
                <td>{{ document.formatQty(line.shippedQty) }}</td>
                <td>{{ document.formatQty(line.remainingQty) }}</td>
                <td>{{ document.formatAmount(line.unitPrice) }}</td>
                <td>{{ line.planDeliveryDate || '-' }}</td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <p v-if="document.sourceSelectorMessage.value" class="form-error" data-testid="sales-out-source-selector-message">{{ document.sourceSelectorMessage.value }}</p>
      <div class="dialog-actions">
        <button type="button" data-testid="sales-out-source-selector-cancel" @click="document.closeCustomerSourceSelector">取消</button>
        <button class="primary-action" type="button" data-testid="sales-out-source-selector-ok" @click="document.confirmCustomerSourceSelector">确定</button>
      </div>
    </div>
  </div>

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
import { computed } from "vue";

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

const taxMode = computed({
  get: () => document.form.isTaxInclusive ? "tax" : "net",
  set: (value: string) => {
    document.form.isTaxInclusive = value === "tax";
  }
});

const selectedSourceLineCount = computed(() => `${Object.values(document.sourceSelectorSelected.value).filter(Boolean).length} 行已选`);

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
