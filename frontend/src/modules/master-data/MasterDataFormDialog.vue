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
        <section
          v-for="section in fieldSections"
          :key="section.title"
          class="master-create-section"
          :class="sectionClasses(section)"
        >
          <h4>{{ section.title }}</h4>
          <div class="master-create-fields">
            <FieldRenderer
              v-for="field in section.fields"
              :key="field.name"
              :field="field"
              :value="form[field.name]"
              :disabled="field.readonly || (editing && field.readonlyWhenEditing)"
              lookup-mode="datalist"
              id-prefix="master-dialog"
              @update-value="(name, value) => emit('updateField', name, value)"
            />
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
import FieldRenderer from "../../components/fields/FieldRenderer.vue";
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

function sectionClasses(section: { title: string; fields: MasterDataField[] }) {
  return {
    "section-checkboxes": section.fields.length > 0 && section.fields.every((field) => field.type === "checkbox")
  };
}
</script>
