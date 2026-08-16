<template>
  <StandardDocument
    :title="title"
    subtitle=""
    :show-subtitle="false"
    :status-label="statusLabel"
    :status-class="statusClass"
    :locked="false"
    :dirty="dirty"
    :message="message"
    :can-save="canSave"
    :can-audit="canAudit"
    :can-reverse="canReverse"
    :can-void="canVoid"
    :can-close="canClose"
    :can-unclose="canUnclose"
    :can-freeze="canFreeze"
    :can-unfreeze="canUnfreeze"
    :can-delete="false"
    :can-output="false"
    :show-audit="true"
    :show-reverse="true"
    :show-red-reverse="false"
    :show-void="true"
    :show-close="true"
    :show-unclose="true"
    :show-freeze="true"
    :show-unfreeze="true"
    :show-delete="false"
    :show-export="false"
    :show-print="false"
    :show-push-down="true"
    :can-push-down="canPushDown"
    push-down-label="下推生产领料单"
    push-down-test-id="production-task-push-material-issue"
    data-testid="production-task-form"
    @create="startNew"
    @save="save"
    @audit="audit"
    @reverse="reverse"
    @void-document="openLifecycleAction('void')"
    @close-document="openLifecycleAction('close')"
    @unclose-document="openLifecycleAction('unclose')"
    @freeze-document="openLifecycleAction('freeze')"
    @unfreeze-document="openLifecycleAction('unfreeze')"
    @push-down="pushDownMaterialIssue"
  >
    <div class="form-layout production-task-form">
      <section class="master-record-section">
        <h3>表头</h3>
      </section>
      <section class="form-head-fields production-task-head-fields">
        <label>
          <span>任务单号</span>
          <input v-model.trim="form.billNo" data-testid="production-task-bill-no" placeholder="保存后生成" readonly />
        </label>
        <label>
          <span>来源生产计划</span>
          <input v-model.trim="form.planNo" data-testid="production-task-plan-no" :disabled="!isEditableTask" @input="markDirty" />
        </label>
        <label>
          <span>任务来源</span>
          <input :value="sourceKindLabel" data-testid="production-task-source-kind" disabled />
        </label>
        <label>
          <span>BOM 层级</span>
          <input :value="taskHead.sourceLevel ?? 0" data-testid="production-task-source-level" disabled />
        </label>
        <label>
          <span>上级任务</span>
          <input :value="taskHead.parentTaskNo || ''" data-testid="production-task-parent-task-no" disabled />
        </label>
        <label>
          <span>生产车间</span>
          <input :value="taskHead.department || ''" data-testid="production-task-department" disabled />
        </label>
      </section>

      <section class="master-record-section">
        <h3>母件信息</h3>
        <div class="form-head-fields production-task-product-fields">
          <label>
            <span>BOM 编码</span>
            <input v-model.trim="form.bomCode" data-testid="production-task-bom-code" :disabled="!isEditableTask" @input="markDirty" />
          </label>
          <label>
            <span>母件编码</span>
            <input :value="productInfo.productCode || ''" data-testid="production-task-product-code" disabled />
          </label>
          <label>
            <span>母件名称</span>
            <input :value="productInfo.productName || ''" data-testid="production-task-product-name" disabled />
          </label>
          <label>
            <span>规格型号</span>
            <input :value="productInfo.spec || ''" data-testid="production-task-product-spec" disabled />
          </label>
          <label>
            <span>单位</span>
            <input :value="productInfo.unit || ''" data-testid="production-task-product-unit" disabled />
          </label>
          <label>
            <span>BOM 版本</span>
            <input :value="productInfo.bomVersionNo ?? ''" data-testid="production-task-bom-version-no" disabled />
          </label>
          <label>
            <span>完工仓库</span>
            <input v-model.trim="form.warehouseCode" data-testid="production-task-warehouse-code" placeholder="留空取母件默认仓库" :disabled="!isEditableTask" @input="markDirty" />
          </label>
          <label class="required">
            <span>任务数量</span>
            <input v-model.number="form.qty" data-testid="production-task-qty" type="number" min="0" step="1" :disabled="!isEditableTask" @input="markDirty" />
          </label>
          <label>
            <span>生产剩余数量</span>
            <input :value="productInfo.remainingQty ?? ''" data-testid="production-task-remaining-qty" disabled />
          </label>
        </div>
      </section>

      <section class="master-record-section">
        <h3>子件/材料信息</h3>
      </section>
      <TableCore
        kind="entry"
        test-id="production-task-material-table-core"
        frame-class="entry-table production-task-material-table"
        table-class="entry-native-table"
        :columns="materialColumns"
        :rows="materialLines"
        :min-width="1180"
        :row-attrs="materialRowAttrs"
        :cell-attrs="materialCellAttrs"
        :row-draggable="false"
      >
        <template #header-cell="{ column }">
          <TableCoreHeaderCell
            :title="column.title"
            :column-key="column.key"
            :filterable="false"
            :resizable="false"
          />
        </template>
        <template #cell="{ row: line, column, rowIndex }">
          <span v-if="column.key === 'rowNo'" class="entry-row-no">
            <span class="entry-row-no__value">{{ rowIndex + 1 }}</span>
          </span>
          <span v-else class="entry-cell-value" :class="{ 'number-text': isNumberColumn(column.key) }">
            {{ materialCellText(line, column.key) }}
          </span>
        </template>
        <template v-if="materialLines.length === 0" #body-extra>
          <tr>
            <td class="production-task-empty" :colspan="materialColumns.length">保存生产任务单后显示 BOM 子件/材料快照。</td>
          </tr>
        </template>
      </TableCore>
    </div>
  </StandardDocument>
  <DocumentDialogs
    :pending-zero-entry-save="null"
    :zero-reason-options="[]"
    :downstream-trace="null"
    :pending-risky-document-action="null"
    :pending-lifecycle-action="pendingLifecycleAction"
    :pending-lifecycle-line-no="null"
    :pending-entry-paste="null"
    :current-bill-no="form.billNo"
    :current-order-status-label="statusLabel"
    red-reverse-bill-no=""
    risky-action-title=""
    risky-action-summary=""
    risky-action-impact=""
    risky-action-verb=""
    :lifecycle-reason="lifecycleReason"
    :void-username="voidUsername"
    :void-password="voidPassword"
    :entry-paste-conflicts-resolved="true"
    :format-qty="formatQty"
    :format-amount="formatQty"
    :zero-reason-test-id="zeroReasonTestId"
    :downstream-type-label="downstreamTypeLabel"
    :backend-status-label="backendStatusLabel"
    :downstream-reverse-impact="emptyImpact"
    :downstream-red-reverse-impact="emptyImpact"
    :downstream-doc-test-id="downstreamDocTestId"
    :entry-paste-candidate-test-id="entryPasteCandidateTestId"
    :is-entry-paste-candidate-active="isEntryPasteCandidateActive"
    @cancel-zero-entry-save="noop"
    @confirm-zero-entry-save="noop"
    @close-downstream-trace="noop"
    @open-downstream-document="noop"
    @cancel-risky-document-action="noop"
    @confirm-risky-document-action="noop"
    @cancel-lifecycle-action="cancelLifecycleAction"
    @confirm-lifecycle-action="confirmLifecycleAction"
    @update-lifecycle-reason="lifecycleReason = $event"
    @update-void-username="voidUsername = $event"
    @update-void-password="voidPassword = $event"
    @handle-entry-paste-conflict-keydown="noop"
    @select-entry-paste-candidate="noop"
    @cancel-pending-entry-paste="noop"
    @confirm-pending-entry-paste="noop"
  />
</template>

<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import type { DownstreamDocumentRef, OpenableDocumentType } from "../../../services/documentApi";
import type { EntryPasteConflict, LifecycleDocumentAction } from "../../../app/documentModel";
import DocumentDialogs from "../../../components/DocumentDialogs.vue";
import StandardDocument from "../../../components/StandardDocument.vue";
import TableCore, { type TableCoreColumn } from "../../../components/table/TableCore.vue";
import TableCoreHeaderCell from "../../../components/table/TableCoreHeaderCell.vue";
import {
  auditProductionTask,
  createProductionTask,
  fetchMaterialIssuePreviewFromTask,
  fetchProductionTaskDetail,
  lifecycleProductionTask,
  pushDownProductionTaskMaterialIssue,
  reverseProductionTask,
  voidProductionTask,
  type MaterialIssuePreview,
  type MaterialIssuePreviewLine
} from "../../../services/productionApi";

const props = withDefaults(defineProps<{
  title: string;
  dirty: boolean;
  hasPermission?: (permission: string) => boolean;
}>(), {
  hasPermission: () => true
});

const emit = defineEmits<{
  markDirty: [];
  clearDirty: [];
  requestOpenDocument: [payload: { type: OpenableDocumentType; billNo: string; sourceLineNo?: number | null; createdDraft?: boolean }];
}>();

interface TaskProductInfo {
  productCode?: string;
  productName?: string;
  spec?: string;
  unit?: string;
  warehouseCode?: string;
  taskQty?: number | string;
  remainingQty?: number | string;
  bomCode?: string;
  bomVersionNo?: number | string;
}

interface TaskHeadInfo {
  id?: string;
  billNo?: string;
  sourceOrderNo?: string;
  planNo?: string;
  planLineNo?: number | string;
  billDate?: string;
  department?: string;
  status?: string;
  closeStatus?: string;
  frozenStatus?: string;
  sourceKind?: string;
  sourceLevel?: number | string;
  parentTaskNo?: string;
  rootTaskNo?: string;
  bomPath?: string;
}

const message = ref("");
const hasError = ref(false);
const productInfo = reactive<TaskProductInfo>({});
const taskHead = reactive<TaskHeadInfo>({});
const materialLines = ref<MaterialIssuePreviewLine[]>([]);
const pendingLifecycleAction = ref<LifecycleDocumentAction | null>(null);
const draftId = ref<string>(crypto.randomUUID());
const saving = ref(false);
const lifecycleReason = ref("");
const voidUsername = ref("");
const voidPassword = ref("");
const form = reactive({
  billNo: "",
  planNo: "",
  planLineNo: undefined as number | undefined,
  bomCode: "",
  warehouseCode: "",
  qty: 1,
  status: "DRAFT",
  closeStatus: "OPEN",
  frozenStatus: "NORMAL"
});
const materialColumns: TableCoreColumn[] = [
  { key: "rowNo", title: "序号", width: 48, minWidth: 48, fixed: "left", align: "center", resizable: false, headerClass: "entry-row-no-cell entry-frozen-cell", cellClass: "entry-row-no-cell entry-frozen-cell" },
  { key: "productCode", title: "子件编码", width: 140, minWidth: 96 },
  { key: "productName", title: "子件名称", width: 180, minWidth: 96 },
  { key: "spec", title: "规格型号", width: 150, minWidth: 96 },
  { key: "unit", title: "单位", width: 80, minWidth: 64 },
  { key: "warehouseCode", title: "发料仓库", width: 110, minWidth: 88 },
  { key: "qty", title: "应领数量", width: 110, minWidth: 88, align: "right", headerClass: "entry-number-cell", cellClass: "entry-number-cell" },
  { key: "remainingQty", title: "剩余可领", width: 110, minWidth: 88, align: "right", headerClass: "entry-number-cell", cellClass: "entry-number-cell" },
  { key: "stockOnHand", title: "即时库存", width: 110, minWidth: 88, align: "right", headerClass: "entry-number-cell", cellClass: "entry-number-cell" },
  { key: "stockAvailable", title: "可用库存", width: 110, minWidth: 88, align: "right", headerClass: "entry-number-cell", cellClass: "entry-number-cell" },
  { key: "netWeight", title: "净重", width: 90, minWidth: 76, align: "right", headerClass: "entry-number-cell", cellClass: "entry-number-cell" },
  { key: "grossWeight", title: "毛重", width: 90, minWidth: 76, align: "right", headerClass: "entry-number-cell", cellClass: "entry-number-cell" }
];

const statusLabel = computed(() => backendStatusLabel(form.status, form.closeStatus, form.frozenStatus));
const statusClass = computed(() => form.status === "AUDITED" ? "audited" : "form");
const isEditableTask = computed(() => !saving.value && form.status === "DRAFT" && taskHead.sourceKind !== "BOM_CHILD");
const sourceKindLabel = computed(() => taskHead.sourceKind === "BOM_CHILD" ? "多层 BOM 子任务" : taskHead.sourceKind === "PLAN_ROOT" ? "计划根任务" : "手工任务");
const canSave = computed(() => isEditableTask.value && !saving.value);
const canAudit = computed(() => !saving.value && Boolean(form.billNo.trim()) && !props.dirty && form.status === "DRAFT" && props.hasPermission("production.task.audit"));
const canReverse = computed(() => !saving.value && Boolean(form.billNo.trim()) && !props.dirty && form.status === "AUDITED" && props.hasPermission("production.task.audit"));
const canVoid = computed(() => !saving.value && Boolean(form.billNo.trim()) && !props.dirty && form.status === "DRAFT" && props.hasPermission("production.task.audit"));
const canClose = computed(() => !saving.value && Boolean(form.billNo.trim()) && !props.dirty && form.status === "AUDITED" && form.closeStatus !== "CLOSED" && form.frozenStatus !== "FROZEN" && props.hasPermission("production.task.audit"));
const canUnclose = computed(() => !saving.value && Boolean(form.billNo.trim()) && !props.dirty && form.status === "AUDITED" && form.closeStatus === "CLOSED" && props.hasPermission("production.task.audit"));
const canFreeze = computed(() => !saving.value && Boolean(form.billNo.trim()) && !props.dirty && form.status === "AUDITED" && form.closeStatus !== "CLOSED" && form.frozenStatus !== "FROZEN" && props.hasPermission("production.task.audit"));
const canUnfreeze = computed(() => !saving.value && Boolean(form.billNo.trim()) && !props.dirty && form.status === "AUDITED" && form.frozenStatus === "FROZEN" && props.hasPermission("production.task.audit"));
const canPushDown = computed(() => (
  !saving.value &&
  Boolean(form.billNo.trim()) &&
  !props.dirty &&
  form.status === "AUDITED" &&
  form.closeStatus === "OPEN" &&
  form.frozenStatus === "NORMAL" &&
  materialLines.value.length > 0 &&
  props.hasPermission("production.document.audit")
));

function markDirty() {
  emit("markDirty");
  message.value = "";
  hasError.value = false;
}

function startNew() {
  if (saving.value) {
    return;
  }
  draftId.value = crypto.randomUUID();
  form.billNo = "";
  form.planNo = "";
  form.planLineNo = undefined;
  form.bomCode = "";
  form.warehouseCode = "";
  form.qty = 1;
  form.status = "DRAFT";
  form.closeStatus = "OPEN";
  form.frozenStatus = "NORMAL";
  clearPreview();
  message.value = "";
  hasError.value = false;
  emit("markDirty");
}

async function save() {
  if (saving.value) {
    return;
  }
  saving.value = true;
  try {
    const result = await createProductionTask({
      draftId: draftId.value,
      billNo: form.billNo.trim(),
      planNo: form.planNo.trim(),
      planLineNo: form.planLineNo,
      bomCode: form.bomCode.trim(),
      warehouseCode: form.warehouseCode.trim(),
      qty: Number(form.qty) || 0
    });
    if (!result.ok) {
      applyError(result.message);
      return;
    }
    draftId.value = String(result.data?.id ?? draftId.value);
    form.billNo = String(result.data?.billNo ?? form.billNo);
    form.bomCode = String(result.data?.bomCode ?? form.bomCode);
    form.qty = Number(result.data?.qty ?? form.qty) || form.qty;
    applyLifecycleResult(result.data);
    await loadPreview(form.billNo);
    hasError.value = false;
    message.value = `生产任务草稿已保存：${form.billNo}`;
    emit("clearDirty");
  } finally {
    saving.value = false;
  }
}

async function audit() {
  if (!canAudit.value) {
    return;
  }
  const result = await auditProductionTask(form.billNo);
  applyActionResult(result, "生产任务单已审核");
}

async function reverse() {
  if (!canReverse.value) {
    return;
  }
  const result = await reverseProductionTask(form.billNo);
  applyActionResult(result, "生产任务单已反审核，状态回到草稿");
}

async function loadPreview(billNo: string) {
  if (!billNo) {
    clearPreview();
    return;
  }
  const result = await fetchMaterialIssuePreviewFromTask(billNo);
  if (!result.ok) {
    clearPreview();
    applyError(result.message || "生产任务用料快照加载失败。");
    return;
  }
  applyPreview(result.data as MaterialIssuePreview | undefined);
}

function applyPreview(preview: MaterialIssuePreview | undefined) {
  clearPreview();
  Object.assign(taskHead, preview?.document ?? {});
  Object.assign(productInfo, preview?.productInfo ?? {});
  draftId.value = String(taskHead.id || draftId.value);
  form.billNo = String(taskHead.billNo || taskHead.sourceOrderNo || form.billNo);
  form.planNo = String(taskHead.planNo ?? form.planNo);
  form.planLineNo = normalizedOptionalInt(taskHead.planLineNo) ?? form.planLineNo;
  applyLifecycleResult(preview?.document as Record<string, unknown> | undefined);
  form.bomCode = String(productInfo.bomCode ?? form.bomCode);
  form.warehouseCode = String(productInfo.warehouseCode ?? form.warehouseCode);
  form.qty = Number(productInfo.taskQty ?? form.qty) || form.qty;
  const previewLines = preview?.lines ?? [];
  materialLines.value = previewLines.map((line) => ({ ...line }));
}

async function loadByBillNo(billNo: string) {
  if (!billNo) {
    return;
  }
  const result = await fetchProductionTaskDetail(billNo);
  if (!result.ok) {
    applyError(result.message || "生产任务单详情加载失败。");
    return;
  }
  applyPreview(result.data as MaterialIssuePreview | undefined);
  hasError.value = false;
  message.value = `已打开生产任务单 ${billNo}`;
  emit("clearDirty");
}

async function pushDownMaterialIssue() {
  if (!canPushDown.value) {
    return;
  }
  const result = await pushDownProductionTaskMaterialIssue(form.billNo);
  if (!result.ok) {
    applyError(result.message || "生产任务单下推生产领料单失败。");
    return;
  }
  const billNo = String(result.data?.billNo ?? "");
  hasError.value = false;
  message.value = billNo ? `已下推生成生产领料单草稿 ${billNo}` : "已下推生成生产领料单草稿。";
  if (billNo) {
    emit("requestOpenDocument", { type: "materialIssue", billNo, createdDraft: true });
  }
}

function openLifecycleAction(action: LifecycleDocumentAction) {
  pendingLifecycleAction.value = action;
  lifecycleReason.value = defaultLifecycleReason(action);
  voidUsername.value = "";
  voidPassword.value = "";
}

function cancelLifecycleAction() {
  pendingLifecycleAction.value = null;
  lifecycleReason.value = "";
  voidUsername.value = "";
  voidPassword.value = "";
}

async function confirmLifecycleAction() {
  const action = pendingLifecycleAction.value;
  if (!action) {
    cancelLifecycleAction();
    return;
  }
  const reason = lifecycleReason.value.trim();
  const result = action === "void"
    ? await voidProductionTask(form.billNo, { reason, username: voidUsername.value.trim(), password: voidPassword.value })
    : await lifecycleProductionTask(form.billNo, action, reason);
  if (!result.ok) {
    applyError(result.message);
    return;
  }
  applyLifecycleResult(result.data);
  hasError.value = false;
  message.value = lifecycleSuccessMessage(action);
  cancelLifecycleAction();
  emit("clearDirty");
}

function applyActionResult(result: { ok: boolean; message: string; data?: Record<string, unknown> }, okMessage: string) {
  if (!result.ok) {
    applyError(result.message);
    return;
  }
  applyLifecycleResult(result.data);
  hasError.value = false;
  message.value = okMessage;
  emit("clearDirty");
}

function clearPreview() {
  Object.assign(productInfo, {
    productCode: "",
    productName: "",
    spec: "",
    unit: "",
    warehouseCode: "",
    taskQty: "",
    remainingQty: "",
    bomCode: "",
    bomVersionNo: ""
  });
  Object.assign(taskHead, {
    id: "",
    billNo: "",
    sourceOrderNo: "",
    planNo: "",
    planLineNo: "",
    billDate: "",
    department: "",
    status: "",
    closeStatus: "",
    frozenStatus: "",
    sourceKind: "",
    sourceLevel: 0,
    parentTaskNo: "",
    rootTaskNo: "",
    bomPath: ""
  });
  materialLines.value = [];
}

function applyLifecycleResult(data: Record<string, unknown> | undefined) {
  form.status = normalizeStatus(data?.status ?? taskHead.status ?? form.status);
  form.closeStatus = String(data?.closeStatus ?? taskHead.closeStatus ?? form.closeStatus ?? "OPEN");
  form.frozenStatus = String(data?.frozenStatus ?? taskHead.frozenStatus ?? form.frozenStatus ?? "NORMAL");
}

function applyError(text: string) {
  hasError.value = true;
  message.value = text;
}

function materialCellText(line: MaterialIssuePreviewLine, key: string) {
  const value = (line as Record<string, unknown>)[key];
  if (isNumberColumn(key)) {
    return formatQty(value);
  }
  return String(value ?? "");
}

function isNumberColumn(key: string) {
  return ["qty", "remainingQty", "stockOnHand", "stockAvailable", "netWeight", "grossWeight"].includes(key);
}

function formatQty(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return Number.isInteger(parsed) ? String(parsed) : parsed.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function defaultLifecycleReason(action: LifecycleDocumentAction) {
  const labels: Record<LifecycleDocumentAction, string> = {
    close: "整单业务结束，剩余不再执行",
    unclose: "恢复生产任务继续执行",
    freeze: "临时暂停生产任务执行",
    unfreeze: "恢复生产任务执行",
    void: "录入错误，撤销无效生产任务草稿"
  };
  return labels[action];
}

function lifecycleSuccessMessage(action: LifecycleDocumentAction) {
  const labels: Record<LifecycleDocumentAction, string> = {
    close: "生产任务单已关闭",
    unclose: "生产任务单已反关闭",
    freeze: "生产任务单已冻结",
    unfreeze: "生产任务单已解冻",
    void: "生产任务单已作废"
  };
  return labels[action];
}

function backendStatusLabel(status: string | undefined, closeStatus = "OPEN", frozenStatus = "NORMAL") {
  if (status === "VOID") return "已作废";
  if (status === "AUDITED") {
    if (closeStatus === "CLOSED") return "已关闭";
    if (frozenStatus === "FROZEN") return "已冻结";
    return "已审核";
  }
  return "未审核";
}

function normalizeStatus(value: unknown) {
  const status = String(value ?? "DRAFT");
  return status === "VOIDED" ? "VOID" : status;
}

function normalizedOptionalInt(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function zeroReasonTestId(lineNo: number) {
  return `production-task-zero-reason-${lineNo}`;
}

function downstreamTypeLabel(type: OpenableDocumentType) {
  return type;
}

function emptyImpact(_doc: DownstreamDocumentRef) {
  return "";
}

function downstreamDocTestId(index: number) {
  return `production-task-downstream-doc-${index + 1}`;
}

function entryPasteCandidateTestId(lineIndex: number, code: string) {
  return `production-task-entry-paste-candidate-${lineIndex + 1}-${code}`;
}

function isEntryPasteCandidateActive(_conflict: EntryPasteConflict, _candidateIndex: number) {
  return false;
}

function noop() {}

function materialRowAttrs(_line: MaterialIssuePreviewLine, index: number) {
  return { "data-testid": `production-task-material-row-${index + 1}` };
}

function materialCellAttrs(_line: MaterialIssuePreviewLine, column: TableCoreColumn) {
  return {
    class: {
      "entry-row-no-cell": column.key === "rowNo",
      "entry-frozen-cell": column.key === "rowNo"
    }
  };
}

defineExpose({ startNew, loadByBillNo });
</script>

<style scoped>
.production-task-form {
  min-width: 1180px;
}

.production-task-head-fields,
.production-task-product-fields {
  grid-template-columns: repeat(4, minmax(160px, 1fr));
}

.production-task-empty {
  color: #687385;
  font-size: 12px;
  height: 42px;
  padding: 0 12px;
  text-align: center;
}
</style>
