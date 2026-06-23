import { computed, ref } from "vue";

export type WorkTabKind = "home" | "panel" | "list" | "form" | "report" | "shell";

export interface WorkTab {
  id: string;
  title: string;
  module: string;
  kind: WorkTabKind;
  dirty?: boolean;
  lockedObjectId?: string;
}

const maxTabs = 8;
const tabs = ref<WorkTab[]>([
  { id: "home", title: "首页工作台", module: "首页工作台", kind: "home" }
]);
const activeTabId = ref("home");
const overflowMessage = ref("");
const pendingCloseTab = ref<WorkTab | null>(null);

export function useTabStore() {
  const activeTab = computed(() => tabs.value.find((tab) => tab.id === activeTabId.value) ?? tabs.value[0]);

  function openTab(tab: WorkTab) {
    const existing = tabs.value.find((item) => item.id === tab.id);
    if (existing) {
      activeTabId.value = existing.id;
      return true;
    }
    if (tabs.value.length >= maxTabs) {
      overflowMessage.value = "已打开太多页签了，请关闭部分页签后再试！";
      return false;
    }
    tabs.value.push(tab);
    activeTabId.value = tab.id;
    return true;
  }

  function requestClose(tabId: string) {
    const tab = tabs.value.find((item) => item.id === tabId);
    if (!tab || tab.id === "home") {
      return;
    }
    if (tab.dirty) {
      pendingCloseTab.value = tab;
      return;
    }
    closeNow(tabId);
  }

  function closeNow(tabId: string) {
    const index = tabs.value.findIndex((item) => item.id === tabId);
    if (index < 0) {
      return;
    }
    tabs.value.splice(index, 1);
    if (activeTabId.value === tabId) {
      activeTabId.value = tabs.value[Math.max(0, index - 1)]?.id ?? "home";
    }
    pendingCloseTab.value = null;
  }

  function cancelClose() {
    pendingCloseTab.value = null;
  }

  function clearOverflow() {
    overflowMessage.value = "";
  }

  return {
    tabs,
    activeTab,
    activeTabId,
    maxTabs,
    overflowMessage,
    pendingCloseTab,
    openTab,
    requestClose,
    closeNow,
    cancelClose,
    clearOverflow
  };
}
