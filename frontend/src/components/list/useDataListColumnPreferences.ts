import type { ListColumn } from "./useDataListDefinition";

export function mergeSavedColumnsWithDefaults(restored: ListColumn[], defaults: ListColumn[]) {
  const restoredFields = new Set(restored.map((column) => column.field));
  const defaultIndexByField = new Map(defaults.map((column, index) => [column.field, index]));
  const merged = [...restored];
  defaults.forEach((defaultColumn, defaultIndex) => {
    if (restoredFields.has(defaultColumn.field)) {
      return;
    }
    let insertAt = -1;
    for (let index = merged.length - 1; index >= 0; index -= 1) {
      const currentDefaultIndex = defaultIndexByField.get(merged[index].field);
      if (currentDefaultIndex != null && currentDefaultIndex < defaultIndex) {
        insertAt = index + 1;
        break;
      }
    }
    if (insertAt === -1) {
      const nextDefaultIndex = merged.findIndex((column) => {
        const currentDefaultIndex = defaultIndexByField.get(column.field);
        return currentDefaultIndex != null && currentDefaultIndex > defaultIndex;
      });
      insertAt = nextDefaultIndex === -1 ? merged.length : nextDefaultIndex;
    }
    merged.splice(insertAt, 0, defaultColumn);
    restoredFields.add(defaultColumn.field);
  });
  return merged;
}

export function loadColumnPreferences(key: string): ListColumn[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as ListColumn[] : [];
  } catch {
    return [];
  }
}

export function saveColumnPreferences(key: string, columns: ListColumn[]) {
  const preference = columns.map((column) => ({
    field: column.field,
    width: column.width,
    reorderable: column.reorderable,
    locked: column.locked,
    visible: column.visible
  }));
  localStorage.setItem(key, JSON.stringify(preference));
}

export function isValidColumnPreference(saved: ListColumn[], defaults: ListColumn[]) {
  const defaultFields = new Set(defaults.map((column) => column.field));
  const defaultVisibleCount = defaults.filter((column) => column.visible).length;
  const matched = saved.filter((column) => defaultFields.has(column.field));
  const visibleMatched = matched.filter((column) => column.visible !== false);
  if (!matched.length) {
    return false;
  }
  if (defaultVisibleCount >= 3 && visibleMatched.length <= 1) {
    return false;
  }
  return true;
}

export function normalizeListColumns(nextColumns: ListColumn[]) {
  return nextColumns.map((column) => ({
    ...column,
    fixed: "" as const
  }));
}
