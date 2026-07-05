<template>
  <StandardDocument
    :title="title"
    subtitle=""
    :show-subtitle="false"
    :status-label="statusLabel"
    status-class="form"
    :locked="false"
    :dirty="dirty"
    :message="message"
    :can-save="canSave"
    :can-audit="Boolean(form.billNo) && statusLabel === '草稿'"
    :can-reverse="Boolean(form.billNo) && statusLabel === '已审核'"
    :can-void="false"
    :can-delete="false"
    :can-output="false"
    :show-reverse="true"
    :show-red-reverse="false"
    :show-void="false"
    :show-close="false"
    :show-unclose="false"
    :show-freeze="false"
    :show-unfreeze="false"
    :show-delete="false"
    :show-export="false"
    :show-print="false"
    :show-source-select="kind !== 'workOrder'"
    :can-source-select="statusLabel === '草稿' && !form.billNo"
    source-select-label="选源单"
    :source-select-test-id="`${testPrefix}-source-select`"
    :show-push-down="showPrimaryPush"
    :can-push-down="canPrimaryPush"
    :push-down-label="primaryPushLabel"
    :push-down-test-id="`${testPrefix}-primary-push`"
    :show-extra-action="showSecondaryPush"
    :can-extra-action="canSecondaryPush"
    :extra-action-label="secondaryPushLabel"
    :extra-action-test-id="`${testPrefix}-secondary-push`"
    :data-testid="`${testPrefix}-form`"
    @create="startNew"
    @save="save"
    @audit="audit"
    @reverse="reverse"
    @source-select="openSourcePicker"
    @push-down="primaryPush"
    @extra-action="secondaryPush"
  >
    <div class="form-layout outsourcing-document-form">
      <section class="form-head-fields outsourcing-head-fields">
        <label>
          单据编号
          <input v-model.trim="form.billNo" :data-testid="`${testPrefix}-bill-no`" placeholder="保存/生成后返回" readonly />
        </label>
        <label>
          {{ sourceLabel }}
          <input v-model.trim="form.sourceBillNo" :data-testid="`${testPrefix}-source-bill-no`" :placeholder="sourcePlaceholder" @input="markDirty" />
        </label>
        <label>
          供应商编码
          <input v-model.trim="form.supplierCode" :disabled="kind !== 'workOrder'" :data-testid="`${testPrefix}-supplier-code`" placeholder="如 GYS001" @input="markDirty" />
        </label>
        <label>
          业务日期
          <input v-model.trim="form.billDate" :data-testid="`${testPrefix}-bill-date`" @input="markDirty" />
        </label>
        <label class="form-head-field-wide">
          单据备注
          <textarea v-model.trim="form.remark" :disabled="kind !== 'workOrder'" :data-testid="`${testPrefix}-remark`" @input="markDirty" />
        </label>
      </section>

      <EntryTable
        :lines="lines"
        :test-prefix="testPrefix"
        :is-draft="statusLabel === '草稿' && (kind === 'workOrder' || !form.billNo)"
        batch-warehouse-code=""
        :active-selector="activeSelector"
        :selector-options="selectorOptions"
        :selector-cursor-index="selectorCursorIndex"
        :known-product-options="knownProductOptions"
        :dragging-line-index="null"
        highlighted-source-bill-no=""
        :highlighted-source-line-no="null"
        :current-bill-no="form.billNo"
        :show-party-code-column="false"
        :show-customer-material-code-column="false"
        :show-supplier-material-code-column="false"
        :show-customer-order-no-column="false"
        :show-source-line-column="kind !== 'workOrder'"
        :show-execution-columns="false"
        :show-target-warehouse-column="false"
        :show-plan-delivery-date-column="kind === 'workOrder'"
        :show-stock-columns="false"
        :show-price-amount-columns="false"
        :entry-table-colspan="entryTableColspan"
        :entry-total-colspan="entryTotalColspan"
        total-amount="0.00"
        :show-tax-columns="false"
        @mark-dirty="markDirty"
        @search-master-options="searchMasterOptions"
        @handle-master-input="handleMasterInput"
        @handle-selector-keydown="handleSelectorKeydown"
        @open-master-selector-dialog="noop"
        @select-line-product="selectLineProduct"
        @select-warehouse-option="selectWarehouseOption"
        @select-target-warehouse-option="noop"
        @entry-paste="noop"
        @trace-source-order="noop"
        @open-downstream-trace="noop"
        @line-drag-start="noop"
        @line-drag-over="noop"
        @line-drop="noop"
        @line-drag-end="noop"
        @insert-line-after="insertLineAfter"
        @remove-line="removeLine"
        @copy-line="copyLine"
        @line-lifecycle="noop"
        @add-line="addLine"
        @refresh-stock="noop"
      />

      <section v-if="kind === 'workOrder' && componentLines.length" class="component-demand-panel" data-testid="outsourcing-component-demand">
        <div class="component-demand-title">
          <strong>子件需求明细</strong>
          <span>按当前已审核 BOM 固化，后续 BOM 修改不影响本单快照。</span>
        </div>
        <TableCore
          kind="entry"
          test-id="outsourcing-component-demand-table"
          frame-class="entry-table component-demand-table"
          table-class="entry-native-table"
          :columns="componentDemandColumns"
          :rows="componentLines"
          :min-width="960"
          :row-visible="() => true"
          :cell-title="componentDemandCellTitle"
          @column-resize="resizeComponentDemandColumn"
        >
          <template #cell="{ row: component, column }">
            <span class="entry-cell-value" :class="{ 'entry-cell-value--number': isComponentDemandNumberColumn(column.key) }">
              {{ componentDemandValue(component, column.key) }}
            </span>
          </template>
        </TableCore>
      </section>

      <SourceSelectorDialog
        :open="sourcePickerOpen"
        :test-prefix="testPrefix"
        title="选择源单"
        description="仅显示已审核且有剩余可下推数量的单据。"
        v-model:keyword="sourceSelectorKeyword"
        search-placeholder="搜索单据编号、供应商、物料"
        :loading="sourceSelectorLoading"
        :rows="sourceSelectorRows"
        :columns="sourceSelectorColumns"
        :selected="sourceSelectorSelected"
        :count-label="selectedSourceCountLabel"
        :summary-items="sourceSelectorSummaryItems"
        :message="sourceSelectorMessage"
        :row-key="sourceSelectorRowKey"
        :format-cell="formatSourceSelectorCell"
        :show-select-all="false"
        :show-column-settings="true"
        empty-text="暂无可选源单"
        @query-change="sourceSelector.load"
        @toggle="sourceSelector.toggleRow"
        @close="sourceSelector.close"
        @confirm="confirmSourcePicker"
      />
    </div>
  </StandardDocument>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import type { EntryLine, MasterOption } from "../../components/EntryTable.vue";
import EntryTable from "../../components/EntryTable.vue";
import SourceSelectorDialog, { type SourceSelectorColumn } from "../../components/SourceSelectorDialog.vue";
import StandardDocument from "../../components/StandardDocument.vue";
import TableCore, { type TableCoreColumn } from "../../components/table/TableCore.vue";
import { useSourceSelectorLifecycle } from "../../app/sourceSelectorLifecycle";
import { fetchListRows } from "../../services/listApi";
import {
  auditOutsourcingIssue,
  auditOutsourcingReceipt,
  auditOutsourcingReturn,
  auditOutsourcingScrap,
  auditOutsourcingWorkOrder,
  fetchOutsourcingIssue,
  fetchOutsourcingReceipt,
  fetchOutsourcingReturn,
  fetchOutsourcingScrap,
  fetchOutsourcingWorkOrder,
  pushOutsourcingIssue,
  pushOutsourcingReceipt,
  pushOutsourcingReturn,
  pushOutsourcingScrap,
  reverseOutsourcingIssue,
  reverseOutsourcingReceipt,
  reverseOutsourcingReturn,
  reverseOutsourcingScrap,
  reverseOutsourcingWorkOrder,
  saveOutsourcingWorkOrder
} from "../../services/outsourcingApi";
import { fetchSourceSelectorRows } from "../../services/sourceSelectorListApi";

type OutsourcingKind = "workOrder" | "issue" | "receipt" | "return" | "scrap";
interface ComponentDemandLine {
  lineNo: number;
  productCode: string;
  productName: string;
  spec: string;
  unit: string;
  warehouseCode: string;
  unitQty: string;
  qty: string;
  issuedQty: string;
}

interface SourceOption {
  billNo: string;
  sourceBillNo?: string;
  sourceLineNo?: number;
  supplierCode: string;
  supplierName: string;
  productCode: string;
  productName: string;
  spec: string;
  unit: string;
  warehouseCode: string;
  remainingQty: string;
  lineRemark: string;
}

const props = defineProps<{
  title: string;
  dirty: boolean;
  kind: OutsourcingKind;
}>();

const emit = defineEmits<{
  markDirty: [];
  clearDirty: [];
}>();

const statusLabel = ref("草稿");
const message = ref("");
const form = reactive({
  billNo: "",
  sourceBillNo: "",
  supplierCode: "",
  billDate: todayText(),
  remark: ""
});
const lines = reactive<EntryLine[]>([emptyLine()]);
const activeSelector = ref("");
const selectorOptions = ref<MasterOption[]>([]);
const selectorCursorIndex = ref(0);
const knownProductOptions = ref<MasterOption[]>([]);
const componentLines = reactive<ComponentDemandLine[]>([]);
const testPrefix = computed(() => `outsourcing-${props.kind}`);
const canSave = computed(() => statusLabel.value === "草稿" && (props.kind === "workOrder" || (!form.billNo && Boolean(form.sourceBillNo.trim()))));
const showPrimaryPush = computed(() => props.kind === "workOrder" || props.kind === "receipt");
const canPrimaryPush = computed(() => statusLabel.value === "已审核" && Boolean(form.billNo.trim()));
const showSecondaryPush = computed(() => props.kind === "workOrder" || props.kind === "receipt");
const canSecondaryPush = computed(() => statusLabel.value === "已审核" && Boolean(form.billNo.trim()));
const primaryPushLabel = computed(() => props.kind === "receipt" ? "下推退货" : "下推发料");
const secondaryPushLabel = computed(() => props.kind === "receipt" ? "下推报废" : "下推入库");
const sourceLabel = computed(() => {
  if (props.kind === "workOrder") {
    return "来源产品入库单";
  }
  return props.kind === "return" || props.kind === "scrap" ? "来源委外入库单" : "来源委外加工单";
});
const sourcePlaceholder = computed(() => {
  if (props.kind === "workOrder") {
    return "如 CPRK000001，可空";
  }
  return props.kind === "return" || props.kind === "scrap" ? "如 WWRK000001" : "如 WWJG000001";
});
const entryTableColspan = computed(() => props.kind === "workOrder" ? 8 : 9);
const entryTotalColspan = computed(() => props.kind === "workOrder" ? 7 : 8);
const sourceSelectorColumns: SourceSelectorColumn[] = [
  { key: "selection", title: "", width: 48, visible: true, align: "center", configurable: false },
  { key: "billNo", title: "源单编号", width: 150, visible: true },
  { key: "supplierName", title: "供应商", width: 150, visible: true },
  { key: "productCode", title: "物料编码", width: 140, visible: true },
  { key: "productName", title: "物料名称", width: 160, visible: true },
  { key: "remainingQty", title: "剩余数量", width: 100, visible: true, align: "right" },
  { key: "unit", title: "单位", width: 70, visible: true },
  { key: "lineRemark", title: "行备注", width: 160, visible: true }
];
const sourceSelector = useSourceSelectorLifecycle<SourceOption>({
  rowKey: (row) => sourceSelectorRowKey(row),
  fetchRows: async (query) => {
    const result = await fetchSourceSelectorRows({
      listKey: sourceSelectorListKey(),
      keyword: query.keyword,
      columnFilters: query.columnFilters
    });
    return {
      ok: result.ok,
      message: result.message || "可选源单加载失败。",
      data: result.rows.map(sourceFromRow)
    };
  },
  quantityField: "remainingQty",
  quantityLabel: "剩余数量合计",
  selectedQuantityLabel: "已选数量",
  emptyMessage: "当前过滤条件下暂无可选源单。",
  loadErrorMessage: "可选源单加载失败。",
  formatQty: (value) => formatSummaryQty(Number(value ?? 0)),
  allocatedQty: allocatedSourceQty,
  selectionMode: "single",
  countLabel: (count) => `已选中 ${count} 条`
});
const sourcePickerOpen = sourceSelector.open;
const sourceSelectorKeyword = sourceSelector.keyword;
const sourceSelectorLoading = sourceSelector.loading;
const sourceSelectorMessage = sourceSelector.message;
const sourceSelectorRows = sourceSelector.rows;
const sourceSelectorSelected = sourceSelector.selected;
const selectedSourceCountLabel = sourceSelector.countLabel;
const sourceSelectorSummaryItems = sourceSelector.summaryItems;
const componentDemandColumns = ref<TableCoreColumn[]>([
  { key: "lineNo", title: "序号", width: 48, minWidth: 48, align: "center", resizable: false, filterable: false, headerClass: "entry-row-no-cell entry-frozen-cell", cellClass: "entry-row-no-cell entry-frozen-cell" },
  { key: "productCode", title: "子件物料编码", width: 150, minWidth: 96, filterable: false },
  { key: "productName", title: "子件物料名称", width: 160, minWidth: 96, filterable: false },
  { key: "spec", title: "规格型号", width: 140, minWidth: 96, filterable: false },
  { key: "warehouseCode", title: "发料仓库", width: 112, minWidth: 84, filterable: false },
  { key: "unit", title: "单位", width: 72, minWidth: 64, filterable: false },
  { key: "unitQty", title: "单位用量", width: 104, minWidth: 84, align: "right", filterable: false, headerClass: "entry-number-cell", cellClass: "entry-number-cell" },
  { key: "qty", title: "需求数量", width: 104, minWidth: 84, align: "right", filterable: false, headerClass: "entry-number-cell", cellClass: "entry-number-cell" },
  { key: "issuedQty", title: "已发料数量", width: 112, minWidth: 84, align: "right", filterable: false, headerClass: "entry-number-cell", cellClass: "entry-number-cell" }
]);

function resizeComponentDemandColumn(payload: { column: TableCoreColumn; width: number }) {
  payload.column.width = payload.width;
}

function componentDemandCellTitle(component: ComponentDemandLine, column: TableCoreColumn) {
  return componentDemandValue(component, column.key);
}

function componentDemandValue(component: ComponentDemandLine, key: string) {
  return String(component[key as keyof ComponentDemandLine] ?? "");
}

function isComponentDemandNumberColumn(key: string) {
  return ["unitQty", "qty", "issuedQty"].includes(key);
}

function markDirty() {
  message.value = "";
  emit("markDirty");
}

function startNew() {
  form.billNo = "";
  form.sourceBillNo = "";
  form.supplierCode = "";
  form.billDate = todayText();
  form.remark = "";
  lines.splice(0, lines.length, emptyLine());
  componentLines.splice(0, componentLines.length);
  statusLabel.value = "草稿";
  message.value = "";
  closeSourcePicker();
  emit("markDirty");
}

async function loadDocument(billNo: string) {
  const result = await fetchDetailByKind(billNo);
  if (!result.ok || !result.data) {
    message.value = result.message || "委外单据详情加载失败。";
    return;
  }
  applyDetail(result.data);
  message.value = `已打开${props.title} ${billNo}`;
  emit("clearDirty");
}

function applyDetail(data: Record<string, unknown>) {
  form.billNo = textValue(data.billNo);
  form.sourceBillNo = textValue(data.sourceBillNo);
  form.supplierCode = textValue(data.supplierCode);
  form.billDate = textValue(data.billDate) || todayText();
  form.remark = textValue(data.remark);
  statusLabel.value = backendStatusLabel(textValue(data.status) || "DRAFT");
  const detailLines = Array.isArray(data.lines) ? data.lines : [];
  lines.splice(0, lines.length, ...detailLines.map(lineFromDetail));
  if (!lines.length) {
    lines.push(emptyLine());
  }
  const detailComponents = Array.isArray(data.components) ? data.components : [];
  componentLines.splice(0, componentLines.length, ...detailComponents.map(componentFromDetail));
}

async function save() {
  const result = props.kind === "workOrder"
    ? await saveOutsourcingWorkOrder({
      billNo: form.billNo.trim(),
      sourceBillNo: form.sourceBillNo.trim(),
      supplierCode: form.supplierCode.trim(),
      productCode: lines[0]?.productCode.trim(),
      qty: Number(lines[0]?.qty || 0),
      planDeliveryDate: String(lines[0]?.planDeliveryDate || "").trim(),
      remark: form.remark.trim()
    })
    : await generateFromSource();
  if (!result.ok) {
    message.value = result.message;
    return;
  }
  form.billNo = String(result.data?.billNo ?? form.billNo);
  statusLabel.value = backendStatusLabel(String(result.data?.status ?? "DRAFT"));
  if (result.data) {
    applyDetail({ ...result.data, billNo: form.billNo, status: result.data.status ?? "DRAFT" });
  }
  message.value = `${props.title}已${props.kind === "workOrder" ? "保存" : "生成"}：${form.billNo}`;
  emit("clearDirty");
}

async function audit() {
  if (!form.billNo && props.kind !== "workOrder") {
    await save();
  }
  if (!form.billNo) {
    return;
  }
  const result = await auditByKind();
  if (!result.ok) {
    message.value = result.message;
    return;
  }
  statusLabel.value = "已审核";
  message.value = `${props.title}已审核：${form.billNo}`;
  emit("clearDirty");
}

async function reverse() {
  if (!form.billNo) {
    return;
  }
  const result = await reverseByKind();
  if (!result.ok) {
    message.value = result.message;
    return;
  }
  statusLabel.value = backendStatusLabel(String(result.data?.status ?? "DRAFT"));
  message.value = `${props.title}已反审核，状态回到草稿：${form.billNo}`;
  emit("clearDirty");
}

async function openSourcePicker() {
  const ok = await sourceSelector.openAndLoad({ keyword: "", columnFilters: {} });
  if (!ok) {
    message.value = sourceSelectorMessage.value || "可选源单加载失败。";
    sourceSelector.close();
    return;
  }
}

function closeSourcePicker() {
  sourceSelector.close();
}

async function confirmSourcePicker() {
  const source = sourceSelector.selectedRowList.value[0];
  if (!source) {
    sourceSelectorMessage.value = "请先选择一条源单。";
    return;
  }
  await selectSource(source);
}

async function selectSource(source: SourceOption) {
  form.sourceBillNo = source.billNo;
  form.supplierCode = source.supplierCode;
  if (props.kind === "issue") {
    const detail = await fetchOutsourcingWorkOrder(source.billNo);
    const components = detail.ok && detail.data && Array.isArray(detail.data.components)
      ? detail.data.components
      : [];
    if (components.length) {
      lines.splice(0, lines.length, ...components.map((component) => lineFromComponentSource(source.billNo, component)));
      sourceSelector.commitLocalAllocation();
      closeSourcePicker();
      markDirty();
      return;
    }
  }
  lines.splice(0, lines.length, {
    ...emptyLine(),
    productCode: source.productCode,
    productName: source.productName,
    spec: source.spec,
    unit: source.unit,
    warehouseCode: source.warehouseCode,
    sourceOrderNo: source.billNo,
    sourceLineNo: source.sourceLineNo,
    qty: Number(source.remainingQty || 0)
  });
  sourceSelector.commitLocalAllocation();
  closeSourcePicker();
  markDirty();
}

async function primaryPush() {
  if (props.kind === "workOrder") {
    const result = await pushOutsourcingIssue(form.billNo);
    handlePushResult(result, "已下推生成委外发料单");
    return;
  }
  if (props.kind === "receipt") {
    const result = await pushOutsourcingReturn(form.billNo);
    handlePushResult(result, "已下推生成委外产品退货单");
  }
}

async function secondaryPush() {
  if (props.kind === "workOrder") {
    const result = await pushOutsourcingReceipt(form.billNo);
    handlePushResult(result, "已下推生成委外产品入库单");
    return;
  }
  if (props.kind === "receipt") {
    const result = await pushOutsourcingScrap(form.billNo);
    handlePushResult(result, "已下推生成委外产品报废单");
  }
}

async function generateFromSource() {
  if (props.kind === "issue") {
    return pushOutsourcingIssue(form.sourceBillNo.trim());
  }
  if (props.kind === "receipt") {
    return pushOutsourcingReceipt(form.sourceBillNo.trim(), Number(lines[0]?.qty || 0) || undefined);
  }
  if (props.kind === "return") {
    return pushOutsourcingReturn(form.sourceBillNo.trim(), Number(lines[0]?.qty || 0) || undefined);
  }
  return pushOutsourcingScrap(form.sourceBillNo.trim(), Number(lines[0]?.qty || 0) || undefined);
}

async function auditByKind() {
  if (props.kind === "workOrder") {
    return auditOutsourcingWorkOrder(form.billNo);
  }
  if (props.kind === "issue") {
    return auditOutsourcingIssue(form.billNo);
  }
  if (props.kind === "receipt") {
    return auditOutsourcingReceipt(form.billNo);
  }
  if (props.kind === "return") {
    return auditOutsourcingReturn(form.billNo);
  }
  return auditOutsourcingScrap(form.billNo);
}

async function reverseByKind() {
  if (props.kind === "workOrder") {
    return reverseOutsourcingWorkOrder(form.billNo);
  }
  if (props.kind === "issue") {
    return reverseOutsourcingIssue(form.billNo);
  }
  if (props.kind === "receipt") {
    return reverseOutsourcingReceipt(form.billNo);
  }
  if (props.kind === "return") {
    return reverseOutsourcingReturn(form.billNo);
  }
  return reverseOutsourcingScrap(form.billNo);
}

async function fetchDetailByKind(billNo: string) {
  if (props.kind === "workOrder") {
    return fetchOutsourcingWorkOrder(billNo);
  }
  if (props.kind === "issue") {
    return fetchOutsourcingIssue(billNo);
  }
  if (props.kind === "receipt") {
    return fetchOutsourcingReceipt(billNo);
  }
  if (props.kind === "return") {
    return fetchOutsourcingReturn(billNo);
  }
  return fetchOutsourcingScrap(billNo);
}

function sourceSelectorListKey() {
  if (props.kind === "issue") {
    return "outsourcing-work-order-issue-source-selector";
  }
  if (props.kind === "receipt") {
    return "outsourcing-work-order-receipt-source-selector";
  }
  if (props.kind === "return") {
    return "outsourcing-receipt-return-source-selector";
  }
  return "outsourcing-receipt-scrap-source-selector";
}

function handlePushResult(result: { ok: boolean; message: string; data?: Record<string, unknown> }, prefix: string) {
  if (!result.ok) {
    message.value = result.message;
    return;
  }
  message.value = `${prefix} ${String(result.data?.billNo ?? "")}`;
}

function insertLineAfter(index: number) {
  lines.splice(index + 1, 0, emptyLine());
  markDirty();
}

function removeLine(index: number) {
  if (lines.length <= 1) {
    return;
  }
  lines.splice(index, 1);
  markDirty();
}

function copyLine(index: number) {
  const line = lines[index];
  if (!line) {
    return;
  }
  lines.splice(index + 1, 0, { ...line });
  markDirty();
}

function addLine() {
  lines.push(emptyLine());
  markDirty();
}

function handleMasterInput(type: string, keyword: string, selectorId: string) {
  markDirty();
  void searchMasterOptions(type, keyword, selectorId);
}

async function searchMasterOptions(type: string, keyword: string, selectorId: string) {
  activeSelector.value = selectorId;
  const result = await fetchListRows(type === "warehouse" ? "warehouse-master-list" : "product-master-list", {
    keyword,
    status: "",
    page: 1,
    pageSize: 20
  });
  selectorOptions.value = result.ok && result.data ? result.data.rows.map(masterRowToOption) : [];
  selectorCursorIndex.value = selectorOptions.value.length > 0 ? 0 : -1;
}

function handleSelectorKeydown(event: KeyboardEvent, selectorId: string) {
  if (event.key === "Escape") {
    activeSelector.value = "";
    return;
  }
  if (activeSelector.value !== selectorId || !selectorOptions.value.length) {
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    selectorCursorIndex.value = Math.min(selectorCursorIndex.value + 1, selectorOptions.value.length - 1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    selectorCursorIndex.value = Math.max(selectorCursorIndex.value - 1, 0);
  } else if (event.key === "Enter") {
    event.preventDefault();
    const option = selectorOptions.value[selectorCursorIndex.value] ?? selectorOptions.value[0];
    if (option && selectorId.includes("-product")) {
      selectLineProduct(option, lineIndexFromSelector(selectorId));
    } else if (option && selectorId.includes("-warehouse")) {
      selectWarehouseOption(option, lineIndexFromSelector(selectorId));
    }
  }
}

function selectLineProduct(option: MasterOption, lineIndex = 0) {
  const line = lines[lineIndex];
  if (!line) {
    return;
  }
  line.productCode = option.code;
  line.productName = option.name;
  line.spec = option.spec ?? "";
  line.unit = option.unit ?? "";
  line.netWeight = option.netWeight ?? "";
  line.grossWeight = option.grossWeight ?? "";
  activeSelector.value = "";
  markDirty();
}

function selectWarehouseOption(option: MasterOption, lineIndex = 0) {
  const line = lines[lineIndex];
  if (!line) {
    return;
  }
  line.warehouseCode = option.code;
  activeSelector.value = "";
  markDirty();
}

function masterRowToOption(row: Record<string, unknown>): MasterOption {
  return {
    code: String(row.code ?? row.productCode ?? row.billNo ?? ""),
    name: String(row.name ?? row.productName ?? row.warehouse ?? ""),
    spec: row.spec == null ? "" : String(row.spec),
    unit: row.unit == null ? "" : String(row.unit),
    netWeight: row.netWeight == null ? "" : String(row.netWeight),
    grossWeight: row.grossWeight == null ? "" : String(row.grossWeight)
  };
}

function lineIndexFromSelector(selectorId: string) {
  const match = selectorId.match(/-line-(\d+)-/);
  return match ? Number(match[1]) : 0;
}

function emptyLine(): EntryLine {
  return {
    productCode: "",
    productName: "",
    spec: "",
    unit: "",
    warehouseCode: "",
    qty: 1,
    unitPrice: 0,
    taxRate: 13,
    planDeliveryDate: todayText()
  };
}

function lineFromDetail(raw: unknown): EntryLine {
  const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    ...emptyLine(),
    lineNo: numberValue(row.lineNo) || undefined,
    productCode: textValue(row.productCode),
    productName: textValue(row.productName),
    spec: textValue(row.spec),
    unit: textValue(row.unit),
    warehouseCode: textValue(row.warehouseCode),
    qty: numberValue(row.qty),
    planDeliveryDate: textValue(row.planDeliveryDate) || todayText()
  };
}

function componentFromDetail(raw: unknown): ComponentDemandLine {
  const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    lineNo: numberValue(row.lineNo),
    productCode: textValue(row.productCode),
    productName: textValue(row.productName),
    spec: textValue(row.spec),
    unit: textValue(row.unit),
    warehouseCode: textValue(row.warehouseCode),
    unitQty: textValue(row.unitQty),
    qty: textValue(row.qty),
    issuedQty: textValue(row.issuedQty)
  };
}

function lineFromComponentSource(sourceBillNo: string, raw: unknown): EntryLine {
  const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const requiredQty = numberValue(row.qty);
  const issuedQty = numberValue(row.issuedQty);
  return {
    ...emptyLine(),
    lineNo: numberValue(row.lineNo) || undefined,
    productCode: textValue(row.productCode),
    productName: textValue(row.productName),
    spec: textValue(row.spec),
    unit: textValue(row.unit),
    warehouseCode: textValue(row.warehouseCode),
    sourceOrderNo: sourceBillNo,
    sourceLineNo: numberValue(row.lineNo) || undefined,
    qty: Math.max(0, requiredQty - issuedQty)
  };
}

function sourceFromRow(raw: unknown): SourceOption {
  const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    billNo: textValue(row.billNo),
    sourceBillNo: textValue(row.sourceBillNo),
    sourceLineNo: numberValue(row.sourceLineNo) || undefined,
    supplierCode: textValue(row.supplierCode),
    supplierName: textValue(row.supplierName),
    productCode: textValue(row.productCode),
    productName: textValue(row.productName),
    spec: textValue(row.spec),
    unit: textValue(row.unit),
    warehouseCode: textValue(row.warehouseCode),
    remainingQty: textValue(row.remainingQty),
    lineRemark: textValue(row.lineRemark || row.remark)
  };
}

function sourceSelectorRowKey(row: unknown) {
  const source = row as SourceOption;
  return `${source.billNo}-${source.sourceLineNo ?? 0}-${source.productCode}`;
}

function formatSourceSelectorCell(row: unknown, columnKey: string) {
  const source = row as SourceOption;
  const values: Record<string, string> = {
    billNo: source.billNo,
    supplierName: source.supplierName,
    productCode: source.productCode,
    productName: source.productName,
    remainingQty: source.remainingQty,
    unit: source.unit,
    lineRemark: source.lineRemark
  };
  return values[columnKey] ?? "";
}

function allocatedSourceQty(source: SourceOption) {
  const sourceKey = sourceSelectorRowKey(source);
  return lines.reduce((sum, line) => {
    const lineKey = `${String(line.sourceOrderNo ?? "")}-${String(line.sourceLineNo ?? 0)}-${String(line.productCode ?? "")}`;
    if (lineKey !== sourceKey) {
      return sum;
    }
    return sum + numberValue(line.qty);
  }, 0);
}

function formatSummaryQty(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function textValue(value: unknown) {
  return value == null ? "" : String(value);
}

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function todayText() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function backendStatusLabel(status: string) {
  if (status === "AUDITED") {
    return "已审核";
  }
  if (status === "REVERSED") {
    return "已反审核";
  }
  return "草稿";
}

function noop() {}

defineExpose({ startNew, loadDocument });
</script>

<style scoped>
.outsourcing-document-form {
  min-width: 1120px;
}

.outsourcing-head-fields {
  grid-template-columns: repeat(4, minmax(160px, 1fr));
}

.component-demand-panel {
  border-top: 1px solid #d9e3ec;
  background: #fff;
}

.component-demand-title {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 32px;
  padding: 0 10px;
  border-bottom: 1px solid #d9e3ec;
  color: #1f3347;
  font-size: 13px;
}

.component-demand-title span {
  color: #718196;
  font-size: 12px;
}

</style>
