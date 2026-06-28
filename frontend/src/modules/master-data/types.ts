import type { Component } from "vue";
import type { ListColumnDefinition } from "../metadata/types";

export interface MasterDataField {
  name: string;
  label: string;
  placeholder?: string;
  options?: string[];
  suggestions?: string[];
  section?: string;
  type?: "text" | "number" | "textarea" | "checkbox";
  span?: 1 | 2;
  required?: boolean;
  readonly?: boolean;
  readonlyWhenEditing?: boolean;
  defaultValue?: string;
}

export interface MasterDataDefinition {
  listKey: string;
  type: string;
  title: string;
  keywordPlaceholder: string;
  statuses: string[];
  listColumns: ListColumnDefinition[];
  selectorColumns: ListColumnDefinition[];
  fields: MasterDataField[];
  formComponent?: Component;
}
