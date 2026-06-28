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
    test-prefix="sales"
    :party-label="partyLabel"
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
    :show-delete="document.showDelete.value"
    :can-delete="document.canDelete.value"
    :show-source-select="showSourceSelect"
    :can-source-select="document.isDraft.value"
    :source-select-label="sourceSelectLabel"
    :source-select-test-id="sourceSelectTestId"
    :show-push-down="showPushDownSalesOut"
    :can-push-down="canPushDownSalesOut"
    :push-down-label="pushDownLabel"
    :push-down-test-id="pushDownTestId"
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
    @red-reverse="document.openRiskyAction('redReverse')"
    @void-document="document.openLifecycleAction('void')"
    @close-document="document.openLifecycleAction('close')"
    @unclose-document="document.openLifecycleAction('unclose')"
    @freeze-document="document.openLifecycleAction('freeze')"
    @unfreeze-document="document.openLifecycleAction('unfreeze')"
    @source-select="openSourceSelector"
    @push-down="emit('pushDownDeliveryNotice', { billNo: document.form.billNo })"
    @delete-document="document.deleteCurrent"
    @export-document="document.exportCurrent"
    @print-document="document.printCurrent"
    @show-existing="emit('showExisting')"
    @override-lock="emit('overrideLock')"
    @open-red-reverse-bill="document.openRedReverseBill"
    @open-red-source-bill="document.openRedSourceBill"
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
    @select-party-option="document.selectPartyOption($event, 'sales-party')"
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
  <div v-if="sourceSelectorOpen" class="modal-mask" data-testid="sales-order-source-selector-dialog">
    <div class="dialog source-selector-dialog">
      <h3>选择销售报价单</h3>
      <p>{{ document.form.partyCode || '未限定客户' }} {{ document.form.partyName || '' }} 已审核、有效且未过期的销售报价明细。</p>
      <div class="source-selector-toolbar">
        <input
          v-model="sourceSelectorKeyword"
          data-testid="sales-order-source-selector-search"
          placeholder="客户/商品/报价单号"
        />
        <button type="button" data-testid="sales-order-source-selector-select-all" @click="selectAllVisibleSourceLines">全选</button>
        <strong data-testid="sales-order-source-selector-count">{{ selectedSourceLineCount }}</strong>
      </div>
      <div class="source-selector-table">
        <table>
          <thead>
            <tr>
              <th>选</th>
              <th>报价单</th>
              <th>行号</th>
              <th>客户</th>
              <th>日期</th>
              <th>有效期</th>
              <th>物料编码</th>
              <th>物料名称</th>
              <th>单位</th>
              <th>净重</th>
              <th>毛重</th>
              <th>报价数量</th>
              <th>单价</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="sourceSelectorLoading">
              <td colspan="13">加载中...</td>
            </tr>
            <tr v-else-if="filteredSourceSelectorLines.length === 0">
              <td colspan="13">暂无可选明细</td>
            </tr>
            <template v-else>
              <tr v-for="line in filteredSourceSelectorLines" :key="sourceSelectorLineKey(line)">
                <td>
                  <input
                    type="checkbox"
                    :checked="Boolean(sourceSelectorSelected[sourceSelectorLineKey(line)])"
                    :data-testid="`sales-order-source-line-${sourceSelectorLineKey(line)}`"
                    @change="toggleSourceSelectorLine(line, ($event.target as HTMLInputElement).checked)"
                  />
                </td>
                <td>{{ line.billNo }}</td>
                <td>#{{ line.lineNo }}</td>
                <td>{{ line.customerCode }} {{ line.customer || '' }}</td>
                <td>{{ line.billDate }}</td>
                <td>{{ line.validUntil || '-' }}</td>
                <td>{{ line.productCode }}</td>
                <td>{{ line.productName || line.spec || '-' }}</td>
                <td>{{ line.unit || '-' }}</td>
                <td>{{ formatOptionalAmount(line.netWeight) }}</td>
                <td>{{ formatOptionalAmount(line.grossWeight) }}</td>
                <td>{{ document.formatQty(line.sourceQty ?? 0) }}</td>
                <td>{{ document.formatAmount(line.unitPrice) }}</td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <p v-if="sourceSelectorMessage" class="form-error" data-testid="sales-order-source-selector-message">{{ sourceSelectorMessage }}</p>
      <div class="dialog-actions">
        <button type="button" data-testid="sales-order-source-selector-cancel" @click="closeSourceSelector">取消</button>
        <button class="primary-action" type="button" data-testid="sales-order-source-selector-ok" @click="confirmSourceSelector">确定</button>
      </div>
    </div>
  </div>
  <DocumentDialogs v-bind="dialogBindings" v-on="dialogHandlers" />
</template>

<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import DocumentDialogs from "../../../components/DocumentDialogs.vue";
import DocumentForm from "../../../components/DocumentForm.vue";
import type { OrderLineForm } from "../../../app/documentModel";
import { getBillDefinition, pushDownAction, sourceSelectAction } from "../../metadata/registry";
import type { DocumentDetail, OpenableDocumentType } from "../../../services/documentApi";
import { fetchSelectableSalesQuoteLines, type SelectableSalesQuoteLine } from "../../../services/salesQuoteApi";
import { useSalesOrderDocument } from "./useSalesOrderDocument";

const billDefinition = getBillDefinition("salesOrder");
const sourceAction = billDefinition ? sourceSelectAction(billDefinition) : null;
const pushAction = billDefinition ? pushDownAction(billDefinition) : null;
const partyLabel = billDefinition?.party?.codeLabel.replace(/编码$/, "") ?? "客户";
const showSourceSelect = billDefinition ? billDefinition.sourcePolicy !== "none" : true;
const sourceSelectLabel = sourceAction?.label ?? "选源单";
const sourceSelectTestId = sourceAction?.testId ?? "sales-order-open-source-selector";
const pushDownLabel = pushAction?.label ?? "下推发货通知";
const pushDownTestId = pushAction?.testId ?? "push-delivery-notice-from-order-detail";

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
  pushDownDeliveryNotice: [row: Record<string, unknown>];
  requestOpenDocument: [payload: { type: OpenableDocumentType; billNo: string; sourceLineNo?: number | null }];
}>();

const document = useSalesOrderDocument({
  userName: () => props.userName,
  hasPermission: props.hasPermission,
  markDirty: () => emit("markDirty"),
  clearDirty: () => emit("clearDirty"),
  requestOpenDocument: (payload) => emit("requestOpenDocument", payload)
});

const showPushDownSalesOut = computed(() => (
  document.form.status === "AUDITED" &&
  document.form.closeStatus !== "CLOSED" &&
  document.form.frozenStatus !== "FROZEN" &&
  document.form.lines.some((line) => Number(line.remainingQty ?? line.qty ?? 0) > 0 && line.lineCloseStatus !== "CLOSED" && line.lineFrozenStatus !== "FROZEN")
));
const canPushDownSalesOut = computed(() => showPushDownSalesOut.value && props.hasPermission("sales.out.audit"));
const sourceSelectorOpen = ref(false);
const sourceSelectorLoading = ref(false);
const sourceSelectorMessage = ref("");
const sourceSelectorKeyword = ref("");
const sourceSelectorLines = ref<SelectableSalesQuoteLine[]>([]);
const sourceSelectorSelected = reactive<Record<string, boolean>>({});
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
  pendingLifecycleLineNo: document.pendingLifecycleLineNo.value,
  pendingDeleteDocument: document.pendingDeleteDocument.value,
  deleteDocumentTitle: "销售订单",
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
  sourceSelectorOpen.value = true;
  sourceSelectorMessage.value = "";
  sourceSelectorKeyword.value = "";
  resetSourceSelection();
  const customerCode = document.form.partyCode.trim();
  if (!customerCode) {
    sourceSelectorLines.value = [];
    sourceSelectorLoading.value = false;
    sourceSelectorMessage.value = "请先在单头选择客户，再从该客户的已审核销售报价单中选源单。";
    return;
  }
  sourceSelectorLoading.value = true;
  const result = await fetchSelectableSalesQuoteLines(customerCode);
  sourceSelectorLoading.value = false;
  if (!result.ok) {
    sourceSelectorLines.value = [];
    sourceSelectorMessage.value = result.message || "销售报价单选单列表加载失败。";
    return;
  }
  sourceSelectorLines.value = result.data;
  if (result.data.length === 0) {
    sourceSelectorMessage.value = "该客户暂无已审核、有效且未过期的销售报价单。";
  }
}

function closeSourceSelector() {
  sourceSelectorOpen.value = false;
  sourceSelectorMessage.value = "";
}

function toggleSourceSelectorLine(line: SelectableSalesQuoteLine, checked: boolean) {
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
    sourceSelectorMessage.value = "请至少勾选一条销售报价明细。";
    return;
  }
  const first = selectedLines[0];
  if (!first) {
    return;
  }
  document.form.partyCode = first.customerCode;
  document.form.partyName = first.customer || document.form.partyName || "";
  document.form.department = first.department || document.form.department || "销售部";
  document.form.isTaxInclusive = Boolean(first.isTaxInclusive);
  appendSourceLines(selectedLines.map(selectableLineToFormLine));
  sourceSelectorOpen.value = false;
  sourceSelectorMessage.value = "";
  document.message.value = `已追加 ${selectedLines.length} 行销售报价明细`;
  document.markDirty();
}

function appendSourceLines(lines: OrderLineForm[]) {
  const currentLines = document.form.lines;
  const shouldReplaceStarter = currentLines.length === 1 && isBlankOrStarterLine(currentLines[0]);
  document.form.lines = shouldReplaceStarter ? lines : [...currentLines, ...lines];
}

function selectableLineToFormLine(line: SelectableSalesQuoteLine): OrderLineForm {
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
    qty: normalizedQty(line.sourceQty),
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

function sourceSelectorLineKey(line: SelectableSalesQuoteLine) {
  return `${line.billNo}:${line.lineNo}`;
}

function sourceLineSearchText(line: SelectableSalesQuoteLine) {
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

function formatOptionalAmount(value: unknown) {
  return value === null || value === undefined || value === "" ? "-" : document.formatAmount(value as number | string | undefined);
}

function resetSourceSelection() {
  Object.keys(sourceSelectorSelected).forEach((key) => {
    delete sourceSelectorSelected[key];
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
