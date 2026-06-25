<template>
  <MasterDataFormDialog
    :open="open"
    :editing="editing"
    :title="title"
    :fields="productMasterFields"
    :form="form"
    :error="error"
    @close="emit('close')"
    @save="emit('save')"
    @update-field="(name, value) => emit('updateField', name, value)"
  />
</template>

<script setup lang="ts">
import MasterDataFormDialog from "../MasterDataFormDialog.vue";
import { productMasterFields } from "./fields";

defineProps<{
  open: boolean;
  editing: boolean;
  title: string;
  form: Record<string, string>;
  error: string;
}>();

const emit = defineEmits<{
  close: [];
  save: [];
  updateField: [name: string, value: string];
}>();
</script>
