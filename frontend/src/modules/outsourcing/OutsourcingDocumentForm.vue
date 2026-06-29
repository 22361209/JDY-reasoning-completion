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
    :can-reverse="false"
    :can-void="false"
    :can-delete="false"
    :can-output="false"
    :show-reverse="false"
    :show-red-reverse="false"
    :show-void="false"
    :show-close="false"
    :show-unclose="false"
    :show-freeze="false"
    :show-unfreeze="false"
    :show-delete="false"
    :show-export="false"
    :show-print="false"
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
    @push-down="primaryPush"
    @extra-action="secondaryPush"
  >
    <div class="form-layout outsourcing-document-form">
      <section class="form-head-fields outsourcing-head-fields">
        <label>
          单据编号
          <input v-model.trim="form.billNo" :data-testid="`${testPrefix}-bill-no`" placeholder="保存/生成后返回" @input="markDirty" />
        </label>
        <label v-if="kind !== 'workOrder'">
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
        :is-draft="kind === 'workOrder' && statusLabel === '草稿'"
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
    </div>
  </StandardDocument>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import type { EntryLine, MasterOption } from "../../components/EntryTable.vue";
import EntryTable from "../../components/EntryTable.vue";
import StandardDocument from "../../components/StandardDocument.vue";
import { fetchListRows } from "../../services/listApi";
import {
  auditOutsourcingIssue,
  auditOutsourcingReceipt,
  auditOutsourcingReturn,
  auditOutsourcingScrap,
  auditOutsourcingWorkOrder,
  pushOutsourcingIssue,
  pushOutsourcingReceipt,
  pushOutsourcingReturn,
  pushOutsourcingScrap,
  saveOutsourcingWorkOrder
} from "../../services/outsourcingApi";

type OutsourcingKind = "workOrder" | "issue" | "receipt" | "return" | "scrap";

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

const testPrefix = computed(() => `outsourcing-${props.kind}`);
const canSave = computed(() => props.kind === "workOrder" || Boolean(form.sourceBillNo.trim()));
const showPrimaryPush = computed(() => props.kind === "workOrder" || props.kind === "receipt");
const canPrimaryPush = computed(() => statusLabel.value === "已审核" && Boolean(form.billNo.trim()));
const showSecondaryPush = computed(() => props.kind === "workOrder" || props.kind === "receipt");
const canSecondaryPush = computed(() => statusLabel.value === "已审核" && Boolean(form.billNo.trim()));
const primaryPushLabel = computed(() => props.kind === "receipt" ? "下推退货" : "下推发料");
const secondaryPushLabel = computed(() => props.kind === "receipt" ? "下推报废" : "下推入库");
const sourceLabel = computed(() => props.kind === "return" || props.kind === "scrap" ? "来源委外入库单" : "来源委外加工单");
const sourcePlaceholder = computed(() => props.kind === "return" || props.kind === "scrap" ? "如 WWRK000001" : "如 WWJG000001");
const entryTableColspan = computed(() => props.kind === "workOrder" ? 8 : 9);
const entryTotalColspan = computed(() => props.kind === "workOrder" ? 7 : 8);

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
  statusLabel.value = "草稿";
  message.value = "";
  emit("markDirty");
}

async function save() {
  const result = props.kind === "workOrder"
    ? await saveOutsourcingWorkOrder({
      billNo: form.billNo.trim(),
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

function todayText() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function backendStatusLabel(status: string) {
  return status === "AUDITED" ? "已审核" : "草稿";
}

function noop() {}

defineExpose({ startNew });
</script>

<style scoped>
.outsourcing-document-form {
  min-width: 1120px;
}

.outsourcing-head-fields {
  grid-template-columns: repeat(4, minmax(160px, 1fr));
}
</style>
