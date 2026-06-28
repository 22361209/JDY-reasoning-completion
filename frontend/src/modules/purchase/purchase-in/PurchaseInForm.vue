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
  <div v-if="sourceSelectorOpen" class="modal-mask" data-testid="purchase-in-source-selector-dialog">
    <div class="dialog source-selector-dialog">
      <h3>选择采购订单</h3>
      <p>{{ document.form.partyCode || '未限定供应商' }} {{ document.form.partyName || '' }} 已审核且有剩余可入数量的采购订单明细。</p>
      <div class="source-selector-toolbar">
        <input
          v-model="sourceSelectorKeyword"
          data-testid="purchase-in-source-selector-search"
          placeholder="供应商/商品/订单号"
        />
        <button type="button" data-testid="purchase-in-source-selector-select-all" @click="selectAllVisibleSourceLines">全选</button>
        <button type="button" data-testid="purchase-in-source-selector-column-settings" @click="sourceColumnDialogOpen = true">列设置</button>
        <strong data-testid="purchase-in-source-selector-count">{{ selectedSourceLineCount }}</strong>
      </div>
      <div class="source-selector-table">
        <table>
          <thead>
            <tr>
              <th v-for="column in visibleSourceColumns" :key="column.key" :style="{ width: `${column.width}px` }">{{ column.title }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="sourceSelectorLoading">
              <td :colspan="visibleSourceColumns.length">加载中...</td>
            </tr>
            <tr v-else-if="filteredSourceSelectorLines.length === 0">
              <td :colspan="visibleSourceColumns.length">暂无可选明细</td>
            </tr>
            <template v-else>
              <tr v-for="line in filteredSourceSelectorLines" :key="sourceSelectorLineKey(line)">
                <td v-if="isSourceColumnVisible('selection')">
                  <input
                    type="checkbox"
                    :checked="Boolean(sourceSelectorSelected[sourceSelectorLineKey(line)])"
                    :data-testid="`purchase-in-source-line-${sourceSelectorLineKey(line)}`"
                    @change="toggleSourceSelectorLine(line, ($event.target as HTMLInputElement).checked)"
                  />
                </td>
                <td v-if="isSourceColumnVisible('billNo')">{{ line.billNo }}</td>
                <td v-if="isSourceColumnVisible('lineNo')">#{{ line.lineNo }}</td>
                <td v-if="isSourceColumnVisible('supplier')">{{ line.supplierCode }} {{ line.supplier || '' }}</td>
                <td v-if="isSourceColumnVisible('billDate')">{{ line.billDate }}</td>
                <td v-if="isSourceColumnVisible('planDeliveryDate')">{{ line.planDeliveryDate || '-' }}</td>
                <td v-if="isSourceColumnVisible('productCode')">{{ line.productCode }}</td>
                <td v-if="isSourceColumnVisible('supplierMaterialCode')">{{ line.supplierMaterialCode || '-' }}</td>
                <td v-if="isSourceColumnVisible('productName')">{{ line.productName || line.spec || '-' }}</td>
                <td v-if="isSourceColumnVisible('warehouseCode')">{{ line.warehouseCode }}</td>
                <td v-if="isSourceColumnVisible('sourceQty')">{{ formatQty(line.sourceQty) }}</td>
                <td v-if="isSourceColumnVisible('receivedQty')">{{ formatQty(line.receivedQty) }}</td>
                <td v-if="isSourceColumnVisible('remainingQty')">{{ formatQty(line.remainingQty) }}</td>
                <td v-if="isSourceColumnVisible('unitPrice')">{{ formatAmount(line.unitPrice) }}</td>
                <td v-if="isSourceColumnVisible('priceTaxTotal')">{{ formatAmount(line.priceTaxTotal) }}</td>
                <td v-if="isSourceColumnVisible('lineRemark')">{{ line.lineRemark || '' }}</td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <p v-if="sourceSelectorMessage" class="form-error" data-testid="purchase-in-source-selector-message">{{ sourceSelectorMessage }}</p>
      <div class="dialog-actions">
        <button type="button" data-testid="purchase-in-source-selector-cancel" @click="closeSourceSelector">取消</button>
        <button class="primary-action" type="button" data-testid="purchase-in-source-selector-ok" @click="confirmSourceSelector">确定</button>
      </div>
    </div>
  </div>

  <ColumnSettingsDialog
    :open="sourceColumnDialogOpen"
    title="列设置"
    :columns="sourceSelectorColumns"
    dialog-test-id="purchase-in-source-selector-column-settings-dialog"
    ok-test-id="purchase-in-source-selector-column-settings-ok"
    @reset="resetSourceColumns"
    @confirm="sourceColumnDialogOpen = false"
  />
  <DocumentDialogs v-bind="dialogBindings" v-on="dialogHandlers" />
</template>

<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import ColumnSettingsDialog from "../../../components/table/ColumnSettingsDialog.vue";
import DocumentDialogs from "../../../components/DocumentDialogs.vue";
import DocumentForm from "../../../components/DocumentForm.vue";
import type { DocumentDetail, OpenableDocumentType } from "../../../services/documentApi";
import type { OrderLineForm, PendingPushLine } from "../../../app/documentModel";
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

const sourceSelectorOpen = ref(false);
const sourceSelectorLoading = ref(false);
const sourceSelectorMessage = ref("");
const sourceSelectorKeyword = ref("");
const sourceColumnDialogOpen = ref(false);
const sourceSelectorLines = ref<SelectablePurchaseOrderLine[]>([]);
const sourceSelectorSelected = reactive<Record<string, boolean>>({});
const sourceSelectorColumns = ref([
  { key: "selection", title: "选", width: 42, visible: true, configurable: false },
  { key: "billNo", title: "采购订单", width: 150, visible: true },
  { key: "lineNo", title: "行号", width: 70, visible: true },
  { key: "supplier", title: "供应商名称", width: 190, visible: true },
  { key: "billDate", title: "单据日期", width: 120, visible: true },
  { key: "planDeliveryDate", title: "预计交期", width: 120, visible: true },
  { key: "productCode", title: "物料编码", width: 130, visible: true },
  { key: "supplierMaterialCode", title: "供应商物料编码", width: 150, visible: true },
  { key: "productName", title: "物料名称", width: 180, visible: true },
  { key: "warehouseCode", title: "仓库", width: 110, visible: true },
  { key: "sourceQty", title: "订单数量", width: 100, visible: true },
  { key: "receivedQty", title: "已入库", width: 100, visible: true },
  { key: "remainingQty", title: "剩余可入", width: 110, visible: true },
  { key: "unitPrice", title: "单价", width: 100, visible: true },
  { key: "priceTaxTotal", title: "含税金额", width: 110, visible: true },
  { key: "lineRemark", title: "行备注", width: 160, visible: false }
]);
const visibleSourceColumns = computed(() => sourceSelectorColumns.value.filter((column) => column.visible));
const selectedSourceLineCount = computed(() => `${Object.values(sourceSelectorSelected).filter(Boolean).length} 行已选`);
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
  sourceSelectorOpen.value = true;
  sourceSelectorMessage.value = "";
  sourceSelectorKeyword.value = "";
  resetSourceSelection();
  const supplierCode = document.form.partyCode.trim();
  if (!supplierCode) {
    sourceSelectorLines.value = [];
    sourceSelectorLoading.value = false;
    sourceSelectorMessage.value = "请先在单头选择供应商，再从该供应商的已审核采购订单中选源单。";
    return;
  }
  sourceSelectorLoading.value = true;
  const result = await fetchSelectablePurchaseOrderLines(supplierCode);
  sourceSelectorLoading.value = false;
  if (!result.ok) {
    sourceSelectorLines.value = [];
    sourceSelectorMessage.value = result.message || "采购订单选单列表加载失败。";
    return;
  }
  sourceSelectorLines.value = result.data;
  if (result.data.length === 0) {
    sourceSelectorMessage.value = "该供应商暂无已审核且有剩余可入数量的采购订单。";
  }
}

function closeSourceSelector() {
  sourceSelectorOpen.value = false;
  sourceSelectorMessage.value = "";
}

function toggleSourceSelectorLine(line: SelectablePurchaseOrderLine, checked: boolean) {
  sourceSelectorSelected[sourceSelectorLineKey(line)] = checked;
}

function selectAllVisibleSourceLines() {
  filteredSourceSelectorLines.value.forEach((line) => {
    sourceSelectorSelected[sourceSelectorLineKey(line)] = true;
  });
}

function confirmSourceSelector() {
  const selectedLines = sourceSelectorLines.value.filter((line) => sourceSelectorSelected[sourceSelectorLineKey(line)]);
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
  sourceSelectorOpen.value = false;
  sourceSelectorMessage.value = "";
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
  return `${line.billNo}:${line.lineNo}`;
}

function sourceLineSearchText(line: SelectablePurchaseOrderLine) {
  return [
    line.supplierCode,
    line.supplier,
    line.productCode,
    line.supplierMaterialCode,
    line.productName,
    line.spec,
    line.billNo
  ].filter(Boolean).join(" ").toLowerCase();
}

function isSourceColumnVisible(key: string) {
  return sourceSelectorColumns.value.some((column) => column.key === key && column.visible);
}

function resetSourceColumns() {
  sourceSelectorColumns.value.forEach((column) => {
    column.visible = true;
  });
}

function resetSourceSelection() {
  Object.keys(sourceSelectorSelected).forEach((key) => {
    delete sourceSelectorSelected[key];
  });
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
