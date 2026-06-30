import type { Component } from "vue";
import type { FieldDefinition } from "../../components/fields/types";
import type { ListColumnDefinition } from "../metadata/types";

export interface MasterDataField extends FieldDefinition {}

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
