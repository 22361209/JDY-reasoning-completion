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
    :can-save="false"
    :can-audit="canAudit"
    :can-reverse="canReverse"
    :can-void="false"
    :can-delete="canDelete"
    :can-output="false"
    :show-create="false"
    :show-save="false"
    :show-audit="true"
    :show-reverse="true"
    :show-red-reverse="false"
    :show-void="false"
    :show-close="false"
    :show-unclose="false"
    :show-freeze="false"
    :show-unfreeze="false"
    :show-delete="true"
    :show-export="false"
    :show-print="false"
    :show-push-down="true"
    :can-push-down="canPushDown"
    push-down-label="下推采购订单"
    push-down-test-id="purchase-plan-push-down-order"
    data-testid="purchase-plan-form"
    @audit="audit"
    @reverse="reverse"
    @delete-document="remove"
    @push-down="pushDownOrder"
  >
    <div class="form-layout purchase-plan-form">
      <section class="form-head-fields purchase-plan-fields">
        <label>
          计划单号
          <input v-model="form.billNo" data-testid="purchase-plan-bill-no" readonly />
        </label>
        <label>
          来源采购申请
          <input v-model="form.sourceRequisitionNo" data-testid="purchase-plan-source-requisition-no" readonly />
        </label>
        <label>
          供应商编码
          <input v-model="form.supplierCode" data-testid="purchase-plan-supplier-code" readonly />
        </label>
        <label>
          供应商名称
          <input v-model="form.supplierName" data-testid="purchase-plan-supplier-name" readonly />
        </label>
        <label>
          单据日期
          <input v-model="form.billDate" data-testid="purchase-plan-bill-date" readonly />
        </label>
        <label>
          部门
          <input v-model="form.department" data-testid="purchase-plan-department" readonly />
        </label>
        <label>
          单据状态
          <input :value="statusLabel" data-testid="purchase-plan-status" readonly />
        </label>
        <label>
          版本
          <input v-model="form.version" data-testid="purchase-plan-version" readonly />
        </label>
      </section>

      <PurchasePlanningEntryTable
        mode="plan"
        :lines="entryLines"
        :is-draft="false"
        :supplier-options="[]"
        :active-supplier-lookup-index="null"
        :supplier-lookup-cursor="0"
      />
    </div>
  </StandardDocument>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import StandardDocument from "../../../components/StandardDocument.vue";
import {
  auditPurchasePlan,
  deletePurchasePlanDraft,
  fetchPurchasePlanDetail,
  pushDownPurchaseOrder,
  reversePurchasePlan,
  type PurchasePlanDetail,
  type PurchasePlanLine
} from "../../../services/purchasePlanningApi";
import PurchasePlanningEntryTable, { type PurchasePlanningEntryLine } from "../purchase-requisition/PurchasePlanningEntryTable.vue";

const props = defineProps<{
  title: string;
  dirty: boolean;
}>();

const emit = defineEmits<{
  markDirty: [];
  clearDirty: [];
  showExisting: [];
  pushDownPurchaseOrder: [billNo: string];
}>();

const message = ref("");
const status = ref("DRAFT");
const hasRemainingOrderQty = ref(false);
let detailRequestSeq = 0;
const form = reactive({
  billNo: "",
  sourceRequisitionNo: "",
  supplierCode: "",
  supplierName: "",
  billDate: "",
  department: "",
  version: ""
});
const entryLines = ref<PurchasePlanningEntryLine[]>([]);

const statusLabel = computed(() => backendStatusLabel(status.value));
const canAudit = computed(() => Boolean(form.billNo) && !props.dirty && status.value === "DRAFT");
const canReverse = computed(() => Boolean(form.billNo) && !props.dirty && status.value === "AUDITED");
const canDelete = computed(() => Boolean(form.billNo) && !props.dirty && status.value === "DRAFT");
const canPushDown = computed(() => Boolean(form.billNo) && !props.dirty && status.value === "AUDITED" && hasRemainingOrderQty.value);

function startNew() {
  message.value = "采购计划由已审核采购申请按供应商下推生成，不支持手工新增。";
}

async function loadDocument(billNo: string) {
  const requestSeq = detailRequestSeq + 1;
  detailRequestSeq = requestSeq;
  const result = await fetchPurchasePlanDetail(billNo);
  if (requestSeq !== detailRequestSeq) {
    return false;
  }
  if (!result.ok || !result.data) {
    message.value = result.message || "采购计划加载失败。";
    return false;
  }
  applyDetail(result.data);
  message.value = "";
  emit("clearDirty");
  return true;
}

async function audit() {
  if (!form.billNo || props.dirty || status.value !== "DRAFT") {
    return;
  }
  const result = await auditPurchasePlan(form.billNo);
  applyLifecycleResult(result, "采购计划已审核");
}

async function reverse() {
  if (!form.billNo || props.dirty || status.value !== "AUDITED") {
    return;
  }
  const result = await reversePurchasePlan(form.billNo);
  applyLifecycleResult(result, "采购计划已反审核，状态回到草稿");
}

async function remove() {
  if (!canDelete.value) {
    return;
  }
  const deletedBillNo = form.billNo;
  if (!window.confirm(`确定删除草稿采购计划 ${deletedBillNo} 吗？此操作不可恢复，原计划编号不复用；删除后可按采购申请剩余数量重新下推。`)) {
    return;
  }
  const result = await deletePurchasePlanDraft(deletedBillNo);
  if (!result.ok) {
    message.value = result.message || "采购计划删除失败。";
    return;
  }
  clearDocument();
  message.value = `采购计划草稿 ${deletedBillNo} 已永久删除，原编号不复用；可从采购申请重新下推。`;
}

async function pushDownOrder() {
  if (!canPushDown.value) {
    return;
  }
  const result = await pushDownPurchaseOrder(form.billNo);
  if (!result.ok || !result.data?.purchaseOrderBillNo) {
    message.value = result.message || "采购计划下推采购订单失败。";
    return;
  }
  message.value = `已由采购计划 ${form.billNo} 生成采购订单草稿 ${result.data.purchaseOrderBillNo}`;
  emit("pushDownPurchaseOrder", result.data.purchaseOrderBillNo);
}

function applyLifecycleResult(
  result: { ok: boolean; message: string; data?: PurchasePlanDetail },
  successMessage: string
) {
  if (!result.ok || !result.data) {
    message.value = result.message || "采购计划状态处理失败。";
    return;
  }
  applyDetail(result.data);
  message.value = successMessage;
  emit("clearDirty");
}

function applyDetail(detail: PurchasePlanDetail) {
  const document = detail.document;
  form.billNo = text(document.billNo);
  form.sourceRequisitionNo = text(document.sourceRequisitionNo);
  form.supplierCode = text(document.supplierCode);
  form.supplierName = text(document.supplierName);
  form.billDate = text(document.billDate);
  form.department = text(document.department);
  form.version = text(document.version);
  status.value = text(document.status) || "DRAFT";
  const detailLines = Array.isArray(detail.lines) ? detail.lines : [];
  hasRemainingOrderQty.value = detailLines.some(line => numberValue(line.remainingOrderQty) > 0);
  const lines = detailLines.map(lineFromData);
  entryLines.value.splice(0, entryLines.value.length, ...lines);
}

function clearDocument() {
  detailRequestSeq += 1;
  form.billNo = "";
  form.sourceRequisitionNo = "";
  form.supplierCode = "";
  form.supplierName = "";
  form.billDate = "";
  form.department = "";
  form.version = "";
  status.value = "DRAFT";
  hasRemainingOrderQty.value = false;
  entryLines.value.splice(0, entryLines.value.length);
  emit("clearDirty");
}

function lineFromData(line: PurchasePlanLine): PurchasePlanningEntryLine {
  return {
    localId: text(line.id) || crypto.randomUUID(),
    id: text(line.id),
    lineNo: line.lineNo,
    sourceRequisitionLineNo: line.sourceRequisitionLineNo,
    productCode: text(line.productCode),
    productName: text(line.productName),
    spec: text(line.spec),
    unit: text(line.unit),
    qty: numberValue(line.qty),
    warehouseCode: text(line.warehouseCode),
    planDeliveryDate: text(line.planDeliveryDate),
    supplierCode: form.supplierCode,
    supplierName: form.supplierName
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
.purchase-plan-form {
  min-width: 1180px;
}

.purchase-plan-fields {
  grid-template-columns: repeat(4, minmax(190px, 1fr));
}
</style>
