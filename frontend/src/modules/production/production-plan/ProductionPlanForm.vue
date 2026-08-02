<template>
  <StandardDocument
    :title="title"
    subtitle=""
    :show-subtitle="false"
    :status-label="statusLabel"
    status-class="form"
    :locked="false"
    :dirty="dirty"
    :message="displayMessage"
    :can-save="canSave"
    :can-audit="canAudit"
    :can-reverse="canReverse"
    :can-void="false"
    :can-delete="false"
    :can-output="false"
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
    push-down-test-id="production-plan-push-down"
    data-testid="production-plan-form"
    @create="startNew"
    @save="save"
    @audit="audit"
    @reverse="reverse"
    @push-down="pushDown"
  >
    <div class="form-layout production-plan-form">
      <section class="form-head-fields production-plan-fields">
        <label>
          计划单号
          <input v-model.trim="form.billNo" data-testid="production-plan-bill-no" readonly />
        </label>
        <label>
          来源类型
          <select v-model="form.sourceType" data-testid="production-plan-source-type" :disabled="!isDraft" @change="markDirty">
            <option value="SELF">自发计划</option>
            <option value="SALES">销售需求</option>
          </select>
        </label>
        <label>
          统一完工仓库
          <input v-model.trim="form.warehouseCode" data-testid="production-plan-default-warehouse-code" :disabled="!isDraft" placeholder="可空；优先取分录或母件默认仓库" @input="markDirty" />
        </label>
        <label>
          统一生产部门
          <input v-model.trim="form.departmentCode" data-testid="production-plan-default-department-code" :disabled="!isDraft" placeholder="可空；优先取分录或母件默认车间" @input="markDirty" />
        </label>
      </section>

      <ProductionPlanEntryTable
        :lines="entryLines"
        :is-draft="isDraft"
        @mark-dirty="markDirty"
        @append-line="appendLine"
        @insert-line-after="insertLineAfter"
        @remove-line="removeLine"
        @open-product-selector="openProductSelector"
      />
    </div>
  </StandardDocument>

  <MasterSelectorDialog
    :open="productSelectorOpen"
    type="product"
    title="选择生产计划母件"
    label="物料"
    :keyword="productSelectorKeyword"
    @close="closeProductSelector"
    @select="selectProduct"
  />
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import type { MasterOption } from "../../../components/entry-table/types";
import MasterSelectorDialog from "../../../components/MasterSelectorDialog.vue";
import ProductionPlanEntryTable, { type ProductionPlanEntryLine } from "../../../components/ProductionPlanEntryTable.vue";
import StandardDocument from "../../../components/StandardDocument.vue";
import {
  auditProductionPlan,
  createProductionPlan,
  fetchProductionPlanDetail,
  pushDownProductionPlan,
  reverseProductionPlan
} from "../../../services/productionApi";

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
const hasError = ref(false);
const status = ref("DRAFT");
const productSelectorOpen = ref(false);
const productSelectorLineIndex = ref<number | null>(null);
const productSelectorKeyword = ref("");
const form = reactive({
  billNo: "",
  warehouseCode: "",
  sourceType: "SELF",
  departmentCode: ""
});
const entryLines = ref<ProductionPlanEntryLine[]>([blankLine()]);

const displayMessage = computed(() => message.value);
const statusLabel = computed(() => backendStatusLabel(status.value));
const isDraft = computed(() => status.value === "DRAFT");
const hasValidLine = computed(() => entryLines.value.some((line) => line.productCode.trim() && Number(line.qty) > 0));
const canSave = computed(() => isDraft.value && hasValidLine.value);
const canAudit = computed(() => Boolean(form.billNo) && !props.dirty && isDraft.value);
const canReverse = computed(() => Boolean(form.billNo) && !props.dirty && status.value === "AUDITED");
const canPushDown = computed(() => Boolean(form.billNo) && !props.dirty && status.value === "AUDITED");

function blankLine(): ProductionPlanEntryLine {
  return {
    localId: crypto.randomUUID(),
    productId: "",
    productCode: "",
    productName: "",
    spec: "",
    bomCode: "",
    bomVersionNo: "",
    unit: "",
    warehouseCode: "",
    departmentCode: "",
    qty: 1,
    planDeliveryDate: todayText(),
    inProgressQty: "0",
    assignedQty: "0",
    remainingQty: "1"
  };
}

function markDirty() {
  emit("markDirty");
  message.value = "";
  hasError.value = false;
}

function startNew() {
  closeProductSelector();
  form.billNo = "";
  form.warehouseCode = "";
  form.sourceType = "SELF";
  form.departmentCode = "";
  entryLines.value.splice(0, entryLines.value.length, blankLine());
  status.value = "DRAFT";
  message.value = "生产计划将在首次保存时生成编号";
  hasError.value = false;
  emit("markDirty");
}

async function loadPlan(billNo: string) {
  closeProductSelector();
  const result = await fetchProductionPlanDetail(billNo);
  if (!result.ok || !result.data) {
    hasError.value = true;
    message.value = result.message || "生产计划加载失败。";
    return;
  }
  applyPlanData(result.data);
  hasError.value = false;
  message.value = "";
  emit("clearDirty");
}

function appendLine() {
  entryLines.value.push(blankLine());
  markDirty();
}

function insertLineAfter(index: number) {
  entryLines.value.splice(index + 1, 0, blankLine());
  markDirty();
}

function removeLine(index: number) {
  if (entryLines.value.length <= 1) {
    return;
  }
  entryLines.value.splice(index, 1);
  markDirty();
}

function openProductSelector(index: number) {
  if (!isDraft.value) {
    return;
  }
  productSelectorLineIndex.value = index;
  productSelectorKeyword.value = entryLines.value[index]?.productCode ?? "";
  productSelectorOpen.value = true;
}

function closeProductSelector() {
  productSelectorOpen.value = false;
  productSelectorLineIndex.value = null;
  productSelectorKeyword.value = "";
}

function selectProduct(option: MasterOption) {
  const index = productSelectorLineIndex.value;
  if (index == null || !entryLines.value[index]) {
    closeProductSelector();
    return;
  }
  if (!isTruthy(option.isProduce)) {
    hasError.value = true;
    message.value = `物料 ${String(option.code ?? "")} 未启用“可自制”，不能作为生产计划母件`;
    return;
  }
  if (String(option.auditStatus ?? "已审核") !== "已审核" || String(option.status ?? "启用") !== "启用") {
    hasError.value = true;
    message.value = `物料 ${String(option.code ?? "")} 未审核或已禁用，不能用于生产计划`;
    return;
  }
  const line = entryLines.value[index];
  line.productId = String(option.id ?? "");
  line.productCode = String(option.code ?? "");
  line.productName = String(option.name ?? "");
  line.spec = String(option.spec ?? "");
  line.unit = String(option.unit ?? "");
  line.bomCode = "";
  line.bomVersionNo = "";
  line.warehouseCode = String(option.defaultWarehouseCode ?? line.warehouseCode ?? "");
  line.departmentCode = String(option.defaultWorkshopCode ?? "");
  closeProductSelector();
  markDirty();
}

async function save() {
  const lines = entryLines.value
    .filter((line) => line.productCode.trim())
    .map((line) => ({
      productId: line.productId.trim(),
      productCode: line.productCode.trim(),
      bomCode: line.bomCode.trim(),
      warehouseCode: line.warehouseCode.trim(),
      departmentCode: line.departmentCode.trim(),
      qty: Number(line.qty) || 0,
      planDeliveryDate: line.planDeliveryDate.trim()
    }));
  if (lines.length === 0) {
    hasError.value = true;
    message.value = "请至少选择一个生产计划母件。";
    return;
  }
  const result = await createProductionPlan({
    billNo: form.billNo.trim(),
    warehouseCode: form.warehouseCode.trim(),
    sourceType: form.sourceType,
    departmentCode: form.departmentCode.trim(),
    lines
  });
  if (!result.ok || !result.data) {
    hasError.value = true;
    message.value = result.message || "生产计划保存失败。";
    return;
  }
  applyPlanData(result.data);
  hasError.value = false;
  message.value = `生产计划已保存：${form.billNo}（${entryLines.value.length} 个型号）`;
  emit("clearDirty");
}

async function audit() {
  if (!form.billNo || props.dirty || !isDraft.value) {
    return;
  }
  const result = await auditProductionPlan(form.billNo);
  applyLifecycleResult(result, "生产计划已审核");
}

async function reverse() {
  if (!form.billNo || props.dirty || status.value !== "AUDITED") {
    return;
  }
  const result = await reverseProductionPlan(form.billNo);
  applyLifecycleResult(result, "生产计划已反审核，状态回到草稿");
}

async function pushDown() {
  if (!form.billNo || props.dirty || status.value !== "AUDITED") {
    return;
  }
  const result = await pushDownProductionPlan(form.billNo);
  if (!result.ok) {
    hasError.value = true;
    message.value = result.message;
    return;
  }
  const productionTasks = Array.isArray(result.data?.productionTasks)
    ? result.data?.productionTasks as Record<string, unknown>[]
    : [];
  const purchaseRequisitions = Array.isArray(result.data?.purchaseRequisitions)
    ? result.data?.purchaseRequisitions as Record<string, unknown>[]
    : [];
  const taskNumbers = productionTasks.map((task) => String(task.billNo ?? "")).filter(Boolean);
  hasError.value = false;
  message.value = `已下推：生产任务 ${productionTasks.length} 张${taskNumbers.length ? `（${taskNumbers.join("、")}）` : ""}，采购申请 ${purchaseRequisitions.length} 张`;
  await loadPlan(form.billNo);
  message.value = `已下推：生产任务 ${productionTasks.length} 张${taskNumbers.length ? `（${taskNumbers.join("、")}）` : ""}，采购申请 ${purchaseRequisitions.length} 张`;
}

function applyLifecycleResult(result: { ok: boolean; message: string; data?: Record<string, unknown> }, okMessage: string) {
  if (!result.ok) {
    hasError.value = true;
    message.value = result.message;
    return;
  }
  hasError.value = false;
  message.value = okMessage;
  status.value = String(result.data?.status ?? status.value);
  emit("clearDirty");
}

function applyPlanData(data: Record<string, unknown>) {
  form.billNo = text(data.billNo);
  form.sourceType = text(data.sourceType) || "SELF";
  status.value = text(data.status) || "DRAFT";
  const rows = Array.isArray(data.lines) ? data.lines as Record<string, unknown>[] : [];
  const lines = rows.map(lineFromData);
  entryLines.value.splice(0, entryLines.value.length, ...(lines.length ? lines : [blankLine()]));
}

function lineFromData(data: Record<string, unknown>): ProductionPlanEntryLine {
  return {
    localId: crypto.randomUUID(),
    id: text(data.id),
    lineNo: numberValue(data.lineNo, 0),
    productId: text(data.productId),
    productCode: text(data.productCode),
    productName: text(data.productName),
    spec: text(data.spec),
    bomCode: text(data.bomCode),
    bomVersionNo: text(data.bomVersionNo),
    unit: text(data.unit),
    warehouseCode: text(data.warehouseCode),
    departmentCode: text(data.departmentCode),
    qty: numberValue(data.qty, 1),
    planDeliveryDate: text(data.planDeliveryDate) || todayText(),
    inProgressQty: text(data.inProgressQty) || "0",
    assignedQty: text(data.assignedQty) || "0",
    remainingQty: text(data.remainingQty) || "0"
  };
}

function backendStatusLabel(value: string) {
  return value === "AUDITED" ? "已审核" : "草稿";
}

function isTruthy(value: unknown) {
  return ["true", "1", "yes", "是", "可自制"].includes(String(value ?? "").trim().toLowerCase());
}

function text(value: unknown) {
  return value == null ? "" : String(value);
}

function numberValue(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function todayText() {
  const date = new Date();
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

onMounted(() => {
  if (!form.billNo) {
    startNew();
  }
});

defineExpose({ startNew, loadPlan });
</script>

<style scoped>
.production-plan-form {
  min-width: 1180px;
}

.production-plan-fields {
  grid-template-columns: repeat(4, minmax(190px, 1fr));
}
</style>
