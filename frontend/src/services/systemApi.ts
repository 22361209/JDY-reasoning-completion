export interface SystemSession {
  authenticated?: boolean;
  user?: { name: string; username?: string; role: string; roleCode?: string; permissionCodes?: string[] };
  tenant: { name: string; environment: string };
  period: { accounting: string; business: string };
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
}

export interface ManagedRole {
  code: string;
  name: string;
  enabled: boolean;
}

export interface ManagedUsersPayload {
  users: ManagedUser[];
  roles: ManagedRole[];
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

export async function loginSystemUser(username: string, password: string): Promise<SystemSession | null> {
  try {
    const response = await fetch("/api/system/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    if (!response.ok) {
      return null;
    }
    return await response.json() as SystemSession;
  } catch {
    return null;
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

export async function resetManagedUserPassword(username: string, password: string): Promise<{ ok: boolean; status: number; message: string }> {
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
