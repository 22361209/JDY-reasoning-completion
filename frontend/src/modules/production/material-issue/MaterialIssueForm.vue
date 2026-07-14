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
    test-prefix="material-issue"
    party-label="来源"
    party-type="customer"
    :show-party-head-fields="false"
    :show-source-order-no-head-field="true"
    :source-order-no-head-readonly="true"
    :show-owner-name-head-field="false"
    bill-date-label="单据日期"
    department-label="领料车间"
    source-order-no-label="选源单"
    entry-section-title="子件信息"
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
    source-select-label="选源单"
    source-select-test-id="material-issue-open-source-selector"
    :show-push-down="true"
    :can-push-down="canPushDownProductIn"
    push-down-label="下推产品入库"
    push-down-test-id="push-product-in-from-material-issue"
    :show-extra-action="canPushDownMaterialScrap"
    :can-extra-action="canPushDownMaterialScrap"
    extra-action-label="材料报废"
    extra-action-test-id="push-material-scrap-from-material-issue"
    :can-trace-source-order="document.canTraceSourceOrder.value"
    :show-source-line-column="document.showSourceLineColumn.value"
    :show-party-code-column="false"
    :show-execution-columns="document.showExecutionColumns.value"
    :show-executed-qty-column="document.showExecutedQtyColumn"
    :execution-qty-label="document.executionQtyLabel"
    :remaining-qty-label="document.remainingQtyLabel"
    :qty-label="document.qtyLabel"
    :show-stock-columns="document.showStockColumns.value"
    :stock-column-mode="document.stockColumnMode"
    :stock-available-label="document.stockAvailableLabel"
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
    @push-down="pushDownProductIn"
    @extra-action="pushDownMaterialScrap"
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
    @select-party-option="document.selectPartyOption($event, 'material-issue-party')"
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
    test-prefix="material-issue"
    title="选择生产任务单"
    description="已审核或已下达，且存在剩余可领子件的生产任务单。"
    v-model:keyword="sourceSelectorKeyword"
    search-placeholder="任务单号/计划单号/产品/车间"
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
    :show-select-all="false"
    @query-change="sourceSelector.load"
    @toggle="sourceSelector.toggleRow"
    @close="closeSourceSelector"
    @confirm="confirmSourceSelector"
    @reset-columns="resetSourceColumns"
  />
  <DocumentDialogs v-bind="dialogBindings" v-on="dialogHandlers" />
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useSourceSelectorLifecycle } from "../../../app/sourceSelectorLifecycle";
import DocumentDialogs from "../../../components/DocumentDialogs.vue";
import DocumentForm from "../../../components/DocumentForm.vue";
import SourceSelectorDialog, { type SourceSelectorColumn } from "../../../components/SourceSelectorDialog.vue";
import type { DocumentDetail, RoutableDocumentType } from "../../../services/documentApi";
import {
  fetchMaterialIssuePreviewFromTask,
  checkMaterialScrapPushEligibility,
  fetchSelectableProductionTasks,
  pushDownMaterialIssueProductIn,
  type MaterialIssuePreview,
  type MaterialIssuePreviewLine,
  type SelectableProductionTaskLine
} from "../../../services/productionApi";
import { useMaterialIssueDocument } from "./useMaterialIssueDocument";

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
  requestOpenDocument: [payload: { type: RoutableDocumentType; billNo: string; sourceLineNo?: number | null }];
  requestPushMaterialScrap: [payload: { issueBillNo: string }];
}>();

const document = useMaterialIssueDocument({
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
  { key: "billDate", title: "单据日期", width: 120, visible: true },
  { key: "department", title: "生产车间", width: 120, visible: true },
  { key: "productCode", title: "产品编码", width: 130, visible: true },
  { key: "productName", title: "产品名称", width: 180, visible: true },
  { key: "spec", title: "规格型号", width: 140, visible: true },
  { key: "unit", title: "单位", width: 80, visible: true },
  { key: "warehouseCode", title: "入库仓库", width: 110, visible: true },
  { key: "bomCode", title: "BOM", width: 120, visible: true },
  { key: "bomVersionNo", title: "BOM 版本", width: 90, visible: true },
  { key: "taskQty", title: "生产任务数量", width: 120, visible: true },
  { key: "completedQty", title: "已完工数量", width: 110, visible: true },
  { key: "remainingProductQty", title: "生产剩余数量", width: 120, visible: true },
  { key: "requiredQty", title: "应领数量", width: 110, visible: true },
  { key: "issuedQty", title: "已领数量", width: 110, visible: true },
  { key: "remainingQty", title: "剩余可领", width: 110, visible: true }
]);
const sourceSelector = useSourceSelectorLifecycle<SelectableProductionTaskLine>({
  rowKey: sourceSelectorRowKey,
  fetchRows: fetchSelectableProductionTasks,
  quantityField: "remainingQty",
  countLabel: (count) => `${count} 张已选`,
  quantityLabel: "剩余可领合计",
  selectedQuantityLabel: "已选可领",
  emptyMessage: "当前过滤条件下暂无可选生产任务单。",
  loadErrorMessage: "生产任务选单列表加载失败。",
  formatQty,
  selectionMode: "single"
});
const sourceSelectorOpen = sourceSelector.open;
const sourceSelectorLoading = sourceSelector.loading;
const sourceSelectorMessage = sourceSelector.message;
const sourceSelectorKeyword = sourceSelector.keyword;
const sourceSelectorRows = sourceSelector.rows;
const sourceSelectorSelected = sourceSelector.selected;
const selectedSourceLineCount = sourceSelector.countLabel;
const sourceSelectorSummaryItems = sourceSelector.summaryItems;

const canPushDownProductIn = computed(() => (
  document.form.status === "AUDITED" &&
  Boolean(document.form.billNo) &&
  props.hasPermission("production.document.audit")
));
const materialScrapPushEligible = ref(false);
const hasMaterialScrapPushHeader = computed(() => (
  document.form.status === "AUDITED" &&
  document.form.closeStatus !== "CLOSED" &&
  document.form.frozenStatus !== "FROZEN" &&
  !document.form.redSourceBillNo &&
  !document.form.redReverseBillNo &&
  Boolean(document.form.billNo) &&
  props.hasPermission("production.document.audit")
));
const canPushDownMaterialScrap = computed(() => (
  hasMaterialScrapPushHeader.value && materialScrapPushEligible.value
));
let materialScrapEligibilityRequest = 0;

watch(
  () => [
    document.form.billNo,
    document.form.status,
    document.form.closeStatus,
    document.form.frozenStatus,
    document.form.redSourceBillNo,
    document.form.redReverseBillNo
  ] as const,
  async () => {
    const currentRequest = materialScrapEligibilityRequest + 1;
    materialScrapEligibilityRequest = currentRequest;
    materialScrapPushEligible.value = false;
    if (!hasMaterialScrapPushHeader.value) {
      return;
    }
    const checkedBillNo = document.form.billNo;
    const result = await checkMaterialScrapPushEligibility(checkedBillNo);
    if (
      currentRequest === materialScrapEligibilityRequest
      && checkedBillNo === document.form.billNo
      && hasMaterialScrapPushHeader.value
    ) {
      materialScrapPushEligible.value = result.ok && result.eligible;
    }
  },
  { immediate: true }
);

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

function noop() {}

async function openSourceSelector() {
  if (!document.isDraft.value) {
    return;
  }
  await sourceSelector.openAndLoad({ keyword: document.form.sourceOrderNo || "", columnFilters: {} });
}

function closeSourceSelector() {
  sourceSelector.close();
}

function resetSourceColumns() {
  sourceSelectorColumns.value = sourceSelectorColumns.value.map((column) => ({ ...column, visible: true }));
}

async function confirmSourceSelector() {
  const source = sourceSelector.selectedRowList.value[0];
  if (!source?.billNo) {
    sourceSelector.setMessage("请先选择一张生产任务单。");
    return;
  }
  const result = await fetchMaterialIssuePreviewFromTask(source.billNo);
  if (!result.ok) {
    sourceSelector.setMessage(result.message || "生产任务领料预览加载失败。");
    return;
  }
  applyMaterialIssuePreview(result.data as MaterialIssuePreview | undefined, source);
  sourceSelector.close();
}

function applyMaterialIssuePreview(preview: MaterialIssuePreview | undefined, source: SelectableProductionTaskLine) {
  const previewDocument = preview?.document ?? {};
  document.form.sourceOrderNo = previewDocument.sourceOrderNo || source.billNo || "";
  document.form.partyCode = "";
  document.form.partyName = "";
  document.form.billDate = previewDocument.billDate || document.form.billDate;
  document.form.department = previewDocument.department || source.department || "生产部";
  document.form.productInfo = preview?.productInfo ? { ...preview.productInfo } : {
    productCode: source.productCode,
    productName: source.productName,
    spec: source.spec,
    unit: source.unit,
    warehouseCode: source.warehouseCode,
    taskQty: source.taskQty,
    remainingQty: source.remainingProductQty,
    bomCode: source.bomCode,
    bomVersionNo: source.bomVersionNo
  };
  const lines = preview?.lines ?? [];
  document.form.lines = lines.length ? lines.map(previewLineToFormLine) : [];
  document.batchWarehouseCode.value = document.form.lines[0]?.warehouseCode || document.batchWarehouseCode.value;
  document.message.value = `已由生产任务单 ${document.form.sourceOrderNo} 回填领料分录`;
  document.markDirty();
}

function previewLineToFormLine(line: MaterialIssuePreviewLine) {
  const sourceLineNo = normalizedOptionalInt(line.sourceLineNo ?? line.lineNo);
  return {
    lineNo: sourceLineNo,
    sourceOrderNo: document.form.sourceOrderNo,
    sourceLineNo,
    productId: String(line.productId ?? ""),
    productCode: String(line.productCode ?? ""),
    productName: String(line.productName ?? ""),
    spec: String(line.spec ?? ""),
    unit: String(line.unit ?? ""),
    netWeight: String(line.netWeight ?? ""),
    grossWeight: String(line.grossWeight ?? ""),
    warehouseCode: String(line.warehouseCode ?? "") || "CK-001",
    qty: numberValue(line.qty ?? line.remainingQty),
    remainingQty: numberValue(line.remainingQty),
    stockOnHand: line.stockOnHand,
    stockReserved: line.stockReserved,
    stockAvailable: line.stockAvailable,
    stockInTransit: line.stockInTransit,
    unitPrice: 0,
    lineRemark: ""
  };
}

async function pushDownProductIn() {
  if (!canPushDownProductIn.value) {
    return;
  }
  const result = await pushDownMaterialIssueProductIn(document.form.billNo);
  if (!result.ok) {
    document.message.value = result.message || "生产领料单下推产品入库失败。";
    return;
  }
  const billNo = String(result.data?.billNo ?? "");
  if (!billNo) {
    document.message.value = "产品入库单已生成，但返回单号为空。";
    return;
  }
  document.message.value = `已下推生成产品入库单草稿 ${billNo}`;
  emit("requestOpenDocument", { type: "productIn", billNo });
}

function pushDownMaterialScrap() {
  if (!canPushDownMaterialScrap.value) {
    return;
  }
  emit("requestPushMaterialScrap", { issueBillNo: document.form.billNo });
}

function sourceSelectorRowKey(row: SelectableProductionTaskLine | unknown) {
  const typed = row as SelectableProductionTaskLine;
  return String(typed.billNo ?? "");
}

function formatSourceSelectorCell(row: unknown, columnKey: string) {
  const value = (row as Record<string, unknown>)[columnKey];
  if (["taskQty", "completedQty", "remainingProductQty", "requiredQty", "issuedQty", "remainingQty"].includes(columnKey)) {
    return formatQty(value);
  }
  return String(value ?? "");
}

function formatQty(value: unknown) {
  const parsed = numberValue(value);
  return Number.isInteger(parsed) ? String(parsed) : parsed.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizedOptionalInt(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
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

function setMessage(message: string) {
  document.message.value = message;
}

defineExpose({ loadByBillNo, startNew, applyDetail, setMessage });
</script>
