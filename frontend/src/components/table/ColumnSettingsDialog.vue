<template>
  <div v-if="open" class="modal-mask" :data-testid="dialogTestId">
    <div class="dialog column-dialog">
      <h3>{{ title }}</h3>
      <div class="column-setting-list">
        <div v-for="column in columns" :key="column.key || column.field" class="column-setting-row">
          <label><input v-model="column.visible" type="checkbox" :disabled="column.configurable === false" /> {{ column.title }}</label>
          <select v-model="column.fixed" :disabled="column.configurable === false">
            <option value="">不固定</option>
            <option value="left">固定左侧</option>
            <option value="right">固定右侧</option>
          </select>
        </div>
      </div>
      <div class="dialog-actions">
        <button type="button" @click="emit('reset')">恢复默认</button>
        <button class="primary-action" type="button" :data-testid="okTestId" @click="emit('confirm')">确定</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
export interface ColumnSettingItem {
  key?: string;
  field?: string;
  title: string;
  visible: boolean;
  fixed?: "" | "left" | "right";
  configurable?: boolean;
}

defineProps<{
  open: boolean;
  title?: string;
  columns: ColumnSettingItem[];
  dialogTestId: string;
  okTestId: string;
}>();

const emit = defineEmits<{
  reset: [];
  confirm: [];
}>();
</script>
