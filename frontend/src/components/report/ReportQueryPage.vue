<template>
  <section class="report-query-page" :data-testid="`report-page-${definition.entryId}`">
    <header class="report-query-header">
      <div>
        <span class="panel-kicker">{{ definition.module }} / 真实业务报表</span>
        <h2>{{ definition.title }}</h2>
        <p>{{ definition.description }}</p>
      </div>
      <div class="report-query-tools">
        <button type="button" :disabled="loading" data-testid="report-refresh" @click="refresh">刷新</button>
        <button type="button" :disabled="loading || exporting || !hasLoaded" data-testid="report-export" @click="exportCsv">
          {{ exporting ? "正在引出…" : "引出 CSV" }}
        </button>
        <button type="button" data-testid="report-column-settings" @click="openColumnSettings">列设置</button>
      </div>
    </header>

    <form class="report-filter-card" data-testid="report-filter-form" @submit.prevent="query">
      <div class="report-filter-heading">
        <strong>筛选条件</strong>
        <button type="button" class="link-button" data-testid="report-filter-toggle" @click="filtersExpanded = !filtersExpanded">
          {{ filtersExpanded ? "收起" : "展开" }}
        </button>
      </div>
      <div v-if="filtersExpanded" class="report-filter-grid">
        <label>
          <span>开始日期</span>
          <input v-model="dateFrom" type="date" required data-testid="report-date-from" />
        </label>
        <label>
          <span>结束日期</span>
          <input v-model="dateTo" type="date" required data-testid="report-date-to" />
        </label>
        <label>
          <span>关键词</span>
          <input v-model="keyword" type="search" placeholder="多个词以空格分隔，词间为并且" data-testid="report-keyword" />
        </label>
        <label v-for="filter in definition.filters" :key="filter.parameter">
          <span>{{ filter.label }}</span>
          <select
            v-if="filter.kind === 'select'"
            v-model="filters[filter.parameter]"
            :data-testid="`report-filter-${filter.parameter}`"
          >
            <option value="">全部</option>
            <option v-for="option in filter.options || []" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
          <input
            v-else
            v-model="filters[filter.parameter]"
            :placeholder="filter.placeholder"
            :data-testid="`report-filter-${filter.parameter}`"
          />
        </label>
        <div class="report-filter-actions">
          <button type="button" :disabled="loading" data-testid="report-reset" @click="reset">重置</button>
          <button class="primary-action" type="submit" :disabled="loading" data-testid="report-query">
            {{ loading ? "查询中…" : "查询" }}
          </button>
        </div>
      </div>
      <div v-else class="report-query-summary" data-testid="report-query-summary">
        <span v-for="item in summaryItems" :key="item">{{ item }}</span>
        <span v-if="summaryItems.length === 0">尚未应用筛选</span>
      </div>
    </form>

    <p v-if="exportMessage" class="report-export-message" data-testid="report-export-message">{{ exportMessage }}</p>

    <section v-if="errorMessage" class="report-state-card report-state-card--error" :data-kind="errorKind" data-testid="report-error">
      <strong>{{ errorTitle }}</strong>
      <p>{{ errorMessage }}</p>
      <button v-if="errorKind !== 'forbidden'" type="button" data-testid="report-retry" @click="refresh">重试</button>
    </section>

    <section v-else class="report-result-card">
      <div class="report-result-meta">
        <span>服务端结果 <strong>{{ total }}</strong> 行</span>
        <span v-if="generatedAt">生成于 {{ formatTimestamp(generatedAt) }}</span>
        <span>数量保持服务端精确十进制，不在浏览器重算</span>
      </div>

      <div v-if="loading && !hasLoaded" class="report-state-card" data-testid="report-loading">正在按当前账套查询…</div>
      <div v-else-if="hasLoaded && rows.length === 0" class="report-state-card" data-testid="report-empty">
        <strong>当前条件下没有业务事实</strong>
        <p>可调整日期或筛选条件后重新查询；空结果不会回退到演示数据。</p>
      </div>
      <div v-else-if="rows.length > 0" class="report-table-wrap">
        <TableCore
          kind="list"
          test-id="report-result-table"
          table-class="report-result-table"
          body-wrapper-class="report-result-table__body"
          :columns="tableColumns"
          :rows="rows"
          :row-key="reportRowKey"
          :cell-title="cellTitle"
          :min-width="tableMinWidth"
          @column-resize="resizeColumn"
          @column-resize-end="resizeColumn"
        >
          <template #header-cell="{ column, startResize }">
            <div class="table-core-header-cell column-header-cell report-header-cell">
              <button
                v-if="columnSortField(column.key)"
                type="button"
                class="report-sort-button"
                :data-testid="`report-sort-${column.key}`"
                @click.stop="changeSort(columnSortField(column.key))"
              >
                <span>{{ column.title }}</span>
                <span aria-hidden="true">{{ sortIndicator(columnSortField(column.key)) }}</span>
              </button>
              <span v-else>{{ column.title }}</span>
              <span
                class="table-core-column-resizer"
                :data-testid="`report-resize-${column.key}`"
                @mousedown.stop.prevent="startResize(column, $event)"
              />
            </div>
          </template>
          <template #cell="{ row, column }">
            <button
              v-if="isSourceBillColumn(column.key) && trustedSource(row)"
              type="button"
              class="report-source-link"
              :data-testid="`report-source-${reportRowIdentity(row)}`"
              @click="openSource(row)"
            >
              {{ displayText(row[column.key]) }}
            </button>
            <span v-else-if="column.key === 'businessDate'" class="report-date-cell">
              <span>{{ displayText(row.businessDate) }}</span>
              <small v-if="row.dateBasis === 'POSTING_FALLBACK'">历史记账日期（业务日期缺失）</small>
            </span>
            <span v-else-if="isSourceBillColumn(column.key)" class="report-source-readonly">
              <span>{{ displayText(row[column.key]) }}</span>
              <small v-if="sourceTraceNote(row)">{{ sourceTraceNote(row) }}</small>
            </span>
            <span v-else :class="cellValueClass(column.key, row[column.key])">{{ formatCell(row, column.key) }}</span>
          </template>
          <template #footer>
            <tr v-for="(totalRow, index) in totals" :key="totalRowKey(totalRow, index)" class="report-total-row">
              <td v-for="(column, columnIndex) in tableColumns" :key="column.key" :class="`col--align-${column.align || 'left'}`">
                {{ totalCell(totalRow, column.key, columnIndex) }}
              </td>
            </tr>
          </template>
        </TableCore>
      </div>

      <footer v-if="hasLoaded" class="report-pagination" data-testid="report-pagination">
        <span>第 {{ page }} / {{ totalPages }} 页</span>
        <label>
          每页
          <select :value="pageSize" data-testid="report-page-size" @change="changePageSize(Number(($event.target as HTMLSelectElement).value))">
            <option v-for="size in pageSizes" :key="size" :value="size">{{ size }}</option>
          </select>
        </label>
        <button type="button" :disabled="loading || page <= 1" data-testid="report-prev-page" @click="goToPage(page - 1)">上一页</button>
        <button type="button" :disabled="loading || page >= totalPages" data-testid="report-next-page" @click="goToPage(page + 1)">下一页</button>
      </footer>
    </section>

    <ColumnSettingsDialog
      :open="columnSettingsOpen"
      title="报表列设置"
      :columns="columnSettingsDraft"
      dialog-test-id="report-column-dialog"
      ok-test-id="report-column-dialog-ok"
      @reset="resetColumnSettings"
      @confirm="confirmColumnSettings"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import TableCore, { type TableCoreColumn } from "../table/TableCore.vue";
import ColumnSettingsDialog, { type ColumnSettingItem } from "../table/ColumnSettingsDialog.vue";
import { useReportQuery } from "./useReportQuery";
import type {
  ReportColumnDefinition,
  ReportDefinition,
  ReportRow,
  ReportScalar,
  ReportSourceDrillDefinition,
  ReportSourceOpenRequest
} from "../../modules/reports/reportTypes";

const props = defineProps<{
  definition: ReportDefinition;
  accountSetKey: string;
}>();

const emit = defineEmits<{
  openDocument: [payload: ReportSourceOpenRequest];
}>();

const queryState = useReportQuery(props.definition);
const {
  dateFrom,
  dateTo,
  keyword,
  filters,
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
} = queryState;

const pageSizes = [20, 50, 100, 200, 500];
const filtersExpanded = ref(true);
const columnSettingsOpen = ref(false);
const columns = ref(props.definition.columns.map(copyColumn));
const columnSettingsDraft = ref<Array<ColumnSettingItem & { key: string }>>([]);
const visibleColumns = computed(() => columns.value.filter((column) => column.visible !== false));
const tableColumns = computed<TableCoreColumn[]>(() => visibleColumns.value.map((column) => ({
  key: column.key,
  title: column.title,
  width: column.width,
  minWidth: column.minWidth,
  align: column.align,
  fixed: column.fixed,
  filterable: false,
  resizable: true
})));
const tableMinWidth = computed(() => Math.max(960, visibleColumns.value.reduce((sum, column) => sum + column.width, 0)));
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));
const summaryItems = computed(() => {
  const query = normalizedQuery.value;
  if (Object.keys(query).length === 0) return [];
  const items = [`日期：${displayText(query.dateFrom)} 至 ${displayText(query.dateTo)}`];
  if (query.keyword) items.push(`关键词：${displayText(query.keyword)}`);
  for (const filter of props.definition.filters) {
    if (query[filter.parameter]) items.push(`${filter.label}：${filterSummaryValue(filter.parameter, query[filter.parameter])}`);
  }
  return items;
});
const errorTitle = computed(() => (errorTitles[errorKind.value] || "报表加载失败"));
const errorTitles: Record<string, string> = {
  "bad-request": "筛选条件不合法",
  forbidden: "当前账号无权访问",
  "too-large": "引出范围过大",
  "not-found": "报表未登记",
  network: "网络连接失败",
  server: "报表服务异常"
};
onMounted(loadInitial);
watch(() => props.accountSetKey, (next, previous) => {
  if (previous !== undefined && next !== previous) void resetForAccountSet();
});

function copyColumn(column: ReportColumnDefinition): ReportColumnDefinition {
  return { ...column, visible: column.visible !== false, fixed: column.fixed ?? "" };
}

function openColumnSettings() {
  columnSettingsDraft.value = columns.value.map((column) => ({
    key: column.key,
    title: column.title,
    visible: column.visible !== false,
    fixed: column.fixed ?? "",
    configurable: column.configurable
  }));
  columnSettingsOpen.value = true;
}

function resetColumnSettings() {
  columnSettingsDraft.value = props.definition.columns.map((column) => ({
    key: column.key,
    title: column.title,
    visible: column.visible !== false,
    fixed: column.fixed ?? "",
    configurable: column.configurable
  }));
}

function confirmColumnSettings() {
  const settings = new Map(columnSettingsDraft.value.map((column) => [column.key, column]));
  columns.value = columns.value.map((column) => {
    const setting = settings.get(column.key);
    return setting ? { ...column, visible: setting.visible, fixed: setting.fixed ?? "" } : column;
  });
  columnSettingsOpen.value = false;
}

function resizeColumn(payload: { column: TableCoreColumn; width: number }) {
  const target = columns.value.find((column) => column.key === payload.column.key);
  if (target) target.width = payload.width;
}

function columnSortField(key: string) {
  return columns.value.find((column) => column.key === key)?.sortField ?? "";
}

function sortIndicator(field: string) {
  if (appliedQuery.value.sortField !== field) return "↕";
  return appliedQuery.value.sortOrder === "asc" ? "↑" : "↓";
}

function reportRowKey(row: ReportRow, index: number) {
  return String(row.id ?? row.rowKey ?? index);
}

function reportRowIdentity(row: ReportRow) {
  const drill = props.definition.sourceDrill;
  return String(row.id ?? row.rowKey ?? (drill ? row[drill.billNoField] : "unknown"));
}

function cellTitle(row: ReportRow, column: TableCoreColumn) {
  return formatCell(row, column.key);
}

function formatCell(row: ReportRow, key: string) {
  const value = row[key];
  if (key === "qtyOnHandAfter" && (value === null || value === "")) return "历史结存不可精确还原";
  if (key === "postingAction") return postingActionLabel(value);
  if (key === "traceQuality") return traceQualityLabel(value);
  return displayText(value);
}

function displayText(value: ReportScalar | undefined) {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function postingActionLabel(value: ReportScalar | undefined) {
  return ({ AUDIT: "审核过账", REVERSE: "反审核", RED_AUDIT: "红字审核", RED_REVERSE: "红字反审核", RESERVE: "预留", RELEASE: "释放" } as Record<string, string>)[String(value)] ?? displayText(value);
}

function traceQualityLabel(value: ReportScalar | undefined) {
  return ({ EXACT: "精确到行", CONTROLLED: "受控来源", HEADER_ONLY: "仅源单头", LEGACY: "历史流水" } as Record<string, string>)[String(value)] ?? displayText(value);
}

function cellValueClass(key: string, value: ReportScalar | undefined) {
  return {
    "report-quantity": ["inboundQty", "outboundQty", "qtyOnHandAfter"].includes(key),
    "report-value-muted": value === null || value === undefined || value === "",
    "report-trace-exact": key === "traceQuality" && value === "EXACT",
    "report-trace-degraded": key === "traceQuality" && value !== "EXACT"
  };
}

function isSourceBillColumn(key: string) {
  return props.definition.sourceDrill?.billNoField === key;
}

function sourceTarget(row: ReportRow, drill: ReportSourceDrillDefinition) {
  const value = row[drill.targetField];
  return typeof value === "string" && drill.targets.some((target) => target === value)
    ? value as ReportSourceOpenRequest["type"]
    : null;
}

function trustedSource(row: ReportRow) {
  const drill = props.definition.sourceDrill;
  if (!drill || !sourceTarget(row, drill)) return false;
  const billNo = row[drill.billNoField];
  if (typeof billNo !== "string" || billNo === "") return false;
  if (!drill.trust) return true;
  const trustValue = row[drill.trust.field];
  return typeof trustValue === "string" && drill.trust.acceptedValues.includes(trustValue);
}

function sourceTraceNote(row: ReportRow) {
  if (trustedSource(row)) return "";
  const drill = props.definition.sourceDrill;
  if (!drill) return "";
  if (drill.trust) {
    const trustValue = row[drill.trust.field];
    if (typeof trustValue === "string" && !drill.trust.acceptedValues.includes(trustValue)) {
      return drill.trust.rejectedValueMessages[trustValue] ?? drill.trust.defaultRejectedMessage;
    }
  }
  return drill.unsupportedTargetMessage;
}

function openSource(row: ReportRow) {
  if (!trustedSource(row)) return;
  const drill = props.definition.sourceDrill;
  if (!drill) return;
  const target = sourceTarget(row, drill);
  const billNo = row[drill.billNoField];
  if (!target || typeof billNo !== "string") return;
  const sourceLineNo = drill.lineNoField ? row[drill.lineNoField] : null;
  emit("openDocument", {
    type: target,
    billNo,
    sourceLineNo: typeof sourceLineNo === "number" ? sourceLineNo : null
  });
}

function totalRowKey(row: ReportRow, index: number) {
  return props.definition.totals.groupKeys.map((key) => displayText(row[key])).join("|") || String(index);
}

function totalCell(row: ReportRow, key: string, columnIndex: number) {
  if (props.definition.totals.valueKeys.includes(key)) return displayText(row[key]);
  if (props.definition.totals.groupKeys.includes(key)) return displayText(row[key]);
  return columnIndex === 0 ? "服务端合计" : "";
}

function formatTimestamp(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-CN", { hour12: false });
}

function filterSummaryValue(parameter: string, value: ReportScalar) {
  const filter = props.definition.filters.find((item) => item.parameter === parameter);
  const option = filter?.options?.find((item) => item.value === String(value));
  return option?.label ?? displayText(value);
}
</script>
