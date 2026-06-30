export interface FieldLookupDefinition {
  listKey: string;
  valueField?: string;
  displayFields?: string[];
  searchFields?: string[];
  strict?: boolean;
  pageSize?: number;
}

export interface FieldOptionDefinition {
  value: string;
  label: string;
}

export type FieldOption = string | FieldOptionDefinition;

export interface FieldDefinition {
  name: string;
  label: string;
  placeholder?: string;
  testId?: string;
  options?: FieldOption[];
  suggestions?: string[];
  strictSuggestions?: boolean;
  lookup?: FieldLookupDefinition;
  section?: string;
  type?: "text" | "number" | "textarea" | "checkbox" | "file";
  accept?: string;
  multiple?: boolean;
  maxFiles?: number;
  fileDataName?: string;
  span?: 1 | 2 | 3;
  required?: boolean;
  readonly?: boolean;
  readonlyWhenEditing?: boolean;
  defaultValue?: string;
}

export interface FieldLookupOption {
  value: string;
  label: string;
  secondary: string;
  searchText: string;
}
