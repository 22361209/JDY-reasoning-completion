import { computed, reactive, ref, shallowRef } from "vue";
import type { SourceSelectorQueryChange, SourceSelectorSummaryItem } from "../components/SourceSelectorDialog.vue";

export interface SourceSelectorFetchResult<T> {
  ok: boolean;
  message: string;
  data: T[];
}

export interface SourceSelectorLifecycleOptions<T extends object> {
  rowKey: (row: T) => string;
  fetchRows: (query: SourceSelectorQueryChange) => Promise<SourceSelectorFetchResult<T>>;
  quantityField?: keyof T & string;
  countLabel?: (count: number) => string;
  quantityLabel?: string;
  selectedQuantityLabel?: string;
  emptyMessage: string;
  loadErrorMessage: string;
  formatQty: (value: number | string | undefined) => string;
  allocatedQty?: (row: T) => number;
  extraSummaryItems?: (visibleRows: T[], selectedRows: T[]) => SourceSelectorSummaryItem[];
  selectionMode?: "multiple" | "single";
}

export function useSourceSelectorLifecycle<T extends object>(options: SourceSelectorLifecycleOptions<T>) {
  const open = ref(false);
  const loading = ref(false);
  const message = ref("");
  const keyword = ref("");
  const rawRows = shallowRef<T[]>([]);
  const selected = reactive<Record<string, boolean>>({});
  const selectedRows = reactive<Record<string, T>>({});
  let requestSeq = 0;

  const rows = computed<T[]>(() => rawRows.value.map(adjustRowAvailability).filter((row) => {
    if (!options.quantityField) {
      return true;
    }
    const key = options.rowKey(row);
    return Boolean(selected[key]) || numberValue(fieldValue(row, options.quantityField)) > 0;
  }));

  const selectedRowList = computed<T[]>(() => Object.values(selectedRows));
  const countLabel = computed(() => {
    const count = selectedRowList.value.length;
    return options.countLabel ? options.countLabel(count) : `${count} 行已选`;
  });
  const summaryItems = computed<SourceSelectorSummaryItem[]>(() => {
    const visibleRows = rows.value;
    const selectedItems = selectedRowList.value;
    const items: SourceSelectorSummaryItem[] = [
      { key: "visibleRows", label: "当前明细", value: `${visibleRows.length} 行`, strong: true },
      { key: "selectedRows", label: "已选", value: `${selectedItems.length} 行`, strong: true }
    ];
    if (options.quantityField) {
      items.push(
        { key: "quantity", label: options.quantityLabel ?? "剩余数量合计", value: options.formatQty(sumField(visibleRows, options.quantityField)) },
        { key: "selectedQty", label: options.selectedQuantityLabel ?? "已选数量", value: options.formatQty(sumField(selectedItems, options.quantityField)) }
      );
    }
    return [...items, ...(options.extraSummaryItems?.(visibleRows, selectedItems) ?? [])];
  });

  async function openAndLoad(query: SourceSelectorQueryChange = { keyword: "", columnFilters: {} }) {
    keyword.value = query.keyword;
    message.value = "";
    clearSelection();
    open.value = true;
    return load(query);
  }

  async function load(query: SourceSelectorQueryChange) {
    const currentRequestSeq = requestSeq + 1;
    requestSeq = currentRequestSeq;
    keyword.value = query.keyword;
    loading.value = true;
    const result = await options.fetchRows(query);
    if (currentRequestSeq !== requestSeq) {
      return false;
    }
    loading.value = false;
    if (!result.ok) {
      rawRows.value = [];
      message.value = result.message || options.loadErrorMessage;
      return false;
    }
    rawRows.value = result.data;
    message.value = rows.value.length ? "" : options.emptyMessage;
    return true;
  }

  function close() {
    requestSeq += 1;
    loading.value = false;
    open.value = false;
    message.value = "";
  }

  function clearSelection() {
    Object.keys(selected).forEach((key) => delete selected[key]);
    Object.keys(selectedRows).forEach((key) => delete selectedRows[key]);
  }

  function toggleRow(row: unknown, checked: boolean) {
    const typedRow = row as T;
    const key = options.rowKey(typedRow);
    if (checked) {
      if (options.selectionMode === "single") {
        clearSelection();
      }
      selected[key] = true;
      selectedRows[key] = typedRow;
      return;
    }
    delete selected[key];
    delete selectedRows[key];
  }

  function selectAll(checked: boolean, candidateRows: unknown[]) {
    if (!checked) {
      clearSelection();
      return;
    }
    candidateRows.forEach((row) => toggleRow(row, true));
  }

  function setMessage(nextMessage: string) {
    message.value = nextMessage;
  }

  function commitLocalAllocation() {
    clearSelection();
    rawRows.value = rawRows.value.map((row) => ({ ...row } as T));
    message.value = rows.value.length ? "" : options.emptyMessage;
  }

  function adjustRowAvailability(row: T) {
    if (!options.quantityField) {
      return row;
    }
    const officialAvailable = numberValue(fieldValue(row, options.quantityField));
    const documentAllocated = Math.max(0, options.allocatedQty?.(row) ?? 0);
    const available = Math.max(0, officialAvailable - documentAllocated);
    return { ...row, [options.quantityField]: available } as T;
  }

  return {
    open,
    loading,
    message,
    keyword,
    rows,
    selected,
    selectedRows,
    selectedRowList,
    countLabel,
    summaryItems,
    openAndLoad,
    load,
    close,
    clearSelection,
    toggleRow,
    selectAll,
    setMessage,
    commitLocalAllocation
  };
}

export function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sumField<T extends object>(rows: T[], field: keyof T & string) {
  return rows.reduce((sum, row) => sum + numberValue(fieldValue(row, field)), 0);
}

function fieldValue<T extends object>(row: T, field: keyof T & string) {
  return (row as Record<string, unknown>)[field];
}
