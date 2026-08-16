<template>
  <div class="role-permission-page">
    <DocumentCommandHeader title="用户角色" subtitle="维护员工账号、启停状态和角色归属，角色权限细项在权限矩阵中维护。" show-subtitle>
      <template #actions>
        <ActionBar :actions="userActions" @action="handleAction" />
      </template>
    </DocumentCommandHeader>
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
        <section class="user-management-core" data-testid="user-management-core-fields">
          <label>
            <span>用户名</span>
            <input ref="managedUsernameInput" v-model="page.managedUserForm.username" :readonly="page.userManagementMode.value === 'edit'" data-testid="managed-user-username" />
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
          <section class="account-set-grant-panel user-management-core__wide" data-testid="managed-user-account-sets">
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
          <ActionBar class="user-management-core__wide" bar-class="settings-inline-actions" :actions="managedUserActions" @action="handleAction" />
        </section>
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
        <section
          v-if="page.selectedManagedUser.value && page.userManagementMode.value === 'edit'"
          class="account-set-grant-panel"
          data-testid="current-account-employee-link"
        >
          <div class="password-reset-admin-panel__head">
            <strong>当前账套员工关联</strong>
            <span data-testid="managed-user-employee-state">{{ page.employeeLinkStateLabel(page.selectedManagedUser.value) }}</span>
          </div>
          <div v-if="page.selectedManagedUser.value.employeeCode" class="account-set-grant-row">
            <strong data-testid="managed-user-employee-name">{{ page.selectedManagedUser.value.employeeName || "员工主档不可用" }}</strong>
            <em data-testid="managed-user-employee-code">{{ page.selectedManagedUser.value.employeeCode }}</em>
          </div>
          <p v-else class="form-message" data-testid="managed-user-employee-empty">当前账套尚未关联员工。</p>
          <div v-if="page.employeeCandidateCode.value" class="account-set-grant-row" data-testid="managed-user-employee-candidate">
            <strong>待关联：{{ page.employeeCandidateName.value || page.employeeCandidateCode.value }}</strong>
            <em>{{ page.employeeCandidateCode.value }}</em>
          </div>
          <ActionBar bar-class="settings-inline-actions" :actions="employeeLinkActions" @action="handleAction" />
        </section>
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
          <ActionBar bar-class="settings-inline-actions" :actions="passwordResetActions" @action="handleAction" />
        </section>
        <NotificationOutboxPanel ref="notificationOutboxPanelRef" :can-manage="canManage" :set-message="page.setUserManagementMessage" />
        <p v-if="page.userManagementMessage.value" class="form-message" data-testid="user-management-message">{{ page.userManagementMessage.value }}</p>
      </div>
    </section>
    <MasterSelectorDialog
      :open="page.employeeSelectorOpen.value"
      type="employee"
      title="选择员工"
      label="员工"
      :keyword="page.employeeCandidateCode.value"
      @close="page.closeEmployeeSelector"
      @select="page.selectEmployeeCandidate($event.code, $event.name)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import ActionBar from "../../../components/ActionBar.vue";
import { defineAction, type ActionBarItem } from "../../../components/actions/actionRegistry";
import DocumentCommandHeader from "../../../components/DocumentCommandHeader.vue";
import MasterSelectorDialog from "../../../components/MasterSelectorDialog.vue";
import NotificationOutboxPanel from "../notification/NotificationOutboxPanel.vue";
import { useUserManagementPage } from "./useUserManagementPage";

const props = defineProps<{
  canManage: boolean;
  currentAccountSetCode: string;
}>();

const notificationOutboxPanelRef = ref<InstanceType<typeof NotificationOutboxPanel> | null>(null);
const managedUsernameInput = ref<HTMLInputElement | null>(null);

const page = useUserManagementPage({
  canManage: () => props.canManage,
  currentAccountSetCode: () => props.currentAccountSetCode,
  onNotificationsChanged: () => notificationOutboxPanelRef.value?.reload()
});

const userActions = computed<ActionBarItem[]>(() => [
  defineAction("refresh", { enabled: true, testId: "user-management-refresh" }),
  defineAction("create", { enabled: props.canManage, testId: "user-management-new" }),
  defineAction("save", { enabled: props.canManage, testId: "user-management-save" })
]);
const passwordResetActions = computed<ActionBarItem[]>(() => [
  defineAction("selectPasswordResetUser", {
    label: "选中该用户",
    order: 40,
    enabled: Boolean(page.selectedPasswordResetRequest.value),
    testId: "password-reset-select-user"
  }),
  defineAction("rejectPasswordReset", {
    label: "驳回申请",
    order: 45,
    enabled: Boolean(page.selectedPasswordResetRequest.value),
    testId: "password-reset-reject"
  })
]);
const managedUserActions = computed<ActionBarItem[]>(() => [
  defineAction("resetPassword", {
    label: "重置密码",
    order: 40,
    enabled: page.userManagementMode.value !== "create" && props.canManage,
    testId: "managed-user-reset-password"
  }),
  defineAction("unlockUser", {
    label: "解除锁定",
    order: 45,
    enabled: page.userManagementMode.value !== "create" && Boolean(page.selectedManagedUser.value?.locked) && props.canManage,
    testId: "managed-user-unlock"
  })
]);
const employeeLinkActions = computed<ActionBarItem[]>(() => [
  defineAction("selectEmployee", {
    label: "选择员工",
    order: 40,
    enabled: props.canManage && page.hasCurrentAccountGrantVersion(),
    testId: "managed-user-employee-select"
  }),
  defineAction("linkEmployee", {
    label: "关联",
    order: 45,
    enabled: props.canManage && page.hasCurrentAccountGrantVersion() && Boolean(page.employeeCandidateCode.value),
    testId: "managed-user-employee-link"
  }),
  defineAction("unlinkEmployee", {
    label: "解除关联",
    order: 50,
    enabled: props.canManage && page.hasCurrentAccountGrantVersion() && Boolean(page.selectedManagedUser.value?.employeeCode),
    testId: "managed-user-employee-unlink"
  })
]);

function handleAction(actionKey: string) {
  if (actionKey === "refresh") {
    void page.loadManagedUsers();
    return;
  }
  if (actionKey === "create") {
    void startCreateManagedUser();
    return;
  }
  if (actionKey === "save") {
    void page.saveManagedUser();
    return;
  }
  if (actionKey === "selectPasswordResetUser" && page.selectedPasswordResetRequest.value) {
    page.selectManagedUser(page.selectedPasswordResetRequest.value.username);
    return;
  }
  if (actionKey === "rejectPasswordReset") {
    void page.rejectPasswordResetRequestAction();
    return;
  }
  if (actionKey === "resetPassword") {
    void page.resetManagedUserPasswordAction();
    return;
  }
  if (actionKey === "unlockUser") {
    void page.unlockManagedUserAction();
    return;
  }
  if (actionKey === "selectEmployee") {
    page.openEmployeeSelector();
    return;
  }
  if (actionKey === "linkEmployee") {
    void page.linkSelectedEmployee();
    return;
  }
  if (actionKey === "unlinkEmployee") {
    void page.unlinkSelectedEmployee();
  }
}

async function startCreateManagedUser() {
  page.startCreateManagedUser();
  await nextTick();
  managedUsernameInput.value?.scrollIntoView({ block: "nearest" });
  managedUsernameInput.value?.focus();
}
</script>

<style scoped>
.role-permission-page {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.role-permission-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.role-permission-list,
.user-management-form {
  min-height: 0;
  overflow-y: auto;
}

.user-management-form {
  background: #fff;
}

.user-management-core {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 420px));
  align-items: start;
  gap: 12px;
}

.user-management-core__wide {
  grid-column: 1 / -1;
}
</style>
