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
          <label>追加源订单<input v-model="document.form.sourceOrderNo" data-testid="sales-out-source-order-no" @input="document.markDirty" @change="document.loadSourceOrderNo" @keydown.enter.prevent="document.loadSourceOrderNo" /></label>
          <button type="button" data-testid="sales-out-load-source-order" @click="document.loadSourceOrderNo">从源订单追加明细</button>
          <button type="button" :disabled="!document.canTraceSourceOrder.value" data-testid="trace-source-order" @click="document.traceSourceOrder()">行级源单追溯</button>
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
              <button
                class="master-selector__open"
                type="button"
                data-testid="sales-out-party-open-selector"
                title="整列表选择"
                aria-label="整列表选择"
                @mousedown.prevent
                @click="document.openMasterSelectorDialog('customer', 'sales-out-party', document.form.partyCode)"
              >...</button>
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
        <label class="form-head-field-wide">单据备注<textarea v-model="document.form.remark" data-testid="sales-out-remark" @input="document.markDirty" /></label>
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
        @open-master-selector-dialog="document.openMasterSelectorDialog"
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

  <MasterSelectorDialog
    :open="document.masterSelectorDialogOpen.value"
    :title="document.masterSelectorDialogTitle.value"
    :label="document.masterSelectorDialogLabel.value"
    :keyword="document.masterSelectorDialogKeyword.value"
    :rows="document.masterSelectorDialogRows.value"
    :total="document.masterSelectorDialogTotal.value"
    :loading="document.masterSelectorDialogLoading.value"
    :message="document.masterSelectorDialogMessage.value"
    @close="document.closeMasterSelectorDialog"
    @search="document.searchMasterSelectorDialog"
    @select="document.selectMasterSelectorDialogRow"
  />

  <div v-if="document.sourceSelectorOpen.value" class="modal-mask" data-testid="sales-out-source-selector-dialog">
    <div class="dialog source-selector-dialog">
      <h3>选择销售订单</h3>
      <p>{{ document.form.partyCode }} {{ document.form.partyName || '' }} 已下单且有剩余可出数量的销售订单明细。</p>
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
    :pending-entry-paste="document.pendingEntryPaste.value"
    :current-bill-no="document.form.billNo"
    :current-order-status-label="document.statusLabel.value"
    :red-reverse-bill-no="document.redReverseBillNo.value"
    :risky-action-title="document.riskyActionTitle.value"
    :risky-action-summary="document.riskyActionSummary.value"
    :risky-action-impact="document.riskyActionImpact.value"
    :risky-action-verb="document.riskyActionVerb.value"
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
    @handle-entry-paste-conflict-keydown="document.handleEntryPasteConflictKeydown"
    @select-entry-paste-candidate="document.selectEntryPasteCandidate"
    @cancel-pending-entry-paste="document.cancelPendingEntryPaste"
    @confirm-pending-entry-paste="document.confirmPendingEntryPaste"
  />
</template>

<script setup lang="ts">
import EntryTable from "../../../components/EntryTable.vue";
import StandardDocument from "../../../components/StandardDocument.vue";
import DocumentDialogs from "../../../components/DocumentDialogs.vue";
import MasterSelectorDialog from "../../../components/MasterSelectorDialog.vue";
import ColumnSettingsDialog from "../../../components/table/ColumnSettingsDialog.vue";
import { knownProductOptions, type PendingPushLine } from "../../../app/documentModel";
import type { DocumentDetail, OpenableDocumentType } from "../../../services/documentApi";
import type { SelectableSalesOrderLine } from "../../../services/salesOrderApi";
import { useSalesOutDocument, type SalesOutPushDownDraft } from "./useSalesOutDocument";
import { computed, ref } from "vue";

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
const sourceSelectorKeyword = ref("");
const sourceColumnDialogOpen = ref(false);
const sourceSelectorColumns = ref([
  { key: "selection", title: "选", width: 42, visible: true, configurable: false },
  { key: "billNo", title: "销售订单", width: 150, visible: true },
  { key: "lineNo", title: "行号", width: 70, visible: true },
  { key: "customer", title: "客户", width: 190, visible: true },
  { key: "billDate", title: "日期", width: 120, visible: true },
  { key: "productCode", title: "商品编码", width: 130, visible: true },
  { key: "productName", title: "商品名称", width: 180, visible: true },
  { key: "warehouseCode", title: "仓库", width: 110, visible: true },
  { key: "sourceQty", title: "订单数量", width: 100, visible: true },
  { key: "shippedQty", title: "已出库", width: 100, visible: true },
  { key: "remainingQty", title: "剩余可出", width: 110, visible: true },
  { key: "unitPrice", title: "单价", width: 100, visible: true },
  { key: "planDeliveryDate", title: "交期", width: 120, visible: true }
]);
const visibleSourceColumns = computed(() => sourceSelectorColumns.value.filter((column) => column.visible));
const filteredSourceSelectorLines = computed(() => {
  const keyword = sourceSelectorKeyword.value.trim().toLowerCase();
  if (!keyword) {
    return document.sourceSelectorLines.value;
  }
  return document.sourceSelectorLines.value.filter((line) => sourceLineSearchText(line).includes(keyword));
});

function sourceLineSearchText(line: SelectableSalesOrderLine) {
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

function noop() {
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
