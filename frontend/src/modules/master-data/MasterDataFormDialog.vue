<template>
  <div v-if="open" class="modal-mask" data-testid="master-create-dialog">
    <div class="dialog master-create-dialog">
      <header class="master-dialog-head">
        <div>
          <h3>{{ editing ? "编辑" : "新增" }}{{ title }}</h3>
        </div>
        <span class="master-dialog-status">{{ form.status || "启用" }}</span>
      </header>
      <div class="master-create-sections">
        <section v-for="section in fieldSections" :key="section.title" class="master-create-section">
          <h4>{{ section.title }}</h4>
          <div class="master-create-fields">
            <label
              v-for="field in section.fields"
              :key="field.name"
              :class="{ 'field-wide': field.span === 2, required: field.required }"
            >
              <span>{{ field.label }}</span>
              <select
                v-if="field.options"
                :value="form[field.name]"
                :disabled="field.readonly || (editing && field.readonlyWhenEditing)"
                @change="emit('updateField', field.name, ($event.target as HTMLSelectElement).value)"
              >
                <option v-for="option in field.options" :key="option" :value="option">{{ option }}</option>
              </select>
              <textarea
                v-else-if="field.type === 'textarea'"
                :value="form[field.name]"
                :placeholder="field.placeholder"
                rows="3"
                :disabled="field.readonly || (editing && field.readonlyWhenEditing)"
                @input="emit('updateField', field.name, ($event.target as HTMLTextAreaElement).value)"
              />
              <span v-else-if="field.type === 'checkbox'" class="master-checkbox-field">
                <input
                  type="checkbox"
                  :checked="form[field.name] === 'true'"
                  :disabled="field.readonly || (editing && field.readonlyWhenEditing)"
                  @change="emit('updateField', field.name, ($event.target as HTMLInputElement).checked ? 'true' : 'false')"
                />
                <em>{{ form[field.name] === "true" ? "是" : "否" }}</em>
              </span>
              <input
                v-else
                :value="form[field.name]"
                :type="field.type === 'number' ? 'number' : 'text'"
                :step="field.type === 'number' ? '0.01' : undefined"
                :placeholder="field.placeholder"
                :disabled="field.readonly || (editing && field.readonlyWhenEditing)"
                @input="emit('updateField', field.name, ($event.target as HTMLInputElement).value)"
              />
            </label>
          </div>
        </section>
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
import { computed } from "vue";
import type { MasterDataField } from "./types";

const props = defineProps<{
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

const fieldSections = computed(() => {
  const groups: { title: string; fields: MasterDataField[] }[] = [];
  props.fields.forEach((field) => {
    const title = field.section || "基本信息";
    let group = groups.find((item) => item.title === title);
    if (!group) {
      group = { title, fields: [] };
      groups.push(group);
    }
    group.fields.push(field);
  });
  return groups;
});
</script>
