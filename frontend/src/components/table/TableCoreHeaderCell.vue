<template>
  <div
    class="table-core-header-cell column-header-cell"
    :class="{ dragging, 'drag-over': dragOver, 'has-filter': filterable, 'has-bulk': bulkFillable }"
    :data-testid="testId"
    :data-column-field="columnKey"
    @mousedown.left.stop="emit('dragStart', $event)"
  >
    <span class="column-header-title">{{ title }}</span>
    <span class="column-header-actions">
      <button
        v-if="bulkFillable"
        class="column-bulk-button"
        type="button"
        :class="{ active: bulkFillActive }"
        :title="bulkFillTitle || `${title}批量填充`"
        :data-testid="bulkFillTestId"
        @mousedown.stop
        @click.stop="emit('bulkFill', $event)"
      >
        <span class="sr-only">{{ bulkFillTitle || `${title}批量填充` }}</span>
      </button>
      <button
        v-if="filterable"
        class="column-filter-button"
        type="button"
        :class="{ active: filterActive }"
        :title="filterTitle || `${title}过滤`"
        :data-testid="filterTestId"
        @mousedown.stop
        @click.stop="emit('filter', $event)"
      >
        <span class="sr-only">{{ filterTitle || `${title}过滤` }}</span>
      </button>
    </span>
    <span
      v-if="resizable"
      class="table-core-column-resizer"
      :data-testid="resizeTestId"
      @mousedown.stop.prevent="emit('resizeStart', $event)"
    />
  </div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  title: string;
  columnKey: string;
  testId?: string;
  filterTestId?: string;
  resizeTestId?: string;
  bulkFillTestId?: string;
  filterTitle?: string;
  bulkFillTitle?: string;
  filterable?: boolean;
  filterActive?: boolean;
  bulkFillable?: boolean;
  bulkFillActive?: boolean;
  resizable?: boolean;
  dragging?: boolean;
  dragOver?: boolean;
}>(), {
  filterable: true,
  filterActive: false,
  bulkFillable: false,
  bulkFillActive: false,
  resizable: false,
  dragging: false,
  dragOver: false
});

const emit = defineEmits<{
  dragStart: [event: MouseEvent];
  filter: [event: MouseEvent];
  bulkFill: [event: MouseEvent];
  resizeStart: [event: MouseEvent];
}>();
</script>
