import { computed, onMounted, ref } from "vue";
import {
  fetchRolePermissions,
  saveRolePermissions,
  type PermissionCatalogItem,
  type RolePermissionMatrix
} from "../../../services/systemApi";

export function usePermissionMatrixPage(options: { canManage: () => boolean }) {
  const rolePermissionMatrix = ref<RolePermissionMatrix | null>(null);
  const selectedRoleCode = ref("ADMIN");
  const rolePermissionDraft = ref<string[]>([]);
  const rolePermissionMessage = ref("");
  const selectedRole = computed(() => rolePermissionMatrix.value?.roles.find((role) => role.code === selectedRoleCode.value) ?? null);
  const selectedRolePermissionCount = computed(() => rolePermissionDraft.value.length);
  const permissionGroups = computed(() => {
    const grouped = new Map<string, PermissionCatalogItem[]>();
    for (const permission of rolePermissionMatrix.value?.permissions ?? []) {
      const group = grouped.get(permission.moduleName) ?? [];
      group.push(permission);
      grouped.set(permission.moduleName, group);
    }
    return Array.from(grouped.entries()).map(([moduleName, permissions]) => ({ moduleName, permissions }));
  });

  onMounted(loadRolePermissions);

  async function loadRolePermissions() {
    const result = await fetchRolePermissions();
    if (!result.ok || !result.data) {
      rolePermissionMessage.value = result.message;
      return;
    }
    rolePermissionMatrix.value = result.data;
    if (!result.data.roles.some((role) => role.code === selectedRoleCode.value)) {
      selectedRoleCode.value = result.data.roles[0]?.code ?? "";
    }
    applySelectedRolePermissions();
    rolePermissionMessage.value = "";
  }

  function selectRolePermissionRole(roleCode: string) {
    selectedRoleCode.value = roleCode;
    applySelectedRolePermissions();
    rolePermissionMessage.value = "";
  }

  function applySelectedRolePermissions() {
    rolePermissionDraft.value = [...(selectedRole.value?.permissionCodes ?? [])];
  }

  function rolePermissionChecked(permissionCode: string) {
    return rolePermissionDraft.value.includes(permissionCode);
  }

  function toggleRolePermission(permissionCode: string, checked: boolean) {
    const current = new Set(rolePermissionDraft.value);
    if (checked) {
      current.add(permissionCode);
    } else {
      current.delete(permissionCode);
    }
    rolePermissionDraft.value = Array.from(current);
  }

  async function saveSelectedRolePermissions() {
    if (!options.canManage()) {
      rolePermissionMessage.value = "当前角色无权维护权限矩阵。";
      return;
    }
    if (!selectedRoleCode.value) {
      rolePermissionMessage.value = "请先选择角色。";
      return;
    }
    const result = await saveRolePermissions(selectedRoleCode.value, rolePermissionDraft.value);
    if (!result.ok || !result.data) {
      rolePermissionMessage.value = result.message || "权限保存失败。";
      return;
    }
    rolePermissionMatrix.value = result.data;
    applySelectedRolePermissions();
    rolePermissionMessage.value = "权限矩阵已保存";
  }

  return {
    rolePermissionMatrix,
    selectedRoleCode,
    rolePermissionDraft,
    rolePermissionMessage,
    selectedRole,
    selectedRolePermissionCount,
    permissionGroups,
    loadRolePermissions,
    selectRolePermissionRole,
    rolePermissionChecked,
    toggleRolePermission,
    saveSelectedRolePermissions
  };
}
