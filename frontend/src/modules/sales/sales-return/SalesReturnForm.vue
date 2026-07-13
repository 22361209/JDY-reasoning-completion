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
    test-prefix="sales-return"
    party-label="客户"
    party-type="customer"
    :party-readonly="true"
    :department-readonly="true"
    :header-draft-only="true"
    :source-locked-lines="true"
    :source-actions-wide="true"
    :is-document-form="true"
    :is-stock-document-form="true"
    :is-draft="document.isDraft.value"
    :can-output="Boolean(document.form.billNo)"
    :can-audit="document.canAudit.value && Boolean(document.form.billNo)"
    :can-reverse="document.canReverse.value"
    :can-red-reverse="false"
    :show-red-reverse="false"
    :can-void="document.canVoid.value && Boolean(document.form.billNo)"
    :show-close="false"
    :show-unclose="false"
    :show-freeze="false"
    :show-unfreeze="false"
    :show-delete="document.showDelete.value"
    :can-delete="document.canDelete.value"
    :show-source-select="true"
    :can-source-select="document.isDraft.value"
    source-select-label="选源单"
    source-select-test-id="sales-return-open-source-selector"
    :can-trace-source-order="document.canTraceSourceOrder.value"
    :show-source-line-column="document.showSourceLineColumn.value"
    :show-party-code-column="false"
    :show-execution-columns="false"
    :show-line-close-status="false"
    :entry-table-colspan="document.entryTableColspan.value"
    :entry-total-colspan="document.entryTotalColspan.value"
    :total-amount="document.totalAmount.value"
    :show-tax-columns="true"
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
    @void-document="document.openLifecycleAction('void')"
    @source-select="openSourceSelector"
    @delete-document="document.deleteCurrent"
    @export-document="document.exportCurrent"
    @print-document="document.printCurrent"
    @show-existing="emit('showExisting')"
    @override-lock="emit('overrideLock')"
    @mark-dirty="document.markDirty"
    @trace-source-order="document.traceSourceOrder"
    @remove-line="removeSourceLine"
  >
    <template #sourceActions>
      <label class="currency-field">
        <span>币种（来源继承）</span>
        <select :value="document.form.currency || ''" disabled data-testid="sales-return-currency">
          <option value="">选源后继承</option>
          <option value="CNY">人民币 / CNY</option>
          <option value="USD">美元 / USD</option>
        </select>
      </label>
      <label class="currency-field">
        <span>冲应收金额</span>
        <input :value="formatAmount(document.form.receivableOffsetAmount)" disabled data-testid="sales-return-receivable-offset" />
      </label>
      <label class="currency-field">
        <span>待退款金额</span>
        <input :value="formatAmount(document.form.pendingRefundAmount)" disabled data-testid="sales-return-pending-refund" />
      </label>
    </template>
  </DocumentForm>

  <SourceSelectorDialog
    :open="sourceSelectorOpen"
    test-prefix="sales-return"
    title="选择销售出库单"
    description="选择同一客户、同一币种且仍有正式剩余可退数量的已审核销售出库明细。"
    v-model:keyword="sourceSelectorKeyword"
    search-placeholder="客户/物料/销售出库单号"
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
    @close="sourceSelector.close"
    @confirm="confirmSourceSelector"
    @reset-columns="resetSourceColumns"
  />

  <DocumentDialogs v-bind="dialogBindings" v-on="dialogHandlers" />
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { OrderLineForm } from "../../../app/documentModel";
import { useSourceSelectorLifecycle } from "../../../app/sourceSelectorLifecycle";
import DocumentDialogs from "../../../components/DocumentDialogs.vue";
import DocumentForm from "../../../components/DocumentForm.vue";
import SourceSelectorDialog, { type SourceSelectorColumn } from "../../../components/SourceSelectorDialog.vue";
import type { DocumentDetail, OpenableDocumentType } from "../../../services/documentApi";
import { fetchSelectableSalesOutLines, type SelectableSalesOutLine } from "../../../services/salesReturnApi";
import { useSalesReturnDocument } from "./useSalesReturnDocument";

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

const document = useSalesReturnDocument({
  userName: () => props.userName,
  hasPermission: props.hasPermission,
  markDirty: () => emit("markDirty"),
  clearDirty: () => emit("clearDirty"),
  requestOpenDocument: (payload) => emit("requestOpenDocument", payload)
});

const sourceSelectorColumns = ref<SourceSelectorColumn[]>([
  { key: "selection", title: "选", width: 42, visible: true, configurable: false },
  { key: "billNo", title: "销售出库单", width: 150, visible: true },
  { key: "lineNo", title: "源行", width: 70, visible: true },
  { key: "customer", title: "客户", width: 190, visible: true },
  { key: "billDate", title: "日期", width: 120, visible: true },
  { key: "currency", title: "币种", width: 80, visible: true },
  { key: "productCode", title: "物料编码", width: 130, visible: true },
  { key: "productName", title: "物料名称", width: 180, visible: true },
  { key: "warehouseCode", title: "原出库仓", width: 110, visible: true },
  { key: "sourceQty", title: "出库数量", width: 100, visible: true, align: "right" },
  { key: "returnedQty", title: "已退数量", width: 100, visible: true, align: "right" },
  { key: "remainingQty", title: "剩余可退", width: 110, visible: true, align: "right" },
  { key: "unitPrice", title: "单价", width: 100, visible: true, align: "right" },
  { key: "lineRemark", title: "行备注", width: 160, visible: true }
]);

const sourceSelector = useSourceSelectorLifecycle<SelectableSalesOutLine>({
  rowKey: sourceSelectorLineKey,
  fetchRows: fetchSelectableSalesOutLines,
  quantityField: "remainingQty",
  quantityLabel: "正式剩余可退合计",
  selectedQuantityLabel: "已选数量",
  emptyMessage: "当前过滤条件下暂无可选销售出库明细。",
  loadErrorMessage: "销售出库选单列表加载失败。",
  formatQty: document.formatQty,
  allocatedQty: allocatedSourceQty
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
  if (!document.isDraft.value) {
    return;
  }
  await sourceSelector.openAndLoad({ keyword: "", columnFilters: {} });
}

function confirmSourceSelector() {
  const selectedLines = sourceSelector.selectedRowList.value;
  if (selectedLines.length === 0) {
    sourceSelectorMessage.value = "请至少勾选一条销售出库明细。";
    return;
  }
  const customerCodes = new Set(selectedLines.map((line) => String(line.customerCode ?? "").trim()).filter(Boolean));
  if (customerCodes.size !== 1 || selectedLines.some((line) => !String(line.customerCode ?? "").trim())) {
    sourceSelectorMessage.value = "一张销售退货单只能选择同一客户的销售出库单。";
    return;
  }
  const currencies = new Set(selectedLines.map(sourceCurrency).filter((currency): currency is "CNY" | "USD" => Boolean(currency)));
  if (currencies.size !== 1 || selectedLines.some((line) => !sourceCurrency(line))) {
    sourceSelectorMessage.value = "销售退货来源币种必须唯一且只能是 CNY 或 USD。";
    return;
  }
  const customerCode = [...customerCodes][0] ?? "";
  const currency = [...currencies][0];
  if ((document.form.partyCode && document.form.partyCode !== customerCode)
    || (document.form.currency && document.form.currency !== currency)) {
    sourceSelectorMessage.value = "新增来源必须与当前销售退货单保持同一客户、同一币种。";
    return;
  }
  const first = selectedLines[0];
  if (!first || !currency) {
    return;
  }
  document.form.partyCode = customerCode;
  document.form.partyName = String(first.customer ?? "");
  document.form.currency = currency;
  mergeSourceLines(selectedLines.map(selectableLineToFormLine));
  sourceSelector.commitLocalAllocation();
  sourceSelector.close();
  document.message.value = `已追加 ${selectedLines.length} 行销售出库剩余可退明细`;
  document.markDirty();
}

function mergeSourceLines(lines: OrderLineForm[]) {
  const merged = [...document.form.lines];
  lines.forEach((line) => {
    const index = merged.findIndex((current) => sourceLineKey(current.sourceOrderNo, current.sourceLineNo) === sourceLineKey(line.sourceOrderNo, line.sourceLineNo));
    if (index < 0) {
      merged.push(line);
      return;
    }
    const current = merged[index];
    if (current) {
      current.qty = normalizedQty(current.qty) + normalizedQty(line.qty);
    }
  });
  document.form.lines = merged;
}

function selectableLineToFormLine(line: SelectableSalesOutLine): OrderLineForm {
  return {
    productId: String(line.productId ?? ""),
    productCode: String(line.productCode ?? ""),
    productName: String(line.productName ?? ""),
    spec: String(line.spec ?? ""),
    unit: String(line.unit ?? ""),
    netWeight: line.netWeight ?? "",
    grossWeight: line.grossWeight ?? "",
    warehouseCode: String(line.warehouseCode ?? ""),
    sourceOrderNo: String(line.billNo ?? ""),
    sourceLineNo: normalizedOptionalInt(line.lineNo),
    qty: normalizedQty(line.remainingQty),
    unitPrice: normalizedQty(line.unitPrice),
    amount: line.amount,
    taxInclusiveUnitPrice: line.taxInclusiveUnitPrice,
    taxRate: normalizedQty(line.taxRate ?? 13),
    taxAmount: line.taxAmount,
    priceTaxTotal: line.priceTaxTotal,
    lineRemark: String(line.lineRemark ?? "")
  };
}

function allocatedSourceQty(source: SelectableSalesOutLine) {
  const key = sourceSelectorLineKey(source);
  return document.form.lines.reduce((sum, line) => (
    sourceLineKey(line.sourceOrderNo, line.sourceLineNo) === key ? sum + normalizedQty(line.qty) : sum
  ), 0);
}

function removeSourceLine(lineIndex: number) {
  document.removeLine(lineIndex);
  if (document.form.lines.length === 0) {
    document.form.partyCode = "";
    document.form.partyName = "";
    document.form.currency = undefined;
    document.form.department = "销售部";
  }
}

function sourceSelectorLineKey(line: SelectableSalesOutLine) {
  return sourceLineKey(line.billNo, line.lineNo);
}

function sourceSelectorRowKey(row: unknown) {
  return sourceSelectorLineKey(row as SelectableSalesOutLine);
}

function sourceLineKey(billNo: unknown, lineNo: unknown) {
  return `${String(billNo ?? "").trim()}:${String(lineNo ?? "").trim()}`;
}

function sourceCurrency(line: SelectableSalesOutLine) {
  const value = String(line.currency ?? "").trim().toUpperCase();
  return value === "CNY" || value === "USD" ? value : undefined;
}

function formatSourceSelectorCell(row: unknown, columnKey: string) {
  const line = row as SelectableSalesOutLine;
  const values: Record<string, string | number> = {
    billNo: String(line.billNo ?? ""),
    lineNo: `#${line.lineNo ?? ""}`,
    customer: `${line.customerCode ?? ""} ${line.customer || ""}`.trim(),
    billDate: String(line.billDate ?? ""),
    currency: String(line.currency ?? ""),
    productCode: String(line.productCode ?? ""),
    productName: String(line.productName || line.spec || "-"),
    warehouseCode: String(line.warehouseCode ?? ""),
    sourceQty: document.formatQty(line.sourceQty),
    returnedQty: document.formatQty(line.returnedQty),
    remainingQty: document.formatQty(line.remainingQty),
    unitPrice: document.formatAmount(line.unitPrice),
    lineRemark: String(line.lineRemark || "")
  };
  return values[columnKey] ?? "";
}

function resetSourceColumns() {
  sourceSelectorColumns.value.forEach((column) => { column.visible = true; });
}

function normalizedQty(value: number | string | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizedOptionalInt(value: number | string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function formatAmount(value: number | string | undefined) {
  return document.formatAmount(value ?? 0);
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
