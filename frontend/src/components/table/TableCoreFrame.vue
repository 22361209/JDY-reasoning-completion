<template>
  <div class="table-core-frame" :class="kindClass" :data-testid="testId">
    <slot />
  </div>
</template>

<script setup lang="ts">
const props = withDefaults(defineProps<{
  kind?: "list" | "entry";
  testId?: string;
}>(), {
  kind: "list"
});

const kindClass = `table-core-frame--${props.kind}`;
</script>
