<template>
  <StandardDocument
    class="bom-form"
    data-testid="bom-form"
    :title="title"
    subtitle=""
    :show-subtitle="false"
    :status-label="statusText"
    :status-class="statusClass"
    :locked="false"
    :dirty="dirty"
    :message="message"
    :can-save="!isAudited"
    :can-audit="Boolean(form.code) && !dirty && !isAudited"
    :can-reverse="Boolean(form.code) && isAudited"
    :can-red-reverse="false"
    :can-void="false"
    :can-close="false"
    :can-unclose="false"
    :can-freeze="false"
    :can-unfreeze="false"
    :can-delete="Boolean(form.code) && !isAudited"
    :can-output="false"
    :show-red-reverse="false"
    :show-void="false"
    :show-close="false"
    :show-unclose="false"
    :show-freeze="false"
    :show-unfreeze="false"
    :show-export="false"
    :show-print="false"
    :show-extra-action="true"
    :can-extra-action="Boolean(form.code) && isAudited"
    :extra-action-label="form.enabled ? '禁用' : '启用'"
    extra-action-test-id="bom-toggle-status"
    @create="startNew"
    @save="save"
    @audit="audit"
    @reverse="reverseAudit"
    @extra-action="toggleStatus"
    @delete-document="remove"
  >
    <div class="master-record-body">
      <section class="master-record-section">
        <h3>基本信息</h3>
        <div class="form-head-fields bom-fields">
          <label class="required">
            <span>BOM 编码</span>
            <input v-model.trim="form.code" data-testid="bom-code" placeholder="如 BOM-CP001" :readonly="isAudited" @input="markDirty" />
          </label>
          <label>
            <span>BOM 分类</span>
            <input v-model.trim="form.bomCategory" data-testid="bom-category" placeholder="如 总成 / 焊接件 / 包装" :readonly="isAudited" @input="markDirty" />
          </label>
          <label>
            <span>版本号</span>
            <input :value="form.versionNo || '保存后生成'" disabled />
          </label>
          <label>
            <span>状态</span>
            <input :value="statusText" disabled />
          </label>
          <label class="wide">
            <span>BOM 备注</span>
            <textarea v-model.trim="form.remark" data-testid="bom-remark" :readonly="isAudited" @input="markDirty" />
          </label>
        </div>
      </section>

      <section class="master-record-section bom-product-section">
        <h3>产品信息</h3>
        <div class="form-head-fields bom-product-fields">
          <label class="required">
            <span>母件物料编码</span>
            <input v-model.trim="form.productCode" data-testid="bom-product-code" placeholder="录入已审核母件物料" :readonly="isAudited" @input="markDirty" />
          </label>
          <label>
            <span>母件名称</span>
            <input v-model="form.productName" disabled />
          </label>
          <label>
            <span>规格型号</span>
            <input v-model="form.spec" disabled />
          </label>
          <label>
            <span>单位</span>
            <input v-model="form.unit" disabled />
          </label>
          <label class="required">
            <span>母件数量</span>
            <input v-model.number="form.qty" data-testid="bom-qty" type="number" min="0" step="0.01" :readonly="isAudited" @input="markDirty" />
          </label>
          <label>
            <span>默认仓库</span>
            <input v-model="form.warehouseCode" disabled />
          </label>
        </div>
      </section>

      <section class="master-record-section">
        <div class="section-title-row">
          <h3>子件明细</h3>
        </div>
        <BomEntryTable
          :lines="form.lines"
          :is-draft="!isAudited"
          :material-options="materialOptions"
          @mark-dirty="markDirty"
          @insert-line-after="insertLineAfter"
          @remove-line="removeLine"
          @open-material-selector="openMaterialSelector"
        />
      </section>
    </div>
  </StandardDocument>

  <MasterSelectorDialog
    :open="materialSelectorDialogOpen"
    type="product"
    title="选择子件物料"
    label="物料"
    :keyword="materialSelectorKeyword"
    @close="closeMaterialSelector"
    @select="selectMaterialSelectorRow"
  />

  <div v-if="pendingCopiedAuditConfirm" class="modal-mask" data-testid="bom-copy-audit-confirm-dialog">
    <div class="dialog risky-action-dialog">
      <h3>BOM 版本确认</h3>
      <p>{{ pendingAuditPreviewMessage || "该母件已有已审核 BOM，当前草稿的子件物料编码与当前版本不同。审核后会新增该母件的新版本，并禁用旧版本。" }}</p>
      <div class="dialog-actions">
        <button type="button" data-testid="bom-copy-audit-cancel" @click="cancelAuditConfirm">取消</button>
        <button class="primary-action" type="button" data-testid="bom-copy-audit-confirm" @click="confirmCopiedAudit">继续审核</button>
      </div>
    </div>
  </div>

  <div v-if="pendingAuditBlocked" class="modal-mask" data-testid="bom-audit-block-dialog">
    <div class="dialog risky-action-dialog">
      <h3>BOM 审核提示</h3>
      <p>{{ pendingAuditBlockMessage || "当前草稿的子件物料与当前版本 BOM 完全一致，请核对后重新提交或关闭。" }}</p>
      <div class="dialog-actions">
        <button class="primary-action" type="button" data-testid="bom-audit-block-ok" @click="closeAuditBlock">确定</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import BomEntryTable, { type BomEntryLine, type BomMaterialOption } from "../../../components/BomEntryTable.vue";
import type { MasterOption } from "../../../components/entry-table/types";
import MasterSelectorDialog from "../../../components/MasterSelectorDialog.vue";
import StandardDocument from "../../../components/StandardDocument.vue";
import { fetchListRows } from "../../../services/listApi";
import { auditBom, deleteBom, fetchBomAuditPreview, fetchBomDetail, reverseBom, saveBom, setBomEnabled, type BomAuditConfirmation } from "../../../services/productionApi";

defineProps<{
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
const materialOptions = ref<BomMaterialOption[]>([]);
const pendingCopiedAuditConfirm = ref(false);
const pendingAuditPreviewMessage = ref("");
const pendingAuditLatestBomCode = ref("");
const pendingAuditLatestVersionNo = ref("");
const pendingAuditBlocked = ref(false);
const pendingAuditBlockMessage = ref("");
const materialSelectorDialogOpen = ref(false);
const materialSelectorLineIndex = ref<number | null>(null);
const materialSelectorKeyword = ref("");
const form = reactive({
  code: "",
  bomCategory: "",
  productCode: "",
  productName: "",
  spec: "",
  unit: "",
  warehouseCode: "",
  qty: 1,
  remark: "",
  versionNo: "",
  auditStatus: "DRAFT",
  enabled: true,
  isCurrent: false,
  lines: [blankLine()]
});

const isAudited = computed(() => form.auditStatus === "AUDITED");
const statusClass = computed(() => isAudited.value ? "audited" : "draft");
const statusText = computed(() => {
  const audit = isAudited.value ? "已审核" : "草稿";
  const status = form.enabled ? "启用" : "禁用";
  return `${status} / ${audit}`;
});

onMounted(() => {
  void loadMaterialOptions();
});

function blankLine(): BomEntryLine {
  return {
    localId: crypto.randomUUID(),
    materialCode: "",
    materialName: "",
    spec: "",
    unit: "",
    productQty: 1,
    materialQty: 1,
    unitQty: 1,
    issueMethod: "按单领料",
    issueWarehouseCode: "",
    fixedLossQty: 0,
    lossRate: 0,
    childBomCode: "",
    childBomVersionNo: ""
  };
}

function markDirty() {
  emit("markDirty");
  message.value = "";
  hasError.value = false;
}

function startNew() {
  pendingCopiedAuditConfirm.value = false;
  pendingAuditPreviewMessage.value = "";
  pendingAuditLatestBomCode.value = "";
  pendingAuditLatestVersionNo.value = "";
  pendingAuditBlocked.value = false;
  pendingAuditBlockMessage.value = "";
  closeMaterialSelector();
  form.code = "";
  form.bomCategory = "";
  form.productCode = "";
  form.productName = "";
  form.spec = "";
  form.unit = "";
  form.warehouseCode = "";
  form.qty = 1;
  form.remark = "";
  form.versionNo = "";
  form.auditStatus = "DRAFT";
  form.enabled = true;
  form.isCurrent = false;
  form.lines.splice(0, form.lines.length, blankLine());
  message.value = "";
  hasError.value = false;
  emit("markDirty");
}

async function loadBom(code: string) {
  pendingCopiedAuditConfirm.value = false;
  pendingAuditPreviewMessage.value = "";
  pendingAuditLatestBomCode.value = "";
  pendingAuditLatestVersionNo.value = "";
  pendingAuditBlocked.value = false;
  pendingAuditBlockMessage.value = "";
  closeMaterialSelector();
  const result = await fetchBomDetail(code);
  if (!result.ok || !result.data) {
    hasError.value = true;
    message.value = result.message || "BOM 加载失败。";
    return;
  }
  applyBomData(result.data);
  hasError.value = false;
  message.value = "";
  emit("clearDirty");
}

async function copyFromBom(code: string) {
  pendingCopiedAuditConfirm.value = false;
  pendingAuditPreviewMessage.value = "";
  pendingAuditLatestBomCode.value = "";
  pendingAuditLatestVersionNo.value = "";
  pendingAuditBlocked.value = false;
  pendingAuditBlockMessage.value = "";
  closeMaterialSelector();
  const result = await fetchBomDetail(code);
  if (!result.ok || !result.data) {
    hasError.value = true;
    message.value = result.message || "BOM 复制失败。";
    return;
  }
  applyBomData(result.data);
  form.auditStatus = "DRAFT";
  form.enabled = true;
  form.isCurrent = false;
  form.versionNo = "";
  hasError.value = false;
  message.value = "已复制 BOM 信息，请修改后保存。";
  emit("markDirty");
}

function insertLineAfter(index: number) {
  form.lines.splice(index + 1, 0, blankLine());
  markDirty();
}

function removeLine(index: number) {
  if (form.lines.length <= 1) {
    return;
  }
  form.lines.splice(index, 1);
  markDirty();
}

async function loadMaterialOptions() {
  const result = await fetchListRows("product-master-list", {
    keyword: "",
    status: "启用",
    page: 1,
    pageSize: 1000
  });
  if (!result.ok || !result.data) {
    materialOptions.value = [];
    return;
  }
  materialOptions.value = result.data.rows
    .filter((row) => String(row.auditStatus ?? "已审核") === "已审核")
    .map((row) => {
      const code = text(row.code);
      const name = text(row.name);
      const spec = text(row.spec);
      const unit = text(row.unit);
      const defaultWarehouseCode = text(row.defaultWarehouseCode);
      return {
        code,
        name,
        spec,
        unit,
        defaultWarehouseCode,
        searchText: normalizeLookupText(`${code} ${name} ${spec} ${unit}`)
      };
    })
    .filter((option) => option.code);
}

function normalizeLookupText(value: string) {
  return value.trim().toLowerCase();
}

async function save() {
  const lines = form.lines
    .filter((line) => line.materialCode.trim())
    .map((line) => ({
      materialCode: line.materialCode.trim(),
      qty: calculatedUnitQty(line),
      productQty: Number(line.productQty) || 0,
      materialQty: Number(line.materialQty) || 0,
      issueMethod: line.issueMethod,
      issueWarehouseCode: line.issueWarehouseCode.trim(),
      fixedLossQty: Number(line.fixedLossQty) || 0,
      lossRate: Number(line.lossRate) || 0,
      childBomCode: line.childBomCode.trim()
    }));
  const result = await saveBom({
    code: form.code.trim(),
    productCode: form.productCode.trim(),
    qty: Number(form.qty) || 0,
    bomCategory: form.bomCategory.trim(),
    remark: form.remark.trim(),
    lines
  });
  handleWriteResult(result, "BOM 已保存。");
}

async function audit() {
  const preview = await fetchBomAuditPreview(form.code);
  if (!preview.ok) {
    hasError.value = true;
    message.value = preview.message || "BOM 审核预检失败。";
    return;
  }
  if (Boolean(preview.data?.blocked)) {
    pendingAuditBlockMessage.value = text(preview.data?.message) || "当前草稿的子件物料与当前版本 BOM 完全一致，请核对后重新提交或关闭。";
    pendingAuditLatestBomCode.value = "";
    pendingAuditLatestVersionNo.value = "";
    pendingAuditBlocked.value = true;
    return;
  }
  if (Boolean(preview.data?.requiresConfirmation)) {
    pendingAuditPreviewMessage.value = text(preview.data?.message) || "该母件已有已审核 BOM，当前草稿的子件物料编码与当前版本不同。审核后会新增该母件的新版本，并禁用旧版本。";
    pendingAuditLatestBomCode.value = text(preview.data?.latestBomCode);
    pendingAuditLatestVersionNo.value = text(preview.data?.latestVersionNo);
    pendingCopiedAuditConfirm.value = true;
    return;
  }
  await performAudit();
}

function cancelAuditConfirm() {
  pendingCopiedAuditConfirm.value = false;
  pendingAuditPreviewMessage.value = "";
  pendingAuditLatestBomCode.value = "";
  pendingAuditLatestVersionNo.value = "";
}

function closeAuditBlock() {
  pendingAuditBlocked.value = false;
  pendingAuditBlockMessage.value = "";
}

async function confirmCopiedAudit() {
  const confirmation: BomAuditConfirmation = {
    confirmNewVersion: true,
    latestBomCode: pendingAuditLatestBomCode.value,
    latestVersionNo: pendingAuditLatestVersionNo.value
  };
  pendingCopiedAuditConfirm.value = false;
  pendingAuditPreviewMessage.value = "";
  pendingAuditLatestBomCode.value = "";
  pendingAuditLatestVersionNo.value = "";
  await performAudit(confirmation);
}

async function performAudit(confirmation?: BomAuditConfirmation) {
  const result = await auditBom(form.code, confirmation);
  handleWriteResult(result, "BOM 已审核并设为当前可用版本。");
}

async function reverseAudit() {
  if (!window.confirm("反审核后该 BOM 将不再作为当前可用版本，确认继续？")) {
    return;
  }
  const result = await reverseBom(form.code);
  handleWriteResult(result, "BOM 已反审核，状态回到草稿。");
}

async function toggleStatus() {
  const result = await setBomEnabled(form.code, !form.enabled);
  handleWriteResult(result, form.enabled ? "BOM 已禁用。" : "BOM 已启用。");
}

async function remove() {
  if (!window.confirm("确定删除当前未审核 BOM 吗？")) {
    return;
  }
  const result = await deleteBom(form.code);
  if (!result.ok) {
    hasError.value = true;
    message.value = result.message || "BOM 删除失败。";
    return;
  }
  startNew();
  emit("clearDirty");
  message.value = "BOM 已删除。";
}

function handleWriteResult(result: { ok: boolean; message: string; data?: Record<string, unknown> }, successMessage: string) {
  if (!result.ok || !result.data) {
    hasError.value = true;
    message.value = result.message || "BOM 处理失败。";
    return;
  }
  applyBomData(result.data);
  hasError.value = false;
  message.value = successMessage;
  pendingCopiedAuditConfirm.value = false;
  pendingAuditPreviewMessage.value = "";
  pendingAuditLatestBomCode.value = "";
  pendingAuditLatestVersionNo.value = "";
  pendingAuditBlocked.value = false;
  pendingAuditBlockMessage.value = "";
  emit("clearDirty");
}

function applyBomData(data: Record<string, unknown>) {
  form.code = text(data.code);
  form.bomCategory = text(data.bomCategory);
  form.productCode = text(data.productCode);
  form.productName = text(data.productName);
  form.spec = text(data.spec);
  form.unit = text(data.unit);
  form.warehouseCode = text(data.warehouseCode);
  form.qty = numberValue(data.qty, 1);
  form.remark = text(data.remark);
  form.versionNo = text(data.versionNo);
  form.auditStatus = text(data.auditStatus) || "DRAFT";
  form.enabled = Boolean(data.enabled);
  form.isCurrent = Boolean(data.isCurrent);
  const lines = Array.isArray(data.lines) ? data.lines as Record<string, unknown>[] : [];
  form.lines.splice(0, form.lines.length, ...(lines.length ? lines.map(lineFromData) : [blankLine()]));
}

function lineFromData(data: Record<string, unknown>): BomEntryLine {
  const productQty = numberValue(data.productQty, 1);
  const materialQty = numberValue(data.materialQty, 1);
  return {
    localId: crypto.randomUUID(),
    materialCode: text(data.materialCode),
    materialName: text(data.materialName),
    spec: text(data.spec),
    unit: text(data.unit),
    productQty,
    materialQty,
    unitQty: calculatedUnitQty({ productQty, materialQty }),
    issueMethod: text(data.issueMethod) || "按单领料",
    issueWarehouseCode: text(data.issueWarehouseCode),
    fixedLossQty: numberValue(data.fixedLossQty, 0),
    lossRate: numberValue(data.lossRate, 0),
    childBomCode: text(data.childBomCode),
    childBomVersionNo: text(data.childBomVersionNo)
  };
}

function text(value: unknown) {
  return value == null ? "" : String(value);
}

function numberValue(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function calculatedUnitQty(line: Pick<BomEntryLine, "productQty" | "materialQty">) {
  const productQty = Number(line.productQty) || 0;
  const materialQty = Number(line.materialQty) || 0;
  return productQty > 0 && materialQty > 0 ? Number((materialQty / productQty).toFixed(6)) : 0;
}

function openMaterialSelector(index: number, keyword: string) {
  if (isAudited.value) {
    return;
  }
  materialSelectorLineIndex.value = index;
  materialSelectorKeyword.value = keyword;
  materialSelectorDialogOpen.value = true;
}

function closeMaterialSelector() {
  materialSelectorDialogOpen.value = false;
  materialSelectorLineIndex.value = null;
  materialSelectorKeyword.value = "";
}

function selectMaterialSelectorRow(option: MasterOption) {
  const index = materialSelectorLineIndex.value;
  const line = index == null ? null : form.lines[index];
  if (!line) {
    closeMaterialSelector();
    return;
  }
  line.materialCode = text(option.code);
  line.materialName = text(option.name);
  line.spec = text(option.spec);
  line.unit = text(option.unit);
  if (!line.issueWarehouseCode && option.defaultWarehouseCode) {
    line.issueWarehouseCode = text(option.defaultWarehouseCode);
  }
  closeMaterialSelector();
  markDirty();
}

defineExpose({ startNew, loadBom, copyFromBom });
</script>

<style scoped>
.bom-form {
  min-width: 1120px;
}

.bom-fields {
  display: grid;
  grid-template-columns: repeat(4, minmax(150px, 1fr));
  gap: 10px 14px;
  border: 0;
  padding: 10px;
}

.bom-product-fields {
  display: grid;
  grid-template-columns: repeat(6, minmax(120px, 1fr));
  gap: 10px 14px;
  border: 0;
  padding: 10px;
}

.bom-fields label,
.bom-product-fields label {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
  color: #5d7188;
  font-size: 12px;
}

.bom-fields label.required span::before,
.bom-product-fields label.required span::before {
  content: "*";
  margin-right: 2px;
  color: #d1412f;
}

.bom-fields textarea {
  resize: vertical;
}

.bom-fields .wide {
  grid-column: span 4;
}

.bom-product-section {
  border-top: 1px solid #e6edf5;
}

.section-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
</style>
