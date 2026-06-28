import type { Component } from "vue";

export interface MasterDataField {
  name: string;
  label: string;
  placeholder?: string;
  options?: string[];
  section?: string;
  type?: "text" | "number" | "textarea" | "checkbox";
  span?: 1 | 2;
  required?: boolean;
  readonlyWhenEditing?: boolean;
  defaultValue?: string;
}

export interface MasterDataDefinition {
  listKey: string;
  type: string;
  fields: MasterDataField[];
  formComponent: Component;
}
