import { defineAction, type ActionBarItem } from "./actionRegistry";

export interface DocumentActionRuleState {
  locked: boolean;
  canSave: boolean;
  canAudit: boolean;
  canReverse: boolean;
  canRedReverse?: boolean;
  canVoid: boolean;
  canClose?: boolean;
  canUnclose?: boolean;
  canFreeze?: boolean;
  canUnfreeze?: boolean;
  canDelete: boolean;
  canOutput: boolean;
  showCreate?: boolean;
  showSave?: boolean;
  showAudit?: boolean;
  showReverse?: boolean;
  showRedReverse?: boolean;
  showVoid?: boolean;
  showClose?: boolean;
  showUnclose?: boolean;
  showFreeze?: boolean;
  showUnfreeze?: boolean;
  showDelete?: boolean;
  showExport?: boolean;
  showPrint?: boolean;
  showPushDown?: boolean;
  canPushDown?: boolean;
  pushDownLabel?: string;
  pushDownTestId?: string;
  showSourceSelect?: boolean;
  canSourceSelect?: boolean;
  sourceSelectLabel?: string;
  sourceSelectTestId?: string;
  showExtraAction?: boolean;
  canExtraAction?: boolean;
  extraActionLabel?: string;
  extraActionTestId?: string;
}

export const documentLifecycleActionKeys = [
  "create",
  "save",
  "audit",
  "reverse",
  "redReverse",
  "close",
  "unclose",
  "freeze",
  "unfreeze",
  "void",
  "sourceSelect",
  "pushDown",
  "extra",
  "delete",
  "export",
  "print"
] as const;

export type DocumentLifecycleActionKey = typeof documentLifecycleActionKeys[number];

export function buildDocumentActions(state: DocumentActionRuleState): ActionBarItem[] {
  return [
    defineAction("create", { visible: state.showCreate !== false, enabled: !state.locked, testId: "new-document" }),
    defineAction("save", { visible: state.showSave !== false, enabled: !state.locked && state.canSave, testId: "save-sales-order" }),
    defineAction("audit", { visible: state.showAudit !== false, enabled: !state.locked && state.canAudit, testId: "audit-sales-order" }),
    defineAction("reverse", { visible: state.showReverse !== false, enabled: !state.locked && state.canReverse }),
    defineAction("redReverse", { visible: state.showRedReverse !== false && state.canRedReverse === true, enabled: !state.locked && state.canRedReverse === true }),
    defineAction("close", { visible: state.showClose !== false, enabled: !state.locked && state.canClose }),
    defineAction("unclose", { visible: state.showUnclose !== false, enabled: !state.locked && state.canUnclose }),
    defineAction("freeze", { visible: state.showFreeze !== false, enabled: !state.locked && state.canFreeze }),
    defineAction("unfreeze", { visible: state.showUnfreeze !== false, enabled: !state.locked && state.canUnfreeze }),
    defineAction("void", { visible: state.showVoid !== false, enabled: !state.locked && state.canVoid }),
    defineAction("sourceSelect", { visible: state.showSourceSelect, enabled: !state.locked && state.canSourceSelect, label: state.sourceSelectLabel, testId: state.sourceSelectTestId }),
    defineAction("pushDown", { visible: state.showPushDown, enabled: !state.locked && state.canPushDown, label: state.pushDownLabel, testId: state.pushDownTestId }),
    defineAction("extra", { visible: state.showExtraAction, enabled: !state.locked && state.canExtraAction, label: state.extraActionLabel, testId: state.extraActionTestId }),
    defineAction("delete", { visible: state.showDelete !== false, enabled: !state.locked && state.canDelete, testId: "delete-sales-order" }),
    defineAction("export", { visible: state.showExport !== false, enabled: state.canOutput, testId: "export-sales-order" }),
    defineAction("print", { visible: state.showPrint !== false, enabled: state.canOutput, testId: "print-sales-order" })
  ];
}
