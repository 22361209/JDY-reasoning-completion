export interface NumberingRule {
  documentType: string;
  label: string;
  typeCode?: string;
  prefix: string;
  lastNumber: number;
  width: number;
  enabled: boolean;
  updatedAt: string;
}

export interface NumberingRuleResult {
  ok: boolean;
  status: number;
  message: string;
  rules: NumberingRule[];
}

export async function fetchNumberingRules(): Promise<NumberingRuleResult> {
  try {
    const response = await fetch("/api/numbering/rules");
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, status: response.status, message: parseApiError(text, "编号规则加载失败。"), rules: [] };
    }
    const payload = await response.json() as { rules?: NumberingRule[] };
    return { ok: true, status: response.status, message: "", rules: payload.rules ?? [] };
  } catch {
    return { ok: false, status: 0, message: "编号规则加载失败。", rules: [] };
  }
}

export async function saveNumberingRule(rule: NumberingRule): Promise<NumberingRuleResult> {
  try {
    const response = await fetch(`/api/numbering/rules/${encodeURIComponent(rule.documentType)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prefix: rule.prefix,
        width: Number(rule.width),
        lastNumber: Number(rule.lastNumber),
        enabled: Boolean(rule.enabled)
      })
    });
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, status: response.status, message: parseApiError(text, "编号规则保存失败。"), rules: [] };
    }
    const refreshed = await fetchNumberingRules();
    return { ...refreshed, message: "编号规则已保存。" };
  } catch {
    return { ok: false, status: 0, message: "编号规则保存失败。", rules: [] };
  }
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
