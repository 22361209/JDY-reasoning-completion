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
    :can-save="true"
    :can-audit="false"
    :can-reverse="false"
    :can-void="false"
    :can-delete="false"
    :can-output="false"
    :show-audit="false"
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
    :show-push-down="true"
    :can-push-down="Boolean(form.billNo) && !dirty"
    push-down-label="下推"
    push-down-test-id="production-plan-push-down"
    data-testid="production-plan-form"
    @create="startNew"
    @save="save"
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
          <select v-model="form.sourceType" data-testid="production-plan-source-type" @change="markDirty">
            <option value="SELF">自发计划</option>
            <option value="SALES">销售需求</option>
          </select>
        </label>
        <label>
          完工仓库
          <input v-model.trim="form.warehouseCode" data-testid="production-plan-warehouse-code" placeholder="空则取母件默认仓库" @input="markDirty" />
        </label>
        <label>
          生产部门
          <input v-model.trim="form.departmentCode" data-testid="production-plan-department-code" placeholder="空则取母件默认车间" @input="markDirty" />
        </label>
      </section>

      <ProductionPlanEntryTable
        :lines="entryLines"
        :is-draft="true"
        @mark-dirty="markDirty"
      />
    </div>
  </StandardDocument>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import ProductionPlanEntryTable, { type ProductionPlanEntryLine } from "../../../components/ProductionPlanEntryTable.vue";
import StandardDocument from "../../../components/StandardDocument.vue";
import { createProductionPlan, nextProductionPlanNumber, pushDownProductionPlan } from "../../../services/productionApi";

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
const statusLabel = ref("草稿");
const form = reactive({
  billNo: "",
  bomCode: "",
  warehouseCode: "",
  sourceType: "SELF",
  departmentCode: ""
});

const entryLine = reactive<ProductionPlanEntryLine>({
  localId: "production-plan-line-1",
  productCode: "",
  productName: "",
  spec: "",
  bomCode: "",
  bomVersionNo: "",
  unit: "",
  qty: 1,
  planDeliveryDate: todayText(),
  inProgressQty: "0"
});

const entryLines = computed(() => [entryLine]);
const displayMessage = computed(() => hasError.value ? message.value : message.value);

function markDirty() {
  emit("markDirty");
  message.value = "";
  hasError.value = false;
}

async function startNew() {
  resetSaved();
  form.bomCode = "";
  form.warehouseCode = "";
  entryLine.productCode = "";
  entryLine.qty = 1;
  entryLine.planDeliveryDate = todayText();
  form.sourceType = "SELF";
  form.departmentCode = "";
  statusLabel.value = "草稿";
  message.value = "";
  hasError.value = false;
  const result = await nextProductionPlanNumber();
  form.billNo = result.ok ? String(result.data?.billNo ?? "") : "";
  if (!result.ok) {
    hasError.value = true;
    message.value = result.message;
    return;
  }
  emit("markDirty");
}

async function save() {
  const result = await createProductionPlan({
    billNo: form.billNo.trim(),
    productCode: entryLine.productCode.trim(),
    bomCode: form.bomCode.trim(),
    warehouseCode: form.warehouseCode.trim(),
    qty: Number(entryLine.qty) || 0,
    sourceType: form.sourceType,
    departmentCode: form.departmentCode.trim(),
    planDeliveryDate: entryLine.planDeliveryDate.trim()
  });
  if (!result.ok) {
    hasError.value = true;
    message.value = result.message;
    return;
  }
  hasError.value = false;
  message.value = `生产计划已保存：${String(result.data?.billNo ?? "")}`;
  form.billNo = String(result.data?.billNo ?? form.billNo);
  entryLine.productCode = String(result.data?.productCode ?? entryLine.productCode);
  entryLine.productName = String(result.data?.productName ?? "");
  entryLine.spec = String(result.data?.spec ?? "");
  entryLine.bomCode = String(result.data?.bomCode ?? "");
  entryLine.bomVersionNo = String(result.data?.bomVersionNo ?? "");
  entryLine.unit = String(result.data?.unit ?? "");
  entryLine.inProgressQty = String(result.data?.inProgressQty ?? "0");
  statusLabel.value = backendStatusLabel(String(result.data?.status ?? "AUDITED"));
  emit("clearDirty");
}

async function pushDown() {
  if (!form.billNo || props.dirty) {
    return;
  }
  const result = await pushDownProductionPlan(form.billNo);
  if (!result.ok) {
    hasError.value = true;
    message.value = result.message;
    return;
  }
  const productionTasks = result.data?.productionTasks;
  const purchaseRequisitions = result.data?.purchaseRequisitions;
  const tasks = Array.isArray(productionTasks) ? productionTasks.length : 0;
  const requisitions = Array.isArray(purchaseRequisitions) ? purchaseRequisitions.length : 0;
  hasError.value = false;
  message.value = `已下推：生产任务 ${tasks} 张，采购申请 ${requisitions} 张`;
}

function resetSaved() {
  entryLine.productName = "";
  entryLine.spec = "";
  entryLine.bomCode = "";
  entryLine.bomVersionNo = "";
  entryLine.unit = "";
  entryLine.inProgressQty = "0";
}

function backendStatusLabel(status: string) {
  return status === "AUDITED" ? "已审核" : "草稿";
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
    void startNew();
  }
});

defineExpose({ startNew });
</script>

<style scoped>
.production-plan-form {
  min-width: 1120px;
}

.production-plan-fields {
  grid-template-columns: repeat(4, minmax(160px, 1fr));
}
</style>
