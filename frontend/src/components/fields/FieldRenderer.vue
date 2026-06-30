<template>
  <label :class="labelClasses">
    <span>{{ field.label }}</span>
    <select
      v-if="field.options"
      :value="value"
      :disabled="disabled"
      @change="emitValue(($event.target as HTMLSelectElement).value)"
    >
      <option v-for="option in field.options" :key="option" :value="option">{{ option }}</option>
    </select>

    <template v-else-if="usesLookupMenu">
      <span class="master-lookup-control">
        <input
          :value="value"
          :placeholder="field.placeholder"
          :disabled="disabled"
          autocomplete="off"
          @focus="emit('lookupOpen', field)"
          @input="emit('lookupInput', field, ($event.target as HTMLInputElement).value)"
          @blur="emit('lookupBlur', field)"
          @keydown.down.prevent="emit('lookupMove', field, 1)"
          @keydown.up.prevent="emit('lookupMove', field, -1)"
          @keydown.enter.prevent="emit('lookupConfirm', field)"
        />
        <span v-if="lookupLoading" class="master-lookup-loading">加载中</span>
        <span v-if="lookupOpen" class="master-lookup-menu">
          <button
            v-for="(option, optionIndex) in lookupOptions"
            :key="`${field.name}-${option.value}-${option.label}`"
            type="button"
            :class="{ active: optionIndex === lookupHighlightIndex }"
            @mousedown.prevent="emit('lookupSelect', field, option)"
          >
            <strong>{{ option.value }}</strong>
            <span v-if="option.label">{{ option.label }}</span>
            <small v-if="option.secondary">{{ option.secondary }}</small>
          </button>
          <em v-if="lookupOptions.length === 0">没有匹配资料</em>
        </span>
      </span>
    </template>

    <template v-else-if="usesSuggestionList">
      <input
        :value="value"
        :list="suggestionListId"
        :placeholder="field.placeholder"
        :disabled="disabled"
        @input="emitValue(($event.target as HTMLInputElement).value)"
      />
      <datalist :id="suggestionListId">
        <option v-for="suggestion in field.suggestions" :key="suggestion" :value="suggestion" />
      </datalist>
    </template>

    <span v-else-if="field.type === 'file'" class="master-file-control">
      <input
        type="file"
        :accept="field.accept"
        :multiple="field.multiple || (field.maxFiles ?? 1) > 1"
        :disabled="disabled"
        @change="emit('fileInput', field, $event)"
      />
      <small>{{ fileText }}</small>
    </span>

    <textarea
      v-else-if="field.type === 'textarea'"
      :value="value"
      :placeholder="field.placeholder"
      rows="3"
      :disabled="disabled"
      @input="emitValue(($event.target as HTMLTextAreaElement).value)"
    />

    <span v-else-if="field.type === 'checkbox'" class="master-checkbox-field">
      <input
        type="checkbox"
        :checked="value === 'true'"
        :disabled="disabled"
        @change="emitValue(($event.target as HTMLInputElement).checked ? 'true' : 'false')"
      />
    </span>

    <input
      v-else
      :value="value"
      :type="field.type === 'number' ? 'number' : 'text'"
      :step="field.type === 'number' ? '0.01' : undefined"
      :placeholder="field.placeholder"
      :disabled="disabled"
      @input="emitValue(($event.target as HTMLInputElement).value)"
    />
  </label>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { FieldDefinition, FieldLookupOption } from "./types";

const props = withDefaults(defineProps<{
  field: FieldDefinition;
  value: string;
  disabled?: boolean;
  lookupMode?: "menu" | "datalist";
  lookupOpen?: boolean;
  lookupLoading?: boolean;
  lookupOptions?: FieldLookupOption[];
  lookupHighlightIndex?: number;
  fileText?: string;
  idPrefix?: string;
}>(), {
  disabled: false,
  lookupMode: "menu",
  lookupOpen: false,
  lookupLoading: false,
  lookupOptions: () => [],
  lookupHighlightIndex: 0,
  fileText: "选择文件",
  idPrefix: "field"
});

const emit = defineEmits<{
  updateValue: [name: string, value: string];
  lookupOpen: [field: FieldDefinition];
  lookupInput: [field: FieldDefinition, value: string];
  lookupBlur: [field: FieldDefinition];
  lookupMove: [field: FieldDefinition, offset: number];
  lookupConfirm: [field: FieldDefinition];
  lookupSelect: [field: FieldDefinition, option: FieldLookupOption];
  fileInput: [field: FieldDefinition, event: Event];
}>();

const usesLookupMenu = computed(() => {
  return props.lookupMode === "menu" && Boolean(props.field.lookup || props.field.suggestions?.length);
});

const usesSuggestionList = computed(() => {
  return Boolean(props.field.suggestions?.length);
});

const suggestionListId = computed(() => `${props.idPrefix}-${props.field.name}-options`);

const labelClasses = computed(() => ({
  "field-wide": props.field.span === 2,
  required: props.field.required,
  "checkbox-field": props.field.type === "checkbox",
  "lookup-field": usesLookupMenu.value
}));

function emitValue(value: string) {
  emit("updateValue", props.field.name, value);
}
</script>
