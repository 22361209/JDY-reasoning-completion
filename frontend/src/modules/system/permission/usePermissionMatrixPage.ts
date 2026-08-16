import { computed, onMounted, ref } from "vue";
import {
  createRole,
  fetchRolePermissions,
  saveRolePermissions,
  type PermissionCatalogItem,
  type RolePermissionMatrix
} from "../../../services/systemApi";

export function usePermissionMatrixPage(options: { canManage: () => boolean }) {
  const rolePermissionMatrix = ref<RolePermissionMatrix | null>(null);
  const selectedRoleCode = ref("ADMIN");
  const roleManagementMode = ref<"edit" | "create">("edit");
  const newRoleCode = ref("");
  const newRoleName = ref("");
  const rolePermissionDraft = ref<string[]>([]);
  const rolePermissionMessage = ref("");
  const loading = ref(false);
  const saving = ref(false);
  let loadRequestSeq = 0;
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
    const requestSeq = ++loadRequestSeq;
    loading.value = true;
    try {
      const result = await fetchRolePermissions();
      if (requestSeq !== loadRequestSeq) {
        return;
      }
      if (!result.ok || !result.data) {
        rolePermissionMessage.value = result.message;
        return;
      }
      rolePermissionMatrix.value = result.data;
      if (roleManagementMode.value === "create") {
        selectedRoleCode.value = "";
        rolePermissionMessage.value = "";
        return;
      }
      if (!result.data.roles.some((role) => role.code === selectedRoleCode.value)) {
        selectedRoleCode.value = result.data.roles[0]?.code ?? "";
      }
      applySelectedRolePermissions();
      rolePermissionMessage.value = "";
    } finally {
      if (requestSeq === loadRequestSeq) {
        loading.value = false;
      }
    }
  }

  function selectRolePermissionRole(roleCode: string) {
    roleManagementMode.value = "edit";
    selectedRoleCode.value = roleCode;
    applySelectedRolePermissions();
    rolePermissionMessage.value = "";
  }

  function startCreateRole() {
    loadRequestSeq += 1;
    loading.value = false;
    roleManagementMode.value = "create";
    selectedRoleCode.value = "";
    newRoleCode.value = "";
    newRoleName.value = "";
    rolePermissionDraft.value = [];
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
    if (saving.value) {
      return;
    }
    if (!options.canManage()) {
      rolePermissionMessage.value = "当前角色无权维护权限矩阵。";
      return;
    }
    if (roleManagementMode.value === "create") {
      const code = newRoleCode.value.trim().toUpperCase();
      const name = newRoleName.value.trim();
      if (!code || !name) {
        rolePermissionMessage.value = "请填写角色编码和角色名称。";
        return;
      }
      loadRequestSeq += 1;
      loading.value = false;
      saving.value = true;
      try {
        const result = await createRole({ code, name, permissionCodes: rolePermissionDraft.value });
        if (!result.ok || !result.data) {
          rolePermissionMessage.value = result.message || "角色创建失败。";
          return;
        }
        rolePermissionMatrix.value = result.data;
        roleManagementMode.value = "edit";
        selectedRoleCode.value = code;
        applySelectedRolePermissions();
        rolePermissionMessage.value = "角色已创建";
      } finally {
        saving.value = false;
      }
      return;
    }
    if (!selectedRoleCode.value) {
      rolePermissionMessage.value = "请先选择角色。";
      return;
    }
    loadRequestSeq += 1;
    loading.value = false;
    saving.value = true;
    try {
      const result = await saveRolePermissions(selectedRoleCode.value, rolePermissionDraft.value);
      if (!result.ok || !result.data) {
        rolePermissionMessage.value = result.message || "权限保存失败。";
        return;
      }
      rolePermissionMatrix.value = result.data;
      applySelectedRolePermissions();
      rolePermissionMessage.value = "权限矩阵已保存";
    } finally {
      saving.value = false;
    }
  }

  return {
    rolePermissionMatrix,
    selectedRoleCode,
    roleManagementMode,
    newRoleCode,
    newRoleName,
    rolePermissionDraft,
    rolePermissionMessage,
    loading,
    saving,
    selectedRole,
    selectedRolePermissionCount,
    permissionGroups,
    loadRolePermissions,
    selectRolePermissionRole,
    startCreateRole,
    rolePermissionChecked,
    toggleRolePermission,
    saveSelectedRolePermissions
  };
}
