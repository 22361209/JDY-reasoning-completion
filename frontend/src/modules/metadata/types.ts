export type BillModule = "sales" | "purchase" | "production" | "inventory";
export type PartyType = "customer" | "supplier" | "workshop";
export type SourcePolicy = "none" | "salesQuote" | "salesOrder" | "deliveryNotice" | "purchaseOrder" | "productionTask";
export type FieldRenderer = "text" | "number" | "qty" | "price" | "amount" | "date" | "master" | "enum" | "status" | "textarea";

export interface FieldDefinition {
  key: string;
  label: string;
  renderer: FieldRenderer;
  required?: boolean;
  readonly?: boolean;
  width?: number;
  span?: 1 | 2 | 3 | 4;
}

export interface ListColumnDefinition {
  field: string;
  title: string;
  width?: number;
  minWidth?: number;
  fixed?: "" | "left" | "right";
  locked?: boolean;
  reorderable?: boolean;
  align?: "left" | "center" | "right";
  visible: boolean;
}

export interface EntryColumnDefinition extends ListColumnDefinition {
  editable?: boolean;
  renderer?: FieldRenderer;
  bulkFill?: boolean;
}

export type ActionKey =
  | "create"
  | "save"
  | "audit"
  | "reverse"
  | "redReverse"
  | "void"
  | "close"
  | "unclose"
  | "freeze"
  | "unfreeze"
  | "delete"
  | "sourceSelect"
  | "pushDown"
  | "toggleValid"
  | "export"
  | "print";

export interface ActionDefinition {
  key: ActionKey;
  label: string;
  danger?: boolean;
  sourcePolicy?: SourcePolicy;
  permission?: string;
  testId?: string;
}

export interface StatusRuleDefinition {
  status: string;
  editable: boolean;
  allowedActions: ActionKey[];
}

export interface LayoutHintDefinition {
  density: "compact";
  rowHeight: number;
  headerColumns?: number;
  frozenLeftColumns?: number;
}

export interface BillDefinition {
  billType: string;
  listKey: string;
  title: string;
  subtitle: string;
  module: BillModule;
  keywordPlaceholder: string;
  statuses: string[];
  party?: {
    type: PartyType;
    codeLabel: string;
    nameLabel: string;
  };
  sourcePolicy: SourcePolicy;
  headerFields: FieldDefinition[];
  entryColumns: EntryColumnDefinition[];
  listViews: {
    header: ListColumnDefinition[];
    detail: ListColumnDefinition[];
  };
  toolbarActions: ActionDefinition[];
  statusRules: StatusRuleDefinition[];
  layoutHints: LayoutHintDefinition;
}

export interface MasterDataDefinition {
  entityType: "material" | "customer" | "supplier" | "warehouse";
  title: string;
  listColumns: ListColumnDefinition[];
  formSections: Array<{
    title: string;
    fields: FieldDefinition[];
  }>;
  selectorColumns: ListColumnDefinition[];
  statusRules: StatusRuleDefinition[];
}
