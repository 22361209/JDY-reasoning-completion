import { computed, reactive, ref, type Ref } from "vue";
import {
  createMasterData,
  deleteMasterData,
  setMasterDataStatus,
  updateMasterData
} from "../../services/listApi";
import { masterDataDefinitions } from "./registry";

export function useMasterDataMaintenance(
  listKey: Ref<string>,
  rows: Ref<Record<string, unknown>[]>,
  selectedRows: Ref<Record<string, unknown>[]>,
  reload: () => Promise<void>
) {
  const createDialogOpen = ref(false);
  const editDialogOpen = ref(false);
  const createError = ref("");
  const editOriginalCode = ref("");
  const form = reactive<Record<string, string>>({});
  const definition = computed(() => masterDataDefinitions[listKey.value] ?? null);
  const isMasterList = computed(() => Boolean(definition.value));
  const formComponent = computed(() => definition.value?.formComponent ?? null);
  const dialogOpen = computed(() => createDialogOpen.value || editDialogOpen.value);
  const editing = computed(() => editDialogOpen.value);

  function openCreateDialog() {
    const masterDefinition = definition.value;
    if (!masterDefinition) {
      return false;
    }
    createError.value = "";
    resetForm();
    masterDefinition.fields.forEach((field) => {
      form[field.name] = field.defaultValue ?? field.options?.[0] ?? "";
    });
    editDialogOpen.value = false;
    createDialogOpen.value = true;
    return true;
  }

  function openEditDialog() {
    const row = actionRows()[0];
    const masterDefinition = definition.value;
    if (!row || !masterDefinition) {
      return false;
    }
    createError.value = "";
    resetForm();
    masterDefinition.fields.forEach((field) => {
      var value = String(row[field.name] ?? "");
      if (field.type === "checkbox") {
        value = value === "是" || value === "true" ? "true" : "false";
      }
      form[field.name] = value;
    });
    form.status = String(row.status ?? "启用");
    editOriginalCode.value = String(row.code ?? "");
    createDialogOpen.value = false;
    editDialogOpen.value = true;
    return true;
  }

  function closeDialog() {
    createDialogOpen.value = false;
    editDialogOpen.value = false;
  }

  function updateField(name: string, value: string) {
    form[name] = value;
  }

  async function submitForm() {
    return editDialogOpen.value ? submitEdit() : submitCreate();
  }

  async function submitCreate() {
    const masterDefinition = definition.value;
    if (!masterDefinition || !validateRequired()) {
      return;
    }
    const result = await createMasterData(masterDefinition.type, { ...form });
    if (!result.ok) {
      createError.value = result.message;
      return;
    }
    createDialogOpen.value = false;
    await reload();
  }

  async function submitEdit() {
    const masterDefinition = definition.value;
    if (!masterDefinition || !validateRequired()) {
      return;
    }
    const result = await updateMasterData(masterDefinition.type, editOriginalCode.value, { ...form });
    if (!result.ok) {
      createError.value = result.message;
      return;
    }
    editDialogOpen.value = false;
    await reload();
  }

  async function submitStatus(enabled: boolean) {
    const masterDefinition = definition.value;
    if (!masterDefinition) {
      return false;
    }
    for (const row of actionRows()) {
      await setMasterDataStatus(masterDefinition.type, String(row.code), enabled);
    }
    await reload();
    return true;
  }

  async function submitDelete() {
    const masterDefinition = definition.value;
    if (!masterDefinition) {
      return false;
    }
    for (const row of actionRows()) {
      await deleteMasterData(masterDefinition.type, String(row.code));
    }
    await reload();
    return true;
  }

  function actionRows() {
    const visibleCodes = new Set(rows.value.map((row) => String(row.code ?? "")));
    const currentSelections = selectedRows.value.filter((row) => visibleCodes.has(String(row.code ?? "")));
    if (currentSelections.length) {
      return currentSelections;
    }
    if (rows.value.length === 1 && selectedRows.value.length === 1) {
      return rows.value;
    }
    return currentSelections;
  }

  function validateRequired() {
    if (!form.code?.trim() || !form.name?.trim()) {
      createError.value = "编码和名称不能为空。";
      return false;
    }
    return true;
  }

  function resetForm() {
    Object.keys(form).forEach((key) => delete form[key]);
  }

  return {
    isMasterList,
    formComponent,
    dialogOpen,
    editing,
    form,
    createError,
    openCreateDialog,
    openEditDialog,
    closeDialog,
    updateField,
    submitForm,
    submitStatus,
    submitDelete
  };
}
