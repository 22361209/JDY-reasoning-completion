import { computed, onMounted, reactive, ref } from "vue";
import {
  createManagedUser,
  fetchCurrentAccountEmployeeLinks,
  fetchManagedUsers,
  handlePasswordResetRequest,
  resetManagedUserPassword,
  setCurrentAccountEmployeeLink,
  unlockManagedUser,
  updateManagedUser,
  type ManagedRole,
  type ManagedUser,
  type CurrentAccountEmployeeLink,
  type PasswordResetRequestItem,
  type SystemAccountSet
} from "../../../services/systemApi";

export function useUserManagementPage(options: {
  canManage: () => boolean;
  currentAccountSetCode: () => string;
  onNotificationsChanged: () => void;
}) {
  const managedUsers = ref<ManagedUser[]>([]);
  const managedRoles = ref<ManagedRole[]>([]);
  const managedAccountSets = ref<SystemAccountSet[]>([]);
  const employeeLinks = ref<CurrentAccountEmployeeLink[]>([]);
  const employeeSelectorOpen = ref(false);
  const employeeCandidateCode = ref("");
  const employeeCandidateName = ref("");
  const passwordResetRequests = ref<PasswordResetRequestItem[]>([]);
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
    enabled: true,
    accountSetCodes: [] as string[],
    defaultAccountSetCode: ""
  });
  const selectedManagedUser = computed(() => managedUsers.value.find((user) => user.username === selectedManagedUsername.value) ?? null);
  const pendingPasswordResetRequests = computed(() => passwordResetRequests.value.filter((request) => request.status === "PENDING"));
  const selectedPasswordResetRequest = computed(() => passwordResetRequests.value.find((request) => request.id === selectedPasswordResetRequestId.value && request.status === "PENDING") ?? null);

  onMounted(loadManagedUsers);

  async function loadManagedUsers() {
    const [result, linkResult] = await Promise.all([
      fetchManagedUsers(),
      fetchCurrentAccountEmployeeLinks()
    ]);
    if (!result.ok || !result.data) {
      userManagementMessage.value = result.message;
      return;
    }
    employeeLinks.value = linkResult.ok ? linkResult.data : [];
    managedUsers.value = mergeEmployeeLinks(result.data.users);
    managedRoles.value = result.data.roles;
    managedAccountSets.value = result.data.accountSets ?? [];
    passwordResetRequests.value = result.data.passwordResetRequests ?? [];
    if (!pendingPasswordResetRequests.value.some((request) => request.id === selectedPasswordResetRequestId.value)) {
      selectedPasswordResetRequestId.value = pendingPasswordResetRequests.value[0]?.id ?? "";
    }
    if (userManagementMode.value !== "create" && !managedUsers.value.some((user) => user.username === selectedManagedUsername.value)) {
      selectedManagedUsername.value = managedUsers.value[0]?.username ?? "";
    }
    if (selectedManagedUsername.value) {
      applySelectedManagedUser();
    }
    userManagementMessage.value = linkResult.ok ? "" : linkResult.message;
  }

  function selectManagedUser(username: string) {
    selectedManagedUsername.value = username;
    userManagementMode.value = "edit";
    employeeSelectorOpen.value = false;
    employeeCandidateCode.value = "";
    employeeCandidateName.value = "";
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
    managedUserForm.accountSetCodes = splitAccountSetCodes(user.accountSetCodes);
    managedUserForm.defaultAccountSetCode = user.defaultAccountSetCode || managedUserForm.accountSetCodes[0] || managedAccountSets.value[0]?.code || "";
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

  function employeeLinkStateLabel(user: ManagedUser) {
    if (!user.employeeCode) {
      return hasGrantVersion(user) ? "未关联" : "当前账套未授权";
    }
    if (!user.employeeName) {
      return "主档不可用（关联保留）";
    }
    if (user.employeeEnabled === false) {
      return "已禁用（关联保留）";
    }
    if (user.employeeAuditStatus !== "AUDITED" && user.employeeAuditStatus !== "已审核") {
      return "草稿（关联保留）";
    }
    return "已审核 / 启用";
  }

  function startCreateManagedUser() {
    userManagementMode.value = "create";
    selectedManagedUsername.value = "";
    managedUserForm.username = "";
    managedUserForm.displayName = "";
    managedUserForm.roleCode = managedRoles.value.find((role) => role.code === "WAREHOUSE")?.code ?? managedRoles.value[0]?.code ?? "";
    managedUserForm.enabled = true;
    const currentAccountSetCode = options.currentAccountSetCode().trim();
    const defaultAccountSetCode = currentAccountSetCode
      || managedAccountSets.value[0]?.code
      || "";
    managedUserForm.accountSetCodes = defaultAccountSetCode ? [defaultAccountSetCode] : [];
    managedUserForm.defaultAccountSetCode = managedUserForm.accountSetCodes[0] ?? "";
    managedUserPassword.value = "";
    employeeSelectorOpen.value = false;
    employeeCandidateCode.value = "";
    employeeCandidateName.value = "";
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
        enabled: managedUserForm.enabled,
        accountSetCodes: managedUserForm.accountSetCodes,
        defaultAccountSetCode: managedUserForm.defaultAccountSetCode
      });
    if (!result.ok || !result.data) {
      userManagementMessage.value = result.message || "用户保存失败。";
      return;
    }
    selectedManagedUsername.value = managedUserForm.username;
    userManagementMode.value = "edit";
    await loadManagedUsers();
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
    options.onNotificationsChanged();
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
    managedUsers.value = mergeEmployeeLinks(result.data.users);
    managedRoles.value = result.data.roles;
    passwordResetRequests.value = result.data.passwordResetRequests ?? [];
    selectedPasswordResetRequestId.value = pendingPasswordResetRequests.value[0]?.id ?? "";
    passwordResetHandleNote.value = "";
    options.onNotificationsChanged();
    userManagementMessage.value = "找回申请已驳回";
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
    managedUsers.value = mergeEmployeeLinks(result.data.users);
    managedRoles.value = result.data.roles;
    passwordResetRequests.value = result.data.passwordResetRequests ?? passwordResetRequests.value;
    selectedManagedUsername.value = managedUserForm.username;
    applySelectedManagedUser();
    userManagementMessage.value = "账号锁定已解除";
  }

  function setUserManagementMessage(message: string) {
    userManagementMessage.value = message;
  }

  function mergeEmployeeLinks(users: ManagedUser[]) {
    const linksByUsername = new Map(employeeLinks.value.map((link) => [link.username, link]));
    return users.map((user) => {
      const link = linksByUsername.get(user.username);
      return {
        ...user,
        grantId: link?.grantId,
        grantVersion: link?.grantVersion,
        employeeLinkScopeToken: link?.scopeToken,
        employeeCode: link?.employeeCode ?? "",
        employeeName: link?.employeeName ?? "",
        employeeEnabled: link?.employeeEnabled,
        employeeAuditStatus: link?.employeeAuditStatus ?? ""
      };
    });
  }

  function openEmployeeSelector() {
    if (!options.canManage() || userManagementMode.value !== "edit") {
      return;
    }
    if (!hasCurrentAccountGrantVersion()) {
      userManagementMessage.value = "该用户未获得当前账套授权，不能关联员工。";
      return;
    }
    employeeSelectorOpen.value = true;
    userManagementMessage.value = "";
  }

  function closeEmployeeSelector() {
    employeeSelectorOpen.value = false;
  }

  function selectEmployeeCandidate(code: string, name: string) {
    employeeCandidateCode.value = code.trim();
    employeeCandidateName.value = name.trim();
    employeeSelectorOpen.value = false;
    userManagementMessage.value = "";
  }

  async function linkSelectedEmployee() {
    if (!employeeCandidateCode.value) {
      userManagementMessage.value = "请先选择要关联的员工。";
      return;
    }
    await updateEmployeeLink(employeeCandidateCode.value);
  }

  async function unlinkSelectedEmployee() {
    if (!selectedManagedUser.value?.employeeCode) {
      return;
    }
    await updateEmployeeLink(null);
  }

  async function updateEmployeeLink(employeeCode: string | null) {
    const user = selectedManagedUser.value;
    if (!options.canManage() || userManagementMode.value !== "edit" || !user) {
      return;
    }
    const version = Number(user.grantVersion);
    if (!Number.isInteger(version) || version < 0) {
      userManagementMessage.value = "当前账套授权版本缺失，请刷新后重试。";
      return;
    }
    const scopeToken = String(user.employeeLinkScopeToken ?? "").trim();
    if (!scopeToken) {
      userManagementMessage.value = "当前账套作用域已失效，请刷新后重试。";
      return;
    }
    const result = await setCurrentAccountEmployeeLink(user.username, { employeeCode, version, scopeToken });
    if (!result.ok) {
      userManagementMessage.value = result.message;
      return;
    }
    employeeLinks.value = result.data;
    managedUsers.value = mergeEmployeeLinks(managedUsers.value);
    employeeCandidateCode.value = "";
    employeeCandidateName.value = "";
    userManagementMessage.value = employeeCode ? "当前账套员工关联已更新" : "当前账套员工关联已解除";
  }

  function hasCurrentAccountGrantVersion() {
    return hasGrantVersion(selectedManagedUser.value);
  }

  function hasGrantVersion(user: ManagedUser | null) {
    const version = Number(user?.grantVersion);
    return Number.isInteger(version) && version >= 0;
  }

  function splitAccountSetCodes(accountSetCodes?: string) {
    if (!accountSetCodes) {
      return [] as string[];
    }
    return accountSetCodes.split(",").map((code) => code.trim()).filter(Boolean);
  }

  function toggleAccountSetGrant(accountSetCode: string, checked: boolean) {
    const next = new Set(managedUserForm.accountSetCodes);
    if (checked) {
      next.add(accountSetCode);
    } else {
      next.delete(accountSetCode);
    }
    managedUserForm.accountSetCodes = Array.from(next);
    if (!managedUserForm.accountSetCodes.includes(managedUserForm.defaultAccountSetCode)) {
      managedUserForm.defaultAccountSetCode = managedUserForm.accountSetCodes[0] ?? "";
    }
  }

  return {
    managedUsers,
    managedRoles,
    managedAccountSets,
    employeeLinks,
    employeeSelectorOpen,
    employeeCandidateCode,
    employeeCandidateName,
    passwordResetRequests,
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
    loadManagedUsers,
    selectManagedUser,
    selectPasswordResetRequest,
    managedUserStateLabel,
    employeeLinkStateLabel,
    startCreateManagedUser,
    saveManagedUser,
    resetManagedUserPasswordAction,
    rejectPasswordResetRequestAction,
    unlockManagedUserAction,
    openEmployeeSelector,
    closeEmployeeSelector,
    selectEmployeeCandidate,
    linkSelectedEmployee,
    unlinkSelectedEmployee,
    hasCurrentAccountGrantVersion,
    setUserManagementMessage,
    toggleAccountSetGrant
  };
}
