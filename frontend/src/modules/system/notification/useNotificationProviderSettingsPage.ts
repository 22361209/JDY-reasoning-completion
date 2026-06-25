import { onMounted, reactive, ref } from "vue";
import {
  fetchNotificationProviderSettings,
  saveNotificationProviderSettings,
  type NotificationProviderCode,
  type NotificationProviderSettings
} from "../../../services/systemApi";

export function useNotificationProviderSettingsPage(options: { canManage: () => boolean }) {
  const notificationProviderSettings = ref<NotificationProviderSettings | null>(null);
  const notificationProviderMessage = ref("");
  const notificationProviderForm = reactive<{
    currentPassword: string;
    providerCode: NotificationProviderCode;
    senderName: string;
    endpointUrl: string;
    webhookSecret: string;
    dryRun: boolean;
  }>({
    currentPassword: "",
    providerCode: "LOCAL",
    senderName: "本地通知",
    endpointUrl: "",
    webhookSecret: "",
    dryRun: true
  });

  onMounted(loadNotificationProviderSettings);

  async function loadNotificationProviderSettings() {
    const result = await fetchNotificationProviderSettings();
    if (!result.ok || !result.data) {
      notificationProviderMessage.value = result.message || "通知供应商设置加载失败。";
      return;
    }
    applyNotificationProviderSettings(result.data);
    notificationProviderMessage.value = "";
  }

  async function saveNotificationProviderSettingsAction() {
    if (!options.canManage()) {
      notificationProviderMessage.value = "当前角色无权维护通知供应商。";
      return;
    }
    const result = await saveNotificationProviderSettings({
      currentPassword: notificationProviderForm.currentPassword,
      providerCode: notificationProviderForm.providerCode,
      senderName: notificationProviderForm.senderName,
      endpointUrl: notificationProviderForm.endpointUrl,
      webhookSecret: notificationProviderForm.webhookSecret,
      dryRun: notificationProviderForm.dryRun
    });
    if (!result.ok || !result.data) {
      notificationProviderMessage.value = result.message || "通知供应商设置保存失败。";
      return;
    }
    applyNotificationProviderSettings(result.data);
    notificationProviderForm.currentPassword = "";
    notificationProviderForm.webhookSecret = "";
    notificationProviderMessage.value = "通知供应商设置已保存";
  }

  function applyNotificationProviderSettings(settings: NotificationProviderSettings) {
    notificationProviderSettings.value = settings;
    notificationProviderForm.providerCode = settings.providerCode;
    notificationProviderForm.senderName = settings.senderName;
    notificationProviderForm.endpointUrl = settings.endpointUrl;
    notificationProviderForm.dryRun = settings.dryRun;
  }

  return {
    notificationProviderSettings,
    notificationProviderMessage,
    notificationProviderForm,
    loadNotificationProviderSettings,
    saveNotificationProviderSettingsAction
  };
}

export function notificationProviderLabel(providerCode: NotificationProviderCode) {
  if (providerCode === "SIMULATED_HTTP") {
    return "模拟 HTTP 供应商";
  }
  if (providerCode === "SIMULATED_SMTP") {
    return "模拟 SMTP 供应商";
  }
  return "本地通知";
}
