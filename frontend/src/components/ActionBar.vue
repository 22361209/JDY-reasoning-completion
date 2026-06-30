<template>
  <div class="action-bar" :class="barClass">
    <button
      v-for="action in normalizedActions"
      :key="action.key"
      type="button"
      :class="buttonClass(action)"
      :disabled="!action.enabled"
      :data-testid="action.testId"
      @click="emit('action', action.key)"
    >
      {{ action.label }}
    </button>
    <slot />
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { ActionBarItem } from "./actions/actionRegistry";
import { normalizeActions } from "./actions/actionRegistry";

const props = withDefaults(defineProps<{
  actions: ActionBarItem[];
  barClass?: string;
}>(), {
  barClass: ""
});

const emit = defineEmits<{
  action: [key: string];
}>();

const normalizedActions = computed(() => normalizeActions(props.actions));

function buttonClass(action: ActionBarItem) {
  return {
    "primary-action": action.variant === "primary",
    "danger-action": action.variant === "danger"
  };
}
</script>
