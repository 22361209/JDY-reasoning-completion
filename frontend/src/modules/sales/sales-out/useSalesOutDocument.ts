import { computed, nextTick, reactive, ref } from "vue";
import {
  initialSalesOutForm,
  knownProductOptions,
  knownWarehouseOptions,
  zeroReasonOptions,
  type DownstreamTraceState,
  type EntryPasteConflict,
  type EntryPasteRefs,
  type MasterOption,
  type OrderForm,
  type OrderLineForm,
  type PendingEntryPaste,
  type PendingPushLine,
  type PendingZeroEntrySave,
  type RiskyDocumentAction,
  type ZeroEntryWarning
} from "../../../app/documentModel";
import { fetchListRows } from "../../../services/listApi";
import {
  auditDocument,
  exportDocument,
  fetchDocumentDetail,
  printDocument,
  redReverseDocument,
  reverseDocument,
  saveDocumentDraft,
  voidDocument,
  type DocumentDetail,
  type DownstreamDocumentRef,
  type OpenableDocumentType
} from "../../../services/documentApi";

interface SalesOutDocumentOptions {
  userName: () => string;
  hasPermission: (permission: string) => boolean;
  markDirty: () => void;
  clearDirty: () => void;
  requestOpenDocument: (payload: { type: OpenableDocumentType; billNo: string; sourceLineNo?: number | null }) => void;
}

export interface SalesOutPushDownDraft {
  billNo: string;
  sourceOrderNo: string;
  partyCode: string;
  billDate: string;
  department: string;
  ownerName: string;
  lines: PendingPushLine[];
}

type PreparedEntryLines = {
  formLines: OrderLineForm[];
  documentLines: {
    productCode: string;
    warehouseCode: string;
    sourceLineNo?: number;
    qty: number;
    unitPrice: number;
    lineRemark: string;
  }[];
  removedBlankCount: number;
};

const formStatusByBackendStatus: Record<string, OrderForm["status"]> = {
  DRAFT: "DRAFT",
  AUDITED: "AUDITED",
  REVERSED: "REVERSED",
  VOID: "VOIDED",
  RED_REVERSED: "RED_REVERSED"
};

export function useSalesOutDocument(options: SalesOutDocumentOptions) {
  const form = reactive<OrderForm>({
    ...initialSalesOutForm,
    lines: initialSalesOutForm.lines.map((line) => ({ ...line }))
  });
  const message = ref("");
  const batchWarehouseCode = ref("");
  const activeSelector = ref("");
  const selectorOptions = ref<MasterOption[]>([]);
  const selectorCursorIndex = ref(0);
  const draggingLineIndex = ref<number | null>(null);
  const pendingZeroEntrySave = ref<PendingZeroEntrySave | null>(null);
  const downstreamTrace = ref<DownstreamTraceState | null>(null);
  const pendingRiskyDocumentAction = ref<RiskyDocumentAction | null>(null);
  const pendingEntryPaste = ref<PendingEntryPaste | null>(null);
  const highlightedSourceBillNo = ref("");
  const highlightedSourceLineNo = ref<number | null>(null);
  let selectorRequestSeq = 0;

  const isDraft = computed(() => form.status === "DRAFT");
  const canAudit = computed(() => isDraft.value && options.hasPermission("sales.out.audit"));
  const canReverse = computed(() => form.status === "AUDITED");
  const canVoid = computed(() => form.status === "DRAFT");
  const canDelete = computed(() => false);
  const canTraceSourceOrder = computed(() => Boolean(form.sourceOrderNo?.trim()));
  const statusLabel = computed(() => {
    const labels: Record<OrderForm["status"], string> = {
      DRAFT: "草稿",
      AUDITED: "已审核",
      REVERSED: "已反审核",
      VOIDED: "已作废",
      RED_REVERSED: "已红冲"
    };
    return labels[form.status];
  });
  const totalAmount = computed(() => form.lines.reduce((sum, line) => sum + Number(line.qty || 0) * Number(line.unitPrice || 0), 0).toFixed(2));
  const showSourceLineColumn = computed(() => Boolean(form.sourceOrderNo));
  const entryTableColspan = computed(() => 9 + (showSourceLineColumn.value ? 1 : 0));
  const entryTotalColspan = computed(() => entryTableColspan.value - 1);
  const redReverseBillNo = computed(() => `HC-${form.billNo}`);
  const riskyActionVerb = computed(() => pendingRiskyDocumentAction.value === "redReverse" ? "红冲" : "反审核");
  const riskyActionTitle = computed(() => `${riskyActionVerb.value}确认`);
  const riskyActionSummary = computed(() => `即将${riskyActionVerb.value}销售出库单 ${form.billNo}。`);
  const riskyActionImpact = computed(() => pendingRiskyDocumentAction.value === "redReverse"
    ? "红冲将生成负数销售出库单，原单标记已红冲，并回退销售订单已出库数量、重算出库状态。"
    : "反审核将冲销销售出库库存流水，回退销售订单已出库数量，并重算出库状态。");
  const entryPasteConflictsResolved = computed(() => Boolean(pendingEntryPaste.value?.conflicts.every((conflict) => conflict.selectedCode)));

  function startNew() {
    const today = new Date();
    form.billDate = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, "0"),
      String(today.getDate()).padStart(2, "0")
    ].join("-");
    form.billNo = nextBillNoFor("XSCK");
    form.sourceOrderNo = "";
    form.redReverseBillNo = undefined;
    form.redSourceBillNo = undefined;
    form.partyCode = "KH-001";
    form.department = "销售部";
    form.ownerName = options.userName() || "本地管理员";
    form.status = "DRAFT";
    form.lines = [defaultLine()];
    message.value = "已生成新单据草稿号";
    options.markDirty();
  }

  function fillFromDetail(detail: DocumentDetail) {
    const document = detail.document;
    form.billNo = document.billNo;
    form.sourceOrderNo = document.sourceOrderNo || undefined;
    form.redReverseBillNo = document.redReverseBillNo || undefined;
    form.redSourceBillNo = document.redSourceBillNo || undefined;
    form.partyCode = document.sourceOrderNo && document.customerCode === "SC" ? document.sourceOrderNo : document.customerCode || "KH-001";
    form.billDate = document.billDate;
    form.department = document.department || "销售部";
    form.ownerName = document.ownerName || "本地管理员";
    form.status = formStatusByBackendStatus[document.status] ?? "DRAFT";
    form.lines = detail.lines.length
      ? detail.lines.map((line) => ({
        productCode: String(line.productCode ?? ""),
        productName: String(line.productName ?? ""),
        spec: String(line.spec ?? ""),
        warehouseCode: String(line.warehouseCode ?? "CK-001"),
        lineNo: normalizedOptionalInt(line.lineNo),
        sourceLineNo: normalizedOptionalInt(line.sourceLineNo),
        qty: Number(line.qty ?? 0),
        executedQty: line.shippedQty === undefined ? undefined : normalizedQty(line.shippedQty),
        remainingQty: line.remainingQty === undefined ? undefined : normalizedQty(line.remainingQty),
        unitPrice: Number(line.unitPrice ?? 0),
        lineRemark: String(line.lineRemark ?? ""),
        downstreamDocs: normalizeDownstreamDocs(line.downstreamDocs)
      }))
      : [defaultLine()];
  }

  async function loadByBillNo(billNo: string) {
    form.lines = [];
    const result = await fetchDocumentDetail("salesOut", billNo);
    if (!result.ok || !result.data) {
      message.value = result.message || "单据详情加载失败。";
      return;
    }
    fillFromDetail(result.data);
    message.value = `已打开销售出库单 ${billNo}`;
    options.clearDirty();
  }

  function applyDetail(detail: DocumentDetail, loadedMessage = "", sourceLineNo: number | null = null) {
    fillFromDetail(detail);
    highlightedSourceBillNo.value = sourceLineNo ? form.billNo : "";
    highlightedSourceLineNo.value = sourceLineNo;
    message.value = loadedMessage;
    options.clearDirty();
    if (sourceLineNo) {
      void scrollHighlightedSourceLineIntoView(sourceLineNo);
    }
  }

  function applyPushDownDraft(draft: SalesOutPushDownDraft) {
    form.billNo = draft.billNo;
    form.sourceOrderNo = draft.sourceOrderNo;
    form.redReverseBillNo = undefined;
    form.redSourceBillNo = undefined;
    form.partyCode = draft.partyCode;
    form.billDate = draft.billDate;
    form.department = draft.department;
    form.ownerName = draft.ownerName;
    form.status = "DRAFT";
    form.lines = draft.lines.map((line) => ({
      productCode: String(line.productCode ?? ""),
      productName: String(line.productName ?? ""),
      spec: String(line.spec ?? ""),
      warehouseCode: String(line.warehouseCode ?? "CK-001"),
      sourceLineNo: line.sourceLineNo,
      qty: normalizedQty(line.qty),
      unitPrice: Number(line.unitPrice ?? 0),
      lineRemark: String(line.lineRemark ?? "")
    }));
    message.value = `已由${draft.sourceOrderNo}按确认数量生成销售出库单草稿`;
    options.markDirty();
  }

  async function save(allowZeroValues = false) {
    if (!allowZeroValues) {
      pendingZeroEntrySave.value = null;
    }
    message.value = "";
    const preparedLines = prepareEntryLinesForSave(form.lines);
    if (!preparedLines.ok) {
      message.value = preparedLines.message;
      return;
    }
    const zeroWarnings = zeroEntryWarnings(preparedLines.formLines);
    if (!allowZeroValues && zeroWarnings.length > 0) {
      pendingZeroEntrySave.value = { target: "document", warnings: zeroWarnings };
      return;
    }
    form.lines = preparedLines.formLines;
    const result = await saveDocumentDraft("salesOut", {
      billNo: form.billNo,
      sourceOrderNo: form.sourceOrderNo,
      partyCode: form.partyCode,
      billDate: form.billDate,
      department: form.department,
      ownerName: form.ownerName,
      lines: preparedLines.documentLines
    });
    message.value = result.ok ? saveSuccessMessage(preparedLines.removedBlankCount, allowZeroValues ? zeroWarnings.length : 0) : result.message;
    if (result.ok) {
      form.status = "DRAFT";
      options.clearDirty();
    }
  }

  async function audit() {
    if (!options.hasPermission("sales.out.audit")) {
      message.value = "当前角色无权审核该单据。";
      return;
    }
    const result = await auditDocument("salesOut", form.billNo);
    message.value = result.ok ? "审核成功" : result.message;
    if (result.ok) {
      form.status = "AUDITED";
      options.clearDirty();
    }
  }

  function openRiskyAction(action: RiskyDocumentAction) {
    if (!canReverse.value) {
      return;
    }
    pendingRiskyDocumentAction.value = action;
  }

  function cancelRiskyAction() {
    const verb = riskyActionVerb.value;
    pendingRiskyDocumentAction.value = null;
    message.value = `已取消${verb}。`;
  }

  async function confirmRiskyAction() {
    const action = pendingRiskyDocumentAction.value;
    if (!action) {
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
    const result = await reverseDocument("salesOut", form.billNo);
    message.value = result.ok ? "反审核成功，库存流水已冲销" : result.message;
    if (result.ok) {
      form.status = "REVERSED";
    }
  }

  async function voidCurrent() {
    const result = await voidDocument("salesOut", form.billNo);
    message.value = result.ok ? "作废成功" : result.message;
    if (result.ok) {
      form.status = "VOIDED";
      options.clearDirty();
    }
  }

  async function redReverse() {
    const redBillNo = redReverseBillNo.value;
    const result = await redReverseDocument("salesOut", form.billNo, {
      redBillNo,
      billDate: form.billDate,
      ownerName: form.ownerName
    });
    message.value = result.ok ? `红冲成功：${redBillNo}` : result.message;
    if (result.ok) {
      const detail = await fetchDocumentDetail("salesOut", redBillNo);
      if (detail.ok && detail.data) {
        fillFromDetail(detail.data);
      } else {
        form.billNo = redBillNo;
        form.status = "RED_REVERSED";
      }
      options.clearDirty();
    }
  }

  async function exportCurrent() {
    const result = await exportDocument("salesOut", form.billNo);
    message.value = result.ok ? "引出文件已生成" : result.message;
  }

  async function printCurrent() {
    const result = await printDocument("salesOut", form.billNo);
    if (result.ok && result.data) {
      window.open(result.data, "_blank", "noopener");
    }
    message.value = result.ok ? "PDF 打印文件已生成" : result.message;
  }

  async function openRedReverseBill() {
    const billNo = form.redReverseBillNo?.trim();
    if (billNo) {
      await loadByBillNo(billNo);
    }
  }

  async function openRedSourceBill() {
    const billNo = form.redSourceBillNo?.trim();
    if (billNo) {
      await loadByBillNo(billNo);
    }
  }

  function traceSourceOrder(sourceLineNo?: number) {
    const billNo = form.sourceOrderNo?.trim();
    if (!billNo) {
      return;
    }
    options.requestOpenDocument({ type: "salesOrder", billNo, sourceLineNo: sourceLineNo ?? form.lines.find((line) => line.sourceLineNo)?.sourceLineNo ?? null });
  }

  function openDownstreamTrace(line: OrderLineForm, index: number) {
    if (!line.downstreamDocs?.length) {
      return;
    }
    downstreamTrace.value = {
      title: `${form.billNo} 第 ${lineLineNo(line, index)} 行执行单据`,
      lineNo: lineLineNo(line, index),
      executedQty: formatQty(line.executedQty),
      docs: line.downstreamDocs
    };
  }

  function openDownstreamDocument(doc: DownstreamDocumentRef) {
    if (doc.billNo && doc.type) {
      downstreamTrace.value = null;
      options.requestOpenDocument({ type: doc.type, billNo: doc.billNo });
    }
  }

  function defaultLine(warehouseCode = "CK-001"): OrderLineForm {
    return { productCode: "CP-001", warehouseCode, qty: 1, unitPrice: 86, lineRemark: "" };
  }

  function addLine() {
    if (!isDraft.value) {
      return;
    }
    const previousLine = form.lines[form.lines.length - 1];
    form.lines.push(defaultLine(previousLine?.warehouseCode || "CK-001"));
    options.markDirty();
  }

  function insertLineAfter(index: number) {
    if (!isDraft.value) {
      return;
    }
    const previousLine = form.lines[index];
    form.lines.splice(index + 1, 0, defaultLine(previousLine?.warehouseCode || "CK-001"));
    options.markDirty();
    void focusLineCell(index + 1, "product");
  }

  function copyLine(index: number) {
    if (!isDraft.value) {
      return;
    }
    const source = form.lines[index];
    if (!source) {
      return;
    }
    form.lines.splice(index + 1, 0, { ...source });
    options.markDirty();
    void focusLineCell(index + 1, "product");
  }

  function removeLine(index: number) {
    if (!isDraft.value || form.lines.length <= 1) {
      return;
    }
    form.lines.splice(index, 1);
    options.markDirty();
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
    }
    activeSelector.value = "";
    draggingLineIndex.value = null;
    options.markDirty();
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
    });
    activeSelector.value = "";
    options.markDirty();
  }

  async function handleEntryPaste(event: ClipboardEvent, startIndex: number) {
    if (!isDraft.value) {
      return;
    }
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (!text.trim()) {
      return;
    }
    event.preventDefault();
    const refs = await loadEntryPasteRefs();
    const pasteResult = parseEntryClipboard(text, refs);
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
      fetchListRows("warehouse-master-list", { keyword: "", status: "", page: 1, pageSize: 1000 })
    ]);
    return {
      products: mergeMasterOptions(productResult.ok && productResult.data ? productResult.data.rows.map(masterRowToOption) : [], knownProductOptions),
      warehouses: mergeMasterOptions(warehouseResult.ok && warehouseResult.data ? warehouseResult.data.rows.map(masterRowToOption) : [], knownWarehouseOptions)
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
    options.markDirty();
    void focusLineCell(startIndex + pastedLines.length - 1, "qty");
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

  function selectEntryPasteCandidate(lineIndex: number, code: string) {
    const pending = pendingEntryPaste.value;
    const conflict = pending?.conflicts.find((item) => item.lineIndex === lineIndex);
    const candidate = conflict?.candidates.find((item) => item.code === code);
    const line = pending?.lines[lineIndex];
    if (!conflict || !candidate || !line) {
      return;
    }
    conflict.selectedCode = code;
    conflict.activeIndex = Math.max(0, conflict.candidates.findIndex((item) => item.code === code));
    line.productCode = candidate.code;
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

  function moveEntryPasteCandidate(delta: number) {
    const conflict = activeEntryPasteConflict(pendingEntryPaste.value);
    if (!conflict || conflict.candidates.length === 0) {
      return;
    }
    moveEntryPasteCandidateForConflict(conflict, delta);
  }

  function chooseActiveEntryPasteCandidate() {
    const conflict = activeEntryPasteConflict(pendingEntryPaste.value);
    if (!conflict || conflict.candidates.length === 0) {
      return;
    }
    const candidate = conflict.candidates[Math.min(Math.max(conflict.activeIndex ?? 0, 0), conflict.candidates.length - 1)];
    if (!candidate) {
      return;
    }
    selectEntryPasteCandidate(conflict.lineIndex, candidate.code);
    if (entryPasteConflictsResolved.value) {
      confirmPendingEntryPaste();
    }
  }

  function handleLineCellKeydown(event: KeyboardEvent, lineIndex: number, cell: "product" | "warehouse" | "qty" | "price", selectorId = "") {
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
        void focusLineCell(lineIndex, "price");
      } else if (cell === "price") {
        insertLineAfter(lineIndex);
      } else {
        void focusLineCell(Math.min(lineIndex + 1, form.lines.length - 1), cell);
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      void focusLineCell(Math.min(lineIndex + 1, form.lines.length - 1), cell);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      void focusLineCell(Math.max(lineIndex - 1, 0), cell);
    }
  }

  async function searchMasterOptions(type: string, keywordValue: string, selectorId: string) {
    activeSelector.value = selectorId;
    selectorOptions.value = [];
    selectorCursorIndex.value = 0;
    const requestSeq = selectorRequestSeq + 1;
    selectorRequestSeq = requestSeq;
    const listKeyByType: Record<string, string> = {
      customer: "customer-master-list",
      product: "product-master-list",
      warehouse: "warehouse-master-list"
    };
    const result = await fetchListRows(listKeyByType[type], { keyword: keywordValue, status: "", page: 1, pageSize: 20 });
    if (requestSeq !== selectorRequestSeq || activeSelector.value !== selectorId) {
      return;
    }
    if (!result.ok || !result.data) {
      selectorOptions.value = [];
      return;
    }
    selectorOptions.value = result.data.rows.map(masterRowToOption);
    selectorCursorIndex.value = selectorOptions.value.length > 0 ? 0 : -1;
  }

  function handleMasterInput(type: string, keywordValue: string, selectorId: string) {
    options.markDirty();
    void searchMasterOptions(type, keywordValue, selectorId);
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
    } else if (selectorId.endsWith("-warehouse")) {
      selectWarehouseOption(option, lineIndexFromSelector(selectorId), selectorId);
    }
  }

  function selectPartyOption(option: MasterOption, selectorId = "sales-out-party") {
    form.partyCode = option.code;
    activeSelector.value = "";
    options.markDirty();
    focusNextAfterSelector(selectorId);
  }

  function selectWarehouseOption(option: MasterOption, lineIndex = 0, selectorId = selectorIdForLine(lineIndex, "warehouse")) {
    const line = form.lines[lineIndex];
    if (!line) {
      return;
    }
    line.warehouseCode = option.code;
    activeSelector.value = "";
    options.markDirty();
    focusNextAfterSelector(selectorId);
  }

  function selectLineProduct(option: MasterOption, lineIndex = 0, selectorId = selectorIdForLine(lineIndex, "product")) {
    const line = form.lines[lineIndex];
    if (!line) {
      return;
    }
    line.productCode = option.code;
    line.productName = option.name;
    line.spec = option.spec ?? "";
    activeSelector.value = "";
    options.markDirty();
    focusNextAfterSelector(selectorId);
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
      if (!line) {
        return;
      }
      const reasonText = `零值原因：${warning.reason}（${warning.reasons.join("、")}）`;
      line.lineRemark = mergeLineRemark(line.lineRemark, reasonText);
    });
    pendingZeroEntrySave.value = null;
    await save(true);
  }

  return {
    form,
    message,
    batchWarehouseCode,
    activeSelector,
    selectorOptions,
    selectorCursorIndex,
    draggingLineIndex,
    pendingZeroEntrySave,
    downstreamTrace,
    pendingRiskyDocumentAction,
    pendingEntryPaste,
    highlightedSourceBillNo,
    highlightedSourceLineNo,
    isDraft,
    canAudit,
    canReverse,
    canVoid,
    canDelete,
    canTraceSourceOrder,
    statusLabel,
    totalAmount,
    showSourceLineColumn,
    entryTableColspan,
    entryTotalColspan,
    redReverseBillNo,
    riskyActionTitle,
    riskyActionSummary,
    riskyActionImpact,
    riskyActionVerb,
    entryPasteConflictsResolved,
    startNew,
    loadByBillNo,
    applyDetail,
    applyPushDownDraft,
    save,
    audit,
    openRiskyAction,
    cancelRiskyAction,
    confirmRiskyAction,
    voidCurrent,
    exportCurrent,
    printCurrent,
    openRedReverseBill,
    openRedSourceBill,
    traceSourceOrder,
    openDownstreamTrace,
    openDownstreamDocument,
    addLine,
    insertLineAfter,
    copyLine,
    removeLine,
    handleLineDragStart,
    handleLineDragOver,
    handleLineDrop,
    applyBatchWarehouse,
    handleEntryPaste,
    cancelPendingEntryPaste,
    confirmPendingEntryPaste,
    selectEntryPasteCandidate,
    isEntryPasteCandidateActive,
    handleEntryPasteConflictKeydown,
    handleLineCellKeydown,
    searchMasterOptions,
    handleMasterInput,
    handleSelectorKeydown,
    selectPartyOption,
    selectWarehouseOption,
    selectLineProduct,
    cancelZeroEntrySave,
    confirmZeroEntrySave,
    zeroReasonOptions,
    formatQty,
    formatAmount,
    backendStatusLabel,
    downstreamTypeLabel,
    downstreamReverseImpact,
    downstreamRedReverseImpact,
    downstreamDocTestId,
    entryPasteCandidateTestId,
    zeroReasonTestId,
    markDirty: options.markDirty
  };
}

function normalizeDownstreamDocs(docs: DownstreamDocumentRef[] | undefined) {
  if (!Array.isArray(docs)) {
    return [];
  }
  return docs.map((doc) => ({
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
  })).filter((doc) => doc.billNo && doc.type);
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
    salesOrder: "销售订单",
    salesOut: "销售出库单",
    purchaseOrder: "采购订单",
    purchaseIn: "采购入库单",
    materialIssue: "生产领料单",
    productIn: "产品入库单",
    otherStockIn: "其他入库单",
    otherStockOut: "其他出库单",
    stockTransfer: "调拨单"
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
    return `红冲将生成负数采购入库单，并回退源采购订单已入库数量 ${qty}。`;
  }
  return `红冲将生成负数销售出库单，并回退源销售订单已出库数量 ${qty}。`;
}

function lineLineNo(line: OrderLineForm, index: number) {
  return line.lineNo ?? index + 1;
}

function normalizedQty(value: number | string | undefined) {
  const qty = Number(value ?? 0);
  return Number.isFinite(qty) ? qty : 0;
}

function normalizedOptionalInt(value: number | string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nextBillNoFor(prefix: string) {
  const now = new Date();
  const datePart = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("");
  const timePart = [
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
    String(now.getMilliseconds()).padStart(3, "0")
  ].join("");
  const seq = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `${prefix}-${datePart}-${timePart}-${seq}`;
}

function toDocumentLines(lines: OrderLineForm[]) {
  return lines.map((line) => ({
    productCode: line.productCode,
    warehouseCode: line.warehouseCode,
    sourceLineNo: line.sourceLineNo,
    qty: Number(line.qty || 0),
    unitPrice: Number(line.unitPrice || 0),
    lineRemark: String(line.lineRemark ?? "").trim()
  }));
}

function prepareEntryLinesForSave(lines: OrderLineForm[]): ({ ok: true } & PreparedEntryLines) | { ok: false; message: string } {
  const nonBlankLines = lines.map((line, index) => ({ line, index })).filter(({ line }) => !isBlankEntryLine(line));
  if (nonBlankLines.length === 0) {
    return { ok: false, message: "至少保留一行有效分录。" };
  }
  const missingProduct = nonBlankLines.find(({ line }) => !entryLineProductCode(line));
  if (missingProduct) {
    return { ok: false, message: `第 ${missingProduct.index + 1} 行商品编码不能为空。` };
  }
  const seen = new Map<string, number>();
  for (const { line, index } of nonBlankLines) {
    const key = `${entryLineProductCode(line)}@@${entryLineWarehouseCode(line)}`;
    const firstIndex = seen.get(key);
    if (firstIndex !== undefined) {
      return { ok: false, message: `第 ${index + 1} 行与第 ${firstIndex + 1} 行商品和仓库重复，请合并后再保存。` };
    }
    seen.set(key, index);
  }
  const formLines = nonBlankLines.map(({ line }) => line);
  return { ok: true, formLines, documentLines: toDocumentLines(formLines), removedBlankCount: lines.length - formLines.length };
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

function zeroEntryWarnings(lines: OrderLineForm[]): ZeroEntryWarning[] {
  return lines.map((line, index) => {
    const qty = normalizedQty(line.qty);
    const unitPrice = normalizedQty(line.unitPrice);
    const reasons = [qty === 0 ? "数量为 0" : "", unitPrice === 0 ? "单价为 0" : ""].filter(Boolean);
    return {
      lineNo: index + 1,
      productCode: entryLineProductCode(line),
      warehouseCode: entryLineWarehouseCode(line),
      qty,
      unitPrice,
      reasons,
      reason: zeroReasonOptions[0]
    };
  }).filter((warning) => warning.reasons.length > 0);
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

function masterRowToOption(row: Record<string, unknown>): MasterOption {
  return {
    code: String(row.code ?? ""),
    name: String(row.name ?? ""),
    spec: row.spec ? String(row.spec) : "",
    unit: row.unit ? String(row.unit) : ""
  };
}

function mergeMasterOptions(primary: MasterOption[], fallback: MasterOption[]) {
  const byCode = new Map<string, MasterOption>();
  [...fallback, ...primary].forEach((option) => {
    if (option.code) {
      byCode.set(option.code, option);
    }
  });
  return Array.from(byCode.values());
}

function parseEntryClipboard(text: string, refs: EntryPasteRefs): { lines: OrderLineForm[]; conflicts: EntryPasteConflict[] } {
  const rows = text.split(/\r?\n/).map((row) => row.trim()).filter(Boolean).map((row) => row.split(/\t|,|;/).map((cell) => cell.trim())).filter((cells) => cells.some(Boolean));
  if (rows.length === 0) {
    return { lines: [], conflicts: [] };
  }
  const header = detectEntryPasteHeader(rows[0]);
  const dataRows = header ? rows.slice(1) : rows;
  const lines: OrderLineForm[] = [];
  const conflicts: EntryPasteConflict[] = [];
  dataRows.forEach((cells) => {
    const parsed = parseEntryPasteRow(cells, refs, header, lines.length);
    if (parsed) {
      lines.push(parsed.line);
      if (parsed.conflict) {
        conflicts.push(parsed.conflict);
      }
    }
  });
  return { lines, conflicts };
}

function parseEntryPasteRow(cells: string[], refs: EntryPasteRefs, header: Record<string, number> | null, lineIndex: number): { line: OrderLineForm; conflict?: EntryPasteConflict } | null {
  const productToken = cellByHeader(cells, header, "productCode", header ? -1 : 0);
  const productName = cellByHeader(cells, header, "productName", header ? -1 : 0);
  const productSpec = cellByHeader(cells, header, "spec", -1);
  const warehouseToken = cellByHeader(cells, header, "warehouseCode", header ? -1 : 1);
  const warehouseName = cellByHeader(cells, header, "warehouseName", -1);
  const qtyText = cellByHeader(cells, header, "qty", header ? -1 : 2);
  const priceText = cellByHeader(cells, header, "unitPrice", header ? -1 : 3);
  const productMatch = matchProduct(productToken, productName, productSpec, refs.products);
  if (!productMatch.product && !productToken && productMatch.candidates.length === 0) {
    return null;
  }
  const matchedWarehouse = matchMasterOption(warehouseToken || warehouseName, refs.warehouses);
  const line: OrderLineForm = {
    productCode: productMatch.product?.code ?? productToken,
    productName: productMatch.product?.name,
    spec: productMatch.product?.spec ?? productSpec,
    warehouseCode: matchedWarehouse?.code ?? (warehouseToken || "CK-001"),
    qty: normalizedPositiveNumber(qtyText, 1),
    unitPrice: normalizedPositiveNumber(priceText, 86),
    lineRemark: ""
  };
  if (productMatch.candidates.length > 0) {
    return { line, conflict: { lineIndex, productText: [productName || productToken, productSpec].filter(Boolean).join(" / "), candidates: productMatch.candidates, activeIndex: 0 } };
  }
  return { line };
}

function detectEntryPasteHeader(cells: string[]) {
  const header: Record<string, number> = {};
  cells.forEach((cell, index) => {
    const field = headerFieldName(cell);
    if (field && header[field] === undefined) {
      header[field] = index;
    }
  });
  return Object.keys(header).length >= 2 && (header.productCode !== undefined || header.productName !== undefined) ? header : null;
}

function headerFieldName(cell: string) {
  const key = normalizePasteText(cell);
  const aliases: Record<string, string> = {
    productcode: "productCode",
    productno: "productCode",
    product: "productCode",
    code: "productCode",
    商品编码: "productCode",
    商品代码: "productCode",
    商品编号: "productCode",
    物料编码: "productCode",
    编码: "productCode",
    商品名称: "productName",
    商品名: "productName",
    名称: "productName",
    物料名称: "productName",
    规格型号: "spec",
    规格: "spec",
    型号: "spec",
    spec: "spec",
    仓库编码: "warehouseCode",
    仓库代码: "warehouseCode",
    仓库编号: "warehouseCode",
    warehousecode: "warehouseCode",
    仓库: "warehouseName",
    仓库名称: "warehouseName",
    数量: "qty",
    qty: "qty",
    quantity: "qty",
    单价: "unitPrice",
    价格: "unitPrice",
    unitprice: "unitPrice",
    price: "unitPrice"
  };
  return aliases[key] ?? "";
}

function cellByHeader(cells: string[], header: Record<string, number> | null, field: string, fallbackIndex: number) {
  if (header && header[field] !== undefined) {
    return cells[header[field]]?.trim() ?? "";
  }
  return fallbackIndex >= 0 ? cells[fallbackIndex]?.trim() ?? "" : "";
}

function matchProduct(productToken: string, productName: string, productSpec: string, products: MasterOption[]): { product?: MasterOption; candidates: MasterOption[] } {
  const exactByCode = matchMasterOptionCode(productToken, products);
  if (exactByCode) {
    return { product: exactByCode, candidates: [] };
  }
  const normalizedName = normalizePasteText(productName || productToken);
  const normalizedSpec = normalizePasteText(productSpec);
  if (!normalizedName) {
    return { candidates: [] };
  }
  const sameName = products.filter((option) => normalizePasteText(option.name) === normalizedName);
  const exactNameAndSpec = sameName.filter((option) => normalizePasteText(option.spec ?? "") === normalizedSpec);
  if (normalizedSpec && exactNameAndSpec.length === 1) {
    return { product: exactNameAndSpec[0], candidates: [] };
  }
  if (sameName.length === 1 && (!normalizedSpec || exactNameAndSpec.length === 1)) {
    return { product: sameName[0], candidates: [] };
  }
  if (sameName.length > 1) {
    return { candidates: exactNameAndSpec.length > 1 ? exactNameAndSpec : sameName };
  }
  return { candidates: [] };
}

function matchMasterOption(token: string, options: MasterOption[]) {
  const normalized = normalizePasteText(token);
  if (!normalized) {
    return undefined;
  }
  return matchMasterOptionCode(token, options) ?? options.find((option) => normalizePasteText(option.name) === normalized);
}

function matchMasterOptionCode(token: string, options: MasterOption[]) {
  const normalized = normalizePasteText(token);
  if (!normalized) {
    return undefined;
  }
  return options.find((option) => normalizePasteText(option.code) === normalized);
}

function normalizePasteText(value: string | undefined) {
  return String(value ?? "").replace(/原材料/g, "原料").replace(/\s+/g, "").replace(/[（）()【】[\]]/g, "").replace(/[/_.-]/g, "").toLowerCase();
}

function normalizedPositiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function activeEntryPasteConflict(pending: PendingEntryPaste | null) {
  if (!pending) {
    return undefined;
  }
  return pending.conflicts.find((conflict) => !conflict.selectedCode) ?? pending.conflicts[0];
}

function moveEntryPasteCandidateForConflict(conflict: EntryPasteConflict, delta: number) {
  const maxIndex = conflict.candidates.length - 1;
  const currentIndex = Math.min(Math.max(conflict.activeIndex ?? 0, 0), maxIndex);
  conflict.activeIndex = Math.min(Math.max(currentIndex + delta, 0), maxIndex);
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

function selectorIdForLine(lineIndex: number, field: "product" | "warehouse") {
  return `sales-out-line-${lineIndex}-${field}`;
}

async function focusFormField(testId: string) {
  await nextTick();
  const input = document.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
  input?.focus();
  input?.select();
}

async function focusLineCell(lineIndex: number, cell: "product" | "warehouse" | "qty" | "price") {
  await nextTick();
  const suffix = lineIndex === 0 ? "" : `-${lineIndex + 1}`;
  const testId = cell === "product"
    ? `sales-out-line-product${suffix}`
    : cell === "warehouse"
    ? `sales-out-line-warehouse${suffix}`
    : cell === "qty"
    ? `sales-out-line-qty${suffix}`
    : `sales-out-line-price${suffix}`;
  const input = document.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
  input?.focus();
  input?.select();
}

function focusNextAfterSelector(selectorId: string) {
  if (selectorId.endsWith("-party")) {
    void focusFormField("sales-out-bill-date");
    return;
  }
  const lineIndex = lineIndexFromSelector(selectorId);
  if (selectorId.endsWith("-product")) {
    void focusLineCell(lineIndex, "warehouse");
    return;
  }
  if (selectorId.endsWith("-warehouse")) {
    void focusLineCell(lineIndex, "qty");
  }
}

function lineIndexFromSelector(selectorId: string) {
  const match = selectorId.match(/-line-(\d+)-/);
  return match ? Number(match[1]) : 0;
}

async function scrollHighlightedSourceLineIntoView(sourceLineNo: number) {
  await nextTick();
  const target = document.querySelector<HTMLElement>(`.entry-table tr[data-line-no="${sourceLineNo}"]`);
  target?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function downstreamDocTestId(index: number) {
  return index === 0 ? "downstream-doc-open" : `downstream-doc-open-${index + 1}`;
}

function entryPasteCandidateTestId(lineIndex: number, code: string) {
  return `entry-paste-candidate-${lineIndex + 1}-${code}`;
}

function zeroReasonTestId(lineNo: number) {
  return lineNo === 1 ? "entry-zero-reason" : `entry-zero-reason-${lineNo}`;
}
