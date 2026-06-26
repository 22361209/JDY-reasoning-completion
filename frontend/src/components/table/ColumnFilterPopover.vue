<template>
  <div
    v-if="open"
    class="column-filter-popover"
    :style="{ left: `${left}px`, top: `${top}px` }"
    :data-testid="testId"
  >
    <div class="filter-operator-list">
      <button
        v-for="option in operators"
        :key="option"
        type="button"
        :class="{ active: operator === option }"
        @click="emit('update:operator', option)"
      >
        {{ option }}
      </button>
    </div>
    <div class="column-filter-input-row">
      <input
        :value="value"
        data-testid="column-filter-input"
        placeholder="输入过滤关键字"
        @input="emit('update:value', ($event.target as HTMLInputElement).value)"
        @keydown.enter="emit('apply')"
      />
    </div>
    <div class="column-filter-actions">
      <button type="button" @click="emit('clear')">重置</button>
      <button class="primary-action" type="button" data-testid="column-filter-ok" @click="emit('apply')">确定</button>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  open: boolean;
  operators: string[];
  operator: string;
  value: string;
  left: number;
  top: number;
  testId?: string;
}>();

const emit = defineEmits<{
  "update:operator": [value: string];
  "update:value": [value: string];
  apply: [];
  clear: [];
}>();
</script>
