<template>
  <section class="master-record-page" data-testid="master-record-page">
    <header class="master-record-head">
      <div class="master-record-title-row">
        <h2>{{ editing ? "编辑" : "新增" }}{{ title }}</h2>
        <span class="master-record-status">{{ statusText }} / {{ auditStatusText }}</span>
      </div>
      <div class="master-record-toolbar" role="toolbar" aria-label="主数据动作">
        <button type="button" @click="emit('newRecord')">新增</button>
        <button class="primary-action" type="button" data-testid="master-record-save" @click="emit('save')">保存</button>
        <button type="button" :disabled="!editing || auditStatusText === '已审核'" @click="emit('audit')">审核</button>
        <button type="button" :disabled="!editing || auditStatusText !== '已审核'" @click="emit('reverseAudit')">反审核</button>
        <button type="button" :disabled="!editing" @click="emit('toggleStatus')">{{ statusActionLabel }}</button>
        <button type="button" :disabled="!editing" @click="emit('deleteRecord')">删除</button>
        <button type="button" @click="emit('cancel')">取消</button>
      </div>
    </header>

    <div class="master-record-body">
      <section
        v-for="section in fieldSections"
        :key="section.title"
        class="master-record-section"
        :class="sectionClasses(section)"
      >
        <h3>{{ section.title }}</h3>
        <div class="master-record-fields">
          <label
            v-for="field in section.fields"
            :key="field.name"
            :class="{ 'field-wide': field.span === 2, required: field.required, 'checkbox-field': field.type === 'checkbox' }"
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
            <template v-else-if="field.suggestions">
              <input
                :value="form[field.name]"
                :list="`${recordId}-${field.name}-options`"
                :placeholder="field.placeholder"
                :disabled="field.readonly || (editing && field.readonlyWhenEditing)"
                @input="emit('updateField', field.name, ($event.target as HTMLInputElement).value)"
              />
              <datalist :id="`${recordId}-${field.name}-options`">
                <option v-for="suggestion in field.suggestions" :key="suggestion" :value="suggestion" />
              </datalist>
            </template>
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
  newRecord: [];
  save: [];
  toggleStatus: [];
  audit: [];
  reverseAudit: [];
  deleteRecord: [];
  updateField: [name: string, value: string];
}>();

const statusText = computed(() => props.form.status || "启用");
const auditStatusText = computed(() => props.form.auditStatus || "草稿");
const statusActionLabel = computed(() => statusText.value === "禁用" ? "启用" : "禁用");

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

function sectionClasses(section: { title: string; fields: MasterDataField[] }) {
  return {
    "section-checkboxes": section.fields.length > 0 && section.fields.every((field) => field.type === "checkbox")
  };
}
</script>
