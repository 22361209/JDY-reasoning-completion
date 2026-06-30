<template>
  <label :class="labelClasses">
    <span>{{ field.label }}</span>
    <select
      v-if="field.options"
      :value="value"
      :disabled="controlDisabled"
      :data-testid="field.testId"
      @change="emitValue(($event.target as HTMLSelectElement).value)"
    >
      <option v-for="option in field.options" :key="fieldOptionValue(option)" :value="fieldOptionValue(option)">{{ fieldOptionLabel(option) }}</option>
    </select>

    <template v-else-if="usesLookupMenu">
      <span class="master-lookup-control">
        <input
          :value="value"
          :placeholder="field.placeholder"
          :readonly="field.readonly"
          :disabled="disabled"
          :data-testid="field.testId"
          autocomplete="off"
          @focus="emit('lookupOpen', field)"
          @input="emit('lookupInput', field, ($event.target as HTMLInputElement).value)"
          @blur="emit('lookupBlur', field)"
          @keydown="handleLookupKeydown"
        />
        <button
          v-if="showLookupButton"
          class="master-selector__open"
          type="button"
          :data-testid="lookupButtonTestId"
          :disabled="controlDisabled"
          :title="lookupButtonTitle"
          :aria-label="lookupButtonTitle"
          @mousedown.prevent
          @click="emit('lookupButtonClick', field)"
        >{{ lookupButtonLabel }}</button>
        <span v-if="lookupLoading" class="master-lookup-loading">加载中</span>
        <span v-if="lookupOpen" :class="lookupMenuClasses">
          <button
            v-for="(option, optionIndex) in lookupOptions"
            :key="`${field.name}-${option.value}-${option.label}`"
            type="button"
            :class="{ active: optionIndex === lookupHighlightIndex, selected: optionIndex === lookupHighlightIndex }"
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
        :readonly="field.readonly"
        :disabled="disabled"
        :data-testid="field.testId"
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
        :disabled="controlDisabled"
        :data-testid="field.testId"
        @change="emit('fileInput', field, $event)"
      />
      <small>{{ fileText }}</small>
    </span>

    <textarea
      v-else-if="field.type === 'textarea'"
      :value="value"
      :placeholder="field.placeholder"
      rows="3"
      :readonly="field.readonly"
      :disabled="disabled"
      :data-testid="field.testId"
      @input="emitValue(($event.target as HTMLTextAreaElement).value)"
    />

    <span v-else-if="field.type === 'checkbox'" class="master-checkbox-field">
      <input
        type="checkbox"
        :checked="value === 'true'"
        :disabled="controlDisabled"
        :data-testid="field.testId"
        @change="emitValue(($event.target as HTMLInputElement).checked ? 'true' : 'false')"
      />
    </span>

    <input
      v-else
      :value="value"
      :type="field.type === 'number' ? 'number' : 'text'"
      :step="field.type === 'number' ? '0.01' : undefined"
      :placeholder="field.placeholder"
      :readonly="field.readonly"
      :disabled="disabled"
      :data-testid="field.testId"
      @input="emitValue(($event.target as HTMLInputElement).value)"
    />
  </label>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { fieldOptionLabel, fieldOptionValue } from "./fieldOptions";
import type { FieldDefinition, FieldLookupOption } from "./types";

const props = withDefaults(defineProps<{
  field: FieldDefinition;
  value: string;
  disabled?: boolean;
  variant?: "master" | "document";
  lookupMode?: "menu" | "datalist";
  lookupKeyboardMode?: "field" | "native";
  lookupOpen?: boolean;
  lookupLoading?: boolean;
  lookupOptions?: FieldLookupOption[];
  lookupHighlightIndex?: number;
  fileText?: string;
  idPrefix?: string;
  showLookupButton?: boolean;
  lookupButtonTestId?: string;
  lookupButtonTitle?: string;
  lookupButtonLabel?: string;
}>(), {
  disabled: false,
  variant: "master",
  lookupMode: "menu",
  lookupKeyboardMode: "field",
  lookupOpen: false,
  lookupLoading: false,
  lookupOptions: () => [],
  lookupHighlightIndex: 0,
  fileText: "选择文件",
  idPrefix: "field",
  showLookupButton: false,
  lookupButtonTestId: "",
  lookupButtonTitle: "整列表选择",
  lookupButtonLabel: "..."
});

const emit = defineEmits<{
  updateValue: [name: string, value: string];
  lookupOpen: [field: FieldDefinition];
  lookupInput: [field: FieldDefinition, value: string];
  lookupBlur: [field: FieldDefinition];
  lookupMove: [field: FieldDefinition, offset: number];
  lookupConfirm: [field: FieldDefinition];
  lookupKeydown: [field: FieldDefinition, event: KeyboardEvent];
  lookupButtonClick: [field: FieldDefinition];
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

const controlDisabled = computed(() => props.disabled || Boolean(props.field.readonly));

const labelClasses = computed(() => ({
  "field-wide": props.variant === "master" && props.field.span === 2,
  "form-head-field-wide": props.variant === "document" && props.field.span === 3,
  "document-field-span-2": props.variant === "document" && props.field.span === 2,
  "document-field": props.variant === "document",
  required: props.field.required,
  "checkbox-field": props.field.type === "checkbox",
  "lookup-field": usesLookupMenu.value
}));

const lookupMenuClasses = computed(() => ({
  "master-lookup-menu": true,
  "master-selector__menu": props.variant === "document"
}));

function emitValue(value: string) {
  if (props.field.readonly) {
    return;
  }
  emit("updateValue", props.field.name, value);
}

function handleLookupKeydown(event: KeyboardEvent) {
  if (props.lookupKeyboardMode === "native") {
    emit("lookupKeydown", props.field, event);
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    emit("lookupMove", props.field, 1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    emit("lookupMove", props.field, -1);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    emit("lookupConfirm", props.field);
  }
}
</script>
