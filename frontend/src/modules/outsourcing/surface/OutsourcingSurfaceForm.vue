<template>
  <section class="master-record-page production-lite-form" data-testid="outsourcing-surface-form">
    <DocumentCommandHeader
      :title="title"
      :show-subtitle="false"
      :status-label="statusLabel"
      :status-class="statusClass"
    >
      <template #actions>
        <ActionBar :actions="surfaceActions" @action="handleAction">
          <span v-if="dirty" class="production-message warn">有未保存改动</span>
          <span v-if="message" class="production-message" :class="{ error: hasError }" data-testid="outsourcing-surface-message">{{ message }}</span>
        </ActionBar>
      </template>
    </DocumentCommandHeader>

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
import { computed, reactive, ref } from "vue";
import ActionBar from "../../../components/ActionBar.vue";
import { defineAction, type ActionBarItem } from "../../../components/actions/actionRegistry";
import DocumentCommandHeader from "../../../components/DocumentCommandHeader.vue";
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
const statusClass = computed(() => statusLabel.value === "草稿" ? "draft" : "audited");
const message = ref("");
const hasError = ref(false);
const surfaceActions = computed<ActionBarItem[]>(() => [
  defineAction("create", { enabled: true, testId: "outsourcing-surface-new" }),
  defineAction("save", { enabled: true, testId: "outsourcing-surface-save" }),
  defineAction("audit", { enabled: Boolean(form.billNo), testId: "outsourcing-surface-audit" }),
  defineAction("complete", { enabled: statusLabel.value === "已发出", testId: "outsourcing-surface-complete" }),
  defineAction("showList", { enabled: true, testId: "outsourcing-surface-back-list" })
]);
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

function handleAction(key: string) {
  const handlers: Record<string, () => void> = {
    create: startNew,
    save: () => { void save(); },
    audit: () => { void audit(); },
    complete: () => { void complete(); },
    showList: () => emit("showExisting")
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
