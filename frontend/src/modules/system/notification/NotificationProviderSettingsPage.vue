<template>
  <div class="role-permission-page">
    <DocumentCommandHeader
      title="通知供应商"
      subtitle="维护通知 outbox 的供应商参数，影响找回密码通知的发送标记、重发和自动重试。"
      show-subtitle
      status-label="设置"
      status-class="draft"
    >
      <template #actions>
        <ActionBar :actions="notificationActions" @action="handleAction" />
      </template>
    </DocumentCommandHeader>
    <section class="role-permission-body">
      <aside class="role-permission-list" aria-label="通知供应商">
        <button
          type="button"
          :class="{ active: page.notificationProviderForm.providerCode === 'LOCAL' }"
          data-testid="notification-provider-local"
          @click="page.notificationProviderForm.providerCode = 'LOCAL'"
        >
          <strong>本地通知</strong>
          <span>只写 outbox 与审计，不请求外部网络</span>
        </button>
        <button
          type="button"
          :class="{ active: page.notificationProviderForm.providerCode === 'SIMULATED_HTTP' }"
          data-testid="notification-provider-simulated-http"
          @click="page.notificationProviderForm.providerCode = 'SIMULATED_HTTP'"
        >
          <strong>模拟 HTTP</strong>
          <span>保存接口地址与密钥，发送仍走本地 dry-run</span>
        </button>
        <button
          type="button"
          :class="{ active: page.notificationProviderForm.providerCode === 'SIMULATED_SMTP' }"
          data-testid="notification-provider-simulated-smtp"
          @click="page.notificationProviderForm.providerCode = 'SIMULATED_SMTP'"
        >
          <strong>模拟 SMTP</strong>
          <span>为邮件供应商预留参数，不暴露真实密钥</span>
        </button>
      </aside>
      <form class="user-management-form" @submit.prevent="page.saveNotificationProviderSettingsAction">
        <div class="role-permission-summary" data-testid="notification-provider-summary">
          <strong>{{ page.notificationProviderSettings.value?.providerLabel || notificationProviderLabel(page.notificationProviderForm.providerCode) }}</strong>
          <span>{{ page.notificationProviderForm.providerCode }}</span>
          <em>{{ page.notificationProviderForm.dryRun ? "Dry-run" : "待接真实供应商" }}</em>
        </div>
        <label>
          <span>供应商类型</span>
          <select v-model="page.notificationProviderForm.providerCode" data-testid="notification-provider-code">
            <option value="LOCAL">本地通知</option>
            <option value="SIMULATED_HTTP">模拟 HTTP 供应商</option>
            <option value="SIMULATED_SMTP">模拟 SMTP 供应商</option>
          </select>
        </label>
        <label>
          <span>发送方名称</span>
          <input v-model="page.notificationProviderForm.senderName" data-testid="notification-provider-sender-name" />
        </label>
        <label>
          <span>接口地址</span>
          <input v-model="page.notificationProviderForm.endpointUrl" data-testid="notification-provider-endpoint-url" placeholder="https://provider.example/send" />
        </label>
        <label>
          <span>回调密钥</span>
          <input v-model="page.notificationProviderForm.webhookSecret" data-testid="notification-provider-webhook-secret" type="password" placeholder="留空则保持现有密钥" />
        </label>
        <div class="security-toggle-grid" data-testid="notification-provider-toggles">
          <label>
            <input v-model="page.notificationProviderForm.dryRun" type="checkbox" data-testid="notification-provider-dry-run" />
            <span>Dry-run</span>
          </label>
        </div>
        <label>
          <span>当前管理员密码</span>
          <input
            v-model="page.notificationProviderForm.currentPassword"
            data-testid="notification-provider-current-password"
            type="password"
            autocomplete="current-password"
          />
        </label>
        <dl class="user-security-summary">
          <div>
            <dt>当前供应商</dt>
            <dd data-testid="notification-provider-current-code">{{ page.notificationProviderSettings.value?.providerCode || "-" }}</dd>
          </div>
          <div>
            <dt>发送方</dt>
            <dd data-testid="notification-provider-current-sender">{{ page.notificationProviderSettings.value?.senderName || "-" }}</dd>
          </div>
          <div>
            <dt>接口地址</dt>
            <dd data-testid="notification-provider-current-endpoint">{{ page.notificationProviderSettings.value?.endpointUrl || "-" }}</dd>
          </div>
          <div>
            <dt>密钥状态</dt>
            <dd data-testid="notification-provider-secret-state">{{ page.notificationProviderSettings.value?.webhookSecretConfigured ? "已配置" : "未配置" }}</dd>
          </div>
        </dl>
        <p v-if="page.notificationProviderMessage.value" class="form-message" data-testid="notification-provider-message">{{ page.notificationProviderMessage.value }}</p>
      </form>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import ActionBar from "../../../components/ActionBar.vue";
import { defineAction, type ActionBarItem } from "../../../components/actions/actionRegistry";
import DocumentCommandHeader from "../../../components/DocumentCommandHeader.vue";
import { notificationProviderLabel, useNotificationProviderSettingsPage } from "./useNotificationProviderSettingsPage";

const props = defineProps<{
  canManage: boolean;
}>();

const page = useNotificationProviderSettingsPage({
  canManage: () => props.canManage
});

const notificationActions = computed<ActionBarItem[]>(() => [
  defineAction("refresh", { enabled: true, testId: "notification-provider-refresh" }),
  defineAction("save", { enabled: props.canManage, testId: "notification-provider-save" })
]);

function handleAction(key: string) {
  const handlers: Record<string, () => void> = {
    refresh: () => { void page.loadNotificationProviderSettings(); },
    save: () => { void page.saveNotificationProviderSettingsAction(); }
  };
  handlers[key]?.();
}
</script>
