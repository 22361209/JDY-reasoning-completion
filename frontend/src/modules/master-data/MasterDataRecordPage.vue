<template>
  <section class="master-record-page" data-testid="master-record-page">
    <header class="master-record-head">
      <div>
        <h2>{{ editing ? "编辑" : "新增" }}{{ title }}</h2>
      </div>
      <div class="master-record-actions">
        <span class="master-record-status">{{ form.status || "启用" }}</span>
        <button type="button" @click="emit('cancel')">取消</button>
        <button class="primary-action" type="button" data-testid="master-record-save" @click="emit('save')">保存</button>
      </div>
    </header>

    <div class="master-record-body">
      <section v-for="section in fieldSections" :key="section.title" class="master-record-section">
        <h3>{{ section.title }}</h3>
        <div class="master-record-fields">
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
            <input
              v-else-if="field.suggestions"
              :value="form[field.name]"
              :list="`${recordId}-${field.name}-options`"
              :placeholder="field.placeholder"
              :disabled="field.readonly || (editing && field.readonlyWhenEditing)"
              @input="emit('updateField', field.name, ($event.target as HTMLInputElement).value)"
            />
            <datalist v-if="field.suggestions" :id="`${recordId}-${field.name}-options`">
              <option v-for="suggestion in field.suggestions" :key="suggestion" :value="suggestion" />
            </datalist>
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

    <p v-if="error" class="form-error" data-testid="master-record-error">{{ error }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { MasterDataField } from "./types";

const props = defineProps<{
  recordId: string;
  editing: boolean;
  title: string;
  fields: MasterDataField[];
  form: Record<string, string>;
  error: string;
}>();

const emit = defineEmits<{
  cancel: [];
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
