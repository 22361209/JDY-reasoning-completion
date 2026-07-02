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
    test-prefix="delivery-notice"
    party-label="客户"
    party-type="customer"
    :is-document-form="true"
    :is-stock-document-form="false"
    :is-draft="document.isDraft.value"
    :can-audit="document.canAudit.value"
    :can-reverse="document.canReverse.value"
    :can-red-reverse="false"
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
    source-select-test-id="delivery-notice-open-source-selector"
    :show-push-down="showPushDownSalesOut"
    :can-push-down="canPushDownSalesOut"
    push-down-label="下推销售出库"
    push-down-test-id="push-sales-out-from-delivery-notice"
    :can-trace-source-order="document.canTraceSourceOrder.value"
    :show-source-line-column="document.showSourceLineColumn.value"
    :show-party-code-column="false"
    :show-customer-material-code-column="true"
    :show-customer-order-no-column="true"
    :show-execution-columns="document.showExecutionColumns.value"
    :show-plan-delivery-date-column="document.showPlanDeliveryDateColumn.value"
    :show-stock-columns="document.showStockColumns.value"
    :enable-sales-price-bulk="true"
    :entry-table-colspan="document.entryTableColspan.value"
    :entry-total-colspan="document.entryTotalColspan.value"
    :total-amount="document.totalAmount.value"
    :show-tax-mode="document.showTaxMode.value"
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
    :known-product-options="document.knownProductOptions"
    :dragging-line-index="document.draggingLineIndex.value"
    :highlighted-source-bill-no="document.highlightedSourceBillNo.value"
    :highlighted-source-line-no="document.highlightedSourceLineNo.value"
    @create="document.startNew"
    @save="document.save()"
    @audit="document.audit"
    @reverse="document.openRiskyAction('reverse')"
    @void-document="document.openLifecycleAction('void')"
    @close-document="document.openLifecycleAction('close')"
    @unclose-document="document.openLifecycleAction('unclose')"
    @freeze-document="document.openLifecycleAction('freeze')"
    @unfreeze-document="document.openLifecycleAction('unfreeze')"
    @source-select="openSourceSelector"
    @push-down="emit('pushDownSalesOut', { billNo: document.form.billNo })"
    @delete-document="document.deleteCurrent"
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
    @search-master-selector-dialog="document.searchMasterSelectorDialog"
    @select-master-selector-dialog-row="document.selectMasterSelectorDialogRow"
    @select-party-option="document.selectPartyOption($event, 'delivery-notice-party')"
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
    @refresh-stock="document.refreshStock"
  />
  <SourceSelectorDialog
    :open="sourceSelectorOpen"
    test-prefix="delivery-notice"
    title="选择销售订单"
    :description="`${document.form.partyCode || '未限定客户'} ${document.form.partyName || ''} 已审核且有剩余可通知数量的销售订单明细。`"
    v-model:keyword="sourceSelectorKeyword"
    search-placeholder="客户/商品/订单号"
    :loading="sourceSelectorLoading"
    :rows="filteredSourceSelectorLines"
    :columns="sourceSelectorColumns"
    :selected="sourceSelectorSelected"
    :count-label="selectedSourceLineCount"
    :summary-items="sourceSelectorSummaryItems"
    :message="sourceSelectorMessage"
    :row-key="sourceSelectorRowKey"
    :format-cell="formatSourceSelectorCell"
    @query-change="reloadSourceSelector"
    @select-all="selectAllVisibleSourceLines"
    @toggle="toggleSourceSelectorRow"
    @close="closeSourceSelector"
    @confirm="confirmSourceSelector"
  />
  <DocumentDialogs v-bind="dialogBindings" v-on="dialogHandlers" />
</template>

<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import DocumentDialogs from "../../../components/DocumentDialogs.vue";
import DocumentForm from "../../../components/DocumentForm.vue";
import SourceSelectorDialog, { type SourceSelectorColumn, type SourceSelectorQueryChange, type SourceSelectorSummaryItem } from "../../../components/SourceSelectorDialog.vue";
import type { DocumentDetail, OpenableDocumentType } from "../../../services/documentApi";
import type { OrderLineForm, PendingPushLine } from "../../../app/documentModel";
import { fetchSelectableSalesOrderLines, type SelectableSalesOrderLine } from "../../../services/salesOrderApi";
import { useDeliveryNoticeDocument } from "./useDeliveryNoticeDocument";

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
  pushDownSalesOut: [row: Record<string, unknown>];
  requestOpenDocument: [payload: { type: OpenableDocumentType; billNo: string; sourceLineNo?: number | null }];
}>();

const document = useDeliveryNoticeDocument({
  userName: () => props.userName,
  hasPermission: props.hasPermission,
  markDirty: () => emit("markDirty"),
  clearDirty: () => emit("clearDirty"),
  requestOpenDocument: (payload) => emit("requestOpenDocument", payload)
});

const showPushDownSalesOut = computed(() => document.form.status === "AUDITED" && document.form.lines.some((line) => Number(line.remainingQty ?? line.qty ?? 0) > 0));
const canPushDownSalesOut = computed(() => showPushDownSalesOut.value && props.hasPermission("sales.out.audit"));
const sourceSelectorOpen = ref(false);
const sourceSelectorLoading = ref(false);
const sourceSelectorMessage = ref("");
const sourceSelectorKeyword = ref("");
const sourceSelectorLines = ref<SelectableSalesOrderLine[]>([]);
const sourceSelectorSelected = reactive<Record<string, boolean>>({});
const sourceSelectorSelectedRows = reactive<Record<string, SelectableSalesOrderLine>>({});
const sourceSelectorColumns: SourceSelectorColumn[] = [
  { key: "selection", title: "选", width: 42, visible: true, configurable: false },
  { key: "billNo", title: "销售订单", width: 150, visible: true },
  { key: "lineNo", title: "行号", width: 70, visible: true },
  { key: "customer", title: "客户", width: 180, visible: true },
  { key: "billDate", title: "日期", width: 120, visible: true },
  { key: "productCode", title: "物料编码", width: 130, visible: true },
  { key: "productName", title: "物料名称", width: 180, visible: true },
  { key: "unit", title: "单位", width: 80, visible: true },
  { key: "netWeight", title: "净重", width: 90, visible: true, align: "right" },
  { key: "grossWeight", title: "毛重", width: 90, visible: true, align: "right" },
  { key: "remainingQty", title: "剩余可通知", width: 110, visible: true, align: "right" },
  { key: "unitPrice", title: "单价", width: 100, visible: true, align: "right" },
  { key: "planDeliveryDate", title: "预计交期", width: 120, visible: true },
  { key: "lineRemark", title: "行备注", width: 160, visible: true }
];
const selectedSourceLineCount = computed(() => `${Object.keys(sourceSelectorSelectedRows).length} 行已选`);
const sourceSelectorSummaryItems = computed<SourceSelectorSummaryItem[]>(() => {
  const visibleLines = filteredSourceSelectorLines.value;
  const selectedLines = Object.values(sourceSelectorSelectedRows);
  return [
    { key: "visibleRows", label: "当前明细", value: `${visibleLines.length} 行`, strong: true },
    { key: "selectedRows", label: "已选", value: `${selectedLines.length} 行`, strong: true },
    { key: "remainingQty", label: "剩余可通知合计", value: document.formatQty(sumLines(visibleLines, "remainingQty")) },
    { key: "selectedQty", label: "已选数量", value: document.formatQty(sumLines(selectedLines, "remainingQty")) }
  ];
});
const filteredSourceSelectorLines = computed(() => {
  const keyword = sourceSelectorKeyword.value.trim().toLowerCase();
  if (!keyword) {
    return sourceSelectorLines.value;
  }
  return sourceSelectorLines.value.filter((line) => sourceLineSearchText(line).includes(keyword));
});

const dialogBindings = computed(() => ({
  pendingZeroEntrySave: document.pendingZeroEntrySave.value,
  zeroReasonOptions: document.zeroReasonOptions,
  downstreamTrace: document.downstreamTrace.value,
  pendingRiskyDocumentAction: document.pendingRiskyDocumentAction.value,
  pendingLifecycleAction: document.pendingLifecycleAction.value,
  pendingLifecycleLineNo: document.pendingLifecycleLineNo.value,
  pendingDeleteDocument: document.pendingDeleteDocument.value,
  deleteDocumentTitle: "发货通知单",
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
  isEntryPasteCandidateActive: document.isEntryPasteCandidateActive
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
  sourceSelectorMessage.value = "";
  sourceSelectorKeyword.value = "";
  resetSourceSelection();
  const customerCode = document.form.partyCode.trim();
  if (!customerCode) {
    sourceSelectorLines.value = [];
    sourceSelectorLoading.value = false;
    document.message.value = "请先在单头选择客户，再从该客户的已审核销售订单中选源单。";
    return;
  }
  sourceSelectorOpen.value = true;
  sourceSelectorLoading.value = true;
  const result = await fetchSelectableSalesOrderLines(customerCode);
  sourceSelectorLoading.value = false;
  if (!result.ok) {
    sourceSelectorLines.value = [];
    sourceSelectorMessage.value = result.message || "销售订单选单列表加载失败。";
    return;
  }
  sourceSelectorLines.value = result.data;
  if (result.data.length === 0) {
    sourceSelectorMessage.value = "该客户暂无已审核且有剩余可通知数量的销售订单。";
  }
}

function closeSourceSelector() {
  sourceSelectorOpen.value = false;
  sourceSelectorMessage.value = "";
}

function toggleSourceSelectorLine(line: SelectableSalesOrderLine, checked: boolean) {
  const key = sourceSelectorLineKey(line);
  if (checked) {
    sourceSelectorSelected[key] = true;
    sourceSelectorSelectedRows[key] = line;
    return;
  }
  delete sourceSelectorSelected[key];
  delete sourceSelectorSelectedRows[key];
}

function toggleSourceSelectorRow(row: unknown, checked: boolean) {
  toggleSourceSelectorLine(row as SelectableSalesOrderLine, checked);
}

async function reloadSourceSelector(query: SourceSelectorQueryChange) {
  sourceSelectorKeyword.value = query.keyword;
  if (!document.form.partyCode) {
    return;
  }
  sourceSelectorLoading.value = true;
  const result = await fetchSelectableSalesOrderLines(document.form.partyCode, query);
  sourceSelectorLoading.value = false;
  if (!result.ok) {
    sourceSelectorLines.value = [];
    sourceSelectorMessage.value = result.message || "销售订单选单列表加载失败。";
    return;
  }
  sourceSelectorLines.value = result.data;
  sourceSelectorMessage.value = result.data.length ? "" : "当前过滤条件下暂无可选销售订单明细。";
}

function selectAllVisibleSourceLines(checked: boolean, rows: unknown[]) {
  if (!checked) {
    resetSourceSelection();
    return;
  }
  rows.forEach((row) => {
    const line = row as SelectableSalesOrderLine;
    toggleSourceSelectorLine(line, true);
  });
}

function confirmSourceSelector() {
  const selectedLines = Object.values(sourceSelectorSelectedRows);
  if (selectedLines.length === 0) {
    sourceSelectorMessage.value = "请至少勾选一条销售订单明细。";
    return;
  }
  const first = selectedLines[0];
  if (!first) {
    return;
  }
  document.form.sourceOrderNo = "";
  document.form.partyCode = first.customerCode;
  document.form.partyName = first.customer || document.form.partyName || "";
  document.form.department = first.department || document.form.department || "销售部";
  document.form.isTaxInclusive = Boolean(first.isTaxInclusive);
  appendSourceLines(selectedLines.map(selectableLineToFormLine));
  sourceSelectorOpen.value = false;
  sourceSelectorMessage.value = "";
  document.message.value = `已追加 ${selectedLines.length} 行销售订单剩余可通知明细`;
  document.markDirty();
}

function appendSourceLines(lines: OrderLineForm[]) {
  const currentLines = document.form.lines;
  const shouldReplaceStarter = currentLines.length === 1 && isBlankOrStarterLine(currentLines[0]);
  document.form.lines = shouldReplaceStarter ? lines : [...currentLines, ...lines];
}

function selectableLineToFormLine(line: SelectableSalesOrderLine): OrderLineForm {
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
	    customerMaterialCode: String(line.customerMaterialCode ?? ""),
	    customerOrderNo: String(line.customerOrderNo ?? ""),
	    lineRemark: String(line.lineRemark ?? ""),
    planDeliveryDate: String(line.planDeliveryDate ?? "")
  };
}

function sourceSelectorLineKey(line: SelectableSalesOrderLine) {
  return `${line.billNo}:${line.lineNo}`;
}

function sourceSelectorRowKey(row: unknown) {
  return sourceSelectorLineKey(row as SelectableSalesOrderLine);
}

function formatSourceSelectorCell(row: unknown, columnKey: string) {
  const line = row as SelectableSalesOrderLine;
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
    remainingQty: document.formatQty(line.remainingQty),
    unitPrice: document.formatAmount(line.unitPrice),
    planDeliveryDate: String(line.planDeliveryDate || "-"),
    lineRemark: String(line.lineRemark || "")
  };
  return values[columnKey] ?? "";
}

function sourceLineSearchText(line: SelectableSalesOrderLine) {
  return [line.customerCode, line.customer, line.productCode, line.productName, line.spec, line.unit, line.billNo, line.lineRemark].filter(Boolean).join(" ").toLowerCase();
}

function formatOptionalAmount(value: unknown) {
  return value === null || value === undefined || value === "" ? "-" : document.formatAmount(value as number | string | undefined);
}

function sumLines(lines: SelectableSalesOrderLine[], field: keyof SelectableSalesOrderLine) {
  return lines.reduce((sum, line) => {
    const value = Number(line[field] ?? 0);
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
}

function resetSourceSelection() {
  Object.keys(sourceSelectorSelected).forEach((key) => {
    delete sourceSelectorSelected[key];
  });
  Object.keys(sourceSelectorSelectedRows).forEach((key) => {
    delete sourceSelectorSelectedRows[key];
  });
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

function loadByBillNo(billNo: string) {
  return document.loadByBillNo(billNo);
}

function startNew() {
  document.startNew();
}

function applyPushDownDraft(draft: {
  billNo: string;
  sourceOrderNo: string;
  partyCode: string;
  partyName?: string;
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
