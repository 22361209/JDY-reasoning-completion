<template>
  <section class="list-filter" :class="{ expanded }">
    <label>
      关键字
      <input
        :value="keyword"
        :placeholder="`${keywordPlaceholder}，空格分隔多条件`"
        data-testid="list-keyword"
        @input="emit('update:keyword', ($event.target as HTMLInputElement).value)"
        @keydown.enter="emit('query')"
      />
    </label>
    <div v-if="supportsQuickDateFilter" class="date-filter-control">
      <button ref="quickDateButton" class="list-query-button" type="button" data-testid="list-quick-date" @click="toggleQuickDateMenu">常用过滤条件</button>
      <div v-if="quickDateMenuOpen" class="column-filter-popover" :style="quickDatePopoverStyle" data-testid="list-quick-date-menu">
        <div class="filter-operator-list">
          <button v-for="option in quickDateOptions" :key="option.key" type="button" @click="selectQuickDate(option.key)">
            {{ option.label }}
          </button>
        </div>
      </div>
    </div>
    <div v-if="supportsQuickDateFilter" class="date-filter-control">
      <button ref="dateRangeButton" class="list-query-button" type="button" data-testid="list-date-range" @click="toggleDateRange">日期范围</button>
      <div v-if="dateRangeOpen" class="column-filter-popover" :style="dateRangePopoverStyle" data-testid="list-date-range-popover">
        <label class="column-filter-input-row">
          开始日期
          <input v-model="draftDateFrom" type="date" data-testid="list-date-from" />
        </label>
        <label class="column-filter-input-row">
          结束日期
          <input v-model="draftDateTo" type="date" data-testid="list-date-to" />
        </label>
        <div class="column-filter-actions">
          <button type="button" @click="clearDateRange">清除</button>
          <button class="primary-action" type="button" data-testid="list-date-range-apply" @click="applyDateRange">确定</button>
        </div>
      </div>
    </div>
    <span v-if="activeDateRangeLabel" class="active-date-range" data-testid="list-active-date-range">{{ activeDateRangeLabel }}</span>
    <slot name="expanded-fields" :expanded="expanded" />
    <div class="filter-actions">
      <button class="primary-action" type="button" data-testid="list-query" @click="emit('query')">查询</button>
      <button type="button" data-testid="list-reset" @click="emit('reset')">重置</button>
      <button v-if="hasExpandedFilters" type="button" data-testid="list-toggle-filter" @click="emit('toggle-expanded')">
        {{ expanded ? "收起过滤" : "展开过滤" }}
      </button>
    </div>
    <slot name="preset-row" :expanded="expanded" />
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";

type QuickDateRangeKey = "currentMonth" | "previousMonth" | "currentQuarter" | "previousQuarter" | "currentYear" | "previousYear";

const props = defineProps<{
  keyword: string;
  keywordPlaceholder: string;
  supportsQuickDateFilter: boolean;
  dateFrom: string;
  dateTo: string;
  expanded: boolean;
  hasExpandedFilters: boolean;
}>();

const emit = defineEmits<{
  (event: "update:keyword", value: string): void;
  (event: "update-date-range", value: { from: string; to: string }): void;
  (event: "query"): void;
  (event: "reset"): void;
  (event: "toggle-expanded"): void;
}>();

const quickDateMenuOpen = ref(false);
const dateRangeOpen = ref(false);
const draftDateFrom = ref("");
const draftDateTo = ref("");
const quickDateButton = ref<HTMLElement | null>(null);
const dateRangeButton = ref<HTMLElement | null>(null);
const quickDatePopoverLeft = ref(0);
const quickDatePopoverTop = ref(0);
const dateRangePopoverLeft = ref(0);
const dateRangePopoverTop = ref(0);

const quickDateOptions: Array<{ key: QuickDateRangeKey; label: string }> = [
  { key: "currentMonth", label: "本月" },
  { key: "previousMonth", label: "上月" },
  { key: "currentQuarter", label: "本季度" },
  { key: "previousQuarter", label: "上季度" },
  { key: "currentYear", label: "本年度" },
  { key: "previousYear", label: "上年度" }
];

const quickDatePopoverStyle = computed(() => ({
  left: `${quickDatePopoverLeft.value}px`,
  top: `${quickDatePopoverTop.value}px`,
  width: "160px"
}));

const dateRangePopoverStyle = computed(() => ({
  left: `${dateRangePopoverLeft.value}px`,
  top: `${dateRangePopoverTop.value}px`,
  width: "260px"
}));

const activeDateRangeLabel = computed(() => {
  if (props.dateFrom && props.dateTo) {
    return `${props.dateFrom} 至 ${props.dateTo}`;
  }
  if (props.dateFrom) {
    return `${props.dateFrom} 起`;
  }
  if (props.dateTo) {
    return `截至 ${props.dateTo}`;
  }
  return "";
});

watch(() => [props.dateFrom, props.dateTo], ([from, to]) => {
  if (!dateRangeOpen.value) {
    draftDateFrom.value = from;
    draftDateTo.value = to;
  }
});

function toggleQuickDateMenu() {
  quickDateMenuOpen.value = !quickDateMenuOpen.value;
  if (quickDateMenuOpen.value) {
    placePopover(quickDateButton.value, 160, quickDatePopoverLeft, quickDatePopoverTop);
    dateRangeOpen.value = false;
  }
}

function toggleDateRange() {
  dateRangeOpen.value = !dateRangeOpen.value;
  if (dateRangeOpen.value) {
    placePopover(dateRangeButton.value, 260, dateRangePopoverLeft, dateRangePopoverTop);
    quickDateMenuOpen.value = false;
    draftDateFrom.value = props.dateFrom;
    draftDateTo.value = props.dateTo;
  }
}

function selectQuickDate(key: QuickDateRangeKey) {
  const range = quickDateRange(key, new Date());
  emit("update-date-range", range);
  quickDateMenuOpen.value = false;
}

function applyDateRange() {
  emit("update-date-range", { from: draftDateFrom.value, to: draftDateTo.value });
  dateRangeOpen.value = false;
}

function clearDateRange() {
  draftDateFrom.value = "";
  draftDateTo.value = "";
  emit("update-date-range", { from: "", to: "" });
  dateRangeOpen.value = false;
}

function quickDateRange(key: QuickDateRangeKey, baseDate: Date) {
  const year = baseDate.getFullYear();
  const month = baseDate.getMonth();
  if (key === "currentMonth") {
    return monthRange(year, month);
  }
  if (key === "previousMonth") {
    return monthRange(year, month - 1);
  }
  if (key === "currentQuarter") {
    const quarterStart = Math.floor(month / 3) * 3;
    return {
      from: formatDate(new Date(year, quarterStart, 1)),
      to: formatDate(new Date(year, quarterStart + 3, 0))
    };
  }
  if (key === "previousQuarter") {
    const quarterStart = Math.floor(month / 3) * 3 - 3;
    return {
      from: formatDate(new Date(year, quarterStart, 1)),
      to: formatDate(new Date(year, quarterStart + 3, 0))
    };
  }
  if (key === "currentYear") {
    return { from: `${year}-01-01`, to: `${year}-12-31` };
  }
  return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` };
}

function monthRange(year: number, month: number) {
  return {
    from: formatDate(new Date(year, month, 1)),
    to: formatDate(new Date(year, month + 1, 0))
  };
}

function formatDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function placePopover(anchor: HTMLElement | null, width: number, leftRef: typeof quickDatePopoverLeft, topRef: typeof quickDatePopoverTop) {
  if (!anchor) {
    return;
  }
  const rect = anchor.getBoundingClientRect();
  leftRef.value = Math.min(rect.left, window.innerWidth - width - 8);
  topRef.value = Math.min(rect.bottom + 4, window.innerHeight - 220);
}
</script>
