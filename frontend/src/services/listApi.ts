export interface ListQuery {
  keyword: string;
  status: string;
  page: number;
  pageSize: number;
}

export interface ListResponse {
  page: number;
  pageSize: number;
  total: number;
  rows: Record<string, unknown>[];
}

export async function fetchListRows(listKey: string, query: ListQuery): Promise<ListResponse | null> {
  const search = new URLSearchParams({
    keyword: query.keyword,
    status: query.status,
    page: String(query.page),
    pageSize: String(query.pageSize)
  });
  const response = await fetch(`/api/lists/${encodeURIComponent(listKey)}?${search.toString()}`);
  if (!response.ok) {
    return null;
  }
  return response.json() as Promise<ListResponse>;
}
