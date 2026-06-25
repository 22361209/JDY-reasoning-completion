import { onMounted, reactive, ref } from "vue";
import {
  fetchSecuritySettings,
  saveSecuritySettings,
  type PasswordPolicySettings,
  type RepeatedLoginPolicy,
  type SecuritySettings
} from "../../../services/systemApi";

export function useSecuritySettingsPage(options: {
  canManage: () => boolean;
  onPasswordPolicyUpdated: (policy: PasswordPolicySettings) => void;
}) {
  const securitySettings = ref<SecuritySettings | null>(null);
  const securitySettingsMessage = ref("");
  const securitySessionTimeoutInput = ref<HTMLInputElement | null>(null);
  const securityPasswordMinLengthInput = ref<HTMLInputElement | null>(null);
  const securitySettingsForm = reactive<{
    currentPassword: string;
    repeatedLoginPolicy: RepeatedLoginPolicy;
    sessionTimeoutMinutes: number;
    passwordMinLength: number;
    passwordRequireUppercase: boolean;
    passwordRequireLowercase: boolean;
    passwordRequireDigit: boolean;
    passwordRequireSymbol: boolean;
  }>({
    currentPassword: "",
    repeatedLoginPolicy: "SINGLE_ACTIVE",
    sessionTimeoutMinutes: 30,
    passwordMinLength: 8,
    passwordRequireUppercase: true,
    passwordRequireLowercase: true,
    passwordRequireDigit: true,
    passwordRequireSymbol: true
  });

  onMounted(loadSecuritySettings);

  async function loadSecuritySettings() {
    const result = await fetchSecuritySettings();
    if (!result.ok || !result.data) {
      securitySettingsMessage.value = result.message || "安全设置加载失败。";
      return;
    }
    securitySettings.value = result.data;
    securitySettingsForm.repeatedLoginPolicy = result.data.repeatedLoginPolicy;
    securitySettingsForm.sessionTimeoutMinutes = result.data.sessionTimeoutMinutes;
    applyPasswordPolicyToSecurityForm(result.data.passwordPolicy);
    options.onPasswordPolicyUpdated(result.data.passwordPolicy);
    securitySettingsMessage.value = "";
  }

  async function saveSecuritySettingsAction() {
    if (!options.canManage()) {
      securitySettingsMessage.value = "当前角色无权维护安全设置。";
      return;
    }
    syncSecuritySessionTimeoutInput();
    syncSecurityPasswordMinLengthInput();
    const submittedPolicy = securitySettingsForm.repeatedLoginPolicy;
    const submittedTimeout = securitySettingsForm.sessionTimeoutMinutes;
    const result = await saveSecuritySettings({
      currentPassword: securitySettingsForm.currentPassword,
      repeatedLoginPolicy: securitySettingsForm.repeatedLoginPolicy,
      sessionTimeoutMinutes: securitySettingsForm.sessionTimeoutMinutes,
      passwordMinLength: securitySettingsForm.passwordMinLength,
      passwordRequireUppercase: securitySettingsForm.passwordRequireUppercase,
      passwordRequireLowercase: securitySettingsForm.passwordRequireLowercase,
      passwordRequireDigit: securitySettingsForm.passwordRequireDigit,
      passwordRequireSymbol: securitySettingsForm.passwordRequireSymbol
    });
    if (!result.ok || !result.data) {
      securitySettingsMessage.value = result.message || "安全设置保存失败。";
      return;
    }
    securitySettings.value = {
      ...result.data,
      repeatedLoginPolicy: submittedPolicy,
      sessionTimeoutMinutes: submittedTimeout
    };
    securitySettingsForm.repeatedLoginPolicy = submittedPolicy;
    securitySettingsForm.sessionTimeoutMinutes = submittedTimeout;
    applyPasswordPolicyToSecurityForm(result.data.passwordPolicy);
    options.onPasswordPolicyUpdated(result.data.passwordPolicy);
    securitySettingsForm.currentPassword = "";
    securitySettingsMessage.value = "安全设置已保存";
  }

  function updateSecuritySessionTimeout(event: Event) {
    securitySettingsForm.sessionTimeoutMinutes = normalizeSecuritySessionTimeout((event.target as HTMLInputElement).value);
  }

  function syncSecuritySessionTimeoutInput() {
    securitySettingsForm.sessionTimeoutMinutes = normalizeSecuritySessionTimeout(
      document.querySelector<HTMLInputElement>("[data-testid='security-session-timeout-minutes']")?.value
        ?? securitySessionTimeoutInput.value?.value
        ?? securitySettingsForm.sessionTimeoutMinutes
    );
  }

  function normalizeSecuritySessionTimeout(rawValue: string | number) {
    const value = Number(rawValue);
    return Number.isFinite(value) ? value : 30;
  }

  function updateSecurityPasswordMinLength(event: Event) {
    securitySettingsForm.passwordMinLength = normalizeSecurityPasswordMinLength((event.target as HTMLInputElement).value);
  }

  function syncSecurityPasswordMinLengthInput() {
    securitySettingsForm.passwordMinLength = normalizeSecurityPasswordMinLength(
      document.querySelector<HTMLInputElement>("[data-testid='security-password-min-length']")?.value
        ?? securityPasswordMinLengthInput.value?.value
        ?? securitySettingsForm.passwordMinLength
    );
  }

  function normalizeSecurityPasswordMinLength(rawValue: string | number) {
    const value = Number(rawValue);
    return Number.isFinite(value) ? value : 8;
  }

  function applyPasswordPolicyToSecurityForm(policy: PasswordPolicySettings) {
    securitySettingsForm.passwordMinLength = policy.minLength;
    securitySettingsForm.passwordRequireUppercase = policy.requireUppercase;
    securitySettingsForm.passwordRequireLowercase = policy.requireLowercase;
    securitySettingsForm.passwordRequireDigit = policy.requireDigit;
    securitySettingsForm.passwordRequireSymbol = policy.requireSymbol;
  }

  return {
    securitySettings,
    securitySettingsMessage,
    securitySessionTimeoutInput,
    securityPasswordMinLengthInput,
    securitySettingsForm,
    loadSecuritySettings,
    saveSecuritySettingsAction,
    updateSecuritySessionTimeout,
    updateSecurityPasswordMinLength
  };
}

export function securityPolicyLabel(policy: RepeatedLoginPolicy) {
  return policy === "ALLOW_CONCURRENT" ? "允许多端同时在线" : "后登录踢下线旧会话";
}

export function passwordPolicySummary(policy: PasswordPolicySettings) {
  const parts = [`至少 ${policy.minLength} 位`];
  if (policy.requireUppercase) {
    parts.push("大写");
  }
  if (policy.requireLowercase) {
    parts.push("小写");
  }
  if (policy.requireDigit) {
    parts.push("数字");
  }
  if (policy.requireSymbol) {
    parts.push("符号");
  }
  return parts.join(" / ");
}
