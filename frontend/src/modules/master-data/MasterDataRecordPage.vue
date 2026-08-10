<template>
  <section class="master-record-page" :class="pageClasses" data-testid="master-record-page">
    <DocumentCommandHeader
      :title="`${pageModeTitle}${title}`"
      :show-subtitle="false"
      :status-label="statusLabel"
      :status-class="statusClass"
    >
      <template #actions>
        <ActionBar :actions="recordActions" @action="handleAction" />
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
            <FieldRenderer
              v-for="field in section.fields"
              :key="field.name"
              :field="fieldWithTestId(field)"
              :value="form[field.name]"
              :disabled="isFieldDisabled(field)"
              :lookup-open="isLookupOpen(field)"
              :lookup-loading="Boolean(lookupLoading[field.name])"
              :lookup-options="filteredLookupOptions(field)"
              :lookup-highlight-index="lookupHighlightIndex"
              :file-text="fileFieldText(field)"
              id-prefix="master-record"
              @update-value="(name, value) => emit('updateField', name, value)"
              @lookup-open="openLookup"
              @lookup-input="handleLookupInput"
              @lookup-blur="closeLookupLater"
              @lookup-move="moveLookupHighlight"
              @lookup-confirm="confirmLookupHighlight"
              @lookup-select="selectLookupOption"
              @file-input="handleFileInput"
            />
        </div>
      </section>
    </div>

    <p v-if="displayError" class="form-error" data-testid="master-record-error">{{ displayError }}</p>
    <p v-else-if="dirty" class="form-message" data-testid="master-record-dirty-hint">存在未保存修改，请先保存或放弃修改后再执行审核、反审核或启禁用。</p>
    <footer class="master-record-foot" aria-label="主数据底部动作">
      <button class="primary-action" type="button" data-testid="master-record-bottom-save" :disabled="!canSave" @click="requestSave">{{ saveLabel || "保存" }}</button>
      <button v-if="allowDelete" type="button" data-testid="master-record-bottom-delete" :disabled="!canEditSavedDraft" @click="emit('deleteRecord')">删除</button>
    </footer>

    <div v-if="pendingLookupCreate" class="modal-mask" data-testid="master-record-lookup-create-dialog">
      <div class="dialog risky-action-dialog">
        <h3>未找到{{ pendingLookupCreate.label }}</h3>
        <p>“{{ pendingLookupCreate.value }}”尚未维护。是否现在新建？</p>
        <div class="dialog-actions">
          <button type="button" data-testid="master-record-lookup-create-cancel" @click="cancelLookupCreate">否</button>
          <button class="primary-action" type="button" data-testid="master-record-lookup-create-confirm" @click="confirmLookupCreate">是，新建</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import ActionBar from "../../components/ActionBar.vue";
import { defineAction, type ActionBarItem } from "../../components/actions/actionRegistry";
import DocumentCommandHeader from "../../components/DocumentCommandHeader.vue";
import FieldRenderer from "../../components/fields/FieldRenderer.vue";
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
  persisted: boolean;
  dirty: boolean;
  protectAuditedEdit: boolean;
  canMaintain: boolean;
  allowDelete: boolean;
  title: string;
  fields: MasterDataField[];
  form: Record<string, string>;
  originalForm: Record<string, string>;
  recentlyAuditedLookupValues?: Record<string, string>;
  saveLabel?: string;
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
  createLookup: [listKey: string, fieldName: string, value: string];
}>();

const lookupOptions = reactive<Record<string, LookupOption[]>>({});
const lookupLoading = reactive<Record<string, boolean>>({});
const activeLookupField = ref("");
const lookupHighlightIndex = ref(0);
const localError = ref("");
const pendingLookupCreate = ref<{ listKey: string; fieldName: string; label: string; value: string } | null>(null);
const lookupRequestSeq: Record<string, number> = {};
const lookupLoadingRequestSeq: Record<string, number | undefined> = {};
const lookupValidationSeq: Record<string, number> = {};
const lookupQueryTimers: Record<string, number | undefined> = {};
let saveValidationSeq = 0;

const statusText = computed(() => props.form.status || "启用");
const auditStatusText = computed(() => props.form.auditStatus === "未审核" ? "草稿" : props.form.auditStatus || "草稿");
const statusLabel = computed(() => `${statusText.value} / ${auditStatusText.value}`);
const statusClass = computed(() => auditStatusText.value === "已审核" ? "audited" : "draft");
const canSave = computed(() => props.canMaintain && !props.readOnly && auditStatusText.value !== "已审核");
const canEditSavedDraft = computed(() => props.canMaintain && !props.readOnly && !props.dirty && props.editing && auditStatusText.value !== "已审核");
const statusActionLabel = computed(() => statusText.value === "禁用" ? "启用" : "禁用");
const pageModeTitle = computed(() => props.readOnly ? "查看" : props.editing ? "编辑" : "新增");
const displayError = computed(() => localError.value || props.error);
const pageClasses = computed(() => ({
  "master-record-page--product": props.recordId.startsWith("product-master-list")
}));
const recordActions = computed<ActionBarItem[]>(() => [
  defineAction("create", { enabled: props.canMaintain, testId: "master-record-new" }),
  defineAction("edit", {
    visible: props.readOnly,
    enabled: props.canMaintain && (!props.protectAuditedEdit || auditStatusText.value !== "已审核"),
    testId: "master-record-edit"
  }),
  defineAction("save", { label: props.saveLabel || "保存", enabled: canSave.value, testId: "master-record-save" }),
  defineAction("audit", { enabled: props.canMaintain && !props.readOnly && !props.dirty && props.editing && auditStatusText.value !== "已审核", testId: "master-record-audit" }),
  defineAction("reverse", { enabled: props.canMaintain && props.persisted && !props.dirty && auditStatusText.value === "已审核", testId: "master-record-reverse-audit" }),
  defineAction(statusText.value === "禁用" ? "enable" : "disable", { enabled: canEditSavedDraft.value, label: statusActionLabel.value, testId: "master-record-toggle-status" }),
  defineAction("delete", { visible: props.allowDelete, enabled: canEditSavedDraft.value, testId: "master-record-delete" }),
  defineAction("cancel", { enabled: true, testId: "master-record-cancel" })
]);

const fieldSections = computed(() => {
  const groups: { title: string; fields: MasterDataField[] }[] = [];
  props.fields.forEach((field) => {
    if (field.name === "status" || field.hidden || !isFieldVisible(field)) {
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
  cancelPendingLookupQueries();
  activeLookupField.value = "";
  lookupHighlightIndex.value = 0;
  localError.value = "";
  pendingLookupCreate.value = null;
});

function sectionClasses(section: { title: string; fields: MasterDataField[] }) {
  return {
    "section-checkboxes": section.fields.length > 0 && section.fields.every((field) => field.type === "checkbox")
  };
}

function fieldWithTestId(field: MasterDataField): MasterDataField {
  const fieldWithRequired = { ...field, required: isFieldRequired(field) };
  return field.testId ? fieldWithRequired : { ...fieldWithRequired, testId: `master-record-${field.name}` };
}

function conditionMatches(condition: MasterDataField["visibleWhen"] | MasterDataField["requiredWhen"]) {
  return !condition || condition.values.includes(String(props.form[condition.field] ?? ""));
}

function isFieldVisible(field: MasterDataField) {
  return conditionMatches(field.visibleWhen);
}

function isFieldRequired(field: MasterDataField) {
  return Boolean(field.required || (field.requiredWhen && conditionMatches(field.requiredWhen)));
}

function clearInactiveFields() {
  props.fields.forEach((field) => {
    if (field.clearWhenHidden && !isFieldVisible(field) && String(props.form[field.name] ?? "")) {
      emit("updateField", field.name, "");
    }
  });
}

function handleAction(key: string) {
  const handlers: Record<string, () => void> = {
    create: () => emit("newRecord"),
    edit: () => emit("editRecord"),
    save: requestSave,
    audit: () => emit("audit"),
    reverse: () => emit("reverseAudit"),
    enable: () => emit("toggleStatus"),
    disable: () => emit("toggleStatus"),
    delete: () => emit("deleteRecord"),
    cancel: () => emit("cancel")
  };
  handlers[key]?.();
}

function isLookupField(field: MasterDataField) {
  return Boolean(field.lookup || field.suggestions?.length);
}

async function loadLookupOptions() {
  const lookupFields = props.fields.filter((field) => field.lookup);
  await Promise.all(lookupFields.map((field) => queryLookupOptions(field, "", {
    showLoading: true,
    updateCache: true
  })));
}

async function queryLookupOptions(
  field: MasterDataField,
  keyword: string,
  options: { showLoading: boolean; updateCache: boolean }
): Promise<{ options: LookupOption[]; error: string; stale: boolean }> {
  const lookup = field.lookup;
  if (!lookup) {
    return { options: [], error: "", stale: false };
  }
  const requestSeq = (lookupRequestSeq[field.name] ?? 0) + 1;
  lookupRequestSeq[field.name] = requestSeq;
  if (options.showLoading) {
    lookupLoadingRequestSeq[field.name] = requestSeq;
    lookupLoading[field.name] = true;
  }
  try {
    const result = await fetchListRows(lookup.listKey, {
      keyword,
      status: "启用",
      page: 1,
      pageSize: lookup.pageSize ?? 300
    });
    if (requestSeq !== lookupRequestSeq[field.name]) {
      return { options: [], error: "", stale: true };
    }
    if (!result.ok || !result.data) {
      if (options.updateCache) {
        lookupOptions[field.name] = [];
      }
      return { options: [], error: result.message || `${field.label}资料加载失败。`, stale: false };
    }
    const fetchedOptions = result.data.rows
      .filter((row) => String(row.auditStatus ?? "已审核") === "已审核")
      .map((row) => rowToLookupOption(field, row));
    if (options.updateCache) {
      lookupOptions[field.name] = fetchedOptions;
    }
    return { options: fetchedOptions, error: "", stale: false };
  } finally {
    if (options.showLoading && lookupLoadingRequestSeq[field.name] === requestSeq) {
      lookupLoadingRequestSeq[field.name] = undefined;
      lookupLoading[field.name] = false;
    }
  }
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
  const recentlyAuditedValue = props.recentlyAuditedLookupValues?.[field.name]?.trim();
  const recentlyAuditedOption = recentlyAuditedValue ? [{
    value: recentlyAuditedValue,
    label: "",
    secondary: "刚审核的新建资料",
    searchText: normalizeLookupText(recentlyAuditedValue)
  }] : [];
  const staticOptions = (field.suggestions ?? []).map((suggestion) => ({
    value: suggestion,
    label: "",
    secondary: "",
    searchText: normalizeLookupText(suggestion)
  }));
  const deduped = new Map<string, LookupOption>();
  [...recentlyAuditedOption, ...dynamicOptions, ...staticOptions].forEach((option) => {
    const key = normalizeLookupText(option.value);
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
  return Boolean(!props.canMaintain || props.readOnly || auditStatusText.value === "已审核" || field.readonly || (props.editing && field.readonlyWhenEditing));
}

function openLookup(field: MasterDataField) {
  if (isFieldDisabled(field)) {
    return;
  }
  activeLookupField.value = field.name;
  lookupValidationSeq[field.name] = (lookupValidationSeq[field.name] ?? 0) + 1;
  lookupHighlightIndex.value = 0;
  localError.value = "";
}

function handleLookupInput(field: MasterDataField, value: string) {
  if (isFieldDisabled(field)) {
    return;
  }
  emit("updateField", field.name, value);
  saveValidationSeq += 1;
  openLookup(field);
  scheduleLookupQuery(field, value);
}

function scheduleLookupQuery(field: MasterDataField, keyword: string) {
  if (!field.lookup) {
    return;
  }
  const pendingTimer = lookupQueryTimers[field.name];
  if (pendingTimer !== undefined) {
    window.clearTimeout(pendingTimer);
  }
  lookupQueryTimers[field.name] = window.setTimeout(async () => {
    lookupQueryTimers[field.name] = undefined;
    const result = await queryLookupOptions(field, keyword, {
      showLoading: false,
      updateCache: true
    });
    if (result.stale) {
      return;
    }
    if (activeLookupField.value === field.name) {
      lookupHighlightIndex.value = result.options.length > 0 ? 0 : -1;
      if (result.error) {
        localError.value = result.error;
      }
    }
  }, 180);
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
  cancelLookupQueryTimer(field.name);
  const rawValue = String(props.form[field.name] ?? "");
  const validationSeq = (lookupValidationSeq[field.name] ?? 0) + 1;
  lookupValidationSeq[field.name] = validationSeq;
  window.setTimeout(async () => {
    if (validationSeq !== lookupValidationSeq[field.name]
      || normalizeLookupText(props.form[field.name] ?? "") !== normalizeLookupText(rawValue)) {
      return;
    }
    const result = await resolveLookupOptionExactly(field, rawValue);
    if (validationSeq !== lookupValidationSeq[field.name]
      || normalizeLookupText(props.form[field.name] ?? "") !== normalizeLookupText(rawValue)) {
      return;
    }
    if (result.stale) {
      return;
    }
    const resolved = result.option;
    if (resolved) {
      emit("updateField", field.name, resolved.value);
      localError.value = "";
    } else if (result.error) {
      localError.value = result.error;
    } else if (isStrictLookup(field) && String(props.form[field.name] ?? "").trim()) {
      const createListKey = field.lookup?.createListKey;
      if (createListKey) {
        pendingLookupCreate.value = {
          listKey: createListKey,
          fieldName: field.name,
          label: field.label,
          value: String(props.form[field.name] ?? "").trim()
        };
      } else {
        localError.value = `${field.label}需要从已维护资料中选择。`;
      }
    }
    if (activeLookupField.value === field.name) {
      activeLookupField.value = "";
    }
  }, 120);
}

function cancelLookupCreate() {
  const pending = pendingLookupCreate.value;
  pendingLookupCreate.value = null;
  localError.value = `${pending?.label ?? "该资料"}需要从已维护资料中选择。`;
}

function confirmLookupCreate() {
  const pending = pendingLookupCreate.value;
  if (!pending) {
    return;
  }
  pendingLookupCreate.value = null;
  emit("createLookup", pending.listKey, pending.fieldName, pending.value);
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
  lookupValidationSeq[field.name] = (lookupValidationSeq[field.name] ?? 0) + 1;
  saveValidationSeq += 1;
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
  return allLookupOptions(field).find((option) => lookupOptionMatchesExactly(option, value)) ?? null;
}

async function resolveLookupOptionExactly(field: MasterDataField, rawValue: string) {
  const value = normalizeLookupText(rawValue);
  if (!value) {
    return { option: null, error: "", stale: false };
  }
  if (!field.lookup) {
    return { option: resolveLookupOption(field, rawValue), error: "", stale: false };
  }
  const cachedOption = resolveLookupOption(field, rawValue);
  if (cachedOption) {
    return { option: cachedOption, error: "", stale: false };
  }
  const result = await queryLookupOptions(field, rawValue.trim(), {
    showLoading: false,
    updateCache: false
  });
  if (result.stale) {
    return { option: null, error: "", stale: true };
  }
  if (result.error) {
    return { option: null, error: result.error, stale: false };
  }
  const option = result.options.find((candidate) => lookupOptionMatchesExactly(candidate, value)) ?? null;
  if (option) {
    lookupOptions[field.name] = [
      option,
      ...(lookupOptions[field.name] ?? []).filter((candidate) => normalizeLookupText(candidate.value) !== normalizeLookupText(option.value))
    ];
  }
  return { option, error: "", stale: false };
}

function lookupOptionMatchesExactly(option: LookupOption, normalizedValue: string) {
  const labelParts = option.label.split(" / ").map(normalizeLookupText);
  return normalizeLookupText(option.value) === normalizedValue
    || labelParts.includes(normalizedValue)
    || normalizeLookupText(option.secondary) === normalizedValue;
}

function isStrictLookup(field: MasterDataField) {
  if (field.lookup) {
    return field.lookup.strict !== false;
  }
  return Boolean(field.strictSuggestions);
}

async function requestSave() {
  if (!canSave.value) {
    return;
  }
  localError.value = "";
  clearInactiveFields();
  const missingField = props.fields.find((field) => isFieldVisible(field)
    && isFieldRequired(field)
    && !String(props.form[field.name] ?? "").trim());
  if (missingField) {
    localError.value = `${missingField.label}不能为空。`;
    return;
  }
  const validationSeq = saveValidationSeq + 1;
  saveValidationSeq = validationSeq;
  const strictFields = props.fields.filter((field) => {
    if (field.name === "status" || !isFieldVisible(field) || !isStrictLookup(field)) {
      return false;
    }
    const value = String(props.form[field.name] ?? "").trim();
    if (!value) {
      return false;
    }
    if (normalizeLookupText(props.originalForm[field.name] ?? "") === normalizeLookupText(value)) {
      return false;
    }
    return true;
  });
  for (const field of strictFields) {
    cancelLookupQueryTimer(field.name);
    lookupValidationSeq[field.name] = (lookupValidationSeq[field.name] ?? 0) + 1;
    const value = String(props.form[field.name] ?? "").trim();
    const result = await resolveLookupOptionExactly(field, value);
    if (validationSeq !== saveValidationSeq) {
      return;
    }
    if (result.stale) {
      return;
    }
    if (result.error) {
      localError.value = result.error;
      activeLookupField.value = field.name;
      return;
    }
    if (!result.option) {
      localError.value = `${field.label}需要从已维护资料中选择。`;
      activeLookupField.value = field.name;
      return;
    }
    emit("updateField", field.name, result.option.value);
  }
  emit("save");
}

function cancelPendingLookupQueries() {
  const fieldNames = new Set([
    ...Object.keys(lookupQueryTimers),
    ...Object.keys(lookupRequestSeq),
    ...Object.keys(lookupValidationSeq)
  ]);
  fieldNames.forEach((fieldName) => {
    const timer = lookupQueryTimers[fieldName];
    if (timer !== undefined) {
      window.clearTimeout(timer);
      lookupQueryTimers[fieldName] = undefined;
    }
    lookupRequestSeq[fieldName] = (lookupRequestSeq[fieldName] ?? 0) + 1;
    lookupLoadingRequestSeq[fieldName] = undefined;
    lookupValidationSeq[fieldName] = (lookupValidationSeq[fieldName] ?? 0) + 1;
    lookupLoading[fieldName] = false;
  });
  saveValidationSeq += 1;
}

function cancelLookupQueryTimer(fieldName: string) {
  const timer = lookupQueryTimers[fieldName];
  if (timer !== undefined) {
    window.clearTimeout(timer);
    lookupQueryTimers[fieldName] = undefined;
  }
}

onBeforeUnmount(cancelPendingLookupQueries);

watch(
  () => props.fields
    .filter((field) => field.clearWhenHidden && field.visibleWhen)
    .map((field) => `${field.name}:${props.form[field.visibleWhen!.field] ?? ""}`)
    .join("|"),
  clearInactiveFields
);
</script>
