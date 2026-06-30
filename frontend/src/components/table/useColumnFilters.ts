import { reactive, ref } from "vue";

export interface TableColumnFilter {
  operator: string;
  value: string;
}

export interface FilterableColumn {
  key: string;
}

export const tableFilterOperators = ["包含", "不包含", "等于", "不等于", "以……开始", "以……结束", "为空", "不为空"];

export function useColumnFilters<TColumn extends FilterableColumn>(valueGetter: (row: unknown, rowIndex: number, columnKey: string) => string) {
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
    activeFilterOperator.value = columnFilters[column.key]?.operator ?? "包含";
    activeFilterValue.value = columnFilters[column.key]?.value ?? "";
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
      columnFilters[column.key] = { operator: activeFilterOperator.value, value };
    } else {
      delete columnFilters[column.key];
    }
    filterDialogOpen.value = false;
  }

  function clearColumnFilter() {
    if (activeFilterColumn.value) {
      delete columnFilters[activeFilterColumn.value.key];
    }
    activeFilterValue.value = "";
    filterDialogOpen.value = false;
  }

  function rowMatchesFilters(row: unknown, rowIndex: number) {
    return Object.entries(columnFilters).every(([key, filter]) => matchesColumnFilter(valueGetter(row, rowIndex, key), filter));
  }

  function isFilterActive(columnKey: string) {
    return Boolean(columnFilters[columnKey]);
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
    rowMatchesFilters,
    isFilterActive
  };
}

function matchesColumnFilter(rawValue: string, filter: TableColumnFilter) {
  const source = rawValue.trim().toLowerCase();
  const value = filter.value.trim().toLowerCase();
  switch (filter.operator) {
    case "不包含":
      return !source.includes(value);
    case "等于":
      return source === value;
    case "不等于":
      return source !== value;
    case "以……开始":
      return source.startsWith(value);
    case "以……结束":
      return source.endsWith(value);
    case "为空":
      return !source;
    case "不为空":
      return Boolean(source);
    case "包含":
    default:
      return source.includes(value);
  }
}
