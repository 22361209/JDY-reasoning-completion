import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, toRaw } from "vue";
import { masterRowToOption, mergeMasterOptions, parseEntryClipboard } from "../../app/entryPaste";
import {
  documentLifecycleStatusLabel,
  lifecyclePolicyFor
} from "../../app/documentLifecyclePolicy";
import { taxAmounts } from "../../app/taxAmounts";
import {
  knownProductOptions,
  zeroReasonOptions,
  type DownstreamTraceState,
  type EntryPasteConflict,
  type EntryPasteRefs,
  type LifecycleDocumentAction,
  type MasterOption,
  type OrderForm,
  type OrderLineForm,
  type PendingEntryPaste,
  type PendingPushLine,
  type PendingZeroEntrySave,
  type RiskyDocumentAction,
  type ZeroEntryWarning
} from "../../app/documentModel";
import { fetchListRows } from "../../services/listApi";
import {
  auditDocument,
  deleteDocument,
  exportDocument,
  fetchDocumentDetail,
  fetchSalesUnitPriceQuote,
  lifecycleDocument,
  lifecycleLine,
  printDocument,
  redReverseDocument,
  reverseDocument,
  saveDocumentDraft,
  voidDocumentHardened,
  type DocumentDetail,
  type DocumentType,
  type DownstreamDocumentRef,
  type OpenableDocumentType,
  type OutputDocumentType
} from "../../services/documentApi";

export interface DocumentModuleOptions {
  documentType: OpenableDocumentType;
  saveType?: DocumentType;
  outputType: OutputDocumentType;
  title: string;
  testPrefix: string;
  partyKind: "customer" | "supplier";
  partyLabel: string;
  auditPermission: string;
  billPrefix: string;
  defaultDepartment: string;
  defaultPartyCode: string;
  defaultUnitPrice: number;
  showTargetWarehouseColumn?: boolean;
  showSupplierMaterialCodeColumn?: boolean;
  executionQtyLabel?: string;
  remainingQtyLabel?: string;
  showTaxColumns?: boolean;
  showStockColumns?: boolean;
  stockColumnMode?: "all" | "availableOnly";
  defaultTargetWarehouseCode?: string;
  qtyLabel?: string;
  stockAvailableLabel?: string;
  showExecutedQtyColumn?: boolean;
  showPriceAmountColumns?: boolean;
  showProductInfoSection?: boolean;
  sourceTraceType?: OpenableDocumentType;
  reversible?: boolean;
  initialForm: OrderForm;
  riskySummaryTitle?: string;
  redReverseImpact?: string;
  reverseImpact?: string;
  allowDraftDelete?: boolean;
  allowZeroQty?: boolean;
  skipZeroEntryWarnings?: boolean;
  sourceLockedLines?: boolean;
  reloadAfterLifecycle?: boolean;
  saveDraft?: (form: OrderForm, lines: OrderLineForm[]) => Promise<{ ok: boolean; message: string; data?: unknown }>;
}

interface RuntimeOptions {
  userName: () => string;
  hasPermission: (permission: string) => boolean;
  markDirty: () => void;
  clearDirty: () => void;
  requestOpenDocument: (payload: { type: OpenableDocumentType; billNo: string; sourceLineNo?: number | null }) => void;
}

type PreparedEntryLines = {
  formLines: OrderLineForm[];
  documentLines: {
    lineNo?: number;
    productId?: string;
    productCode: string;
    unit?: string;
    netWeight?: string | number;
    grossWeight?: string | number;
    warehouseCode: string;
    targetWarehouseCode?: string;
    sourceLineNo?: number;
    sourceOrderNo?: string;
    qty: number;
    unitPrice: number;
    taxRate?: number;
    lineRemark: string;
    planDeliveryDate?: string;
    sourceDeliveryNoticeNo?: string;
    sourceDeliveryLineNo?: number;
    customerMaterialCode?: string;
    supplierMaterialCode?: string;
    customerOrderNo?: string;
  }[];
  removedBlankCount: number;
};

type DocumentModuleSnapshot = {
  form: OrderForm;
  message: string;
  batchWarehouseCode: string;
  batchPlanDeliveryDate: string;
  highlightedSourceBillNo: string;
  highlightedSourceLineNo: number | null;
};

const documentModuleSnapshots = new Map<string, DocumentModuleSnapshot>();

function plainClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(toRaw(value))) as T;
}

const formStatusByBackendStatus: Record<string, OrderForm["status"]> = {
  DRAFT: "DRAFT",
  AUDITED: "AUDITED",
  REVERSED: "REVERSED",
  VOID: "VOIDED",
  VOIDED: "VOIDED",
  RED_REVERSED: "RED_REVERSED"
};

export function useDocumentModule(config: DocumentModuleOptions, runtime: RuntimeOptions) {
  const form = reactive<OrderForm>({
    ...config.initialForm,
    lines: config.initialForm.lines.map((line) => ({ ...line }))
  });
  const message = ref("");
  const batchWarehouseCode = ref("CK-001");
  const batchPlanDeliveryDate = ref(defaultPlanDeliveryDate());
  const activeSelector = ref("");
  const selectorOptions = ref<MasterOption[]>([]);
  const selectorCursorIndex = ref(0);
  const masterSelectorDialogOpen = ref(false);
  const masterSelectorDialogType = ref("");
  const masterSelectorDialogSelectorId = ref("");
  const masterSelectorDialogKeyword = ref("");
  const draggingLineIndex = ref<number | null>(null);
  const highlightedSourceBillNo = ref("");
  const highlightedSourceLineNo = ref<number | null>(null);
  const downstreamTrace = ref<DownstreamTraceState | null>(null);
  const pendingEntryPaste = ref<PendingEntryPaste | null>(null);
  const pendingZeroEntrySave = ref<PendingZeroEntrySave | null>(null);
  const pendingRiskyDocumentAction = ref<RiskyDocumentAction | null>(null);
  const pendingLifecycleAction = ref<LifecycleDocumentAction | null>(null);
  const pendingLifecycleLineNo = ref<number | null>(null);
  const pendingDeleteDocument = ref(false);
  const hasPersistedDraft = ref(false);
  const lifecycleReason = ref("");
  const voidUsername = ref("");
  const voidPassword = ref("");
  let selectorRequestSeq = 0;
  let priceRequestSeq = 0;

  const isDraft = computed(() => form.status === "DRAFT");
  const lifecyclePolicy = computed(() => lifecyclePolicyFor(config.saveType ?? null));
  const showCloseFreezeActions = computed(() => Boolean(lifecyclePolicy.value?.closeFreezeAllowed));
  const canAudit = computed(() => Boolean(config.saveType) && isDraft.value && runtime.hasPermission(config.auditPermission));
  const canReverse = computed(() => Boolean(config.reversible && config.saveType && form.status === "AUDITED" && !form.redReverseBillNo));
  const canRedReverse = computed(() => Boolean(config.saveType && lifecyclePolicy.value?.redReverseAllowed && form.status === "AUDITED" && !form.redReverseBillNo && !form.redSourceBillNo));
  const canVoid = computed(() => Boolean(config.saveType && lifecyclePolicy.value?.voidAllowed && form.status === "DRAFT"));
  const canClose = computed(() => Boolean(config.saveType && lifecyclePolicy.value?.closeFreezeAllowed && form.status === "AUDITED" && form.closeStatus !== "CLOSED" && form.frozenStatus !== "FROZEN"));
  const canUnclose = computed(() => Boolean(
    config.saveType &&
    lifecyclePolicy.value?.closeFreezeAllowed &&
    form.status === "AUDITED" &&
    form.closeStatus === "CLOSED" &&
    (config.documentType !== "salesOrder" || form.closeMode === "MANUAL")
  ));
  const canFreeze = computed(() => Boolean(config.saveType && lifecyclePolicy.value?.closeFreezeAllowed && form.status === "AUDITED" && form.frozenStatus !== "FROZEN" && form.closeStatus !== "CLOSED"));
  const canUnfreeze = computed(() => Boolean(config.saveType && lifecyclePolicy.value?.closeFreezeAllowed && form.status === "AUDITED" && form.frozenStatus === "FROZEN"));
  const showDelete = computed(() => Boolean(config.allowDraftDelete));
  const canDelete = computed(() => Boolean(
    config.allowDraftDelete &&
    config.saveType &&
    runtime.hasPermission(config.auditPermission) &&
    form.status === "DRAFT" &&
    hasPersistedDraft.value &&
    form.billNo
  ));
  const canTraceSourceOrder = computed(() => Boolean(config.sourceTraceType && form.lines.some((line) => line.sourceOrderNo?.trim())));
  const showSourceLineColumn = computed(() => Boolean(config.sourceTraceType && form.lines.some((line) => line.sourceOrderNo?.trim())));
  const showExecutionColumns = computed(() => Boolean(config.executionQtyLabel || config.remainingQtyLabel) || form.lines.some((line) => line.executedQty !== undefined || line.remainingQty !== undefined));
  const showTargetWarehouseColumn = computed(() => Boolean(config.showTargetWarehouseColumn));
  const showTaxColumns = computed(() => Boolean(config.showTaxColumns));
  const showSupplierMaterialCodeColumn = computed(() => Boolean(config.showSupplierMaterialCodeColumn));
  const showPlanDeliveryDateColumn = computed(() => config.documentType === "salesOrder" || config.documentType === "deliveryNotice" || config.documentType === "purchaseOrder");
  const executionColumnCount = computed(() => showExecutionColumns.value ? (config.showExecutedQtyColumn === false ? 1 : 2) : 0);
  const stockColumnCount = computed(() => config.showStockColumns ? (config.stockColumnMode === "availableOnly" ? 1 : 4) : 0);
  const priceAmountColumnCount = computed(() => config.showPriceAmountColumns === false ? 0 : 2);
  const entryTableColspan = computed(() => 7 + priceAmountColumnCount.value + (showSourceLineColumn.value ? 1 : 0) + executionColumnCount.value + stockColumnCount.value + (showTargetWarehouseColumn.value ? 1 : 0) + (showPlanDeliveryDateColumn.value ? 2 : 0));
  const entryTotalColspan = computed(() => entryTableColspan.value - 1);
  const totalAmount = computed(() => form.lines.reduce((sum, line) => sum + taxAmounts(line.qty, line.unitPrice, line.taxRate).priceTaxTotal, 0).toFixed(2));
  const masterSelectorDialogLabel = computed(() => masterSelectorLabel(masterSelectorDialogType.value));
  const masterSelectorDialogTitle = computed(() => `选择${masterSelectorDialogLabel.value}`);
  const statusLabel = computed(() => documentLifecycleStatusLabel(form.status, form.closeStatus, form.frozenStatus, form.closeMode));
  const redReverseBillNo = computed(() => "系统自动生成");
  const riskyActionVerb = computed(() => pendingRiskyDocumentAction.value === "redReverse" ? "红冲" : "反审核");
  const riskyActionTitle = computed(() => `${riskyActionVerb.value}确认`);
  const riskyActionSummary = computed(() => `即将${riskyActionVerb.value}${config.riskySummaryTitle ?? config.title} ${form.billNo}。`);
	  const riskyActionImpact = computed(() => pendingRiskyDocumentAction.value === "redReverse"
	    ? config.redReverseImpact ?? `红冲将生成负数${config.title}草稿，并在原单关联红字单；审核红字单后才产生反向业务事实。`
    : config.reverseImpact ?? `反审核将冲销${config.title}相关库存流水。`);
  const entryPasteConflictsResolved = computed(() => Boolean(pendingEntryPaste.value?.conflicts.every((conflict) => conflict.selectedCode)));

  onMounted(() => {
    const snapshot = documentModuleSnapshots.get(config.documentType);
    if (!snapshot) {
      return;
    }
    restoreSnapshot(snapshot);
  });

  onBeforeUnmount(() => {
    documentModuleSnapshots.set(config.documentType, snapshotState());
  });

  async function startNew() {
    form.billDate = todayText();
    form.billNo = "";
    form.version = undefined;
    form.sourceOrderNo = config.sourceTraceType ? "" : undefined;
    form.currency = config.initialForm.currency;
    form.redReverseBillNo = undefined;
    form.redSourceBillNo = undefined;
    form.partyCode = "";
    form.partyName = "";
    form.department = config.defaultDepartment;
    form.ownerName = runtime.userName() || "本地管理员";
    form.remark = "";
    form.validUntil = config.documentType === "salesQuote" ? defaultSalesQuoteValidUntil() : undefined;
    form.status = "DRAFT";
    form.closeStatus = "OPEN";
    form.closeMode = null;
    form.frozenStatus = "NORMAL";
    form.productInfo = undefined;
    form.totalAmount = undefined;
    form.receivableOffsetAmount = undefined;
    form.pendingRefundAmount = undefined;
    form.lines = config.sourceLockedLines ? [] : [blankLine()];
    hasPersistedDraft.value = false;
    message.value = "新单据将在首次保存时生成编号";
    runtime.markDirty();
  }

  function fillFromDetail(detail: DocumentDetail) {
    const document = detail.document;
    form.billNo = document.billNo;
    form.version = normalizeDocumentVersion(document.version);
    form.sourceOrderNo = document.sourceOrderNo || undefined;
    form.redReverseBillNo = document.redReverseBillNo || undefined;
    form.redSourceBillNo = document.redSourceBillNo || undefined;
    form.partyCode = document.sourceOrderNo && (document.customerCode === "SC" || document.supplierCode === "SC")
      ? document.sourceOrderNo
      : config.partyKind === "supplier"
      ? document.supplierCode || config.defaultPartyCode
      : document.customerCode || config.defaultPartyCode;
    form.partyName = config.partyKind === "supplier" ? document.supplier || "" : document.customer || "";
    form.billDate = document.billDate;
    form.currency = document.currency === "USD"
      ? "USD"
      : document.currency === "CNY"
        ? "CNY"
        : config.initialForm.currency;
    form.department = document.department || config.defaultDepartment;
    form.ownerName = document.createdByName || document.ownerName || "本地管理员";
    form.remark = document.remark || "";
    form.enabled = document.enabled ?? true;
    form.validUntil = document.validUntil || (config.documentType === "salesQuote" ? defaultSalesQuoteValidUntil() : undefined);
    form.totalAmount = document.totalAmount;
    form.receivableOffsetAmount = document.receivableOffsetAmount;
    form.pendingRefundAmount = document.pendingRefundAmount;
    form.status = formStatusByBackendStatus[document.status] ?? "DRAFT";
    form.closeStatus = document.closeStatus ?? "OPEN";
    form.closeMode = document.closeMode ?? null;
    form.frozenStatus = document.frozenStatus ?? "NORMAL";
    form.productInfo = detail.productInfo ? { ...detail.productInfo } : undefined;
    form.lines = detail.lines.length
      ? detail.lines.map((line) => ({
        productCode: String(line.productCode ?? ""),
        productId: String(line.productId ?? ""),
        productName: String(line.productName ?? ""),
        spec: String(line.spec ?? ""),
        unit: String(line.unit ?? ""),
        netWeight: String(line.netWeight ?? ""),
        grossWeight: String(line.grossWeight ?? ""),
        warehouseCode: String(line.warehouseCode ?? "CK-001"),
        targetWarehouseCode: String(line.targetWarehouseCode ?? config.defaultTargetWarehouseCode ?? "CK-002"),
        lineNo: normalizedOptionalInt(line.lineNo),
        sourceOrderNo: String(line.sourceOrderNo ?? ""),
        sourceLineNo: normalizedOptionalInt(line.sourceLineNo),
        sourcePurchasePlanId: String(line.sourcePurchasePlanId ?? ""),
        sourcePurchasePlanLineId: String(line.sourcePurchasePlanLineId ?? ""),
        sourcePurchasePlanNo: String(line.sourcePurchasePlanNo ?? ""),
        sourcePurchasePlanLineNo: normalizedOptionalInt(line.sourcePurchasePlanLineNo),
        customerMaterialCode: String(line.customerMaterialCode ?? ""),
        supplierMaterialCode: String(line.supplierMaterialCode ?? ""),
        customerOrderNo: String(line.customerOrderNo ?? ""),
        qty: Number(line.qty ?? 0),
        executedQty: documentLineExecutedQty(line),
        remainingQty: documentLineRemainingQty(line),
        availableNoticeQty: documentLineAvailableNoticeQty(line),
        lineCloseStatus: line.lineCloseStatus ?? "OPEN",
        lineFrozenStatus: line.lineFrozenStatus ?? "NORMAL",
        unitPrice: Number(line.unitPrice ?? 0),
        amount: line.amount,
        taxInclusiveUnitPrice: line.taxInclusiveUnitPrice,
        taxRate: Number(line.taxRate ?? 13),
        taxAmount: line.taxAmount,
        priceTaxTotal: line.priceTaxTotal,
        stockOnHand: line.stockOnHand,
        stockReserved: line.stockReserved,
        stockAvailable: line.stockAvailable,
        stockInTransit: line.stockInTransit,
        lineRemark: String(line.lineRemark ?? ""),
        planDeliveryDate: String(line.planDeliveryDate ?? "") || defaultPlanDeliveryDateForDocument(),
        downstreamDocs: normalizeDownstreamDocs(line.downstreamDocs)
      }))
      : config.sourceLockedLines ? [] : [defaultLine()];
    hasPersistedDraft.value = true;
  }

  async function loadByBillNo(billNo: string, loadedMessage = "") {
    form.lines = [];
    const result = await fetchDocumentDetail(config.documentType, billNo);
    if (!result.ok || !result.data) {
      message.value = result.message || "单据详情加载失败。";
      return;
    }
    fillFromDetail(result.data);
    message.value = loadedMessage || `已打开${config.title} ${billNo}`;
    runtime.clearDirty();
  }

  async function refreshStock() {
    if (!form.billNo) {
      message.value = "请先保存或打开单据后再更新库存。";
      return;
    }
    const result = await fetchDocumentDetail(config.documentType, form.billNo);
    if (!result.ok || !result.data) {
      message.value = result.message || "库存更新失败。";
      return;
    }
    const stockByLine = new Map(result.data.lines.map((line) => [Number(line.lineNo ?? 0), line]));
    form.lines.forEach((line, index) => {
      const stock = stockByLine.get(Number(line.lineNo ?? index + 1));
      if (!stock) {
        return;
      }
      line.stockOnHand = stock.stockOnHand;
      line.stockReserved = stock.stockReserved;
      line.stockAvailable = stock.stockAvailable;
      line.stockInTransit = stock.stockInTransit;
    });
    message.value = "库存已更新";
  }

  function applyDetail(detail: DocumentDetail, loadedMessage = "", sourceLineNo: number | null = null) {
    fillFromDetail(detail);
    highlightedSourceBillNo.value = sourceLineNo ? form.billNo : "";
    highlightedSourceLineNo.value = sourceLineNo;
    message.value = loadedMessage;
    runtime.clearDirty();
    if (sourceLineNo) {
      void scrollHighlightedSourceLineIntoView(sourceLineNo);
    }
  }

  function applyPushDownDraft(draft: Omit<PendingPushLine, "selected" | "sourceQty" | "executedQty" | "remainingQty">[] & never) {
    void draft;
  }

  function applyInboundPushDownDraft(draft: {
    billNo: string;
    sourceOrderNo: string;
    partyCode: string;
    partyName?: string;
    billDate: string;
    currency?: "CNY" | "USD";
    department: string;
    ownerName: string;
    lines: PendingPushLine[];
  }) {
    form.billNo = draft.billNo;
    form.sourceOrderNo = "";
    form.redReverseBillNo = undefined;
    form.redSourceBillNo = undefined;
    form.partyCode = draft.partyCode;
    form.partyName = draft.partyName || "";
    form.billDate = draft.billDate;
    form.currency = draft.currency ?? "CNY";
    form.department = draft.department;
    form.ownerName = draft.ownerName;
    form.remark = "";
    form.validUntil = config.documentType === "salesQuote" ? defaultSalesQuoteValidUntil() : undefined;
    form.status = "DRAFT";
    hasPersistedDraft.value = false;
    form.lines = draft.lines.map((line) => ({
      productCode: String(line.productCode ?? ""),
      productId: String(line.productId ?? ""),
      productName: String(line.productName ?? ""),
      spec: String(line.spec ?? ""),
      unit: String(line.unit ?? ""),
      netWeight: String(line.netWeight ?? ""),
      grossWeight: String(line.grossWeight ?? ""),
      warehouseCode: String(line.warehouseCode ?? "CK-001"),
	      sourceOrderNo: draft.sourceOrderNo,
	      sourceLineNo: line.sourceLineNo,
	      customerMaterialCode: String(line.customerMaterialCode ?? ""),
	      supplierMaterialCode: String(line.supplierMaterialCode ?? ""),
	      customerOrderNo: String(line.customerOrderNo ?? ""),
	      qty: normalizedQty(line.qty),
      unitPrice: Number(line.unitPrice ?? 0),
      taxRate: Number(line.taxRate ?? 13),
      lineRemark: String(line.lineRemark ?? ""),
      planDeliveryDate: String(line.planDeliveryDate ?? "") || defaultPlanDeliveryDateForDocument()
    }));
    message.value = `已由${draft.sourceOrderNo}按确认数量生成${config.title}草稿`;
    runtime.markDirty();
  }

  async function save(allowZeroValues = false) {
    if (!config.saveType) {
      message.value = "当前单据由生产任务生成，不能直接保存草稿。";
      return;
    }
    if (!allowZeroValues) {
      pendingZeroEntrySave.value = null;
    }
    message.value = "";
    if (config.documentType === "salesQuote" && !String(form.validUntil ?? "").trim()) {
      message.value = "报价有效期不能为空。";
      return;
    }
    const preparedLines = prepareEntryLinesForSave(form.lines);
    if (!preparedLines.ok) {
      message.value = preparedLines.message;
      return;
    }
    const zeroWarnings = config.skipZeroEntryWarnings
      ? []
      : zeroEntryWarnings(preparedLines.formLines, Boolean(config.allowZeroQty));
    if (!allowZeroValues && zeroWarnings.length > 0) {
      pendingZeroEntrySave.value = { target: "document", warnings: zeroWarnings };
      return;
    }
    form.lines = preparedLines.formLines;
    const result = config.saveDraft
      ? await config.saveDraft(form, preparedLines.formLines)
      : await saveDocumentDraft(config.saveType, {
          billNo: form.billNo,
          sourceOrderNo: form.sourceOrderNo,
          partyCode: form.partyCode,
          billDate: form.billDate,
          currency: form.currency,
          department: form.department,
          ownerName: form.ownerName,
          remark: form.remark,
          validUntil: form.validUntil,
          lines: preparedLines.documentLines
        });
    const successMessage = saveSuccessMessage(preparedLines.removedBlankCount, allowZeroValues ? zeroWarnings.length : 0);
    message.value = result.ok ? successMessage : result.message;
    if (result.ok) {
      const saved = result.data as { billNo?: unknown } | undefined;
      const savedBillNo = typeof saved?.billNo === "string" ? saved.billNo : form.billNo;
      if (savedBillNo) {
        await loadByBillNo(savedBillNo, successMessage);
      } else {
        form.status = "DRAFT";
        hasPersistedDraft.value = true;
        runtime.clearDirty();
      }
    }
  }

  async function audit() {
    if (!config.saveType) {
      message.value = "当前单据由生产任务生成，不能在此直接审核。";
      return;
    }
    if (!runtime.hasPermission(config.auditPermission)) {
      message.value = "当前角色无权审核该单据。";
      return;
    }
    const result = await auditDocument(config.saveType, form.billNo);
    message.value = result.ok ? "审核成功" : result.message;
    if (result.ok) {
      if (config.reloadAfterLifecycle && form.billNo) {
        await loadByBillNo(form.billNo, "审核成功");
        return;
      }
      form.status = "AUDITED";
      runtime.clearDirty();
    }
  }

  function openRiskyAction(action: RiskyDocumentAction) {
    if ((action === "redReverse" && canRedReverse.value) || (action === "reverse" && canReverse.value)) {
      pendingRiskyDocumentAction.value = action;
    }
  }

  function cancelRiskyAction() {
    const verb = riskyActionVerb.value;
    pendingRiskyDocumentAction.value = null;
    message.value = `已取消${verb}。`;
  }

  async function confirmRiskyAction() {
    const action = pendingRiskyDocumentAction.value;
    if (!action || !config.saveType) {
      pendingRiskyDocumentAction.value = null;
      return;
    }
    pendingRiskyDocumentAction.value = null;
    if (action === "redReverse") {
      await redReverse();
      return;
    }
    await reverse();
  }

  async function reverse() {
    if (!config.saveType) {
      return;
    }
    const result = await reverseDocument(config.saveType, form.billNo);
    message.value = result.ok ? "反审核成功，状态回到草稿；库存流水已冲销" : result.message;
    if (result.ok) {
      if (config.reloadAfterLifecycle && form.billNo) {
        await loadByBillNo(form.billNo, "反审核成功，状态回到草稿；库存流水已冲销");
        return;
      }
      const reversed = result.data as { status?: unknown } | undefined;
      form.status = typeof reversed?.status === "string" ? formStatusByBackendStatus[reversed.status] ?? "DRAFT" : "DRAFT";
      runtime.clearDirty();
    }
  }

  async function deleteCurrent() {
    if (!config.saveType || !canDelete.value) {
      message.value = `只有草稿${config.title}可以删除。`;
      return;
    }
    pendingDeleteDocument.value = true;
  }

  function cancelDeleteDocument() {
    pendingDeleteDocument.value = false;
    message.value = "已取消删除。";
  }

  async function confirmDeleteDocument() {
    if (!config.saveType || !canDelete.value) {
      pendingDeleteDocument.value = false;
      message.value = `只有草稿${config.title}可以删除。`;
      return;
    }
    const deletedBillNo = form.billNo;
    pendingDeleteDocument.value = false;
    const result = await deleteDocument(config.saveType, deletedBillNo);
    if (!result.ok) {
      message.value = result.message || "删除失败。";
      return;
    }
    runtime.clearDirty();
    await startNew();
    message.value = `已删除草稿${config.title} ${deletedBillNo}，并生成新草稿号。`;
  }

  function openLifecycleAction(action: LifecycleDocumentAction, lineNo?: number) {
    pendingLifecycleAction.value = action;
    pendingLifecycleLineNo.value = lineNo ?? null;
    lifecycleReason.value = defaultLifecycleReason(action, lineNo);
    voidUsername.value = "";
    voidPassword.value = "";
  }

  function cancelLifecycleAction() {
    pendingLifecycleAction.value = null;
    pendingLifecycleLineNo.value = null;
    lifecycleReason.value = "";
    voidUsername.value = "";
    voidPassword.value = "";
  }

  async function confirmLifecycleAction() {
    const action = pendingLifecycleAction.value;
    if (!action || !config.saveType) {
      cancelLifecycleAction();
      return;
    }
    const lineNo = pendingLifecycleLineNo.value;
    const reason = lifecycleReason.value.trim();
    let result;
    if (action === "void") {
      result = await voidDocumentHardened(config.saveType, form.billNo, {
        reason,
        username: voidUsername.value.trim(),
        password: voidPassword.value
      });
    } else if (lineNo != null) {
      result = await lifecycleLine(config.saveType, form.billNo, lineNo, action, reason);
    } else {
      result = await lifecycleDocument(config.saveType, form.billNo, action, reason);
    }
    message.value = result.ok ? lifecycleSuccessMessage(action, lineNo) : result.message;
    if (result.ok) {
      applyLifecycleLocal(action, lineNo);
      cancelLifecycleAction();
      runtime.clearDirty();
    }
  }

  async function redReverse() {
    if (!config.saveType) {
      return;
    }
    const result = await redReverseDocument(config.saveType, form.billNo, {
      billDate: form.billDate,
      ownerName: form.ownerName
    });
    const saved = result.data as { billNo?: unknown } | undefined;
    const generatedBillNo = String(saved?.billNo ?? "");
	    message.value = result.ok && generatedBillNo ? `红字草稿已生成：${generatedBillNo}，审核后生效` : result.ok ? "红字草稿已生成，请刷新列表查看系统生成的红字单。" : result.message;
	    if (result.ok) {
	      if (generatedBillNo) {
	        await loadByBillNo(generatedBillNo, `红字草稿已生成：${generatedBillNo}，审核后生效`);
	      }
	    }
  }

  async function exportCurrent() {
    const result = await exportDocument(config.outputType, form.billNo);
    message.value = result.ok ? "引出文件已生成" : result.message;
  }

  async function printCurrent() {
    const result = await printDocument(config.outputType, form.billNo);
    if (result.ok && result.data) {
      window.open(result.data, "_blank", "noopener");
    }
    message.value = result.ok ? "PDF 打印文件已生成" : result.message;
  }

  async function openRedReverseBill() {
    const billNo = form.redReverseBillNo?.trim();
    if (billNo) {
      await loadByBillNo(billNo, `已打开红字单 ${billNo}`);
    }
  }

  async function openRedSourceBill() {
    const billNo = form.redSourceBillNo?.trim();
    if (billNo) {
      await loadByBillNo(billNo, `已打开来源原单 ${billNo}`);
    }
  }

  function traceSourceOrder(sourceLineNo?: number, sourceOrderNo?: string) {
    const billNo = sourceOrderNo?.trim() || form.lines.find((line) => line.sourceOrderNo?.trim())?.sourceOrderNo?.trim() || form.sourceOrderNo?.trim();
    if (!billNo || !config.sourceTraceType) {
      return;
    }
    const targetLineNo = sourceLineNo ?? form.lines.find((line) => line.sourceLineNo)?.sourceLineNo ?? null;
    runtime.requestOpenDocument({ type: config.sourceTraceType, billNo, sourceLineNo: targetLineNo });
  }

  function openDownstreamTrace(line: OrderLineForm, index: number) {
    if (!line.downstreamDocs?.length) {
      return;
    }
    downstreamTrace.value = {
      title: `${form.billNo} 第 ${lineLineNo(line, index)} 行执行单据`,
      lineNo: lineLineNo(line, index),
      executedQty: formatQty(line.executedQty ?? 0),
      docs: line.downstreamDocs
    };
  }

  function openDownstreamDocument(doc: DownstreamDocumentRef) {
    if (!doc.billNo || !doc.type) {
      return;
    }
    downstreamTrace.value = null;
    runtime.requestOpenDocument({ type: doc.type, billNo: doc.billNo });
  }

  function markDirty() {
    runtime.markDirty();
  }

  function addLine() {
    if (!isDraft.value || config.sourceLockedLines) {
      return;
    }
    form.lines.push(blankLine());
    runtime.markDirty();
  }

  function insertLineAfter(index: number) {
    if (!isDraft.value || config.sourceLockedLines) {
      return;
    }
    form.lines.splice(index + 1, 0, blankLine());
    runtime.markDirty();
    void focusLineCell(index + 1, "product", config.testPrefix);
  }

  function copyLine(index: number) {
    if (!isDraft.value || config.sourceLockedLines) {
      return;
    }
    const source = form.lines[index];
    if (!source) {
      return;
    }
    form.lines.splice(index + 1, 0, { ...source });
    runtime.markDirty();
    void focusLineCell(index + 1, "product", config.testPrefix);
  }

  function removeLine(index: number) {
    if (!isDraft.value || (!config.sourceLockedLines && form.lines.length <= 1)) {
      return;
    }
    form.lines.splice(index, 1);
    runtime.markDirty();
  }

  function handleLineDragStart(event: DragEvent, index: number) {
    if (!isDraft.value) {
      event.preventDefault();
      return;
    }
    draggingLineIndex.value = index;
    event.dataTransfer?.setData("text/plain", String(index));
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
    }
  }

  function handleLineDragOver(event: DragEvent) {
    if (isDraft.value && event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
  }

  function handleLineDrop(targetIndex: number) {
    if (!isDraft.value || draggingLineIndex.value === null || draggingLineIndex.value === targetIndex) {
      draggingLineIndex.value = null;
      return;
    }
    const [line] = form.lines.splice(draggingLineIndex.value, 1);
    if (line) {
      form.lines.splice(targetIndex, 0, line);
      activeSelector.value = "";
      runtime.markDirty();
    }
    draggingLineIndex.value = null;
  }

  function applyBatchWarehouse() {
    if (!isDraft.value) {
      return;
    }
    const warehouseCode = batchWarehouseCode.value.trim();
    if (!warehouseCode) {
      return;
    }
    form.lines.forEach((line) => {
      line.warehouseCode = warehouseCode;
      if (showTargetWarehouseColumn.value && !line.targetWarehouseCode) {
        line.targetWarehouseCode = config.defaultTargetWarehouseCode ?? "CK-002";
      }
    });
    activeSelector.value = "";
    runtime.markDirty();
  }

  function applyBatchPlanDeliveryDate(lineIndexes: number[]) {
    if (!isDraft.value || !showPlanDeliveryDateColumn.value) {
      return;
    }
    const planDate = batchPlanDeliveryDate.value.trim();
    if (!planDate) {
      return;
    }
    lineIndexes.forEach((index) => {
      const line = form.lines[index];
      if (line) {
        line.planDeliveryDate = planDate;
      }
    });
    runtime.markDirty();
  }

  async function handleEntryPaste(event: ClipboardEvent, startIndex: number) {
    if (!isDraft.value || config.sourceLockedLines) {
      return;
    }
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (!text.trim()) {
      return;
    }
    event.preventDefault();
    const refs = await loadEntryPasteRefs();
    const pasteResult = parseEntryClipboard(text, refs, {
      fallbackWarehouseCode: batchWarehouseCode.value.trim() || "CK-001",
      defaultUnitPrice: config.defaultUnitPrice
    });
    if (pasteResult.lines.length === 0) {
      message.value = "未识别到可粘贴的分录。";
      return;
    }
    if (pasteResult.conflicts.length > 0) {
      activeSelector.value = "";
      pendingEntryPaste.value = { startIndex, lines: pasteResult.lines, conflicts: pasteResult.conflicts };
      message.value = `有 ${pasteResult.conflicts.length} 行商品需要选择。`;
      return;
    }
    applyPastedEntryLines(startIndex, pasteResult.lines);
  }

  async function loadEntryPasteRefs(): Promise<EntryPasteRefs> {
    const [productResult, warehouseResult] = await Promise.all([
      fetchListRows("product-master-list", { keyword: "", status: "", page: 1, pageSize: 1000 }),
      fetchListRows("warehouse-master-selector", { keyword: "", status: "", page: 1, pageSize: 1000 })
    ]);
    return {
      products: mergeMasterOptions(productResult.ok && productResult.data ? productResult.data.rows.map(masterRowToOption) : [], knownProductOptions),
      warehouses: warehouseResult.ok && warehouseResult.data ? warehouseResult.data.rows.map(masterRowToOption) : []
    };
  }

  function applyPastedEntryLines(startIndex: number, pastedLines: OrderLineForm[]) {
    pastedLines.forEach((line, offset) => {
      const targetIndex = startIndex + offset;
      if (targetIndex < form.lines.length) {
        form.lines.splice(targetIndex, 1, line);
      } else {
        form.lines.push(line);
      }
    });
    activeSelector.value = "";
    message.value = `已粘贴 ${pastedLines.length} 行分录`;
    runtime.markDirty();
    void focusLineCell(startIndex + pastedLines.length - 1, "qty", config.testPrefix);
  }

  function handleMasterInput(type: string, keywordValue: string, selectorId: string) {
    runtime.markDirty();
    void searchMasterOptions(type, keywordValue, selectorId);
  }

  async function searchMasterOptions(type: string, keywordValue: string, selectorId: string) {
    activeSelector.value = selectorId;
    selectorOptions.value = [];
    selectorCursorIndex.value = 0;
    const requestSeq = selectorRequestSeq + 1;
    selectorRequestSeq = requestSeq;
    const result = await fetchListRows(masterSelectorListKey(type), {
      keyword: keywordValue,
      status: "",
      page: 1,
      pageSize: 20
    });
    if (requestSeq !== selectorRequestSeq || activeSelector.value !== selectorId) {
      return;
    }
    selectorOptions.value = result.ok && result.data
      ? result.data.rows.map(masterRowToOption)
      : [];
    selectorCursorIndex.value = selectorOptions.value.length > 0 ? 0 : -1;
  }

  async function openMasterSelectorDialog(type: string, selectorId: string, keywordValue: string) {
    activeSelector.value = "";
    masterSelectorDialogOpen.value = true;
    masterSelectorDialogType.value = type;
    masterSelectorDialogSelectorId.value = selectorId;
    masterSelectorDialogKeyword.value = type === "warehouse" ? "" : keywordValue;
  }

  function closeMasterSelectorDialog() {
    masterSelectorDialogOpen.value = false;
  }

  function selectMasterSelectorDialogRow(option: MasterOption) {
    const selectorId = masterSelectorDialogSelectorId.value;
    if (!selectorId) {
      return;
    }
    if (selectorId.endsWith("-party")) {
      selectPartyOption(option, selectorId);
    } else if (selectorId.endsWith("-product")) {
      selectLineProduct(option, lineIndexFromSelector(selectorId), selectorId);
    } else if (selectorId.endsWith("-target-warehouse")) {
      selectTargetWarehouseOption(option, lineIndexFromSelector(selectorId), selectorId);
    } else if (selectorId.endsWith("-warehouse")) {
      selectWarehouseOption(option, lineIndexFromSelector(selectorId), selectorId);
    }
    closeMasterSelectorDialog();
  }

  function handleSelectorKeydown(event: KeyboardEvent, selectorId: string) {
    if (event.key === "Escape") {
      activeSelector.value = "";
      return;
    }
    if (activeSelector.value !== selectorId || selectorOptions.value.length === 0) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      selectorCursorIndex.value = Math.min(selectorCursorIndex.value + 1, selectorOptions.value.length - 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      selectorCursorIndex.value = Math.max(selectorCursorIndex.value - 1, 0);
      return;
    }
    if (event.key === "Enter" || (event.key === "Tab" && !event.shiftKey)) {
      event.preventDefault();
      chooseSelectorOption(selectorId);
    }
  }

  function chooseSelectorOption(selectorId: string) {
    const option = selectorOptions.value[selectorCursorIndex.value] ?? selectorOptions.value[0];
    if (!option) {
      return;
    }
    if (selectorId.endsWith("-party")) {
      selectPartyOption(option, selectorId);
    } else if (selectorId.endsWith("-product")) {
      selectLineProduct(option, lineIndexFromSelector(selectorId), selectorId);
    } else if (selectorId.endsWith("-target-warehouse")) {
      selectTargetWarehouseOption(option, lineIndexFromSelector(selectorId), selectorId);
    } else if (selectorId.endsWith("-warehouse")) {
      selectWarehouseOption(option, lineIndexFromSelector(selectorId), selectorId);
    }
  }

  function selectPartyOption(option: MasterOption, selectorId = selectorIdForParty(config.testPrefix)) {
    form.partyCode = option.code;
    form.partyName = option.name;
    activeSelector.value = "";
    runtime.markDirty();
    void refreshSalesLinePrices();
    focusNextAfterSelector(selectorId);
  }

  function selectWarehouseOption(option: MasterOption, lineIndex = 0, selectorId = selectorIdForLine(lineIndex, "warehouse", config.testPrefix)) {
    const line = form.lines[lineIndex];
    if (!line) {
      return;
    }
    line.warehouseCode = option.code;
    activeSelector.value = "";
    runtime.markDirty();
    focusNextAfterSelector(selectorId);
  }

  function selectTargetWarehouseOption(option: MasterOption, lineIndex = 0, selectorId = selectorIdForLine(lineIndex, "target-warehouse", config.testPrefix)) {
    const line = form.lines[lineIndex];
    if (!line) {
      return;
    }
    line.targetWarehouseCode = option.code;
    activeSelector.value = "";
    runtime.markDirty();
    focusNextAfterSelector(selectorId);
  }

  function selectLineProduct(option: MasterOption, lineIndex = 0, selectorId = selectorIdForLine(lineIndex, "product", config.testPrefix)) {
    const line = form.lines[lineIndex];
    if (!line) {
      return;
    }
    line.productCode = option.code;
    line.productId = option.id;
    line.productName = option.name;
    line.spec = option.spec ?? "";
    line.unit = option.unit ?? "";
    line.netWeight = option.netWeight ?? "";
    line.grossWeight = option.grossWeight ?? "";
    activeSelector.value = "";
    runtime.markDirty();
    void refreshSalesLinePrice(lineIndex);
    focusNextAfterSelector(selectorId);
  }

  async function refreshSalesLinePrices() {
    if (!isSalesPriceMemoryEnabled(config) || !isDraft.value) {
      return;
    }
    const requestSeq = priceRequestSeq + 1;
    priceRequestSeq = requestSeq;
    await Promise.all(form.lines.map((_, index) => refreshSalesLinePrice(index, requestSeq)));
  }

  async function refreshSalesLinePrice(lineIndex: number, requestSeq = priceRequestSeq) {
    if (!isSalesPriceMemoryEnabled(config) || !isDraft.value) {
      return;
    }
    const line = form.lines[lineIndex];
    const customerCode = form.partyCode.trim();
    const productCode = line?.productCode.trim();
    if (!line || !customerCode || !productCode) {
      return;
    }
    const result = await fetchSalesUnitPriceQuote(customerCode, productCode);
    if (requestSeq !== priceRequestSeq || !result.ok || !result.data) {
      return;
    }
    const currentLine = form.lines[lineIndex];
    if (!currentLine || currentLine.productCode.trim() !== productCode || form.partyCode.trim() !== customerCode) {
      return;
    }
    currentLine.unitPrice = Number(result.data.unitPrice ?? 0);
    runtime.markDirty();
  }

  function cancelZeroEntrySave() {
    pendingZeroEntrySave.value = null;
    message.value = "已取消保存，请检查零数量/零单价分录。";
  }

  async function confirmZeroEntrySave() {
    const pending = pendingZeroEntrySave.value;
    if (!pending) {
      return;
    }
    pending.warnings.forEach((warning) => {
      const line = form.lines[warning.lineNo - 1];
      if (line) {
        const reasonText = `零值原因：${warning.reason}（${warning.reasons.join("、")}）`;
        line.lineRemark = mergeLineRemark(line.lineRemark, reasonText);
      }
    });
    pendingZeroEntrySave.value = null;
    await save(true);
  }

  function selectEntryPasteCandidate(lineIndex: number, code: string) {
    const pending = pendingEntryPaste.value;
    if (!pending) {
      return;
    }
    const conflict = pending.conflicts.find((item) => item.lineIndex === lineIndex);
    const candidate = conflict?.candidates.find((item) => item.code === code);
    const line = pending.lines[lineIndex];
    if (!conflict || !candidate || !line) {
      return;
    }
    conflict.selectedCode = code;
    conflict.activeIndex = Math.max(0, conflict.candidates.findIndex((item) => item.code === code));
    line.productCode = candidate.code;
    line.productId = candidate.id;
    line.productName = candidate.name;
    line.spec = candidate.spec ?? "";
  }

  function isEntryPasteCandidateActive(conflict: EntryPasteConflict, candidateIndex: number) {
    return (conflict.activeIndex ?? 0) === candidateIndex;
  }

  function handleEntryPasteConflictKeydown(event: KeyboardEvent) {
    if (!pendingEntryPaste.value) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelPendingEntryPaste();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveEntryPasteCandidate(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      chooseActiveEntryPasteCandidate();
    }
  }

  function cancelPendingEntryPaste() {
    pendingEntryPaste.value = null;
    message.value = "已取消本次粘贴。";
  }

  function confirmPendingEntryPaste() {
    const pending = pendingEntryPaste.value;
    if (!pending || !entryPasteConflictsResolved.value) {
      return;
    }
    applyPastedEntryLines(pending.startIndex, pending.lines);
    pendingEntryPaste.value = null;
  }

  function moveEntryPasteCandidate(delta: number) {
    const conflict = activeEntryPasteConflict();
    if (!conflict || conflict.candidates.length === 0) {
      return;
    }
    const maxIndex = conflict.candidates.length - 1;
    const currentIndex = Math.min(Math.max(conflict.activeIndex ?? 0, 0), maxIndex);
    conflict.activeIndex = Math.min(Math.max(currentIndex + delta, 0), maxIndex);
  }

  function chooseActiveEntryPasteCandidate() {
    const conflict = activeEntryPasteConflict();
    if (!conflict || conflict.candidates.length === 0) {
      return;
    }
    const candidate = conflict.candidates[Math.min(Math.max(conflict.activeIndex ?? 0, 0), conflict.candidates.length - 1)];
    if (candidate) {
      selectEntryPasteCandidate(conflict.lineIndex, candidate.code);
    }
    if (entryPasteConflictsResolved.value) {
      confirmPendingEntryPaste();
    }
  }

  function activeEntryPasteConflict() {
    const pending = pendingEntryPaste.value;
    if (!pending) {
      return undefined;
    }
    return pending.conflicts.find((conflict) => !conflict.selectedCode) ?? pending.conflicts[0];
  }

  function handleLineCellKeydown(event: KeyboardEvent, lineIndex: number, cell: "product" | "warehouse" | "target-warehouse" | "qty" | "price", selectorId = "") {
    const selectorWasOpen = Boolean(selectorId && activeSelector.value === selectorId && selectorOptions.value.length > 0);
    if (selectorId) {
      handleSelectorKeydown(event, selectorId);
    }
    if (!isDraft.value || selectorWasOpen || event.defaultPrevented) {
      return;
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      insertLineAfter(lineIndex);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (cell === "qty") {
        void focusLineCell(lineIndex, "price", config.testPrefix);
      } else if (cell === "price") {
        insertLineAfter(lineIndex);
      } else {
        void focusLineCell(Math.min(lineIndex + 1, form.lines.length - 1), cell, config.testPrefix);
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      void focusLineCell(Math.min(lineIndex + 1, form.lines.length - 1), cell, config.testPrefix);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      void focusLineCell(Math.max(lineIndex - 1, 0), cell, config.testPrefix);
    }
  }

  function lineProductTestId(index: number) {
    return index === 0 ? `${config.testPrefix}-line-product` : `${config.testPrefix}-line-product-${index + 1}`;
  }

  function lineWarehouseTestId(index: number) {
    return index === 0 ? `${config.testPrefix}-line-warehouse` : `${config.testPrefix}-line-warehouse-${index + 1}`;
  }

  function lineTargetWarehouseTestId(index: number) {
    return index === 0 ? `${config.testPrefix}-line-target-warehouse` : `${config.testPrefix}-line-target-warehouse-${index + 1}`;
  }

  function lineQtyTestId(index: number) {
    return index === 0 ? `${config.testPrefix}-line-qty` : `${config.testPrefix}-line-qty-${index + 1}`;
  }

  function linePriceTestId(index: number) {
    return index === 0 ? `${config.testPrefix}-line-price` : `${config.testPrefix}-line-price-${index + 1}`;
  }

  function zeroReasonTestId(lineNo: number) {
    return lineNo === 1 ? "entry-zero-reason" : `entry-zero-reason-${lineNo}`;
  }

  function downstreamDocTestId(index: number) {
    return index === 0 ? "downstream-doc-open" : `downstream-doc-open-${index + 1}`;
  }

  function entryPasteCandidateTestId(lineIndex: number, code: string) {
    return `entry-paste-candidate-${lineIndex + 1}-${code}`;
  }

  function defaultLifecycleReason(action: LifecycleDocumentAction, lineNo?: number) {
    const target = lineNo == null ? "整单" : `第 ${lineNo} 行`;
    const labels: Record<LifecycleDocumentAction, string> = {
      close: "业务结束，剩余不再执行",
      unclose: "恢复继续执行",
      freeze: "临时暂停执行",
      unfreeze: "恢复执行",
      void: "录入错误，撤销无效业务事实"
    };
    return `${target}${labels[action]}`;
  }

  function lifecycleSuccessMessage(action: LifecycleDocumentAction, lineNo: number | null) {
    const target = lineNo == null ? "单据" : `第 ${lineNo} 行`;
    const labels: Record<LifecycleDocumentAction, string> = {
      close: "关闭成功",
      unclose: "反关闭成功",
      freeze: "冻结成功",
      unfreeze: "解冻成功",
      void: "作废成功"
    };
    return `${target}${labels[action]}`;
  }

  function applyLifecycleLocal(action: LifecycleDocumentAction, lineNo: number | null) {
    if (action === "void") {
      form.status = "VOIDED";
      return;
    }
    if (lineNo != null) {
      const line = form.lines.find((item, index) => Number(item.lineNo ?? index + 1) === lineNo);
      if (line) {
        if (action === "close" || action === "unclose") {
          line.lineCloseStatus = action === "close" ? "CLOSED" : "OPEN";
          form.closeStatus = form.lines.every((item) => item.lineCloseStatus === "CLOSED") ? "CLOSED" : "OPEN";
          form.closeMode = form.closeStatus === "CLOSED" && config.documentType === "salesOrder" ? null : form.closeMode;
        }
        if (action === "freeze" || action === "unfreeze") {
          line.lineFrozenStatus = action === "freeze" ? "FROZEN" : "NORMAL";
        }
      }
      return;
    }
    if (action === "close" || action === "unclose") {
      form.closeStatus = action === "close" ? "CLOSED" : "OPEN";
      form.closeMode = action === "close" && config.documentType === "salesOrder" ? "MANUAL" : null;
      if (config.documentType !== "salesOrder") {
        form.lines.forEach((line) => { line.lineCloseStatus = form.closeStatus; });
      }
    }
    if (action === "freeze" || action === "unfreeze") {
      form.frozenStatus = action === "freeze" ? "FROZEN" : "NORMAL";
      form.lines.forEach((line) => { line.lineFrozenStatus = form.frozenStatus; });
    }
  }

  return {
    form,
    message,
    batchWarehouseCode,
    batchPlanDeliveryDate,
    activeSelector,
    selectorOptions,
    selectorCursorIndex,
    masterSelectorDialogOpen,
    masterSelectorDialogType,
    masterSelectorDialogTitle,
    masterSelectorDialogLabel,
    masterSelectorDialogKeyword,
    draggingLineIndex,
    highlightedSourceBillNo,
    highlightedSourceLineNo,
    downstreamTrace,
    pendingEntryPaste,
    pendingZeroEntrySave,
    pendingRiskyDocumentAction,
    pendingLifecycleAction,
    pendingLifecycleLineNo,
    pendingDeleteDocument,
    lifecycleReason,
    voidUsername,
    voidPassword,
    zeroReasonOptions,
    isDraft,
    canAudit,
    canReverse,
    canRedReverse,
    canVoid,
    canClose,
    canUnclose,
    canFreeze,
    canUnfreeze,
    showCloseFreezeActions,
    showDelete,
    canDelete,
    canTraceSourceOrder,
    showSourceLineColumn,
    showExecutionColumns,
    showTargetWarehouseColumn,
    showSupplierMaterialCodeColumn,
    showTaxColumns,
    showPlanDeliveryDateColumn,
    showStockColumns: computed(() => Boolean(config.showStockColumns)),
    stockColumnMode: config.stockColumnMode ?? "all",
    showProductInfoSection: config.showProductInfoSection ?? false,
    executionQtyLabel: config.executionQtyLabel ?? "已执行",
    remainingQtyLabel: config.remainingQtyLabel ?? "剩余",
    qtyLabel: config.qtyLabel ?? "数量",
    stockAvailableLabel: config.stockAvailableLabel ?? "可用库存",
    showExecutedQtyColumn: config.showExecutedQtyColumn ?? true,
    showPriceAmountColumns: config.showPriceAmountColumns ?? true,
    sourceLockedLines: computed(() => Boolean(config.sourceLockedLines)),
    entryTableColspan,
    entryTotalColspan,
    totalAmount,
    statusLabel,
    redReverseBillNo,
    riskyActionTitle,
    riskyActionSummary,
    riskyActionImpact,
    riskyActionVerb,
    entryPasteConflictsResolved,
    knownProductOptions,
    startNew,
    loadByBillNo,
    refreshStock,
    applyDetail,
    applyPushDownDraft,
    applyInboundPushDownDraft,
    save,
    audit,
    openRiskyAction,
    cancelRiskyAction,
    confirmRiskyAction,
    deleteCurrent,
    cancelDeleteDocument,
    confirmDeleteDocument,
    openLifecycleAction,
    cancelLifecycleAction,
    confirmLifecycleAction,
    exportCurrent,
    printCurrent,
    openRedReverseBill,
    openRedSourceBill,
    traceSourceOrder,
    openDownstreamTrace,
    openDownstreamDocument,
    markDirty,
    addLine,
    insertLineAfter,
    copyLine,
    removeLine,
    handleLineDragStart,
    handleLineDragOver,
    handleLineDrop,
    applyBatchWarehouse,
    applyBatchPlanDeliveryDate,
    handleEntryPaste,
    handleMasterInput,
    searchMasterOptions,
    handleSelectorKeydown,
    openMasterSelectorDialog,
    closeMasterSelectorDialog,
    selectMasterSelectorDialogRow,
    selectPartyOption,
    selectWarehouseOption,
    selectTargetWarehouseOption,
    selectLineProduct,
    cancelZeroEntrySave,
    confirmZeroEntrySave,
    selectEntryPasteCandidate,
    isEntryPasteCandidateActive,
    handleEntryPasteConflictKeydown,
    cancelPendingEntryPaste,
    confirmPendingEntryPaste,
    handleLineCellKeydown,
    formatQty,
    formatAmount,
    backendStatusLabel,
    downstreamTypeLabel,
    downstreamReverseImpact,
    downstreamRedReverseImpact,
    zeroReasonTestId,
    downstreamDocTestId,
    entryPasteCandidateTestId
  };

  function defaultLine(warehouseCode = "CK-001"): OrderLineForm {
      return {
        productCode: "",
        productId: "",
        unit: "",
        netWeight: "",
        grossWeight: "",
        warehouseCode,
      targetWarehouseCode: config.showTargetWarehouseColumn ? config.defaultTargetWarehouseCode ?? "CK-002" : undefined,
      qty: 0,
      unitPrice: 0,
      taxRate: 13,
      lineRemark: "",
      customerMaterialCode: "",
      supplierMaterialCode: "",
      customerOrderNo: "",
      planDeliveryDate: defaultPlanDeliveryDateForDocument()
    };
  }

  function blankLine(): OrderLineForm {
    return {
      productCode: "",
      productId: "",
      unit: "",
      netWeight: "",
      grossWeight: "",
      warehouseCode: "",
      targetWarehouseCode: config.showTargetWarehouseColumn ? "" : undefined,
      qty: 0,
      unitPrice: 0,
      taxRate: 13,
      lineRemark: "",
      customerMaterialCode: "",
      supplierMaterialCode: "",
      customerOrderNo: "",
      planDeliveryDate: defaultPlanDeliveryDateForDocument()
    };
  }

  function defaultPlanDeliveryDateForDocument() {
    return supportsPlanDeliveryDate(config.documentType) ? defaultPlanDeliveryDate() : "";
  }

  function snapshotState(): DocumentModuleSnapshot {
    return {
      form: plainClone(form),
      message: message.value,
      batchWarehouseCode: batchWarehouseCode.value,
      batchPlanDeliveryDate: batchPlanDeliveryDate.value,
      highlightedSourceBillNo: highlightedSourceBillNo.value,
      highlightedSourceLineNo: highlightedSourceLineNo.value
    };
  }

  function restoreSnapshot(snapshot: DocumentModuleSnapshot) {
    Object.assign(form, {
      ...snapshot.form,
      lines: snapshot.form.lines.map((line) => ({ ...line }))
    });
    message.value = snapshot.message;
    batchWarehouseCode.value = snapshot.batchWarehouseCode;
    batchPlanDeliveryDate.value = snapshot.batchPlanDeliveryDate;
    highlightedSourceBillNo.value = snapshot.highlightedSourceBillNo;
    highlightedSourceLineNo.value = snapshot.highlightedSourceLineNo;
  }

  function prepareEntryLinesForSave(lines: OrderLineForm[]): { ok: true } & PreparedEntryLines | { ok: false; message: string } {
    const nonBlankLines = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => !isBlankEntryLine(line));
    if (nonBlankLines.length === 0) {
      return { ok: false, message: config.sourceLockedLines ? "请先选择至少一行销售出库源单。" : "至少保留一行有效分录。" };
    }
    if (config.sourceLockedLines) {
      const missingSource = nonBlankLines.find(({ line }) => !String(line.sourceOrderNo ?? "").trim() || !normalizedOptionalInt(line.sourceLineNo));
      if (missingSource) {
        return { ok: false, message: `第 ${missingSource.index + 1} 行必须来自销售出库源单。` };
      }
      const invalidQty = nonBlankLines.find(({ line }) => !Number.isFinite(Number(line.qty)) || Number(line.qty) <= 0);
      if (invalidQty) {
        return { ok: false, message: `第 ${invalidQty.index + 1} 行退货数量必须大于 0。` };
      }
    }
    const missingProduct = nonBlankLines.find(({ line }) => !entryLineProductCode(line));
    if (missingProduct) {
      return { ok: false, message: `第 ${missingProduct.index + 1} 行物料编码不能为空。` };
    }
    const missingTargetWarehouse = config.showTargetWarehouseColumn
      ? nonBlankLines.find(({ line }) => !String(line.targetWarehouseCode ?? "").trim())
      : undefined;
    if (missingTargetWarehouse) {
      return { ok: false, message: `第 ${missingTargetWarehouse.index + 1} 行目标仓库不能为空。` };
    }
    const formLines = nonBlankLines.map(({ line }) => line);
    return {
      ok: true,
      formLines,
      documentLines: formLines.map((line) => ({
        lineNo: line.lineNo,
        productCode: line.productCode,
        productId: line.productId,
        unit: line.unit,
        netWeight: line.netWeight,
        grossWeight: line.grossWeight,
        warehouseCode: line.warehouseCode,
        targetWarehouseCode: config.showTargetWarehouseColumn ? entryLineTargetWarehouseCode(line) : undefined,
        sourceLineNo: line.sourceLineNo,
        sourceOrderNo: line.sourceOrderNo,
        sourcePurchasePlanId: line.sourcePurchasePlanId,
        sourcePurchasePlanLineId: line.sourcePurchasePlanLineId,
        sourcePurchasePlanNo: line.sourcePurchasePlanNo,
        sourcePurchasePlanLineNo: line.sourcePurchasePlanLineNo,
        customerMaterialCode: String(line.customerMaterialCode ?? "").trim(),
        supplierMaterialCode: String(line.supplierMaterialCode ?? "").trim(),
        customerOrderNo: String(line.customerOrderNo ?? "").trim(),
        qty: Number(line.qty || 0),
        unitPrice: Number(line.unitPrice || 0),
        taxRate: Number(line.taxRate ?? 13),
        lineRemark: String(line.lineRemark ?? "").trim(),
        planDeliveryDate: supportsPlanDeliveryDate(config.documentType) ? String(line.planDeliveryDate ?? "").trim() || undefined : undefined
      })),
      removedBlankCount: lines.length - formLines.length
    };
  }
}

async function scrollHighlightedSourceLineIntoView(sourceLineNo: number) {
  await nextTick();
  const target = document.querySelector<HTMLElement>(`.entry-table tr[data-line-no="${sourceLineNo}"]`);
  target?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function todayText() {
  return formatDateText(new Date());
}

function defaultPlanDeliveryDate() {
  return todayText();
}

function formatDateText(date: Date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function defaultSalesQuoteValidUntil() {
  const date = new Date();
  date.setDate(date.getDate() + 30);
  return formatDateText(date);
}

function supportsPlanDeliveryDate(documentType: string) {
  return documentType === "salesOrder" || documentType === "deliveryNotice" || documentType === "purchaseOrder";
}

function normalizedQty(value: number | string | undefined) {
  const qty = Number(value ?? 0);
  return Number.isFinite(qty) ? qty : 0;
}

function normalizedOptionalInt(value: number | string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeDocumentVersion(value: unknown) {
  const normalized = String(value ?? "").trim();
  return /^(0|[1-9]\d*)$/.test(normalized) ? normalized : undefined;
}

function isSalesPriceMemoryEnabled(config: DocumentModuleOptions) {
  return config.documentType === "salesOrder" && config.partyKind === "customer";
}

function normalizeDownstreamDocs(docs: DownstreamDocumentRef[] | undefined) {
  if (!Array.isArray(docs)) {
    return [];
  }
  return docs
    .map((doc) => ({
      billNo: String(doc.billNo ?? ""),
      type: doc.type,
      typeLabel: doc.typeLabel ? String(doc.typeLabel) : undefined,
      status: doc.status ? String(doc.status) : undefined,
      billDate: doc.billDate ? String(doc.billDate) : undefined,
      sourceLineNo: doc.sourceLineNo,
      downstreamLineNo: doc.downstreamLineNo,
      qty: doc.qty,
      amount: doc.amount,
      riskLevel: doc.riskLevel ? String(doc.riskLevel) : undefined,
      reverseImpact: doc.reverseImpact ? String(doc.reverseImpact) : undefined,
      redReverseImpact: doc.redReverseImpact ? String(doc.redReverseImpact) : undefined
    }))
    .filter((doc) => doc.billNo && doc.type);
}

function documentLineExecutedQty(line: { shippedQty?: number | string; receivedQty?: number | string; systemQty?: number | string }) {
  if (line.systemQty !== undefined) {
    return normalizedQty(line.systemQty);
  }
  if (line.shippedQty !== undefined) {
    return normalizedQty(line.shippedQty);
  }
  if (line.receivedQty !== undefined) {
    return normalizedQty(line.receivedQty);
  }
  return undefined;
}

function documentLineRemainingQty(line: { remainingQty?: number | string; diffQty?: number | string }) {
  if (line.diffQty !== undefined) {
    return normalizedQty(line.diffQty);
  }
  return line.remainingQty === undefined ? undefined : normalizedQty(line.remainingQty);
}

function documentLineAvailableNoticeQty(line: { availableNoticeQty?: number | string }) {
  return line.availableNoticeQty === undefined ? undefined : normalizedQty(line.availableNoticeQty);
}

function lineLineNo(line: OrderLineForm, index: number) {
  return line.lineNo ?? index + 1;
}

function formatQty(value: number | string | undefined) {
  const qty = Number(value ?? 0);
  if (!Number.isFinite(qty)) {
    return "0";
  }
  return Number.isInteger(qty) ? String(qty) : qty.toFixed(2);
}

function formatAmount(value: number | string | undefined) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? amount.toFixed(2) : "0.00";
}

function backendStatusLabel(status: string | undefined) {
  const labels: Record<string, string> = {
    DRAFT: "草稿",
    AUDITED: "已审核",
    REVERSED: "已反审核",
    VOID: "已作废",
    VOIDED: "已作废",
    RED_REVERSED: "已红冲"
  };
  return labels[status ?? ""] ?? status ?? "-";
}

function downstreamTypeLabel(type: OpenableDocumentType) {
  const labels: Record<OpenableDocumentType, string> = {
    salesQuote: "销售报价单",
    salesOrder: "销售订单",
    deliveryNotice: "发货通知单",
    salesOut: "销售出库单",
    salesReturn: "销售退货单",
    purchaseOrder: "采购订单",
    purchaseIn: "采购入库单",
    purchaseReturn: "采购退货单",
    materialIssue: "生产领料单",
    productIn: "产品入库单",
    otherStockIn: "其他入库单",
    otherStockOut: "其他出库单",
    stockTransfer: "调拨单",
    stockCount: "盘点单",
    stockCountGain: "盘盈单",
    stockCountLoss: "盘亏单"
  };
  return labels[type];
}

function downstreamReverseImpact(doc: DownstreamDocumentRef) {
  const qty = formatQty(doc.qty);
  if (doc.type === "purchaseIn") {
    return `反审核将冲销采购入库库存流水，并回退源采购订单已入库数量 ${qty}。`;
  }
  return `反审核将冲销销售出库库存流水，并回退源销售订单已出库数量 ${qty}。`;
}

function downstreamRedReverseImpact(doc: DownstreamDocumentRef) {
  const qty = formatQty(doc.qty);
	  if (doc.type === "purchaseIn") {
	    return `红冲将生成负数采购入库草稿；审核红字单后回退源采购订单已入库数量 ${qty}。`;
	  }
	  return `红冲将生成负数销售出库草稿；审核红字单后回退源销售订单已出库数量 ${qty}。`;
	}

function isBlankEntryLine(line: OrderLineForm) {
  return !entryLineProductCode(line)
    && !String(line.productName ?? "").trim()
    && !String(line.spec ?? "").trim()
    && !String(line.lineRemark ?? "").trim()
    && normalizedQty(line.qty) === 0
    && normalizedQty(line.unitPrice) === 0;
}

function entryLineProductCode(line: OrderLineForm) {
  return String(line.productCode ?? "").trim();
}

function entryLineWarehouseCode(line: OrderLineForm) {
  return String(line.warehouseCode ?? "").trim() || "CK-001";
}

function entryLineTargetWarehouseCode(line: OrderLineForm) {
  return String(line.targetWarehouseCode ?? "").trim() || "CK-002";
}

function zeroEntryWarnings(lines: OrderLineForm[], allowZeroQty = false): ZeroEntryWarning[] {
  return lines
    .map((line, index) => {
      const qty = normalizedQty(line.qty);
      const unitPrice = normalizedQty(line.unitPrice);
      const reasons = [
        qty === 0 && !allowZeroQty ? "数量为 0" : "",
        unitPrice === 0 ? "单价为 0" : ""
      ].filter(Boolean);
      return {
        lineNo: index + 1,
      productCode: entryLineProductCode(line),
      productId: String(line.productId ?? "").trim() || undefined,
        warehouseCode: entryLineWarehouseCode(line),
        qty,
        unitPrice,
        reasons,
        reason: zeroReasonOptions[0]
      };
    })
    .filter((warning) => warning.reasons.length > 0);
}

function saveSuccessMessage(removedBlankCount: number, confirmedZeroCount = 0) {
  const notes: string[] = [];
  if (removedBlankCount > 0) {
    notes.push(`已移除 ${removedBlankCount} 行空白分录`);
  }
  if (confirmedZeroCount > 0) {
    notes.push(`已确认 ${confirmedZeroCount} 行零值分录`);
  }
  return notes.length > 0 ? `草稿已保存，${notes.join("，")}` : "草稿已保存";
}

function mergeLineRemark(current: string | undefined, addition: string) {
  const trimmed = String(current ?? "").trim();
  if (!trimmed) {
    return addition;
  }
  if (trimmed.includes(addition)) {
    return trimmed;
  }
  return `${trimmed}；${addition}`;
}

async function focusFormField(testId: string) {
  await nextTick();
  const input = document.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
  input?.focus();
  input?.select();
}

function lineIndexFromSelector(selectorId: string) {
  const match = selectorId.match(/-line-(\d+)-/);
  return match ? Number(match[1]) : 0;
}

function selectorIdForLine(lineIndex: number, field: "product" | "warehouse" | "target-warehouse", testPrefix = "") {
  return `${testPrefix}-line-${lineIndex}-${field}`;
}

function selectorIdForParty(testPrefix = "") {
  return `${testPrefix}-party`;
}

function masterSelectorListKey(type: string) {
  const listKeyByType: Record<string, string> = {
    customer: "customer-master-list",
    supplier: "supplier-master-list",
    product: "product-master-list",
    warehouse: "warehouse-master-selector"
  };
  return listKeyByType[type] ?? "product-master-list";
}

function masterSelectorLabel(type: string) {
  const labelByType: Record<string, string> = {
    customer: "客户",
    supplier: "供应商",
    product: "商品",
    warehouse: "仓库"
  };
  return labelByType[type] ?? "资料";
}

async function focusLineCell(lineIndex: number, cell: "product" | "warehouse" | "target-warehouse" | "qty" | "price", testPrefix = "") {
  await nextTick();
  const suffix = lineIndex === 0 ? "" : `-${lineIndex + 1}`;
  const field = cell === "product" ? "product" : cell === "warehouse" ? "warehouse" : cell === "target-warehouse" ? "target-warehouse" : cell;
  const input = document.querySelector<HTMLInputElement>(`[data-testid="${testPrefix}-line-${field}${suffix}"]`);
  input?.focus();
  input?.select();
}

function focusNextAfterSelector(selectorId: string) {
  if (selectorId.endsWith("-party")) {
    void focusFormField(`${selectorId.replace(/-party$/, "")}-bill-date`);
    return;
  }
  const linePrefix = selectorId.match(/^(.*)-line-\d+-(product|warehouse|target-warehouse)$/)?.[1] ?? "";
  const lineIndex = lineIndexFromSelector(selectorId);
  if (selectorId.endsWith("-product")) {
    void focusLineCell(lineIndex, "warehouse", linePrefix);
    return;
  }
  if (selectorId.endsWith("-target-warehouse")) {
    void focusLineCell(lineIndex, "qty", linePrefix);
    return;
  }
  if (selectorId.endsWith("-warehouse")) {
    void focusLineCell(lineIndex, "qty", linePrefix);
    return;
  }
}
