import { onBeforeUnmount, watch } from "vue";
import { initialStockCountForm } from "../../../app/documentModel";
import type { OrderLineForm } from "../../../app/documentModel";
import { fetchStockCountBookQuantity } from "../../../services/documentApi";
import { useDocumentModule } from "../../documents/useDocumentModule";

export function useStockCountDocument(options: Parameters<typeof useDocumentModule>[1]) {
  const document = useDocumentModule({
    documentType: "stockCount",
    saveType: "stockCount",
    outputType: "stockCount",
    title: "盘点单",
    testPrefix: "stock-count",
    partyKind: "supplier",
    partyLabel: "盘点仓",
    auditPermission: "inventory.stock_count.audit",
    billPrefix: "PD",
    defaultDepartment: "仓储部",
    defaultPartyCode: "",
    defaultUnitPrice: 0,
    executionQtyLabel: "系统库存",
    remainingQtyLabel: "差异",
    reversible: true,
    initialForm: initialStockCountForm,
    riskySummaryTitle: "盘点单",
    redReverseImpact: "盘点单第一版不做红冲，差异调整通过下推盘盈/盘亏草稿处理。",
    reverseImpact: "盘点单本身不动库存，反审核只回滚盘点单状态。"
  }, options);

  const activeRequestByLine = new WeakMap<OrderLineForm, number>();
  const lastReferenceByLine = new WeakMap<OrderLineForm, string>();
  const pendingTimerByLine = new WeakMap<OrderLineForm, number>();
  const pendingTimers = new Set<number>();
  let displayedBookQuantityMessage = "";
  let disposed = false;

  function reconcileBookQuantityErrors() {
    const errors = document.form.lines
      .map((line) => String(line.stockCountBookQuantityError ?? "").trim())
      .filter(Boolean);
    if (errors.length > 0) {
      const nextMessage = errors.length === 1
        ? errors[0]
        : `${errors[0]}（另有 ${errors.length - 1} 行账面数量查询失败）`;
      displayedBookQuantityMessage = nextMessage;
      document.message.value = nextMessage;
      return;
    }
    if (displayedBookQuantityMessage && document.message.value === displayedBookQuantityMessage) {
      document.message.value = "";
    }
    displayedBookQuantityMessage = "";
  }

  function clearBookQuantityError(line: OrderLineForm) {
    line.stockCountBookQuantityError = undefined;
    reconcileBookQuantityErrors();
  }

  function updateDifference(line: OrderLineForm) {
    line.remainingQty = numericQty(line.qty) - numericQty(line.executedQty);
  }

  async function refreshBookQuantity(line: OrderLineForm, expectedReference = lineReference(line)) {
    if (disposed || !document.isDraft.value || !document.form.lines.includes(line) || lineReference(line) !== expectedReference) {
      return;
    }
    if (!line.productCode.trim() || !line.warehouseCode.trim()) {
      activeRequestByLine.set(line, (activeRequestByLine.get(line) ?? 0) + 1);
      line.stockCountBookQuantityPending = false;
      clearBookQuantityError(line);
      line.executedQty = 0;
      updateDifference(line);
      return;
    }
    const requestSeq = (activeRequestByLine.get(line) ?? 0) + 1;
    activeRequestByLine.set(line, requestSeq);
    const requestedProductCode = line.productCode.trim();
    const requestedWarehouseCode = line.warehouseCode.trim();
    const result = await fetchStockCountBookQuantity(
      undefined,
      requestedProductCode,
      requestedWarehouseCode
    );
    if (
      activeRequestByLine.get(line) !== requestSeq
      || disposed
      || !document.form.lines.includes(line)
      || line.productCode.trim() !== requestedProductCode
      || line.warehouseCode.trim() !== requestedWarehouseCode
    ) {
      return;
    }
    if (!result.ok || !result.data) {
      const message = result.message || "盘点账面数量查询失败。";
      line.stockCountBookQuantityPending = false;
      line.stockCountBookQuantityError = message;
      reconcileBookQuantityErrors();
      return;
    }
    line.stockCountBookQuantityPending = false;
    clearBookQuantityError(line);
    line.executedQty = numericQty(result.data.bookQuantity);
    updateDifference(line);
  }

  function scheduleBookQuantityRefresh(line: OrderLineForm) {
    clearLineTimer(line);
    activeRequestByLine.set(line, (activeRequestByLine.get(line) ?? 0) + 1);
    if (!document.isDraft.value) {
      line.stockCountBookQuantityPending = false;
      return;
    }
    clearBookQuantityError(line);
    if (!line.productCode.trim() || !line.warehouseCode.trim()) {
      line.stockCountBookQuantityPending = false;
      line.executedQty = 0;
      updateDifference(line);
      return;
    }
    line.stockCountBookQuantityPending = true;
    line.executedQty = 0;
    updateDifference(line);
    const expectedReference = lineReference(line);
    const timer = window.setTimeout(() => {
      pendingTimerByLine.delete(line);
      pendingTimers.delete(timer);
      void refreshBookQuantity(line, expectedReference);
    }, 120);
    pendingTimerByLine.set(line, timer);
    pendingTimers.add(timer);
  }

  function clearLineTimer(line: OrderLineForm) {
    const timer = pendingTimerByLine.get(line);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      pendingTimers.delete(timer);
      pendingTimerByLine.delete(line);
    }
  }

  watch(
    () => document.form.lines.map((line) => lineReference(line)),
    () => {
      document.form.lines.forEach((line) => {
        const reference = lineReference(line);
        const previousReference = lastReferenceByLine.get(line);
        if (previousReference === reference) {
          return;
        }
        lastReferenceByLine.set(line, reference);
        if (
          previousReference === undefined
          && line.lineNo !== undefined
          && line.stockCountBookQuantityPending !== true
        ) {
          return;
        }
        scheduleBookQuantityRefresh(line);
      });
      reconcileBookQuantityErrors();
    },
    { immediate: true }
  );

  watch(
    () => document.form.lines.map((line) => [line.qty, line.executedQty]),
    () => document.form.lines.forEach(updateDifference),
    { deep: true }
  );

  onBeforeUnmount(() => {
    disposed = true;
    pendingTimers.forEach((timer) => window.clearTimeout(timer));
    pendingTimers.clear();
  });

  return {
    ...document,
    refreshBookQuantity
  };
}

function lineReference(line: OrderLineForm) {
  return `${line.productId ?? ""}|${line.productCode.trim()}|${line.warehouseCode.trim()}`;
}

function numericQty(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
