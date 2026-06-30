<template>
  <section class="role-permission-page account-set-page" data-testid="account-set-settings-page">
    <DocumentCommandHeader
      title="账套管理"
      subtitle="当前采用共用应用容器，切换账套会刷新业务页签并绑定新的账套上下文；正式多库隔离会在后续迁移。"
      show-subtitle
    >
      <template #actions>
        <ActionBar :actions="accountSetActions" @action="handleAction" />
      </template>
    </DocumentCommandHeader>
    <div class="settings-grid">
      <section class="settings-card">
        <h3>账套列表</h3>
        <div class="account-set-list">
          <label v-for="accountSet in visibleAccountSets" :key="accountSet.code" class="account-set-row" :class="{ active: accountSet.code === currentAccountSetCode, disabled: accountSet.enabled === false }">
            <input v-model="selectedCode" type="radio" :value="accountSet.code" />
            <span>
              <strong>{{ accountSet.name }}</strong>
              <em>{{ accountSet.code }} / {{ accountSet.environment }} / {{ accountSet.schemaName || "public" }}</em>
            </span>
            <b>{{ accountSet.enabled === false ? "已禁用" : accountSet.initialized ? "已初始化" : "未初始化" }}</b>
          </label>
        </div>
      </section>
      <section class="settings-card">
        <h3>状态与资源</h3>
        <p>共用应用容器，数据按账套 schema 隔离；附件和 Redis 使用账套前缀。</p>
        <dl v-if="selectedAccountSet" class="account-set-status">
          <dt>账套</dt>
          <dd>{{ selectedAccountSet.name }}（{{ selectedAccountSet.code }}）</dd>
          <dt>状态</dt>
          <dd>{{ selectedAccountSet.enabled === false ? "禁用" : "启用" }} / {{ selectedAccountSet.initialized ? "已初始化" : "未初始化" }}</dd>
          <dt>数据 schema</dt>
          <dd>{{ selectedAccountSet.schemaName || "public" }}</dd>
          <dt>附件目录</dt>
          <dd>{{ selectedAccountSet.attachmentPrefix || "account-sets/" + selectedAccountSet.code }}</dd>
          <dt>Redis 前缀</dt>
          <dd>{{ selectedAccountSet.redisKeyPrefix || selectedAccountSet.code }}</dd>
        </dl>
        <ActionBar bar-class="settings-inline-actions" :actions="statusActions" @action="handleAction" />
        <input v-model.trim="statusReason" :disabled="!canManage" data-testid="account-set-status-reason" placeholder="状态变更原因，可空" />
      </section>
      <section class="settings-card">
        <h3>备份与恢复</h3>
        <p>当前第一版按账套 schema 建立备份，仅允许恢复当前账套自己的备份。</p>
        <ActionBar bar-class="settings-inline-actions" :actions="backupActions" @action="handleAction" />
        <select v-model="selectedBackupName" :disabled="backups.length === 0" data-testid="account-set-backup-select">
          <option value="">选择备份</option>
          <option v-for="backup in backups" :key="backup.id" :value="backup.backupName">
            {{ backup.backupName }} / {{ backup.tableCount }} 表 / {{ backup.rowCount }} 行
          </option>
        </select>
        <ul class="account-set-backup-list">
          <li v-for="backup in backups.slice(0, 5)" :key="backup.id">
            <strong>{{ backup.backupName }}</strong>
            <span>{{ backup.createdAt }} / {{ backup.backupSchemaName }}</span>
          </li>
        </ul>
      </section>
      <section class="settings-card">
        <h3>新建账套</h3>
        <p>新账套会创建独立 tenant schema；用户和权限仍由平台统一管理。</p>
        <label>
          <span>账套编码</span>
          <input v-model.trim="createForm.code" :disabled="!canManage" data-testid="account-set-create-code" placeholder="如 TEST2026" />
        </label>
        <label>
          <span>账套名称</span>
          <input v-model.trim="createForm.name" :disabled="!canManage" data-testid="account-set-create-name" placeholder="如 测试账套" />
        </label>
        <label>
          <span>环境说明</span>
          <input v-model.trim="createForm.environment" :disabled="!canManage" data-testid="account-set-create-environment" />
        </label>
        <div class="settings-inline-fields">
          <label>
            <span>会计期间</span>
            <input v-model.trim="createForm.accountingPeriod" :disabled="!canManage" data-testid="account-set-create-accounting-period" />
          </label>
          <label>
            <span>业务期间</span>
            <input v-model.trim="createForm.businessPeriod" :disabled="!canManage" data-testid="account-set-create-business-period" />
          </label>
        </div>
        <ActionBar :actions="createActions" @action="handleAction" />
      </section>
      <section class="settings-card">
        <h3>本账套初始化</h3>
        <p>开发期初始化会清空当前项目的业务单据、库存余额、库存期初和编号流水，保留主数据、用户、权限、账套配置和 BOM。</p>
        <label class="settings-check">
          <input v-model="clearBusinessData" type="checkbox" data-testid="account-set-clear-business-data" />
          <span>清空开发期业务数据</span>
        </label>
        <input v-model.trim="confirmText" data-testid="account-set-confirm-text" placeholder="输入 初始化 确认执行" />
        <p v-if="message" class="form-message" data-testid="account-set-message">{{ message }}</p>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import ActionBar from "../../../components/ActionBar.vue";
import { defineAction, type ActionBarItem } from "../../../components/actions/actionRegistry";
import DocumentCommandHeader from "../../../components/DocumentCommandHeader.vue";
import {
  backupCurrentAccountSet,
  createAccountSet,
  fetchCurrentAccountSetBackups,
  fetchManagedAccountSets,
  initializeCurrentAccountSet,
  restoreCurrentAccountSetBackup,
  setAccountSetEnabled,
  type AccountSetBackup,
  type SystemAccountSet
} from "../../../services/systemApi";

const props = defineProps<{
  accountSets: SystemAccountSet[];
  currentAccountSetCode: string;
  canManage: boolean;
}>();

const emit = defineEmits<{
  accountSetsChanged: [accountSets: SystemAccountSet[]];
  accountSetSwitchRequested: [accountSetCode: string];
}>();

const selectedCode = ref(props.currentAccountSetCode);
const clearBusinessData = ref(true);
const confirmText = ref("");
const message = ref("");
const managedAccountSets = ref<SystemAccountSet[]>([]);
const backups = ref<AccountSetBackup[]>([]);
const selectedBackupName = ref("");
const statusReason = ref("");
const backingUp = ref(false);
const restoring = ref(false);
const createForm = reactive({
  code: "",
  name: "",
  environment: "本地开发",
  accountingPeriod: "2026-06",
  businessPeriod: "2026-06"
});

const visibleAccountSets = computed(() => managedAccountSets.value.length > 0 ? managedAccountSets.value : props.accountSets);
const selectedAccountSet = computed(() => visibleAccountSets.value.find((accountSet) => accountSet.code === selectedCode.value) ?? null);
const accountSetActions = computed<ActionBarItem[]>(() => [
  defineAction("switchAccountSet", {
    label: "切换账套",
    order: 35,
    enabled: props.canManage && Boolean(selectedCode.value) && selectedCode.value !== props.currentAccountSetCode && selectedAccountSet.value?.enabled !== false,
    testId: "account-set-switch"
  }),
  defineAction("initializeAccountSet", {
    label: "初始化本账套",
    order: 55,
    variant: "primary",
    enabled: props.canManage,
    testId: "account-set-initialize"
  })
]);
const statusActions = computed<ActionBarItem[]>(() => [
  defineAction("enable", {
    enabled: props.canManage && Boolean(selectedAccountSet.value) && selectedAccountSet.value?.enabled !== true,
    testId: "account-set-enable"
  }),
  defineAction("disable", {
    enabled: props.canManage && Boolean(selectedAccountSet.value) && selectedAccountSet.value?.enabled !== false && selectedCode.value !== props.currentAccountSetCode,
    testId: "account-set-disable"
  })
]);
const backupActions = computed<ActionBarItem[]>(() => [
  defineAction("backupAccountSet", {
    label: "备份当前账套",
    order: 40,
    enabled: props.canManage && !backingUp.value,
    testId: "account-set-backup"
  }),
  defineAction("restoreAccountSet", {
    label: "恢复所选备份",
    order: 45,
    enabled: props.canManage && Boolean(selectedBackupName.value) && !restoring.value,
    testId: "account-set-restore"
  })
]);
const createActions = computed<ActionBarItem[]>(() => [
  defineAction("create", {
    label: "新建账套",
    enabled: props.canManage,
    testId: "account-set-create"
  })
]);

watch(() => props.currentAccountSetCode, (code) => {
  selectedCode.value = code;
  void loadBackups();
});

onMounted(async () => {
  await loadManagedAccountSets();
  await loadBackups();
});

async function switchSelected() {
  message.value = "";
  if (!selectedCode.value || selectedCode.value === props.currentAccountSetCode) {
    return;
  }
  emit("accountSetSwitchRequested", selectedCode.value);
}

function handleAction(actionKey: string) {
  if (actionKey === "switchAccountSet") {
    void switchSelected();
    return;
  }
  if (actionKey === "initializeAccountSet") {
    void initializeCurrent();
    return;
  }
  if (actionKey === "enable") {
    void updateSelectedEnabled(true);
    return;
  }
  if (actionKey === "disable") {
    void updateSelectedEnabled(false);
    return;
  }
  if (actionKey === "backupAccountSet") {
    void backupCurrent();
    return;
  }
  if (actionKey === "restoreAccountSet") {
    void restoreSelectedBackup();
    return;
  }
  if (actionKey === "create") {
    void createNewAccountSet();
  }
}

async function loadManagedAccountSets() {
  if (!props.canManage) {
    managedAccountSets.value = props.accountSets;
    return;
  }
  const result = await fetchManagedAccountSets();
  managedAccountSets.value = result.accountSets.length > 0 ? result.accountSets : props.accountSets;
  if (result.accountSets.length > 0) {
    emit("accountSetsChanged", result.accountSets.filter((accountSet) => accountSet.enabled !== false));
  }
}

async function loadBackups() {
  if (!props.canManage) {
    backups.value = [];
    return;
  }
  const result = await fetchCurrentAccountSetBackups();
  backups.value = result.backups;
  if (!backups.value.some((backup) => backup.backupName === selectedBackupName.value)) {
    selectedBackupName.value = backups.value[0]?.backupName ?? "";
  }
}

async function updateSelectedEnabled(enabled: boolean) {
  message.value = "";
  if (!selectedCode.value) {
    return;
  }
  const action = enabled ? "启用" : "禁用";
  if (!window.confirm(`确定${action}账套「${selectedAccountSet.value?.name || selectedCode.value}」吗？`)) {
    return;
  }
  const result = await setAccountSetEnabled(selectedCode.value, enabled, statusReason.value);
  message.value = result.message;
  if (result.ok) {
    managedAccountSets.value = result.accountSets;
    emit("accountSetsChanged", result.accountSets.filter((accountSet) => accountSet.enabled !== false));
    statusReason.value = "";
  }
}

async function backupCurrent() {
  message.value = "";
  backingUp.value = true;
  const result = await backupCurrentAccountSet();
  backingUp.value = false;
  message.value = result.message;
  if (result.ok) {
    backups.value = result.backups;
    selectedBackupName.value = result.backup?.backupName ?? backups.value[0]?.backupName ?? "";
  }
}

async function restoreSelectedBackup() {
  message.value = "";
  if (!selectedBackupName.value) {
    message.value = "请选择备份。";
    return;
  }
  if (!window.confirm(`确定将当前账套恢复到备份「${selectedBackupName.value}」吗？当前账套数据会被覆盖。`)) {
    return;
  }
  restoring.value = true;
  const result = await restoreCurrentAccountSetBackup(selectedBackupName.value);
  restoring.value = false;
  message.value = result.message;
  if (result.ok) {
    backups.value = result.backups;
  }
}

async function initializeCurrent() {
  message.value = "";
  if (confirmText.value !== "初始化") {
    message.value = "请输入“初始化”后再执行。";
    return;
  }
  const result = await initializeCurrentAccountSet({ clearBusinessData: clearBusinessData.value });
  message.value = result.message || (result.ok ? "本账套已初始化。" : "本账套初始化失败。");
  if (result.ok) {
    confirmText.value = "";
    if (result.accountSet) {
      emit("accountSetsChanged", props.accountSets.map((accountSet) => accountSet.code === result.accountSet?.code ? result.accountSet : accountSet));
    }
  }
}

async function createNewAccountSet() {
  message.value = "";
  if (!createForm.code || !createForm.name) {
    message.value = "请填写账套编码和账套名称。";
    return;
  }
  const result = await createAccountSet({ ...createForm });
  message.value = result.message || (result.ok ? "账套已创建。" : "账套创建失败。");
  if (!result.ok) {
    return;
  }
  selectedCode.value = result.accountSet?.code || createForm.code.toUpperCase();
  if (result.accountSets.length > 0) {
    managedAccountSets.value = result.accountSets;
    emit("accountSetsChanged", result.accountSets.filter((accountSet) => accountSet.enabled !== false));
  }
  createForm.code = "";
  createForm.name = "";
  await loadManagedAccountSets();
  emit("accountSetSwitchRequested", selectedCode.value);
}
</script>
