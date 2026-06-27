<template>
  <div class="business-page document-page">
    <DocumentCommandHeader
      :title="title"
      :subtitle="subtitle"
      :show-subtitle="showSubtitle"
      :status-label="statusLabel"
      :status-class="statusClass"
    >
      <template #actions>
        <button v-if="showCreate !== false" class="primary-action" type="button" :disabled="locked" data-testid="new-document" @click="requestCreate">新增</button>
        <button v-if="showSave !== false" type="button" :disabled="locked || !canSave" data-testid="save-sales-order" @click="$emit('save')">保存</button>
        <button v-if="showAudit !== false" type="button" :disabled="locked || !canAudit" data-testid="audit-sales-order" @click="$emit('audit')">审核</button>
        <button v-if="showReverse !== false" type="button" :disabled="locked || !canReverse" data-testid="reverse-document" @click="$emit('reverse')">反审核</button>
        <button v-if="showRedReverse !== false" type="button" :disabled="locked || !(canRedReverse ?? canReverse)" data-testid="red-reverse-document" @click="$emit('redReverse')">红冲</button>
        <button v-if="showClose !== false" type="button" :disabled="locked || !canClose" data-testid="close-document" @click="$emit('closeDocument')">关闭</button>
        <button v-if="showUnclose !== false" type="button" :disabled="locked || !canUnclose" data-testid="unclose-document" @click="$emit('uncloseDocument')">反关闭</button>
        <button v-if="showFreeze !== false" type="button" :disabled="locked || !canFreeze" data-testid="freeze-document" @click="$emit('freezeDocument')">冻结</button>
        <button v-if="showUnfreeze !== false" type="button" :disabled="locked || !canUnfreeze" data-testid="unfreeze-document" @click="$emit('unfreezeDocument')">解冻</button>
        <button v-if="showVoid !== false" class="danger-action" type="button" :disabled="locked || !canVoid" data-testid="void-document" @click="$emit('voidDocument')">作废</button>
        <button v-if="showSourceSelect" type="button" :disabled="locked || !canSourceSelect" :data-testid="sourceSelectTestId" @click="$emit('sourceSelect')">{{ sourceSelectLabel }}</button>
        <button v-if="showPushDown" type="button" :disabled="locked || !canPushDown" :data-testid="pushDownTestId" @click="$emit('pushDown')">{{ pushDownLabel }}</button>
        <button v-if="showExtraAction" type="button" :disabled="locked || !canExtraAction" :data-testid="extraActionTestId" @click="$emit('extraAction')">{{ extraActionLabel }}</button>
        <button v-if="showDelete !== false" type="button" :disabled="locked || !canDelete" data-testid="delete-sales-order" @click="$emit('deleteDocument')">删除</button>
        <button v-if="showExport !== false" type="button" :disabled="!canOutput" data-testid="export-sales-order" @click="$emit('exportDocument')">引出</button>
        <button v-if="showPrint !== false" type="button" :disabled="!canOutput" data-testid="print-sales-order" @click="$emit('printDocument')">打印</button>
        <span v-if="dirty" class="dirty-tip">有未保存改动</span>
        <span v-if="message" class="form-message" data-testid="form-message">{{ message }}</span>
      </template>
    </DocumentCommandHeader>

    <div v-if="locked" class="lock-banner" data-testid="lock-banner">
      {{ lockMessage || "单据已被他人打开，只读" }}
      <button v-if="canOverrideLock" type="button" data-testid="override-document-lock" @click="$emit('overrideLock')">踢走并编辑</button>
    </div>

    <slot />

    <div v-if="pendingCreateConfirm" class="modal-mask" data-testid="new-document-unsaved-dialog">
      <div class="dialog risky-action-dialog">
        <h3>未保存提示</h3>
        <p>当前单据有未保存内容。继续新增会放弃当前未保存内容。</p>
        <div class="dialog-actions">
          <button type="button" data-testid="new-document-unsaved-cancel" @click="pendingCreateConfirm = false">取消</button>
          <button class="primary-action" type="button" data-testid="new-document-unsaved-confirm" @click="confirmCreate">继续新增</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import DocumentCommandHeader from "./DocumentCommandHeader.vue";

const props = withDefaults(defineProps<{
  title: string;
  subtitle: string;
  showSubtitle?: boolean;
  statusLabel: string;
  statusClass: string;
  locked: boolean;
  lockMessage?: string;
  canOverrideLock?: boolean;
  dirty: boolean;
  message: string;
  canSave: boolean;
  canAudit: boolean;
  canReverse: boolean;
  canRedReverse?: boolean;
  canVoid: boolean;
  canClose?: boolean;
  canUnclose?: boolean;
  canFreeze?: boolean;
  canUnfreeze?: boolean;
  canDelete: boolean;
  canOutput: boolean;
  showCreate?: boolean;
  showSave?: boolean;
  showAudit?: boolean;
  showReverse?: boolean;
  showRedReverse?: boolean;
  showVoid?: boolean;
  showClose?: boolean;
  showUnclose?: boolean;
  showFreeze?: boolean;
  showUnfreeze?: boolean;
  showDelete?: boolean;
  showExport?: boolean;
  showPrint?: boolean;
  showPushDown?: boolean;
  canPushDown?: boolean;
  pushDownLabel?: string;
  pushDownTestId?: string;
  showSourceSelect?: boolean;
  canSourceSelect?: boolean;
  sourceSelectLabel?: string;
  sourceSelectTestId?: string;
  showExtraAction?: boolean;
  canExtraAction?: boolean;
  extraActionLabel?: string;
  extraActionTestId?: string;
}>(), {
  showSubtitle: false,
  lockMessage: "",
  canOverrideLock: false,
  canRedReverse: undefined,
  canClose: false,
  canUnclose: false,
  canFreeze: false,
  canUnfreeze: false,
  showCreate: true,
  showSave: true,
  showAudit: true,
  showReverse: true,
  showRedReverse: true,
  showVoid: true,
  showClose: true,
  showUnclose: true,
  showFreeze: true,
  showUnfreeze: true,
  showDelete: true,
  showExport: true,
  showPrint: true,
  showPushDown: false,
  canPushDown: false,
  pushDownLabel: "下推",
  pushDownTestId: "push-down-document",
  showSourceSelect: false,
  canSourceSelect: false,
  sourceSelectLabel: "选源单",
  sourceSelectTestId: "select-source-document",
  showExtraAction: false,
  canExtraAction: false,
  extraActionLabel: "执行",
  extraActionTestId: "extra-document-action"
});

const emit = defineEmits<{
  create: [];
  save: [];
  audit: [];
  reverse: [];
  redReverse: [];
  voidDocument: [];
  closeDocument: [];
  uncloseDocument: [];
  freezeDocument: [];
  unfreezeDocument: [];
  sourceSelect: [];
  pushDown: [];
  extraAction: [];
  deleteDocument: [];
  exportDocument: [];
  printDocument: [];
  showExisting: [];
  overrideLock: [];
}>();

const pendingCreateConfirm = ref(false);

function requestCreate() {
  if (props.dirty) {
    pendingCreateConfirm.value = true;
    return;
  }
  emit("create");
}

function confirmCreate() {
  pendingCreateConfirm.value = false;
  emit("create");
}
</script>
