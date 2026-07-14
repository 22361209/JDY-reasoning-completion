import { computed, reactive, ref, type Ref } from "vue";
import { documentLifecycleStatusLabel } from "../../../app/documentLifecyclePolicy";
import { voidDocumentHardened, type DocumentDetail } from "../../../services/documentApi";
import {
  auditMaterialScrap,
  deleteMaterialScrap,
  fetchMaterialScrapDetail,
  reverseMaterialScrap,
  reverseStockInMaterialScrap,
  saveMaterialScrapDraft,
  stockInMaterialScrap,
  type MaterialScrapDetail,
  type MaterialScrapDocument,
  type MaterialScrapLine
} from "../../../services/productionApi";

type PendingAction = "reverse" | "delete" | "void" | "stockIn" | "reverseStockIn" | "";

interface RuntimeOptions {
  hasPermission: (permission: string) => boolean;
  isLocked: () => boolean;
  accountSetKey: () => string;
}

interface MaterialScrapState {
  document: MaterialScrapDocument;
  lines: MaterialScrapLine[];
}

interface MaterialScrapSharedRuntime {
  accountSetKey: string;
  state: MaterialScrapState;
  message: Ref<string>;
  pendingAction: Ref<PendingAction>;
  voidReason: Ref<string>;
  voidUsername: Ref<string>;
  voidPassword: Ref<string>;
  saving: Ref<boolean>;
  operationInFlight: Ref<boolean>;
  previewing: Ref<boolean>;
  dirty: Ref<boolean>;
  dirtyRevision: Ref<number>;
  epoch: Ref<number>;
}

let sharedRuntime: MaterialScrapSharedRuntime | null = null;
export const materialScrapSharedBusy = ref(false);
export const materialScrapSharedDirty = ref(false);
export const materialScrapSharedDirtyRevision = ref(0);

function syncMaterialScrapSharedBusy(target: MaterialScrapSharedRuntime) {
  if (sharedRuntime !== target) return;
  materialScrapSharedBusy.value = target.saving.value
    || target.operationInFlight.value
    || target.previewing.value;
}

function setMaterialScrapSharedDirty(target: MaterialScrapSharedRuntime, dirty: boolean, touch = false) {
  target.dirty.value = dirty;
  if (touch) target.dirtyRevision.value += 1;
  if (sharedRuntime !== target) return;
  materialScrapSharedDirty.value = dirty;
  materialScrapSharedDirtyRevision.value = target.dirtyRevision.value;
}

function clearMaterialScrapSharedActionState(target: MaterialScrapSharedRuntime) {
  target.pendingAction.value = "";
  target.voidReason.value = "";
  target.voidUsername.value = "";
  target.voidPassword.value = "";
}

function materialScrapSharedRuntime(accountSetKey: string) {
  if (!sharedRuntime || sharedRuntime.accountSetKey !== accountSetKey) {
    if (sharedRuntime) sharedRuntime.epoch.value += 1;
    sharedRuntime = {
      accountSetKey,
      state: reactive<MaterialScrapState>(blankState()),
      message: ref(""),
      pendingAction: ref<PendingAction>(""),
      voidReason: ref(""),
      voidUsername: ref(""),
      voidPassword: ref(""),
      saving: ref(false),
      operationInFlight: ref(false),
      previewing: ref(false),
      dirty: ref(false),
      dirtyRevision: ref(0),
      epoch: ref(0)
    };
    materialScrapSharedBusy.value = false;
    materialScrapSharedDirty.value = false;
    materialScrapSharedDirtyRevision.value = 0;
  }
  return sharedRuntime;
}

export function resetMaterialScrapRuntime(accountSetKey?: string) {
  if (!sharedRuntime || (accountSetKey && sharedRuntime.accountSetKey !== accountSetKey)) return;
  sharedRuntime.epoch.value += 1;
  sharedRuntime = null;
  materialScrapSharedBusy.value = false;
  materialScrapSharedDirty.value = false;
  materialScrapSharedDirtyRevision.value = 0;
}

export function startNewMaterialScrapSharedRuntime(accountSetKey: string) {
  if (!accountSetKey) return false;
  const target = materialScrapSharedRuntime(accountSetKey);
  if (target.saving.value || target.operationInFlight.value || target.previewing.value) return false;
  target.epoch.value += 1;
  const blank = blankState();
  target.state.document = blank.document;
  target.state.lines = blank.lines;
  clearMaterialScrapSharedActionState(target);
  setMaterialScrapSharedDirty(target, true, true);
  target.message.value = "请先选择已审核且仍有可报废数量的生产领料单。";
  return true;
}

export function applyMaterialScrapSharedDetail(
  accountSetKey: string,
  detail: MaterialScrapDetail | DocumentDetail,
  expectedBillNo: string,
  loadedMessage = ""
) {
  if (!accountSetKey) return false;
  const payload = detail as MaterialScrapDetail;
  const document = normalizeDocument(payload.document ?? {});
  if (!expectedBillNo || document.billNo !== expectedBillNo) return false;
  const target = materialScrapSharedRuntime(accountSetKey);
  if (target.saving.value || target.operationInFlight.value || target.previewing.value) return false;
  target.epoch.value += 1;
  target.state.document = document;
  target.state.lines = Array.isArray(payload.lines) ? payload.lines.map(normalizeLine) : [];
  clearMaterialScrapSharedActionState(target);
  setMaterialScrapSharedDirty(target, false);
  target.message.value = loadedMessage;
  return true;
}

export function useMaterialScrapDocument(runtime: RuntimeOptions) {
  const ownerAccountSetKey = runtime.accountSetKey();
  const shared = materialScrapSharedRuntime(ownerAccountSetKey);
  const { state, message, pendingAction, voidReason, voidUsername, voidPassword, saving, operationInFlight, previewing, dirty } = shared;

  const mutationInFlight = computed(() => saving.value || operationInFlight.value || previewing.value);
  const editable = computed(() => state.document.status === "DRAFT" && !runtime.isLocked() && !mutationInFlight.value);
  const persisted = computed(() => Boolean(state.document.billNo));
  const hasPermission = computed(() => runtime.hasPermission("production.document.audit"));
  const canSave = computed(() => !saving.value && editable.value && hasPermission.value && Boolean(state.document.sourceIssueNo) && state.lines.length > 0);
  const canSourceSelect = computed(() => editable.value && !persisted.value);
  const canAudit = computed(() => editable.value && persisted.value && hasPermission.value && !dirty.value && !mutationInFlight.value);
  const canReverse = computed(() => (
    state.document.status === "AUDITED" &&
    state.document.stockInStatus !== "STOCKED_IN" &&
    hasPermission.value &&
    !runtime.isLocked() &&
    !mutationInFlight.value
  ));
  const canVoid = computed(() => editable.value && persisted.value && hasPermission.value && !mutationInFlight.value);
  const canDelete = computed(() => editable.value && persisted.value && hasPermission.value && !mutationInFlight.value);
  const hasStockInLines = computed(() => state.lines.some((line) => line.isStockIn));
  const showStockAction = computed(() => state.document.status === "AUDITED" && hasStockInLines.value);
  const stockActionLabel = computed(() => state.document.stockInStatus === "STOCKED_IN" ? "撤销报废入库" : "报废入库");
  const canStockAction = computed(() => showStockAction.value && hasPermission.value && !runtime.isLocked() && !mutationInFlight.value);
  const canConfirmPendingAction = computed(() => pendingActionAllowed(pendingAction.value));
  const statusLabel = computed(() => documentLifecycleStatusLabel(
    state.document.status,
    state.document.closeStatus,
    state.document.frozenStatus
  ));
  const pendingActionTitle = computed(() => ({
    reverse: "反审核确认",
    delete: "删除草稿确认",
    void: "作废确认",
    stockIn: "报废入库确认",
    reverseStockIn: "撤销报废入库确认"
  } as Record<string, string>)[pendingAction.value] ?? "操作确认");
  const pendingActionSummary = computed(() => ({
    reverse: "反审核后状态回到草稿，报废统计将剔除本单；有未撤销报废入库时后端会拒绝。",
    delete: "删除只允许无库存历史的草稿，单号不会复用。",
    void: "作废只允许草稿；成功后统计为 0，并释放来源领料的下游阻断。",
    stockIn: "将整单处理全部勾选“是否入库”的分录，任一行失败则整单回滚。",
    reverseStockIn: "将整单新增精确反向库存流水；完成后才能反审核材料报废单。"
  } as Record<string, string>)[pendingAction.value] ?? "");

  function startNew() {
    replaceState(blankState());
    clearMaterialScrapSharedActionState(shared);
    message.value = "请先选择已审核且仍有可报废数量的生产领料单。";
    setMaterialScrapSharedDirty(shared, true, true);
  }

  async function loadByBillNo(billNo: string, loadedMessage = "") {
    const normalized = billNo.trim();
    if (!normalized) return;
    const result = await fetchMaterialScrapDetail(normalized);
    if (!accountSetStillCurrent()) return;
    if (!result.ok || !result.data) {
      message.value = result.message || "材料报废单加载失败。";
      return;
    }
    applyDetail(result.data as MaterialScrapDetail, loadedMessage || `已打开材料报废单 ${normalized}`);
  }

  function applyDetail(detail: MaterialScrapDetail | DocumentDetail, loadedMessage = "", _sourceLineNo: number | null = null) {
    const payload = detail as MaterialScrapDetail;
    const document = normalizeDocument(payload.document ?? {});
    const lines = Array.isArray(payload.lines) ? payload.lines.map(normalizeLine) : [];
    state.document = document;
    state.lines = lines;
    clearMaterialScrapSharedActionState(shared);
    message.value = loadedMessage;
    setMaterialScrapSharedDirty(shared, false);
  }

  function applyPreview(detail: MaterialScrapDetail) {
    const previewDocument = normalizeDocument(detail.document ?? {});
    previewDocument.billNo = "";
    previewDocument.status = "DRAFT";
    previewDocument.stockInStatus = "NOT_REQUIRED";
    state.document = previewDocument;
    state.lines = (detail.lines ?? []).map(normalizeLine);
    clearMaterialScrapSharedActionState(shared);
    message.value = `已从生产领料单 ${state.document.sourceIssueNo} 带出 ${state.lines.length} 条可报废分录；首次保存时生成报废单号。`;
    setMaterialScrapSharedDirty(shared, true, true);
  }

  async function save() {
    if (saving.value || !canSave.value) return;
    const validation = validateDraft();
    if (validation) {
      message.value = validation;
      return;
    }
    const requestEpoch = beginOperationEpoch();
    saving.value = true;
    syncMaterialScrapSharedBusy(shared);
    try {
      const result = await saveMaterialScrapDraft({
        billNo: state.document.billNo || undefined,
        sourceIssueNo: state.document.sourceIssueNo,
        billDate: state.document.billDate,
        businessType: "PRODUCTION_SCRAP",
        lines: state.lines.map((line) => ({
          sourceIssueLineId: line.sourceIssueLineId,
          scrapQty: normalizedDecimalText(line.scrapQty),
          scrapReason: line.scrapReason.trim() || undefined,
          reissueQty: normalizedDecimalText(line.reissueQty),
          isStockIn: Boolean(line.isStockIn),
          targetWarehouseCode: line.isStockIn ? line.targetWarehouseCode.trim() : undefined
        }))
      });
      if (!result.ok || !result.data) {
        message.value = result.message || "材料报废草稿保存失败。";
        return;
      }
      if (!operationStillCurrent(requestEpoch)) return;
      const savedHeader = result.data as Partial<MaterialScrapDocument>;
      const billNo = stringValue(savedHeader.billNo || state.document.billNo);
      state.document = normalizeDocument({ ...state.document, ...savedHeader, billNo });
      setMaterialScrapSharedDirty(shared, false);
      message.value = "材料报废草稿已保存。草稿数量可为 0，审核前须补齐正数数量和原因。";

      const refreshed = await fetchMaterialScrapDetail(billNo);
      if (!operationStillCurrent(requestEpoch)) return;
      if (!refreshed.ok || !refreshed.data) {
        message.value = `材料报废草稿 ${billNo} 已保存，但刷新失败：${refreshed.message || "请稍后从列表重新打开。"}`;
        return;
      }
      applyDetail(
        refreshed.data as MaterialScrapDetail,
        "材料报废草稿已保存。草稿数量可为 0，审核前须补齐正数数量和原因。"
      );
    } finally {
      if (shared.epoch.value === requestEpoch) saving.value = false;
      syncMaterialScrapSharedBusy(shared);
    }
  }

  async function audit() {
    if (operationInFlight.value || !canAudit.value) return;
    const validation = validateAudit();
    if (validation) {
      message.value = validation;
      return;
    }
    const requestEpoch = beginOperationEpoch();
    operationInFlight.value = true;
    syncMaterialScrapSharedBusy(shared);
    try {
      const result = await auditMaterialScrap(state.document.billNo);
      if (!operationStillCurrent(requestEpoch)) return;
      if (!result.ok) {
        message.value = result.message || "材料报废审核失败。";
        return;
      }
      await loadByBillNo(state.document.billNo, "审核成功；报废数量已进入统计，审核本身未重复扣减库存。");
    } finally {
      if (shared.epoch.value === requestEpoch) operationInFlight.value = false;
      syncMaterialScrapSharedBusy(shared);
    }
  }

  function requestAction(action: PendingAction) {
    if (!action || mutationInFlight.value) return;
    pendingAction.value = action;
    voidReason.value = "";
    voidUsername.value = "";
    voidPassword.value = "";
  }

  function requestStockAction() {
    if (!canStockAction.value) return;
    requestAction(state.document.stockInStatus === "STOCKED_IN" ? "reverseStockIn" : "stockIn");
  }

  function cancelAction() {
    pendingAction.value = "";
    voidReason.value = "";
    voidUsername.value = "";
    voidPassword.value = "";
  }

  async function confirmAction() {
    const action = pendingAction.value;
    if (!action || !state.document.billNo || mutationInFlight.value) return;
    if (!pendingActionAllowed(action)) {
      message.value = "单据状态、编辑锁或账套状态已变化，当前操作已被阻止。";
      return;
    }
    if (action === "void" && (!voidReason.value.trim() || !voidUsername.value.trim() || !voidPassword.value)) {
      message.value = "作废必须填写原因，并使用当前账号和密码确认。";
      return;
    }
    const requestEpoch = beginOperationEpoch();
    operationInFlight.value = true;
    syncMaterialScrapSharedBusy(shared);
    try {
      const billNo = state.document.billNo;
      const result = action === "reverse"
        ? await reverseMaterialScrap(billNo)
        : action === "delete"
          ? await deleteMaterialScrap(billNo)
          : action === "void"
            ? await voidDocumentHardened("materialScrap", billNo, {
                reason: voidReason.value.trim(),
                username: voidUsername.value.trim(),
                password: voidPassword.value
              })
            : action === "reverseStockIn"
              ? await reverseStockInMaterialScrap(billNo)
              : await stockInMaterialScrap(billNo);
      if (!operationStillCurrent(requestEpoch)) return;
      if (!result.ok) {
        message.value = result.message || "材料报废单操作失败。";
        return;
      }
      cancelAction();
      if (action === "delete") {
        startNew();
        message.value = `已删除材料报废草稿 ${billNo}。`;
        return;
      }
      const success = ({
        reverse: "反审核成功，状态已回到草稿；报废统计已剔除本单。",
        void: "作废成功；本单不再进入统计，并已释放来源领料阻断。",
        stockIn: "整单报废入库成功。",
        reverseStockIn: "整单撤销报废入库成功，现在可以反审核。"
      } as Record<string, string>)[action] ?? "操作成功。";
      await loadByBillNo(billNo, success);
    } finally {
      if (shared.epoch.value === requestEpoch) operationInFlight.value = false;
      syncMaterialScrapSharedBusy(shared);
    }
  }

  function validateDraft() {
    if (!state.document.sourceIssueNo.trim()) return "请选择来源生产领料单。";
    if (!state.document.billDate) return "单据日期不能为空。";
    if (!state.lines.length) return "材料报废单至少需要一条分录。";
    for (const [index, line] of state.lines.entries()) {
      const scrapQty = decimalValue(line.scrapQty);
      const reissueQty = decimalValue(line.reissueQty);
      if (scrapQty == null || scrapQty < 0) return `第 ${index + 1} 行报废数量必须不小于 0。`;
      if (reissueQty == null || reissueQty < 0 || reissueQty > scrapQty) return `第 ${index + 1} 行报废重发数量必须在 0 到报废数量之间。`;
      if (line.isStockIn && !line.targetWarehouseCode.trim()) return `第 ${index + 1} 行勾选入库后必须填写目标报废仓。`;
    }
    return "";
  }

  function validateAudit() {
    const draftError = validateDraft();
    if (draftError) return draftError;
    for (const [index, line] of state.lines.entries()) {
      if ((decimalValue(line.scrapQty) ?? 0) <= 0) return `第 ${index + 1} 行审核时报废数量必须大于 0。`;
      if (!line.scrapReason.trim()) return `第 ${index + 1} 行审核时必须填写报废原因。`;
    }
    return "";
  }

  function markDirty() {
    if (editable.value) setMaterialScrapSharedDirty(shared, true, true);
  }

  function pendingActionAllowed(action: PendingAction) {
    if (action === "reverse") return canReverse.value;
    if (action === "delete") return canDelete.value;
    if (action === "void") return canVoid.value;
    if (action === "stockIn") {
      return canStockAction.value && state.document.stockInStatus !== "STOCKED_IN";
    }
    if (action === "reverseStockIn") {
      return canStockAction.value && state.document.stockInStatus === "STOCKED_IN";
    }
    return false;
  }

  function replaceState(target: MaterialScrapState) {
    state.document = normalizeDocument(target.document);
    state.lines = target.lines.map(normalizeLine);
  }

  function accountSetStillCurrent() {
    return runtime.accountSetKey() === ownerAccountSetKey && sharedRuntime === shared;
  }

  function beginOperationEpoch() {
    shared.epoch.value += 1;
    return shared.epoch.value;
  }

  function operationStillCurrent(epoch: number) {
    return accountSetStillCurrent() && shared.epoch.value === epoch;
  }

  function beginPreviewOperation() {
    if (mutationInFlight.value) return 0;
    const epoch = beginOperationEpoch();
    previewing.value = true;
    syncMaterialScrapSharedBusy(shared);
    return epoch;
  }

  function finishPreviewOperation(epoch: number) {
    if (shared.epoch.value === epoch) previewing.value = false;
    syncMaterialScrapSharedBusy(shared);
  }

  return {
    state,
    message,
    pendingAction,
    voidReason,
    voidUsername,
    voidPassword,
    saving,
    operationInFlight,
    previewing,
    mutationInFlight,
    operationEpoch: shared.epoch,
    beginPreviewOperation,
    operationStillCurrent,
    finishPreviewOperation,
    editable,
    canSave,
    canSourceSelect,
    canAudit,
    canReverse,
    canVoid,
    canDelete,
    showStockAction,
    stockActionLabel,
    canStockAction,
    canConfirmPendingAction,
    statusLabel,
    pendingActionTitle,
    pendingActionSummary,
    startNew,
    loadByBillNo,
    applyDetail,
    applyPreview,
    save,
    audit,
    requestAction,
    requestStockAction,
    cancelAction,
    confirmAction,
    markDirty
  };
}

function blankState(): MaterialScrapState {
  return {
    document: {
      billNo: "",
      billDate: todayText(),
      businessType: "PRODUCTION_SCRAP",
      sourceIssueNo: "",
      workshopCode: "",
      workshopName: "",
      status: "DRAFT",
      closeStatus: "OPEN",
      frozenStatus: "NORMAL",
      stockInStatus: "NOT_REQUIRED"
    },
    lines: []
  };
}

function normalizeDocument(document: Partial<MaterialScrapDocument>): MaterialScrapDocument {
  return {
    id: stringValue(document.id),
    billNo: stringValue(document.billNo),
    billDate: stringValue(document.billDate) || todayText(),
    businessType: stringValue(document.businessType) || "PRODUCTION_SCRAP",
    sourceIssueId: stringValue(document.sourceIssueId),
    sourceIssueNo: stringValue(document.sourceIssueNo),
    workshopId: stringValue(document.workshopId),
    workshopCode: stringValue(document.workshopCode),
    workshopName: stringValue(document.workshopName),
    status: stringValue(document.status) || "DRAFT",
    closeStatus: stringValue(document.closeStatus) || "OPEN",
    frozenStatus: stringValue(document.frozenStatus) || "NORMAL",
    stockInStatus: stringValue(document.stockInStatus) || "NOT_REQUIRED",
    version: document.version
  };
}

function normalizeLine(line: Partial<MaterialScrapLine>): MaterialScrapLine {
  return {
    id: stringValue(line.id),
    lineNo: line.lineNo,
    sourceIssueLineId: stringValue(line.sourceIssueLineId || line.id),
    productId: stringValue(line.productId),
    productCode: stringValue(line.productCode),
    productName: stringValue(line.productName),
    spec: stringValue(line.spec),
    unit: stringValue(line.unit),
    sourceWarehouseId: stringValue(line.sourceWarehouseId),
    sourceWarehouseCode: stringValue(line.sourceWarehouseCode),
    issueQty: normalizedDecimalText(line.issueQty ?? 0),
    availableScrapQty: normalizedDecimalText(line.availableScrapQty ?? 0),
    scrapQty: normalizedDecimalText(line.scrapQty ?? 0),
    scrapReason: stringValue(line.scrapReason),
    reissueQty: normalizedDecimalText(line.reissueQty ?? 0),
    isStockIn: Boolean(line.isStockIn),
    targetWarehouseId: stringValue(line.targetWarehouseId),
    targetWarehouseCode: stringValue(line.targetWarehouseCode),
    stockInStatus: stringValue(line.stockInStatus) || (line.isStockIn ? "PENDING" : "NOT_REQUIRED")
  };
}

function todayText() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function stringValue(value: unknown) {
  return value == null ? "" : String(value);
}

function normalizedDecimalText(value: number | string) {
  const text = String(value ?? "0").trim();
  return text || "0";
}

function decimalValue(value: number | string) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}
