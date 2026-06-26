<template>
  <div class="business-page">
    <div class="business-head">
      <div>
        <h2>{{ title }}</h2>
        <p>{{ subtitle }}</p>
      </div>
      <div class="status-stamp" :class="statusClass" data-testid="document-status">{{ statusLabel }}</div>
    </div>

    <div v-if="locked" class="lock-banner" data-testid="lock-banner">
      {{ lockMessage || "单据已被他人打开，只读" }}
      <button v-if="canOverrideLock" type="button" data-testid="override-document-lock" @click="$emit('overrideLock')">踢走并编辑</button>
    </div>

    <div class="action-bar">
      <button class="primary-action" type="button" :disabled="locked" data-testid="new-document" @click="$emit('create')">新增</button>
      <button type="button" :disabled="locked || !canSave" data-testid="save-sales-order" @click="$emit('save')">保存</button>
      <button type="button" :disabled="locked || !canAudit" data-testid="audit-sales-order" @click="$emit('audit')">审核</button>
      <button type="button" :disabled="locked || !canReverse" data-testid="reverse-document" @click="$emit('reverse')">反审核</button>
      <button type="button" :disabled="locked || !(canRedReverse ?? canReverse)" data-testid="red-reverse-document" @click="$emit('redReverse')">红冲</button>
      <button type="button" :disabled="locked || !canClose" data-testid="close-document" @click="$emit('closeDocument')">关闭</button>
      <button type="button" :disabled="locked || !canUnclose" data-testid="unclose-document" @click="$emit('uncloseDocument')">反关闭</button>
      <button type="button" :disabled="locked || !canFreeze" data-testid="freeze-document" @click="$emit('freezeDocument')">冻结</button>
      <button type="button" :disabled="locked || !canUnfreeze" data-testid="unfreeze-document" @click="$emit('unfreezeDocument')">解冻</button>
      <button class="danger-action" type="button" :disabled="locked || !canVoid" data-testid="void-document" @click="$emit('voidDocument')">更多/危险区：作废</button>
      <button v-if="showSourceSelect" type="button" :disabled="locked || !canSourceSelect" :data-testid="sourceSelectTestId" @click="$emit('sourceSelect')">{{ sourceSelectLabel }}</button>
      <button v-if="showPushDown" type="button" :disabled="locked || !canPushDown" :data-testid="pushDownTestId" @click="$emit('pushDown')">{{ pushDownLabel }}</button>
      <button type="button" :disabled="locked || !canDelete" data-testid="delete-sales-order" @click="$emit('deleteDocument')">删除</button>
      <button type="button" :disabled="!canOutput" data-testid="export-sales-order" @click="$emit('exportDocument')">引出</button>
      <button type="button" :disabled="!canOutput" data-testid="print-sales-order" @click="$emit('printDocument')">打印</button>
      <span v-if="dirty" class="dirty-tip">有未保存改动</span>
      <span v-if="message" class="form-message" data-testid="form-message">{{ message }}</span>
    </div>

    <slot />
  </div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  title: string;
  subtitle: string;
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
  showPushDown?: boolean;
  canPushDown?: boolean;
  pushDownLabel?: string;
  pushDownTestId?: string;
  showSourceSelect?: boolean;
  canSourceSelect?: boolean;
  sourceSelectLabel?: string;
  sourceSelectTestId?: string;
}>(), {
  lockMessage: "",
  canOverrideLock: false,
  canRedReverse: undefined,
  canClose: false,
  canUnclose: false,
  canFreeze: false,
  canUnfreeze: false,
  showPushDown: false,
  canPushDown: false,
  pushDownLabel: "下推",
  pushDownTestId: "push-down-document",
  showSourceSelect: false,
  canSourceSelect: false,
  sourceSelectLabel: "选源单",
  sourceSelectTestId: "select-source-document"
});

defineEmits<{
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
  deleteDocument: [];
  exportDocument: [];
  printDocument: [];
  showExisting: [];
  overrideLock: [];
}>();
</script>
