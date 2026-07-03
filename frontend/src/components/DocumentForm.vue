<template>
  <StandardDocument
    :title="title"
    :subtitle="subtitle"
    :status-label="statusLabel"
    :status-class="statusClass"
    :locked="locked"
    :lock-message="lockMessage"
    :can-override-lock="canOverrideLock"
    :dirty="dirty"
    :message="message"
    :can-save="isDraft"
    :can-audit="canAudit"
    :can-reverse="canReverse"
    :can-red-reverse="canRedReverse"
    :can-void="canVoid"
    :show-red-reverse="showRedReverse"
    :show-void="showVoid"
    :can-close="canClose"
    :can-unclose="canUnclose"
    :can-freeze="canFreeze"
    :can-unfreeze="canUnfreeze"
    :show-close="showClose"
    :show-unclose="showUnclose"
    :show-freeze="showFreeze"
    :show-unfreeze="showUnfreeze"
    :show-delete="showDelete"
    :can-delete="canDelete"
    :can-output="isDocumentForm"
    :show-push-down="showPushDown"
    :can-push-down="canPushDown"
    :push-down-label="pushDownLabel"
    :push-down-test-id="pushDownTestId"
    :show-source-select="showSourceSelect"
    :can-source-select="canSourceSelect"
    :source-select-label="sourceSelectLabel"
    :source-select-test-id="sourceSelectTestId"
    :show-extra-action="showExtraAction"
    :can-extra-action="canExtraAction"
    :extra-action-label="extraActionLabel"
    :extra-action-test-id="extraActionTestId"
    @create="emit('create')"
    @save="emit('save')"
    @audit="emit('audit')"
    @reverse="emit('reverse')"
    @red-reverse="emit('redReverse')"
    @void-document="emit('voidDocument')"
    @close-document="emit('closeDocument')"
    @unclose-document="emit('uncloseDocument')"
    @freeze-document="emit('freezeDocument')"
    @unfreeze-document="emit('unfreezeDocument')"
    @source-select="emit('sourceSelect')"
    @push-down="emit('pushDown')"
    @extra-action="emit('extraAction')"
    @delete-document="emit('deleteDocument')"
    @export-document="emit('exportDocument')"
    @print-document="emit('printDocument')"
    @show-existing="emit('showExisting')"
    @override-lock="emit('overrideLock')"
  >
    <div v-if="isDocumentForm" class="form-layout">
      <section class="form-head-fields">
        <div v-if="$slots.sourceActions || form.redReverseBillNo || form.redSourceBillNo" class="source-order-field">
          <slot name="sourceActions" />
          <button v-if="form.redReverseBillNo" class="red-reverse-link" type="button" data-testid="open-red-reverse-bill" @click="emit('openRedReverseBill')">红字单 {{ form.redReverseBillNo }}</button>
          <button v-if="form.redSourceBillNo" class="red-reverse-link" type="button" data-testid="open-red-source-bill" @click="emit('openRedSourceBill')">来源原单 {{ form.redSourceBillNo }}</button>
        </div>
        <FieldRenderer
          v-for="field in documentHeadFields"
          :key="field.name"
          :field="field"
          :value="documentHeadFieldValue(field.name)"
          :disabled="locked"
          variant="document"
          lookup-keyboard-mode="native"
          id-prefix="document-head"
          :lookup-open="field.name === 'partyCode' && activeSelector === partySelectorId"
          :lookup-options="partyLookupOptions"
          :lookup-highlight-index="selectorCursorIndex"
          :show-lookup-button="field.name === 'partyCode'"
          :lookup-button-test-id="field.name === 'partyCode' ? `${testPrefix}-party-open-selector` : ''"
          @update-value="updateDocumentHeadField"
          @lookup-open="openDocumentHeadLookup"
          @lookup-input="inputDocumentHeadLookup"
          @lookup-keydown="keydownDocumentHeadLookup"
          @lookup-button-click="openDocumentHeadLookupDialog"
          @lookup-select="selectDocumentHeadLookupOption"
        />
      </section>

      <EntryTable
        :lines="form.lines"
        :test-prefix="testPrefix"
        :is-draft="isDraft && !locked"
        :batch-warehouse-code="batchWarehouseCode"
        :batch-plan-delivery-date="batchPlanDeliveryDate"
        :active-selector="activeSelector"
        :selector-options="selectorOptions"
        :selector-cursor-index="selectorCursorIndex"
        :known-product-options="knownProductOptions"
        :dragging-line-index="draggingLineIndex"
        :highlighted-source-bill-no="highlightedSourceBillNo"
        :highlighted-source-line-no="highlightedSourceLineNo"
        :current-bill-no="form.billNo"
        :party-code="form.partyCode"
        :party-code-label="`${partyLabel}编码`"
        :show-party-code-column="showPartyCodeColumn"
        :show-customer-material-code-column="showCustomerMaterialCodeColumn"
        :show-supplier-material-code-column="showSupplierMaterialCodeColumn"
        :show-customer-order-no-column="showCustomerOrderNoColumn"
        :show-source-line-column="showSourceLineColumn"
        :show-execution-columns="showExecutionColumns"
        :show-target-warehouse-column="showTargetWarehouseColumn"
        :show-plan-delivery-date-column="showPlanDeliveryDateColumn"
        :show-stock-columns="showStockColumns"
        :show-line-close-status="showLineCloseStatus"
        :enable-sales-price-bulk="enableSalesPriceBulk"
        :sales-price-customer-code="form.partyCode"
        :execution-qty-label="executionQtyLabel"
        :remaining-qty-label="remainingQtyLabel"
        :entry-table-colspan="entryTableColspan"
        :entry-total-colspan="entryTotalColspan"
        :total-amount="totalAmount"
        :is-tax-inclusive="isTaxInclusive"
        :show-tax-columns="showTaxMode"
        @update:batch-warehouse-code="emit('update:batchWarehouseCode', $event)"
        @update:batch-plan-delivery-date="emit('update:batchPlanDeliveryDate', $event)"
        @apply-batch-warehouse="emit('applyBatchWarehouse')"
        @apply-batch-plan-delivery-date="emit('applyBatchPlanDeliveryDate', $event)"
        @mark-dirty="emit('markDirty')"
        @search-master-options="(type, keyword, selectorId) => emit('searchMasterOptions', type, keyword, selectorId)"
        @handle-master-input="(type, keyword, selectorId) => emit('handleMasterInput', type, keyword, selectorId)"
        @handle-selector-keydown="(event, selectorId) => emit('handleSelectorKeydown', event, selectorId)"
        @open-master-selector-dialog="(type, selectorId, keyword) => emit('openMasterSelectorDialog', type, selectorId, keyword)"
        @select-line-product="(option, lineIndex, selectorId) => emit('selectLineProduct', option, lineIndex, selectorId)"
        @select-warehouse-option="(option, lineIndex, selectorId) => emit('selectWarehouseOption', option, lineIndex, selectorId)"
        @select-target-warehouse-option="(option, lineIndex, selectorId) => emit('selectTargetWarehouseOption', option, lineIndex, selectorId)"
        @entry-paste="(event, lineIndex) => emit('entryPaste', event, lineIndex)"
        @trace-source-order="(sourceLineNo, sourceOrderNo) => emit('traceSourceOrder', sourceLineNo, sourceOrderNo)"
        @open-downstream-trace="(line, lineIndex) => emit('openDownstreamTrace', line, lineIndex)"
        @line-drag-start="(event, lineIndex) => emit('lineDragStart', event, lineIndex)"
        @line-drag-over="emit('lineDragOver', $event)"
        @line-drop="emit('lineDrop', $event)"
        @line-drag-end="emit('lineDragEnd')"
        @insert-line-after="emit('insertLineAfter', $event)"
        @remove-line="emit('removeLine', $event)"
        @copy-line="emit('copyLine', $event)"
        @line-lifecycle="(lineNo, action) => emit('lineLifecycle', lineNo, action)"
        @add-line="emit('addLine')"
        @refresh-stock="emit('refreshStock')"
      />
      <MasterSelectorDialog
        :open="masterSelectorDialogOpen"
        :type="masterSelectorDialogType"
        :title="masterSelectorDialogTitle"
        :label="masterSelectorDialogLabel"
        :keyword="masterSelectorDialogKeyword"
        @close="emit('closeMasterSelectorDialog')"
        @select="emit('selectMasterSelectorDialogRow', $event)"
      />
    </div>
    <div v-else class="empty-shell">该表单正在等待本批次接入，先保留统一工作区和页签行为。</div>
  </StandardDocument>
</template>

<script setup lang="ts">
import { computed } from "vue";
import EntryTable, { type EntryLine, type MasterOption } from "./EntryTable.vue";
import FieldRenderer from "./fields/FieldRenderer.vue";
import type { FieldDefinition, FieldLookupOption } from "./fields/types";
import MasterSelectorDialog from "./MasterSelectorDialog.vue";
import StandardDocument from "./StandardDocument.vue";

interface DocumentFormState {
  billNo: string;
  sourceOrderNo?: string;
  redReverseBillNo?: string;
  redSourceBillNo?: string;
  partyCode: string;
  partyName?: string;
  billDate: string;
  department: string;
  ownerName: string;
  remark?: string;
  status: "DRAFT" | "AUDITED" | "REVERSED" | "VOIDED" | "RED_REVERSED";
  validUntil?: string;
  lines: EntryLine[];
}

const props = withDefaults(defineProps<{
  title: string;
  subtitle: string;
  statusLabel: string;
  statusClass: string;
  locked: boolean;
  lockMessage?: string;
  canOverrideLock?: boolean;
  dirty: boolean;
  message: string;
  form: DocumentFormState;
  testPrefix: string;
  partyLabel: string;
  partyType: string;
  isDocumentForm: boolean;
  isStockDocumentForm: boolean;
  isDraft: boolean;
  canAudit: boolean;
  canReverse: boolean;
  canRedReverse?: boolean;
  canVoid: boolean;
  showRedReverse?: boolean;
  showVoid?: boolean;
  canClose?: boolean;
  canUnclose?: boolean;
  canFreeze?: boolean;
  canUnfreeze?: boolean;
  showClose?: boolean;
  showUnclose?: boolean;
  showFreeze?: boolean;
  showUnfreeze?: boolean;
  showDelete?: boolean;
  canDelete: boolean;
  showPushDown?: boolean;
  canPushDown?: boolean;
  pushDownLabel?: string;
  pushDownTestId?: string;
  showSourceSelect?: boolean;
  canSourceSelect?: boolean;
  sourceSelectLabel?: string;
  sourceSelectTestId?: string;
  showExtraAction?: boolean;
  canExtraAction?: boolean;
  extraActionLabel?: string;
  extraActionTestId?: string;
  canTraceSourceOrder: boolean;
  showSourceLineColumn: boolean;
  showPartyCodeColumn?: boolean;
  showCustomerMaterialCodeColumn?: boolean;
  showSupplierMaterialCodeColumn?: boolean;
  showCustomerOrderNoColumn?: boolean;
  showExecutionColumns: boolean;
  showTargetWarehouseColumn?: boolean;
  showPlanDeliveryDateColumn?: boolean;
  showStockColumns?: boolean;
  showLineCloseStatus?: boolean;
  enableSalesPriceBulk?: boolean;
  executionQtyLabel?: string;
  remainingQtyLabel?: string;
  entryTableColspan: number;
  entryTotalColspan: number;
  totalAmount: string;
  showTaxMode?: boolean;
  showValidUntil?: boolean;
  isTaxInclusive?: boolean;
  batchWarehouseCode: string;
  batchPlanDeliveryDate?: string;
  activeSelector: string;
  selectorOptions: MasterOption[];
  selectorCursorIndex: number;
  masterSelectorDialogOpen: boolean;
  masterSelectorDialogType: string;
  masterSelectorDialogTitle: string;
  masterSelectorDialogLabel: string;
  masterSelectorDialogKeyword: string;
  knownProductOptions: MasterOption[];
  draggingLineIndex: number | null;
  highlightedSourceBillNo: string;
  highlightedSourceLineNo: number | null;
}>(), {
  lockMessage: "",
  canOverrideLock: false,
  canRedReverse: undefined,
  showRedReverse: true,
  showVoid: true,
  canClose: false,
  canUnclose: false,
  canFreeze: false,
  canUnfreeze: false,
  showClose: true,
  showUnclose: true,
  showFreeze: true,
  showUnfreeze: true,
  showDelete: true,
  showPushDown: false,
  canPushDown: false,
  pushDownLabel: "下推",
  pushDownTestId: "push-down-document",
  showSourceSelect: false,
  canSourceSelect: false,
  sourceSelectLabel: "选源单",
  sourceSelectTestId: "select-source-document",
  showExtraAction: false,
  canExtraAction: false,
  extraActionLabel: "执行",
  extraActionTestId: "extra-document-action",
  showValidUntil: false,
  showLineCloseStatus: true,
  enableSalesPriceBulk: false
});

const emit = defineEmits<{
  create: [];
  save: [];
  audit: [];
  reverse: [];
  redReverse: [];
  voidDocument: [];
  closeDocument: [];
  uncloseDocument: [];
  freezeDocument: [];
  unfreezeDocument: [];
  sourceSelect: [];
  pushDown: [];
  extraAction: [];
  deleteDocument: [];
  exportDocument: [];
  printDocument: [];
  showExisting: [];
  overrideLock: [];
  openRedReverseBill: [];
  openRedSourceBill: [];
  "update:batchWarehouseCode": [value: string];
  "update:batchPlanDeliveryDate": [value: string];
  "update:isTaxInclusive": [value: boolean];
  applyBatchWarehouse: [];
  applyBatchPlanDeliveryDate: [lineIndexes: number[]];
  markDirty: [];
  searchMasterOptions: [type: string, keyword: string, selectorId: string];
  handleMasterInput: [type: string, keyword: string, selectorId: string];
  handleSelectorKeydown: [event: KeyboardEvent, selectorId: string];
  openMasterSelectorDialog: [type: string, selectorId: string, keyword: string];
  closeMasterSelectorDialog: [];
  selectMasterSelectorDialogRow: [option: MasterOption];
  selectPartyOption: [option: MasterOption];
  selectLineProduct: [option: MasterOption, lineIndex: number, selectorId: string];
  selectWarehouseOption: [option: MasterOption, lineIndex: number, selectorId: string];
  selectTargetWarehouseOption: [option: MasterOption, lineIndex: number, selectorId: string];
  entryPaste: [event: ClipboardEvent, lineIndex: number];
  traceSourceOrder: [sourceLineNo?: number, sourceOrderNo?: string];
  openDownstreamTrace: [line: EntryLine, lineIndex: number];
  lineDragStart: [event: DragEvent, lineIndex: number];
  lineDragOver: [event: DragEvent];
  lineDrop: [lineIndex: number];
  lineDragEnd: [];
  insertLineAfter: [lineIndex: number];
  removeLine: [lineIndex: number];
  copyLine: [lineIndex: number];
  lineLifecycle: [lineNo: number, action: "close" | "unclose" | "freeze" | "unfreeze"];
  addLine: [];
  refreshStock: [];
}>();

const partySelectorId = computed(() => `${props.testPrefix}-party`);

const partyLookupOptions = computed<FieldLookupOption[]>(() => props.selectorOptions.map((option) => ({
  value: option.code,
  label: option.name,
  secondary: option.spec ?? option.unit ?? "",
  searchText: `${option.code} ${option.name} ${option.spec ?? ""} ${option.unit ?? ""}`.toLowerCase()
})));

const documentHeadFields = computed<FieldDefinition[]>(() => {
  const fields: FieldDefinition[] = [
    {
      name: "partyCode",
      label: `${props.partyLabel}编码`,
      testId: `${props.testPrefix}-party-code`,
      lookup: { listKey: props.partyType }
    },
    {
      name: "partyName",
      label: `${props.partyLabel}名称`,
      testId: `${props.testPrefix}-party-name`,
      readonly: true
    },
    {
      name: "billDate",
      label: "业务日期",
      testId: `${props.testPrefix}-bill-date`
    }
  ];
  if (props.showValidUntil) {
    fields.push({
      name: "validUntil",
      label: "报价有效期",
      testId: `${props.testPrefix}-valid-until`
    });
  }
  fields.push(
    {
      name: "billNo",
      label: "单据编号",
      testId: `${props.testPrefix}-bill-no`
    },
    {
      name: "department",
      label: "部门",
      testId: `${props.testPrefix}-department`
    },
    {
      name: "ownerName",
      label: "录入人",
      testId: `${props.testPrefix}-owner-name`,
      readonly: true
    }
  );
  if (props.showTaxMode) {
    fields.push({
      name: "taxMode",
      label: "价格口径",
      testId: `${props.testPrefix}-tax-mode`,
      options: [
        { value: "net", label: "不含税" },
        { value: "tax", label: "含税" }
      ]
    });
  }
  fields.push({
    name: "remark",
    label: "单据备注",
    type: "textarea",
    testId: `${props.testPrefix}-remark`,
    span: 3
  });
  return fields;
});

function documentHeadFieldValue(name: string) {
  const values: Record<string, string> = {
    partyCode: props.form.partyCode ?? "",
    partyName: props.form.partyName ?? "",
    billDate: props.form.billDate ?? "",
    validUntil: props.form.validUntil ?? "",
    billNo: props.form.billNo ?? "",
    department: props.form.department ?? "",
    ownerName: props.form.ownerName ?? "",
    taxMode: props.isTaxInclusive ? "tax" : "net",
    remark: props.form.remark ?? ""
  };
  return values[name] ?? "";
}

function updateDocumentHeadField(name: string, value: string) {
  if (name === "taxMode") {
    emit("update:isTaxInclusive", value === "tax");
    return;
  }
  if (name === "billDate") {
    props.form.billDate = value;
  } else if (name === "validUntil") {
    props.form.validUntil = value;
  } else if (name === "billNo") {
    props.form.billNo = value;
  } else if (name === "department") {
    props.form.department = value;
  } else if (name === "remark") {
    props.form.remark = value;
  } else {
    return;
  }
  emit("markDirty");
}

function openDocumentHeadLookup(field: FieldDefinition) {
  if (field.name !== "partyCode") {
    return;
  }
  emit("searchMasterOptions", props.partyType, props.form.partyCode, partySelectorId.value);
}

function inputDocumentHeadLookup(field: FieldDefinition, value: string) {
  if (field.name !== "partyCode") {
    return;
  }
  props.form.partyCode = value;
  emit("handleMasterInput", props.partyType, value, partySelectorId.value);
}

function keydownDocumentHeadLookup(field: FieldDefinition, event: KeyboardEvent) {
  if (field.name !== "partyCode") {
    return;
  }
  emit("handleSelectorKeydown", event, partySelectorId.value);
}

function openDocumentHeadLookupDialog(field: FieldDefinition) {
  if (field.name !== "partyCode") {
    return;
  }
  emit("openMasterSelectorDialog", props.partyType, partySelectorId.value, props.form.partyCode);
}

function selectDocumentHeadLookupOption(field: FieldDefinition, option: FieldLookupOption) {
  if (field.name !== "partyCode") {
    return;
  }
  const selected = props.selectorOptions.find((item) => item.code === option.value) ?? {
    code: option.value,
    name: option.label
  };
  emit("selectPartyOption", selected);
}
</script>
