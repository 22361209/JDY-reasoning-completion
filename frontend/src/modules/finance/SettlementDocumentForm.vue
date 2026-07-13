<template>
  <StandardDocument
    :title="title"
    :subtitle="subtitle"
    :status-label="statusLabel"
    :status-class="statusClass"
    :locked="false"
    :dirty="dirty"
    :message="message"
    :can-save="canSave"
    :can-audit="canAudit"
    :can-reverse="canReverse"
    :can-void="false"
    :can-delete="canDelete"
    :can-output="false"
    :show-create="hasSettlePermission"
    :show-save="hasSettlePermission"
    :show-audit="hasSettlePermission"
    :show-reverse="hasSettlePermission"
    :show-delete="hasSettlePermission"
    :show-red-reverse="false"
    :show-void="false"
    :show-close="false"
    :show-unclose="false"
    :show-freeze="false"
    :show-unfreeze="false"
    :show-export="false"
    :show-print="false"
    :show-source-select="hasSettlePermission"
    :can-source-select="canEditAllocations"
    source-select-label="选核销来源"
    :source-select-test-id="`${testPrefix}-open-source-selector`"
    @create="startNew"
    @save="save"
    @audit="audit"
    @reverse="requestAction('reverse')"
    @delete-document="requestAction('delete')"
    @source-select="openSourceSelector"
  >
    <div class="settlement-layout" :class="{ 'has-legacy': form.legacy }" :data-testid="`${testPrefix}-form`">
      <section v-if="form.legacy" class="legacy-banner" :data-testid="`${testPrefix}-legacy-banner`">
        <strong>历史直接结算记录</strong>
        <span>历史头和核销来源保持只读；反审核后需补充同币种真实账户才能重新审核。</span>
      </section>

      <section class="settlement-head">
        <label>
          <span>单据编号</span>
          <input :value="form.billNo" disabled :data-testid="`${testPrefix}-bill-no`" placeholder="保存后自动生成" />
        </label>
        <label>
          <span>{{ partyLabel }}编码</span>
          <input :value="form.partyCode" disabled :data-testid="`${testPrefix}-party-code`" />
        </label>
        <label>
          <span>{{ partyLabel }}名称</span>
          <input :value="form.partyName" disabled :data-testid="`${testPrefix}-party-name`" />
        </label>
        <label>
          <span>业务日期</span>
          <input v-model="form.billDate" type="date" :disabled="!canEditHeader" :data-testid="`${testPrefix}-bill-date`" @input="markDirty" />
        </label>
        <label>
          <span>币种</span>
          <select v-model="form.currency" :disabled="!canChangeCurrency" :data-testid="`${testPrefix}-currency`" @change="markDirty">
            <option value="CNY">人民币 / CNY</option>
            <option value="USD">美元 / USD</option>
          </select>
        </label>
        <label>
          <span>{{ kind === 'receipt' ? '收款金额' : '付款金额' }}</span>
          <input :value="formatMoney(allocationTotal)" disabled :data-testid="`${testPrefix}-amount`" />
        </label>
        <label>
          <span>状态 / 版本</span>
          <input :value="`${statusLabel} / v${form.version}`" disabled :data-testid="`${testPrefix}-status-version`" />
        </label>
        <label class="head-remark">
          <span>备注</span>
          <input v-model="form.remark" :title="form.remark" :disabled="!canEditHeader" :data-testid="`${testPrefix}-remark`" @input="markDirty" />
        </label>
      </section>

      <section class="settlement-section">
        <div class="section-head">
          <div>
            <h3>{{ kind === 'receipt' ? '收款账户' : '付款账户' }}</h3>
            <span>资金合计 {{ form.currency }} {{ formatMoney(fundTotal) }}；手续费本批只允许 0。</span>
          </div>
          <button v-if="hasSettlePermission" type="button" :disabled="!canEditFunds" :data-testid="`${testPrefix}-open-account-selector`" @click="openAccountSelector">选择账户</button>
        </div>
        <TableCore
          kind="list"
          :test-id="`${testPrefix}-fund-table`"
          frame-class="settlement-table-frame"
          inner-class="table-core-vxe-inner"
          table-class="vxe-table data-list-native-table settlement-native-table"
          header-wrapper-class="vxe-table--header-wrapper body--wrapper"
          body-wrapper-class="vxe-table--body-wrapper body--wrapper"
          header-row-class="vxe-header--row"
          row-class="vxe-body--row"
          :columns="fundColumns"
          :rows="form.fundLines"
          :min-width="1240"
          :row-key="fundRowKey"
        >
          <template #cell="{ row, column }">
            <div class="settlement-cell">
              <span v-if="column.key === 'lineNo'">{{ row.lineNo }}</span>
              <span v-else-if="column.key === 'accountCode'" :title="row.accountCode">{{ row.accountCode }}</span>
              <span v-else-if="column.key === 'accountName'" :title="row.accountName">{{ row.accountName }}</span>
              <span v-else-if="column.key === 'accountType'">{{ accountTypeLabel(row.accountType) }}</span>
              <span v-else-if="column.key === 'accountCurrency'">{{ row.accountCurrency }}</span>
              <select v-else-if="column.key === 'paymentMethod'" v-model="row.paymentMethod" :disabled="!canEditFunds" :data-testid="`${testPrefix}-fund-method-${row.lineNo}`" @change="markDirty">
                <option value="CASH">现金</option>
                <option value="BANK_TRANSFER">银行转账</option>
                <option value="OTHER">其他</option>
              </select>
              <input v-else-if="column.key === 'amount'" v-model="row.amount" type="text" inputmode="decimal" :disabled="!canEditFunds" :data-testid="`${testPrefix}-fund-amount-${row.lineNo}`" @input="markDirty" />
              <input v-else-if="column.key === 'fee'" v-model="row.fee" type="text" inputmode="decimal" :disabled="!canEditFunds" :data-testid="`${testPrefix}-fund-fee-${row.lineNo}`" @input="markDirty" />
              <input v-else-if="column.key === 'transactionNo'" v-model="row.transactionNo" :title="row.transactionNo" :disabled="!canEditFunds" :data-testid="`${testPrefix}-fund-transaction-${row.lineNo}`" @input="markDirty" />
              <input v-else-if="column.key === 'remark'" v-model="row.remark" :title="row.remark" :disabled="!canEditFunds" :data-testid="`${testPrefix}-fund-remark-${row.lineNo}`" @input="markDirty" />
              <button v-else-if="column.key === 'actions'" type="button" :disabled="!canEditFunds" :data-testid="`${testPrefix}-fund-remove-${row.lineNo}`" @click="removeFundLine(row.accountId)">移除</button>
            </div>
          </template>
          <template #overlay>
            <div v-if="form.fundLines.length === 0" class="empty-table">尚未选择财务账户。</div>
          </template>
        </TableCore>
      </section>

      <section class="settlement-section settlement-section--sources">
        <div class="section-head">
          <div>
            <h3>核销来源</h3>
            <span>只允许同一{{ partyLabel }}、同一币种；草稿不提前占用未核销余额。</span>
          </div>
          <strong :class="{ mismatch: !totalsMatch }">核销 {{ formatMoney(allocationTotal) }} / 资金 {{ formatMoney(fundTotal) }}</strong>
        </div>
        <TableCore
          kind="list"
          :test-id="`${testPrefix}-allocation-table`"
          frame-class="settlement-table-frame"
          inner-class="table-core-vxe-inner"
          table-class="vxe-table data-list-native-table settlement-native-table"
          header-wrapper-class="vxe-table--header-wrapper body--wrapper"
          body-wrapper-class="vxe-table--body-wrapper body--wrapper"
          header-row-class="vxe-header--row"
          row-class="vxe-body--row"
          :columns="allocationColumns"
          :rows="form.allocations"
          :min-width="1120"
          :row-key="allocationRowKey"
        >
          <template #cell="{ row, column }">
            <div class="settlement-cell">
              <span v-if="column.key === 'lineNo'">{{ row.lineNo }}</span>
              <span v-else-if="column.key === 'sourceBillNo'" :title="row.sourceBillNo">{{ row.sourceBillNo }}</span>
              <span v-else-if="column.key === 'sourceDate'">{{ row.sourceDate }}</span>
              <span v-else-if="column.key === 'sourceAmount'">{{ formatMoney(row.sourceAmount) }}</span>
              <span v-else-if="column.key === 'currentSettledAmount'">{{ formatMoney(row.currentSettledAmount) }}</span>
              <span v-else-if="column.key === 'currentUnsettledAmount'">{{ formatMoney(row.currentUnsettledAmount) }}</span>
              <input v-else-if="column.key === 'settlementAmount'" v-model="row.settlementAmount" type="text" inputmode="decimal" :disabled="!canEditAllocations" :data-testid="`${testPrefix}-allocation-amount-${row.lineNo}`" @input="markDirty" />
              <input v-else-if="column.key === 'remark'" v-model="row.remark" :title="row.remark" :disabled="!canEditAllocations" :data-testid="`${testPrefix}-allocation-remark-${row.lineNo}`" @input="markDirty" />
              <button v-else-if="column.key === 'actions'" type="button" :disabled="!canEditAllocations" :data-testid="`${testPrefix}-allocation-remove-${row.lineNo}`" @click="removeAllocation(row.sourceId)">移除</button>
            </div>
          </template>
          <template #overlay>
            <div v-if="form.allocations.length === 0" class="empty-table">请从可核销应{{ kind === 'receipt' ? '收' : '付' }}中选择来源。</div>
          </template>
        </TableCore>
      </section>
    </div>
  </StandardDocument>

  <SourceSelectorDialog
    :open="sourceSelector.open.value"
    :test-prefix="`${testPrefix}-source`"
    :title="`选择可核销应${kind === 'receipt' ? '收' : '付'}`"
    :description="`${form.partyName || '未限定往来单位'} / ${form.currency} / 仅显示实时未核销金额大于 0 的来源。`"
    v-model:keyword="sourceSelector.keyword.value"
    search-placeholder="应收应付单号、源业务单号、往来单位"
    :loading="sourceSelector.loading.value"
    :rows="sourceSelector.rows.value"
    :columns="sourceSelectorColumns"
    :selected="sourceSelector.selected"
    :count-label="sourceSelector.countLabel.value"
    :summary-items="sourceSelector.summaryItems.value"
    :message="sourceSelector.message.value"
    :row-key="sourceOptionRowKey"
    :format-cell="formatSourceOptionCell"
    @query-change="sourceSelector.load"
    @select-all="sourceSelector.selectAll"
    @toggle="sourceSelector.toggleRow"
    @close="sourceSelector.close"
    @confirm="confirmSourceSelection"
  />

  <SourceSelectorDialog
    :open="accountSelector.open.value"
    :test-prefix="`${testPrefix}-account`"
    title="选择财务账户"
    :description="`只显示已审核、已启用的 ${form.currency} 财务账户。`"
    v-model:keyword="accountSelector.keyword.value"
    search-placeholder="账户编码、账户名称、开户行"
    :loading="accountSelector.loading.value"
    :rows="accountSelector.rows.value"
    :columns="accountSelectorColumns"
    :selected="accountSelector.selected"
    :count-label="accountSelector.countLabel.value"
    :summary-items="accountSelector.summaryItems.value"
    :message="accountSelector.message.value"
    :row-key="accountOptionRowKey"
    :format-cell="formatAccountOptionCell"
    @query-change="accountSelector.load"
    @select-all="accountSelector.selectAll"
    @toggle="accountSelector.toggleRow"
    @close="accountSelector.close"
    @confirm="confirmAccountSelection"
  />

  <div v-if="pendingAction" class="modal-mask" :data-testid="`${testPrefix}-${pendingAction}-dialog`">
    <div class="dialog settlement-confirm-dialog">
      <h3>{{ pendingAction === 'reverse' ? '反审核确认' : '删除确认' }}</h3>
      <p v-if="pendingAction === 'reverse'">反审核会精确释放本单对全部应{{ kind === 'receipt' ? '收' : '付' }}的核销影响，并回到草稿。</p>
      <p v-else>仅草稿可删除，删除后单号不复用。</p>
      <div class="dialog-actions">
        <button type="button" @click="pendingAction = ''">取消</button>
        <button class="danger-action" type="button" :data-testid="`${testPrefix}-${pendingAction}-confirm`" @click="confirmPendingAction">确定</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import SourceSelectorDialog, { type SourceSelectorColumn } from "../../components/SourceSelectorDialog.vue";
import StandardDocument from "../../components/StandardDocument.vue";
import TableCore, { type TableCoreColumn } from "../../components/table/TableCore.vue";
import { useSourceSelectorLifecycle } from "../../app/sourceSelectorLifecycle";
import {
  auditSettlement,
  createSettlementDraft,
  deleteSettlementDraft,
  fetchSettlementAccounts,
  fetchSettlementDetail,
  fetchSettlementSources,
  reverseSettlement,
  updateSettlementDraft,
  type SettlementAccountOption,
  type SettlementAllocationLine,
  type SettlementCurrency,
  type SettlementDocument,
  type SettlementDraftPayload,
  type SettlementFundLine,
  type SettlementKind,
  type SettlementMoney,
  type SettlementSourceOption
} from "../../services/financeApi";

const props = defineProps<{
  kind: SettlementKind;
  title: string;
  subtitle: string;
  statusClass: string;
  dirty: boolean;
  hasPermission: (permission: string) => boolean;
}>();

const emit = defineEmits<{
  markDirty: [];
  clearDirty: [];
}>();

interface SettlementFormState extends SettlementDocument {}

const form = reactive<SettlementFormState>(emptyForm());
const message = ref("");
const pendingAction = ref<"" | "reverse" | "delete">("");
const testPrefix = computed(() => props.kind === "receipt" ? "receipt" : "payment");
const partyLabel = computed(() => props.kind === "receipt" ? "客户" : "供应商");
const hasSettlePermission = computed(() => props.hasPermission("finance.settle"));
const isDraft = computed(() => form.status === "DRAFT");
const isPersisted = computed(() => Boolean(form.billNo));
const canEditHeader = computed(() => hasSettlePermission.value && isDraft.value && !form.legacy);
const canEditAllocations = computed(() => canEditHeader.value);
const canEditFunds = computed(() => hasSettlePermission.value && isDraft.value);
const canChangeCurrency = computed(() => canEditHeader.value && form.allocations.length === 0 && form.fundLines.length === 0);
const allocationTotal = computed(() => sumMoneyUnits(form.allocations.map((line) => line.settlementAmount)));
const fundTotal = computed(() => sumMoneyUnits(form.fundLines.map((line) => line.amount)));
const totalsMatch = computed(() => allocationTotal.value === fundTotal.value);
const statusLabel = computed(() => form.status === "AUDITED" ? "已审核" : "草稿");
const canSave = computed(() => canEditFunds.value && Boolean(form.partyId) && (!form.legacy || isPersisted.value));
const canAudit = computed(() => hasSettlePermission.value && isDraft.value && isPersisted.value && !props.dirty);
const canReverse = computed(() => hasSettlePermission.value && form.status === "AUDITED" && isPersisted.value);
const canDelete = computed(() => hasSettlePermission.value && isDraft.value && isPersisted.value && !form.legacy);

const fundColumns: TableCoreColumn[] = [
  tableColumn("lineNo", "行", 50),
  tableColumn("accountCode", "账户编码", 120),
  tableColumn("accountName", "账户名称", 160),
  tableColumn("accountType", "类型", 95),
  tableColumn("accountCurrency", "币种", 75),
  tableColumn("paymentMethod", "结算方式", 130),
  tableColumn("amount", "金额", 120, "right"),
  tableColumn("fee", "手续费", 100, "right"),
  tableColumn("transactionNo", "交易号", 160),
  tableColumn("remark", "备注", 160),
  tableColumn("actions", "操作", 70)
];

const allocationColumns: TableCoreColumn[] = [
  tableColumn("lineNo", "行", 50),
  tableColumn("sourceBillNo", `应${props.kind === "receipt" ? "收" : "付"}单号`, 160),
  tableColumn("sourceDate", "来源日期", 120),
  tableColumn("sourceAmount", "来源金额", 125, "right"),
  tableColumn("currentSettledAmount", "已核销", 115, "right"),
  tableColumn("currentUnsettledAmount", "未核销", 115, "right"),
  tableColumn("settlementAmount", "本次核销", 130, "right"),
  tableColumn("remark", "备注", 180),
  tableColumn("actions", "操作", 70)
];

const sourceSelectorColumns: SourceSelectorColumn[] = [
  { key: "selection", title: "选", width: 42, visible: true, configurable: false },
  { key: "billNo", title: `应${props.kind === "receipt" ? "收" : "付"}单号`, width: 160, visible: true },
  { key: "sourceBillNo", title: "源业务单", width: 150, visible: true },
  { key: "partyCode", title: `${partyLabel.value}编码`, width: 130, visible: true },
  { key: "partyName", title: `${partyLabel.value}名称`, width: 190, visible: true },
  { key: "billDate", title: "日期", width: 120, visible: true },
  { key: "currency", title: "币种", width: 80, visible: true },
  { key: "amount", title: "来源金额", width: 120, visible: true, align: "right" },
  { key: "settledAmount", title: "已核销", width: 110, visible: true, align: "right" },
  { key: "unsettledAmount", title: "未核销", width: 110, visible: true, align: "right" }
];

const accountSelectorColumns: SourceSelectorColumn[] = [
  { key: "selection", title: "选", width: 42, visible: true, configurable: false },
  { key: "code", title: "账户编码", width: 140, visible: true },
  { key: "name", title: "账户名称", width: 200, visible: true },
  { key: "accountType", title: "账户类型", width: 120, visible: true },
  { key: "currency", title: "币种", width: 90, visible: true },
  { key: "status", title: "状态", width: 90, visible: true },
  { key: "auditStatus", title: "审核状态", width: 100, visible: true }
];

const sourceSelector = useSourceSelectorLifecycle<SettlementSourceOption>({
  rowKey: sourceOptionRowKey,
  fetchRows: async (query) => {
    const result = await fetchSettlementSources(props.kind, {
      keyword: query.keyword,
      currency: form.currency,
      partyId: form.partyId || undefined
    });
    return { ok: result.ok, message: result.message, data: result.data ?? [] };
  },
  countLabel: (count) => `已选 ${count} 张来源`,
  emptyMessage: "当前往来单位和币种下暂无可核销来源。",
  loadErrorMessage: "可核销来源加载失败。",
  formatQty: formatMoney,
  extraSummaryItems: (visibleRows, selectedRows) => [
    { key: "quantity", label: "当前未核销合计", value: formatMoney(sumMoneyUnits(visibleRows.map((row) => row.unsettledAmount))) },
    { key: "selectedQty", label: "已选未核销合计", value: formatMoney(sumMoneyUnits(selectedRows.map((row) => row.unsettledAmount))) }
  ]
});

const accountSelector = useSourceSelectorLifecycle<SettlementAccountOption>({
  rowKey: accountOptionRowKey,
  fetchRows: async (query) => {
    const result = await fetchSettlementAccounts({ keyword: query.keyword, currency: form.currency });
    return { ok: result.ok, message: result.message, data: result.data ?? [] };
  },
  countLabel: (count) => `已选 ${count} 个账户`,
  emptyMessage: `暂无可用财务账户。`,
  loadErrorMessage: "财务账户加载失败。",
  formatQty: formatMoney
});

function emptyForm(): SettlementFormState {
  return {
    billNo: "",
    partyId: "",
    partyCode: "",
    partyName: "",
    billDate: todayText(),
    currency: "CNY",
    amount: "0.00",
    status: "DRAFT",
    version: "0",
    remark: "",
    legacy: false,
    fundLines: [],
    allocations: []
  };
}

async function startNew(prefill?: { sourceBillNo?: string; currency?: SettlementCurrency }) {
  Object.assign(form, emptyForm(), { currency: prefill?.currency ?? "CNY" });
  message.value = "新单据将在首次保存时生成编号";
  emit("markDirty");
  if (prefill?.sourceBillNo) {
    await prefillSource(prefill.sourceBillNo);
  }
}

async function prefillSource(sourceBillNo: string) {
  const result = await fetchSettlementSources(props.kind, { keyword: sourceBillNo, currency: form.currency });
  if (!result.ok) {
    message.value = result.message;
    return;
  }
  const match = result.data?.find((row) => row.sourceBillNo === sourceBillNo || row.billNo === sourceBillNo);
  if (!match) {
    message.value = `未找到业务单 ${sourceBillNo} 对应的可核销应${props.kind === "receipt" ? "收" : "付"}。`;
    return;
  }
  appendSources([match]);
  message.value = `已由业务单 ${sourceBillNo} 预填核销来源。`;
}

async function loadByBillNo(billNo: string) {
  const result = await fetchSettlementDetail(props.kind, billNo);
  if (!result.ok || !result.data) {
    message.value = result.message || "收付款单详情加载失败。";
    return;
  }
  applyDocument(result.data);
  message.value = `已打开${props.title} ${billNo}`;
  emit("clearDirty");
}

function applyDocument(document: SettlementDocument) {
  Object.assign(form, {
    ...document,
    fundLines: document.fundLines.map((line) => ({ ...line })),
    allocations: document.allocations.map((line) => ({ ...line }))
  });
}

async function save() {
  const validation = validateDraft();
  if (validation) {
    message.value = validation;
    return;
  }
  const payload = draftPayload();
  const currentBillNo = form.billNo;
  const result = currentBillNo
    ? await updateSettlementDraft(props.kind, currentBillNo, form.version, payload)
    : await createSettlementDraft(props.kind, payload);
  if (!result.ok) {
    message.value = result.conflict ? `保存冲突：${result.message} 当前输入已保留，请核对后重试。` : result.message;
    return;
  }
  const savedBillNo = result.data?.billNo || currentBillNo;
  if (savedBillNo) {
    await loadByBillNo(savedBillNo);
    message.value = `草稿已保存：${savedBillNo}`;
    return;
  }
  message.value = "草稿已保存。";
  emit("clearDirty");
}

async function audit() {
  if (!canAudit.value) {
    message.value = props.dirty ? "请先保存当前修改后再审核。" : "当前单据不能审核。";
    return;
  }
  const validation = validateAudit();
  if (validation) {
    message.value = validation;
    return;
  }
  const result = await auditSettlement(props.kind, form.billNo);
  if (!result.ok) {
    message.value = result.conflict ? `审核冲突：${result.message} 当前输入已保留。` : result.message;
    return;
  }
  await loadByBillNo(form.billNo);
  message.value = "审核成功，应收应付核销已正式生效。";
}

function requestAction(action: "reverse" | "delete") {
  pendingAction.value = action;
}

async function confirmPendingAction() {
  const action = pendingAction.value;
  pendingAction.value = "";
  if (action === "reverse") {
    const result = await reverseSettlement(props.kind, form.billNo);
    if (!result.ok) {
      message.value = result.conflict ? `反审核冲突：${result.message} 当前页面数据已保留。` : result.message;
      return;
    }
    await loadByBillNo(form.billNo);
    message.value = "反审核成功，来源核销已释放，单据回到草稿。";
    return;
  }
  if (action === "delete") {
    const deletedBillNo = form.billNo;
    const result = await deleteSettlementDraft(props.kind, deletedBillNo);
    if (!result.ok) {
      message.value = result.conflict ? `删除冲突：${result.message} 当前页面数据已保留。` : result.message;
      return;
    }
    await startNew();
    message.value = `已删除草稿 ${deletedBillNo}。`;
  }
}

function validateDraft() {
  if (!form.partyId || form.allocations.length === 0) {
    return `请至少选择一张同一${partyLabel.value}的核销来源。`;
  }
  if (!form.billDate) {
    return "业务日期不能为空。";
  }
  if (hasInvalidMoneyInputs()) {
    return "金额和手续费必须是整数或最多 2 位小数的十进制数。";
  }
  if (hasNegativeAmounts()) {
    return "草稿金额和手续费不能为负数。";
  }
  if (hasOutOfRangeAmounts()) {
    return "金额和手续费不能超过 NUMERIC(18,2) 范围。";
  }
  if (form.fundLines.some((line) => moneyUnits(line.fee) !== 0n)) {
    return "A141 手续费只允许 0；本批不会自动生成其他支出。";
  }
  const overAllocated = form.allocations.find((line) => moneyUnits(line.settlementAmount)! > moneyUnits(line.currentUnsettledAmount)!);
  if (overAllocated) {
    return `来源 ${overAllocated.sourceBillNo} 的本次核销金额不能超过当前未核销 ${formatMoney(overAllocated.currentUnsettledAmount)}。`;
  }
  if (!totalsMatch.value) {
    return `资金合计 ${formatMoney(fundTotal.value)} 与核销合计 ${formatMoney(allocationTotal.value)} 必须相等。`;
  }
  const invalidCash = form.fundLines.find((line) => line.accountType === "CASH" ? line.paymentMethod !== "CASH" : line.paymentMethod === "CASH");
  if (invalidCash) {
    return `账户 ${invalidCash.accountCode} 的账户类型与结算方式不匹配。`;
  }
  return "";
}

function validateAudit() {
  const draftError = validateDraft();
  if (draftError) {
    return draftError;
  }
  if (allocationTotal.value <= 0n) {
    return "0 元草稿可以保存，但审核金额必须大于 0。";
  }
  if (form.fundLines.length === 0 || form.fundLines.some((line) => moneyUnits(line.amount)! <= 0n)) {
    return "审核前每条有效资金账户行金额都必须大于 0。";
  }
  if (form.allocations.some((line) => moneyUnits(line.settlementAmount)! <= 0n)) {
    return "审核前每条有效核销来源行金额都必须大于 0。";
  }
  return "";
}

function draftPayload(): SettlementDraftPayload {
  return {
    partyId: form.partyId,
    billDate: form.billDate,
    currency: form.currency,
    amount: moneyFromUnits(allocationTotal.value),
    remark: form.remark.trim(),
    fundLines: form.fundLines.map((line, index) => ({
      lineNo: index + 1,
      accountId: line.accountId,
      paymentMethod: line.paymentMethod,
      amount: normalizedMoney(line.amount),
      fee: normalizedMoney(line.fee),
      transactionNo: line.transactionNo.trim(),
      remark: line.remark.trim()
    })),
    allocations: form.allocations.map((line, index) => ({
      lineNo: index + 1,
      sourceId: line.sourceId,
      settlementAmount: normalizedMoney(line.settlementAmount),
      remark: line.remark.trim()
    }))
  };
}

async function openSourceSelector() {
  await sourceSelector.openAndLoad({ keyword: "", columnFilters: {} });
}

function confirmSourceSelection() {
  const selected = sourceSelector.selectedRowList.value;
  if (!selected.length) {
    sourceSelector.setMessage("请至少选择一张来源单。 ");
    return;
  }
  const expectedParty = form.partyId || selected[0]?.partyId;
  if (!expectedParty || selected.some((row) => row.partyId !== expectedParty)) {
    sourceSelector.setMessage(`一张${props.title}只能核销同一${partyLabel.value}的来源。`);
    return;
  }
  if (selected.some((row) => row.currency !== form.currency)) {
    sourceSelector.setMessage("来源币种与单据币种不一致。 ");
    return;
  }
  appendSources(selected);
  sourceSelector.close();
}

function appendSources(rows: SettlementSourceOption[]) {
  const existing = new Set(form.allocations.map((line) => line.sourceId));
  const additions = rows.filter((row) => !existing.has(row.id || row.sourceId));
  const first = additions[0] ?? rows[0];
  if (first && !form.partyId) {
    form.partyId = first.partyId;
    form.partyCode = first.partyCode;
    form.partyName = first.partyName;
    form.currency = first.currency;
  }
  additions.forEach((row) => {
    form.allocations.push({
      lineNo: form.allocations.length + 1,
      sourceId: row.id || row.sourceId,
      sourceBillNo: row.billNo,
      sourceDate: row.billDate,
      sourceAmount: row.amount,
      settledBefore: row.settledAmount,
      unsettledBefore: row.unsettledAmount,
      currentSettledAmount: row.settledAmount,
      currentUnsettledAmount: row.unsettledAmount,
      settlementAmount: row.unsettledAmount,
      remark: ""
    });
  });
  renumberLines();
  markDirty();
}

async function openAccountSelector() {
  await accountSelector.openAndLoad({ keyword: "", columnFilters: {} });
}

function confirmAccountSelection() {
  const selected = accountSelector.selectedRowList.value;
  if (!selected.length) {
    accountSelector.setMessage("请至少选择一个财务账户。 ");
    return;
  }
  if (selected.some((row) => row.currency !== form.currency)) {
    accountSelector.setMessage("账户币种与单据币种不一致。 ");
    return;
  }
  const existing = new Set(form.fundLines.map((line) => line.accountId));
  selected.filter((row) => !existing.has(row.id)).forEach((row) => {
    const unassigned = allocationTotal.value > fundTotal.value ? allocationTotal.value - fundTotal.value : 0n;
    form.fundLines.push({
      lineNo: form.fundLines.length + 1,
      accountId: row.id,
      accountCode: row.code,
      accountName: row.name,
      accountType: row.accountType,
      accountCurrency: row.currency,
      paymentMethod: row.accountType === "CASH" ? "CASH" : "BANK_TRANSFER",
      amount: moneyFromUnits(unassigned),
      fee: "0.00",
      transactionNo: "",
      remark: ""
    });
  });
  renumberLines();
  markDirty();
  accountSelector.close();
}

function removeFundLine(accountId: string) {
  if (!canEditFunds.value) {
    return;
  }
  form.fundLines = form.fundLines.filter((line) => line.accountId !== accountId);
  renumberLines();
  markDirty();
}

function removeAllocation(sourceId: string) {
  if (!canEditAllocations.value) {
    return;
  }
  form.allocations = form.allocations.filter((line) => line.sourceId !== sourceId);
  if (!form.allocations.length) {
    form.partyId = "";
    form.partyCode = "";
    form.partyName = "";
  }
  renumberLines();
  markDirty();
}

function renumberLines() {
  form.fundLines.forEach((line, index) => { line.lineNo = index + 1; });
  form.allocations.forEach((line, index) => { line.lineNo = index + 1; });
}

function markDirty() {
  emit("markDirty");
}

const MAX_MONEY_UNITS = 999999999999999999n;

function moneyInputs(): SettlementMoney[] {
  return [
    ...form.fundLines.flatMap((line) => [line.amount, line.fee]),
    ...form.allocations.map((line) => line.settlementAmount)
  ];
}

function hasInvalidMoneyInputs() {
  return moneyInputs().some((value) => moneyUnits(value) === null);
}

function hasNegativeAmounts() {
  return moneyInputs().some((value) => (moneyUnits(value) ?? 0n) < 0n);
}

function hasOutOfRangeAmounts() {
  const lineOutOfRange = moneyInputs().some((value) => {
    const units = moneyUnits(value) ?? 0n;
    return (units < 0n ? -units : units) > MAX_MONEY_UNITS;
  });
  return lineOutOfRange || allocationTotal.value > MAX_MONEY_UNITS || fundTotal.value > MAX_MONEY_UNITS;
}

function fundRowKey(row: unknown) {
  return (row as SettlementFundLine).accountId;
}

function allocationRowKey(row: unknown) {
  return (row as SettlementAllocationLine).sourceId;
}

function sourceOptionRowKey(row: SettlementSourceOption | unknown) {
  const option = row as SettlementSourceOption;
  return option.id || option.sourceId;
}

function accountOptionRowKey(row: SettlementAccountOption | unknown) {
  return (row as SettlementAccountOption).id;
}

function formatSourceOptionCell(row: unknown, key: string) {
  const option = row as SettlementSourceOption;
  if (["amount", "settledAmount", "unsettledAmount"].includes(key)) {
    return formatMoney(option[key as "amount" | "settledAmount" | "unsettledAmount"]);
  }
  return String((option as unknown as Record<string, unknown>)[key] ?? "-");
}

function formatAccountOptionCell(row: unknown, key: string) {
  const option = row as SettlementAccountOption;
  if (key === "accountType") {
    return accountTypeLabel(option.accountType);
  }
  return String((option as unknown as Record<string, unknown>)[key] ?? "-");
}

function accountTypeLabel(type: string) {
  return ({ CASH: "现金", BANK: "银行账户", DEPOSIT: "存款账户" } as Record<string, string>)[type] ?? type;
}

function tableColumn(key: string, title: string, width: number, align: "left" | "center" | "right" = "left"): TableCoreColumn {
  return { key, title, width, minWidth: width, align, filterable: false, resizable: false };
}

function sumMoneyUnits(values: unknown[]) {
  return values.reduce<bigint>((sum, value) => sum + (moneyUnits(value) ?? 0n), 0n);
}

function moneyUnits(value: unknown) {
  const text = String(value ?? "").trim();
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d{0,2}))?$/);
  if (!match) {
    return null;
  }
  const integerDigits = match[2].replace(/^0+(?=\d)/, "");
  if (integerDigits.length > 16) {
    return match[1] === "-" ? -(MAX_MONEY_UNITS + 1n) : MAX_MONEY_UNITS + 1n;
  }
  const fraction = (match[3] ?? "").padEnd(2, "0");
  const units = BigInt(integerDigits) * 100n + BigInt(fraction || "0");
  return match[1] === "-" ? -units : units;
}

function normalizedMoney(value: unknown) {
  return moneyFromUnits(moneyUnits(value) ?? 0n);
}

function moneyFromUnits(units: bigint): SettlementMoney {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  return `${negative && absolute !== 0n ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

function formatMoney(value: unknown) {
  return typeof value === "bigint" ? moneyFromUnits(value) : normalizedMoney(value);
}

function todayText() {
  const today = new Date();
  return [today.getFullYear(), String(today.getMonth() + 1).padStart(2, "0"), String(today.getDate()).padStart(2, "0")].join("-");
}

defineExpose({ startNew, loadByBillNo });
</script>

<style scoped>
.settlement-layout {
  min-height: 0;
  display: grid;
  grid-template-rows: auto minmax(180px, 1fr) minmax(180px, 1fr);
  gap: 6px;
  flex: 1 1 auto;
}

.settlement-layout.has-legacy {
  grid-template-rows: auto auto minmax(180px, 1fr) minmax(180px, 1fr);
}

.legacy-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  border: 1px solid #e4c27b;
  border-radius: 4px;
  background: #fff8e8;
  color: #72541d;
  padding: 8px 12px;
}

.settlement-head {
  display: grid;
  grid-template-columns: repeat(4, minmax(170px, 1fr));
  gap: 10px 18px;
  border: 1px solid #d4dde8;
  background: #fff;
  padding: 12px 18px;
}

.settlement-head label {
  min-width: 0;
  display: grid;
  gap: 3px;
  color: #536272;
  font-size: 12px;
}

.settlement-head input,
.settlement-head select {
  min-width: 0;
  height: 28px;
  border: 0;
  border-bottom: 1px solid #d9e1ea;
  background: #fff;
  color: #18293a;
}

.head-remark {
  grid-column: span 1;
}

.settlement-section {
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid #d4dde8;
  background: #fff;
}

.section-head {
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid #d9e1ea;
  padding: 6px 10px;
}

.section-head h3 {
  margin: 0 0 2px;
  font-size: 14px;
}

.section-head span,
.section-head strong {
  color: #5f6f80;
  font-size: 12px;
}

.section-head strong.mismatch {
  color: #b04436;
}

.section-head button {
  height: 28px;
  border: 1px solid #afc0d2;
  border-radius: 4px;
  background: #fff;
  color: #24435e;
  padding: 0 12px;
}

:deep(.settlement-table-frame) {
  min-height: 0;
  flex: 1 1 auto;
}

.settlement-cell {
  min-width: 0;
  min-height: 28px;
  display: flex;
  align-items: center;
  overflow: hidden;
}

.settlement-cell > span {
  display: block;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settlement-cell input,
.settlement-cell select {
  width: 100%;
  min-width: 0;
  height: 26px;
  border: 1px solid transparent;
  background: transparent;
  padding: 0 4px;
}

.settlement-cell input:focus,
.settlement-cell select:focus {
  border-color: #afc0d2;
  background: #fff;
  outline: 0;
}

.settlement-cell button {
  height: 24px;
  border: 0;
  background: transparent;
  color: #a43b31;
}

.empty-table {
  display: grid;
  min-height: 82px;
  place-items: center;
  color: #7a8794;
}

.settlement-confirm-dialog {
  width: min(440px, calc(100vw - 32px));
}

:deep(.settlement-table-frame .table-core-body-wrapper) {
  min-height: 82px;
}

:deep(.settlement-native-table table) {
  min-width: 100%;
}

@media (max-width: 1200px) {
  .settlement-head {
    grid-template-columns: repeat(2, minmax(180px, 1fr));
  }
}
</style>
