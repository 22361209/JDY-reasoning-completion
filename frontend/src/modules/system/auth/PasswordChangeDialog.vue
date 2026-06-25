<template>
  <div v-if="dialog.passwordDialogOpen.value" class="modal-mask" data-testid="password-change-dialog">
    <form class="dialog password-dialog" @submit.prevent="dialog.submitPasswordChange">
      <h3>修改密码</h3>
      <label>
        <span>当前密码</span>
        <input v-model="dialog.passwordForm.currentPassword" type="password" data-testid="password-current" autocomplete="current-password" />
      </label>
      <label>
        <span>新密码</span>
        <input v-model="dialog.passwordForm.newPassword" type="password" data-testid="password-new" autocomplete="new-password" />
      </label>
      <label>
        <span>确认新密码</span>
        <input v-model="dialog.passwordForm.confirmPassword" type="password" data-testid="password-confirm" autocomplete="new-password" />
      </label>
      <div class="password-rules" data-testid="password-rules">
        <span v-for="rule in dialog.passwordStrengthRules.value" :key="rule.label" :class="{ passed: rule.ok }">{{ rule.label }}</span>
      </div>
      <p v-if="dialog.passwordMessage.value" class="form-message" data-testid="password-message">{{ dialog.passwordMessage.value }}</p>
      <div class="dialog-actions">
        <button type="button" data-testid="password-cancel" @click="dialog.closePasswordDialog">取消</button>
        <button class="primary-action" type="submit" data-testid="password-submit">保存</button>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import type { PasswordPolicySettings } from "../../../services/systemApi";
import { usePasswordChangeDialog } from "./useAuthForms";

const props = defineProps<{
  passwordPolicy: PasswordPolicySettings;
}>();

const emit = defineEmits<{
  changed: [];
}>();

const dialog = usePasswordChangeDialog({
  passwordPolicy: () => props.passwordPolicy,
  onChanged: () => emit("changed")
});

defineExpose({
  openPasswordDialog: dialog.openPasswordDialog,
  resetPasswordForm: dialog.resetPasswordForm
});
</script>
