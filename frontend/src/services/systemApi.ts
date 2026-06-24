export interface SystemSession {
  authenticated?: boolean;
  user?: { name: string; username?: string; role: string; roleCode?: string; permissionCodes?: string[] };
  tenant: { name: string; environment: string };
  period: { accounting: string; business: string };
  security?: { sessionTimeoutMinutes: number; sessionMaxInactiveSeconds: number; passwordPolicy?: PasswordPolicySettings };
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

export interface ManagedUsersPayload {
  users: ManagedUser[];
  roles: ManagedRole[];
  passwordResetRequests: PasswordResetRequestItem[];
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

export interface WriteResult {
  ok: boolean;
  status: number;
  message: string;
}

export interface LoginResult {
  ok: boolean;
  status: number;
  message: string;
  session: SystemSession | null;
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

export async function fetchSystemUsers(): Promise<SystemUser[]> {
  try {
    const response = await fetch("/api/system/users");
    if (!response.ok) {
      return [];
    }
    const payload = await response.json() as { users?: SystemUser[] };
    return payload.users ?? [];
  } catch {
    return [];
  }
}

export async function loginSystemUser(username: string, password: string): Promise<LoginResult> {
  try {
    const response = await fetch("/api/system/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    if (!response.ok) {
      const text = await response.text();
      const parsedMessage = parseErrorMessage(text);
      const fallbackMessage = response.status === 423 ? "账号已锁定，请稍后再试" : "账号或密码不正确";
      const message = parsedMessage && !["Locked", "Unauthorized"].includes(parsedMessage) ? parsedMessage : fallbackMessage;
      return { ok: false, status: response.status, message, session: null };
    }
    return { ok: true, status: response.status, message: "", session: await response.json() as SystemSession };
  } catch {
    return { ok: false, status: 0, message: "登录失败。", session: null };
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

export async function createManagedUser(payload: { username: string; displayName: string; roleCode: string; password: string; enabled: boolean }): Promise<ManagedUsersResult> {
  return writeManagedUser("/api/system/managed-users", "POST", payload);
}

export async function updateManagedUser(username: string, payload: { displayName: string; roleCode: string; enabled: boolean }): Promise<ManagedUsersResult> {
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
      return { ok: false, status: response.status, message: text || "安全设置保存失败。", data: null };
    }
    return { ok: true, status: response.status, message: "", data: await response.json() as SecuritySettings };
  } catch {
    return { ok: false, status: 0, message: "安全设置保存失败。", data: null };
  }
}
