<template>
  <section class="master-record-page production-lite-form" data-testid="production-task-form">
    <DocumentCommandHeader
      :title="title"
      :show-subtitle="false"
      status-label="已审核"
      status-class="audited"
    >
      <template #actions>
        <ActionBar :actions="taskActions" @action="handleAction">
          <span v-if="dirty" class="production-message warn">有未保存改动</span>
          <span v-if="message" class="production-message" :class="{ error: hasError }" data-testid="production-task-message">{{ message }}</span>
        </ActionBar>
      </template>
    </DocumentCommandHeader>

    <div class="master-record-body">
      <section class="master-record-section">
        <h3>任务信息</h3>
        <div class="master-record-fields">
          <label>
            <span>任务单号</span>
            <input v-model.trim="form.billNo" data-testid="production-task-bill-no" placeholder="保存后生成" @input="markDirty" />
          </label>
          <label>
            <span>来源生产计划</span>
            <input v-model.trim="form.planNo" data-testid="production-task-plan-no" @input="markDirty" />
          </label>
          <label>
            <span>BOM 编码</span>
            <input v-model.trim="form.bomCode" data-testid="production-task-bom-code" @input="markDirty" />
          </label>
          <label>
            <span>完工仓库</span>
            <input v-model.trim="form.warehouseCode" data-testid="production-task-warehouse-code" @input="markDirty" />
          </label>
          <label class="required">
            <span>任务数量</span>
            <input v-model.number="form.qty" data-testid="production-task-qty" type="number" min="0" step="1" @input="markDirty" />
          </label>
        </div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import ActionBar from "../../../components/ActionBar.vue";
import { defineAction, type ActionBarItem } from "../../../components/actions/actionRegistry";
import DocumentCommandHeader from "../../../components/DocumentCommandHeader.vue";
import { createProductionTask } from "../../../services/productionApi";

const props = defineProps<{
  title: string;
  dirty: boolean;
}>();

const emit = defineEmits<{
  markDirty: [];
  clearDirty: [];
}>();

const message = ref("");
const hasError = ref(false);
const taskActions = computed<ActionBarItem[]>(() => [
  defineAction("create", { enabled: true, testId: "production-task-new" }),
  defineAction("save", { enabled: true, testId: "production-task-save" })
]);
const form = reactive({
  billNo: "",
  planNo: "",
  bomCode: "",
  warehouseCode: "CK-001",
  qty: 1
});

function markDirty() {
  emit("markDirty");
  message.value = "";
  hasError.value = false;
}

function startNew() {
  form.billNo = "";
  form.planNo = "";
  form.bomCode = "";
  form.warehouseCode = "CK-001";
  form.qty = 1;
  message.value = "";
  hasError.value = false;
  emit("markDirty");
}

async function save() {
  const result = await createProductionTask({
    billNo: form.billNo.trim(),
    planNo: form.planNo.trim(),
    bomCode: form.bomCode.trim(),
    warehouseCode: form.warehouseCode.trim(),
    qty: Number(form.qty) || 0
  });
  if (!result.ok) {
    hasError.value = true;
    message.value = result.message;
    return;
  }
  hasError.value = false;
  message.value = `生产任务已保存：${String(result.data?.billNo ?? "")}`;
  form.billNo = String(result.data?.billNo ?? form.billNo);
  emit("clearDirty");
}

function handleAction(key: string) {
  const handlers: Record<string, () => void> = {
    create: startNew,
    save: () => { void save(); }
  };
  handlers[key]?.();
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
