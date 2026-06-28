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
    test-prefix="sales-out"
    party-label="客户"
    party-type="customer"
    :is-document-form="true"
    :is-stock-document-form="true"
    :is-draft="document.isDraft.value"
    :can-audit="document.canAudit.value"
    :can-reverse="document.canReverse.value"
    :can-red-reverse="document.canReverse.value"
    :can-void="document.canVoid.value"
    :can-close="document.canClose.value"
    :can-unclose="document.canUnclose.value"
    :can-freeze="document.canFreeze.value"
    :can-unfreeze="document.canUnfreeze.value"
    :show-delete="document.showDelete.value"
    :can-delete="document.canDelete.value"
    :show-source-select="true"
    :can-source-select="document.isDraft.value"
    source-select-label="选源单"
    source-select-test-id="sales-out-open-source-selector"
    :can-trace-source-order="document.canTraceSourceOrder.value"
    :show-source-line-column="document.showSourceLineColumn.value"
    :show-party-code-column="false"
    :show-customer-material-code-column="true"
    :show-customer-order-no-column="true"
    :show-execution-columns="false"
    :show-plan-delivery-date-column="true"
    :enable-sales-price-bulk="true"
    :entry-table-colspan="document.entryTableColspan.value"
    :entry-total-colspan="document.entryTotalColspan.value"
    :total-amount="document.totalAmount.value"
    :show-tax-mode="true"
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
    :master-selector-dialog-rows="document.masterSelectorDialogRows.value"
    :master-selector-dialog-total="document.masterSelectorDialogTotal.value"
    :master-selector-dialog-loading="document.masterSelectorDialogLoading.value"
    :master-selector-dialog-message="document.masterSelectorDialogMessage.value"
    :known-product-options="knownProductOptions"
    :dragging-line-index="document.draggingLineIndex.value"
    :highlighted-source-bill-no="document.highlightedSourceBillNo.value"
    :highlighted-source-line-no="document.highlightedSourceLineNo.value"
    @update:batch-warehouse-code="document.batchWarehouseCode.value = $event"
    @update:batch-plan-delivery-date="document.batchPlanDeliveryDate.value = $event"
    @update:is-tax-inclusive="document.form.isTaxInclusive = $event; document.markDirty()"
    @create="document.startNew"
    @save="document.save()"
    @audit="document.audit"
    @reverse="document.openRiskyAction('reverse')"
    @red-reverse="document.openRiskyAction('redReverse')"
    @void-document="document.openLifecycleAction('void')"
    @close-document="document.openLifecycleAction('close')"
    @unclose-document="document.openLifecycleAction('unclose')"
    @freeze-document="document.openLifecycleAction('freeze')"
    @unfreeze-document="document.openLifecycleAction('unfreeze')"
    @source-select="document.openCustomerSourceSelector"
    @delete-document="document.deleteCurrent"
    @export-document="document.exportCurrent"
    @print-document="document.printCurrent"
    @show-existing="emit('showExisting')"
    @override-lock="emit('overrideLock')"
    @open-red-reverse-bill="document.openRedReverseBill"
    @open-red-source-bill="document.openRedSourceBill"
    @apply-batch-warehouse="document.applyBatchWarehouse"
    @apply-batch-plan-delivery-date="document.applyBatchPlanDeliveryDate"
    @mark-dirty="document.markDirty"
    @search-master-options="document.searchMasterOptions"
    @handle-master-input="document.handleMasterInput"
    @handle-selector-keydown="document.handleSelectorKeydown"
    @open-master-selector-dialog="document.openMasterSelectorDialog"
    @close-master-selector-dialog="document.closeMasterSelectorDialog"
    @search-master-selector-dialog="document.searchMasterSelectorDialog"
    @select-master-selector-dialog-row="document.selectMasterSelectorDialogRow"
    @select-party-option="(option) => document.selectPartyOption(option, 'sales-out-party')"
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
    @line-lifecycle="(lineNo, action) => document.openLifecycleAction(action, lineNo)"
    @add-line="document.addLine"
  >
  </DocumentForm>

  <div v-if="document.sourceSelectorOpen.value" class="modal-mask" data-testid="sales-out-source-selector-dialog">
    <div class="dialog source-selector-dialog">
      <h3>选择发货通知单</h3>
      <p>{{ document.form.partyCode || '未限定客户' }} {{ document.form.partyName || '' }} 已审核且有剩余可出数量的发货通知明细。</p>
      <div class="source-selector-toolbar">
        <input
          v-model="sourceSelectorKeyword"
          data-testid="sales-out-source-selector-search"
          placeholder="客户/商品/订单号"
        />
        <button type="button" data-testid="sales-out-source-selector-select-all" @click="selectAllVisibleSourceLines">全选</button>
        <button type="button" data-testid="sales-out-source-selector-column-settings" @click="sourceColumnDialogOpen = true">列设置</button>
        <strong data-testid="sales-out-source-selector-count">{{ selectedSourceLineCount }}</strong>
      </div>
      <div class="source-selector-table">
        <table>
          <thead>
            <tr>
              <th v-for="column in visibleSourceColumns" :key="column.key" :style="{ width: `${column.width}px` }">{{ column.title }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="document.sourceSelectorLoading.value">
              <td :colspan="visibleSourceColumns.length">加载中...</td>
            </tr>
            <tr v-else-if="filteredSourceSelectorLines.length === 0">
              <td :colspan="visibleSourceColumns.length">暂无可选明细</td>
            </tr>
            <template v-else>
              <tr v-for="line in filteredSourceSelectorLines" :key="document.sourceSelectorLineKey(line)">
                <td v-if="isSourceColumnVisible('selection')">
                  <input
                    type="checkbox"
                    :checked="Boolean(document.sourceSelectorSelected.value[document.sourceSelectorLineKey(line)])"
                    :data-testid="`sales-out-source-line-${document.sourceSelectorLineKey(line)}`"
                    @change="document.toggleSourceSelectorLine(line, ($event.target as HTMLInputElement).checked)"
                  />
                </td>
                <td v-if="isSourceColumnVisible('billNo')">{{ line.billNo }}</td>
                <td v-if="isSourceColumnVisible('lineNo')">#{{ line.lineNo }}</td>
                <td v-if="isSourceColumnVisible('customer')">{{ line.customerCode }} {{ line.customer || '' }}</td>
                <td v-if="isSourceColumnVisible('billDate')">{{ line.billDate }}</td>
                <td v-if="isSourceColumnVisible('productCode')">{{ line.productCode }}</td>
                <td v-if="isSourceColumnVisible('productName')">{{ line.productName || line.spec || '-' }}</td>
                <td v-if="isSourceColumnVisible('warehouseCode')">{{ line.warehouseCode }}</td>
                <td v-if="isSourceColumnVisible('sourceQty')">{{ document.formatQty(line.sourceQty) }}</td>
                <td v-if="isSourceColumnVisible('shippedQty')">{{ document.formatQty(line.shippedQty) }}</td>
                <td v-if="isSourceColumnVisible('remainingQty')">{{ document.formatQty(line.remainingQty) }}</td>
                <td v-if="isSourceColumnVisible('unitPrice')">{{ document.formatAmount(line.unitPrice) }}</td>
                <td v-if="isSourceColumnVisible('planDeliveryDate')">{{ line.planDeliveryDate || '-' }}</td>
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

  <ColumnSettingsDialog
    :open="sourceColumnDialogOpen"
    title="列设置"
    :columns="sourceSelectorColumns"
    dialog-test-id="sales-out-source-selector-column-settings-dialog"
    ok-test-id="sales-out-source-selector-column-settings-ok"
    @reset="resetSourceColumns"
    @confirm="sourceColumnDialogOpen = false"
  />

  <DocumentDialogs
    :pending-zero-entry-save="document.pendingZeroEntrySave.value"
    :zero-reason-options="document.zeroReasonOptions"
    :downstream-trace="document.downstreamTrace.value"
    :pending-risky-document-action="document.pendingRiskyDocumentAction.value"
    :pending-lifecycle-action="document.pendingLifecycleAction.value"
    :pending-lifecycle-line-no="document.pendingLifecycleLineNo.value"
    :pending-delete-document="document.pendingDeleteDocument.value"
    delete-document-title="销售出库单"
    :pending-entry-paste="document.pendingEntryPaste.value"
    :current-bill-no="document.form.billNo"
    :current-order-status-label="document.statusLabel.value"
    :red-reverse-bill-no="document.redReverseBillNo.value"
    :risky-action-title="document.riskyActionTitle.value"
    :risky-action-summary="document.riskyActionSummary.value"
    :risky-action-impact="document.riskyActionImpact.value"
    :risky-action-verb="document.riskyActionVerb.value"
    :lifecycle-reason="document.lifecycleReason.value"
    :void-username="document.voidUsername.value"
    :void-password="document.voidPassword.value"
    :entry-paste-conflicts-resolved="document.entryPasteConflictsResolved.value"
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
    @cancel-zero-entry-save="document.cancelZeroEntrySave"
    @confirm-zero-entry-save="document.confirmZeroEntrySave"
    @close-downstream-trace="document.downstreamTrace.value = null"
    @open-downstream-document="document.openDownstreamDocument"
    @cancel-risky-document-action="document.cancelRiskyAction"
    @confirm-risky-document-action="document.confirmRiskyAction"
    @cancel-lifecycle-action="document.cancelLifecycleAction"
    @confirm-lifecycle-action="document.confirmLifecycleAction"
    @cancel-delete-document="document.cancelDeleteDocument"
    @confirm-delete-document="document.confirmDeleteDocument"
    @update-lifecycle-reason="document.lifecycleReason.value = $event"
    @update-void-username="document.voidUsername.value = $event"
    @update-void-password="document.voidPassword.value = $event"
    @handle-entry-paste-conflict-keydown="document.handleEntryPasteConflictKeydown"
    @select-entry-paste-candidate="document.selectEntryPasteCandidate"
    @cancel-pending-entry-paste="document.cancelPendingEntryPaste"
    @confirm-pending-entry-paste="document.confirmPendingEntryPaste"
  />
</template>

<script setup lang="ts">
import DocumentForm from "../../../components/DocumentForm.vue";
import DocumentDialogs from "../../../components/DocumentDialogs.vue";
import ColumnSettingsDialog from "../../../components/table/ColumnSettingsDialog.vue";
import { knownProductOptions, type PendingPushLine } from "../../../app/documentModel";
import type { DocumentDetail, OpenableDocumentType } from "../../../services/documentApi";
import type { SelectableDeliveryNoticeLine } from "../../../services/salesOrderApi";
import { useSalesOutDocument, type SalesOutPushDownDraft } from "./useSalesOutDocument";
import { computed, ref } from "vue";

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

const document = useSalesOutDocument({
  userName: () => props.userName,
  hasPermission: props.hasPermission,
  markDirty: () => emit("markDirty"),
  clearDirty: () => emit("clearDirty"),
  requestOpenDocument: (payload) => emit("requestOpenDocument", payload)
});

const selectedSourceLineCount = computed(() => `${Object.values(document.sourceSelectorSelected.value).filter(Boolean).length} 行已选`);
const sourceSelectorKeyword = ref("");
const sourceColumnDialogOpen = ref(false);
const sourceSelectorColumns = ref([
  { key: "selection", title: "选", width: 42, visible: true, configurable: false },
  { key: "billNo", title: "发货通知单", width: 150, visible: true },
  { key: "lineNo", title: "行号", width: 70, visible: true },
  { key: "customer", title: "客户", width: 190, visible: true },
  { key: "billDate", title: "日期", width: 120, visible: true },
  { key: "productCode", title: "物料编码", width: 130, visible: true },
  { key: "productName", title: "物料名称", width: 180, visible: true },
  { key: "warehouseCode", title: "仓库", width: 110, visible: true },
  { key: "sourceQty", title: "通知数量", width: 100, visible: true },
  { key: "shippedQty", title: "已出库", width: 100, visible: true },
  { key: "remainingQty", title: "剩余可出", width: 110, visible: true },
  { key: "unitPrice", title: "单价", width: 112, visible: true },
  { key: "planDeliveryDate", title: "预计交期", width: 120, visible: true }
]);
const visibleSourceColumns = computed(() => sourceSelectorColumns.value.filter((column) => column.visible));
const filteredSourceSelectorLines = computed(() => {
  const keyword = sourceSelectorKeyword.value.trim().toLowerCase();
  if (!keyword) {
    return document.sourceSelectorLines.value;
  }
  return document.sourceSelectorLines.value.filter((line) => sourceLineSearchText(line).includes(keyword));
});

function sourceLineSearchText(line: SelectableDeliveryNoticeLine) {
  return [
    line.customerCode,
    line.customer,
    line.productCode,
    line.productName,
    line.spec,
    line.billNo
  ].filter(Boolean).join(" ").toLowerCase();
}

function isSourceColumnVisible(key: string) {
  return sourceSelectorColumns.value.some((column) => column.key === key && column.visible);
}

function selectAllVisibleSourceLines() {
  filteredSourceSelectorLines.value.forEach((line) => document.toggleSourceSelectorLine(line, true));
}

function resetSourceColumns() {
  sourceSelectorColumns.value.forEach((column) => {
    column.visible = true;
  });
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
