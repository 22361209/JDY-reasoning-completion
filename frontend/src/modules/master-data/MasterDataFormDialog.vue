<template>
  <div v-if="open" class="modal-mask" data-testid="master-create-dialog">
    <div class="dialog master-create-dialog">
      <h3>{{ editing ? "编辑" : "新增" }}{{ title }}</h3>
      <div class="master-create-fields">
        <label v-for="field in fields" :key="field.name">
          {{ field.label }}
          <select
            v-if="field.options"
            :value="form[field.name]"
            @change="emit('updateField', field.name, ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="option in field.options" :key="option" :value="option">{{ option }}</option>
          </select>
          <input
            v-else
            :value="form[field.name]"
            :placeholder="field.placeholder"
            @input="emit('updateField', field.name, ($event.target as HTMLInputElement).value)"
          />
        </label>
      </div>
      <p v-if="error" class="form-error" data-testid="master-create-error">{{ error }}</p>
      <div class="dialog-actions">
        <button type="button" @click="emit('close')">取消</button>
        <button class="primary-action" type="button" data-testid="master-create-save" @click="emit('save')">保存</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { MasterDataField } from "./types";

defineProps<{
  open: boolean;
  editing: boolean;
  title: string;
  fields: MasterDataField[];
  form: Record<string, string>;
  error: string;
}>();

const emit = defineEmits<{
  close: [];
  save: [];
  updateField: [name: string, value: string];
}>();
</script>
