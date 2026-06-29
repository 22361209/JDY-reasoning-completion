<template>
  <div class="role-permission-page">
    <section class="role-permission-head">
      <div>
        <h2>用户角色</h2>
        <p>维护员工账号、启停状态和角色归属，角色权限细项在权限矩阵中维护。</p>
      </div>
      <div class="role-permission-head__actions">
        <button type="button" data-testid="user-management-refresh" @click="page.loadManagedUsers">刷新</button>
        <button class="primary-action" type="button" :disabled="!canManage" data-testid="user-management-new" @click="page.startCreateManagedUser">新增</button>
        <button class="primary-action" type="button" :disabled="!canManage" data-testid="user-management-save" @click="page.saveManagedUser">保存</button>
      </div>
    </section>
    <section class="role-permission-body">
      <aside class="role-permission-list" aria-label="用户">
        <button
          v-for="user in page.managedUsers.value"
          :key="user.username"
          type="button"
          :class="{ active: user.username === page.selectedManagedUsername.value }"
          :data-testid="`managed-user-${user.username}`"
          @click="page.selectManagedUser(user.username)"
        >
          <strong>{{ user.displayName }}</strong>
          <span>{{ user.username }} / {{ user.roleName }} / {{ page.managedUserStateLabel(user) }}</span>
        </button>
      </aside>
      <div class="user-management-form">
        <div class="role-permission-summary" data-testid="user-management-summary">
          <strong>{{ page.userManagementMode.value === "create" ? "新增用户" : page.selectedManagedUser.value?.displayName || "未选择用户" }}</strong>
          <span>{{ page.userManagementMode.value === "create" ? "CREATE" : page.selectedManagedUser.value?.username || "" }}</span>
          <em>{{ page.selectedManagedUser.value ? page.managedUserStateLabel(page.selectedManagedUser.value) : "选择角色后保存" }}</em>
        </div>
        <dl v-if="page.selectedManagedUser.value && page.userManagementMode.value === 'edit'" class="user-security-summary" data-testid="user-security-summary">
          <div>
            <dt>失败次数</dt>
            <dd data-testid="managed-user-failed-count">{{ page.selectedManagedUser.value.failedLoginCount ?? 0 }}</dd>
          </div>
          <div>
            <dt>锁定状态</dt>
            <dd data-testid="managed-user-lock-state">{{ page.selectedManagedUser.value.locked ? `已锁定至 ${page.selectedManagedUser.value.lockedUntil}` : "未锁定" }}</dd>
          </div>
          <div>
            <dt>最近登录</dt>
            <dd>{{ page.selectedManagedUser.value.lastLoginAt || "-" }}</dd>
          </div>
          <div>
            <dt>当前会话</dt>
            <dd data-testid="managed-user-active-session">{{ page.selectedManagedUser.value.activeSession ? `在线：${page.selectedManagedUser.value.activeSessionStartedAt || "-"}` : "无活动会话" }}</dd>
          </div>
          <div>
            <dt>上次替换</dt>
            <dd data-testid="managed-user-session-replaced">{{ page.selectedManagedUser.value.lastSessionReplacedAt || "-" }}</dd>
          </div>
        </dl>
        <section v-if="page.pendingPasswordResetRequests.value.length" class="password-reset-admin-panel" data-testid="password-reset-admin-panel">
          <div class="password-reset-admin-panel__head">
            <strong>待处理找回申请</strong>
            <span>{{ page.pendingPasswordResetRequests.value.length }} 条</span>
          </div>
          <button
            v-for="request in page.pendingPasswordResetRequests.value"
            :key="request.id"
            type="button"
            class="password-reset-request-row"
            :class="{ active: request.id === page.selectedPasswordResetRequestId.value }"
            :data-testid="`password-reset-request-${request.username}`"
            @click="page.selectPasswordResetRequest(request.id)"
          >
            <strong>{{ request.displayName || request.username }}</strong>
            <span>{{ request.username }} / {{ request.requestedAt }}</span>
            <em>{{ request.contactNote || "无联系方式说明" }}</em>
          </button>
        </section>
        <section v-if="page.selectedPasswordResetRequest.value" class="password-reset-admin-panel password-reset-admin-panel--selected" data-testid="password-reset-selected">
          <div class="password-reset-admin-panel__head">
            <strong>{{ page.selectedPasswordResetRequest.value.username }} 的找回申请</strong>
            <span>{{ page.selectedPasswordResetRequest.value.requestedAt }}</span>
          </div>
          <p>{{ page.selectedPasswordResetRequest.value.contactNote || "未填写联系方式说明。" }}</p>
          <label>
            <span>处理备注</span>
            <input v-model="page.passwordResetHandleNote.value" data-testid="password-reset-handle-note" placeholder="如：已电话核验身份" />
          </label>
          <div class="role-permission-head__actions">
            <button type="button" data-testid="password-reset-select-user" @click="page.selectManagedUser(page.selectedPasswordResetRequest.value.username)">选中该用户</button>
            <button type="button" data-testid="password-reset-reject" @click="page.rejectPasswordResetRequestAction">驳回申请</button>
          </div>
        </section>
        <NotificationOutboxPanel ref="notificationOutboxPanelRef" :can-manage="canManage" :set-message="page.setUserManagementMessage" />
        <label>
          <span>用户名</span>
          <input v-model="page.managedUserForm.username" :readonly="page.userManagementMode.value === 'edit'" data-testid="managed-user-username" />
        </label>
        <label>
          <span>姓名</span>
          <input v-model="page.managedUserForm.displayName" data-testid="managed-user-display-name" />
        </label>
        <label>
          <span>角色</span>
          <select v-model="page.managedUserForm.roleCode" data-testid="managed-user-role">
            <option v-for="role in page.managedRoles.value" :key="role.code" :value="role.code">{{ role.name }} / {{ role.code }}</option>
          </select>
        </label>
        <label class="user-management-check">
          <input v-model="page.managedUserForm.enabled" type="checkbox" data-testid="managed-user-enabled" />
          <span>启用</span>
        </label>
        <section class="account-set-grant-panel" data-testid="managed-user-account-sets">
          <div class="password-reset-admin-panel__head">
            <strong>账套授权</strong>
            <span>{{ page.managedUserForm.accountSetCodes.length }} 个</span>
          </div>
          <div class="account-set-grant-grid">
            <label
              v-for="accountSet in page.managedAccountSets.value"
              :key="accountSet.code"
              class="account-set-grant-row"
            >
              <input
                type="checkbox"
                :checked="page.managedUserForm.accountSetCodes.includes(accountSet.code)"
                :data-testid="`managed-user-account-set-${accountSet.code}`"
                @change="page.toggleAccountSetGrant(accountSet.code, ($event.target as HTMLInputElement).checked)"
              />
              <span>{{ accountSet.name }}</span>
              <em>{{ accountSet.code }}</em>
            </label>
          </div>
          <label>
            <span>默认账套</span>
            <select v-model="page.managedUserForm.defaultAccountSetCode" data-testid="managed-user-default-account-set">
              <option v-for="accountSetCode in page.managedUserForm.accountSetCodes" :key="accountSetCode" :value="accountSetCode">{{ accountSetCode }}</option>
            </select>
          </label>
        </section>
        <label>
          <span>{{ page.userManagementMode.value === "create" ? "初始密码" : "重置密码" }}</span>
          <input v-model="page.managedUserPassword.value" type="password" data-testid="managed-user-password" />
        </label>
        <div class="role-permission-head__actions">
          <button type="button" :disabled="page.userManagementMode.value === 'create' || !canManage" data-testid="managed-user-reset-password" @click="page.resetManagedUserPasswordAction">重置密码</button>
          <button type="button" :disabled="page.userManagementMode.value === 'create' || !page.selectedManagedUser.value?.locked || !canManage" data-testid="managed-user-unlock" @click="page.unlockManagedUserAction">解除锁定</button>
        </div>
        <p v-if="page.userManagementMessage.value" class="form-message" data-testid="user-management-message">{{ page.userManagementMessage.value }}</p>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import type { SystemUser } from "../../../services/systemApi";
import NotificationOutboxPanel from "../notification/NotificationOutboxPanel.vue";
import { ref } from "vue";
import { useUserManagementPage } from "./useUserManagementPage";

const props = defineProps<{
  canManage: boolean;
}>();

const emit = defineEmits<{
  usersChanged: [users: SystemUser[]];
}>();

const notificationOutboxPanelRef = ref<InstanceType<typeof NotificationOutboxPanel> | null>(null);

const page = useUserManagementPage({
  canManage: () => props.canManage,
  onUsersChanged: (users) => emit("usersChanged", users),
  onNotificationsChanged: () => notificationOutboxPanelRef.value?.reload()
});
</script>
