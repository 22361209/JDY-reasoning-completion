<template>
  <StandardDocument
    :title="title"
    :subtitle="subtitle"
    :status-label="document.statusLabel.value"
    :status-class="statusClass"
    :locked="locked"
    :lock-message="lockMessage"
    :can-override-lock="canOverrideLock"
    :dirty="dirty"
    :message="document.message.value"
    :can-save="document.canSave.value"
    :can-audit="document.canAudit.value"
    :can-reverse="document.canReverse.value"
    :can-red-reverse="false"
    :can-void="document.canVoid.value"
    :can-delete="document.canDelete.value"
    :can-output="false"
    :show-red-reverse="false"
    :show-close="false"
    :show-unclose="false"
    :show-freeze="false"
    :show-unfreeze="false"
    :show-export="false"
    :show-print="false"
    :show-source-select="true"
    :can-source-select="document.canSourceSelect.value"
    source-select-label="选源单"
    source-select-test-id="material-scrap-open-source-selector"
    :show-extra-action="document.showStockAction.value"
    :can-extra-action="document.canStockAction.value"
    :extra-action-label="document.stockActionLabel.value"
    extra-action-test-id="material-scrap-stock-action"
    @create="requestStartNew"
    @save="document.save"
    @audit="document.audit"
    @reverse="document.requestAction('reverse')"
    @void-document="document.requestAction('void')"
    @source-select="openSourceSelector"
    @extra-action="document.requestStockAction"
    @delete-document="document.requestAction('delete')"
    @override-lock="emit('overrideLock')"
  >
    <section class="material-scrap-form" data-testid="material-scrap-form">
      <div class="material-scrap-head-card">
        <div class="material-scrap-head-grid">
          <label>
            报废单号
            <input
              :value="document.state.document.billNo"
              readonly
              data-testid="material-scrap-bill-no"
              placeholder="首次保存时生成"
            />
          </label>
          <label>
            单据日期
            <input
              v-model="document.state.document.billDate"
              type="date"
              :disabled="!document.editable.value"
              data-testid="material-scrap-bill-date"
              @input="document.markDirty"
            />
          </label>
          <label>
            业务类型
            <select
              v-model="document.state.document.businessType"
              :disabled="!document.editable.value"
              data-testid="material-scrap-business-type"
              @change="document.markDirty"
            >
              <option value="PRODUCTION_SCRAP">生产材料报废</option>
            </select>
          </label>
          <label>
            来源生产领料单
            <input :value="document.state.document.sourceIssueNo" readonly data-testid="material-scrap-source-issue-no" />
          </label>
          <label>
            车间编码
            <input :value="document.state.document.workshopCode" readonly data-testid="material-scrap-workshop-code" />
          </label>
          <label>
            生产车间
            <input :value="document.state.document.workshopName" readonly data-testid="material-scrap-workshop-name" />
          </label>
          <label>
            报废入库状态
            <input :value="stockInStatusLabel(document.state.document.stockInStatus)" readonly data-testid="material-scrap-stock-in-status" />
          </label>
        </div>
      </div>

      <section class="material-scrap-entry-section">
        <div class="material-scrap-entry-title">
          <h3>材料报废分录</h3>
          <span>{{ document.state.lines.length }} 行</span>
        </div>
        <MaterialScrapEntryTable
          :lines="document.state.lines"
          :editable="document.editable.value"
          @mark-dirty="document.markDirty"
        />
      </section>
    </section>
  </StandardDocument>

  <SourceSelectorDialog
    :open="sourceSelectorOpen"
    test-prefix="material-scrap"
    title="选择生产领料单"
    description="只显示已审核、未关闭/冻结、非红字且仍有可报废数量的生产领料行。"
    v-model:keyword="sourceSelectorKeyword"
    search-placeholder="领料单号、车间、商品、仓库"
    :loading="sourceSelectorLoading || document.previewing.value"
    :rows="sourceSelectorRows"
    :columns="sourceSelectorColumns"
    :selected="sourceSelectorSelected"
    :count-label="sourceSelectorCountLabel"
    :summary-items="sourceSelectorSummaryItems"
    :message="sourceSelectorMessage"
    :row-key="sourceRowKey"
    :format-cell="formatSourceCell"
    :show-column-settings="true"
    :show-select-all="false"
    @query-change="sourceSelector.load"
    @toggle="sourceSelector.toggleRow"
    @close="sourceSelector.close"
    @confirm="confirmSourceSelector"
    @reset-columns="resetSourceColumns"
  />

  <div v-if="document.pendingAction.value" class="modal-mask" data-testid="material-scrap-action-dialog">
    <div class="dialog risky-action-dialog">
      <h3>{{ document.pendingActionTitle.value }}</h3>
      <p>{{ document.pendingActionSummary.value }}</p>
      <template v-if="document.pendingAction.value === 'void'">
        <label>
          作废原因
          <textarea v-model="document.voidReason.value" rows="3" data-testid="material-scrap-void-reason"></textarea>
        </label>
        <label>
          当前账号
          <input v-model.trim="document.voidUsername.value" autocomplete="username" data-testid="material-scrap-void-username" />
        </label>
        <label>
          当前密码
          <input v-model="document.voidPassword.value" type="password" autocomplete="current-password" data-testid="material-scrap-void-password" />
        </label>
      </template>
      <div class="dialog-actions">
        <button type="button" :disabled="document.mutationInFlight.value" @click="document.cancelAction">取消</button>
        <button class="danger-action" type="button" :disabled="!document.canConfirmPendingAction.value" data-testid="material-scrap-action-confirm" @click="document.confirmAction">确认执行</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useSourceSelectorLifecycle } from "../../../app/sourceSelectorLifecycle";
import MaterialScrapEntryTable from "../../../components/MaterialScrapEntryTable.vue";
import SourceSelectorDialog, { type SourceSelectorColumn } from "../../../components/SourceSelectorDialog.vue";
import StandardDocument from "../../../components/StandardDocument.vue";
import type { DocumentDetail } from "../../../services/documentApi";
import {
  fetchMaterialScrapPreview,
  fetchSelectableMaterialScrapSources,
  type MaterialScrapDetail,
  type SelectableMaterialScrapSourceLine
} from "../../../services/productionApi";
import { useMaterialScrapDocument } from "./useMaterialScrapDocument";

const props = defineProps<{
  title: string;
  subtitle: string;
  statusClass: string;
  locked: boolean;
  lockMessage?: string;
  canOverrideLock?: boolean;
  dirty: boolean;
  accountSetKey: string;
  hasPermission: (permission: string) => boolean;
}>();

const emit = defineEmits<{
  overrideLock: [];
  requestStartNew: [payload: { dirtyAlreadyConfirmed: boolean }];
}>();

const document = useMaterialScrapDocument({
  hasPermission: props.hasPermission,
  isLocked: () => props.locked,
  accountSetKey: () => props.accountSetKey
});

const sourceSelectorColumns = ref<SourceSelectorColumn[]>([
  { key: "selection", title: "选", width: 42, visible: true, configurable: false },
  { key: "billNo", title: "生产领料单", width: 168, visible: true },
  { key: "billDate", title: "单据日期", width: 116, visible: true },
  { key: "workshopCode", title: "车间编码", width: 116, visible: true },
  { key: "workshopName", title: "生产车间", width: 150, visible: true },
  { key: "lineNo", title: "行号", width: 72, visible: true },
  { key: "productCode", title: "商品编码", width: 140, visible: true },
  { key: "productName", title: "商品名称", width: 180, visible: true },
  { key: "spec", title: "规格型号", width: 148, visible: true },
  { key: "unit", title: "单位", width: 76, visible: true },
  { key: "sourceWarehouseCode", title: "来源仓库", width: 116, visible: true },
  { key: "issueQty", title: "领料数量", width: 108, visible: true },
  { key: "availableScrapQty", title: "可报废数量", width: 118, visible: true }
]);

const sourceSelector = useSourceSelectorLifecycle<SelectableMaterialScrapSourceLine>({
  rowKey: sourceRowKey,
  fetchRows: fetchSelectableMaterialScrapSources,
  quantityField: "availableScrapQty",
  countLabel: (count) => `${count} 行已选`,
  quantityLabel: "可报废数量合计",
  selectedQuantityLabel: "已选可报废数量",
  emptyMessage: "当前条件下暂无可下推材料报废的生产领料单。",
  loadErrorMessage: "材料报废来源列表加载失败。",
  formatQty: formatQuantity,
  selectionMode: "single"
});
const sourceSelectorOpen = sourceSelector.open;
const sourceSelectorLoading = sourceSelector.loading;
const sourceSelectorMessage = sourceSelector.message;
const sourceSelectorKeyword = sourceSelector.keyword;
const sourceSelectorRows = sourceSelector.rows;
const sourceSelectorSelected = sourceSelector.selected;
const sourceSelectorCountLabel = sourceSelector.countLabel;
const sourceSelectorSummaryItems = sourceSelector.summaryItems;

async function openSourceSelector() {
  if (!document.canSourceSelect.value) return;
  await sourceSelector.openAndLoad({
    keyword: document.state.document.sourceIssueNo || "",
    columnFilters: {}
  });
}

async function confirmSourceSelector() {
  if (!document.canSourceSelect.value || props.locked || !sourceSelectorOpen.value) {
    sourceSelector.setMessage("单据状态、编辑锁或账套状态已变化，当前选源已被阻止。 ");
    return;
  }
  const source = sourceSelector.selectedRowList.value[0];
  const billNo = String(source?.billNo ?? "");
  if (!billNo) {
    sourceSelector.setMessage("请先选择一张生产领料单。 ");
    return;
  }
  const requestEpoch = document.beginPreviewOperation();
  if (!requestEpoch) return;
  const requestAccountSetKey = props.accountSetKey;
  try {
    const result = await fetchMaterialScrapPreview(billNo);
    const selectedBillNo = String(sourceSelector.selectedRowList.value[0]?.billNo ?? "");
    if (
      !document.operationStillCurrent(requestEpoch)
      || props.accountSetKey !== requestAccountSetKey
      || selectedBillNo !== billNo
      || !sourceSelectorOpen.value
    ) {
      return;
    }
    if (!result.ok || !result.data) {
      sourceSelector.setMessage(result.message || "材料报废预览加载失败。 ");
      return;
    }
    document.applyPreview(result.data as MaterialScrapDetail);
    sourceSelector.close();
  } finally {
    document.finishPreviewOperation(requestEpoch);
  }
}

function resetSourceColumns() {
  sourceSelectorColumns.value = sourceSelectorColumns.value.map((column) => ({ ...column, visible: true }));
}

function sourceRowKey(row: SelectableMaterialScrapSourceLine | unknown) {
  const typed = row as SelectableMaterialScrapSourceLine;
  return String(typed.id ?? `${typed.billNo ?? ""}-${typed.sourceIssueLineId ?? typed.lineNo ?? ""}`);
}

function formatSourceCell(row: unknown, key: string) {
  const value = (row as Record<string, unknown>)[key];
  return ["issueQty", "availableScrapQty"].includes(key) ? formatQuantity(value) : String(value ?? "");
}

function formatQuantity(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return String(value ?? "");
  return Number.isInteger(parsed) ? String(parsed) : parsed.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function stockInStatusLabel(value: string) {
  return ({
    NOT_REQUIRED: "无需入库",
    PENDING: "待报废入库",
    STOCKED_IN: "已报废入库",
    REVERSED: "已撤销入库"
  } as Record<string, string>)[value] ?? value;
}

function loadByBillNo(billNo: string) {
  return document.loadByBillNo(billNo);
}

function startNew() {
  document.startNew();
}

function requestStartNew() {
  emit("requestStartNew", { dirtyAlreadyConfirmed: props.dirty });
}

function applyDetail(detail: DocumentDetail, message = "", sourceLineNo: number | null = null) {
  document.applyDetail(detail, message, sourceLineNo);
}

defineExpose({ loadByBillNo, startNew, applyDetail, operationInFlight: document.mutationInFlight });
</script>

<style scoped>
.material-scrap-form {
  min-width: 0;
  overflow: hidden;
}

.material-scrap-head-card,
.material-scrap-entry-section {
  min-width: 0;
  margin: 12px 0;
  padding: 14px;
  border: 1px solid #dbe3ec;
  border-radius: 8px;
  background: #fff;
}

.material-scrap-head-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 12px 16px;
}

.material-scrap-head-grid label,
.risky-action-dialog label {
  display: grid;
  gap: 6px;
  color: #475569;
  font-size: 12px;
}

.material-scrap-head-grid input,
.material-scrap-head-grid select,
.risky-action-dialog input,
.risky-action-dialog textarea {
  width: 100%;
  box-sizing: border-box;
}

.material-scrap-entry-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.material-scrap-entry-title h3 {
  margin: 0;
  font-size: 15px;
}

.material-scrap-entry-title span {
  color: #64748b;
  font-size: 12px;
}
</style>
