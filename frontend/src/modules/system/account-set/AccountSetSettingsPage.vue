<template>
  <section class="role-permission-page account-set-page" data-testid="account-set-settings-page">
    <header class="role-permission-head">
      <div>
        <h2>账套管理</h2>
        <p>当前采用共用应用容器，切换账套只切换 session 的账套上下文；正式多库隔离会在后续迁移。</p>
      </div>
      <div class="role-permission-head__actions">
        <button type="button" :disabled="!canManage || !selectedCode || selectedCode === currentAccountSetCode" data-testid="account-set-switch" @click="switchSelected">切换账套</button>
        <button class="primary-action" type="button" :disabled="!canManage" data-testid="account-set-initialize" @click="initializeCurrent">初始化本账套</button>
      </div>
    </header>
    <div class="settings-grid">
      <section class="settings-card">
        <h3>账套列表</h3>
        <div class="account-set-list">
          <label v-for="accountSet in accountSets" :key="accountSet.code" class="account-set-row" :class="{ active: accountSet.code === currentAccountSetCode }">
            <input v-model="selectedCode" type="radio" :value="accountSet.code" />
            <span>
              <strong>{{ accountSet.name }}</strong>
              <em>{{ accountSet.code }} / {{ accountSet.environment }}</em>
            </span>
            <b>{{ accountSet.initialized ? "已初始化" : "未初始化" }}</b>
          </label>
        </div>
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
        <button type="button" :disabled="!canManage" data-testid="account-set-create" @click="createNewAccountSet">新建账套</button>
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
import { reactive, ref, watch } from "vue";
import { createAccountSet, initializeCurrentAccountSet, switchCurrentAccountSet, type SystemAccountSet } from "../../../services/systemApi";

const props = defineProps<{
  accountSets: SystemAccountSet[];
  currentAccountSetCode: string;
  canManage: boolean;
}>();

const emit = defineEmits<{
  accountSetSwitched: [];
}>();

const selectedCode = ref(props.currentAccountSetCode);
const clearBusinessData = ref(true);
const confirmText = ref("");
const message = ref("");
const createForm = reactive({
  code: "",
  name: "",
  environment: "本地开发",
  accountingPeriod: "2026-06",
  businessPeriod: "2026-06"
});

watch(() => props.currentAccountSetCode, (code) => {
  selectedCode.value = code;
});

async function switchSelected() {
  message.value = "";
  const result = await switchCurrentAccountSet(selectedCode.value);
  if (!result.ok) {
    message.value = result.message || "账套切换失败。";
    return;
  }
  emit("accountSetSwitched");
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
  const switchResult = await switchCurrentAccountSet(selectedCode.value);
  if (!switchResult.ok) {
    message.value = switchResult.message || "账套已创建，但切换账套失败。";
    return;
  }
  createForm.code = "";
  createForm.name = "";
  emit("accountSetSwitched");
}
</script>
