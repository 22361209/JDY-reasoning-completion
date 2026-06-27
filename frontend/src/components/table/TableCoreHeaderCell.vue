<template>
  <div
    class="table-core-header-cell column-header-cell"
    :class="{ dragging, 'drag-over': dragOver }"
    :data-testid="testId"
    :data-column-field="columnKey"
    @mousedown.left.stop="emit('dragStart', $event)"
  >
    <span class="column-header-title">{{ title }}</span>
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
  filterTitle?: string;
  filterable?: boolean;
  filterActive?: boolean;
  resizable?: boolean;
  dragging?: boolean;
  dragOver?: boolean;
}>(), {
  filterable: true,
  filterActive: false,
  resizable: false,
  dragging: false,
  dragOver: false
});

const emit = defineEmits<{
  dragStart: [event: MouseEvent];
  filter: [event: MouseEvent];
  resizeStart: [event: MouseEvent];
}>();
</script>
