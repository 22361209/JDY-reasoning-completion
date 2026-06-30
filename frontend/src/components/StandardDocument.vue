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
        <ActionBar :actions="documentActions" @action="handleAction">
          <span v-if="dirty" class="dirty-tip">有未保存改动</span>
          <span v-if="message" class="form-message" data-testid="form-message">{{ message }}</span>
        </ActionBar>
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
import { computed, ref } from "vue";
import ActionBar from "./ActionBar.vue";
import { defineAction, type ActionBarItem } from "./actions/actionRegistry";
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
const documentActions = computed<ActionBarItem[]>(() => [
  defineAction("create", { visible: props.showCreate !== false, enabled: !props.locked, testId: "new-document" }),
  defineAction("save", { visible: props.showSave !== false, enabled: !props.locked && props.canSave, testId: "save-sales-order" }),
  defineAction("audit", { visible: props.showAudit !== false, enabled: !props.locked && props.canAudit, testId: "audit-sales-order" }),
  defineAction("reverse", { visible: props.showReverse !== false, enabled: !props.locked && props.canReverse }),
  defineAction("redReverse", { visible: props.showRedReverse !== false, enabled: !props.locked && (props.canRedReverse ?? props.canReverse) }),
  defineAction("close", { visible: props.showClose !== false, enabled: !props.locked && props.canClose }),
  defineAction("unclose", { visible: props.showUnclose !== false, enabled: !props.locked && props.canUnclose }),
  defineAction("freeze", { visible: props.showFreeze !== false, enabled: !props.locked && props.canFreeze }),
  defineAction("unfreeze", { visible: props.showUnfreeze !== false, enabled: !props.locked && props.canUnfreeze }),
  defineAction("void", { visible: props.showVoid !== false, enabled: !props.locked && props.canVoid }),
  defineAction("sourceSelect", { visible: props.showSourceSelect, enabled: !props.locked && props.canSourceSelect, label: props.sourceSelectLabel, testId: props.sourceSelectTestId }),
  defineAction("pushDown", { visible: props.showPushDown, enabled: !props.locked && props.canPushDown, label: props.pushDownLabel, testId: props.pushDownTestId }),
  defineAction("extra", { visible: props.showExtraAction, enabled: !props.locked && props.canExtraAction, label: props.extraActionLabel, testId: props.extraActionTestId }),
  defineAction("delete", { visible: props.showDelete !== false, enabled: !props.locked && props.canDelete, testId: "delete-sales-order" }),
  defineAction("export", { visible: props.showExport !== false, enabled: props.canOutput, testId: "export-sales-order" }),
  defineAction("print", { visible: props.showPrint !== false, enabled: props.canOutput, testId: "print-sales-order" })
]);

function handleAction(key: string) {
  const handlers: Record<string, () => void> = {
    create: requestCreate,
    save: () => emit("save"),
    audit: () => emit("audit"),
    reverse: () => emit("reverse"),
    redReverse: () => emit("redReverse"),
    close: () => emit("closeDocument"),
    unclose: () => emit("uncloseDocument"),
    freeze: () => emit("freezeDocument"),
    unfreeze: () => emit("unfreezeDocument"),
    void: () => emit("voidDocument"),
    sourceSelect: () => emit("sourceSelect"),
    pushDown: () => emit("pushDown"),
    extra: () => emit("extraAction"),
    delete: () => emit("deleteDocument"),
    export: () => emit("exportDocument"),
    print: () => emit("printDocument")
  };
  handlers[key]?.();
}

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
