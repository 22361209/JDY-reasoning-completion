import { computed, reactive, ref } from "vue";
import {
  changeSystemPassword,
  loginSystemUser,
  requestPasswordReset,
  type PasswordPolicySettings,
  type SystemSession,
  type SystemUser
} from "../../../services/systemApi";

export function passwordPolicyRules(policy: PasswordPolicySettings, password: string) {
  const rules = [{ label: `至少 ${policy.minLength} 位`, ok: password.length >= policy.minLength }];
  if (policy.requireUppercase) {
    rules.push({ label: "大写字母", ok: /[A-Z]/.test(password) });
  }
  if (policy.requireLowercase) {
    rules.push({ label: "小写字母", ok: /[a-z]/.test(password) });
  }
  if (policy.requireDigit) {
    rules.push({ label: "数字", ok: /\d/.test(password) });
  }
  if (policy.requireSymbol) {
    rules.push({ label: "符号", ok: /[^A-Za-z0-9]/.test(password) });
  }
  return rules;
}

export function useLoginPage() {
  const loginForm = reactive({
    username: "admin",
    password: ""
  });
  const loginMessage = ref("");
  const passwordResetRequestDialogOpen = ref(false);
  const passwordResetRequestMessage = ref("");
  const passwordResetRequestForm = reactive({
    username: "admin",
    contactNote: ""
  });

  async function loginCurrentUser(): Promise<SystemSession | null> {
    loginMessage.value = "";
    const loginResult = await loginSystemUser(loginForm.username, loginForm.password);
    const remoteSession = loginResult.session;
    if (!loginResult.ok || !remoteSession?.authenticated || !remoteSession.user) {
      loginMessage.value = loginResult.message || "账号或密码不正确";
      return null;
    }
    loginForm.password = "";
    return remoteSession;
  }

  function openPasswordResetRequestDialog() {
    passwordResetRequestForm.username = loginForm.username;
    passwordResetRequestForm.contactNote = "";
    passwordResetRequestMessage.value = "";
    passwordResetRequestDialogOpen.value = true;
  }

  function closePasswordResetRequestDialog() {
    passwordResetRequestDialogOpen.value = false;
    passwordResetRequestMessage.value = "";
  }

  async function submitPasswordResetRequest() {
    passwordResetRequestMessage.value = "";
    const result = await requestPasswordReset({
      username: passwordResetRequestForm.username,
      contactNote: passwordResetRequestForm.contactNote
    });
    passwordResetRequestMessage.value = result.message || (result.ok ? "已提交找回申请。" : "找回申请提交失败。");
    if (result.ok) {
      loginMessage.value = passwordResetRequestMessage.value;
      passwordResetRequestForm.contactNote = "";
    }
  }

  function clearPassword(message: string) {
    loginForm.password = "";
    loginMessage.value = message;
  }

  function setUsername(username: string) {
    loginForm.username = username || loginForm.username;
  }

  return {
    loginForm,
    loginMessage,
    passwordResetRequestDialogOpen,
    passwordResetRequestMessage,
    passwordResetRequestForm,
    loginCurrentUser,
    openPasswordResetRequestDialog,
    closePasswordResetRequestDialog,
    submitPasswordResetRequest,
    clearPassword,
    setUsername
  };
}

export function usePasswordChangeDialog(options: {
  passwordPolicy: () => PasswordPolicySettings;
  onChanged: () => Promise<void> | void;
}) {
  const passwordDialogOpen = ref(false);
  const passwordMessage = ref("");
  const passwordForm = reactive({
    currentPassword: "",
    newPassword: "",
    confirmPassword: ""
  });
  const passwordStrengthRules = computed(() => passwordPolicyRules(options.passwordPolicy(), passwordForm.newPassword));
  const passwordStrengthOk = computed(() => passwordStrengthRules.value.every((rule) => rule.ok));

  function openPasswordDialog() {
    resetPasswordForm();
    passwordDialogOpen.value = true;
  }

  function closePasswordDialog() {
    passwordDialogOpen.value = false;
    resetPasswordForm();
  }

  function resetPasswordForm() {
    passwordForm.currentPassword = "";
    passwordForm.newPassword = "";
    passwordForm.confirmPassword = "";
    passwordMessage.value = "";
  }

  async function submitPasswordChange() {
    passwordMessage.value = "";
    if (!passwordStrengthOk.value) {
      passwordMessage.value = "新密码需满足全部强度要求。";
      return;
    }
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      passwordMessage.value = "两次输入的新密码不一致。";
      return;
    }
    const result = await changeSystemPassword({
      currentPassword: passwordForm.currentPassword,
      newPassword: passwordForm.newPassword
    });
    if (!result.ok) {
      passwordMessage.value = result.message || "密码修改失败。";
      return;
    }
    closePasswordDialog();
    await options.onChanged();
  }

  return {
    passwordDialogOpen,
    passwordMessage,
    passwordForm,
    passwordStrengthRules,
    openPasswordDialog,
    closePasswordDialog,
    resetPasswordForm,
    submitPasswordChange
  };
}

export type LoginPageUser = SystemUser;
