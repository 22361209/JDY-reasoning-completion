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
    test-prefix="purchase-in"
    party-label="供应商"
    party-type="supplier"
    :is-document-form="true"
    :is-stock-document-form="true"
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
    :show-delete="document.showDelete.value"
    :can-delete="document.canDelete.value"
    :show-source-select="true"
    :can-source-select="document.isDraft.value"
    source-select-label="选源单"
    source-select-test-id="purchase-in-open-source-selector"
    :can-trace-source-order="document.canTraceSourceOrder.value"
    :show-source-line-column="document.showSourceLineColumn.value"
    :show-execution-columns="document.showExecutionColumns.value"
    :entry-table-colspan="document.entryTableColspan.value"
    :entry-total-colspan="document.entryTotalColspan.value"
    :total-amount="document.totalAmount.value"
    :show-tax-mode="document.showTaxMode.value"
    :is-tax-inclusive="Boolean(document.form.isTaxInclusive)"
    :batch-warehouse-code="document.batchWarehouseCode.value"
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
    @delete-document="document.deleteCurrent"
    @export-document="document.exportCurrent"
    @print-document="document.printCurrent"
    @show-existing="emit('showExisting')"
    @override-lock="emit('overrideLock')"
    @open-red-reverse-bill="document.openRedReverseBill"
    @open-red-source-bill="document.openRedSourceBill"
    @update:batch-warehouse-code="document.batchWarehouseCode.value = $event"
    @update:is-tax-inclusive="document.form.isTaxInclusive = $event; document.markDirty()"
    @apply-batch-warehouse="document.applyBatchWarehouse"
    @mark-dirty="document.markDirty"
    @search-master-options="document.searchMasterOptions"
    @handle-master-input="document.handleMasterInput"
    @handle-selector-keydown="document.handleSelectorKeydown"
    @open-master-selector-dialog="document.openMasterSelectorDialog"
    @close-master-selector-dialog="document.closeMasterSelectorDialog"
    @search-master-selector-dialog="document.searchMasterSelectorDialog"
    @select-master-selector-dialog-row="document.selectMasterSelectorDialogRow"
    @select-party-option="document.selectPartyOption($event, 'purchase-in-party')"
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
    test-prefix="purchase-in"
    title="选择采购订单"
    :description="`${document.form.partyCode || '未限定供应商'} ${document.form.partyName || ''} 已审核且有剩余可入数量的采购订单明细。`"
    v-model:keyword="sourceSelectorKeyword"
    search-placeholder="供应商/商品/订单号"
    :loading="sourceSelectorLoading"
    :rows="sourceSelectorRows"
    :columns="sourceSelectorColumns"
    :selected="sourceSelectorSelected"
    :count-label="selectedSourceLineCount"
    :summary-items="sourceSelectorSummaryItems"
    :message="sourceSelectorMessage"
    :row-key="sourceSelectorRowKey"
    :format-cell="formatSourceSelectorCell"
    :show-column-settings="true"
    @query-change="sourceSelector.load"
    @select-all="sourceSelector.selectAll"
    @toggle="sourceSelector.toggleRow"
    @close="closeSourceSelector"
    @confirm="confirmSourceSelector"
    @reset-columns="resetSourceColumns"
  />
  <DocumentDialogs v-bind="dialogBindings" v-on="dialogHandlers" />
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import DocumentDialogs from "../../../components/DocumentDialogs.vue";
import DocumentForm from "../../../components/DocumentForm.vue";
import SourceSelectorDialog, { type SourceSelectorColumn } from "../../../components/SourceSelectorDialog.vue";
import type { DocumentDetail, OpenableDocumentType } from "../../../services/documentApi";
import type { OrderLineForm, PendingPushLine } from "../../../app/documentModel";
import { sumField, useSourceSelectorLifecycle } from "../../../app/sourceSelectorLifecycle";
import { fetchSelectablePurchaseOrderLines, type SelectablePurchaseOrderLine } from "../../../services/purchaseOrderApi";
import { usePurchaseInDocument } from "./usePurchaseInDocument";

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

const document = usePurchaseInDocument({
  userName: () => props.userName,
  hasPermission: props.hasPermission,
  markDirty: () => emit("markDirty"),
  clearDirty: () => emit("clearDirty"),
  requestOpenDocument: (payload) => emit("requestOpenDocument", payload)
});

const sourceSelectorColumns = ref<SourceSelectorColumn[]>([
  { key: "selection", title: "选", width: 42, visible: true, configurable: false },
  { key: "billNo", title: "采购订单", width: 150, visible: true },
  { key: "lineNo", title: "行号", width: 70, visible: true },
  { key: "supplier", title: "供应商名称", width: 190, visible: true },
  { key: "billDate", title: "单据日期", width: 120, visible: true },
  { key: "planDeliveryDate", title: "预计交期", width: 120, visible: true },
  { key: "productCode", title: "物料编码", width: 130, visible: true },
  { key: "supplierMaterialCode", title: "供应商物料编码", width: 150, visible: true },
  { key: "productName", title: "物料名称", width: 180, visible: true },
  { key: "unit", title: "单位", width: 80, visible: true },
  { key: "netWeight", title: "净重", width: 90, visible: true },
  { key: "grossWeight", title: "毛重", width: 90, visible: true },
  { key: "warehouseCode", title: "仓库", width: 110, visible: true },
  { key: "sourceQty", title: "订单数量", width: 100, visible: true },
  { key: "receivedQty", title: "已入库", width: 100, visible: true },
  { key: "remainingQty", title: "剩余可入", width: 110, visible: true },
  { key: "unitPrice", title: "单价", width: 100, visible: true },
  { key: "priceTaxTotal", title: "含税金额", width: 110, visible: true },
  { key: "lineRemark", title: "行备注", width: 160, visible: true }
]);
const sourceSelector = useSourceSelectorLifecycle<SelectablePurchaseOrderLine>({
  rowKey: sourceSelectorLineKey,
  fetchRows: (query) => fetchSelectablePurchaseOrderLines(document.form.partyCode, query),
  quantityField: "remainingQty",
  quantityLabel: "剩余可入合计",
  selectedQuantityLabel: "已选数量",
  emptyMessage: "当前过滤条件下暂无可选采购订单明细。",
  loadErrorMessage: "采购订单选单列表加载失败。",
  formatQty,
  allocatedQty: allocatedSourceQty,
  extraSummaryItems: (visibleRows) => [
    { key: "priceTaxTotal", label: "含税金额合计", value: formatAmount(sumField(visibleRows, "priceTaxTotal")) }
  ]
});
const sourceSelectorOpen = sourceSelector.open;
const sourceSelectorLoading = sourceSelector.loading;
const sourceSelectorMessage = sourceSelector.message;
const sourceSelectorKeyword = sourceSelector.keyword;
const sourceSelectorRows = sourceSelector.rows;
const sourceSelectorSelected = sourceSelector.selected;
const selectedSourceLineCount = sourceSelector.countLabel;
const sourceSelectorSummaryItems = sourceSelector.summaryItems;

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

async function openSourceSelector() {
  if (!document.isDraft.value) {
    return;
  }
  const supplierCode = document.form.partyCode.trim();
  if (!supplierCode) {
    document.message.value = "请先在单头选择供应商，再从该供应商的已审核采购订单中选源单。";
    return;
  }
  await sourceSelector.openAndLoad({ keyword: "", columnFilters: {} });
}

function closeSourceSelector() {
  sourceSelector.close();
}

function confirmSourceSelector() {
  const selectedLines = sourceSelector.selectedRowList.value;
  if (selectedLines.length === 0) {
    sourceSelectorMessage.value = "请至少勾选一条采购订单明细。";
    return;
  }
  const first = selectedLines[0];
  if (!first) {
    return;
  }
  document.form.sourceOrderNo = "";
  document.form.partyCode = first.supplierCode;
  document.form.partyName = first.supplier || document.form.partyName || "";
  document.form.department = first.department || document.form.department || "采购部";
  document.form.isTaxInclusive = Boolean(first.isTaxInclusive);
  appendSourceLines(selectedLines.map(selectableLineToFormLine));
  sourceSelector.commitLocalAllocation();
  sourceSelector.close();
  document.message.value = `已追加 ${selectedLines.length} 行采购订单剩余可入明细`;
  document.markDirty();
}

function appendSourceLines(lines: OrderLineForm[]) {
  const currentLines = document.form.lines;
  const shouldReplaceStarter = currentLines.length === 1 && isBlankOrStarterLine(currentLines[0]);
  document.form.lines = shouldReplaceStarter ? lines : [...currentLines, ...lines];
}

function selectableLineToFormLine(line: SelectablePurchaseOrderLine): OrderLineForm {
  return {
    productId: String(line.productId ?? ""),
    productCode: String(line.productCode ?? ""),
    productName: String(line.productName ?? ""),
    spec: String(line.spec ?? ""),
    unit: String(line.unit ?? ""),
    netWeight: line.netWeight ?? "",
    grossWeight: line.grossWeight ?? "",
    warehouseCode: String(line.warehouseCode ?? "CK-001"),
    sourceOrderNo: String(line.billNo ?? ""),
    sourceLineNo: normalizedOptionalInt(line.lineNo),
    qty: normalizedQty(line.remainingQty),
    unitPrice: Number(line.unitPrice ?? 0),
    taxRate: Number(line.taxRate ?? 13),
    taxAmount: line.taxAmount,
    priceTaxTotal: line.priceTaxTotal,
    lineRemark: String(line.lineRemark ?? "")
  };
}

function sourceSelectorLineKey(line: SelectablePurchaseOrderLine) {
  return sourceLineKey(line.billNo, line.lineNo);
}

function sourceSelectorRowKey(row: unknown) {
  return sourceSelectorLineKey(row as SelectablePurchaseOrderLine);
}

function formatSourceSelectorCell(row: unknown, columnKey: string) {
  const line = row as SelectablePurchaseOrderLine;
  const values: Record<string, string | number> = {
    billNo: String(line.billNo ?? ""),
    lineNo: `#${line.lineNo ?? ""}`,
    supplier: `${line.supplierCode ?? ""} ${line.supplier || ""}`.trim(),
    billDate: String(line.billDate ?? ""),
    planDeliveryDate: String(line.planDeliveryDate || "-"),
    productCode: String(line.productCode ?? ""),
    supplierMaterialCode: String(line.supplierMaterialCode || "-"),
    productName: String(line.productName || line.spec || "-"),
    unit: String(line.unit || "-"),
    netWeight: formatOptionalAmount(line.netWeight),
    grossWeight: formatOptionalAmount(line.grossWeight),
    warehouseCode: String(line.warehouseCode ?? ""),
    sourceQty: formatQty(line.sourceQty),
    receivedQty: formatQty(line.receivedQty),
    remainingQty: formatQty(line.remainingQty),
    unitPrice: formatAmount(line.unitPrice),
    priceTaxTotal: formatAmount(line.priceTaxTotal),
    lineRemark: String(line.lineRemark || "")
  };
  return values[columnKey] ?? "";
}

function formatOptionalAmount(value: unknown) {
  return value === null || value === undefined || value === "" ? "-" : formatAmount(value as number | string | undefined);
}

function resetSourceColumns() {
  sourceSelectorColumns.value.forEach((column) => {
    column.visible = true;
  });
}

function allocatedSourceQty(source: SelectablePurchaseOrderLine) {
  const sourceKey = sourceSelectorLineKey(source);
  return document.form.lines.reduce((sum, line) => {
    if (sourceLineKey(line.sourceOrderNo, line.sourceLineNo) !== sourceKey) {
      return sum;
    }
    return sum + normalizedQty(line.qty);
  }, 0);
}

function sourceLineKey(billNo: unknown, lineNo: unknown) {
  return `${String(billNo ?? "")}:${String(lineNo ?? "")}`;
}

function formatQty(value: number | string | undefined) {
  return document.formatQty(value ?? 0);
}

function formatAmount(value: number | string | undefined) {
  return document.formatAmount(value ?? 0);
}

function normalizedQty(value: number | string | undefined) {
  const qty = Number(value ?? 0);
  return Number.isFinite(qty) ? qty : 0;
}

function normalizedOptionalInt(value: number | string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isBlankOrStarterLine(line: OrderLineForm | undefined) {
  if (!line) {
    return true;
  }
  const hasSource = Boolean(line.sourceOrderNo || line.sourceLineNo);
  const hasText = [line.productName, line.spec, line.lineRemark].some((value) => String(value ?? "").trim());
  const isStarter = !hasSource && String(line.productCode ?? "") === "CP-001" && String(line.warehouseCode ?? "") === "CK-001";
  const isBlank = !hasSource && !String(line.productCode ?? "").trim() && !String(line.warehouseCode ?? "").trim() && !hasText && normalizedQty(line.qty) === 0 && normalizedQty(line.unitPrice) === 0;
  return isStarter || isBlank;
}

async function loadByBillNo(billNo: string) {
  await document.loadByBillNo(billNo);
}

function startNew() {
  document.startNew();
}

function applyPushDownDraft(draft: {
  billNo: string;
  sourceOrderNo: string;
  partyCode: string;
  billDate: string;
  department: string;
  ownerName: string;
  lines: PendingPushLine[];
}) {
  document.applyInboundPushDownDraft(draft);
}

function applyDetail(detail: DocumentDetail, message = "", sourceLineNo: number | null = null) {
  document.applyDetail(detail, message, sourceLineNo);
}

defineExpose({ loadByBillNo, startNew, applyPushDownDraft, applyDetail });
</script>
