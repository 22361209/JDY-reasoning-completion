import type { Component } from "vue";
import type { FieldDefinition } from "../../components/fields/types";
import type { ListColumnDefinition } from "../metadata/types";

export interface MasterDataFieldCondition {
  field: string;
  values: string[];
}

export interface MasterDataField extends FieldDefinition {
  visibleWhen?: MasterDataFieldCondition;
  requiredWhen?: MasterDataFieldCondition;
  clearWhenHidden?: boolean;
}

export interface MasterDataDefinition {
  listKey: string;
  type: string;
  maintainPermission: string;
  title: string;
  keywordPlaceholder: string;
  statuses: string[];
  listColumns: ListColumnDefinition[];
  selectorColumns: ListColumnDefinition[];
  fields: MasterDataField[];
  sparsePatch?: boolean;
  allowDelete?: boolean;
  formComponent?: Component;
}
