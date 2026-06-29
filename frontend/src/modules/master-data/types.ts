import type { Component } from "vue";
import type { ListColumnDefinition } from "../metadata/types";

export interface MasterDataField {
  name: string;
  label: string;
  placeholder?: string;
  options?: string[];
  suggestions?: string[];
  strictSuggestions?: boolean;
  lookup?: {
    listKey: string;
    valueField?: string;
    displayFields?: string[];
    searchFields?: string[];
    strict?: boolean;
    pageSize?: number;
  };
  section?: string;
  type?: "text" | "number" | "textarea" | "checkbox" | "file";
  accept?: string;
  multiple?: boolean;
  maxFiles?: number;
  fileDataName?: string;
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
