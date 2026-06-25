import { computed, onMounted, ref } from "vue";
import {
  fetchNotificationOutbox,
  resendNotification,
  syncNotificationReceipt,
  type NotificationOutboxItem
} from "../../../services/systemApi";

export function useNotificationOutbox(options: { canManage: () => boolean; setMessage: (message: string) => void }) {
  const notificationOutbox = ref<NotificationOutboxItem[]>([]);
  const notificationStatusFilter = ref("");
  const recentPasswordResetNotifications = computed(() => notificationOutbox.value.slice(0, 6));

  onMounted(loadNotificationOutboxAction);

  async function loadNotificationOutboxAction() {
    const result = await fetchNotificationOutbox(notificationStatusFilter.value);
    if (!result.ok) {
      options.setMessage(result.message);
      return;
    }
    notificationOutbox.value = result.data;
  }

  async function resendNotificationAction(notificationId: string) {
    if (!options.canManage()) {
      options.setMessage("当前角色无权维护通知。");
      return;
    }
    const result = await resendNotification(notificationId);
    if (!result.ok) {
      options.setMessage(result.message || "通知重发失败。");
      return;
    }
    notificationStatusFilter.value = "";
    notificationOutbox.value = result.data;
    options.setMessage("通知已重发");
  }

  async function syncNotificationReceiptAction(notificationId: string, providerReceiptStatus: "DELIVERED" | "FAILED") {
    if (!options.canManage()) {
      options.setMessage("当前角色无权维护通知。");
      return;
    }
    const result = await syncNotificationReceipt(notificationId, {
      providerReceiptStatus,
      failureReason: providerReceiptStatus === "FAILED" ? "本地供应商回执失败" : ""
    });
    if (!result.ok) {
      options.setMessage(result.message || "通知回执同步失败。");
      return;
    }
    notificationStatusFilter.value = "";
    notificationOutbox.value = result.data;
    options.setMessage("通知回执已同步");
  }

  return {
    notificationOutbox,
    notificationStatusFilter,
    recentPasswordResetNotifications,
    loadNotificationOutboxAction,
    resendNotificationAction,
    syncNotificationReceiptAction
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
