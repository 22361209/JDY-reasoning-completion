<template>
  <section class="master-record-page production-lite-form" data-testid="production-plan-form">
    <header class="master-record-head">
      <div class="master-record-title-row">
        <h2>{{ title }}</h2>
        <span class="master-record-status">已审核</span>
      </div>
      <div class="master-record-toolbar">
        <button type="button" data-testid="production-plan-new" @click="startNew">新增</button>
        <button class="primary-action" type="button" data-testid="production-plan-save" @click="save">保存</button>
        <button type="button" data-testid="production-plan-back-list" @click="emit('showExisting')">列表</button>
        <span v-if="dirty" class="production-message warn">有未保存改动</span>
        <span v-if="message" class="production-message" :class="{ error: hasError }" data-testid="production-plan-message">{{ message }}</span>
      </div>
    </header>

    <div class="master-record-body">
      <section class="master-record-section">
        <h3>计划信息</h3>
        <div class="master-record-fields">
          <label>
            <span>计划单号</span>
            <input v-model.trim="form.billNo" data-testid="production-plan-bill-no" placeholder="保存后生成" @input="markDirty" />
          </label>
          <label class="required">
            <span>BOM 编码</span>
            <input v-model.trim="form.bomCode" data-testid="production-plan-bom-code" @input="markDirty" />
          </label>
          <label class="required">
            <span>完工仓库</span>
            <input v-model.trim="form.warehouseCode" data-testid="production-plan-warehouse-code" @input="markDirty" />
          </label>
          <label class="required">
            <span>计划数量</span>
            <input v-model.number="form.qty" data-testid="production-plan-qty" type="number" min="0" step="1" @input="markDirty" />
          </label>
          <label>
            <span>生产部门</span>
            <input v-model.trim="form.departmentCode" data-testid="production-plan-department-code" @input="markDirty" />
          </label>
          <label>
            <span>来源类型</span>
            <select v-model="form.sourceType" data-testid="production-plan-source-type" @change="markDirty">
              <option value="SELF">自发计划</option>
              <option value="SALES">销售需求</option>
            </select>
          </label>
        </div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { reactive, ref } from "vue";
import { createProductionPlan } from "../../../services/productionApi";

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
  bomCode: "",
  warehouseCode: "CK-001",
  qty: 1,
  sourceType: "SELF",
  departmentCode: ""
});

function markDirty() {
  emit("markDirty");
  message.value = "";
  hasError.value = false;
}

function startNew() {
  form.billNo = "";
  form.bomCode = "";
  form.warehouseCode = "CK-001";
  form.qty = 1;
  form.sourceType = "SELF";
  form.departmentCode = "";
  message.value = "";
  hasError.value = false;
  emit("markDirty");
}

async function save() {
  const result = await createProductionPlan({
    billNo: form.billNo.trim(),
    bomCode: form.bomCode.trim(),
    warehouseCode: form.warehouseCode.trim(),
    qty: Number(form.qty) || 0,
    sourceType: form.sourceType,
    departmentCode: form.departmentCode.trim()
  });
  if (!result.ok) {
    hasError.value = true;
    message.value = result.message;
    return;
  }
  hasError.value = false;
  message.value = `生产计划已保存：${String(result.data?.billNo ?? "")}`;
  form.billNo = String(result.data?.billNo ?? form.billNo);
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
