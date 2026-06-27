import { computed, onBeforeUnmount, ref } from "vue";

export interface ColumnReorderMeta {
  fixed?: "" | "left" | "right";
  locked?: boolean;
  reorderable?: boolean;
  title?: string;
}

export interface ColumnReorderOptions<TColumn extends ColumnReorderMeta> {
  getColumns: () => TColumn[];
  setColumns: (columns: TColumn[]) => void;
  getKey: (column: TColumn) => string;
  getTitle?: (column: TColumn) => string;
  normalize?: (columns: TColumn[]) => TColumn[];
  canReorder?: (column: TColumn) => boolean;
  onReorder?: () => void;
  headerSelector?: string;
  blockedStartSelector?: string;
}

export function canReorderColumn(column: ColumnReorderMeta) {
  if (column.reorderable === false) {
    return false;
  }
  if (column.locked) {
    return false;
  }
  return true;
}

export function useColumnReorder<TColumn extends ColumnReorderMeta>(options: ColumnReorderOptions<TColumn>) {
  const draggingKey = ref("");
  const dragOverKey = ref("");
  const dragGhostLeft = ref(0);
  const dragGhostTop = ref(0);
  const headerSelector = options.headerSelector ?? ".table-core-header-cell";
  const blockedStartSelector = options.blockedStartSelector ?? "button,.table-core-column-resizer,.vxe-resizable";

  const draggingTitle = computed(() => {
    const column = options.getColumns().find((item) => options.getKey(item) === draggingKey.value);
    return column ? options.getTitle?.(column) ?? column.title ?? "" : "";
  });

  onBeforeUnmount(() => {
    cleanupListeners();
  });

  function isReorderable(column: TColumn) {
    return options.canReorder?.(column) ?? canReorderColumn(column);
  }

  function start(column: TColumn, event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (target.closest(blockedStartSelector) || !isReorderable(column)) {
      return;
    }
    event.preventDefault();
    draggingKey.value = options.getKey(column);
    dragOverKey.value = draggingKey.value;
    dragGhostLeft.value = event.clientX + 10;
    dragGhostTop.value = event.clientY + 10;
    window.addEventListener("mousemove", track);
    window.addEventListener("mouseup", finish, { once: true });
  }

  function track(event: MouseEvent) {
    if (!draggingKey.value) {
      return;
    }
    dragGhostLeft.value = event.clientX + 10;
    dragGhostTop.value = event.clientY + 10;
    const element = document.elementFromPoint(event.clientX, event.clientY);
    const header = element?.closest<HTMLElement>(headerSelector);
    const key = header?.dataset.columnField;
    const targetColumn = key ? options.getColumns().find((column) => options.getKey(column) === key) : undefined;
    if (targetColumn && isReorderable(targetColumn)) {
      dragOverKey.value = key ?? "";
    }
  }

  function finish() {
    const sourceKey = draggingKey.value;
    const targetKey = dragOverKey.value;
    if (!sourceKey || !targetKey || sourceKey === targetKey) {
      reset();
      return;
    }
    const columns = options.getColumns();
    const sourceIndex = columns.findIndex((column) => options.getKey(column) === sourceKey);
    const targetIndex = columns.findIndex((column) => options.getKey(column) === targetKey);
    const sourceColumn = columns[sourceIndex];
    const targetColumn = columns[targetIndex];
    if (sourceIndex < 0 || targetIndex < 0 || !sourceColumn || !targetColumn || !isReorderable(sourceColumn) || !isReorderable(targetColumn)) {
      reset();
      return;
    }
    const next = [...columns];
    const [movedColumn] = next.splice(sourceIndex, 1);
    if (!movedColumn) {
      reset();
      return;
    }
    next.splice(targetIndex, 0, movedColumn);
    options.setColumns(options.normalize ? options.normalize(next) : next);
    options.onReorder?.();
    reset();
  }

  function reset() {
    cleanupListeners();
    draggingKey.value = "";
    dragOverKey.value = "";
  }

  function cleanupListeners() {
    window.removeEventListener("mousemove", track);
    window.removeEventListener("mouseup", finish);
  }

  return {
    draggingKey,
    dragOverKey,
    dragGhostLeft,
    dragGhostTop,
    draggingTitle,
    isReorderable,
    start,
    reset
  };
}
