<template>
  <div v-if="pendingZeroEntrySave" class="modal-mask" data-testid="entry-zero-confirm-dialog">
    <div class="dialog entry-zero-confirm-dialog">
      <h3>零值分录确认</h3>
      <p>以下分录数量或单价为 0。若用于赠品、样品、补录等真实业务，可以确认后继续保存。</p>
      <table class="entry-zero-warning-table">
        <thead>
          <tr>
            <th>行号</th>
            <th>商品</th>
            <th>仓库</th>
            <th>数量</th>
            <th>单价</th>
            <th>原因</th>
            <th>业务说明</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="warning in pendingZeroEntrySave.warnings" :key="warning.lineNo">
            <td>第 {{ warning.lineNo }} 行</td>
            <td>{{ warning.productCode }}</td>
            <td>{{ warning.warehouseCode }}</td>
            <td>{{ formatQty(warning.qty) }}</td>
            <td>{{ formatAmount(warning.unitPrice) }}</td>
            <td>{{ warning.reasons.join("、") }}</td>
            <td>
              <select v-model="warning.reason" :data-testid="zeroReasonTestId(warning.lineNo)">
                <option v-for="option in zeroReasonOptions" :key="option" :value="option">{{ option }}</option>
              </select>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="dialog-actions">
        <button type="button" data-testid="entry-zero-cancel" @click="emit('cancelZeroEntrySave')">取消</button>
        <button class="primary-action" type="button" data-testid="entry-zero-confirm" @click="emit('confirmZeroEntrySave')">确认保存</button>
      </div>
    </div>
  </div>

  <div v-if="downstreamTrace" class="modal-mask" data-testid="downstream-trace-dialog">
    <div class="dialog downstream-trace-dialog">
      <h3>{{ downstreamTrace.title }}</h3>
      <p>源单第 {{ downstreamTrace.lineNo }} 行已执行 {{ downstreamTrace.executedQty }}，以下单据参与了该行执行。</p>
      <div class="downstream-impact-note" data-testid="downstream-impact-note">
        <strong>影响提示</strong>
        <span>反审核或红冲下游执行单据会回退源单行已执行数量，并重新计算源单执行状态；操作前请确认库存与后续单据链。</span>
      </div>
      <table class="downstream-trace-table">
        <thead>
          <tr>
            <th>单据类型</th>
            <th>单据编号</th>
            <th>日期</th>
            <th>状态</th>
            <th>源行</th>
            <th>下游行</th>
            <th>数量</th>
            <th>金额</th>
            <th>反审核影响</th>
            <th>红冲影响</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(doc, docIndex) in downstreamTrace.docs" :key="`${doc.type}-${doc.billNo}-${docIndex}`">
            <td>{{ doc.typeLabel || downstreamTypeLabel(doc.type) }}</td>
            <td>
              <button
                class="downstream-doc-link"
                type="button"
                :data-testid="downstreamDocTestId(docIndex)"
                @click="emit('openDownstreamDocument', doc)"
              >
                {{ doc.billNo }}
              </button>
            </td>
            <td>{{ doc.billDate || "-" }}</td>
            <td>{{ backendStatusLabel(doc.status) }}</td>
            <td>#{{ doc.sourceLineNo }}</td>
            <td>#{{ doc.downstreamLineNo }}</td>
            <td>{{ formatQty(doc.qty) }}</td>
            <td>{{ formatAmount(doc.amount) }}</td>
            <td class="impact-cell">{{ doc.reverseImpact || downstreamReverseImpact(doc) }}</td>
            <td class="impact-cell">{{ doc.redReverseImpact || downstreamRedReverseImpact(doc) }}</td>
          </tr>
        </tbody>
      </table>
      <div class="dialog-actions">
        <button type="button" data-testid="downstream-trace-close" @click="emit('closeDownstreamTrace')">关闭</button>
      </div>
    </div>
  </div>

  <div v-if="pendingRiskyDocumentAction" class="modal-mask" data-testid="risky-action-dialog">
    <div class="dialog risky-action-dialog">
      <h3>{{ riskyActionTitle }}</h3>
      <p>{{ riskyActionSummary }}</p>
      <div class="downstream-impact-note">
        <strong>影响提示</strong>
        <span>{{ riskyActionImpact }}</span>
      </div>
      <dl class="risky-action-fields">
        <div>
          <dt>单据编号</dt>
          <dd>{{ currentBillNo }}</dd>
        </div>
        <div>
          <dt>当前状态</dt>
          <dd>{{ currentOrderStatusLabel }}</dd>
        </div>
        <div v-if="pendingRiskyDocumentAction === 'redReverse'">
          <dt>红冲单号</dt>
          <dd>{{ redReverseBillNo }}</dd>
        </div>
      </dl>
      <div class="dialog-actions">
        <button type="button" data-testid="risky-action-cancel" @click="emit('cancelRiskyDocumentAction')">取消</button>
        <button class="primary-action" type="button" data-testid="risky-action-confirm" @click="emit('confirmRiskyDocumentAction')">确认{{ riskyActionVerb }}</button>
      </div>
    </div>
  </div>

  <div v-if="pendingEntryPaste" class="modal-mask" data-testid="entry-paste-conflict-dialog">
    <div ref="entryPasteDialogRef" class="dialog entry-paste-conflict-dialog" tabindex="-1" @keydown="emit('handleEntryPasteConflictKeydown', $event)">
      <h3>选择商品</h3>
      <p>粘贴内容里有商品名称对应多个资料，请选定后再写入分录。</p>
      <div v-for="conflict in pendingEntryPaste.conflicts" :key="conflict.lineIndex" class="entry-paste-conflict">
        <div class="entry-paste-conflict-title">第 {{ conflict.lineIndex + 1 }} 行：{{ conflict.productText }}</div>
        <div class="entry-paste-candidates">
          <button
            v-for="(candidate, candidateIndex) in conflict.candidates"
            :key="candidate.code"
            type="button"
            class="entry-paste-candidate"
            :class="{ selected: conflict.selectedCode === candidate.code, active: isEntryPasteCandidateActive(conflict, candidateIndex) }"
            :data-testid="entryPasteCandidateTestId(conflict.lineIndex, candidate.code)"
            @click="emit('selectEntryPasteCandidate', conflict.lineIndex, candidate.code)"
          >
            <strong>{{ candidate.code }}</strong>
            <span>{{ candidate.name }}</span>
            <span>{{ candidate.spec || "-" }}</span>
            <small>{{ candidate.unit || "" }}</small>
          </button>
        </div>
      </div>
      <div class="dialog-actions">
        <button type="button" data-testid="entry-paste-cancel" @click="emit('cancelPendingEntryPaste')">取消</button>
        <button type="button" data-testid="entry-paste-confirm" :disabled="!entryPasteConflictsResolved" @click="emit('confirmPendingEntryPaste')">确定</button>
      </div>
    </div>
  </div>

  <div v-if="pendingPushDown" class="modal-mask" data-testid="push-confirm-dialog">
    <div class="dialog push-confirm-dialog">
      <h3>{{ pendingPushDown.title }}</h3>
      <p>{{ pendingPushDown.sourceBillNo }} 可按剩余数量下推，确认本次数量后生成{{ pendingPushDown.targetTitle }}草稿。</p>
      <div class="push-confirm-tools">
        <button type="button" data-testid="push-confirm-clear" @click="emit('clearPushDownQtys')">清零</button>
        <button type="button" data-testid="push-confirm-all" @click="emit('fillAllRemainingQtys')">全剩余</button>
        <button type="button" data-testid="push-confirm-invert-selection" @click="emit('invertPushDownSelection')">反选</button>
        <label>
          比例
          <input :value="pushConfirmRatio" inputmode="decimal" data-testid="push-confirm-ratio" @input="emit('update:pushConfirmRatio', Number(($event.target as HTMLInputElement).value))" />
          <span>%</span>
        </label>
        <button type="button" data-testid="push-confirm-apply-ratio" @click="emit('applyPushDownRatio')">按比例</button>
        <label>
          仓库
          <input :value="pushConfirmWarehouseCode" data-testid="push-confirm-warehouse-code" @input="emit('update:pushConfirmWarehouseCode', ($event.target as HTMLInputElement).value)" />
        </label>
        <button type="button" data-testid="push-confirm-apply-warehouse" @click="emit('applyPushDownWarehouse')">应用仓库</button>
        <span class="push-confirm-selection" data-testid="push-confirm-selection-summary">{{ pushConfirmSelectionSummary }}</span>
      </div>
      <div class="push-confirm-table">
        <table>
          <thead>
            <tr>
              <th class="selection-cell">
                <input
                  type="checkbox"
                  :checked="allPushDownLinesSelected"
                  data-testid="push-confirm-select-all"
                  @change="emit('toggleAllPushDownLinesFromEvent', $event)"
                />
              </th>
              <th>商品</th>
              <th>仓库</th>
              <th>源单</th>
              <th>已执行</th>
              <th>剩余</th>
              <th>本次</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(line, lineIndex) in pendingPushDown.lines" :key="`${line.productCode}-${lineIndex}`">
              <td class="selection-cell">
                <input v-model="line.selected" type="checkbox" :data-testid="pushConfirmSelectTestId(lineIndex)" />
              </td>
              <td>
                <strong>{{ line.productCode }}</strong>
                <span>{{ line.productName || line.spec }}</span>
              </td>
              <td :data-testid="pushConfirmWarehouseTestId(lineIndex)">{{ line.warehouseCode }}</td>
              <td>{{ line.sourceQty }}</td>
              <td>{{ line.executedQty }}</td>
              <td>{{ line.remainingQty }}</td>
              <td>
                <input v-model.number="line.qty" inputmode="decimal" :data-testid="pushConfirmQtyTestId(lineIndex)" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="push-confirm-summary">
        <span>本次数量合计</span>
        <strong data-testid="push-confirm-total">{{ pendingPushDownTotal }}</strong>
      </div>
      <p v-if="pushConfirmError" class="form-error" data-testid="push-confirm-error">{{ pushConfirmError }}</p>
      <div class="dialog-actions">
        <button type="button" data-testid="push-confirm-cancel" @click="emit('cancelPushDown')">取消</button>
        <button class="primary-action" type="button" data-testid="push-confirm-ok" @click="emit('confirmPushDown')">生成草稿</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import type { DownstreamDocumentRef, OpenableDocumentType } from "../services/documentApi";
import type { DownstreamTraceState, EntryPasteConflict, PendingEntryPaste, PendingPushDown, PendingZeroEntrySave, RiskyDocumentAction } from "../app/documentModel";

const props = defineProps<{
  pendingZeroEntrySave: PendingZeroEntrySave | null;
  zeroReasonOptions: string[];
  downstreamTrace: DownstreamTraceState | null;
  pendingRiskyDocumentAction: RiskyDocumentAction | null;
  pendingEntryPaste: PendingEntryPaste | null;
  pendingPushDown: PendingPushDown | null;
  currentBillNo: string;
  currentOrderStatusLabel: string;
  redReverseBillNo: string;
  riskyActionTitle: string;
  riskyActionSummary: string;
  riskyActionImpact: string;
  riskyActionVerb: string;
  entryPasteConflictsResolved: boolean;
  pushConfirmRatio: number;
  pushConfirmWarehouseCode: string;
  pushConfirmSelectionSummary: string;
  allPushDownLinesSelected: boolean;
  pendingPushDownTotal: string;
  pushConfirmError: string;
  formatQty: (value: number | string | undefined) => string;
  formatAmount: (value: number | string | undefined) => string;
  zeroReasonTestId: (lineNo: number) => string;
  downstreamTypeLabel: (type: OpenableDocumentType) => string;
  backendStatusLabel: (status: string | undefined) => string;
  downstreamReverseImpact: (doc: DownstreamDocumentRef) => string;
  downstreamRedReverseImpact: (doc: DownstreamDocumentRef) => string;
  downstreamDocTestId: (index: number) => string;
  entryPasteCandidateTestId: (lineIndex: number, code: string) => string;
  isEntryPasteCandidateActive: (conflict: EntryPasteConflict, candidateIndex: number) => boolean;
  pushConfirmSelectTestId: (lineIndex: number) => string;
  pushConfirmWarehouseTestId: (lineIndex: number) => string;
  pushConfirmQtyTestId: (lineIndex: number) => string;
}>();

const emit = defineEmits<{
  cancelZeroEntrySave: [];
  confirmZeroEntrySave: [];
  closeDownstreamTrace: [];
  openDownstreamDocument: [doc: DownstreamDocumentRef];
  cancelRiskyDocumentAction: [];
  confirmRiskyDocumentAction: [];
  handleEntryPasteConflictKeydown: [event: KeyboardEvent];
  selectEntryPasteCandidate: [lineIndex: number, code: string];
  cancelPendingEntryPaste: [];
  confirmPendingEntryPaste: [];
  "update:pushConfirmRatio": [value: number];
  "update:pushConfirmWarehouseCode": [value: string];
  clearPushDownQtys: [];
  fillAllRemainingQtys: [];
  invertPushDownSelection: [];
  applyPushDownRatio: [];
  applyPushDownWarehouse: [];
  toggleAllPushDownLinesFromEvent: [event: Event];
  cancelPushDown: [];
  confirmPushDown: [];
}>();

const entryPasteDialogRef = ref<HTMLElement | null>(null);

watch(
  () => props.pendingEntryPaste,
  async (pending) => {
    if (!pending) {
      return;
    }
    await nextTick();
    entryPasteDialogRef.value?.focus();
  }
);
</script>
