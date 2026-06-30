<template>
  <div class="business-head document-head">
    <div class="document-title-row">
      <div>
        <h2>{{ title }}</h2>
        <p v-if="showSubtitle && subtitle">{{ subtitle }}</p>
      </div>
      <div v-if="statusLabel" class="status-stamp" :class="statusClass" data-testid="document-status">{{ statusLabel }}</div>
    </div>
    <div v-if="$slots.actions" class="document-command-actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  title: string;
  subtitle?: string;
  showSubtitle?: boolean;
  statusLabel?: string;
  statusClass?: string;
}>(), {
  subtitle: "",
  showSubtitle: false,
  statusLabel: "",
  statusClass: ""
});
</script>
