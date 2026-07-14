<template>
  <section ref="pageRef" class="master-data-import-page" tabindex="-1" data-testid="master-data-import-page">
    <DocumentCommandHeader
      title="Excel 导入"
      subtitle="使用预置模板批量新增基础资料；预检不会写入业务资料，确认成功后统一保存为草稿。"
      show-subtitle
      :status-label="importState.statusLabel.value"
      :status-class="importState.statusTone.value"
    >
      <template #actions>
        <button
          type="button"
          :disabled="!canImport || importState.templateDownloading.value || importState.busy.value"
          data-testid="master-data-import-template-download"
          @click="importState.downloadTemplate"
        >
          {{ importState.templateDownloading.value ? "下载中…" : "下载预置模板" }}
        </button>
        <button
          type="button"
          :disabled="importState.busy.value"
          data-testid="master-data-import-reset"
          @click="importState.resetWorkspace()"
        >
          重置
        </button>
      </template>
    </DocumentCommandHeader>

    <div class="master-data-import-layout">
      <div class="master-data-import-workspace">
        <section class="master-data-import-card master-data-import-upload-card">
          <div class="master-data-import-card__head">
            <div>
              <h3>上传与预检</h3>
              <p>请先下载当前类型模板，填写后上传原始 .xlsx 文件。</p>
            </div>
            <span class="master-data-import-tenant" data-testid="master-data-import-tenant">
              当前账套：<strong>{{ tenantName }}</strong>
              <small>{{ accountSetCode }}</small>
            </span>
          </div>

          <div class="master-data-import-controls">
            <label class="master-data-import-field">
              <span>资料类型</span>
              <select
                :value="importState.selectedType.value"
                :disabled="!canImport || importState.busy.value"
                data-testid="master-data-import-type"
                @change="handleTypeChange"
              >
                <option v-for="definition in importState.definitions" :key="definition.type" :value="definition.type">
                  {{ definition.label }}
                </option>
              </select>
            </label>
            <div class="master-data-import-template-meta">
              <span>模板版本</span>
              <strong>{{ importState.selectedTemplate.value ? `v${importState.selectedTemplate.value.templateVersion}` : "未加载" }}</strong>
              <small>{{ importState.selectedTemplate.value?.description || `${importState.selectedDefinition.value.label}预置模板` }}</small>
            </div>
          </div>

          <div class="master-data-import-hints" data-testid="master-data-import-limit-hint">
            <span><strong>.xlsx / 10 MiB / 5,000 行</strong>，文件限制以后端校验为准</span>
            <span><strong>只新增</strong>，不更新、不覆盖、不跳过错误行</span>
            <span><strong>导入后为草稿</strong>，不会自动审核</span>
            <span><strong>整批原子</strong>，任一失败全部回滚</span>
          </div>

          <div class="master-data-import-file-zone" :class="{ selected: importState.selectedFile.value }">
            <label class="master-data-import-file-picker">
              <span>{{ importState.selectedFile.value ? "重新选择文件" : "选择 .xlsx 文件" }}</span>
              <input
                :key="importState.fileInputKey.value"
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                :disabled="!canImport || importState.busy.value"
                data-testid="master-data-import-file"
                @change="handleFileSelected"
              />
            </label>
            <div class="master-data-import-file-name">
              <strong>{{ importState.selectedFile.value?.name || "尚未选择文件" }}</strong>
              <small v-if="importState.selectedFile.value">{{ importState.fileSizeLabel.value }}</small>
              <small v-else>浏览器不读取文件内容，文件将直接上传到服务端预检。</small>
            </div>
            <button
              type="button"
              :disabled="!importState.selectedFile.value || importState.busy.value"
              data-testid="master-data-import-file-clear"
              @click="importState.clearFile"
            >
              清除
            </button>
          </div>

          <div class="master-data-import-upload-actions">
            <button
              class="primary-action"
              type="button"
              :disabled="!importState.canPreview.value"
              data-testid="master-data-import-dry-run"
              @click="importState.runPreview"
            >
              {{ importState.workflowState.value === "DRY_RUNNING" ? "正在预检…" : "上传并预检" }}
            </button>
            <span
              class="master-data-import-status"
              :class="`is-${importState.statusTone.value}`"
              role="status"
              aria-live="polite"
              data-testid="master-data-import-status"
            >
              {{ importState.statusLabel.value }}
            </span>
            <p v-if="importState.message.value" class="master-data-import-message" data-testid="master-data-import-message">
              {{ importState.message.value }}
            </p>
          </div>
          <p v-if="!canImport" class="master-data-import-warning">当前账号无基础资料维护权限，不能执行导入。</p>
        </section>

        <section class="master-data-import-card master-data-import-summary-card">
          <div class="master-data-import-card__head">
            <div>
              <h3>预检摘要</h3>
              <p v-if="importState.currentJob.value">任务 {{ importState.currentJob.value.id }}</p>
              <p v-else>上传后由服务端返回真实计数与可确认状态。</p>
            </div>
            <small v-if="importState.currentJob.value?.expiresAt">有效期至 {{ formatDateTime(importState.currentJob.value.expiresAt) }}</small>
          </div>

          <div class="master-data-import-summary">
            <div data-testid="master-data-import-summary-total">
              <span>总行数</span>
              <strong>{{ importState.currentJob.value?.totalRows ?? 0 }}</strong>
            </div>
            <div data-testid="master-data-import-summary-valid">
              <span>有效行</span>
              <strong>{{ importState.currentJob.value?.validRows ?? 0 }}</strong>
            </div>
            <div class="danger" data-testid="master-data-import-summary-errors">
              <span>错误行</span>
              <strong>{{ importState.currentJob.value?.errorRows ?? 0 }}</strong>
            </div>
            <div class="write-count" data-testid="master-data-import-summary-write-count">
              <span>本批写入</span>
              <strong>{{ importState.actualWriteCount.value }}</strong>
            </div>
          </div>

          <div class="master-data-import-summary-actions">
            <button
              type="button"
              :disabled="!importState.canDownloadErrorReceipt.value"
              data-testid="master-data-import-error-receipt"
              @click="importState.downloadErrorReceipt"
            >
              {{ importState.receiptDownloading.value
                ? "生成中…"
                : importState.currentJob.value?.errorRows
                  ? "下载错误回执"
                  : "下载预检回执" }}
            </button>
            <button
              class="primary-action"
              type="button"
              :disabled="!importState.canConfirm.value"
              data-testid="master-data-import-confirm"
              @click="importState.openConfirmDialog"
            >
              确认导入
            </button>
          </div>

          <div
            v-if="importState.currentJob.value?.status === 'COMMITTED'"
            class="master-data-import-result"
            data-testid="master-data-import-result"
          >
            <strong>导入完成</strong>
            <span>已新增 {{ importState.currentJob.value.committedRows }} 条{{ importState.selectedDefinition.value.label }}草稿。</span>
            <button
              type="button"
              :disabled="!canImport"
              data-testid="master-data-import-open-list"
              @click="emit('openList', importState.selectedDefinition.value.listKey)"
            >
              打开资料列表
            </button>
          </div>
        </section>

        <section class="master-data-import-card master-data-import-preview-card">
          <div class="master-data-import-card__head">
            <div>
              <h3>行预览与错误</h3>
              <p>Excel 行号与字段错误均来自服务端预检结果。</p>
            </div>
            <span v-if="importState.currentJob.value">第 {{ importState.previewPage.value }} 页 / 共 {{ importState.previewTotal.value }} 行</span>
          </div>
          <div class="master-data-import-table-wrap">
            <TableCore
              kind="list"
              test-id="master-data-import-preview-table"
              frame-class="vxe-wrap master-data-import-preview-table"
              inner-class="table-core-vxe-inner"
              table-class="vxe-table data-list-native-table"
              header-wrapper-class="vxe-table--header-wrapper body--wrapper"
              body-wrapper-class="vxe-table--body-wrapper body--wrapper"
              header-row-class="vxe-header--row"
              :columns="previewColumns"
              :rows="importState.previewRows.value"
              :min-width="920"
              :row-key="previewRowKey"
              :row-class="previewRowClass"
              :row-attrs="previewRowAttrs"
              :cell-title="previewCellTitle"
            >
              <template #cell="{ row, column }">
                <span v-if="column.key === 'valid'" class="master-data-import-row-state" :class="row.valid ? 'valid' : 'invalid'">
                  {{ row.valid ? "可导入" : "错误" }}
                </span>
                <span v-else>{{ previewCellValue(row, column.key) }}</span>
              </template>
              <template #overlay>
                <div v-if="!importState.previewRows.value.length" class="list-state-panel">
                  {{ importState.jobLoading.value ? "正在加载预览…" : "完成服务端预检后在这里查看逐行结果。" }}
                </div>
              </template>
            </TableCore>
          </div>
          <div class="master-data-import-pagination">
            <button
              type="button"
              :disabled="!importState.canPreviousPreviewPage.value"
              data-testid="master-data-import-preview-previous"
              @click="importState.previousPreviewPage"
            >
              上一页
            </button>
            <button
              type="button"
              :disabled="!importState.canNextPreviewPage.value"
              data-testid="master-data-import-preview-next"
              @click="importState.nextPreviewPage"
            >
              下一页
            </button>
          </div>
        </section>
      </div>

      <aside class="master-data-import-card master-data-import-recent-card">
        <div class="master-data-import-card__head">
          <div>
            <h3>最近任务</h3>
            <p>仅显示当前账套、当前操作人的导入任务。</p>
          </div>
          <button
            type="button"
            :disabled="!canImport || importState.recentLoading.value"
            data-testid="master-data-import-recent-refresh"
            @click="importState.loadRecentJobs"
          >
            刷新
          </button>
        </div>
        <div class="master-data-import-recent-list">
          <button
            v-for="job in importState.recentJobs.value"
            :key="job.id"
            type="button"
            :disabled="!canImport || importState.busy.value"
            :data-testid="`master-data-import-recent-${job.id}`"
            @click="importState.openRecentJob(job)"
          >
            <span>
              <strong>{{ definitionLabel(job.type) }}</strong>
              <small>{{ job.fileName || job.id }}</small>
            </span>
            <span>
              <em :class="`is-${jobStatusTone(job.status)}`">{{ jobStatusLabel(job.status) }}</em>
              <small>{{ formatDateTime(job.createdAt) }}</small>
            </span>
          </button>
          <div v-if="!importState.recentLoading.value && !importState.recentJobs.value.length" class="master-data-import-recent-empty">
            暂无导入任务。
          </div>
          <div v-if="importState.recentLoading.value" class="master-data-import-recent-empty">正在加载…</div>
        </div>
        <p
          v-if="importState.recentMessage.value"
          class="master-data-import-message"
          data-testid="master-data-import-recent-message"
        >
          {{ importState.recentMessage.value }}
        </p>
      </aside>
    </div>

    <div v-if="importState.confirmDialogOpen.value" class="modal-mask" data-testid="master-data-import-confirm-dialog">
      <div
        ref="confirmDialogRef"
        class="dialog master-data-import-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="master-data-import-confirm-title"
        aria-describedby="master-data-import-confirm-description"
        :aria-busy="importState.committing.value"
        tabindex="-1"
        @keydown="handleConfirmDialogKeydown"
      >
        <h3 id="master-data-import-confirm-title">确认导入{{ importState.selectedDefinition.value.label }}</h3>
        <p id="master-data-import-confirm-description">将新增 {{ importState.currentJob.value?.validRows ?? 0 }} 条草稿，任一失败整批回滚。</p>
        <p>确认时服务端会重新校验编码与引用；预检通过不代表可以绕过实时校验。</p>
        <div class="dialog-actions">
          <button
            ref="confirmCancelRef"
            type="button"
            :disabled="importState.workflowState.value === 'COMMITTING'"
            @click="importState.closeConfirmDialog"
          >
            取消
          </button>
          <button
            class="primary-action"
            type="button"
            :disabled="!importState.canConfirm.value || importState.workflowState.value === 'COMMITTING'"
            data-testid="master-data-import-confirm-submit"
            @click="importState.submitConfirm"
          >
            {{ importState.workflowState.value === "COMMITTING" ? "正在导入…" : "确认并原子写入" }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="importState.typeChangeDialogOpen.value" class="modal-mask" data-testid="master-data-import-type-change-dialog">
      <div
        ref="typeChangeDialogRef"
        class="dialog master-data-import-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="master-data-import-type-change-title"
        aria-describedby="master-data-import-type-change-description"
        tabindex="-1"
        @keydown="handleTypeChangeDialogKeydown"
      >
        <h3 id="master-data-import-type-change-title">切换资料类型</h3>
        <p id="master-data-import-type-change-description">当前文件或预检结果将被清除，旧任务令牌不再用于本次操作。</p>
        <div class="dialog-actions">
          <button ref="typeChangeCancelRef" type="button" @click="importState.cancelTypeChange">取消</button>
          <button class="danger-action" type="button" data-testid="master-data-import-type-change-confirm" @click="importState.confirmTypeChange">清除并切换</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import DocumentCommandHeader from "../../../components/DocumentCommandHeader.vue";
import TableCore, { type TableCoreColumn } from "../../../components/table/TableCore.vue";
import type { MasterDataImportJobStatus } from "../../../services/masterDataImportApi";
import { isMasterDataImportType, masterDataImportDefinition, type MasterDataImportType } from "./importRegistry";
import { useMasterDataImport, type MasterDataImportPreviewDisplayRow } from "./useMasterDataImport";

const props = defineProps<{
  tenantName: string;
  accountSetCode: string;
  canImport: boolean;
}>();

const emit = defineEmits<{
  dirtyChange: [dirty: boolean];
  committingChange: [committing: boolean];
  openList: [listKey: string];
}>();

const importState = useMasterDataImport({
  canImport: () => props.canImport,
  onDirtyChange: (dirty) => emit("dirtyChange", dirty)
});
const pageRef = ref<HTMLElement | null>(null);
const confirmDialogRef = ref<HTMLElement | null>(null);
const confirmCancelRef = ref<HTMLButtonElement | null>(null);
const typeChangeDialogRef = ref<HTMLElement | null>(null);
const typeChangeCancelRef = ref<HTMLButtonElement | null>(null);
let confirmReturnFocus: HTMLElement | null = null;
let typeChangeReturnFocus: HTMLElement | null = null;

const previewColumns: TableCoreColumn[] = [
  { key: "rowNo", title: "Excel 行号", width: 92, minWidth: 80, align: "right", filterable: false },
  { key: "businessCode", title: "业务编码", width: 150, minWidth: 110, filterable: false },
  { key: "field", title: "字段", width: 130, minWidth: 100, filterable: false },
  { key: "errorCode", title: "错误码", width: 168, minWidth: 120, filterable: false },
  { key: "message", title: "信息", width: 260, minWidth: 180, filterable: false },
  { key: "value", title: "原值", width: 160, minWidth: 110, filterable: false },
  { key: "valid", title: "结果", width: 80, minWidth: 72, align: "center", filterable: false }
];

defineExpose({
  openForList: importState.openForList,
  notifyNavigationBlocked: importState.notifyNavigationBlocked
});

watch(importState.committing, async (committing) => {
  emit("committingChange", committing);
  if (committing) {
    await nextTick();
    if (importState.committing.value) confirmDialogRef.value?.focus();
  }
}, { immediate: true });

watch(importState.confirmDialogOpen, async (open, wasOpen) => {
  if (open) {
    confirmReturnFocus = activeElement();
    await nextTick();
    if (importState.confirmDialogOpen.value) {
      (confirmCancelRef.value ?? confirmDialogRef.value)?.focus();
    }
    return;
  }
  if (wasOpen) {
    const returnTarget = confirmReturnFocus;
    confirmReturnFocus = null;
    await nextTick();
    restoreFocus(returnTarget, pageRef.value);
  }
});

watch(importState.typeChangeDialogOpen, async (open, wasOpen) => {
  if (open) {
    typeChangeReturnFocus = activeElement();
    await nextTick();
    if (importState.typeChangeDialogOpen.value) {
      (typeChangeCancelRef.value ?? typeChangeDialogRef.value)?.focus();
    }
    return;
  }
  if (wasOpen) {
    const returnTarget = typeChangeReturnFocus;
    typeChangeReturnFocus = null;
    await nextTick();
    restoreFocus(returnTarget, pageRef.value);
  }
});

function handleFileSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  importState.selectFile(input.files?.[0] ?? null);
}

function handleTypeChange(event: Event) {
  const select = event.target as HTMLSelectElement;
  const type = select.value;
  if (isMasterDataImportType(type)) {
    importState.requestTypeChange(type);
  }
  void nextTick(() => {
    select.value = importState.selectedType.value;
  });
}

function handleConfirmDialogKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    if (!importState.committing.value) importState.closeConfirmDialog();
    return;
  }
  trapDialogFocus(event, confirmDialogRef.value);
}

function handleTypeChangeDialogKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    importState.cancelTypeChange();
    return;
  }
  trapDialogFocus(event, typeChangeDialogRef.value);
}

function trapDialogFocus(event: KeyboardEvent, dialog: HTMLElement | null) {
  if (event.key !== "Tab" || !dialog) return;
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>([
    "button:not([disabled])",
    "a[href]",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])"
  ].join(","))).filter((element) => element.getAttribute("aria-hidden") !== "true");
  if (!focusable.length) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !dialog.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

function activeElement() {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

function restoreFocus(target: HTMLElement | null, fallback: HTMLElement | null) {
  const targetDisabled = target instanceof HTMLButtonElement && target.disabled;
  if (target?.isConnected && !targetDisabled) {
    target.focus();
    return;
  }
  fallback?.focus();
}

function definitionLabel(type: MasterDataImportType) {
  return masterDataImportDefinition(type).label;
}

function previewRowKey(row: MasterDataImportPreviewDisplayRow) {
  return row.key;
}

function previewRowClass(row: MasterDataImportPreviewDisplayRow) {
  return ["vxe-body--row", { "master-data-import-row-invalid": !row.valid }];
}

function previewRowAttrs(row: MasterDataImportPreviewDisplayRow) {
  return { "data-testid": `master-data-import-preview-row-${row.rowNo}` };
}

function previewCellValue(row: MasterDataImportPreviewDisplayRow, key: string) {
  return String(row[key as keyof MasterDataImportPreviewDisplayRow] ?? "");
}

function previewCellTitle(row: MasterDataImportPreviewDisplayRow, column: TableCoreColumn) {
  return previewCellValue(row, column.key);
}

function jobStatusLabel(status: MasterDataImportJobStatus) {
  return {
    VALIDATED: "预检通过",
    INVALID: "预检不通过",
    COMMITTED: "已导入",
    STALE: "资料已变化",
    FAILED: "导入失败",
    EXPIRED: "已过期"
  }[status];
}

function jobStatusTone(status: MasterDataImportJobStatus) {
  if (status === "COMMITTED") return "audited";
  if (status === "VALIDATED") return "ready";
  return "danger";
}

function formatDateTime(value: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}
</script>
