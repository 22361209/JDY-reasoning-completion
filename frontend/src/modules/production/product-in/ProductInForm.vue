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
    test-prefix="product-in"
    party-label="来源"
    party-type="customer"
    :show-party-head-fields="false"
    :show-source-order-no-head-field="true"
    :source-order-no-head-readonly="true"
    :show-owner-name-head-field="false"
    bill-date-label="单据日期"
    department-label="生产车间"
    source-order-no-label="生产任务单"
    entry-section-title="成品信息"
    :is-document-form="true"
    :is-stock-document-form="false"
    :is-draft="document.isDraft.value"
    :can-audit="document.canAudit.value"
    :can-reverse="document.canReverse.value"
    :can-red-reverse="document.canRedReverse.value"
    :can-void="document.canVoid.value"
    :can-close="document.canClose.value"
    :can-unclose="document.canUnclose.value"
    :can-freeze="document.canFreeze.value"
    :can-unfreeze="document.canUnfreeze.value"
    :show-close="document.showCloseFreezeActions.value"
    :show-unclose="document.showCloseFreezeActions.value"
    :show-freeze="document.showCloseFreezeActions.value"
    :show-unfreeze="document.showCloseFreezeActions.value"
    :can-delete="document.canDelete.value"
    :show-source-select="true"
    :can-source-select="document.isDraft.value"
    source-select-label="选择生产任务"
    source-select-test-id="product-in-open-source-selector"
    :can-trace-source-order="document.canTraceSourceOrder.value"
    :show-source-line-column="document.showSourceLineColumn.value"
    :show-party-code-column="false"
    :show-execution-columns="document.showExecutionColumns.value"
    :show-price-amount-columns="document.showPriceAmountColumns"
    :show-product-info-section="document.showProductInfoSection"
    :show-section-titles="document.showProductInfoSection"
    :entry-table-colspan="document.entryTableColspan.value"
    :entry-total-colspan="document.entryTotalColspan.value"
    :total-amount="document.totalAmount.value"
    :batch-warehouse-code="document.batchWarehouseCode.value"
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
    @close-document="document.openLifecycleAction('close')"
    @unclose-document="document.openLifecycleAction('unclose')"
    @freeze-document="document.openLifecycleAction('freeze')"
    @unfreeze-document="document.openLifecycleAction('unfreeze')"
    @source-select="openSourceSelector"
    @delete-document="noop"
    @export-document="document.exportCurrent"
    @print-document="document.printCurrent"
    @show-existing="emit('showExisting')"
    @override-lock="emit('overrideLock')"
    @open-red-reverse-bill="document.openRedReverseBill"
    @open-red-source-bill="document.openRedSourceBill"
    @update:batch-warehouse-code="document.batchWarehouseCode.value = $event"
    @apply-batch-warehouse="document.applyBatchWarehouse"
    @mark-dirty="document.markDirty"
    @search-master-options="document.searchMasterOptions"
    @handle-master-input="document.handleMasterInput"
    @handle-selector-keydown="document.handleSelectorKeydown"
    @open-master-selector-dialog="document.openMasterSelectorDialog"
    @close-master-selector-dialog="document.closeMasterSelectorDialog"
    @select-master-selector-dialog-row="document.selectMasterSelectorDialogRow"
    @select-party-option="document.selectPartyOption($event, 'product-in-party')"
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
  />
  <SourceSelectorDialog
    :open="sourceSelectorOpen"
    test-prefix="product-in"
    title="选择可完工生产任务"
    description="仅显示已审核、已领料且仍有可完工数量的生产任务。"
    v-model:keyword="sourceSelectorKeyword"
    search-placeholder="任务单号/计划单号/产品/车间"
    :loading="sourceSelectorLoading"
    :rows="sourceSelectorRows"
    :columns="sourceSelectorColumns"
    :selected="sourceSelectorSelected"
    :count-label="selectedSourceCount"
    :summary-items="sourceSelectorSummaryItems"
    :message="sourceSelectorMessage"
    :row-key="sourceSelectorRowKey"
    :format-cell="formatSourceSelectorCell"
    :show-column-settings="true"
    :show-select-all="false"
    @query-change="sourceSelector.load"
    @toggle="sourceSelector.toggleRow"
    @close="sourceSelector.close"
    @confirm="confirmSourceSelector"
    @reset-columns="resetSourceColumns"
  />
  <DocumentDialogs v-bind="dialogBindings" v-on="dialogHandlers" />
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useSourceSelectorLifecycle } from "../../../app/sourceSelectorLifecycle";
import DocumentDialogs from "../../../components/DocumentDialogs.vue";
import DocumentForm from "../../../components/DocumentForm.vue";
import SourceSelectorDialog, { type SourceSelectorColumn } from "../../../components/SourceSelectorDialog.vue";
import type { DocumentDetail, OpenableDocumentType } from "../../../services/documentApi";
import { fetchSelectableProductInTasks, type SelectableProductionTaskLine } from "../../../services/productionApi";
import { useProductInDocument } from "./useProductInDocument";

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

const document = useProductInDocument({
  userName: () => props.userName,
  hasPermission: props.hasPermission,
  markDirty: () => emit("markDirty"),
  clearDirty: () => emit("clearDirty"),
  requestOpenDocument: (payload) => emit("requestOpenDocument", payload)
});

const sourceSelectorColumns = ref<SourceSelectorColumn[]>([
  { key: "selection", title: "选", width: 42, visible: true, configurable: false },
  { key: "billNo", title: "生产任务单", width: 150, visible: true },
  { key: "planNo", title: "生产计划单", width: 150, visible: true },
  { key: "billDate", title: "单据日期", width: 110, visible: true },
  { key: "department", title: "生产车间", width: 110, visible: true },
  { key: "productCode", title: "产品编码", width: 130, visible: true },
  { key: "productName", title: "产品名称", width: 180, visible: true },
  { key: "spec", title: "规格型号", width: 130, visible: true },
  { key: "unit", title: "单位", width: 70, visible: true },
  { key: "warehouseCode", title: "完工仓库", width: 110, visible: true },
  { key: "bomCode", title: "BOM", width: 120, visible: true },
  { key: "taskQty", title: "任务数量", width: 100, visible: true },
  { key: "issuedSets", title: "已领套数", width: 100, visible: true },
  { key: "completedQty", title: "已完工", width: 100, visible: true },
  { key: "completableQty", title: "可完工", width: 100, visible: true }
]);

const sourceSelector = useSourceSelectorLifecycle<SelectableProductionTaskLine>({
  rowKey: sourceSelectorRowKey,
  fetchRows: fetchSelectableProductInTasks,
  quantityField: "completableQty",
  countLabel: (count) => `${count} 张已选`,
  quantityLabel: "可完工合计",
  selectedQuantityLabel: "本次可完工",
  emptyMessage: "当前没有已领料且可完工的生产任务。",
  loadErrorMessage: "可完工生产任务加载失败。",
  formatQty,
  selectionMode: "single"
});
const sourceSelectorOpen = sourceSelector.open;
const sourceSelectorLoading = sourceSelector.loading;
const sourceSelectorMessage = sourceSelector.message;
const sourceSelectorKeyword = sourceSelector.keyword;
const sourceSelectorRows = sourceSelector.rows;
const sourceSelectorSelected = sourceSelector.selected;
const selectedSourceCount = sourceSelector.countLabel;
const sourceSelectorSummaryItems = sourceSelector.summaryItems;

const dialogBindings = computed(() => ({
  pendingZeroEntrySave: document.pendingZeroEntrySave.value,
  zeroReasonOptions: document.zeroReasonOptions,
  downstreamTrace: document.downstreamTrace.value,
  pendingRiskyDocumentAction: document.pendingRiskyDocumentAction.value,
  pendingLifecycleAction: document.pendingLifecycleAction.value,
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
  updateLifecycleReason: (value: string) => { document.lifecycleReason.value = value; },
  updateVoidUsername: (value: string) => { document.voidUsername.value = value; },
  updateVoidPassword: (value: string) => { document.voidPassword.value = value; },
  handleEntryPasteConflictKeydown: document.handleEntryPasteConflictKeydown,
  selectEntryPasteCandidate: document.selectEntryPasteCandidate,
  cancelPendingEntryPaste: document.cancelPendingEntryPaste,
  confirmPendingEntryPaste: document.confirmPendingEntryPaste
};

async function openSourceSelector() {
  if (!document.isDraft.value) {
    return;
  }
  await sourceSelector.openAndLoad({ keyword: document.form.sourceOrderNo || "", columnFilters: {} });
}

async function confirmSourceSelector() {
  const source = sourceSelector.selectedRowList.value[0];
  if (!source?.billNo) {
    sourceSelector.setMessage("请先选择一张生产任务单。");
    return;
  }
  const qty = numberValue(source.completableQty);
  if (qty <= 0) {
    sourceSelector.setMessage("该生产任务当前没有可完工数量。");
    return;
  }
  document.form.sourceOrderNo = source.billNo;
  document.form.partyCode = "";
  document.form.partyName = "";
  document.form.department = source.department || "生产部";
  document.form.productInfo = {
    productCode: source.productCode,
    productName: source.productName,
    spec: source.spec,
    unit: source.unit,
    warehouseCode: source.warehouseCode,
    taskQty: source.taskQty,
    remainingQty: source.completableQty,
    bomCode: source.bomCode,
    bomVersionNo: source.bomVersionNo
  };
  document.form.lines = [{
    lineNo: 1,
    sourceOrderNo: source.billNo,
    sourceLineNo: 1,
    productId: source.productId || "",
    productCode: source.productCode || "",
    productName: source.productName || "",
    spec: source.spec || "",
    unit: source.unit || "",
    warehouseCode: source.warehouseCode || "",
    qty,
    unitPrice: 1,
    lineRemark: ""
  }];
  document.batchWarehouseCode.value = source.warehouseCode || "";
  document.message.value = `已由生产任务单 ${source.billNo} 回填可完工成品`;
  sourceSelector.close();
  document.markDirty();
}

function resetSourceColumns() {
  sourceSelectorColumns.value = sourceSelectorColumns.value.map((column) => ({ ...column, visible: true }));
}

function sourceSelectorRowKey(row: SelectableProductionTaskLine | unknown) {
  return String((row as SelectableProductionTaskLine).billNo ?? "");
}

function formatSourceSelectorCell(row: unknown, columnKey: string) {
  const value = (row as Record<string, unknown>)[columnKey];
  if (["taskQty", "issuedSets", "completedQty", "completableQty"].includes(columnKey)) {
    return formatQty(value as number | string | undefined);
  }
  return String(value ?? "");
}

function formatQty(value: number | string | undefined) {
  const parsed = numberValue(value);
  return Number.isInteger(parsed) ? String(parsed) : parsed.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function noop() {}

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
