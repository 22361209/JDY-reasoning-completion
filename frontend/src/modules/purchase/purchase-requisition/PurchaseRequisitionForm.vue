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
    :can-audit="canAudit"
    :can-reverse="canReverse"
    :can-void="false"
    :can-delete="false"
    :can-output="false"
    :show-create="false"
    :show-audit="true"
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
    :show-push-down="true"
    :can-push-down="canPushDown"
    push-down-label="下推"
    push-down-test-id="purchase-requisition-push-down"
    data-testid="purchase-requisition-form"
    @save="save"
    @audit="audit"
    @reverse="reverse"
    @push-down="pushDown"
  >
    <div class="form-layout purchase-requisition-form">
      <section class="form-head-fields purchase-requisition-fields">
        <label>
          申请单号
          <input v-model="form.billNo" data-testid="purchase-requisition-bill-no" readonly />
        </label>
        <label>
          来源生产计划
          <input v-model="form.sourcePlanNo" data-testid="purchase-requisition-source-plan-no" readonly />
        </label>
        <label>
          单据日期
          <input v-model="form.billDate" data-testid="purchase-requisition-bill-date" readonly />
        </label>
        <label>
          部门
          <input v-model="form.department" data-testid="purchase-requisition-department" readonly />
        </label>
        <label>
          单据状态
          <input :value="statusLabel" data-testid="purchase-requisition-status" readonly />
        </label>
        <label>
          版本
          <input v-model="form.version" data-testid="purchase-requisition-version" readonly />
        </label>
      </section>

      <PurchasePlanningEntryTable
        mode="requisition"
        :lines="entryLines"
        :is-draft="isDraft"
        :supplier-options="supplierLookupOptions"
        :active-supplier-lookup-index="activeSupplierLookupIndex"
        :supplier-lookup-cursor="supplierLookupCursor"
        @mark-dirty="markDirty"
        @remove-line="removeLine"
        @open-supplier-selector="openSupplierSelector"
        @search-supplier-options="searchSupplierOptions"
        @handle-supplier-input="handleSupplierInput"
        @handle-supplier-keydown="handleSupplierKeydown"
        @close-supplier-lookup-later="closeSupplierLookupLater"
        @select-supplier-option="selectInlineSupplier"
      />
    </div>
  </StandardDocument>

  <MasterSelectorDialog
    :open="supplierSelectorOpen"
    type="supplier"
    title="选择供应商"
    label="供应商"
    :keyword="supplierSelectorKeyword"
    @close="closeSupplierSelector"
    @select="selectSupplier"
  />
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import type { MasterOption } from "../../../components/entry-table/types";
import MasterSelectorDialog from "../../../components/MasterSelectorDialog.vue";
import StandardDocument from "../../../components/StandardDocument.vue";
import { fetchListRows } from "../../../services/listApi";
import {
  auditPurchaseRequisition,
  fetchPurchaseRequisitionDetail,
  pushDownPurchaseRequisition,
  reversePurchaseRequisition,
  savePurchaseRequisitionDraft,
  type PurchaseRequisitionDetail,
  type PurchaseRequisitionLine
} from "../../../services/purchasePlanningApi";
import PurchasePlanningEntryTable, { type PurchasePlanningEntryLine } from "./PurchasePlanningEntryTable.vue";

const props = defineProps<{
  title: string;
  dirty: boolean;
}>();

const emit = defineEmits<{
  markDirty: [];
  clearDirty: [];
  showExisting: [];
}>();

const message = ref("");
const status = ref("DRAFT");
const supplierSelectorOpen = ref(false);
const supplierSelectorLineIndex = ref<number | null>(null);
const supplierSelectorKeyword = ref("");
const supplierLookupOptions = ref<MasterOption[]>([]);
const activeSupplierLookupIndex = ref<number | null>(null);
const supplierLookupCursor = ref(0);
let detailRequestSeq = 0;
let supplierLookupRequestSeq = 0;
let supplierLookupCloseTimer: number | undefined;

const form = reactive({
  billNo: "",
  sourcePlanNo: "",
  billDate: "",
  department: "",
  version: ""
});
const entryLines = ref<PurchasePlanningEntryLine[]>([]);

const statusLabel = computed(() => backendStatusLabel(status.value));
const isDraft = computed(() => status.value === "DRAFT");
const hasValidLines = computed(() => entryLines.value.length > 0
  && entryLines.value.every((line) => Boolean(line.id) && Number(line.qty) > 0));
const canSave = computed(() => Boolean(form.billNo) && isDraft.value && hasValidLines.value);
const canAudit = computed(() => Boolean(form.billNo) && !props.dirty && isDraft.value);
const canReverse = computed(() => Boolean(form.billNo) && !props.dirty && status.value === "AUDITED");
const canPushDown = computed(() => Boolean(form.billNo) && !props.dirty && status.value === "AUDITED");

function startNew() {
  closeSupplierLookup();
  closeSupplierSelector();
  message.value = "采购申请由已审核生产计划下推生成，不支持手工新增。";
}

async function loadDocument(billNo: string) {
  closeSupplierLookup();
  closeSupplierSelector();
  const requestSeq = detailRequestSeq + 1;
  detailRequestSeq = requestSeq;
  const result = await fetchPurchaseRequisitionDetail(billNo);
  if (requestSeq !== detailRequestSeq) {
    return false;
  }
  if (!result.ok || !result.data) {
    message.value = result.message || "采购申请加载失败。";
    return false;
  }
  applyDetail(result.data);
  message.value = "";
  emit("clearDirty");
  return true;
}

function markDirty() {
  emit("markDirty");
  message.value = "";
}

function removeLine(index: number) {
  if (!isDraft.value || !entryLines.value[index]) {
    return;
  }
  closeSupplierLookup();
  closeSupplierSelector();
  entryLines.value.splice(index, 1);
  markDirty();
}

function openSupplierSelector(index: number) {
  if (!isDraft.value || !entryLines.value[index]) {
    return;
  }
  closeSupplierLookup();
  supplierSelectorLineIndex.value = index;
  supplierSelectorKeyword.value = entryLines.value[index]?.supplierCode ?? "";
  supplierSelectorOpen.value = true;
}

function closeSupplierSelector() {
  supplierSelectorOpen.value = false;
  supplierSelectorLineIndex.value = null;
  supplierSelectorKeyword.value = "";
}

function selectSupplier(option: MasterOption) {
  const index = supplierSelectorLineIndex.value;
  if (index == null || !entryLines.value[index]) {
    closeSupplierSelector();
    return;
  }
  if (applySupplierOption(option, index)) {
    closeSupplierSelector();
  }
}

function applySupplierOption(option: MasterOption, index: number) {
  if (!isEligibleSupplierOption(option)) {
    message.value = `供应商 ${text(option.code)} 未审核或已禁用，不能用于采购申请`;
    return false;
  }
  const line = entryLines.value[index];
  if (!line) {
    return false;
  }
  closeSupplierLookup();
  line.supplierCode = text(option.code);
  line.supplierName = text(option.name);
  markDirty();
  return true;
}

function handleSupplierInput(keyword: string, index: number) {
  const line = entryLines.value[index];
  if (!line || !isDraft.value) {
    return;
  }
  line.supplierName = "";
  markDirty();
  void searchSupplierOptions(keyword, index);
}

async function searchSupplierOptions(keyword: string, index: number) {
  if (!isDraft.value || !entryLines.value[index]) {
    return;
  }
  if (supplierLookupCloseTimer != null) {
    window.clearTimeout(supplierLookupCloseTimer);
    supplierLookupCloseTimer = undefined;
  }
  activeSupplierLookupIndex.value = index;
  supplierLookupOptions.value = [];
  supplierLookupCursor.value = 0;
  const requestSeq = supplierLookupRequestSeq + 1;
  supplierLookupRequestSeq = requestSeq;
  const result = await fetchListRows("supplier-master-selector", {
    keyword,
    status: "启用",
    page: 1,
    pageSize: 20,
    columnFilters: {
      auditStatus: { operator: "等于", value: "已审核" }
    }
  });
  if (requestSeq !== supplierLookupRequestSeq || activeSupplierLookupIndex.value !== index) {
    return;
  }
  supplierLookupOptions.value = result.ok && result.data
    ? result.data.rows.map(masterRowToSupplierOption).filter(isEligibleSupplierOption)
    : [];
  supplierLookupCursor.value = supplierLookupOptions.value.length ? 0 : -1;
}

function handleSupplierKeydown(event: KeyboardEvent, index: number) {
  if (event.isComposing) {
    return;
  }
  if (event.key === "Escape") {
    closeSupplierLookup();
    return;
  }
  if (activeSupplierLookupIndex.value !== index || !supplierLookupOptions.value.length) {
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    supplierLookupCursor.value = Math.min(supplierLookupCursor.value + 1, supplierLookupOptions.value.length - 1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    supplierLookupCursor.value = Math.max(supplierLookupCursor.value - 1, 0);
    return;
  }
  if (event.key === "Enter" || (event.key === "Tab" && !event.shiftKey)) {
    event.preventDefault();
    const option = supplierLookupOptions.value[supplierLookupCursor.value] ?? supplierLookupOptions.value[0];
    if (option) {
      selectInlineSupplier(option, index);
    }
  }
}

function selectInlineSupplier(option: MasterOption, index: number) {
  applySupplierOption(option, index);
}

function closeSupplierLookupLater() {
  if (supplierLookupCloseTimer != null) {
    window.clearTimeout(supplierLookupCloseTimer);
  }
  supplierLookupCloseTimer = window.setTimeout(() => closeSupplierLookup(), 120);
}

function closeSupplierLookup() {
  supplierLookupRequestSeq += 1;
  activeSupplierLookupIndex.value = null;
  supplierLookupOptions.value = [];
  supplierLookupCursor.value = 0;
  if (supplierLookupCloseTimer != null) {
    window.clearTimeout(supplierLookupCloseTimer);
    supplierLookupCloseTimer = undefined;
  }
}

function masterRowToSupplierOption(row: Record<string, unknown>): MasterOption {
  const option: MasterOption = { code: "", name: "" };
  Object.entries(row).forEach(([key, value]) => {
    option[key] = value == null ? "" : String(value);
  });
  option.id = row.id == null ? undefined : String(row.id);
  option.code = text(row.code);
  option.name = text(row.name);
  return option;
}

function isEligibleSupplierOption(option: MasterOption) {
  return Boolean(option.code)
    && text(option.auditStatus) === "已审核"
    && text(option.status) === "启用";
}

async function save() {
  if (!form.billNo || !isDraft.value) {
    return;
  }
  if (!hasValidLines.value) {
    message.value = "采购申请必须保留至少一行，且申请数量必须大于 0。";
    return;
  }
  const result = await savePurchaseRequisitionDraft({
    billNo: form.billNo,
    version: optionalNumber(form.version),
    lines: entryLines.value.map((line) => ({
      id: line.id,
      qty: Number(line.qty),
      supplierCode: line.supplierCode.trim()
    }))
  });
  if (!result.ok || !result.data) {
    message.value = result.message || "采购申请保存失败。";
    return;
  }
  applyDetail(result.data);
  message.value = `采购申请已保存：${form.billNo}`;
  emit("clearDirty");
}

async function audit() {
  if (!form.billNo || props.dirty || !isDraft.value) {
    return;
  }
  const result = await auditPurchaseRequisition(form.billNo);
  applyLifecycleResult(result, "采购申请已审核");
}

async function reverse() {
  if (!form.billNo || props.dirty || status.value !== "AUDITED") {
    return;
  }
  const result = await reversePurchaseRequisition(form.billNo);
  applyLifecycleResult(result, "采购申请已反审核，状态回到草稿");
}

async function pushDown() {
  if (!form.billNo || props.dirty || status.value !== "AUDITED") {
    return;
  }
  const billNo = form.billNo;
  const result = await pushDownPurchaseRequisition(billNo);
  if (!result.ok || !result.data) {
    message.value = result.message || "采购申请下推失败。";
    return;
  }
  const purchasePlans = Array.isArray(result.data.purchasePlans) ? result.data.purchasePlans : [];
  const planNumbers = purchasePlans.map((plan) => text(plan.billNo)).filter(Boolean);
  const successMessage = `已按供应商下推采购计划 ${purchasePlans.length} 张${planNumbers.length ? `（${planNumbers.join("、")}）` : ""}`;
  const refreshed = await loadDocument(billNo);
  message.value = refreshed ? successMessage : `${successMessage}；详情刷新失败，请重新打开本单。`;
}

function applyLifecycleResult(
  result: { ok: boolean; message: string; data?: PurchaseRequisitionDetail },
  successMessage: string
) {
  if (!result.ok || !result.data) {
    message.value = result.message || "采购申请状态处理失败。";
    return;
  }
  applyDetail(result.data);
  message.value = successMessage;
  emit("clearDirty");
}

function applyDetail(detail: PurchaseRequisitionDetail) {
  const document = detail.document;
  form.billNo = text(document.billNo);
  form.sourcePlanNo = text(document.sourcePlanNo);
  form.billDate = text(document.billDate);
  form.department = text(document.department);
  form.version = text(document.version);
  status.value = text(document.status) || "DRAFT";
  const lines = Array.isArray(detail.lines) ? detail.lines.map(lineFromData) : [];
  entryLines.value.splice(0, entryLines.value.length, ...lines);
}

function lineFromData(line: PurchaseRequisitionLine): PurchasePlanningEntryLine {
  return {
    localId: text(line.id) || crypto.randomUUID(),
    id: text(line.id),
    lineNo: line.lineNo,
    sourceLevel: line.sourceLevel,
    sourceBomCode: text(line.sourceBomCode),
    sourceBomLineNo: line.sourceBomLineNo,
    productCode: text(line.productCode),
    productName: text(line.productName),
    spec: text(line.spec),
    unit: text(line.unit),
    qty: numberValue(line.qty),
    orderedQty: line.orderedQty,
    plannedQty: line.plannedQty,
    remainingQty: line.remainingQty,
    warehouseCode: text(line.warehouseCode),
    planDeliveryDate: text(line.planDeliveryDate),
    supplierCode: text(line.supplierCode),
    supplierName: text(line.supplierName)
  };
}

function backendStatusLabel(value: string) {
  if (value === "AUDITED") {
    return "已审核";
  }
  if (value === "REVERSED") {
    return "已反审核";
  }
  return "草稿";
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalNumber(value: unknown) {
  if (value == null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function text(value: unknown) {
  return value == null ? "" : String(value);
}

onMounted(() => {
  if (!form.billNo) {
    startNew();
  }
});

defineExpose({ startNew, loadDocument });
</script>

<style scoped>
.purchase-requisition-form {
  min-width: 1180px;
}

.purchase-requisition-fields {
  grid-template-columns: repeat(4, minmax(190px, 1fr));
}
</style>
