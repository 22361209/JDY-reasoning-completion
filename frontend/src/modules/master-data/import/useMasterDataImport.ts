import { computed, onBeforeUnmount, ref, shallowRef } from "vue";
import {
  confirmMasterDataImport,
  downloadMasterDataImportErrorReceipt,
  downloadMasterDataImportTemplate,
  fetchMasterDataImportJob,
  fetchMasterDataImportJobs,
  fetchMasterDataImportTemplates,
  previewMasterDataImport,
  type MasterDataImportJob,
  type MasterDataImportRow,
  type MasterDataImportTemplate
} from "../../../services/masterDataImportApi";
import {
  masterDataImportDefinition,
  masterDataImportDefinitionForList,
  masterDataImportDefinitions,
  type MasterDataImportType
} from "./importRegistry";

export type MasterDataImportWorkflowState =
  | "EMPTY"
  | "FILE_REJECTED"
  | "FILE_READY"
  | "DRY_RUNNING"
  | "PREVIEW_INVALID"
  | "READY_TO_COMMIT"
  | "COMMITTING"
  | "COMMITTED";

type MasterDataImportRequestFailure =
  | ""
  | "AUTH_REQUIRED"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "FILE_OR_TEMPLATE_INVALID"
  | "FILE_TOO_LARGE"
  | "CONFIRM_CONFLICT"
  | "JOB_EXPIRED"
  | "NETWORK_ERROR"
  | "SERVER_ERROR";

export interface MasterDataImportPreviewDisplayRow {
  key: string;
  rowNo: number;
  businessCode: string;
  field: string;
  errorCode: string;
  message: string;
  value: string;
  valid: boolean;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const PREVIEW_PAGE_SIZE = 100;

export function useMasterDataImport(options: {
  canImport: () => boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const selectedType = ref<MasterDataImportType>("productCategory");
  const templates = ref<MasterDataImportTemplate[]>([]);
  const selectedFile = shallowRef<File | null>(null);
  const fileInputKey = ref(0);
  const workflowState = ref<MasterDataImportWorkflowState>("EMPTY");
  const currentJob = ref<MasterDataImportJob | null>(null);
  const recentJobs = ref<MasterDataImportJob[]>([]);
  const message = ref("");
  const recentMessage = ref("");
  const requestFailure = ref<MasterDataImportRequestFailure>("");
  const dirty = ref(false);
  const confirmStateFresh = ref(false);
  const currentTimeMs = ref(Date.now());
  const confirmDialogOpen = ref(false);
  const typeChangeDialogOpen = ref(false);
  const pendingType = ref<MasterDataImportType | null>(null);
  const templateDownloading = ref(false);
  const receiptDownloading = ref(false);
  const recentLoading = ref(false);
  const jobLoading = ref(false);

  let interactionController: AbortController | null = null;
  let templateController: AbortController | null = null;
  let templateDownloadController: AbortController | null = null;
  let recentController: AbortController | null = null;
  let jobController: AbortController | null = null;
  let receiptController: AbortController | null = null;
  let interactionSerial = 0;
  let templateSerial = 0;
  let templateDownloadSerial = 0;
  let recentSerial = 0;
  let jobSerial = 0;
  let receiptSerial = 0;
  let workspaceSerial = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;

  const selectedDefinition = computed(() => masterDataImportDefinition(selectedType.value));
  const selectedTemplate = computed(() => templates.value.find((template) => template.type === selectedType.value) ?? null);
  const busy = computed(() => ["DRY_RUNNING", "COMMITTING"].includes(workflowState.value));
  const committing = computed(() => workflowState.value === "COMMITTING");
  const currentJobUnexpired = computed(() => {
    const expiresAt = Date.parse(currentJob.value?.expiresAt ?? "");
    return Number.isFinite(expiresAt) && expiresAt > currentTimeMs.value;
  });
  const canPreview = computed(() => options.canImport()
    && workflowState.value === "FILE_READY"
    && Boolean(selectedFile.value)
    && !busy.value);
  const canConfirm = computed(() => options.canImport()
    && confirmStateFresh.value
    && !requestFailure.value
    && workflowState.value === "READY_TO_COMMIT"
    && currentJob.value?.status === "VALIDATED"
    && currentJob.value.errorRows === 0
    && currentJob.value.totalRows > 0
    && currentJob.value.validRows === currentJob.value.totalRows
    && currentJob.value.canConfirm
    && currentJobUnexpired.value
    && !jobLoading.value
    && !busy.value);
  const canDownloadErrorReceipt = computed(() => options.canImport()
    && !requestFailure.value
    && Boolean(currentJob.value?.id)
    && ["VALIDATED", "INVALID", "STALE", "FAILED"].includes(currentJob.value?.status ?? "")
    && !receiptDownloading.value
    && !busy.value);
  const actualWriteCount = computed(() => {
    const job = currentJob.value;
    return job?.status === "COMMITTED" ? job.committedRows : 0;
  });
  const previewRows = computed<MasterDataImportPreviewDisplayRow[]>(() => flattenPreviewRows(currentJob.value?.rows ?? []));
  const previewPage = computed(() => currentJob.value?.rowPage ?? 1);
  const previewPageSize = computed(() => currentJob.value?.rowPageSize ?? PREVIEW_PAGE_SIZE);
  const previewTotal = computed(() => currentJob.value?.rowTotal ?? 0);
  const canPreviousPreviewPage = computed(() => options.canImport()
    && Boolean(currentJob.value?.id)
    && previewPage.value > 1
    && !jobLoading.value
    && !busy.value);
  const canNextPreviewPage = computed(() => options.canImport()
    && Boolean(currentJob.value?.id)
    && previewPage.value * previewPageSize.value < previewTotal.value
    && !jobLoading.value
    && !busy.value);
  const fileSizeLabel = computed(() => selectedFile.value ? formatFileSize(selectedFile.value.size) : "");
  const statusLabel = computed(() => requestFailure.value
    ? requestFailureLabel(requestFailure.value)
    : workflowStatusLabel(workflowState.value, currentJob.value));
  const statusTone = computed(() => requestFailure.value
    ? "danger"
    : workflowStatusTone(workflowState.value, currentJob.value));

  void loadTemplates();
  void loadRecentJobs();

  onBeforeUnmount(() => {
    workspaceSerial += 1;
    clearExpiryTimer();
    abortAll();
  });

  function setDirty(value: boolean) {
    if (dirty.value === value) return;
    dirty.value = value;
    options.onDirtyChange(value);
  }

  function selectFile(file: File | null) {
    workspaceSerial += 1;
    abortInteraction();
    abortJobRequest();
    abortReceiptRequest();
    clearExpiryTimer();
    confirmStateFresh.value = false;
    currentJob.value = null;
    confirmDialogOpen.value = false;
    message.value = "";
    requestFailure.value = "";
    selectedFile.value = file;
    if (!file) {
      workflowState.value = "EMPTY";
      setDirty(false);
      return;
    }

    setDirty(true);
    const clientError = clientFileError(file);
    if (clientError) {
      workflowState.value = "FILE_REJECTED";
      message.value = clientError;
      return;
    }
    workflowState.value = "FILE_READY";
    message.value = `已选择 ${file.name}，请执行服务端预检。`;
  }

  function clearFile() {
    resetWorkspace({ preserveType: true });
  }

  async function runPreview() {
    const file = selectedFile.value;
    if (!file || !canPreview.value) return;
    const contextSerial = workspaceSerial;
    const requestedType = selectedType.value;
    abortInteraction();
    const serial = ++interactionSerial;
    interactionController = new AbortController();
    workflowState.value = "DRY_RUNNING";
    requestFailure.value = "";
    message.value = "正在上传并执行服务端预检……";
    const fingerprint = fileFingerprint(file);
    const result = await previewMasterDataImport(selectedType.value, file, interactionController.signal);
    if (serial !== interactionSerial
      || contextSerial !== workspaceSerial
      || requestedType !== selectedType.value
      || fingerprint !== fileFingerprint(selectedFile.value)) return;
    interactionController = null;
    if (result.aborted) return;
    if (!result.ok || !result.data) {
      workflowState.value = [400, 413].includes(result.status) ? "FILE_REJECTED" : "FILE_READY";
      requestFailure.value = requestFailureForStatus(result.status);
      message.value = result.message;
      return;
    }
    if (result.data.type !== requestedType) {
      invalidateJobContract("预检响应的资料类型与上传请求不一致，请刷新后重试。");
      return;
    }
    applyJob(result.data, { preserveDirty: true });
    message.value = previewResultMessage(result.data);
    void loadRecentJobs();
  }

  function requestTypeChange(type: MasterDataImportType) {
    if (type === selectedType.value) return;
    if (busy.value) {
      message.value = "当前任务正在处理中，请完成后再切换资料类型。";
      return;
    }
    if (dirty.value) {
      pendingType.value = type;
      typeChangeDialogOpen.value = true;
      return;
    }
    applyType(type);
  }

  function confirmTypeChange() {
    const type = pendingType.value;
    typeChangeDialogOpen.value = false;
    pendingType.value = null;
    if (type) applyType(type);
  }

  function cancelTypeChange() {
    typeChangeDialogOpen.value = false;
    pendingType.value = null;
  }

  function openForList(listKey: string) {
    const definition = masterDataImportDefinitionForList(listKey);
    if (definition) requestTypeChange(definition.type);
  }

  function applyType(type: MasterDataImportType) {
    resetWorkspace({ preserveType: false });
    selectedType.value = type;
  }

  function resetWorkspace({ preserveType = true }: { preserveType?: boolean } = {}) {
    workspaceSerial += 1;
    abortInteraction();
    abortJobRequest();
    abortReceiptRequest();
    abortTemplateDownload();
    clearExpiryTimer();
    confirmStateFresh.value = false;
    selectedFile.value = null;
    currentJob.value = null;
    workflowState.value = "EMPTY";
    confirmDialogOpen.value = false;
    typeChangeDialogOpen.value = false;
    pendingType.value = null;
    message.value = "";
    requestFailure.value = "";
    fileInputKey.value += 1;
    setDirty(false);
    if (!preserveType) selectedType.value = "productCategory";
  }

  async function downloadTemplate() {
    if (!options.canImport() || templateDownloading.value) return;
    templateDownloadController?.abort();
    templateDownloadController = new AbortController();
    const serial = ++templateDownloadSerial;
    templateDownloading.value = true;
    message.value = "正在生成模板下载……";
    const result = await downloadMasterDataImportTemplate(selectedType.value, templateDownloadController.signal);
    if (serial !== templateDownloadSerial) return;
    templateDownloadController = null;
    templateDownloading.value = false;
    if (result.aborted) return;
    if (!result.ok || !result.blob) {
      requestFailure.value = requestFailureForStatus(result.status);
      message.value = result.message;
      return;
    }
    requestFailure.value = "";
    triggerBlobDownload(result.blob, result.fileName, "master-data-import-template-download-link");
    message.value = `已下载${selectedDefinition.value.label}导入模板。`;
  }

  async function loadTemplates() {
    templateController?.abort();
    templateController = new AbortController();
    const serial = ++templateSerial;
    const result = await fetchMasterDataImportTemplates(templateController.signal);
    if (serial !== templateSerial) return;
    templateController = null;
    if (result.aborted) return;
    if (!result.ok || !result.data) {
      requestFailure.value = requestFailureForStatus(result.status);
      message.value = result.message;
      return;
    }
    templates.value = result.data;
  }

  async function loadRecentJobs() {
    recentController?.abort();
    recentController = new AbortController();
    const serial = ++recentSerial;
    recentLoading.value = true;
    recentMessage.value = "";
    const result = await fetchMasterDataImportJobs(1, 12, recentController.signal);
    if (serial !== recentSerial) return;
    recentController = null;
    recentLoading.value = false;
    if (result.aborted) return;
    if (!result.ok || !result.data) {
      recentMessage.value = result.message;
      return;
    }
    recentJobs.value = result.data.jobs;
  }

  async function openRecentJob(job: MasterDataImportJob) {
    if (!options.canImport()) {
      recentMessage.value = "当前账号无权读取基础资料导入任务。";
      return;
    }
    if (dirty.value || busy.value) {
      recentMessage.value = "请先重置当前文件与预检结果。";
      return;
    }
    workspaceSerial += 1;
    abortInteraction();
    await loadJob(job.id, 1, { updateType: true });
  }

  async function loadJob(jobId: string, page: number, { updateType = false } = {}) {
    const expectedType = selectedType.value;
    abortJobRequest();
    abortReceiptRequest();
    clearExpiryTimer();
    confirmStateFresh.value = false;
    jobController = new AbortController();
    const serial = ++jobSerial;
    jobLoading.value = true;
    requestFailure.value = "";
    const result = await fetchMasterDataImportJob(jobId, page, PREVIEW_PAGE_SIZE, jobController.signal);
    if (serial !== jobSerial) return;
    jobController = null;
    jobLoading.value = false;
    if (result.aborted) return;
    if (!result.ok || !result.data) {
      requestFailure.value = requestFailureForStatus(result.status);
      message.value = result.message;
      return;
    }
    if (result.data.id !== jobId || (!updateType && result.data.type !== expectedType)) {
      invalidateJobContract("任务详情响应与当前导入任务不一致，请刷新后重试。");
      return;
    }
    if (updateType) selectedType.value = result.data.type;
    applyJob(result.data, { preserveDirty: dirty.value });
    message.value = `已打开导入任务 ${result.data.id}。`;
  }

  async function previousPreviewPage() {
    const job = currentJob.value;
    if (job && canPreviousPreviewPage.value) await loadJob(job.id, previewPage.value - 1);
  }

  async function nextPreviewPage() {
    const job = currentJob.value;
    if (job && canNextPreviewPage.value) await loadJob(job.id, previewPage.value + 1);
  }

  function openConfirmDialog() {
    if (canConfirm.value) confirmDialogOpen.value = true;
  }

  function closeConfirmDialog() {
    if (workflowState.value !== "COMMITTING") confirmDialogOpen.value = false;
  }

  async function submitConfirm() {
    const job = currentJob.value;
    if (!job || !canConfirm.value) return;
    const contextSerial = workspaceSerial;
    const expectedType = selectedType.value;
    const expectedFingerprint = fileFingerprint(selectedFile.value);
    abortJobRequest();
    abortReceiptRequest();
    abortInteraction();
    const serial = ++interactionSerial;
    interactionController = new AbortController();
    workflowState.value = "COMMITTING";
    clearExpiryTimer();
    confirmStateFresh.value = false;
    requestFailure.value = "";
    message.value = "正在原子确认导入……";
    const result = await confirmMasterDataImport(job.id, interactionController.signal);
    if (serial !== interactionSerial) return;
    interactionController = null;
    if (result.aborted) return;
    if (!result.ok || !result.data) {
      confirmDialogOpen.value = false;
      workflowState.value = result.status === 0 ? "READY_TO_COMMIT" : "PREVIEW_INVALID";
      requestFailure.value = requestFailureForStatus(result.status);
      const failureMessage = result.message;
      message.value = failureMessage;
      if (![401, 403, 404].includes(result.status)) {
        await loadJob(job.id, 1);
        if (!workspaceContextMatches(contextSerial, job.id, expectedType, expectedFingerprint)) {
          return;
        }
        if (currentJob.value?.status === "COMMITTED") {
          message.value = `导入已完成，成功新增 ${currentJob.value.committedRows} 条草稿。`;
          void loadRecentJobs();
          return;
        }
        message.value = failureMessage;
      }
      return;
    }
    if (result.data.id !== job.id || result.data.type !== expectedType) {
      confirmDialogOpen.value = false;
      invalidateJobContract("确认响应与当前导入任务不一致，已停止更新页面状态。");
      return;
    }
    confirmDialogOpen.value = false;
    applyJob(result.data, { preserveDirty: false });
    message.value = `导入已完成，成功新增 ${result.data.committedRows} 条草稿。`;
    void loadRecentJobs();
  }

  async function downloadErrorReceipt() {
    const job = currentJob.value;
    if (!job || !canDownloadErrorReceipt.value) return;
    const contextSerial = workspaceSerial;
    const expectedType = selectedType.value;
    const expectedFingerprint = fileFingerprint(selectedFile.value);
    receiptController?.abort();
    receiptController = new AbortController();
    const serial = ++receiptSerial;
    receiptDownloading.value = true;
    const result = await downloadMasterDataImportErrorReceipt(job.id, receiptController.signal);
    if (serial !== receiptSerial) return;
    receiptController = null;
    receiptDownloading.value = false;
    if (result.aborted) return;
    if (!result.ok || !result.blob) {
      requestFailure.value = requestFailureForStatus(result.status);
      message.value = result.message;
      if ([401, 403, 404, 410].includes(result.status)) {
        clearExpiryTimer();
        confirmStateFresh.value = false;
      }
      if (result.status === 410) {
        const failureMessage = result.message;
        await loadJob(job.id, 1);
        if (!workspaceContextMatches(contextSerial, job.id, expectedType, expectedFingerprint)) {
          return;
        }
        message.value = failureMessage;
      }
      return;
    }
    requestFailure.value = "";
    triggerBlobDownload(result.blob, result.fileName, "master-data-import-error-receipt-download-link");
    message.value = job.errorRows > 0 ? "错误回执已生成。" : "预检回执已生成。";
  }

  function applyJob(job: MasterDataImportJob, { preserveDirty }: { preserveDirty: boolean }) {
    currentJob.value = job;
    workflowState.value = workflowStateForJob(job);
    requestFailure.value = "";
    confirmStateFresh.value = true;
    scheduleExpiry(job);
    if (job.status === "COMMITTED") {
      if (selectedFile.value) {
        selectedFile.value = null;
        fileInputKey.value += 1;
      }
      setDirty(false);
    } else if (!preserveDirty) {
      setDirty(false);
    }
  }

  function abortInteraction() {
    interactionSerial += 1;
    interactionController?.abort();
    interactionController = null;
  }

  function abortJobRequest() {
    jobSerial += 1;
    jobController?.abort();
    jobController = null;
    jobLoading.value = false;
  }

  function abortReceiptRequest() {
    receiptSerial += 1;
    receiptController?.abort();
    receiptController = null;
    receiptDownloading.value = false;
  }

  function abortTemplateDownload() {
    templateDownloadSerial += 1;
    templateDownloadController?.abort();
    templateDownloadController = null;
    templateDownloading.value = false;
  }

  function abortAll() {
    abortInteraction();
    abortJobRequest();
    abortReceiptRequest();
    abortTemplateDownload();
    templateSerial += 1;
    recentSerial += 1;
    templateController?.abort();
    recentController?.abort();
    templateController = null;
    recentController = null;
  }

  function workspaceContextMatches(
    serial: number,
    expectedJobId: string,
    expectedType: MasterDataImportType,
    expectedFingerprint: string
  ) {
    return serial === workspaceSerial
      && selectedType.value === expectedType
      && currentJob.value?.id === expectedJobId
      && currentJob.value.type === expectedType
      && (currentJob.value.status === "COMMITTED"
        || fileFingerprint(selectedFile.value) === expectedFingerprint);
  }

  function invalidateJobContract(contractMessage: string) {
    clearExpiryTimer();
    confirmDialogOpen.value = false;
    confirmStateFresh.value = false;
    requestFailure.value = "SERVER_ERROR";
    workflowState.value = "PREVIEW_INVALID";
    message.value = contractMessage;
  }

  function scheduleExpiry(job: MasterDataImportJob) {
    clearExpiryTimer();
    currentTimeMs.value = Date.now();
    if (["COMMITTED", "EXPIRED"].includes(job.status)) return;
    const expiresAt = Date.parse(job.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= currentTimeMs.value) {
      expireCurrentJobLocally(job.id);
      return;
    }
    expiryTimer = setTimeout(() => expireCurrentJobLocally(job.id), expiresAt - currentTimeMs.value + 25);
  }

  function expireCurrentJobLocally(jobId: string) {
    expiryTimer = null;
    currentTimeMs.value = Date.now();
    if (currentJob.value?.id !== jobId || workflowState.value === "COMMITTING") return;
    confirmDialogOpen.value = false;
    confirmStateFresh.value = false;
    requestFailure.value = "JOB_EXPIRED";
    message.value = "预检任务已过期，请重新上传并预检。";
  }

  function clearExpiryTimer() {
    if (expiryTimer) {
      clearTimeout(expiryTimer);
      expiryTimer = null;
    }
  }

  function notifyNavigationBlocked() {
    message.value = "正在原子确认导入，完成并取得最终结果前不能关闭页签、切换类型或切换账套。";
  }

  return {
    definitions: masterDataImportDefinitions,
    selectedType,
    selectedDefinition,
    selectedTemplate,
    selectedFile,
    fileInputKey,
    fileSizeLabel,
    workflowState,
    statusLabel,
    statusTone,
    currentJob,
    recentJobs,
    previewRows,
    previewPage,
    previewTotal,
    actualWriteCount,
    message,
    recentMessage,
    busy,
    committing,
    templateDownloading,
    receiptDownloading,
    recentLoading,
    jobLoading,
    canPreview,
    canConfirm,
    canDownloadErrorReceipt,
    canPreviousPreviewPage,
    canNextPreviewPage,
    confirmDialogOpen,
    typeChangeDialogOpen,
    pendingType,
    selectFile,
    clearFile,
    runPreview,
    requestTypeChange,
    confirmTypeChange,
    cancelTypeChange,
    openForList,
    resetWorkspace,
    downloadTemplate,
    loadRecentJobs,
    openRecentJob,
    previousPreviewPage,
    nextPreviewPage,
    openConfirmDialog,
    closeConfirmDialog,
    submitConfirm,
    downloadErrorReceipt,
    notifyNavigationBlocked
  };
}

function clientFileError(file: File) {
  if (!file.name.toLowerCase().endsWith(".xlsx")) return "仅支持 .xlsx 文件，不接受 .xls、CSV 或压缩包。";
  if (file.size === 0) return "文件为空，请重新选择预置模板文件。";
  if (file.size > MAX_FILE_BYTES) return "原始文件不得超过 10 MiB。";
  return "";
}

function fileFingerprint(file: File | null) {
  return file ? `${file.name}|${file.size}|${file.lastModified}` : "";
}

function workflowStateForJob(job: MasterDataImportJob): MasterDataImportWorkflowState {
  if (job.status === "COMMITTED") return "COMMITTED";
  if (job.status === "VALIDATED" && job.canConfirm) return "READY_TO_COMMIT";
  return "PREVIEW_INVALID";
}

function previewResultMessage(job: MasterDataImportJob) {
  if (job.status === "VALIDATED" && job.canConfirm) {
    return `预检通过，可确认新增 ${job.validRows} 条草稿。`;
  }
  if (job.status === "INVALID") return `预检发现 ${job.errorRows} 个错误行，本批将写入 0 条。`;
  if (job.status === "STALE") return "基础资料已变化，本批不可确认，请重新上传并预检。";
  if (job.status === "EXPIRED") return "预检任务已过期，请重新上传并预检。";
  if (job.status === "FAILED") return "导入任务处理失败，本批未写入任何资料。";
  return "服务端未授予确认状态，请刷新任务或重新预检。";
}

function flattenPreviewRows(rows: MasterDataImportRow[]) {
  return rows.flatMap((row, rowIndex) => {
    if (row.errors.length === 0) {
      return [{
        key: `${row.rowNo}-${rowIndex}-valid`,
        rowNo: row.rowNo,
        businessCode: row.businessCode,
        field: "",
        errorCode: "",
        message: "可导入",
        value: "",
        valid: true
      }];
    }
    return row.errors.map((error, errorIndex) => ({
      key: `${row.rowNo}-${rowIndex}-${error.field}-${errorIndex}`,
      rowNo: error.rowNo || row.rowNo,
      businessCode: row.businessCode,
      field: error.field,
      errorCode: error.code,
      message: error.message,
      value: error.value,
      valid: false
    }));
  });
}

function workflowStatusLabel(state: MasterDataImportWorkflowState, job: MasterDataImportJob | null) {
  const statusLabels: Record<string, string> = {
    VALIDATED: "预检通过",
    INVALID: "预检不通过",
    COMMITTED: "已导入",
    STALE: "资料已变化",
    FAILED: "导入失败",
    EXPIRED: "预检已过期"
  };
  if (state === "DRY_RUNNING") return "正在上传预检";
  if (state === "COMMITTING") return "正在原子导入";
  if (job?.status === "VALIDATED" && !job.canConfirm) return "预检不可确认";
  if (job) return statusLabels[job.status] ?? job.status;
  const workflowLabels: Record<MasterDataImportWorkflowState, string> = {
    EMPTY: "等待选择文件",
    FILE_REJECTED: "文件不符合基础要求",
    FILE_READY: "等待服务端预检",
    DRY_RUNNING: "正在上传预检",
    PREVIEW_INVALID: "预检不通过",
    READY_TO_COMMIT: "预检通过",
    COMMITTING: "正在原子导入",
    COMMITTED: "已导入"
  };
  return workflowLabels[state];
}

function workflowStatusTone(state: MasterDataImportWorkflowState, job: MasterDataImportJob | null) {
  if (["DRY_RUNNING", "COMMITTING"].includes(state)) return "working";
  const status = job?.status;
  if (status === "COMMITTED") return "audited";
  if (status === "VALIDATED") return job?.canConfirm ? "ready" : "danger";
  if (["INVALID", "STALE", "FAILED", "EXPIRED"].includes(status ?? "")) return "danger";
  if (state === "FILE_REJECTED") return "danger";
  return "draft";
}

function requestFailureForStatus(status: number): MasterDataImportRequestFailure {
  if (status === 401) return "AUTH_REQUIRED";
  if (status === 403) return "PERMISSION_DENIED";
  if (status === 404) return "NOT_FOUND";
  if (status === 400) return "FILE_OR_TEMPLATE_INVALID";
  if (status === 413) return "FILE_TOO_LARGE";
  if (status === 409) return "CONFIRM_CONFLICT";
  if (status === 410) return "JOB_EXPIRED";
  if (status === 0) return "NETWORK_ERROR";
  return "SERVER_ERROR";
}

function requestFailureLabel(failure: MasterDataImportRequestFailure) {
  if (!failure) return "";
  const labels: Record<Exclude<MasterDataImportRequestFailure, "">, string> = {
    AUTH_REQUIRED: "登录状态已失效",
    PERMISSION_DENIED: "无导入权限",
    NOT_FOUND: "任务或导入类型不存在",
    FILE_OR_TEMPLATE_INVALID: "文件或模板不符合合同",
    FILE_TOO_LARGE: "文件超出导入上限",
    CONFIRM_CONFLICT: "确认时资料已变化",
    JOB_EXPIRED: "预检任务已过期",
    NETWORK_ERROR: "网络请求失败",
    SERVER_ERROR: "服务端处理失败"
  };
  return labels[failure];
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function triggerBlobDownload(blob: Blob, fileName: string, testId: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.dataset.testid = testId;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
