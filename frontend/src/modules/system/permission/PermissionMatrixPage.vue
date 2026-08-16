<template>
  <div class="role-permission-page">
    <DocumentCommandHeader
      title="权限矩阵"
      subtitle="按角色维护系统权限，保存后写入后端 RBAC 表。"
      show-subtitle
      status-label="设置"
      status-class="draft"
    >
      <template #actions>
        <ActionBar :actions="permissionActions" @action="handleAction" />
      </template>
    </DocumentCommandHeader>
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
          <strong>{{ page.roleManagementMode.value === "create" ? "新增角色" : page.selectedRole.value?.name || "未选择角色" }}</strong>
          <span>{{ page.roleManagementMode.value === "create" ? "CREATE" : page.selectedRole.value?.code || "" }}</span>
          <em>已勾选 {{ page.selectedRolePermissionCount.value }} 项权限</em>
        </div>
        <section v-if="page.roleManagementMode.value === 'create'" class="role-create-fields" data-testid="role-create-fields">
          <label>
            <span>角色编码</span>
            <input ref="roleCodeInput" v-model="page.newRoleCode.value" data-testid="role-create-code" placeholder="如：PURCHASE_VIEWER" />
          </label>
          <label>
            <span>角色名称</span>
            <input v-model="page.newRoleName.value" data-testid="role-create-name" placeholder="如：采购只读" />
          </label>
        </section>
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
import { computed, nextTick, ref } from "vue";
import ActionBar from "../../../components/ActionBar.vue";
import { defineAction, type ActionBarItem } from "../../../components/actions/actionRegistry";
import DocumentCommandHeader from "../../../components/DocumentCommandHeader.vue";
import { usePermissionMatrixPage } from "./usePermissionMatrixPage";

const props = defineProps<{
  canManage: boolean;
}>();

const page = usePermissionMatrixPage({
  canManage: () => props.canManage
});
const roleCodeInput = ref<HTMLInputElement | null>(null);

const permissionActions = computed<ActionBarItem[]>(() => [
  defineAction("refresh", { enabled: !page.loading.value && !page.saving.value, testId: "role-permission-refresh" }),
  defineAction("create", { enabled: props.canManage && !page.loading.value && !page.saving.value, testId: "role-permission-new" }),
  defineAction("save", { enabled: props.canManage && !page.loading.value && !page.saving.value, testId: "role-permission-save" })
]);

function handleAction(key: string) {
  const handlers: Record<string, () => void> = {
    refresh: () => { void page.loadRolePermissions(); },
    create: () => { void startCreateRole(); },
    save: () => { void page.saveSelectedRolePermissions(); }
  };
  handlers[key]?.();
}

async function startCreateRole() {
  page.startCreateRole();
  await nextTick();
  roleCodeInput.value?.scrollIntoView({ block: "nearest" });
  roleCodeInput.value?.focus();
}
</script>

<style scoped>
.role-create-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 320px));
  gap: 12px;
}

.role-create-fields label {
  display: grid;
  gap: 6px;
  color: #405366;
  font-size: 12px;
}

.role-create-fields input {
  height: 32px;
  border: 1px solid #c7d4e2;
  border-radius: 4px;
  padding: 0 9px;
}
</style>
