<template>
  <section class="master-record-page" :class="pageClasses" data-testid="master-record-page">
    <DocumentCommandHeader
      :title="`${pageModeTitle}${title}`"
      :show-subtitle="false"
      :status-label="statusLabel"
      :status-class="statusClass"
    >
      <template #actions>
        <button class="primary-action" type="button" @click="emit('newRecord')">新增</button>
        <button v-if="readOnly" type="button" data-testid="master-record-edit" @click="emit('editRecord')">编辑</button>
        <button type="button" data-testid="master-record-save" :disabled="!canSave" @click="requestSave">保存</button>
        <button type="button" :disabled="readOnly || !editing || auditStatusText === '已审核'" @click="emit('audit')">审核</button>
        <button type="button" :disabled="readOnly || !editing || auditStatusText !== '已审核'" @click="emit('reverseAudit')">反审核</button>
        <button type="button" :disabled="!canEditSavedDraft" @click="emit('toggleStatus')">{{ statusActionLabel }}</button>
        <button type="button" :disabled="!canEditSavedDraft" @click="emit('deleteRecord')">删除</button>
        <button type="button" @click="emit('cancel')">取消</button>
      </template>
    </DocumentCommandHeader>

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
            :class="{ 'field-wide': field.span === 2, required: field.required, 'checkbox-field': field.type === 'checkbox', 'lookup-field': isLookupField(field) }"
          >
            <span>{{ field.label }}</span>
            <select
              v-if="field.options"
              :value="form[field.name]"
              :disabled="isFieldDisabled(field)"
              @change="emit('updateField', field.name, ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="option in field.options" :key="option" :value="option">{{ option }}</option>
            </select>
            <template v-else-if="isLookupField(field)">
              <span class="master-lookup-control">
                <input
                  :value="form[field.name]"
                  :placeholder="field.placeholder"
                  :disabled="isFieldDisabled(field)"
                  autocomplete="off"
                  @focus="openLookup(field)"
                  @input="handleLookupInput(field, ($event.target as HTMLInputElement).value)"
                  @blur="closeLookupLater(field)"
                  @keydown.down.prevent="moveLookupHighlight(field, 1)"
                  @keydown.up.prevent="moveLookupHighlight(field, -1)"
                  @keydown.enter.prevent="confirmLookupHighlight(field)"
                />
                <span v-if="lookupLoading[field.name]" class="master-lookup-loading">加载中</span>
                <span v-if="isLookupOpen(field)" class="master-lookup-menu">
                  <button
                    v-for="(option, optionIndex) in filteredLookupOptions(field)"
                    :key="`${field.name}-${option.value}-${option.label}`"
                    type="button"
                    :class="{ active: optionIndex === lookupHighlightIndex }"
                    @mousedown.prevent="selectLookupOption(field, option)"
                  >
                    <strong>{{ option.value }}</strong>
                    <span v-if="option.label">{{ option.label }}</span>
                    <small v-if="option.secondary">{{ option.secondary }}</small>
                  </button>
                  <em v-if="filteredLookupOptions(field).length === 0">没有匹配资料</em>
                </span>
              </span>
            </template>
            <span v-else-if="field.type === 'file'" class="master-file-control">
              <input
                type="file"
                :accept="field.accept"
                :multiple="field.multiple || (field.maxFiles ?? 1) > 1"
                :disabled="isFieldDisabled(field)"
                @change="handleFileInput(field, $event)"
              />
              <small>{{ fileFieldText(field) }}</small>
            </span>
            <textarea
              v-else-if="field.type === 'textarea'"
              :value="form[field.name]"
              :placeholder="field.placeholder"
              rows="3"
              :disabled="isFieldDisabled(field)"
              @input="emit('updateField', field.name, ($event.target as HTMLTextAreaElement).value)"
            />
            <span v-else-if="field.type === 'checkbox'" class="master-checkbox-field">
              <input
                type="checkbox"
                :checked="form[field.name] === 'true'"
                :disabled="isFieldDisabled(field)"
                @change="emit('updateField', field.name, ($event.target as HTMLInputElement).checked ? 'true' : 'false')"
              />
            </span>
            <input
              v-else
              :value="form[field.name]"
              :type="field.type === 'number' ? 'number' : 'text'"
              :step="field.type === 'number' ? '0.01' : undefined"
              :placeholder="field.placeholder"
              :disabled="isFieldDisabled(field)"
              @input="emit('updateField', field.name, ($event.target as HTMLInputElement).value)"
            />
          </label>
        </div>
      </section>
    </div>

    <p v-if="displayError" class="form-error" data-testid="master-record-error">{{ displayError }}</p>
    <footer class="master-record-foot" aria-label="主数据底部动作">
      <button class="primary-action" type="button" data-testid="master-record-bottom-save" :disabled="!canSave" @click="requestSave">保存</button>
      <button type="button" data-testid="master-record-bottom-delete" :disabled="!canEditSavedDraft" @click="emit('deleteRecord')">删除</button>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import DocumentCommandHeader from "../../components/DocumentCommandHeader.vue";
import { fetchListRows } from "../../services/listApi";
import type { MasterDataField } from "./types";

interface LookupOption {
  value: string;
  label: string;
  secondary: string;
  searchText: string;
}

const props = defineProps<{
  recordId: string;
  editing: boolean;
  readOnly: boolean;
  title: string;
  fields: MasterDataField[];
  form: Record<string, string>;
  originalForm: Record<string, string>;
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
  editRecord: [];
  updateField: [name: string, value: string];
}>();

const lookupOptions = reactive<Record<string, LookupOption[]>>({});
const lookupLoading = reactive<Record<string, boolean>>({});
const activeLookupField = ref("");
const lookupHighlightIndex = ref(0);
const localError = ref("");

const statusText = computed(() => props.form.status || "启用");
const auditStatusText = computed(() => props.form.auditStatus || "草稿");
const statusLabel = computed(() => `${statusText.value} / ${auditStatusText.value}`);
const statusClass = computed(() => auditStatusText.value === "已审核" ? "audited" : "draft");
const canSave = computed(() => !props.readOnly && auditStatusText.value !== "已审核");
const canEditSavedDraft = computed(() => !props.readOnly && props.editing && auditStatusText.value !== "已审核");
const statusActionLabel = computed(() => statusText.value === "禁用" ? "启用" : "禁用");
const pageModeTitle = computed(() => props.readOnly ? "查看" : props.editing ? "编辑" : "新增");
const displayError = computed(() => localError.value || props.error);
const pageClasses = computed(() => ({
  "master-record-page--product": props.recordId.startsWith("product-master-list")
}));

const fieldSections = computed(() => {
  const groups: { title: string; fields: MasterDataField[] }[] = [];
  props.fields.forEach((field) => {
    if (field.name === "status") {
      return;
    }
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

watch(
  () => props.fields.map((field) => `${field.name}:${field.lookup?.listKey ?? ""}`).join("|"),
  () => {
    void loadLookupOptions();
  },
  { immediate: true }
);

watch(() => props.recordId, () => {
  activeLookupField.value = "";
  lookupHighlightIndex.value = 0;
  localError.value = "";
});

function sectionClasses(section: { title: string; fields: MasterDataField[] }) {
  return {
    "section-checkboxes": section.fields.length > 0 && section.fields.every((field) => field.type === "checkbox")
  };
}

function isLookupField(field: MasterDataField) {
  return Boolean(field.lookup || field.suggestions?.length);
}

async function loadLookupOptions() {
  const lookupFields = props.fields.filter((field) => field.lookup);
  await Promise.all(lookupFields.map(async (field) => {
    const lookup = field.lookup;
    if (!lookup) {
      return;
    }
    lookupLoading[field.name] = true;
    try {
      const result = await fetchListRows(lookup.listKey, {
        keyword: "",
        status: "启用",
        page: 1,
        pageSize: lookup.pageSize ?? 300
      });
      if (!result.ok || !result.data) {
        lookupOptions[field.name] = [];
        return;
      }
      const auditedRows = result.data.rows.filter((row) => {
        const auditStatus = String(row.auditStatus ?? "已审核");
        return auditStatus === "已审核";
      });
      lookupOptions[field.name] = (auditedRows.length ? auditedRows : result.data.rows).map((row) => rowToLookupOption(field, row));
    } finally {
      lookupLoading[field.name] = false;
    }
  }));
}

function rowToLookupOption(field: MasterDataField, row: Record<string, unknown>): LookupOption {
  const lookup = field.lookup;
  const valueField = lookup?.valueField ?? "code";
  const displayFields = lookup?.displayFields ?? ["code", "name"];
  const searchFields = lookup?.searchFields ?? [];
  const value = String(row[valueField] ?? "").trim();
  const displayValues = displayFields
    .map((name) => String(row[name] ?? "").trim())
    .filter(Boolean);
  const uniqueDisplays = Array.from(new Set(displayValues));
  const label = uniqueDisplays.filter((item) => item !== value).join(" / ");
  const secondary = searchFields
    .map((name) => String(row[name] ?? "").trim())
    .filter(Boolean)
    .join(" / ");
  return {
    value,
    label,
    secondary,
    searchText: normalizeLookupText([value, ...uniqueDisplays, secondary].join(" "))
  };
}

function allLookupOptions(field: MasterDataField) {
  const dynamicOptions = lookupOptions[field.name] ?? [];
  const staticOptions = (field.suggestions ?? []).map((suggestion) => ({
    value: suggestion,
    label: "",
    secondary: "",
    searchText: normalizeLookupText(suggestion)
  }));
  const deduped = new Map<string, LookupOption>();
  [...dynamicOptions, ...staticOptions].forEach((option) => {
    const key = `${option.value}\u0000${option.label}`;
    if (option.value && !deduped.has(key)) {
      deduped.set(key, option);
    }
  });
  return Array.from(deduped.values());
}

function filteredLookupOptions(field: MasterDataField) {
  const keyword = normalizeLookupText(props.form[field.name] ?? "");
  const options = allLookupOptions(field);
  if (!keyword) {
    return options.slice(0, 24);
  }
  return options.filter((option) => option.searchText.includes(keyword)).slice(0, 24);
}

function normalizeLookupText(value: string) {
  return value.trim().toLowerCase();
}

function isLookupOpen(field: MasterDataField) {
  return activeLookupField.value === field.name && !isFieldDisabled(field);
}

function isFieldDisabled(field: MasterDataField) {
  return Boolean(props.readOnly || auditStatusText.value === "已审核" || field.readonly || (props.editing && field.readonlyWhenEditing));
}

function openLookup(field: MasterDataField) {
  if (isFieldDisabled(field)) {
    return;
  }
  activeLookupField.value = field.name;
  lookupHighlightIndex.value = 0;
  localError.value = "";
}

function handleLookupInput(field: MasterDataField, value: string) {
  if (isFieldDisabled(field)) {
    return;
  }
  emit("updateField", field.name, value);
  openLookup(field);
}

async function handleFileInput(field: MasterDataField, event: Event) {
  if (isFieldDisabled(field)) {
    return;
  }
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  if (!files.length) {
    return;
  }
  const maxFiles = field.maxFiles ?? (field.multiple ? files.length : 1);
  if (files.length > maxFiles) {
    localError.value = `${field.label}最多上传 ${maxFiles} 个文件。`;
    input.value = "";
    return;
  }
  const rejectedFile = files.find((file) => !isAcceptedFile(field, file));
  if (rejectedFile) {
    localError.value = `${field.label}文件格式不符合要求：${rejectedFile.name}`;
    input.value = "";
    return;
  }

  localError.value = "";
  emit("updateField", field.name, files.map((file) => file.name).join("; "));
  if (field.fileDataName) {
    try {
      const encodedFiles = await Promise.all(files.map(async (file) => ({
        name: file.name,
        type: file.type,
        size: file.size,
        data: await readFileAsDataUrl(file)
      })));
      emit("updateField", field.fileDataName, JSON.stringify(encodedFiles));
    } catch {
      localError.value = `${field.label}读取失败，请重新选择文件。`;
      input.value = "";
    }
  }
}

function isAcceptedFile(field: MasterDataField, file: File) {
  if (!field.accept) {
    return true;
  }
  const fileName = file.name.toLowerCase();
  const fileType = file.type.toLowerCase();
  return field.accept.split(",").map((item) => item.trim().toLowerCase()).some((rule) => {
    if (!rule) {
      return false;
    }
    if (rule.startsWith(".")) {
      return fileName.endsWith(rule);
    }
    if (rule.endsWith("/*")) {
      return fileType.startsWith(rule.slice(0, -1));
    }
    return fileType === rule;
  });
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}

function fileFieldText(field: MasterDataField) {
  return String(props.form[field.name] ?? "").trim() || field.placeholder || "选择文件";
}

function closeLookupLater(field: MasterDataField) {
  window.setTimeout(() => {
    const resolved = resolveLookupOption(field, props.form[field.name] ?? "");
    if (resolved) {
      emit("updateField", field.name, resolved.value);
      localError.value = "";
    } else if (isStrictLookup(field) && String(props.form[field.name] ?? "").trim()) {
      localError.value = `${field.label}需要从已维护资料中选择。`;
    }
    if (activeLookupField.value === field.name) {
      activeLookupField.value = "";
    }
  }, 120);
}

function moveLookupHighlight(field: MasterDataField, offset: number) {
  const options = filteredLookupOptions(field);
  if (!options.length) {
    lookupHighlightIndex.value = 0;
    return;
  }
  lookupHighlightIndex.value = (lookupHighlightIndex.value + offset + options.length) % options.length;
}

function confirmLookupHighlight(field: MasterDataField) {
  const option = filteredLookupOptions(field)[lookupHighlightIndex.value];
  if (option) {
    selectLookupOption(field, option);
    return;
  }
  const resolved = resolveLookupOption(field, props.form[field.name] ?? "");
  if (resolved) {
    selectLookupOption(field, resolved);
  }
}

function selectLookupOption(field: MasterDataField, option: LookupOption) {
  emit("updateField", field.name, option.value);
  activeLookupField.value = "";
  lookupHighlightIndex.value = 0;
  localError.value = "";
}

function resolveLookupOption(field: MasterDataField, rawValue: string) {
  const value = normalizeLookupText(rawValue);
  if (!value) {
    return null;
  }
  return allLookupOptions(field).find((option) => {
    const labelParts = option.label.split(" / ").map(normalizeLookupText);
    return normalizeLookupText(option.value) === value
      || labelParts.includes(value)
      || normalizeLookupText(option.secondary) === value;
  }) ?? null;
}

function isStrictLookup(field: MasterDataField) {
  if (field.lookup) {
    return field.lookup.strict !== false;
  }
  return Boolean(field.strictSuggestions);
}

function requestSave() {
  if (!canSave.value) {
    return;
  }
  localError.value = "";
  const invalidField = props.fields.find((field) => {
    if (field.name === "status" || !isStrictLookup(field)) {
      return false;
    }
    const value = String(props.form[field.name] ?? "").trim();
    if (!value) {
      return false;
    }
    if (normalizeLookupText(props.originalForm[field.name] ?? "") === normalizeLookupText(value)) {
      return false;
    }
    const resolved = resolveLookupOption(field, value);
    if (resolved) {
      emit("updateField", field.name, resolved.value);
      return false;
    }
    return true;
  });
  if (invalidField) {
    localError.value = `${invalidField.label}需要从已维护资料中选择。`;
    activeLookupField.value = invalidField.name;
    return;
  }
  emit("save");
}
</script>
