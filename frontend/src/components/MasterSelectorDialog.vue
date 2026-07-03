<template>
  <SourceSelectorDialog
    :open="open"
    test-prefix="master-selector"
    :title="title"
    description="点击行即回填当前字段。"
    :keyword="keyword"
    :search-placeholder="`${label}编码、名称`"
    :loading="loading"
    :rows="rows"
    :columns="selectorColumns"
    :selected="selectedRows"
    :count-label="`共 ${total} 条`"
    :message="message"
    :row-key="selectorRowKey"
    :format-cell="formatSelectorCell"
    empty-text="暂无可选资料"
    :pagination="{ total, page, pageSize }"
    :page-size-options="[100, 200, 500]"
    :show-select-all="false"
    row-clickable
    @update:keyword="draftKeyword = $event"
    @query-change="handleQueryChange"
    @page-change="changePage"
    @page-size-change="changePageSize"
    @row-click="selectRow"
    @toggle="selectRow"
    @confirm="confirmSelected"
    @close="emit('close')"
  >
    <template #sidebar>
      <button
        type="button"
        class="master-selector-dialog__tree-item"
        :class="{ active: selectedCategory === '' }"
        data-testid="master-selector-category-all"
        @click="changeCategory('')"
      >
        全部{{ label }}
      </button>
      <template v-if="type === 'product'">
        <span class="master-selector-dialog__tree-title">物料类别</span>
        <button
          v-for="category in categories"
          :key="category.code || category.name"
          type="button"
          class="master-selector-dialog__tree-item"
          :class="{ active: selectedCategory === category.name }"
          :data-testid="`master-selector-category-${category.code || category.name}`"
          @click="changeCategory(category.name)"
        >
          <strong>{{ category.name }}</strong>
          <small v-if="category.code">{{ category.code }}</small>
        </button>
        <span v-if="categories.length === 0 && !loadingCategories" class="master-selector-dialog__tree-empty">暂无类别</span>
      </template>
      <template v-else>
        <span>启用资料</span>
        <span>最近使用</span>
      </template>
    </template>
  </SourceSelectorDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { MasterOption } from "./EntryTable.vue";
import SourceSelectorDialog, { type SourceSelectorColumn, type SourceSelectorQueryChange } from "./SourceSelectorDialog.vue";
import { masterDataDefinitions } from "../modules/master-data/registry";
import { fetchListRows } from "../services/listApi";

type SelectorRow = MasterOption;

const props = defineProps<{
  open: boolean;
  type: string;
  title: string;
  label: string;
  keyword: string;
}>();

const emit = defineEmits<{
  close: [];
  select: [option: MasterOption];
}>();

const rows = ref<SelectorRow[]>([]);
const categories = ref<SelectorRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(100);
const loading = ref(false);
const loadingCategories = ref(false);
const message = ref("");
const draftKeyword = ref(props.keyword);
const selectedCategory = ref("");
const selectedCode = ref("");
const columnFilters = ref<Record<string, { operator: string; value: string }>>({});
let requestSeq = 0;
let categoryRequestSeq = 0;

const listKey = computed(() => masterSelectorListKey(props.type));
const selectorColumns = computed<SourceSelectorColumn[]>(() => [
  { key: "selection", title: "", width: 48, visible: true, configurable: false, filterable: false, resizable: false },
  ...(masterDataDefinitions[listKey.value]?.selectorColumns ?? fallbackColumns(props.label))
    .filter((column) => column.visible !== false)
    .map((column) => ({
      key: column.field,
      title: column.title,
      width: column.width,
      visible: true,
      fixed: column.fixed ?? "",
      align: column.align,
      filterable: true,
      resizable: true
    }))
]);
const selectedRows = computed(() => selectedCode.value ? { [selectedCode.value]: true } : {});

function selectorRowKey(row: unknown) {
  return String((row as SelectorRow).code ?? "");
}

function formatSelectorCell(row: unknown, columnKey: string) {
  const value = (row as Record<string, unknown>)[columnKey];
  return value == null || value === "" ? "-" : String(value);
}

function handleQueryChange(query: SourceSelectorQueryChange) {
  draftKeyword.value = query.keyword;
  columnFilters.value = query.columnFilters;
  page.value = 1;
  void loadRows();
}

function changePage(nextPage: number) {
  page.value = nextPage;
  void loadRows();
}

function changePageSize(nextPageSize: number) {
  pageSize.value = nextPageSize;
  page.value = 1;
  void loadRows();
}

function changeCategory(category: string) {
  selectedCategory.value = category;
  selectedCode.value = "";
  page.value = 1;
  void loadRows();
}

function selectRow(row: unknown) {
  const option = row as SelectorRow;
  selectedCode.value = option.code;
  emit("select", option);
}

function confirmSelected() {
  const row = rows.value.find((item) => item.code === selectedCode.value);
  if (row) {
    emit("select", row);
    return;
  }
  emit("close");
}

async function loadCategories() {
  if (props.type !== "product") {
    categories.value = [];
    return;
  }
  const seq = categoryRequestSeq + 1;
  categoryRequestSeq = seq;
  loadingCategories.value = true;
  const result = await fetchListRows("product-category-list", {
    keyword: "",
    status: "",
    page: 1,
    pageSize: 500,
    columnFilters: {
      auditStatus: { operator: "等于", value: "已审核" },
      status: { operator: "等于", value: "启用" }
    }
  });
  if (seq !== categoryRequestSeq) {
    return;
  }
  loadingCategories.value = false;
  categories.value = result.ok && result.data ? result.data.rows.map(masterRowToOption) : [];
}

async function loadRows() {
  if (!props.open || !props.type) {
    return;
  }
  const seq = requestSeq + 1;
  requestSeq = seq;
  loading.value = true;
  message.value = "";
  const filters = { ...columnFilters.value };
  if (props.type === "product" && selectedCategory.value) {
    filters.category = { operator: "等于", value: selectedCategory.value };
  }
  const result = await fetchListRows(listKey.value, {
    keyword: draftKeyword.value,
    status: "",
    page: page.value,
    pageSize: pageSize.value,
    columnFilters: Object.keys(filters).length ? filters : undefined
  });
  if (seq !== requestSeq) {
    return;
  }
  loading.value = false;
  if (!result.ok || !result.data) {
    rows.value = [];
    total.value = 0;
    message.value = result.message || "主数据列表加载失败。";
    return;
  }
  rows.value = result.data.rows.map(masterRowToOption);
  total.value = result.data.total;
}

function masterRowToOption(row: Record<string, unknown>): SelectorRow {
  const option: SelectorRow = { code: "", name: "" };
  Object.entries(row).forEach(([key, value]) => {
    option[key] = value == null ? "" : String(value);
  });
  option.id = row.id ? String(row.id) : undefined;
  option.code = String(row.code ?? "");
  option.name = String(row.name ?? "");
  option.spec = row.spec ? String(row.spec) : "";
  option.unit = row.unit ? String(row.unit) : "";
  option.category = row.category ? String(row.category) : "";
  option.netWeight = row.netWeight ? String(row.netWeight) : "";
  option.grossWeight = row.grossWeight ? String(row.grossWeight) : "";
  return option;
}

function masterSelectorListKey(type: string) {
  const listKeyByType: Record<string, string> = {
    customer: "customer-master-list",
    supplier: "supplier-master-list",
    product: "product-master-list",
    warehouse: "warehouse-master-list"
  };
  return listKeyByType[type] ?? "product-master-list";
}

function fallbackColumns(label: string): SourceSelectorColumn[] {
  return [
    { key: "code", title: `${label}编码`, width: 150, visible: true },
    { key: "name", title: `${label}名称`, width: 180, visible: true },
    { key: "spec", title: "规格", width: 140, visible: true },
    { key: "unit", title: "单位", width: 80, visible: true }
  ];
}

watch(() => props.open, (open) => {
  if (!open) {
    return;
  }
  rows.value = [];
  total.value = 0;
  message.value = "";
  selectedCode.value = "";
  selectedCategory.value = "";
  columnFilters.value = {};
  draftKeyword.value = props.keyword;
  page.value = 1;
  void loadCategories();
  void loadRows();
});

watch(() => props.type, () => {
  if (props.open) {
    rows.value = [];
    total.value = 0;
    selectedCode.value = "";
    selectedCategory.value = "";
    columnFilters.value = {};
    page.value = 1;
    void loadCategories();
    void loadRows();
  }
});
</script>
