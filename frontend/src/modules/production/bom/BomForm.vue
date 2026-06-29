<template>
  <section class="master-record-page production-lite-form" data-testid="bom-form">
    <header class="master-record-head">
      <div class="master-record-title-row">
        <h2>{{ title }}</h2>
        <span class="master-record-status">草稿</span>
      </div>
      <div class="master-record-toolbar">
        <button type="button" data-testid="bom-new" @click="startNew">新增</button>
        <button class="primary-action" type="button" data-testid="bom-save" @click="save">保存</button>
        <button type="button" data-testid="bom-back-list" @click="emit('showExisting')">列表</button>
        <span v-if="dirty" class="production-message warn">有未保存改动</span>
        <span v-if="message" class="production-message" :class="{ error: hasError }" data-testid="bom-message">{{ message }}</span>
      </div>
    </header>

    <div class="master-record-body">
      <section class="master-record-section">
        <h3>BOM 信息</h3>
        <div class="master-record-fields">
          <label class="required">
            <span>BOM 编码</span>
            <input v-model.trim="form.code" data-testid="bom-code" placeholder="如 BOM-CP001" @input="markDirty" />
          </label>
          <label class="required">
            <span>成品物料编码</span>
            <input v-model.trim="form.productCode" data-testid="bom-product-code" placeholder="录入已审核成品物料" @input="markDirty" />
          </label>
          <label class="required">
            <span>成品数量</span>
            <input v-model.number="form.qty" data-testid="bom-qty" type="number" min="0" step="0.01" @input="markDirty" />
          </label>
          <label>
            <span>状态</span>
            <input value="启用" disabled />
          </label>
        </div>
      </section>

      <section class="master-record-section">
        <h3>子件明细</h3>
        <table class="production-lite-table" data-testid="bom-lines">
          <thead>
            <tr>
              <th class="line-no">序号</th>
              <th>物料编码</th>
              <th class="qty-col">用量</th>
              <th class="row-action">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(line, index) in form.lines" :key="line.localId">
              <td class="line-no">{{ index + 1 }}</td>
              <td><input v-model.trim="line.materialCode" :data-testid="`bom-line-material-${index + 1}`" @input="markDirty" /></td>
              <td><input v-model.number="line.qty" :data-testid="`bom-line-qty-${index + 1}`" type="number" min="0" step="0.01" @input="markDirty" /></td>
              <td class="row-action">
                <button type="button" :disabled="form.lines.length === 1" @click="removeLine(index)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
        <button type="button" data-testid="bom-add-line" @click="addLine">增加子件</button>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { reactive, ref } from "vue";
import { saveBom } from "../../../services/productionApi";

interface BomLineForm {
  localId: string;
  materialCode: string;
  qty: number;
}

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
  code: "",
  productCode: "",
  qty: 1,
  lines: [blankLine()]
});

function blankLine(): BomLineForm {
  return {
    localId: crypto.randomUUID(),
    materialCode: "",
    qty: 1
  };
}

function markDirty() {
  emit("markDirty");
  message.value = "";
  hasError.value = false;
}

function startNew() {
  form.code = "";
  form.productCode = "";
  form.qty = 1;
  form.lines.splice(0, form.lines.length, blankLine());
  message.value = "";
  hasError.value = false;
  emit("markDirty");
}

function addLine() {
  form.lines.push(blankLine());
  markDirty();
}

function removeLine(index: number) {
  if (form.lines.length <= 1) {
    return;
  }
  form.lines.splice(index, 1);
  markDirty();
}

async function save() {
  const lines = form.lines
    .filter((line) => line.materialCode.trim())
    .map((line) => ({ materialCode: line.materialCode.trim(), qty: Number(line.qty) || 0 }));
  const result = await saveBom({
    code: form.code.trim(),
    productCode: form.productCode.trim(),
    qty: Number(form.qty) || 0,
    lines
  });
  if (!result.ok) {
    hasError.value = true;
    message.value = result.message;
    return;
  }
  hasError.value = false;
  message.value = `BOM 已保存：${String(result.data?.code ?? form.code)}`;
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

.production-message.warn {
  color: #b44b37;
}

.production-message.error {
  color: #b44b37;
}

.production-lite-table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 13px;
}

.production-lite-table th,
.production-lite-table td {
  height: 32px;
  border: 1px solid #d8e1ec;
  padding: 0 8px;
  background: #ffffff;
}

.production-lite-table th {
  background: #f4f7fb;
  color: #26384d;
  font-weight: 600;
  text-align: left;
}

.production-lite-table input {
  width: 100%;
  height: 26px;
  border: 1px solid #c7d2df;
  border-radius: 4px;
  padding: 0 6px;
  font-size: 13px;
}

.line-no {
  width: 56px;
  text-align: center;
}

.qty-col {
  width: 160px;
}

.row-action {
  width: 100px;
  text-align: center;
}
</style>
