<template>
  <section v-if="outbox.recentPasswordResetNotifications.value.length" class="password-reset-admin-panel" data-testid="password-reset-notification-panel">
    <div class="password-reset-admin-panel__head">
      <strong>最近通知</strong>
      <div class="password-reset-notification-tools">
        <select v-model="outbox.notificationStatusFilter.value" data-testid="notification-status-filter" @change="outbox.loadNotificationOutboxAction">
          <option value="">全部</option>
          <option value="FAILED">失败</option>
          <option value="PENDING">待发送</option>
          <option value="SENT">已发送</option>
        </select>
        <button type="button" data-testid="notification-refresh" @click="outbox.loadNotificationOutboxAction">刷新</button>
        <span>{{ outbox.recentPasswordResetNotifications.value.length }} 条</span>
      </div>
    </div>
    <div
      v-for="notice in outbox.recentPasswordResetNotifications.value"
      :key="notice.id"
      class="password-reset-notice-row"
      :data-testid="`password-reset-notice-${notice.recipientUsername}-${notice.templateCode}`"
    >
      <strong>{{ notice.title }}</strong>
      <span>{{ notice.recipientUsername }} / {{ notificationStatusLabel(notice) }} / {{ notificationReceiptLabel(notice) }} / 重试 {{ notice.retryCount ?? 0 }} 次 / {{ notice.sentAt || notice.lastAttemptAt || notice.createdAt }}</span>
      <em>{{ notice.body }}</em>
      <em v-if="notice.failureReason">失败原因：{{ notice.failureReason }}</em>
      <div class="password-reset-notice-row__actions">
        <button type="button" :data-testid="`notification-resend-${notice.recipientUsername}`" @click="outbox.resendNotificationAction(notice.id)">重发</button>
        <button type="button" :data-testid="`notification-receipt-delivered-${notice.recipientUsername}`" @click="outbox.syncNotificationReceiptAction(notice.id, 'DELIVERED')">回执成功</button>
        <button type="button" :data-testid="`notification-receipt-failed-${notice.recipientUsername}`" @click="outbox.syncNotificationReceiptAction(notice.id, 'FAILED')">回执失败</button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { notificationReceiptLabel, notificationStatusLabel, useNotificationOutbox } from "./useNotificationOutbox";

const props = defineProps<{
  canManage: boolean;
  setMessage: (message: string) => void;
}>();

const outbox = useNotificationOutbox({
  canManage: () => props.canManage,
  setMessage: props.setMessage
});

defineExpose({
  reload: outbox.loadNotificationOutboxAction
});
</script>
