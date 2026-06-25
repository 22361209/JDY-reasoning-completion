<template>
  <div class="role-permission-page">
    <section class="role-permission-head">
      <div>
        <h2>权限矩阵</h2>
        <p>按角色维护系统权限，保存后写入后端 RBAC 表。</p>
      </div>
      <div class="role-permission-head__actions">
        <button type="button" data-testid="role-permission-refresh" @click="page.loadRolePermissions">刷新</button>
        <button class="primary-action" type="button" :disabled="!canManage" data-testid="role-permission-save" @click="page.saveSelectedRolePermissions">保存</button>
      </div>
    </section>
    <section class="role-permission-body">
      <aside class="role-permission-list" aria-label="角色">
        <button
          v-for="role in page.rolePermissionMatrix.value?.roles ?? []"
          :key="role.code"
          type="button"
          :class="{ active: role.code === page.selectedRoleCode.value }"
          :data-testid="`role-permission-role-${role.code}`"
          @click="page.selectRolePermissionRole(role.code)"
        >
          <strong>{{ role.name }}</strong>
          <span>{{ role.code }} / {{ role.enabled ? "启用" : "禁用" }}</span>
        </button>
      </aside>
      <div class="role-permission-matrix">
        <div class="role-permission-summary" data-testid="role-permission-summary">
          <strong>{{ page.selectedRole.value?.name || "未选择角色" }}</strong>
          <span>{{ page.selectedRole.value?.code || "" }}</span>
          <em>已勾选 {{ page.selectedRolePermissionCount.value }} 项权限</em>
        </div>
        <div v-for="group in page.permissionGroups.value" :key="group.moduleName" class="permission-group">
          <h3>{{ group.moduleName }}</h3>
          <div class="permission-grid">
            <label v-for="permission in group.permissions" :key="permission.permissionCode" :data-testid="`permission-cell-${permission.permissionCode}`">
              <input
                type="checkbox"
                :checked="page.rolePermissionChecked(permission.permissionCode)"
                :data-testid="`permission-check-${permission.permissionCode}`"
                @change="page.toggleRolePermission(permission.permissionCode, ($event.target as HTMLInputElement).checked)"
              />
              <span>{{ permission.permissionName }}</span>
              <small>{{ permission.permissionCode }}</small>
            </label>
          </div>
        </div>
        <p v-if="page.rolePermissionMessage.value" class="form-message" data-testid="role-permission-message">{{ page.rolePermissionMessage.value }}</p>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { usePermissionMatrixPage } from "./usePermissionMatrixPage";

const props = defineProps<{
  canManage: boolean;
}>();

const page = usePermissionMatrixPage({
  canManage: () => props.canManage
});
</script>
