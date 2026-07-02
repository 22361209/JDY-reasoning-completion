import { fetchListRows, type ListQuery } from "./listApi";

export type SourceSelectorColumnFilters = Record<string, { operator: string; value: string }>;

export interface SourceSelectorListQueryOptions {
  listKey: string;
  keyword?: string;
  fixedFilters?: SourceSelectorColumnFilters;
  columnFilters?: SourceSelectorColumnFilters;
  pageSize?: number;
}

export async function fetchSourceSelectorRows(options: SourceSelectorListQueryOptions) {
  const pageSize = options.pageSize ?? 1000;
  const query: ListQuery = {
    keyword: options.keyword ?? "",
    page: 1,
    pageSize,
    view: "detail",
    columnFilters: {
      ...(options.columnFilters ?? {}),
      ...(options.fixedFilters ?? {})
    }
  };
  const result = await fetchListRows(options.listKey, query);
  if (!result.ok) {
    return {
      ok: result.ok,
      message: result.message,
      rows: [],
      total: 0
    };
  }
  const rows = [...(result.data?.rows ?? [])];
  const total = result.data?.total ?? rows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  for (let page = 2; page <= pageCount; page += 1) {
    const next = await fetchListRows(options.listKey, { ...query, page });
    if (!next.ok) {
      return {
        ok: false,
        message: next.message,
        rows: [],
        total: 0
      };
    }
    rows.push(...(next.data?.rows ?? []));
  }
  return {
    ok: true,
    message: result.message,
    rows,
    total
  };
}

export function exactSourceFilter(field: string, value: string): SourceSelectorColumnFilters {
  return value.trim() ? { [field]: { operator: "等于", value: value.trim() } } : {};
}
