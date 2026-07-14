import { computed, onBeforeUnmount, reactive, ref } from "vue";
import { exportReportRows, fetchReportRows } from "../../services/reportApi";
import type {
  ReportDefinition,
  ReportErrorKind,
  ReportQueryParameters,
  ReportQueryResponse,
  ReportScalar
} from "../../modules/reports/reportTypes";

export function useReportQuery(definition: ReportDefinition) {
  const initialDates = currentMonthDates();
  const filters = reactive<Record<string, string>>(emptyFilters(definition));
  const dateFrom = ref(initialDates.dateFrom);
  const dateTo = ref(initialDates.dateTo);
  const keyword = ref("");
  const response = ref<ReportQueryResponse | null>(null);
  const loading = ref(false);
  const exporting = ref(false);
  const errorKind = ref<ReportErrorKind | "">("");
  const errorMessage = ref("");
  const exportMessage = ref("");
  const appliedQuery = ref<ReportQueryParameters>({
    dateFrom: initialDates.dateFrom,
    dateTo: initialDates.dateTo,
    page: 1,
    pageSize: 100,
    sortField: definition.defaultSortField,
    sortOrder: definition.defaultSortOrder
  });
  let queryController: AbortController | null = null;
  let exportController: AbortController | null = null;
  let querySerial = 0;
  let exportSerial = 0;

  const rows = computed(() => response.value?.rows ?? []);
  const totals = computed(() => response.value?.totals ?? []);
  const normalizedQuery = computed(() => response.value?.query ?? {});
  const page = computed(() => response.value?.page ?? appliedQuery.value.page);
  const pageSize = computed(() => response.value?.pageSize ?? appliedQuery.value.pageSize);
  const total = computed(() => response.value?.total ?? 0);
  const generatedAt = computed(() => response.value?.generatedAt ?? "");
  const hasLoaded = computed(() => response.value !== null);

  onBeforeUnmount(() => {
    invalidateRequests();
  });

  async function loadInitial() {
    appliedQuery.value = queryFromDraft(1, 100);
    await loadAppliedQuery();
  }

  async function query() {
    appliedQuery.value = queryFromDraft(1, pageSize.value);
    await loadAppliedQuery();
  }

  async function reset() {
    const dates = currentMonthDates();
    dateFrom.value = dates.dateFrom;
    dateTo.value = dates.dateTo;
    keyword.value = "";
    for (const filter of definition.filters) {
      filters[filter.parameter] = filter.defaultValue ?? "";
    }
    appliedQuery.value = queryFromDraft(1, pageSize.value);
    await loadAppliedQuery();
  }

  async function refresh() {
    await loadAppliedQuery();
  }

  async function goToPage(nextPage: number) {
    if (nextPage < 1 || nextPage === appliedQuery.value.page) return;
    appliedQuery.value = { ...appliedQuery.value, page: nextPage };
    await loadAppliedQuery();
  }

  async function changePageSize(nextPageSize: number) {
    if (![20, 50, 100, 200, 500].includes(nextPageSize)) return;
    appliedQuery.value = { ...appliedQuery.value, page: 1, pageSize: nextPageSize };
    await loadAppliedQuery();
  }

  async function changeSort(sortField: string) {
    const sortColumn = definition.columns.find((column) => column.sortField === sortField);
    if (!sortColumn) return;
    const sameField = appliedQuery.value.sortField === sortField;
    appliedQuery.value = {
      ...appliedQuery.value,
      page: 1,
      sortField,
      sortOrder: sameField && appliedQuery.value.sortOrder === "asc" ? "desc" : "asc"
    };
    await loadAppliedQuery();
  }

  async function exportCsv() {
    exportController?.abort();
    exportController = new AbortController();
    const serial = ++exportSerial;
    exporting.value = true;
    exportMessage.value = "";
    const exportQuery = response.value?.query ?? appliedQuery.value;
    try {
      const result = await exportReportRows(definition.reportKey, exportQuery, exportController.signal);
      if (serial !== exportSerial) return;
      if (!result.ok || !result.blob) {
        exportMessage.value = result.message;
        return;
      }
      const objectUrl = URL.createObjectURL(result.blob);
      try {
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = result.fileName;
        link.click();
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
      exportMessage.value = `已引出 ${total.value} 行，与当前服务端筛选一致。`;
    } catch (error) {
      if (!isAbort(error)) {
        exportMessage.value = "网络异常，报表引出失败。请检查连接后重试。";
      }
    } finally {
      if (serial === exportSerial) exporting.value = false;
    }
  }

  async function resetForAccountSet() {
    invalidateRequests();
    response.value = null;
    errorKind.value = "";
    errorMessage.value = "";
    exportMessage.value = "";
    const dates = currentMonthDates();
    dateFrom.value = dates.dateFrom;
    dateTo.value = dates.dateTo;
    keyword.value = "";
    for (const filter of definition.filters) filters[filter.parameter] = filter.defaultValue ?? "";
    appliedQuery.value = queryFromDraft(1, 100);
    await loadAppliedQuery();
  }

  async function loadAppliedQuery() {
    invalidateExportForQueryChange();
    queryController?.abort();
    queryController = new AbortController();
    const serial = ++querySerial;
    loading.value = true;
    errorKind.value = "";
    errorMessage.value = "";
    try {
      const result = await fetchReportRows(definition.reportKey, appliedQuery.value, queryController.signal);
      if (serial !== querySerial) return;
      if (!result.ok || !result.data) {
        response.value = null;
        errorKind.value = result.kind || "server";
        errorMessage.value = result.message;
        return;
      }
      response.value = result.data;
      appliedQuery.value = queryFromEcho(result.data.query);
    } catch (error) {
      if (!isAbort(error) && serial === querySerial) {
        response.value = null;
        errorKind.value = "network";
        errorMessage.value = "网络异常，报表数据加载失败。请检查连接后重试。";
      }
    } finally {
      if (serial === querySerial) loading.value = false;
    }
  }

  function queryFromDraft(nextPage: number, nextPageSize: number): ReportQueryParameters {
    const query: ReportQueryParameters = {
      dateFrom: dateFrom.value,
      dateTo: dateTo.value,
      page: nextPage,
      pageSize: nextPageSize,
      sortField: appliedQuery.value?.sortField ?? definition.defaultSortField,
      sortOrder: appliedQuery.value?.sortOrder ?? definition.defaultSortOrder
    };
    const normalizedKeyword = keyword.value.trim();
    if (normalizedKeyword) query.keyword = normalizedKeyword;
    for (const filter of definition.filters) {
      const value = filters[filter.parameter]?.trim();
      if (value) query[filter.parameter] = value;
    }
    return query;
  }

  function queryFromEcho(echo: Record<string, ReportScalar>): ReportQueryParameters {
    const normalized: ReportQueryParameters = {
      dateFrom: String(echo.dateFrom ?? appliedQuery.value.dateFrom),
      dateTo: String(echo.dateTo ?? appliedQuery.value.dateTo),
      page: safeInteger(echo.page, appliedQuery.value.page),
      pageSize: safeInteger(echo.pageSize, appliedQuery.value.pageSize),
      sortField: String(echo.sortField ?? appliedQuery.value.sortField),
      sortOrder: echo.sortOrder === "asc" ? "asc" : "desc"
    };
    for (const [key, value] of Object.entries(echo)) {
      if (value !== null && !["dateFrom", "dateTo", "page", "pageSize", "sortField", "sortOrder"].includes(key)) {
        normalized[key] = typeof value === "number" ? value : String(value);
      }
    }
    return normalized;
  }

  function invalidateRequests() {
    querySerial += 1;
    exportSerial += 1;
    queryController?.abort();
    exportController?.abort();
    queryController = null;
    exportController = null;
    loading.value = false;
    exporting.value = false;
  }

  function invalidateExportForQueryChange() {
    exportSerial += 1;
    exportController?.abort();
    exportController = null;
    exporting.value = false;
    exportMessage.value = "";
  }

  return {
    dateFrom,
    dateTo,
    keyword,
    filters,
    response,
    rows,
    totals,
    normalizedQuery,
    page,
    pageSize,
    total,
    generatedAt,
    hasLoaded,
    loading,
    exporting,
    errorKind,
    errorMessage,
    exportMessage,
    appliedQuery,
    loadInitial,
    query,
    reset,
    refresh,
    goToPage,
    changePageSize,
    changeSort,
    exportCsv,
    resetForAccountSet
  };
}

function emptyFilters(definition: ReportDefinition) {
  return Object.fromEntries(definition.filters.map((filter) => [filter.parameter, filter.defaultValue ?? ""]));
}

function currentMonthDates() {
  const now = new Date();
  return {
    dateFrom: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`,
    dateTo: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  };
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function safeInteger(value: ReportScalar | undefined, fallback: number) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : fallback;
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}
