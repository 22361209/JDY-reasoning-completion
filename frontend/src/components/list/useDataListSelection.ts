import { computed, ref, type Ref } from "vue";

export type ListRow = Record<string, unknown>;

export function rowKey(row: ListRow) {
  return String(row.id ?? row.billNo ?? row.bill_no ?? JSON.stringify(row));
}

export function useDataListSelection(displayedRows: Ref<ListRow[]>) {
  const selectedRows = ref<ListRow[]>([]);

  const allDisplayedRowsSelected = computed(() => (
    displayedRows.value.length > 0 &&
    displayedRows.value.every((row) => isRowSelected(row))
  ));

  function isRowSelected(row: ListRow) {
    const key = rowKey(row);
    return selectedRows.value.some((selected) => rowKey(selected) === key);
  }

  function toggleRowSelection(row: ListRow, checked: boolean) {
    const key = rowKey(row);
    selectedRows.value = checked
      ? [...selectedRows.value.filter((selected) => rowKey(selected) !== key), row]
      : selectedRows.value.filter((selected) => rowKey(selected) !== key);
  }

  function toggleAllDisplayedRows(checked: boolean) {
    selectedRows.value = checked ? [...displayedRows.value] : [];
  }

  return {
    selectedRows,
    allDisplayedRowsSelected,
    rowKey,
    isRowSelected,
    toggleRowSelection,
    toggleAllDisplayedRows
  };
}
