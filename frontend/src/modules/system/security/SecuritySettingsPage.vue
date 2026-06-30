<template>
  <div class="role-permission-page">
    <DocumentCommandHeader
      title="安全设置"
      subtitle="维护登录安全策略，影响同账号在多个浏览器或设备上的在线方式。"
      show-subtitle
      status-label="设置"
      status-class="draft"
    >
      <template #actions>
        <ActionBar :actions="securityActions" @action="handleAction" />
      </template>
    </DocumentCommandHeader>
    <section class="role-permission-body">
      <aside class="role-permission-list" aria-label="安全策略">
        <button
          type="button"
          :class="{ active: page.securitySettingsForm.repeatedLoginPolicy === 'SINGLE_ACTIVE' }"
          data-testid="security-policy-single-active"
          @click="page.securitySettingsForm.repeatedLoginPolicy = 'SINGLE_ACTIVE'"
        >
          <strong>后登录踢下线</strong>
          <span>同账号只保留一个活动会话</span>
        </button>
        <button
          type="button"
          :class="{ active: page.securitySettingsForm.repeatedLoginPolicy === 'ALLOW_CONCURRENT' }"
          data-testid="security-policy-allow-concurrent"
          @click="page.securitySettingsForm.repeatedLoginPolicy = 'ALLOW_CONCURRENT'"
        >
          <strong>允许多端同时在线</strong>
          <span>重复登录不踢旧会话，改密仍全部失效</span>
        </button>
      </aside>
      <form class="user-management-form" @submit.prevent="page.saveSecuritySettingsAction">
        <div class="role-permission-summary" data-testid="security-settings-summary">
          <strong>{{ securityPolicyLabel(page.securitySettingsForm.repeatedLoginPolicy) }}</strong>
          <span>{{ page.securitySettingsForm.repeatedLoginPolicy }}</span>
          <em>{{ page.securitySettings.value?.repeatedLoginPolicyLabel || "等待加载" }}</em>
        </div>
        <label>
          <span>重复登录策略</span>
          <select v-model="page.securitySettingsForm.repeatedLoginPolicy" data-testid="security-repeated-login-policy">
            <option value="SINGLE_ACTIVE">后登录踢下线旧会话</option>
            <option value="ALLOW_CONCURRENT">允许同账号多端同时在线</option>
          </select>
        </label>
        <label>
          <span>会话超时（分钟）</span>
          <input
            :ref="page.setSecuritySessionTimeoutInput"
            v-model.number="page.securitySettingsForm.sessionTimeoutMinutes"
            data-testid="security-session-timeout-minutes"
            type="number"
            min="5"
            max="480"
            step="1"
            @change="page.updateSecuritySessionTimeout"
          />
        </label>
        <label>
          <span>密码最小长度</span>
          <input
            :ref="page.setSecurityPasswordMinLengthInput"
            v-model.number="page.securitySettingsForm.passwordMinLength"
            data-testid="security-password-min-length"
            type="number"
            min="6"
            max="64"
            step="1"
            @change="page.updateSecurityPasswordMinLength"
          />
        </label>
        <div class="security-toggle-grid" data-testid="security-password-policy-toggles">
          <label>
            <input v-model="page.securitySettingsForm.passwordRequireUppercase" type="checkbox" data-testid="security-password-require-uppercase" />
            <span>大写字母</span>
          </label>
          <label>
            <input v-model="page.securitySettingsForm.passwordRequireLowercase" type="checkbox" data-testid="security-password-require-lowercase" />
            <span>小写字母</span>
          </label>
          <label>
            <input v-model="page.securitySettingsForm.passwordRequireDigit" type="checkbox" data-testid="security-password-require-digit" />
            <span>数字</span>
          </label>
          <label>
            <input v-model="page.securitySettingsForm.passwordRequireSymbol" type="checkbox" data-testid="security-password-require-symbol" />
            <span>符号</span>
          </label>
        </div>
        <label>
          <span>当前管理员密码</span>
          <input
            v-model="page.securitySettingsForm.currentPassword"
            data-testid="security-current-password"
            type="password"
            autocomplete="current-password"
          />
        </label>
        <dl class="user-security-summary">
          <div>
            <dt>当前生效</dt>
            <dd data-testid="security-current-policy">{{ page.securitySettings.value?.repeatedLoginPolicy || "-" }}</dd>
          </div>
          <div>
            <dt>会话超时</dt>
            <dd data-testid="security-current-timeout">{{ page.securitySettings.value ? `${page.securitySettings.value.sessionTimeoutMinutes} 分钟` : "-" }}</dd>
          </div>
          <div>
            <dt>密码策略</dt>
            <dd data-testid="security-current-password-policy">{{ page.securitySettings.value ? passwordPolicySummary(page.securitySettings.value.passwordPolicy) : "-" }}</dd>
          </div>
          <div>
            <dt>改密处理</dt>
            <dd>无论策略如何，改密后旧会话全部失效</dd>
          </div>
        </dl>
        <p v-if="page.securitySettingsMessage.value" class="form-message" data-testid="security-settings-message">{{ page.securitySettingsMessage.value }}</p>
      </form>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import ActionBar from "../../../components/ActionBar.vue";
import { defineAction, type ActionBarItem } from "../../../components/actions/actionRegistry";
import DocumentCommandHeader from "../../../components/DocumentCommandHeader.vue";
import type { PasswordPolicySettings } from "../../../services/systemApi";
import { passwordPolicySummary, securityPolicyLabel, useSecuritySettingsPage } from "./useSecuritySettingsPage";

const props = defineProps<{
  canManage: boolean;
}>();

const emit = defineEmits<{
  passwordPolicyUpdated: [policy: PasswordPolicySettings];
}>();

const page = useSecuritySettingsPage({
  canManage: () => props.canManage,
  onPasswordPolicyUpdated: (policy) => emit("passwordPolicyUpdated", policy)
});

const securityActions = computed<ActionBarItem[]>(() => [
  defineAction("refresh", { enabled: true, testId: "security-settings-refresh" }),
  defineAction("save", { enabled: props.canManage, testId: "security-settings-save" })
]);

function handleAction(key: string) {
  const handlers: Record<string, () => void> = {
    refresh: () => { void page.loadSecuritySettings(); },
    save: () => { void page.saveSecuritySettingsAction(); }
  };
  handlers[key]?.();
}
</script>
