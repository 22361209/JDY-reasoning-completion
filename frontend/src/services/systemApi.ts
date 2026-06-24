export interface SystemSession {
  user: { name: string; username?: string; role: string; roleCode?: string };
  tenant: { name: string; environment: string };
  period: { accounting: string; business: string };
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
