import { computed, onMounted, reactive, ref } from "vue";
import {
  createManagedUser,
  fetchManagedUsers,
  fetchNotificationOutbox,
  fetchSystemUsers,
  handlePasswordResetRequest,
  resendNotification,
  resetManagedUserPassword,
  syncNotificationReceipt,
  unlockManagedUser,
  updateManagedUser,
  type ManagedRole,
  type ManagedUser,
  type NotificationOutboxItem,
  type PasswordResetRequestItem,
  type SystemUser
} from "../../../services/systemApi";

export function useUserManagementPage(options: {
  canManage: () => boolean;
  onUsersChanged: (users: SystemUser[]) => void;
}) {
  const managedUsers = ref<ManagedUser[]>([]);
  const managedRoles = ref<ManagedRole[]>([]);
  const passwordResetRequests = ref<PasswordResetRequestItem[]>([]);
  const notificationOutbox = ref<NotificationOutboxItem[]>([]);
  const notificationStatusFilter = ref("");
  const selectedPasswordResetRequestId = ref("");
  const passwordResetHandleNote = ref("");
  const selectedManagedUsername = ref("");
  const userManagementMode = ref<"edit" | "create">("edit");
  const userManagementMessage = ref("");
  const managedUserPassword = ref("");
  const managedUserForm = reactive({
    username: "",
    displayName: "",
    roleCode: "WAREHOUSE",
    enabled: true
  });
  const selectedManagedUser = computed(() => managedUsers.value.find((user) => user.username === selectedManagedUsername.value) ?? null);
  const pendingPasswordResetRequests = computed(() => passwordResetRequests.value.filter((request) => request.status === "PENDING"));
  const selectedPasswordResetRequest = computed(() => passwordResetRequests.value.find((request) => request.id === selectedPasswordResetRequestId.value && request.status === "PENDING") ?? null);
  const recentPasswordResetNotifications = computed(() => notificationOutbox.value.slice(0, 6));

  onMounted(loadManagedUsers);

  async function loadManagedUsers() {
    const result = await fetchManagedUsers();
    if (!result.ok || !result.data) {
      userManagementMessage.value = result.message;
      return;
    }
    managedUsers.value = result.data.users;
    managedRoles.value = result.data.roles;
    passwordResetRequests.value = result.data.passwordResetRequests ?? [];
    notificationOutbox.value = result.data.notificationOutbox ?? [];
    if (!pendingPasswordResetRequests.value.some((request) => request.id === selectedPasswordResetRequestId.value)) {
      selectedPasswordResetRequestId.value = pendingPasswordResetRequests.value[0]?.id ?? "";
    }
    if (userManagementMode.value !== "create" && !managedUsers.value.some((user) => user.username === selectedManagedUsername.value)) {
      selectedManagedUsername.value = managedUsers.value[0]?.username ?? "";
    }
    if (selectedManagedUsername.value) {
      applySelectedManagedUser();
    }
    userManagementMessage.value = "";
  }

  async function loadNotificationOutboxAction() {
    const result = await fetchNotificationOutbox(notificationStatusFilter.value);
    if (!result.ok) {
      userManagementMessage.value = result.message;
      return;
    }
    notificationOutbox.value = result.data;
  }

  function selectManagedUser(username: string) {
    selectedManagedUsername.value = username;
    userManagementMode.value = "edit";
    applySelectedManagedUser();
    userManagementMessage.value = "";
    const pendingRequest = pendingPasswordResetRequests.value.find((request) => request.username === username);
    if (pendingRequest) {
      selectedPasswordResetRequestId.value = pendingRequest.id;
    }
  }

  function selectPasswordResetRequest(requestId: string) {
    selectedPasswordResetRequestId.value = requestId;
    const request = selectedPasswordResetRequest.value;
    if (request && managedUsers.value.some((user) => user.username === request.username)) {
      selectedManagedUsername.value = request.username;
      userManagementMode.value = "edit";
      applySelectedManagedUser();
    }
    passwordResetHandleNote.value = "";
    userManagementMessage.value = "";
  }

  function applySelectedManagedUser() {
    const user = selectedManagedUser.value;
    if (!user) {
      return;
    }
    managedUserForm.username = user.username;
    managedUserForm.displayName = user.displayName;
    managedUserForm.roleCode = user.roleCode;
    managedUserForm.enabled = user.enabled;
    managedUserPassword.value = "";
  }

  function managedUserStateLabel(user: ManagedUser) {
    if (!user.enabled) {
      return "禁用";
    }
    if (user.locked) {
      return "已锁定";
    }
    return "启用";
  }

  function startCreateManagedUser() {
    userManagementMode.value = "create";
    selectedManagedUsername.value = "";
    managedUserForm.username = "";
    managedUserForm.displayName = "";
    managedUserForm.roleCode = managedRoles.value.find((role) => role.code === "WAREHOUSE")?.code ?? managedRoles.value[0]?.code ?? "";
    managedUserForm.enabled = true;
    managedUserPassword.value = "";
    userManagementMessage.value = "";
  }

  async function saveManagedUser() {
    if (!options.canManage()) {
      userManagementMessage.value = "当前角色无权维护用户。";
      return;
    }
    const result = userManagementMode.value === "create"
      ? await createManagedUser({ ...managedUserForm, password: managedUserPassword.value })
      : await updateManagedUser(managedUserForm.username, {
        displayName: managedUserForm.displayName,
        roleCode: managedUserForm.roleCode,
        enabled: managedUserForm.enabled
      });
    if (!result.ok || !result.data) {
      userManagementMessage.value = result.message || "用户保存失败。";
      return;
    }
    managedUsers.value = result.data.users;
    managedRoles.value = result.data.roles;
    passwordResetRequests.value = result.data.passwordResetRequests ?? passwordResetRequests.value;
    notificationOutbox.value = result.data.notificationOutbox ?? notificationOutbox.value;
    selectedManagedUsername.value = managedUserForm.username;
    userManagementMode.value = "edit";
    applySelectedManagedUser();
    options.onUsersChanged(await fetchSystemUsers());
    userManagementMessage.value = "用户已保存";
  }

  async function resetManagedUserPasswordAction() {
    if (!options.canManage() || userManagementMode.value === "create") {
      return;
    }
    const result = await resetManagedUserPassword(managedUserForm.username, managedUserPassword.value);
    if (!result.ok) {
      userManagementMessage.value = result.message || "密码重置失败。";
      return;
    }
    managedUserPassword.value = "";
    await loadManagedUsers();
    userManagementMessage.value = "密码已重置，待处理找回申请已标记完成";
  }

  async function rejectPasswordResetRequestAction() {
    if (!options.canManage() || !selectedPasswordResetRequest.value) {
      return;
    }
    const result = await handlePasswordResetRequest(selectedPasswordResetRequest.value.id, "REJECTED", passwordResetHandleNote.value || "身份核验未通过");
    if (!result.ok || !result.data) {
      userManagementMessage.value = result.message || "找回申请处理失败。";
      return;
    }
    managedUsers.value = result.data.users;
    managedRoles.value = result.data.roles;
    passwordResetRequests.value = result.data.passwordResetRequests ?? [];
    notificationOutbox.value = result.data.notificationOutbox ?? [];
    selectedPasswordResetRequestId.value = pendingPasswordResetRequests.value[0]?.id ?? "";
    passwordResetHandleNote.value = "";
    userManagementMessage.value = "找回申请已驳回";
  }

  async function resendNotificationAction(notificationId: string) {
    if (!options.canManage()) {
      userManagementMessage.value = "当前角色无权维护通知。";
      return;
    }
    const result = await resendNotification(notificationId);
    if (!result.ok) {
      userManagementMessage.value = result.message || "通知重发失败。";
      return;
    }
    notificationStatusFilter.value = "";
    notificationOutbox.value = result.data;
    userManagementMessage.value = "通知已重发";
  }

  async function syncNotificationReceiptAction(notificationId: string, providerReceiptStatus: "DELIVERED" | "FAILED") {
    if (!options.canManage()) {
      userManagementMessage.value = "当前角色无权维护通知。";
      return;
    }
    const result = await syncNotificationReceipt(notificationId, {
      providerReceiptStatus,
      failureReason: providerReceiptStatus === "FAILED" ? "本地供应商回执失败" : ""
    });
    if (!result.ok) {
      userManagementMessage.value = result.message || "通知回执同步失败。";
      return;
    }
    notificationStatusFilter.value = "";
    notificationOutbox.value = result.data;
    userManagementMessage.value = "通知回执已同步";
  }

  async function unlockManagedUserAction() {
    if (!options.canManage() || userManagementMode.value === "create" || !selectedManagedUser.value?.locked) {
      return;
    }
    const result = await unlockManagedUser(managedUserForm.username);
    if (!result.ok || !result.data) {
      userManagementMessage.value = result.message || "解除锁定失败。";
      return;
    }
    managedUsers.value = result.data.users;
    managedRoles.value = result.data.roles;
    passwordResetRequests.value = result.data.passwordResetRequests ?? passwordResetRequests.value;
    selectedManagedUsername.value = managedUserForm.username;
    applySelectedManagedUser();
    userManagementMessage.value = "账号锁定已解除";
  }

  return {
    managedUsers,
    managedRoles,
    passwordResetRequests,
    notificationOutbox,
    notificationStatusFilter,
    selectedPasswordResetRequestId,
    passwordResetHandleNote,
    selectedManagedUsername,
    userManagementMode,
    userManagementMessage,
    managedUserPassword,
    managedUserForm,
    selectedManagedUser,
    pendingPasswordResetRequests,
    selectedPasswordResetRequest,
    recentPasswordResetNotifications,
    loadManagedUsers,
    loadNotificationOutboxAction,
    selectManagedUser,
    selectPasswordResetRequest,
    managedUserStateLabel,
    startCreateManagedUser,
    saveManagedUser,
    resetManagedUserPasswordAction,
    rejectPasswordResetRequestAction,
    resendNotificationAction,
    syncNotificationReceiptAction,
    unlockManagedUserAction
  };
}

export function notificationStatusLabel(notice: NotificationOutboxItem) {
  if (notice.status === "SENT") {
    return "已发送";
  }
  if (notice.status === "FAILED") {
    return "失败";
  }
  return "待发送";
}

export function notificationReceiptLabel(notice: NotificationOutboxItem) {
  if (notice.providerReceiptStatus === "DELIVERED") {
    return `回执成功${notice.providerReceiptAt ? ` ${notice.providerReceiptAt}` : ""}`;
  }
  if (notice.providerReceiptStatus === "FAILED") {
    return `回执失败${notice.providerReceiptAt ? ` ${notice.providerReceiptAt}` : ""}`;
  }
  if (notice.providerReceiptStatus === "BOUNCED") {
    return `回执退回${notice.providerReceiptAt ? ` ${notice.providerReceiptAt}` : ""}`;
  }
  return "未回执";
}
