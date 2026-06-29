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
import { ref, watch } from "vue";
import { initializeCurrentAccountSet, switchCurrentAccountSet, type SystemAccountSet } from "../../../services/systemApi";

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
</script>
