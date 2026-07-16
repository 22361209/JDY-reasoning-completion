<template>
  <StandardDocument
    :title="title"
    :subtitle="subtitle"
    :status-label="statusLabel"
    :status-class="statusClass"
    :locked="false"
    :dirty="dirty"
    :message="message"
    :can-save="canEdit"
    :can-audit="canAudit"
    :can-reverse="canReverse"
    :can-void="false"
    :can-delete="false"
    :can-output="false"
    :show-create="hasPermission('finance.cash_transfer.audit')"
    :show-save="hasPermission('finance.cash_transfer.audit')"
    :show-audit="hasPermission('finance.cash_transfer.audit')"
    :show-reverse="hasPermission('finance.cash_transfer.audit')"
    :show-red-reverse="false"
    :show-void="false"
    :show-close="false"
    :show-unclose="false"
    :show-freeze="false"
    :show-unfreeze="false"
    :show-delete="false"
    :show-export="false"
    :show-print="false"
    @create="startNew"
    @save="save"
    @audit="audit"
    @reverse="reverse"
  >
    <section class="cash-transfer-form" data-testid="cash-transfer-form">
      <p class="cash-transfer-tip">仅允许 CNY/USD 的同币种账户互转。草稿不产生资金事实，审核后才写入双边资金事实。</p>
      <div class="cash-transfer-grid">
        <label><span>单据编号</span><input :value="form.billNo" disabled data-testid="cash-transfer-bill-no" placeholder="保存后自动生成" /></label>
        <label><span>业务日期</span><input v-model="form.billDate" type="date" :disabled="!canEdit" data-testid="cash-transfer-bill-date" @input="markDirty" /></label>
        <label><span>转出账户</span><select v-model="form.sourceAccountId" :disabled="!canEdit" data-testid="cash-transfer-source-account" @change="accountChanged"><option value="">请选择</option><option v-for="account in accounts" :key="account.id" :value="account.id">{{ account.code }} · {{ account.name }} · {{ account.currency }}</option></select></label>
        <label><span>转入账户</span><select v-model="form.targetAccountId" :disabled="!canEdit" data-testid="cash-transfer-target-account" @change="accountChanged"><option value="">请选择</option><option v-for="account in targetAccounts" :key="account.id" :value="account.id">{{ account.code }} · {{ account.name }} · {{ account.currency }}</option></select></label>
        <label><span>币种</span><input :value="form.currency || '随账户确定'" disabled data-testid="cash-transfer-currency" /></label>
        <label><span>转账金额</span><input v-model="form.amount" type="text" inputmode="decimal" :disabled="!canEdit" data-testid="cash-transfer-amount" @input="markDirty" /></label>
        <label class="cash-transfer-remark"><span>备注</span><input v-model="form.remark" :disabled="!canEdit" data-testid="cash-transfer-remark" @input="markDirty" /></label>
        <label><span>状态 / 版本</span><input :value="`${statusLabel} / v${form.version}`" disabled data-testid="cash-transfer-status-version" /></label>
      </div>
    </section>
  </StandardDocument>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import StandardDocument from "../../components/StandardDocument.vue";
import { fetchListRows } from "../../services/listApi";

const props = defineProps<{ title: string; subtitle: string; statusClass: string; dirty: boolean; hasPermission: (permission: string) => boolean }>();
const emit = defineEmits<{ markDirty: []; clearDirty: [] }>();
type Account = { id: string; code: string; name: string; currency: "CNY" | "USD" };
const accounts = ref<Account[]>([]);
const message = ref("");
const form = reactive({ billNo: "", billDate: today(), sourceAccountId: "", targetAccountId: "", currency: "", amount: "0", remark: "", status: "DRAFT", version: 0 });
const statusLabel = computed(() => form.status === "AUDITED" ? "已审核" : "草稿");
const canEdit = computed(() => props.hasPermission("finance.cash_transfer.audit") && form.status === "DRAFT");
const canAudit = computed(() => canEdit.value && Boolean(form.billNo) && !props.dirty);
const canReverse = computed(() => props.hasPermission("finance.cash_transfer.audit") && form.status === "AUDITED");
const targetAccounts = computed(() => accounts.value.filter((account) => !form.sourceAccountId || account.id === form.sourceAccountId || account.currency === form.currency));

onMounted(loadAccounts);
async function loadAccounts() {
  const result = await fetchListRows("financial-account-settlement-selector", { keyword: "", page: 1, pageSize: 200, view: "header" });
  if (!result.ok || !result.data) { message.value = result.message || "资金账户加载失败。"; return; }
  accounts.value = result.data.rows.map((row) => ({ id: String(row.id ?? ""), code: String(row.code ?? ""), name: String(row.name ?? ""), currency: String(row.currency ?? "") as "CNY" | "USD" })).filter((row) => row.id && (row.currency === "CNY" || row.currency === "USD"));
}
function accountChanged() {
  const source = accounts.value.find((account) => account.id === form.sourceAccountId);
  const target = accounts.value.find((account) => account.id === form.targetAccountId);
  form.currency = source?.currency ?? target?.currency ?? "";
  if (source && target && source.currency !== target.currency) { form.targetAccountId = ""; message.value = "资金转账只允许同币种账户。"; }
  emit("markDirty");
}
function markDirty() { emit("markDirty"); }
function startNew() { Object.assign(form, { billNo: "", billDate: today(), sourceAccountId: "", targetAccountId: "", currency: "", amount: "0", remark: "", status: "DRAFT", version: 0 }); message.value = ""; emit("clearDirty"); }
function validation(auditing: boolean) {
  if (!form.sourceAccountId || !form.targetAccountId) return "请选择转出和转入账户。";
  if (form.sourceAccountId === form.targetAccountId) return "转出账户和转入账户不能相同。";
  const source = accounts.value.find((account) => account.id === form.sourceAccountId);
  const target = accounts.value.find((account) => account.id === form.targetAccountId);
  if (!source || !target || source.currency !== target.currency) return "转账双方必须为同币种的有效账户。";
  const amount = Number(form.amount);
  if (!Number.isFinite(amount) || amount < 0) return "转账金额不能小于 0。";
  if (auditing && amount <= 0) return "审核时转账金额必须大于 0。";
  return "";
}
async function save() {
  const error = validation(false); if (error) { message.value = error; return; }
  const result = await call("/api/cash-transfers/draft", "POST", { billNo: form.billNo || null, billDate: form.billDate, sourceAccountId: form.sourceAccountId, targetAccountId: form.targetAccountId, amount: form.amount, remark: form.remark });
  if (!result.ok) { message.value = result.message; return; }
  await loadByBillNo(String(result.data?.billNo ?? form.billNo)); message.value = "草稿已保存。";
}
async function audit() {
  const error = validation(true); if (error) { message.value = error; return; }
  if (props.dirty) { message.value = "请先保存当前修改后再审核。"; return; }
  const result = await call(`/api/cash-transfers/${encodeURIComponent(form.billNo)}/audit`, "POST");
  if (!result.ok) { message.value = result.message; return; }
  await loadByBillNo(form.billNo); message.value = "审核成功，已写入同币种双边资金事实。";
}
async function reverse() {
  const result = await call(`/api/cash-transfers/${encodeURIComponent(form.billNo)}/reverse`, "POST");
  if (!result.ok) { message.value = result.message; return; }
  await loadByBillNo(form.billNo); message.value = "反审核成功，双边资金事实已完整回滚。";
}
async function loadByBillNo(billNo: string) {
  const result = await call(`/api/cash-transfers/${encodeURIComponent(billNo)}`, "GET");
  if (!result.ok || !result.data?.document) { message.value = result.message || "资金转账单加载失败。"; return; }
  const document = result.data.document;
  Object.assign(form, { billNo: String(document.billNo), billDate: String(document.billDate), sourceAccountId: String(document.sourceAccountId), targetAccountId: String(document.targetAccountId), currency: String(document.currency), amount: String(document.amount), remark: String(document.remark ?? ""), status: String(document.status), version: Number(document.version ?? 0) });
  emit("clearDirty");
}
async function call(url: string, method: string, body?: unknown): Promise<{ ok: boolean; data?: any; message: string }> {
  try { const response = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined }); const data = await response.json().catch(() => null); return { ok: response.ok, data, message: String(data?.message ?? data?.error ?? (response.ok ? "" : "请求失败")) }; } catch { return { ok: false, message: "网络异常，请稍后重试。" }; }
}
function today() { return new Date().toISOString().slice(0, 10); }
defineExpose({ startNew, loadByBillNo });
</script>

<style scoped>
.cash-transfer-form { padding: 18px 22px 28px; }
.cash-transfer-tip { margin: 0 0 16px; color: #5b6878; }
.cash-transfer-grid { display: grid; grid-template-columns: repeat(4, minmax(180px, 1fr)); gap: 14px 18px; }
.cash-transfer-grid label { display: grid; gap: 6px; color: #425466; font-size: 13px; }
.cash-transfer-grid input, .cash-transfer-grid select { min-width: 0; min-height: 32px; border: 1px solid #ccd5df; border-radius: 3px; padding: 5px 8px; background: #fff; color: #1d2a38; }
.cash-transfer-remark { grid-column: span 2; }
@media (max-width: 760px) { .cash-transfer-grid { grid-template-columns: repeat(2, minmax(180px, 1fr)); } }
</style>
