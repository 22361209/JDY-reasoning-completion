<template>
  <div class="data-list-page" :data-testid="`list-page-${listKey}`">
    <div class="business-head list-head">
      <div>
        <h2>{{ definition.title }}</h2>
        <p>{{ definition.subtitle }}</p>
      </div>
      <div class="status-stamp">列表</div>
    </div>

    <section class="list-filter" :class="{ expanded: filtersExpanded }">
      <label>
        关键字
        <input
          v-model="query.keyword"
          :placeholder="definition.keywordPlaceholder"
          data-testid="list-keyword"
          @keydown.enter="reload"
        />
      </label>
      <label>
        状态
        <select v-model="query.status" data-testid="list-status">
          <option value="">全部</option>
          <option v-for="status in definition.statuses" :key="status" :value="status">{{ status }}</option>
        </select>
      </label>
      <label v-if="filtersExpanded">
        日期
        <input value="2026-06-01 至 2026-06-30" readonly />
      </label>
      <label v-if="filtersExpanded">
        经办人
        <input value="本地管理员" readonly />
      </label>
      <div class="filter-actions">
        <button class="primary-action" type="button" data-testid="list-query" @click="reload">查询</button>
        <button type="button" data-testid="list-reset" @click="resetQuery">重置</button>
        <button type="button" data-testid="list-toggle-filter" @click="filtersExpanded = !filtersExpanded">
          {{ filtersExpanded ? "收起过滤" : "展开过滤" }}
        </button>
      </div>
    </section>

    <div v-if="locked" class="lock-banner" data-testid="lock-banner">
      单据已在其他页签打开，列表的审核/删除/批量操作已锁定。
    </div>

    <div class="list-toolbar">
      <button class="primary-action" type="button" :disabled="locked">新增</button>
      <button type="button" :disabled="locked || selectedRows.length === 0" data-testid="batch-audit" @click="confirmAction('审核')">审核</button>
      <button type="button" :disabled="locked || selectedRows.length === 0" data-testid="batch-delete" @click="confirmAction('删除')">删除</button>
      <button type="button" data-testid="list-refresh" @click="reload">刷新</button>
      <button type="button">引出</button>
      <button type="button">打印</button>
      <button type="button" data-testid="column-settings" @click="columnDialogOpen = true">列设置</button>
      <span class="selected-count">已选中 {{ selectedRows.length }} 条</span>
    </div>

    <div class="vxe-wrap" data-testid="vxe-list-table">
      <vxe-table
        :key="tableVersion"
        ref="tableRef"
        height="360"
        size="mini"
        border
        show-overflow
        show-header-overflow
        stripe
        :loading="loading"
        :data="displayedRows"
        :row-config="{ keyField: 'id', isHover: true }"
        :column-config="{ resizable: true }"
        :checkbox-config="{ checkMethod: checkboxCheckMethod }"
        @checkbox-change="syncSelected"
        @checkbox-all="syncSelected"
        @resizable-change="handleColumnResize"
      >
        <vxe-column type="checkbox" width="42" fixed="left" />
        <vxe-column
          v-for="column in visibleColumns"
          :key="column.field"
          :field="column.field"
          :title="column.title"
          :width="column.width"
          :min-width="column.minWidth"
          :fixed="column.fixed || undefined"
          :align="column.align || 'left'"
          :resizable="true"
          show-overflow
        >
          <template #header>
            <div
              class="column-header-cell"
              :class="{ dragging: draggingColumnField === column.field, 'drag-over': dragOverColumnField === column.field }"
              :data-testid="`column-drag-${column.field}`"
              :data-column-field="column.field"
              @mousedown.left="startColumnMouseDrag(column, $event)"
            >
              <span class="column-header-title">
                {{ column.title }}
              </span>
              <button
                class="column-filter-button"
                type="button"
                :class="{ active: Boolean(columnFilters[column.field]?.value) }"
                :title="`${column.title}过滤`"
                :data-testid="`column-filter-${column.field}`"
                @mousedown.stop
                @click.stop="openColumnFilter(column, $event)"
              >
                ⌄
              </button>
            </div>
          </template>
          <template #default="{ row }">
            <span v-if="column.field === 'status'" class="status-pill" :class="{ draft: row.status === '草稿' }">{{ row[column.field] }}</span>
            <span v-else>{{ row[column.field] }}</span>
          </template>
        </vxe-column>
      </vxe-table>
      <div v-if="!loading && listState === 'empty'" class="list-state-panel" data-testid="list-empty-state">
        <strong>暂无数据</strong>
        <span>当前查询条件下没有匹配记录。</span>
      </div>
      <div v-if="!loading && listState === 'forbidden'" class="list-state-panel" data-testid="list-forbidden-state">
        <strong>无权查看</strong>
        <span>{{ stateMessage }}</span>
      </div>
      <div v-if="!loading && listState === 'error'" class="list-state-panel" data-testid="list-error-state">
        <strong>加载失败</strong>
        <span>{{ stateMessage }}</span>
        <button type="button" @click="reload">重试</button>
      </div>
    </div>

    <footer class="list-pagination">
      <span>共 {{ total }} 条</span>
      <select v-model.number="query.pageSize" @change="reload">
        <option :value="200">200条/页</option>
        <option :value="500">500条/页</option>
        <option :value="1000">1000条/页</option>
      </select>
      <button type="button" :disabled="query.page === 1" @click="goPage(query.page - 1)">上一页</button>
      <span>第 {{ query.page }} 页</span>
      <button type="button" :disabled="query.page * query.pageSize >= total" @click="goPage(query.page + 1)">下一页</button>
    </footer>

    <div v-if="columnDialogOpen" class="modal-mask" data-testid="column-settings-dialog">
      <div class="dialog column-dialog">
        <h3>列设置</h3>
        <div class="column-setting-list">
          <div v-for="column in columns" :key="column.field" class="column-setting-row">
            <label><input v-model="column.visible" type="checkbox" /> {{ column.title }}</label>
            <select v-model="column.fixed">
              <option value="">不固定</option>
              <option value="left">固定左侧</option>
              <option value="right">固定右侧</option>
            </select>
          </div>
        </div>
        <div class="dialog-actions">
          <button type="button" @click="resetColumnsToDefault">恢复默认</button>
          <button class="primary-action" type="button" data-testid="column-settings-ok" @click="closeColumnSettings">确定</button>
        </div>
      </div>
    </div>

    <div
      v-if="filterDialogOpen && activeFilterColumn"
      class="column-filter-popover"
      :style="{ left: `${filterPopoverLeft}px`, top: `${filterPopoverTop}px` }"
      data-testid="column-filter-dialog"
    >
      <div class="filter-operator-list">
        <button
          v-for="operator in filterOperators"
          :key="operator"
          type="button"
          :class="{ active: activeFilterOperator === operator }"
          @click="activeFilterOperator = operator"
        >
          {{ operator }}
        </button>
      </div>
      <div class="column-filter-input-row">
          <input
            v-model="activeFilterValue"
            data-testid="column-filter-input"
            placeholder="输入过滤关键字"
            @keydown.enter="applyColumnFilter"
          />
      </div>
      <div class="column-filter-actions">
        <button type="button" @click="clearColumnFilter">重置</button>
        <button class="primary-action" type="button" data-testid="column-filter-ok" @click="applyColumnFilter">确定</button>
      </div>
    </div>

    <div v-if="pendingAction" class="modal-mask" data-testid="batch-confirm-dialog">
      <div class="dialog">
        <h3>操作确认</h3>
        <p>确定要{{ pendingAction }}已选中的 {{ selectedRows.length }} 条数据吗？</p>
        <div class="dialog-actions">
          <button type="button" @click="pendingAction = ''">取消</button>
          <button class="danger-action" type="button" @click="pendingAction = ''">确定</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { fetchListRows } from "../services/listApi";

interface ListColumn {
  field: string;
  title: string;
  width?: number;
  minWidth?: number;
  fixed?: "" | "left" | "right";
  align?: "left" | "center" | "right";
  visible: boolean;
}

interface ListDefinition {
  title: string;
  subtitle: string;
  keywordPlaceholder: string;
  statuses: string[];
  columns: ListColumn[];
}

interface ColumnFilter {
  operator: string;
  value: string;
}

const props = defineProps<{
  listKey: string;
  locked?: boolean;
}>();

const tableRef = ref();
const tableVersion = ref(0);
const loading = ref(false);
const listState = ref<"ready" | "empty" | "error" | "forbidden">("ready");
const stateMessage = ref("");
const filtersExpanded = ref(false);
const columnDialogOpen = ref(false);
const filterDialogOpen = ref(false);
const pendingAction = ref("");
const rows = ref<Record<string, unknown>[]>([]);
const total = ref(0);
const selectedRows = ref<Record<string, unknown>[]>([]);
const activeFilterColumn = ref<ListColumn | null>(null);
const activeFilterOperator = ref("包含");
const activeFilterValue = ref("");
const columnFilters = reactive<Record<string, ColumnFilter>>({});
const filterPopoverLeft = ref(0);
const filterPopoverTop = ref(0);
const draggingColumnField = ref("");
const dragOverColumnField = ref("");
const query = reactive({ keyword: "", status: "", page: 1, pageSize: 200 });
const filterOperators = ["包含", "不包含", "等于", "不等于", "以……开始", "以……结束", "为空", "不为空"];

const definitions: Record<string, ListDefinition> = {
  "product-master-list": {
    title: "商品资料",
    subtitle: "编码、名称、规格型号、类别、单位和状态按高密度列表范式展示。",
    keywordPlaceholder: "商品编码、名称、规格型号",
    statuses: ["启用", "禁用"],
    columns: [
      { field: "code", title: "商品编码", width: 140, fixed: "left", visible: true },
      { field: "name", title: "商品名称", width: 180, visible: true },
      { field: "spec", title: "规格型号", width: 170, visible: true },
      { field: "category", title: "商品类别", width: 130, visible: true },
      { field: "unit", title: "单位", width: 80, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "updatedAt", title: "最近更新时间", width: 160, visible: true }
    ]
  },
  "customer-master-list": {
    title: "客户",
    subtitle: "客户编码、联系人、电话、地区和状态保持同一列表骨架。",
    keywordPlaceholder: "客户编码、客户名称、联系人",
    statuses: ["启用", "禁用"],
    columns: [
      { field: "code", title: "客户编码", width: 140, fixed: "left", visible: true },
      { field: "name", title: "客户名称", width: 220, visible: true },
      { field: "contact", title: "联系人", width: 120, visible: true },
      { field: "phone", title: "电话", width: 150, visible: true },
      { field: "region", title: "地区", width: 160, visible: true },
      { field: "status", title: "状态", width: 100, visible: true }
    ]
  },
  "supplier-master-list": {
    title: "供应商",
    subtitle: "供应商资料使用与客户一致的筛选、勾选、列设置和分页范式。",
    keywordPlaceholder: "供应商编码、供应商名称",
    statuses: ["启用", "禁用"],
    columns: [
      { field: "code", title: "供应商编码", width: 150, fixed: "left", visible: true },
      { field: "name", title: "供应商名称", width: 220, visible: true },
      { field: "contact", title: "联系人", width: 120, visible: true },
      { field: "phone", title: "电话", width: 150, visible: true },
      { field: "status", title: "状态", width: 100, visible: true }
    ]
  },
  "sales-order-form-list": {
    title: "销售订单列表",
    subtitle: "销售订单列表承载查询、批量动作、列设置、页签锁定和分页。",
    keywordPlaceholder: "单据编号、客户、商品",
    statuses: ["草稿", "已审核"],
    columns: [
      { field: "billNo", title: "单据编号", width: 150, fixed: "left", visible: true },
      { field: "customer", title: "客户/对象", width: 220, visible: true },
      { field: "billDate", title: "日期", width: 130, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true },
      { field: "owner", title: "经办人", width: 120, visible: true }
    ]
  },
  "purchase-in-list": {
    title: "采购入库单",
    subtitle: "采购入库单用于验证业务列表的供应商、仓库、金额和状态列。",
    keywordPlaceholder: "单据编号、供应商、仓库",
    statuses: ["草稿", "已审核"],
    columns: [
      { field: "billNo", title: "单据编号", width: 150, fixed: "left", visible: true },
      { field: "supplier", title: "供应商", width: 220, visible: true },
      { field: "billDate", title: "日期", width: 130, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true }
    ]
  },
  "inventory-query-list": {
    title: "库存查询",
    subtitle: "库存查询只展示数据库余额口径的现存量和可用量，不做业务结果缓存。",
    keywordPlaceholder: "商品编码、商品名称、仓库",
    statuses: ["正常", "低库存"],
    columns: [
      { field: "code", title: "商品编码", width: 140, fixed: "left", visible: true },
      { field: "name", title: "商品名称", width: 180, visible: true },
      { field: "spec", title: "规格型号", width: 170, visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true },
      { field: "onHand", title: "现存量", width: 110, align: "right", visible: true },
      { field: "available", title: "可用量", width: 110, align: "right", visible: true },
      { field: "status", title: "状态", width: 100, visible: true }
    ]
  }
};

const fallbackDefinition: ListDefinition = {
  title: "标准列表",
  subtitle: "该入口暂用 B1 标准列表骨架承载。",
  keywordPlaceholder: "编码、名称、单据编号",
  statuses: ["草稿", "已审核", "启用"],
  columns: definitions["sales-order-form-list"].columns
};

const definition = computed(() => definitions[props.listKey] ?? fallbackDefinition);
const columns = ref<ListColumn[]>([]);
const visibleColumns = computed(() => columns.value.filter((column) => column.visible));
const displayedRows = computed(() => rows.value);

watch(() => props.listKey, () => {
  resetColumns();
  resetQuery();
}, { immediate: true });

onMounted(() => {
  reload();
});

onBeforeUnmount(() => {
  window.removeEventListener("mousemove", trackColumnMouseDrag);
  window.removeEventListener("mouseup", finishColumnMouseDrag);
});

function resetColumns() {
  const defaults = definition.value.columns.map((column) => ({ ...column }));
  const saved = loadColumnPreferences();
  if (!saved.length) {
    columns.value = defaults;
    return;
  }
  const defaultByField = new Map(defaults.map((column) => [column.field, column]));
  const restored: ListColumn[] = [];
  saved.forEach((savedColumn) => {
    const current = defaultByField.get(savedColumn.field);
    if (!current) {
      return;
    }
    restored.push({
      ...current,
      width: savedColumn.width ?? current.width,
      fixed: savedColumn.fixed ?? "",
      visible: savedColumn.visible
    });
  });
  const restoredFields = new Set(restored.map((column) => column.field));
  columns.value = [
    ...restored,
    ...defaults.filter((column) => !restoredFields.has(column.field))
  ];
}

async function reload() {
  loading.value = true;
  listState.value = "ready";
  stateMessage.value = "";
  selectedRows.value = [];
  const response = await fetchListRows(props.listKey, { ...query, columnFilters });
  if (response.ok && response.data) {
    rows.value = response.data.rows;
    total.value = response.data.total;
    listState.value = response.data.rows.length ? "ready" : "empty";
  } else {
    rows.value = [];
    total.value = 0;
    listState.value = response.forbidden ? "forbidden" : "error";
    stateMessage.value = response.message;
  }
  loading.value = false;
}

function resetQuery() {
  query.keyword = "";
  query.status = "";
  query.page = 1;
  reload();
}

function goPage(page: number) {
  query.page = page;
  reload();
}

function syncSelected() {
  selectedRows.value = tableRef.value?.getCheckboxRecords?.() ?? [];
}

function checkboxCheckMethod() {
  return !props.locked;
}

function confirmAction(action: string) {
  pendingAction.value = action;
}

function openColumnFilter(column: ListColumn, event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  activeFilterColumn.value = column;
  activeFilterOperator.value = columnFilters[column.field]?.operator ?? "包含";
  activeFilterValue.value = columnFilters[column.field]?.value ?? "";
  filterPopoverLeft.value = Math.min(rect.right - 136, window.innerWidth - 150);
  filterPopoverTop.value = rect.bottom + 4;
  filterDialogOpen.value = true;
}

function applyColumnFilter() {
  if (!activeFilterColumn.value) {
    return;
  }
  const value = activeFilterValue.value.trim();
  if (value || ["为空", "不为空"].includes(activeFilterOperator.value)) {
    columnFilters[activeFilterColumn.value.field] = {
      operator: activeFilterOperator.value,
      value
    };
  } else {
    delete columnFilters[activeFilterColumn.value.field];
  }
  filterDialogOpen.value = false;
  query.page = 1;
  reload();
}

function clearColumnFilter() {
  if (activeFilterColumn.value) {
    delete columnFilters[activeFilterColumn.value.field];
  }
  activeFilterValue.value = "";
  filterDialogOpen.value = false;
  query.page = 1;
  reload();
}

function startColumnMouseDrag(column: ListColumn, event: MouseEvent) {
  event.preventDefault();
  draggingColumnField.value = column.field;
  dragOverColumnField.value = column.field;
  window.addEventListener("mousemove", trackColumnMouseDrag);
  window.addEventListener("mouseup", finishColumnMouseDrag, { once: true });
}

function trackColumnMouseDrag(event: MouseEvent) {
  if (!draggingColumnField.value) {
    return;
  }
  const element = document.elementFromPoint(event.clientX, event.clientY);
  const header = element?.closest<HTMLElement>(".column-header-cell");
  const field = header?.dataset.columnField;
  if (field) {
    dragOverColumnField.value = field;
  }
}

function finishColumnMouseDrag() {
  const targetField = dragOverColumnField.value;
  const sourceField = draggingColumnField.value;
  if (!sourceField || !targetField || sourceField === targetField) {
    finishColumnDrag();
    return;
  }
  const sourceIndex = columns.value.findIndex((column) => column.field === sourceField);
  const targetIndex = columns.value.findIndex((column) => column.field === targetField);
  if (sourceIndex === -1 || targetIndex === -1) {
    finishColumnDrag();
    return;
  }
  const nextColumns = [...columns.value];
  const [sourceColumn] = nextColumns.splice(sourceIndex, 1);
  sourceColumn.fixed = "";
  const targetColumn = nextColumns.find((column) => column.field === targetField);
  if (targetColumn) {
    targetColumn.fixed = "";
  }
  nextColumns.splice(targetIndex, 0, sourceColumn);
  columns.value = nextColumns;
  tableVersion.value += 1;
  saveColumnPreferences();
  finishColumnDrag();
}

function finishColumnDrag() {
  window.removeEventListener("mousemove", trackColumnMouseDrag);
  draggingColumnField.value = "";
  dragOverColumnField.value = "";
}

function handleColumnResize(event: { column?: { field?: string }, resizeWidth?: number }) {
  const field = event.column?.field;
  if (!field || !event.resizeWidth) {
    return;
  }
  const target = columns.value.find((column) => column.field === field);
  if (target) {
    target.width = event.resizeWidth;
    saveColumnPreferences();
  }
}

function closeColumnSettings() {
  saveColumnPreferences();
  columnDialogOpen.value = false;
}

function resetColumnsToDefault() {
  localStorage.removeItem(columnPreferenceKey());
  columns.value = definition.value.columns.map((column) => ({ ...column }));
  tableVersion.value += 1;
}

function columnPreferenceKey() {
  return `jdy:list-columns:${props.listKey}`;
}

function loadColumnPreferences(): ListColumn[] {
  try {
    const raw = localStorage.getItem(columnPreferenceKey());
    return raw ? JSON.parse(raw) as ListColumn[] : [];
  } catch {
    return [];
  }
}

function saveColumnPreferences() {
  const preference = columns.value.map((column) => ({
    field: column.field,
    width: column.width,
    fixed: column.fixed ?? "",
    visible: column.visible
  }));
  localStorage.setItem(columnPreferenceKey(), JSON.stringify(preference));
}
</script>
