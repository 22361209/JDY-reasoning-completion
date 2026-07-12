import { onBeforeUnmount, onMounted, ref, type Ref } from "vue";
import {
  fetchAccountSets,
  fetchPublicAccountSetChoices,
  fetchSystemSession,
  logoutSystemUser,
  type AuthenticatedSystemSession,
  type PasswordPolicySettings,
  type PublicAccountSetChoice,
  type SystemAccountSet
} from "../../services/systemApi";
import { useSessionStore } from "../../stores/session";
import { useTabStore } from "../../stores/tabs";

type LoginPageHandle = {
  setUsername: (username: string) => void;
  clearPassword: (message: string) => void;
};

type PasswordChangeDialogHandle = {
  resetPasswordForm: () => void;
};

const SESSION_EXPIRED_EVENT = "jdy:session-expired";
const SESSION_INVALIDATION_STORAGE_KEY = "jdy:session-invalidation";
type SessionInvalidationReason = "logout" | "password-changed" | "session-expired";
const publicSessionRequests = new Set([
  "GET /api/system/health",
  "GET /api/system/session",
  "GET /api/system/account-sets",
  "POST /api/system/login",
  "POST /api/system/logout",
  "POST /api/system/password-reset-requests"
]);

export function useShellSession(handles: {
  loginPageRef: Ref<LoginPageHandle | null>;
  passwordChangeDialogRef: Ref<PasswordChangeDialogHandle | null>;
}) {
  const session = useSessionStore();
  const tabs = useTabStore();
  const activePasswordPolicy = ref<PasswordPolicySettings>({
    minLength: 8,
    requireUppercase: true,
    requireLowercase: true,
    requireDigit: true,
    requireSymbol: true
  });
  const loginAccountSets = ref<PublicAccountSetChoice[]>([]);
  const accountSets = ref<SystemAccountSet[]>([]);
  const isAuthenticated = ref(false);
  const loginPageMessage = ref("");

  onMounted(async () => {
    installSessionExpiryInterceptor();
    window.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    window.addEventListener("storage", handleSessionStorageEvent);
    window.addEventListener("focus", verifyActiveSession);
    const remoteSession = await fetchSystemSession();
    if (remoteSession?.authenticated) {
      await refreshAuthorizedAccountSets();
      applySystemSession(remoteSession);
      return;
    }
    await refreshPublicAccountSets();
  });

  onBeforeUnmount(() => {
    window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    window.removeEventListener("storage", handleSessionStorageEvent);
    window.removeEventListener("focus", verifyActiveSession);
  });

  function applySystemSession(remoteSession: AuthenticatedSystemSession) {
    session.userName.value = remoteSession.user.name;
    session.userRole.value = remoteSession.user.role;
    session.userRoleCode.value = remoteSession.user.roleCode || "";
    session.permissionCodes.value = remoteSession.user.permissionCodes ?? [];
    session.tenantName.value = remoteSession.tenant.name;
    session.accountSetCode.value = remoteSession.tenant.code || "";
    session.accountSetId.value = remoteSession.tenant.id || "";
    session.accountSetEnvironment.value = remoteSession.tenant.environment || "";
    session.accountSetInitialized.value = Boolean(remoteSession.tenant.initialized);
    session.accountingPeriod.value = remoteSession.period.accounting;
    session.businessPeriod.value = remoteSession.period.business;
    if (remoteSession.security?.passwordPolicy) {
      activePasswordPolicy.value = remoteSession.security.passwordPolicy;
    }
    handles.loginPageRef.value?.setUsername(remoteSession.user.username || "");
    isAuthenticated.value = true;
    loginPageMessage.value = "";
  }

  async function handleLoginSuccess(remoteSession: AuthenticatedSystemSession) {
    await refreshAuthorizedAccountSets();
    applySystemSession(remoteSession);
  }

  async function refreshAuthorizedAccountSets() {
    accountSets.value = (await fetchAccountSets()).accountSets;
  }

  async function refreshPublicAccountSets() {
    loginAccountSets.value = await fetchPublicAccountSetChoices();
  }

  async function logoutCurrentUser() {
    await logoutSystemUser();
    clearLocalSession("已退出登录。", "logout");
  }

  async function handlePasswordChanged() {
    await logoutSystemUser();
    clearLocalSession("密码已修改，请使用新密码重新登录。", "password-changed");
  }

  function handleSessionExpired() {
    clearLocalSession("登录已过期，请重新登录。", "session-expired");
  }

  function clearLocalSession(message: string, reason: SessionInvalidationReason = "session-expired", broadcast = true) {
    isAuthenticated.value = false;
    session.userName.value = "";
    session.userRole.value = "";
    session.userRoleCode.value = "";
    session.permissionCodes.value = [];
    session.accountSetCode.value = "";
    session.accountSetId.value = "";
    session.accountSetInitialized.value = false;
    accountSets.value = [];
    loginPageMessage.value = message;
    handles.loginPageRef.value?.clearPassword(message);
    handles.passwordChangeDialogRef.value?.resetPasswordForm();
    tabs.activeTabId.value = "home";
    void refreshPublicAccountSets();
    if (broadcast) {
      broadcastSessionInvalidation(reason, message);
    }
  }

  function broadcastSessionInvalidation(reason: SessionInvalidationReason, message: string) {
    try {
      localStorage.setItem(SESSION_INVALIDATION_STORAGE_KEY, JSON.stringify({
        reason,
        message,
        timestamp: Date.now()
      }));
    } catch {
      // localStorage can be unavailable in private contexts; local page cleanup still succeeded.
    }
  }

  function handleSessionStorageEvent(event: StorageEvent) {
    if (event.key !== SESSION_INVALIDATION_STORAGE_KEY || !event.newValue) {
      return;
    }
    try {
      const payload = JSON.parse(event.newValue) as { reason?: SessionInvalidationReason; message?: string };
      const message = payload.message || sessionInvalidationMessage(payload.reason);
      clearLocalSession(message, payload.reason ?? "session-expired", false);
    } catch {
      clearLocalSession("登录状态已变化，请重新登录。", "session-expired", false);
    }
  }

  async function verifyActiveSession() {
    if (!isAuthenticated.value) {
      return;
    }
    const remoteSession = await fetchSystemSession();
    if (!remoteSession?.authenticated) {
      clearLocalSession("登录状态已失效，请重新登录。", "session-expired", false);
      return;
    }
    applySystemSession(remoteSession);
  }

  function sessionInvalidationMessage(reason?: SessionInvalidationReason) {
    if (reason === "logout") {
      return "其他标签页已退出登录。";
    }
    if (reason === "password-changed") {
      return "密码已在其他标签页修改，请重新登录。";
    }
    return "登录状态已变化，请重新登录。";
  }

  function installSessionExpiryInterceptor() {
    const runtimeWindow = window as Window & { __jdyFetchWrapped?: boolean; __jdyOriginalFetch?: typeof window.fetch };
    if (runtimeWindow.__jdyFetchWrapped) {
      return;
    }
    runtimeWindow.__jdyFetchWrapped = true;
    runtimeWindow.__jdyOriginalFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await runtimeWindow.__jdyOriginalFetch!(input, init);
      const rawUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      const url = new URL(rawUrl, window.location.origin);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (response.status === 401 && url.pathname.startsWith("/api/") && !publicSessionRequests.has(`${method} ${url.pathname}`)) {
        window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
      }
      return response;
    };
  }

  return {
    activePasswordPolicy,
    loginAccountSets,
    accountSets,
    isAuthenticated,
    loginPageMessage,
    handleLoginSuccess,
    logoutCurrentUser,
    handlePasswordChanged
  };
}
