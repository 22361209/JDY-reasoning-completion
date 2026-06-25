import type { Component } from "vue";

export interface MasterDataField {
  name: string;
  label: string;
  placeholder?: string;
  options?: string[];
}

export interface MasterDataDefinition {
  listKey: string;
  type: string;
  fields: MasterDataField[];
  formComponent: Component;
}
