import { reactive, ref } from "vue";
import type { TableColumnFilter } from "./useColumnFilters";

export interface ListFilterColumn {
  field: string;
}

export function useListColumnFilters<TColumn extends ListFilterColumn>(afterFilterChange: () => void) {
  const columnFilters = reactive<Record<string, TableColumnFilter>>({});
  const activeFilterColumn = ref<TColumn | null>(null);
  const filterDialogOpen = ref(false);
  const activeFilterOperator = ref("包含");
  const activeFilterValue = ref("");
  const filterPopoverLeft = ref(0);
  const filterPopoverTop = ref(0);

  function openColumnFilter(column: TColumn, event: MouseEvent) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    activeFilterColumn.value = column;
    activeFilterOperator.value = columnFilters[column.field]?.operator ?? "包含";
    activeFilterValue.value = columnFilters[column.field]?.value ?? "";
    filterPopoverLeft.value = Math.min(rect.right - 136, window.innerWidth - 150);
    filterPopoverTop.value = Math.min(rect.bottom + 4, window.innerHeight - 260);
    filterDialogOpen.value = true;
  }

  function applyColumnFilter() {
    const column = activeFilterColumn.value;
    if (!column) {
      return;
    }
    const value = activeFilterValue.value.trim();
    if (value || ["为空", "不为空"].includes(activeFilterOperator.value)) {
      columnFilters[column.field] = { operator: activeFilterOperator.value, value };
    } else {
      delete columnFilters[column.field];
    }
    filterDialogOpen.value = false;
    afterFilterChange();
  }

  function clearColumnFilter() {
    if (activeFilterColumn.value) {
      delete columnFilters[activeFilterColumn.value.field];
    }
    activeFilterValue.value = "";
    filterDialogOpen.value = false;
    afterFilterChange();
  }

  function snapshotColumnFilters() {
    return Object.fromEntries(Object.entries(columnFilters).map(([field, filter]) => [field, { ...filter }]));
  }

  function replaceColumnFilters(nextFilters: Record<string, TableColumnFilter>) {
    Object.keys(columnFilters).forEach((field) => delete columnFilters[field]);
    Object.entries(nextFilters).forEach(([field, filter]) => {
      columnFilters[field] = { ...filter };
    });
  }

  function isFilterActive(field: string) {
    const filter = columnFilters[field];
    return Boolean(filter?.value) || ["为空", "不为空"].includes(filter?.operator ?? "");
  }

  return {
    columnFilters,
    activeFilterColumn,
    filterDialogOpen,
    activeFilterOperator,
    activeFilterValue,
    filterPopoverLeft,
    filterPopoverTop,
    openColumnFilter,
    applyColumnFilter,
    clearColumnFilter,
    snapshotColumnFilters,
    replaceColumnFilters,
    isFilterActive
  };
}
