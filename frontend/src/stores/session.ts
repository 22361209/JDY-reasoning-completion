import { computed, ref } from "vue";

const tenantName = ref("博莱德机械测试账套");
const userName = ref("本地管理员");
const userRole = ref("系统管理员");
const userRoleCode = ref("ADMIN");
const permissionCodes = ref<string[]>([]);
const accountingPeriod = ref("2026-06");
const businessPeriod = ref("2026-06");

export function useSessionStore() {
  const periodLabel = computed(() => `会计期间 ${accountingPeriod.value} / 业务期间 ${businessPeriod.value}`);
  const permissionSet = computed(() => new Set(permissionCodes.value));
  const hasPermission = (permissionCode?: string) => !permissionCode || permissionSet.value.has(permissionCode);

  return {
    tenantName,
    userName,
    userRole,
    userRoleCode,
    permissionCodes,
    hasPermission,
    accountingPeriod,
    businessPeriod,
    periodLabel
  };
}
