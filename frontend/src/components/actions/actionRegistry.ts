export type ActionVariant = "default" | "primary" | "danger";

export interface RegisteredAction {
  key: string;
  label: string;
  order: number;
  variant?: ActionVariant;
  testId?: string;
}

export interface ActionBarItem extends RegisteredAction {
  visible?: boolean;
  enabled?: boolean;
}

const registeredActions: Record<string, RegisteredAction> = {
  create: { key: "create", label: "新增", order: 10, variant: "primary", testId: "new-document" },
  edit: { key: "edit", label: "编辑", order: 15, testId: "edit-document" },
  save: { key: "save", label: "保存", order: 20, testId: "save-document" },
  refresh: { key: "refresh", label: "刷新", order: 25, testId: "refresh-document" },
  audit: { key: "audit", label: "审核", order: 30, testId: "audit-document" },
  reverse: { key: "reverse", label: "反审核", order: 40, testId: "reverse-document" },
  redReverse: { key: "redReverse", label: "红冲", order: 50, testId: "red-reverse-document" },
  close: { key: "close", label: "关闭", order: 60, testId: "close-document" },
  unclose: { key: "unclose", label: "反关闭", order: 70, testId: "unclose-document" },
  freeze: { key: "freeze", label: "冻结", order: 80, testId: "freeze-document" },
  unfreeze: { key: "unfreeze", label: "解冻", order: 90, testId: "unfreeze-document" },
  void: { key: "void", label: "作废", order: 100, variant: "danger", testId: "void-document" },
  sourceSelect: { key: "sourceSelect", label: "选源单", order: 110, testId: "select-source-document" },
  pushDown: { key: "pushDown", label: "下推", order: 120, testId: "push-down-document" },
  extra: { key: "extra", label: "执行", order: 130, testId: "extra-document-action" },
  delete: { key: "delete", label: "删除", order: 140, testId: "delete-document" },
  importData: { key: "importData", label: "导入", order: 145, testId: "import-document" },
  export: { key: "export", label: "引出", order: 150, testId: "export-document" },
  print: { key: "print", label: "打印", order: 160, testId: "print-document" },
  complete: { key: "complete", label: "完成", order: 165, testId: "complete-document" },
  showList: { key: "showList", label: "列表", order: 166, testId: "show-list" },
  enable: { key: "enable", label: "启用", order: 170, testId: "enable-record" },
  disable: { key: "disable", label: "禁用", order: 170, testId: "disable-record" },
  cancel: { key: "cancel", label: "取消", order: 900, testId: "cancel-document" }
};

export function getRegisteredAction(key: string): RegisteredAction {
  return registeredActions[key] ?? {
    key,
    label: key,
    order: 500,
    testId: `${key}-action`
  };
}

export function defineAction(key: string, overrides: Partial<ActionBarItem> = {}): ActionBarItem {
  const base = getRegisteredAction(key);
  const actionKey = overrides.key ?? key;
  return {
    ...base,
    ...overrides,
    key: actionKey,
    label: overrides.label ?? base.label,
    order: overrides.order ?? base.order,
    variant: overrides.variant ?? base.variant ?? "default",
    testId: overrides.testId ?? base.testId
  };
}

export function normalizeActions(actions: ActionBarItem[]): ActionBarItem[] {
  return actions
    .filter((action) => action.visible !== false)
    .map((action) => ({
      ...action,
      enabled: action.enabled !== false,
      variant: action.variant ?? "default"
    }))
    .sort((left, right) => left.order - right.order);
}
