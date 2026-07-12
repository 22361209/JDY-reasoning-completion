export interface AnonymousSystemSession {
  authenticated: false;
}

export interface AuthenticatedSystemSession {
  authenticated: true;
  user: { name: string; username?: string; role: string; roleCode?: string; permissionCodes?: string[] };
  tenant: SystemAccountSet;
  period: { accounting: string; business: string };
  security?: { sessionTimeoutMinutes: number; sessionMaxInactiveSeconds: number; passwordPolicy?: PasswordPolicySettings };
}

export type SystemSession = AnonymousSystemSession | AuthenticatedSystemSession;

export interface PublicAccountSetChoice {
  code: string;
  name: string;
}

export interface SystemAccountSet extends PublicAccountSetChoice {
  id?: string;
  environment: string;
  databaseName?: string;
  schemaName?: string;
  attachmentPrefix?: string;
  redisKeyPrefix?: string;
  accountingPeriod?: string;
  businessPeriod?: string;
  enabled?: boolean;
  initialized?: boolean;
  disabledReason?: string;
}

export interface AccountSetBackup {
  id: string;
  backupName: string;
  backupSchemaName: string;
  accountSetCode: string;
  accountSetName: string;
  attachmentPrefix: string;
  tableCount: number;
  rowCount: number;
  createdAt: string;
  restoredAt?: string;
}

export interface AccountSetPayload {
  accountSets: SystemAccountSet[];
  current: SystemAccountSet;
}

export interface SystemUser {
  username: string;
  displayName: string;
  roleCode: string;
  roleName: string;
}

export interface ManagedUser extends SystemUser {
  id: string;
  enabled: boolean;
  accountSetCodes?: string;
  defaultAccountSetCode?: string;
  failedLoginCount?: number;
  locked?: boolean;
  lockedUntil?: string;
  lastLoginAt?: string;
  activeSession?: boolean;
  activeSessionStartedAt?: string;
  lastSessionReplacedAt?: string;
  pendingPasswordReset?: boolean;
}

export interface ManagedRole {
  code: string;
  name: string;
  enabled: boolean;
}

export interface PasswordResetRequestItem {
  id: string;
  username: string;
  displayName: string;
  contactNote: string;
  status: string;
  requestedAt: string;
  handledAt: string;
  handledBy: string;
  handleNote: string;
}

export interface NotificationOutboxItem {
  id: string;
  channel: string;
  templateCode: string;
  recipientUsername: string;
  recipientContact: string;
  title: string;
  body: string;
  sourceType: string;
  sourceId: string;
  status: string;
  provider: string;
  retryCount?: number;
  lastAttemptAt?: string;
  failureReason?: string;
  providerReceiptStatus?: string;
  providerReceiptAt?: string;
  createdAt: string;
  sentAt: string;
}

export interface ManagedUsersPayload {
  users: ManagedUser[];
  roles: ManagedRole[];
  accountSets?: SystemAccountSet[];
  passwordResetRequests: PasswordResetRequestItem[];
  notificationOutbox?: NotificationOutboxItem[];
}

export interface ManagedUsersResult {
  ok: boolean;
  status: number;
  message: string;
  data: ManagedUsersPayload | null;
}

export interface PermissionCatalogItem {
  permissionCode: string;
  moduleName: string;
  permissionName: string;
  sortNo: number;
}

export interface RolePermissionRole {
  id: string;
  code: string;
  name: string;
  enabled: boolean;
  permissionCodes: string[];
}

export interface RolePermissionMatrix {
  permissions: PermissionCatalogItem[];
  roles: RolePermissionRole[];
}

export interface RolePermissionResult {
  ok: boolean;
  status: number;
  message: string;
  data: RolePermissionMatrix | null;
}

export type RepeatedLoginPolicy = "SINGLE_ACTIVE" | "ALLOW_CONCURRENT";

export interface PasswordPolicySettings {
  minLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireDigit: boolean;
  requireSymbol: boolean;
}

export interface SecuritySettings {
  repeatedLoginPolicy: RepeatedLoginPolicy;
  repeatedLoginPolicyLabel: string;
  sessionTimeoutMinutes: number;
  sessionTimeoutSeconds: number;
  passwordPolicy: PasswordPolicySettings;
}

export interface SecuritySettingsResult {
  ok: boolean;
  status: number;
  message: string;
  data: SecuritySettings | null;
}

export type NotificationProviderCode = "LOCAL" | "SIMULATED_HTTP" | "SIMULATED_SMTP";

export interface NotificationProviderSettings {
  providerCode: NotificationProviderCode;
  providerLabel: string;
  senderName: string;
  endpointUrl: string;
  webhookSecretConfigured: boolean;
  dryRun: boolean;
}

export interface NotificationProviderSettingsResult {
  ok: boolean;
  status: number;
  message: string;
  data: NotificationProviderSettings | null;
}

export interface WriteResult {
  ok: boolean;
  status: number;
  message: string;
}

export interface LoginResult {
  ok: boolean;
  status: number;
  message: string;
  session: AuthenticatedSystemSession | null;
}

export async function fetchSystemSession(): Promise<SystemSession | null> {
  try {
    const response = await fetch("/api/system/session");
    if (!response.ok) {
      return null;
    }
    return await response.json() as SystemSession;
  } catch {
    return null;
  }
}

export async function loginSystemUser(username: string, password: string, accountSetCode = ""): Promise<LoginResult> {
  try {
    const response = await fetch("/api/system/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, accountSetCode })
    });
    if (!response.ok) {
      const text = await response.text();
      const parsedMessage = parseErrorMessage(text);
      const fallbackMessage = response.status === 423 ? "账号已锁定，请稍后再试" : "账号或密码不正确";
      const message = parsedMessage && !["Locked", "Unauthorized"].includes(parsedMessage) ? parsedMessage : fallbackMessage;
      return { ok: false, status: response.status, message, session: null };
    }
    return { ok: true, status: response.status, message: "", session: await response.json() as AuthenticatedSystemSession };
  } catch {
    return { ok: false, status: 0, message: "登录失败。", session: null };
  }
}

export async function fetchPublicAccountSetChoices(): Promise<PublicAccountSetChoice[]> {
  try {
    const response = await fetch("/api/system/account-sets");
    if (!response.ok) {
      return [];
    }
    const payload = await response.json() as { accountSets?: PublicAccountSetChoice[] };
    return (payload.accountSets ?? []).map((accountSet) => ({
      code: accountSet.code,
      name: accountSet.name
    }));
  } catch {
    return [];
  }
}

export async function fetchAccountSets(): Promise<AccountSetPayload> {
  try {
    const response = await fetch("/api/system/account-sets");
    if (!response.ok) {
      return { accountSets: [], current: defaultAccountSet() };
    }
    const payload = await response.json() as Partial<AccountSetPayload>;
    return {
      accountSets: payload.accountSets ?? [],
      current: payload.current ?? defaultAccountSet()
    };
  } catch {
    return { accountSets: [], current: defaultAccountSet() };
  }
}

export async function switchCurrentAccountSet(accountSetCode: string): Promise<{ ok: boolean; status: number; message: string; current: SystemAccountSet | null }> {
  try {
    const response = await fetch("/api/system/account-sets/current", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountSetCode })
    });
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, status: response.status, message: parseErrorMessage(text) || "账套切换失败。", current: null };
    }
    const payload = await response.json() as { current?: SystemAccountSet };
    return { ok: true, status: response.status, message: "", current: payload.current ?? null };
  } catch {
    return { ok: false, status: 0, message: "账套切换失败。", current: null };
  }
}

export async function createAccountSet(payload: {
  code: string;
  name: string;
  environment: string;
  accountingPeriod: string;
  businessPeriod: string;
}): Promise<{ ok: boolean; status: number; message: string; accountSet: SystemAccountSet | null; accountSets: SystemAccountSet[] }> {
  try {
    const response = await fetch("/api/system/account-sets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, status: response.status, message: parseErrorMessage(text) || "账套创建失败。", accountSet: null, accountSets: [] };
    }
    const result = await response.json() as { message?: string; accountSet?: SystemAccountSet; accountSets?: SystemAccountSet[] };
    return {
      ok: true,
      status: response.status,
      message: result.message || "账套已创建。",
      accountSet: result.accountSet ?? null,
      accountSets: result.accountSets ?? []
    };
  } catch {
    return { ok: false, status: 0, message: "账套创建失败。", accountSet: null, accountSets: [] };
  }
}

export async function fetchManagedAccountSets(): Promise<AccountSetPayload> {
  try {
    const response = await fetch("/api/system/account-sets/manage");
    if (!response.ok) {
      return { accountSets: [], current: defaultAccountSet() };
    }
    const payload = await response.json() as Partial<AccountSetPayload>;
    return {
      accountSets: payload.accountSets ?? [],
      current: payload.current ?? defaultAccountSet()
    };
  } catch {
    return { accountSets: [], current: defaultAccountSet() };
  }
}

export async function setAccountSetEnabled(accountSetCode: string, enabled: boolean, reason = ""): Promise<{ ok: boolean; status: number; message: string; accountSets: SystemAccountSet[] }> {
  try {
    const response = await fetch(`/api/system/account-sets/${encodeURIComponent(accountSetCode)}/enabled`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, reason })
    });
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, status: response.status, message: parseErrorMessage(text) || "账套状态更新失败。", accountSets: [] };
    }
    const result = await response.json() as { message?: string; accountSets?: SystemAccountSet[] };
    return { ok: true, status: response.status, message: result.message || "账套状态已更新。", accountSets: result.accountSets ?? [] };
  } catch {
    return { ok: false, status: 0, message: "账套状态更新失败。", accountSets: [] };
  }
}

export async function initializeCurrentAccountSet(payload: { clearBusinessData: boolean }): Promise<{ ok: boolean; status: number; message: string; accountSet: SystemAccountSet | null }> {
  try {
    const response = await fetch("/api/system/account-sets/current/initialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, status: response.status, message: parseErrorMessage(text) || "本账套初始化失败。", accountSet: null };
    }
    const result = await response.json() as { message?: string; accountSet?: SystemAccountSet };
    return { ok: true, status: response.status, message: result.message || "本账套已初始化。", accountSet: result.accountSet ?? null };
  } catch {
    return { ok: false, status: 0, message: "本账套初始化失败。", accountSet: null };
  }
}

export async function fetchCurrentAccountSetBackups(): Promise<{ ok: boolean; status: number; message: string; backups: AccountSetBackup[] }> {
  try {
    const response = await fetch("/api/system/account-sets/current/backups");
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, status: response.status, message: parseErrorMessage(text) || "账套备份加载失败。", backups: [] };
    }
    const result = await response.json() as { backups?: AccountSetBackup[] };
    return { ok: true, status: response.status, message: "", backups: result.backups ?? [] };
  } catch {
    return { ok: false, status: 0, message: "账套备份加载失败。", backups: [] };
  }
}

export async function backupCurrentAccountSet(): Promise<{ ok: boolean; status: number; message: string; backup: AccountSetBackup | null; backups: AccountSetBackup[] }> {
  try {
    const response = await fetch("/api/system/account-sets/current/backups", { method: "POST" });
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, status: response.status, message: parseErrorMessage(text) || "账套备份失败。", backup: null, backups: [] };
    }
    const result = await response.json() as { message?: string; backup?: AccountSetBackup; backups?: AccountSetBackup[] };
    return { ok: true, status: response.status, message: result.message || "当前账套已备份。", backup: result.backup ?? null, backups: result.backups ?? [] };
  } catch {
    return { ok: false, status: 0, message: "账套备份失败。", backup: null, backups: [] };
  }
}

export async function restoreCurrentAccountSetBackup(backupName: string): Promise<{ ok: boolean; status: number; message: string; backup: AccountSetBackup | null; backups: AccountSetBackup[] }> {
  try {
    const response = await fetch(`/api/system/account-sets/current/backups/${encodeURIComponent(backupName)}/restore`, { method: "POST" });
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, status: response.status, message: parseErrorMessage(text) || "账套恢复失败。", backup: null, backups: [] };
    }
    const result = await response.json() as { message?: string; backup?: AccountSetBackup; backups?: AccountSetBackup[] };
    return { ok: true, status: response.status, message: result.message || "当前账套已恢复。", backup: result.backup ?? null, backups: result.backups ?? [] };
  } catch {
    return { ok: false, status: 0, message: "账套恢复失败。", backup: null, backups: [] };
  }
}

export async function logoutSystemUser(): Promise<boolean> {
  try {
    const response = await fetch("/api/system/logout", { method: "POST" });
    return response.ok;
  } catch {
    return false;
  }
}

export async function changeSystemPassword(payload: { currentPassword: string; newPassword: string }): Promise<WriteResult> {
  try {
    const response = await fetch("/api/system/password", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, status: response.status, message: text || "密码修改失败。" };
    }
    return { ok: true, status: response.status, message: "" };
  } catch {
    return { ok: false, status: 0, message: "密码修改失败。" };
  }
}

export async function requestPasswordReset(payload: { username: string; contactNote: string }): Promise<WriteResult> {
  try {
    const response = await fetch("/api/system/password-reset-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, status: response.status, message: text || "找回申请提交失败。" };
    }
    const result = await response.json() as { message?: string };
    return { ok: true, status: response.status, message: result.message || "已提交找回申请。" };
  } catch {
    return { ok: false, status: 0, message: "找回申请提交失败。" };
  }
}

export async function fetchManagedUsers(): Promise<ManagedUsersResult> {
  try {
    const response = await fetch("/api/system/managed-users");
    if (!response.ok) {
      return { ok: false, status: response.status, message: response.status === 403 ? "当前角色无权维护用户。" : "用户列表加载失败。", data: null };
    }
    return { ok: true, status: response.status, message: "", data: await response.json() as ManagedUsersPayload };
  } catch {
    return { ok: false, status: 0, message: "用户列表加载失败。", data: null };
  }
}

export async function createManagedUser(payload: {
  username: string;
  displayName: string;
  roleCode: string;
  password: string;
  enabled: boolean;
  accountSetCodes: string[];
  defaultAccountSetCode: string;
}): Promise<ManagedUsersResult> {
  return writeManagedUser("/api/system/managed-users", "POST", payload);
}

export async function updateManagedUser(username: string, payload: {
  displayName: string;
  roleCode: string;
  enabled: boolean;
  accountSetCodes: string[];
  defaultAccountSetCode: string;
}): Promise<ManagedUsersResult> {
  return writeManagedUser(`/api/system/managed-users/${encodeURIComponent(username)}`, "PUT", payload);
}

export async function resetManagedUserPassword(username: string, password: string): Promise<WriteResult> {
  try {
    const response = await fetch(`/api/system/managed-users/${encodeURIComponent(username)}/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, status: response.status, message: text || "密码重置失败。" };
    }
    return { ok: true, status: response.status, message: "" };
  } catch {
    return { ok: false, status: 0, message: "密码重置失败。" };
  }
}

export async function unlockManagedUser(username: string): Promise<ManagedUsersResult> {
  return writeManagedUser(`/api/system/managed-users/${encodeURIComponent(username)}/unlock`, "PUT", {});
}

export async function handlePasswordResetRequest(requestId: string, status: "DONE" | "REJECTED", note: string): Promise<ManagedUsersResult> {
  return writeManagedUser(`/api/system/password-reset-requests/${encodeURIComponent(requestId)}`, "PUT", { status, note });
}

export async function fetchNotificationOutbox(status = ""): Promise<{ ok: boolean; status: number; message: string; data: NotificationOutboxItem[] }> {
  try {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const response = await fetch(`/api/system/notification-outbox${query}`);
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, status: response.status, message: text || "通知列表加载失败。", data: [] };
    }
    const payload = await response.json() as { notificationOutbox?: NotificationOutboxItem[] };
    return { ok: true, status: response.status, message: "", data: payload.notificationOutbox ?? [] };
  } catch {
    return { ok: false, status: 0, message: "通知列表加载失败。", data: [] };
  }
}

export async function resendNotification(notificationId: string): Promise<{ ok: boolean; status: number; message: string; data: NotificationOutboxItem[] }> {
  try {
    const response = await fetch(`/api/system/notification-outbox/${encodeURIComponent(notificationId)}/resend`, { method: "PUT" });
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, status: response.status, message: text || "通知重发失败。", data: [] };
    }
    const payload = await response.json() as { notificationOutbox?: NotificationOutboxItem[] };
    return { ok: true, status: response.status, message: "", data: payload.notificationOutbox ?? [] };
  } catch {
    return { ok: false, status: 0, message: "通知重发失败。", data: [] };
  }
}

export async function syncNotificationReceipt(notificationId: string, payload: { providerReceiptStatus: "DELIVERED" | "FAILED" | "BOUNCED"; providerMessageId?: string; failureReason?: string }): Promise<{ ok: boolean; status: number; message: string; data: NotificationOutboxItem[] }> {
  try {
    const response = await fetch(`/api/system/notification-outbox/${encodeURIComponent(notificationId)}/receipt`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, status: response.status, message: text || "通知回执同步失败。", data: [] };
    }
    const result = await response.json() as { notificationOutbox?: NotificationOutboxItem[] };
    return { ok: true, status: response.status, message: "", data: result.notificationOutbox ?? [] };
  } catch {
    return { ok: false, status: 0, message: "通知回执同步失败。", data: [] };
  }
}

async function writeManagedUser(pathname: string, method: "POST" | "PUT", payload: Record<string, unknown>): Promise<ManagedUsersResult> {
  try {
    const response = await fetch(pathname, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, status: response.status, message: text || "用户保存失败。", data: null };
    }
    return { ok: true, status: response.status, message: "", data: await response.json() as ManagedUsersPayload };
  } catch {
    return { ok: false, status: 0, message: "用户保存失败。", data: null };
  }
}

function parseErrorMessage(text: string) {
  if (!text) {
    return "";
  }
  try {
    const payload = JSON.parse(text) as { message?: string; error?: string };
    return payload.message || payload.error || text;
  } catch {
    return text;
  }
}

function defaultAccountSet(): SystemAccountSet {
  return {
    code: "BLD-TEST",
    name: "博莱德机械测试账套",
    environment: "本地开发",
    accountingPeriod: "2026-06",
    businessPeriod: "2026-06",
    initialized: true
  };
}

export async function fetchRolePermissions(): Promise<RolePermissionResult> {
  try {
    const response = await fetch("/api/system/role-permissions");
    if (!response.ok) {
      return { ok: false, status: response.status, message: "权限矩阵加载失败。", data: null };
    }
    return { ok: true, status: response.status, message: "", data: await response.json() as RolePermissionMatrix };
  } catch {
    return { ok: false, status: 0, message: "权限矩阵加载失败。", data: null };
  }
}

export async function saveRolePermissions(roleCode: string, permissionCodes: string[]): Promise<RolePermissionResult> {
  try {
    const response = await fetch(`/api/system/roles/${encodeURIComponent(roleCode)}/permissions`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permissionCodes })
    });
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, status: response.status, message: text || "权限保存失败。", data: null };
    }
    return { ok: true, status: response.status, message: "", data: await response.json() as RolePermissionMatrix };
  } catch {
    return { ok: false, status: 0, message: "权限保存失败。", data: null };
  }
}

export async function fetchSecuritySettings(): Promise<SecuritySettingsResult> {
  try {
    const response = await fetch("/api/system/security-settings");
    if (!response.ok) {
      return { ok: false, status: response.status, message: response.status === 403 ? "当前角色无权维护安全设置。" : "安全设置加载失败。", data: null };
    }
    return { ok: true, status: response.status, message: "", data: await response.json() as SecuritySettings };
  } catch {
    return { ok: false, status: 0, message: "安全设置加载失败。", data: null };
  }
}

export async function saveSecuritySettings(payload: {
  currentPassword: string;
  repeatedLoginPolicy: RepeatedLoginPolicy;
  sessionTimeoutMinutes: number;
  passwordMinLength: number;
  passwordRequireUppercase: boolean;
  passwordRequireLowercase: boolean;
  passwordRequireDigit: boolean;
  passwordRequireSymbol: boolean;
}): Promise<SecuritySettingsResult> {
  try {
    const response = await fetch("/api/system/security-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, status: response.status, message: parseApiErrorMessage(text, "安全设置保存失败。"), data: null };
    }
    return { ok: true, status: response.status, message: "", data: await response.json() as SecuritySettings };
  } catch {
    return { ok: false, status: 0, message: "安全设置保存失败。", data: null };
  }
}

export async function fetchNotificationProviderSettings(): Promise<NotificationProviderSettingsResult> {
  try {
    const response = await fetch("/api/system/notification-provider-settings");
    if (!response.ok) {
      return { ok: false, status: response.status, message: response.status === 403 ? "当前角色无权维护通知供应商。" : "通知供应商设置加载失败。", data: null };
    }
    return { ok: true, status: response.status, message: "", data: await response.json() as NotificationProviderSettings };
  } catch {
    return { ok: false, status: 0, message: "通知供应商设置加载失败。", data: null };
  }
}

export async function saveNotificationProviderSettings(payload: {
  currentPassword: string;
  providerCode: NotificationProviderCode;
  senderName: string;
  endpointUrl: string;
  webhookSecret: string;
  dryRun: boolean;
}): Promise<NotificationProviderSettingsResult> {
  try {
    const response = await fetch("/api/system/notification-provider-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, status: response.status, message: parseApiErrorMessage(text, "通知供应商设置保存失败。"), data: null };
    }
    return { ok: true, status: response.status, message: "", data: await response.json() as NotificationProviderSettings };
  } catch {
    return { ok: false, status: 0, message: "通知供应商设置保存失败。", data: null };
  }
}

function parseApiErrorMessage(text: string, fallback: string) {
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
