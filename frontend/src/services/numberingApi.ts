export interface NumberingRule {
  documentType: string;
  label: string;
  typeCode: string;
  prefix: string;
  lastNumber: string;
  width: number;
  enabled: boolean;
  version: string;
  updatedAt: string;
}

export interface NumberingRuleResult {
  ok: boolean;
  status: number;
  message: string;
  rules: NumberingRule[];
  rule: NumberingRule | null;
}

export async function fetchNumberingRules(): Promise<NumberingRuleResult> {
  try {
    const response = await fetch("/api/numbering/rules");
    if (!response.ok) {
      const text = await response.text();
      return failed(response.status, parseApiError(text, loadFailureMessage(response.status)));
    }
    const payload = await response.json() as { rules?: unknown[] };
    if (!Array.isArray(payload.rules)) {
      return failed(response.status, "编号规则响应格式无效，请刷新后重试。");
    }
    const rules = payload.rules.map(normalizeRule);
    return { ok: true, status: response.status, message: "", rules, rule: null };
  } catch {
    return failed(0, "编号规则加载失败，请检查网络后重试。");
  }
}

export async function saveNumberingRule(rule: NumberingRule): Promise<NumberingRuleResult> {
  try {
    const response = await fetch(`/api/numbering/rules/${encodeURIComponent(rule.documentType)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prefix: rule.prefix,
        width: rule.width,
        lastNumber: rule.lastNumber,
        enabled: rule.enabled,
        version: rule.version
      })
    });
    if (!response.ok) {
      const text = await response.text();
      return failed(response.status, parseApiError(text, saveFailureMessage(response.status)));
    }
    const payload = await response.json() as { rule?: unknown };
    if (!payload.rule) {
      return failed(response.status, "编号规则已提交，但服务端未返回持久化结果，请保留当前输入并重试。");
    }
    const persisted = normalizeRule(payload.rule);
    return {
      ok: true,
      status: response.status,
      message: "编号规则已保存。",
      rules: [persisted],
      rule: persisted
    };
  } catch {
    return failed(0, "编号规则保存失败，请检查网络后重试。");
  }
}

function normalizeRule(value: unknown): NumberingRule {
  if (!value || typeof value !== "object") {
    throw new Error("invalid numbering rule");
  }
  const row = value as Record<string, unknown>;
  const documentType = requiredText(row.documentType);
  const prefix = requiredText(row.prefix);
  const lastNumber = canonicalInteger(row.lastNumber);
  const version = canonicalInteger(row.version);
  const width = Number(row.width);
  if (!Number.isInteger(width) || width < 3 || width > 12 || typeof row.enabled !== "boolean") {
    throw new Error("invalid numbering rule");
  }
  return {
    documentType,
    label: requiredText(row.label),
    typeCode: text(row.typeCode) || documentType,
    prefix,
    lastNumber,
    width,
    enabled: row.enabled,
    version,
    updatedAt: text(row.updatedAt)
  };
}

function canonicalInteger(value: unknown) {
  const normalized = String(value ?? "").trim();
  if (!/^(0|[1-9][0-9]*)$/.test(normalized)) {
    throw new Error("invalid canonical integer");
  }
  return normalized;
}

function requiredText(value: unknown) {
  const normalized = text(value);
  if (!normalized) {
    throw new Error("required text missing");
  }
  return normalized;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function failed(status: number, message: string): NumberingRuleResult {
  return { ok: false, status, message, rules: [], rule: null };
}

function loadFailureMessage(status: number) {
  if (status === 401) return "登录已失效，请重新登录后加载编号规则。";
  if (status === 403) return "当前账号没有编号规则管理权限。";
  return "编号规则加载失败，请稍后重试。";
}

function saveFailureMessage(status: number) {
  if (status === 400) return "编号规则填写不合法，请检查前缀、位数和当前流水。";
  if (status === 401) return "登录已失效，请重新登录后保存。";
  if (status === 403) return "当前账号没有编号规则管理权限。";
  if (status === 409) return "编号规则已变化或当前流水不能回退，请保留输入并重新核对。";
  return "编号规则保存失败，请稍后重试。";
}

function parseApiError(text: string, fallback: string) {
  if (!text) {
    return fallback;
  }
  try {
    const payload = JSON.parse(text) as { message?: string; error?: string };
    return payload.message || payload.error || fallback;
  } catch {
    return text;
  }
}
