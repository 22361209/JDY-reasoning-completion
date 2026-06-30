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

  <SourceSelectorDialog
    :open="document.sourceSelectorOpen.value"
    test-prefix="sales-out"
    title="选择发货通知单"
    :description="`${document.form.partyCode || '未限定客户'} ${document.form.partyName || ''} 已审核且有剩余可出数量的发货通知明细。`"
    v-model:keyword="sourceSelectorKeyword"
    search-placeholder="客户/商品/订单号"
    :loading="document.sourceSelectorLoading.value"
    :rows="filteredSourceSelectorLines"
    :columns="sourceSelectorColumns"
    :selected="document.sourceSelectorSelected.value"
    :count-label="selectedSourceLineCount"
    :message="document.sourceSelectorMessage.value"
    :row-key="sourceSelectorRowKey"
    :format-cell="formatSourceSelectorCell"
    :show-column-settings="true"
    @select-all="selectAllVisibleSourceLines"
    @toggle="toggleSourceSelectorRow"
    @close="document.closeCustomerSourceSelector"
    @confirm="document.confirmCustomerSourceSelector"
    @reset-columns="resetSourceColumns"
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
import SourceSelectorDialog, { type SourceSelectorColumn } from "../../../components/SourceSelectorDialog.vue";
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
const sourceSelectorColumns = ref<SourceSelectorColumn[]>([
  { key: "selection", title: "选", width: 42, visible: true, configurable: false },
  { key: "billNo", title: "发货通知单", width: 150, visible: true },
  { key: "lineNo", title: "行号", width: 70, visible: true },
  { key: "customer", title: "客户", width: 190, visible: true },
  { key: "billDate", title: "日期", width: 120, visible: true },
  { key: "productCode", title: "物料编码", width: 130, visible: true },
  { key: "productName", title: "物料名称", width: 180, visible: true },
  { key: "unit", title: "单位", width: 80, visible: true },
  { key: "netWeight", title: "净重", width: 90, visible: true },
  { key: "grossWeight", title: "毛重", width: 90, visible: true },
  { key: "warehouseCode", title: "仓库", width: 110, visible: true },
  { key: "sourceQty", title: "通知数量", width: 100, visible: true },
  { key: "shippedQty", title: "已出库", width: 100, visible: true },
  { key: "remainingQty", title: "剩余可出", width: 110, visible: true },
  { key: "unitPrice", title: "单价", width: 112, visible: true },
  { key: "planDeliveryDate", title: "预计交期", width: 120, visible: true }
]);
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
    line.unit,
    line.billNo
  ].filter(Boolean).join(" ").toLowerCase();
}

function sourceSelectorRowKey(row: unknown) {
  return document.sourceSelectorLineKey(row as SelectableDeliveryNoticeLine);
}

function toggleSourceSelectorRow(row: unknown, checked: boolean) {
  document.toggleSourceSelectorLine(row as SelectableDeliveryNoticeLine, checked);
}

function formatSourceSelectorCell(row: unknown, columnKey: string) {
  const line = row as SelectableDeliveryNoticeLine;
  const values: Record<string, string | number> = {
    billNo: String(line.billNo ?? ""),
    lineNo: `#${line.lineNo ?? ""}`,
    customer: `${line.customerCode ?? ""} ${line.customer || ""}`.trim(),
    billDate: String(line.billDate ?? ""),
    productCode: String(line.productCode ?? ""),
    productName: String(line.productName || line.spec || "-"),
    unit: String(line.unit || "-"),
    netWeight: formatOptionalAmount(line.netWeight),
    grossWeight: formatOptionalAmount(line.grossWeight),
    warehouseCode: String(line.warehouseCode ?? ""),
    sourceQty: document.formatQty(line.sourceQty),
    shippedQty: document.formatQty(line.shippedQty),
    remainingQty: document.formatQty(line.remainingQty),
    unitPrice: document.formatAmount(line.unitPrice),
    planDeliveryDate: String(line.planDeliveryDate || "-")
  };
  return values[columnKey] ?? "";
}

function formatOptionalAmount(value: unknown) {
  return value === null || value === undefined || value === "" ? "-" : document.formatAmount(value as number | string | undefined);
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
