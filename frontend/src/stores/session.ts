import { computed, ref } from "vue";

const tenantName = ref("博莱德机械测试账套");
const userName = ref("本地管理员");
const userRole = ref("系统管理员");
const accountingPeriod = ref("2026-06");
const businessPeriod = ref("2026-06");

export function useSessionStore() {
  const periodLabel = computed(() => `会计期间 ${accountingPeriod.value} / 业务期间 ${businessPeriod.value}`);

  return {
    tenantName,
    userName,
    userRole,
    accountingPeriod,
    businessPeriod,
    periodLabel
  };
}
