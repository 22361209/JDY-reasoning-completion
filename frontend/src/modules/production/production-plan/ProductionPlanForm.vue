<template>
  <section class="master-record-page production-plan-form" data-testid="production-plan-form">
    <header class="master-record-head production-plan-head">
      <div class="master-record-title-row">
        <h2>{{ title }}</h2>
        <span class="master-record-status">已审核</span>
      </div>
      <div class="master-record-toolbar">
        <button type="button" data-testid="production-plan-new" @click="startNew">新增</button>
        <button class="primary-action" type="button" data-testid="production-plan-save" @click="save">保存</button>
        <button type="button" data-testid="production-plan-push-down" :disabled="dirty || !form.billNo" @click="pushDown">下推</button>
        <button type="button" data-testid="production-plan-back-list" @click="emit('showExisting')">列表</button>
        <span v-if="dirty" class="production-message warn">有未保存改动</span>
        <span v-if="message" class="production-message" :class="{ error: hasError }" data-testid="production-plan-message">{{ message }}</span>
      </div>
    </header>

    <div class="master-record-body">
      <section class="master-record-section">
        <h3>计划信息</h3>
        <div class="production-plan-fields">
          <label>
            <span>计划单号</span>
            <input v-model.trim="form.billNo" data-testid="production-plan-bill-no" readonly />
          </label>
          <label>
            <span>来源类型</span>
            <select v-model="form.sourceType" data-testid="production-plan-source-type" @change="markDirty">
              <option value="SELF">自发计划</option>
              <option value="SALES">销售需求</option>
            </select>
          </label>
          <label>
            <span>完工仓库</span>
            <input v-model.trim="form.warehouseCode" data-testid="production-plan-warehouse-code" placeholder="空则取母件默认仓库" @input="markDirty" />
          </label>
          <label>
            <span>生产部门</span>
            <input v-model.trim="form.departmentCode" data-testid="production-plan-department-code" placeholder="空则取母件默认车间" @input="markDirty" />
          </label>
        </div>
      </section>

      <section class="production-plan-entry-section">
        <div class="entry-toolbar">
          <strong>生产计划分录</strong>
          <span>按母件编码自动选用当前可用 BOM</span>
        </div>
        <div class="entry-table-wrap">
          <table class="production-plan-entry-table">
            <thead>
              <tr>
                <th class="entry-index">序号</th>
                <th>母件编码</th>
                <th>物料名称</th>
                <th>规格型号</th>
                <th>BOM</th>
                <th>BOM版本</th>
                <th>单位</th>
                <th class="number-col">数量</th>
                <th>交期</th>
                <th class="number-col">在制未完工</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td class="entry-index">1</td>
                <td>
                  <input v-model.trim="form.productCode" data-testid="production-plan-product-code" placeholder="输入母件编码" @input="markDirty" />
                </td>
                <td>{{ saved.productName }}</td>
                <td>{{ saved.spec }}</td>
                <td>{{ saved.bomCode || form.bomCode }}</td>
                <td>{{ saved.bomVersionNo }}</td>
                <td>{{ saved.unit }}</td>
                <td>
                  <input v-model.number="form.qty" class="number-input" data-testid="production-plan-qty" type="number" min="0" step="1" @input="markDirty" />
                </td>
                <td>
                  <input v-model.trim="form.planDeliveryDate" data-testid="production-plan-delivery-date" placeholder="2026-06-30" @input="markDirty" />
                </td>
                <td class="number-col">{{ saved.inProgressQty }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
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
const form = reactive({
  billNo: "",
  productCode: "",
  bomCode: "",
  warehouseCode: "",
  qty: 1,
  planDeliveryDate: todayText(),
  sourceType: "SELF",
  departmentCode: ""
});

const saved = reactive({
  productName: "",
  spec: "",
  bomCode: "",
  bomVersionNo: "",
  unit: "",
  inProgressQty: "0"
});

function markDirty() {
  emit("markDirty");
  message.value = "";
  hasError.value = false;
}

async function startNew() {
  resetSaved();
  form.productCode = "";
  form.bomCode = "";
  form.warehouseCode = "";
  form.qty = 1;
  form.planDeliveryDate = todayText();
  form.sourceType = "SELF";
  form.departmentCode = "";
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
    productCode: form.productCode.trim(),
    bomCode: form.bomCode.trim(),
    warehouseCode: form.warehouseCode.trim(),
    qty: Number(form.qty) || 0,
    sourceType: form.sourceType,
    departmentCode: form.departmentCode.trim(),
    planDeliveryDate: form.planDeliveryDate.trim()
  });
  if (!result.ok) {
    hasError.value = true;
    message.value = result.message;
    return;
  }
  hasError.value = false;
  message.value = `生产计划已保存：${String(result.data?.billNo ?? "")}`;
  form.billNo = String(result.data?.billNo ?? form.billNo);
  saved.productName = String(result.data?.productName ?? "");
  saved.spec = String(result.data?.spec ?? "");
  saved.bomCode = String(result.data?.bomCode ?? "");
  saved.bomVersionNo = String(result.data?.bomVersionNo ?? "");
  saved.unit = String(result.data?.unit ?? "");
  saved.inProgressQty = String(result.data?.inProgressQty ?? "0");
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
  saved.productName = "";
  saved.spec = "";
  saved.bomCode = "";
  saved.bomVersionNo = "";
  saved.unit = "";
  saved.inProgressQty = "0";
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
  display: grid;
  grid-template-columns: repeat(4, minmax(180px, 1fr));
  gap: 10px 14px;
}

.production-plan-fields label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #516076;
}

.production-plan-fields input,
.production-plan-fields select,
.production-plan-entry-table input {
  height: 26px;
  border: 1px solid #cad8e8;
  border-radius: 3px;
  padding: 0 8px;
  font-size: 13px;
  color: #1f2d3d;
  background: #fff;
}

.production-plan-fields input[readonly] {
  background: #f6f8fb;
}

.production-plan-entry-section {
  border: 1px solid #d7e1ee;
  background: #fff;
}

.entry-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 32px;
  padding: 0 10px;
  border-bottom: 1px solid #d7e1ee;
  background: #f5f8fb;
  font-size: 12px;
}

.entry-toolbar span {
  color: #6d7c91;
}

.entry-table-wrap {
  overflow: auto;
}

.production-plan-entry-table {
  min-width: 1120px;
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 13px;
}

.production-plan-entry-table th,
.production-plan-entry-table td {
  height: 30px;
  border-right: 1px solid #dce6f1;
  border-bottom: 1px solid #dce6f1;
  padding: 0 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.production-plan-entry-table th {
  background: #f1f5f9;
  color: #34465d;
  font-weight: 600;
  text-align: left;
}

.entry-index {
  width: 46px;
  text-align: center;
  color: #5d6e82;
}

.number-col,
.number-input {
  text-align: right;
}

.production-message {
  color: #16734a;
  font-size: 12px;
}

.production-message.warn,
.production-message.error {
  color: #b44b37;
}
</style>
