<template>
  <section class="master-record-page production-lite-form" data-testid="outsourcing-surface-form">
    <header class="master-record-head">
      <div class="master-record-title-row">
        <h2>{{ title }}</h2>
        <span class="master-record-status">{{ statusLabel }}</span>
      </div>
      <div class="master-record-toolbar">
        <button type="button" data-testid="outsourcing-surface-new" @click="startNew">新增</button>
        <button class="primary-action" type="button" data-testid="outsourcing-surface-save" @click="save">保存</button>
        <button type="button" :disabled="!form.billNo" data-testid="outsourcing-surface-audit" @click="audit">审核</button>
        <button type="button" :disabled="statusLabel !== '已发出'" data-testid="outsourcing-surface-complete" @click="complete">完成</button>
        <button type="button" data-testid="outsourcing-surface-back-list" @click="emit('showExisting')">列表</button>
        <span v-if="dirty" class="production-message warn">有未保存改动</span>
        <span v-if="message" class="production-message" :class="{ error: hasError }" data-testid="outsourcing-surface-message">{{ message }}</span>
      </div>
    </header>

    <div class="master-record-body">
      <section class="master-record-section">
        <h3>委外表面处理</h3>
        <div class="master-record-fields">
          <label>
            <span>委外单号</span>
            <input v-model.trim="form.billNo" data-testid="outsourcing-surface-bill-no" placeholder="保存后生成" @input="markDirty" />
          </label>
          <label>
            <span>来源产品入库单</span>
            <input v-model.trim="form.sourceBillNo" data-testid="outsourcing-surface-source-bill-no" placeholder="如 CPRK000001，可空" @input="markDirty" />
          </label>
          <label>
            <span>物料编码</span>
            <input v-model.trim="form.productCode" data-testid="outsourcing-surface-product-code" placeholder="无来源单时必填" @input="markDirty" />
          </label>
          <label class="required">
            <span>委外数量</span>
            <input v-model.number="form.qty" data-testid="outsourcing-surface-qty" type="number" min="0" step="1" @input="markDirty" />
          </label>
          <label>
            <span>处理供应商</span>
            <input v-model.trim="form.processorSupplierCode" data-testid="outsourcing-surface-supplier-code" placeholder="如 GYS001，可空" @input="markDirty" />
          </label>
          <label>
            <span>表面处理</span>
            <input v-model.trim="form.surfaceTreatment" data-testid="outsourcing-surface-treatment" placeholder="如 电泳、磷化、达克罗" @input="markDirty" />
          </label>
          <label class="master-record-field-wide">
            <span>备注</span>
            <textarea v-model.trim="form.remark" data-testid="outsourcing-surface-remark" rows="3" @input="markDirty"></textarea>
          </label>
        </div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { reactive, ref } from "vue";
import { auditOutsourcingSurface, completeOutsourcingSurface, saveOutsourcingSurface } from "../../../services/outsourcingApi";

const props = defineProps<{
  title: string;
  dirty: boolean;
}>();

const emit = defineEmits<{
  markDirty: [];
  clearDirty: [];
  showExisting: [];
}>();

const statusLabel = ref("草稿");
const message = ref("");
const hasError = ref(false);
const form = reactive({
  billNo: "",
  sourceBillNo: "",
  productCode: "",
  qty: 1,
  processorSupplierCode: "",
  surfaceTreatment: "",
  remark: ""
});

function markDirty() {
  emit("markDirty");
  message.value = "";
  hasError.value = false;
}

function startNew() {
  form.billNo = "";
  form.sourceBillNo = "";
  form.productCode = "";
  form.qty = 1;
  form.processorSupplierCode = "";
  form.surfaceTreatment = "";
  form.remark = "";
  statusLabel.value = "草稿";
  message.value = "";
  hasError.value = false;
  emit("markDirty");
}

async function save() {
  const result = await saveOutsourcingSurface({
    billNo: form.billNo.trim(),
    sourceBillNo: form.sourceBillNo.trim(),
    productCode: form.productCode.trim(),
    qty: Number(form.qty) || 0,
    processorSupplierCode: form.processorSupplierCode.trim(),
    surfaceTreatment: form.surfaceTreatment.trim(),
    remark: form.remark.trim()
  });
  if (!result.ok) {
    hasError.value = true;
    message.value = result.message;
    return false;
  }
  form.billNo = String(result.data?.billNo ?? form.billNo);
  statusLabel.value = "草稿";
  hasError.value = false;
  message.value = `委外表面处理单已保存：${form.billNo}`;
  emit("clearDirty");
  return true;
}

async function audit() {
  if (!form.billNo && !(await save())) {
    return;
  }
  const result = await auditOutsourcingSurface(form.billNo);
  if (!result.ok) {
    hasError.value = true;
    message.value = result.message;
    return;
  }
  statusLabel.value = "已发出";
  hasError.value = false;
  message.value = `委外表面处理单已审核：${form.billNo}`;
  emit("clearDirty");
}

async function complete() {
  if (!form.billNo) {
    return;
  }
  const result = await completeOutsourcingSurface(form.billNo);
  if (!result.ok) {
    hasError.value = true;
    message.value = result.message;
    return;
  }
  statusLabel.value = "已完成";
  hasError.value = false;
  message.value = `委外表面处理单已完成：${form.billNo}`;
  emit("clearDirty");
}

defineExpose({ startNew });

void props;
</script>

<style scoped>
.production-lite-form {
  min-width: 960px;
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
