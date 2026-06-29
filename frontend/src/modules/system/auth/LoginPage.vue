<template>
  <section class="login-page" data-testid="login-page">
    <form class="login-panel" @submit.prevent="submitLogin">
      <div class="login-panel__brand">BLD</div>
      <h1>博莱德机械工作台</h1>
      <p>输入账号密码，选择账套后进入工作台。</p>
      <label>
        <span>账号</span>
        <input v-model.trim="auth.loginForm.username" data-testid="login-username" list="login-user-candidates" autocomplete="username" placeholder="请输入账号" />
        <datalist id="login-user-candidates">
          <option v-for="user in users" :key="user.username" :value="user.username">{{ user.displayName }} / {{ user.roleName }}</option>
        </datalist>
      </label>
      <label>
        <span>密码</span>
        <input v-model="auth.loginForm.password" data-testid="login-password" type="password" autocomplete="current-password" />
      </label>
      <label>
        <span>账套</span>
        <select v-model="auth.loginForm.accountSetCode" data-testid="login-account-set">
          <option v-for="accountSet in accountSets" :key="accountSet.code" :value="accountSet.code">
            {{ accountSet.name }} / {{ accountSet.code }}
          </option>
        </select>
      </label>
      <label class="login-remember">
        <input v-model="auth.loginForm.rememberCredentials" type="checkbox" data-testid="login-remember" />
        <span>记住账号密码和账套</span>
      </label>
      <button class="primary-action" type="submit" data-testid="login-submit">登录</button>
      <button class="text-action" type="button" data-testid="forgot-password-open" @click="auth.openPasswordResetRequestDialog">忘记密码</button>
      <p v-if="auth.loginMessage.value" class="login-message" data-testid="login-message">{{ auth.loginMessage.value }}</p>
    </form>
    <div v-if="auth.passwordResetRequestDialogOpen.value" class="modal-mask" data-testid="password-reset-request-dialog">
      <form class="dialog password-dialog" @submit.prevent="auth.submitPasswordResetRequest">
        <h3>找回密码</h3>
        <label>
          <span>账号</span>
          <input v-model="auth.passwordResetRequestForm.username" data-testid="password-reset-username" autocomplete="username" />
        </label>
        <label>
          <span>联系方式/说明</span>
          <input v-model="auth.passwordResetRequestForm.contactNote" data-testid="password-reset-contact" placeholder="手机号、班组或交接说明" />
        </label>
        <p v-if="auth.passwordResetRequestMessage.value" class="form-message" data-testid="password-reset-message">{{ auth.passwordResetRequestMessage.value }}</p>
        <div class="dialog-actions">
          <button type="button" data-testid="password-reset-cancel" @click="auth.closePasswordResetRequestDialog">取消</button>
          <button class="primary-action" type="submit" data-testid="password-reset-submit">提交申请</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { watch } from "vue";
import type { SystemSession } from "../../../services/systemApi";
import { useLoginPage, type LoginPageAccountSet, type LoginPageUser } from "./useAuthForms";

const props = defineProps<{
  users: LoginPageUser[];
  accountSets: LoginPageAccountSet[];
  message: string;
}>();

const emit = defineEmits<{
  loginSuccess: [session: SystemSession];
}>();

const auth = useLoginPage();

watch(
  () => props.message,
  (message) => {
    if (message) {
      auth.clearPassword(message);
    }
  },
  { immediate: true }
);

watch(
  () => props.accountSets,
  (accountSets) => {
    if (!auth.loginForm.accountSetCode && accountSets.length > 0) {
      auth.setAccountSet(accountSets[0].code);
    }
  },
  { immediate: true }
);

async function submitLogin() {
  const remoteSession = await auth.loginCurrentUser();
  if (remoteSession) {
    emit("loginSuccess", remoteSession);
  }
}

defineExpose({
  clearPassword: auth.clearPassword,
  setUsername: auth.setUsername,
  setAccountSet: auth.setAccountSet
});
</script>
