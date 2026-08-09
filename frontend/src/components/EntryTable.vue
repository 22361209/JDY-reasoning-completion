<template>
  <div class="entry-tools">
    <button type="button" data-testid="entry-column-settings" @click="columnDialogOpen = true">列设置</button>
    <button v-if="showStockColumns" type="button" data-testid="refresh-entry-stock" @click="emit('refreshStock')">更新</button>
  </div>
  <TableCore
    kind="entry"
    test-id="entry-table-core"
    frame-class="entry-table"
    table-class="entry-native-table"
    :columns="entryCoreColumns"
    :rows="lines"
    :min-width="1180"
    :max-resize-width="420"
    :row-visible="rowMatchesFilters"
    :row-class="entryRowClass"
    :row-attrs="entryRowAttrs"
    :row-draggable="false"
    :cell-attrs="entryCellAttrs"
    @column-drag-start="startEntryColumnMouseDrag"
    @column-filter="openEntryColumnFilter"
    @column-resize="resizeEntryColumn"
    @column-resize-end="finishEntryColumnResize"
    @row-dragstart="handleEntryRowDragstart"
    @row-dragover="handleEntryRowDragover"
    @row-drop="handleEntryRowDrop"
    @row-dragend="handleEntryRowDragend"
  >
    <template #header-cell="{ column, startResize }">
      <TableCoreHeaderCell
        :title="column.title"
        :column-key="column.key"
        :test-id="column.dragTestId"
        :filter-test-id="column.filterTestId"
        :resize-test-id="column.resizeTestId"
        :filterable="column.filterable !== false"
        :resizable="column.resizable !== false"
        :filter-active="Boolean(column.filterActive)"
        :bulk-fillable="Boolean(column.bulkFillable)"
        :bulk-fill-active="bulkFillColumnKey === column.key"
        :bulk-fill-test-id="column.bulkFillTestId"
        :dragging="Boolean(column.dragging)"
        :drag-over="Boolean(column.dragOver)"
        @drag-start="startEntryColumnMouseDrag(column, $event)"
        @filter="openEntryColumnFilter(column, $event)"
        @bulk-fill="openEntryBulkFill(column, $event)"
        @resize-start="startResize(column, $event)"
      />
    </template>
    <template #cell="{ row: line, column, rowIndex: lineIndex }">
            <template v-if="column.key === 'productCode'">
              <span class="master-selector in-cell">
                <input
                  v-model="line.productCode"
                  :disabled="!isDraft || sourceLockedLines"
                  :data-testid="lineProductTestId(lineIndex)"
                  @focus="emit('searchMasterOptions', 'product', line.productCode, selectorIdForLine(lineIndex, 'product'))"
                  @input="emit('handleMasterInput', 'product', line.productCode, selectorIdForLine(lineIndex, 'product'))"
                  @keydown="handleLineCellKeydown($event, lineIndex, 'product', selectorIdForLine(lineIndex, 'product'))"
                  @paste="emit('entryPaste', $event, lineIndex)"
                />
                <button
                  class="master-selector__open"
                  type="button"
                  :disabled="!isDraft || sourceLockedLines"
                  :data-testid="`${lineProductTestId(lineIndex)}-open-selector`"
                  title="整列表选择"
                  aria-label="整列表选择"
                  @mousedown.prevent
                  @click="emit('openMasterSelectorDialog', 'product', selectorIdForLine(lineIndex, 'product'), line.productCode)"
                >...</button>
                <span v-if="activeSelector === selectorIdForLine(lineIndex, 'product')" class="master-selector__menu">
                  <button
                    v-for="(option, optionIndex) in selectorOptions"
                    :key="option.code"
                    type="button"
                    :class="{ selected: selectorCursorIndex === optionIndex }"
                    @mousedown.prevent="emit('selectLineProduct', option, lineIndex, selectorIdForLine(lineIndex, 'product'))"
                  >
                    <strong>{{ option.code }}</strong>
                    <span>{{ option.name }}</span>
                  </button>
                </span>
              </span>
            </template>
            <span v-else-if="column.key === 'rowNo'" class="entry-row-no">
              <span class="entry-row-no__value">{{ lineLineNo(line, lineIndex) }}</span>
              <span class="entry-row-no__quick-actions">
                <button
                  v-if="!sourceLockedLines"
                  type="button"
                  :disabled="!isDraft"
                  :data-testid="lineInsertTestId(lineIndex)"
                  title="在下方新增行"
                  @click.stop="emit('insertLineAfter', lineIndex)"
                >+</button>
                <button
                  type="button"
                  :disabled="!isDraft || (!sourceLockedLines && lines.length <= 1)"
                  :data-testid="lineDeleteTestId(lineIndex)"
                  title="删除本行"
                  @click.stop="emit('removeLine', lineIndex)"
                >-</button>
              </span>
            </span>
            <span v-else-if="column.key === 'partyCode'" class="entry-cell-value" :data-testid="columnCellTestId(column.key, lineIndex)">{{ partyCodeForLine }}</span>
            <input
              v-else-if="column.key === 'customerMaterialCode'"
              v-model="line.customerMaterialCode"
              :disabled="!isDraft || sourceLockedLines"
              :data-testid="lineCustomerMaterialCodeTestId(lineIndex)"
              @input="emit('markDirty')"
              @keydown="handleLineCellKeydown($event, lineIndex, 'customerMaterialCode')"
            />
            <input
              v-else-if="column.key === 'supplierMaterialCode'"
              v-model="line.supplierMaterialCode"
              :disabled="!isDraft || sourceLockedLines"
              :data-testid="lineSupplierMaterialCodeTestId(lineIndex)"
              @input="emit('markDirty')"
              @keydown="handleLineCellKeydown($event, lineIndex, 'supplierMaterialCode')"
            />
            <input
              v-else-if="column.key === 'customerOrderNo'"
              v-model="line.customerOrderNo"
              :disabled="!isDraft || sourceLockedLines"
              :data-testid="lineCustomerOrderNoTestId(lineIndex)"
              @input="emit('markDirty')"
              @keydown="handleLineCellKeydown($event, lineIndex, 'customerOrderNo')"
            />
            <span v-else-if="column.key === 'productName'" class="entry-cell-value">{{ productInfo(line).name }}</span>
            <span v-else-if="column.key === 'spec'" class="entry-cell-value">{{ productInfo(line).spec }}</span>
            <span v-else-if="column.key === 'unit'" class="entry-cell-value">{{ productInfo(line).unit }}</span>
            <span v-else-if="column.key === 'netWeight'" class="entry-cell-value entry-cell-value--number">{{ formatOptionalWeight(productInfo(line).netWeight) }}</span>
            <span v-else-if="column.key === 'grossWeight'" class="entry-cell-value entry-cell-value--number">{{ formatOptionalWeight(productInfo(line).grossWeight) }}</span>
            <template v-else-if="column.key === 'warehouse'">
              <span class="master-selector in-cell">
                <input
                  v-model="line.warehouseCode"
                  :disabled="!isDraft || sourceLockedLines"
                  :data-testid="lineWarehouseTestId(lineIndex)"
                  @focus="emit('searchMasterOptions', 'warehouse', line.warehouseCode, selectorIdForLine(lineIndex, 'warehouse'))"
                  @input="emit('handleMasterInput', 'warehouse', line.warehouseCode, selectorIdForLine(lineIndex, 'warehouse'))"
                  @keydown="handleLineCellKeydown($event, lineIndex, 'warehouse', selectorIdForLine(lineIndex, 'warehouse'))"
                  @paste="emit('entryPaste', $event, lineIndex)"
                />
                <button
                  class="master-selector__open"
                  type="button"
                  :disabled="!isDraft || sourceLockedLines"
                  :data-testid="`${lineWarehouseTestId(lineIndex)}-open-selector`"
                  title="整列表选择"
                  aria-label="整列表选择"
                  @mousedown.prevent
                  @click="emit('openMasterSelectorDialog', 'warehouse', selectorIdForLine(lineIndex, 'warehouse'), line.warehouseCode)"
                >...</button>
                <span v-if="activeSelector === selectorIdForLine(lineIndex, 'warehouse')" class="master-selector__menu">
                  <button
                    v-for="(option, optionIndex) in selectorOptions"
                    :key="option.code"
                    type="button"
                    :class="{ selected: selectorCursorIndex === optionIndex }"
                    @mousedown.prevent="emit('selectWarehouseOption', option, lineIndex, selectorIdForLine(lineIndex, 'warehouse'))"
                  >
                    <strong>{{ option.code }}</strong>
                    <span>{{ option.name }}</span>
                  </button>
                </span>
              </span>
            </template>
            <template v-else-if="column.key === 'targetWarehouse'">
              <span class="master-selector in-cell">
                <input
                  v-model="line.targetWarehouseCode"
                  :disabled="!isDraft || sourceLockedLines"
                  :data-testid="lineTargetWarehouseTestId(lineIndex)"
                  @focus="emit('searchMasterOptions', 'warehouse', line.targetWarehouseCode || '', selectorIdForLine(lineIndex, 'target-warehouse'))"
                  @input="emit('handleMasterInput', 'warehouse', line.targetWarehouseCode || '', selectorIdForLine(lineIndex, 'target-warehouse'))"
                  @keydown="handleLineCellKeydown($event, lineIndex, 'target-warehouse', selectorIdForLine(lineIndex, 'target-warehouse'))"
                  @paste="emit('entryPaste', $event, lineIndex)"
                />
                <button
                  class="master-selector__open"
                  type="button"
                  :disabled="!isDraft || sourceLockedLines"
                  :data-testid="`${lineTargetWarehouseTestId(lineIndex)}-open-selector`"
                  title="整列表选择"
                  aria-label="整列表选择"
                  @mousedown.prevent
                  @click="emit('openMasterSelectorDialog', 'warehouse', selectorIdForLine(lineIndex, 'target-warehouse'), line.targetWarehouseCode || '')"
                >...</button>
                <span v-if="activeSelector === selectorIdForLine(lineIndex, 'target-warehouse')" class="master-selector__menu">
                  <button
                    v-for="(option, optionIndex) in selectorOptions"
                    :key="option.code"
                    type="button"
                    :class="{ selected: selectorCursorIndex === optionIndex }"
                    @mousedown.prevent="emit('selectTargetWarehouseOption', option, lineIndex, selectorIdForLine(lineIndex, 'target-warehouse'))"
                  >
                    <strong>{{ option.code }}</strong>
                    <span>{{ option.name }}</span>
                  </button>
                </span>
              </span>
            </template>
            <template v-else-if="column.key === 'sourceOrderNo'">
              <button
                v-if="line.sourceOrderNo"
                class="entry-cell-value source-line-link"
                type="button"
                :data-testid="`${lineSourceOrderNoTestId(lineIndex)}-open`"
                @click="emit('traceSourceOrder', line.sourceLineNo, line.sourceOrderNo)"
              >
                {{ line.sourceOrderNo }}
              </button>
              <span v-else class="entry-cell-value">-</span>
            </template>
            <template v-else-if="column.key === 'sourceLineNo'">
              <button
                v-if="line.sourceOrderNo && line.sourceLineNo"
                class="entry-cell-value source-line-link"
                type="button"
                :data-testid="lineSourceTraceTestId(lineIndex)"
                @click="emit('traceSourceOrder', line.sourceLineNo, line.sourceOrderNo)"
              >
                {{ lineSourceLineNo(line) }}
              </button>
              <span v-else class="entry-cell-value">-</span>
            </template>
            <input
              v-else-if="column.key === 'qty'"
              v-model.number="line.qty"
              class="entry-number-input"
              :disabled="!isDraft"
              :data-testid="lineQtyTestId(lineIndex)"
              @input="emit('markDirty')"
              @keydown="handleLineCellKeydown($event, lineIndex, 'qty')"
              @paste="emit('entryPaste', $event, lineIndex)"
            />
            <template v-else-if="column.key === 'executedQty'">
              <button
                v-if="line.downstreamDocs?.length"
                class="entry-cell-value entry-cell-value--number source-line-link"
                type="button"
                :data-testid="lineDownstreamTraceTestId(lineIndex)"
                @click="emit('openDownstreamTrace', line, lineIndex)"
              >
                {{ lineExecutedQty(line) }}
              </button>
              <span v-else class="entry-cell-value entry-cell-value--number">{{ lineExecutedQty(line) }}</span>
            </template>
            <span v-else-if="column.key === 'remainingQty'" class="line-lifecycle-state">
              {{ lineRemainingQty(line) }}
              <small v-if="displayLineCloseStatus && line.lineCloseStatus === 'CLOSED'">已关闭</small>
              <small v-if="line.lineFrozenStatus === 'FROZEN'">已冻结</small>
            </span>
            <span v-else-if="column.key === 'stockOnHand'" class="entry-cell-value entry-cell-value--number">{{ formatQty(line.stockOnHand) }}</span>
            <span v-else-if="column.key === 'stockReserved'" class="entry-cell-value entry-cell-value--number">{{ formatQty(line.stockReserved) }}</span>
            <span v-else-if="column.key === 'stockAvailable'" class="entry-cell-value entry-cell-value--number">{{ formatQty(line.stockAvailable) }}</span>
            <span v-else-if="column.key === 'stockInTransit'" class="entry-cell-value entry-cell-value--number">{{ formatQty(line.stockInTransit) }}</span>
            <input
              v-else-if="column.key === 'unitPrice'"
              v-model.number="line.unitPrice"
              class="entry-number-input"
              :disabled="!isDraft || sourceLockedLines"
              :data-testid="linePriceTestId(lineIndex)"
              @input="emit('markDirty')"
              @keydown="handleLineCellKeydown($event, lineIndex, 'price')"
              @paste="emit('entryPaste', $event, lineIndex)"
            />
            <span v-else-if="column.key === 'taxInclusiveUnitPrice'" class="entry-cell-value entry-cell-value--number" :data-testid="lineTaxInclusiveUnitPriceTestId(lineIndex)">{{ lineTaxInclusiveUnitPrice(line) }}</span>
            <input
              v-else-if="column.key === 'taxRate'"
              v-model.number="line.taxRate"
              class="entry-number-input"
              :disabled="!isDraft || sourceLockedLines"
              :data-testid="lineTaxRateTestId(lineIndex)"
              @input="emit('markDirty')"
              @keydown="handleLineCellKeydown($event, lineIndex, 'taxRate')"
            />
            <span v-else-if="column.key === 'amount'" class="entry-cell-value entry-cell-value--number" :data-testid="lineAmountTestId(lineIndex)">{{ lineAmount(line) }}</span>
            <span v-else-if="column.key === 'taxAmount'" class="entry-cell-value entry-cell-value--number" :data-testid="lineTaxAmountTestId(lineIndex)">{{ lineTaxAmount(line) }}</span>
            <span v-else-if="column.key === 'priceTaxTotal'" class="entry-cell-value entry-cell-value--number" :data-testid="linePriceTaxTotalTestId(lineIndex)">{{ linePriceTaxTotal(line) }}</span>
            <span
              v-else-if="column.key === 'planDeliveryDate'"
              class="entry-date-cell"
              :class="{ 'is-disabled': !isDraft || sourceLockedLines }"
            >
              <input
                :value="line.planDeliveryDate || ''"
                :disabled="!isDraft || sourceLockedLines"
                :data-testid="linePlanDeliveryDateTestId(lineIndex)"
                placeholder="2026-05-01"
                @input="line.planDeliveryDate = ($event.target as HTMLInputElement).value; emit('markDirty')"
                @keydown="handleLineDateKeydown($event, lineIndex)"
                @blur="commitLineDate(lineIndex)"
              />
              <button
                type="button"
                class="entry-date-picker-button"
                :disabled="!isDraft || sourceLockedLines"
                :data-testid="`${linePlanDeliveryDateTestId(lineIndex)}-calendar`"
                title="选择日期"
                @mousedown.prevent
                @click="openLineDatePicker(lineIndex, $event)"
              />
            </span>
            <input
              v-else-if="column.key === 'remark'"
              v-model="line.lineRemark"
              :disabled="!isDraft"
              :data-testid="lineRemarkTestId(lineIndex)"
              @input="emit('markDirty')"
              @keydown="handleLineCellKeydown($event, lineIndex, 'remark')"
            />
    </template>
    <template #footer>
        <tr class="entry-total-row">
          <td v-for="column in visibleColumns" :key="column.key" :class="columnClass(column)" :data-testid="column.key === totalAmountColumnKey ? 'document-total-amount' : undefined">
            <template v-if="column.key === firstVisibleColumnKey">合计</template>
            <template v-else-if="column.key === 'qty'">{{ totalQty }}</template>
            <template v-else-if="column.key === 'amount'">{{ totalNetAmount }}</template>
            <template v-else-if="column.key === 'taxAmount'">{{ totalTaxAmount }}</template>
            <template v-else-if="column.key === 'priceTaxTotal'">{{ totalPriceTaxAmount }}</template>
          </td>
        </tr>
    </template>
  </TableCore>

  <ColumnSettingsDialog
    :open="columnDialogOpen"
    title="列设置"
    :columns="configurableColumns"
    dialog-test-id="entry-column-settings-dialog"
    ok-test-id="entry-column-settings-ok"
    @reset="resetColumnsToDefault"
    @confirm="closeColumnSettings"
  />

  <ColumnFilterPopover
    :open="filterDialogOpen && Boolean(activeFilterColumn)"
    :operators="tableFilterOperators"
    :operator="activeFilterOperator"
    :value="activeFilterValue"
    :left="filterPopoverLeft"
    :top="filterPopoverTop"
    test-id="entry-column-filter-dialog"
    @update:operator="activeFilterOperator = $event"
    @update:value="activeFilterValue = $event"
    @apply="applyColumnFilter"
    @clear="clearColumnFilter"
  />

  <div
    v-if="bulkFillColumnKey"
    class="column-bulk-popover"
    :style="{ left: `${bulkFillLeft}px`, top: `${bulkFillTop}px` }"
    data-testid="entry-column-bulk-dialog"
    @click.stop
    @mousedown.stop
  >
    <template v-if="bulkFillColumnKey === 'planDeliveryDate'">
      <strong>批量填充日期</strong>
      <span class="entry-date-cell column-bulk-date-input">
        <input
          v-model="bulkDateValue"
          data-testid="entry-bulk-date-input"
          placeholder="2026-05-01"
          @keydown.enter.prevent="applyBulkDate"
        />
        <button
          type="button"
          class="entry-date-picker-button"
          title="选择日期"
          @mousedown.prevent
          @click="openBulkDatePicker"
        />
      </span>
      <button type="button" class="primary-action" data-testid="entry-bulk-date-ok" @click="applyBulkDate">确定</button>
    </template>
    <template v-else-if="bulkFillColumnKey === 'warehouse'">
      <strong>批量填充仓库</strong>
      <input
        v-model="bulkWarehouseValue"
        data-testid="entry-bulk-warehouse-input"
        placeholder="仓库编码"
        @keydown.enter.prevent="applyBulkWarehouse"
      />
      <button type="button" class="primary-action" data-testid="entry-bulk-warehouse-ok" @click="applyBulkWarehouse">确定</button>
    </template>
    <template v-else-if="bulkFillColumnKey === 'qty'">
      <strong>批量填充数量</strong>
      <input
        v-model="bulkQtyValue"
        class="column-bulk-number-input"
        data-testid="entry-bulk-qty-input"
        placeholder="数量"
        @keydown.enter.prevent="applyBulkQty"
      />
      <button type="button" class="primary-action" data-testid="entry-bulk-qty-ok" @click="applyBulkQty">确定</button>
    </template>
    <template v-else-if="bulkFillColumnKey === 'unitPrice'">
      <strong>单价</strong>
      <select v-model="bulkPriceSourceKey" data-testid="entry-bulk-price-source">
        <option
          v-for="source in bulkPriceSourceOptions"
          :key="source.key"
          :value="source.key"
        >
          {{ source.label }}
        </option>
      </select>
      <select v-model="bulkPriceOperator" class="column-bulk-price-operator" data-testid="entry-bulk-price-operator">
        <option value="+">+</option>
        <option value="-">-</option>
        <option value="*">*</option>
        <option value="/">/</option>
      </select>
      <input
        v-model="bulkPriceFactor"
        class="column-bulk-price-factor"
        data-testid="entry-bulk-price-factor"
        placeholder="系数"
        @keydown.enter.prevent="applyBulkPrice"
      />
      <button type="button" class="primary-action" data-testid="entry-bulk-price-ok" @click="applyBulkPrice">确定</button>
      <small v-if="bulkPriceMessage" class="column-bulk-message" data-testid="entry-bulk-price-message">{{ bulkPriceMessage }}</small>
    </template>
  </div>

  <div
    v-if="datePickerOpen"
    class="entry-date-popover"
    :style="{ left: `${datePickerLeft}px`, top: `${datePickerTop}px` }"
    data-testid="entry-date-picker"
    @click.stop
    @mousedown.stop
  >
    <div class="entry-date-popover__head">
      <button type="button" @click="shiftDatePickerMonth(-1)">‹</button>
      <strong>{{ datePickerYear }}年 {{ datePickerMonth + 1 }}月</strong>
      <button type="button" @click="shiftDatePickerMonth(1)">›</button>
    </div>
    <div class="entry-date-popover__week">
      <span v-for="day in weekDays" :key="day">{{ day }}</span>
    </div>
    <div class="entry-date-popover__grid">
      <button
        v-for="day in datePickerDays"
        :key="day.key"
        type="button"
        :class="{ muted: !day.inMonth, selected: day.value === activeDatePickerValue }"
        @click="selectDatePickerDay(day.value)"
      >
        {{ day.label }}
      </button>
    </div>
  </div>

  <div
    v-if="columnReorder.draggingKey.value"
    class="column-drag-ghost"
    :style="{ left: `${columnReorder.dragGhostLeft.value}px`, top: `${columnReorder.dragGhostTop.value}px` }"
    data-testid="entry-column-drag-ghost"
  >
    {{ draggingColumnTitle }}
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { fetchSalesUnitPriceSources, type SalesUnitPriceSource, type SalesUnitPriceSourcesByProduct } from "../services/documentApi";
import ColumnFilterPopover from "./table/ColumnFilterPopover.vue";
import ColumnSettingsDialog from "./table/ColumnSettingsDialog.vue";
import TableCore, { type TableCoreColumn } from "./table/TableCore.vue";
import TableCoreHeaderCell from "./table/TableCoreHeaderCell.vue";
import { tableFilterOperators, useColumnFilters } from "./table/useColumnFilters";
import { canReorderColumn, useColumnReorder } from "./table/useColumnReorder";
import {
  buildDefaultEntryColumns,
  bulkPriceSourceOptions,
  entryColumnClass as columnClass,
  isColumnAvailable as isEntryColumnAvailable,
  isFrozenEntryColumn,
  loadEntryColumnPreferences,
  normalizeEntryColumns,
  numericColumns,
  saveEntryColumnPreferences
} from "./entry-table/useEntryTableColumns";
import type { EditableLineCell, EntryColumn, EntryColumnKey, EntryLine, MasterOption } from "./entry-table/types";
import {
  entryLineAmount,
  entryLineAmountValue,
  entryLineExecutedQty,
  entryLineNo,
  entryLinePriceTaxTotal,
  entryLinePriceTaxTotalValue,
  entryLineRemainingQty,
  entryLineTaxAmount,
  entryLineTaxAmountValue,
  entryLineTaxInclusiveUnitPrice,
  entryProductInfo,
  entrySourceLineNo,
  formatEntryPrice,
  formatEntryQty,
  formatOptionalWeight,
  taxForEntryLine
} from "./entry-table/useEntryTableCalculations";
import { createEntryTableTestIds } from "./entry-table/useEntryTableTestIds";

export type { EntryLine, MasterOption } from "./entry-table/types";

const props = withDefaults(defineProps<{
  lines: EntryLine[];
  testPrefix: string;
  isDraft: boolean;
  dirty?: boolean;
  batchWarehouseCode: string;
  batchPlanDeliveryDate?: string;
  activeSelector: string;
  selectorOptions: MasterOption[];
  selectorCursorIndex: number;
  knownProductOptions: MasterOption[];
  draggingLineIndex: number | null;
  highlightedSourceBillNo: string;
  highlightedSourceLineNo: number | null;
  currentBillNo: string;
  partyCode?: string;
  partyCodeLabel?: string;
  showPartyCodeColumn?: boolean;
  showCustomerMaterialCodeColumn?: boolean;
  showSupplierMaterialCodeColumn?: boolean;
  showCustomerOrderNoColumn?: boolean;
  showSourceLineColumn: boolean;
  showExecutionColumns: boolean;
  showTargetWarehouseColumn?: boolean;
  showPlanDeliveryDateColumn?: boolean;
  showStockColumns?: boolean;
  stockColumnMode?: "all" | "availableOnly";
  enableSalesPriceBulk?: boolean;
  salesPriceCustomerCode?: string;
  executionQtyLabel?: string;
  remainingQtyLabel?: string;
  qtyLabel?: string;
  stockAvailableLabel?: string;
  showExecutedQtyColumn?: boolean;
  requiredVisibleColumnKeys?: EntryColumnKey[];
  showPriceAmountColumns?: boolean;
  entryTableColspan: number;
  entryTotalColspan: number;
  totalAmount: string;
  showTaxColumns?: boolean;
  showLineCloseStatus?: boolean;
  sourceLockedLines?: boolean;
}>(), {
  showPriceAmountColumns: true,
  sourceLockedLines: false
});

const emit = defineEmits<{
  "update:batchWarehouseCode": [value: string];
  "update:batchPlanDeliveryDate": [value: string];
  applyBatchWarehouse: [];
  applyBatchPlanDeliveryDate: [lineIndexes: number[]];
  markDirty: [];
  searchMasterOptions: [type: string, keyword: string, selectorId: string];
  handleMasterInput: [type: string, keyword: string, selectorId: string];
  handleSelectorKeydown: [event: KeyboardEvent, selectorId: string];
  openMasterSelectorDialog: [type: string, selectorId: string, keyword: string];
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

const {
  selectorIdForLine,
  lineProductTestId,
  lineWarehouseTestId,
  lineTargetWarehouseTestId,
  lineQtyTestId,
  lineSourceLineNoTestId,
  lineSourceOrderNoTestId,
  lineSourceTraceTestId,
  lineDownstreamTraceTestId,
  lineExecutedQtyTestId,
  lineRemainingQtyTestId,
  linePriceTestId,
  lineTaxInclusiveUnitPriceTestId,
  lineTaxRateTestId,
  lineAmountTestId,
  lineTaxAmountTestId,
  linePriceTaxTotalTestId,
  lineRemarkTestId,
  lineCustomerMaterialCodeTestId,
  lineSupplierMaterialCodeTestId,
  lineCustomerOrderNoTestId,
  linePlanDeliveryDateTestId,
  lineDeleteTestId,
  lineInsertTestId,
  columnCellTestId
} = createEntryTableTestIds(() => props.testPrefix);

const columnDialogOpen = ref(false);
const columns = ref<EntryColumn[]>([]);
const bulkFillColumnKey = ref<EntryColumnKey | "">("");
const bulkFillLeft = ref(0);
const bulkFillTop = ref(0);
const bulkDateValue = ref("");
const bulkWarehouseValue = ref("");
const bulkQtyValue = ref("");
const bulkPriceSourceKey = ref("defaultPrice");
const bulkPriceOperator = ref("+");
const bulkPriceFactor = ref("0");
const bulkPriceMessage = ref("");
const datePickerOpen = ref(false);
const datePickerTarget = ref<{ type: "line"; lineIndex: number } | { type: "bulk" } | null>(null);
const datePickerLeft = ref(0);
const datePickerTop = ref(0);
const datePickerYear = ref(new Date().getFullYear());
const datePickerMonth = ref(new Date().getMonth());
const weekDays = ["一", "二", "三", "四", "五", "六", "日"];
const displayLineCloseStatus = computed(() => props.showLineCloseStatus !== false);

const columnReorder = useColumnReorder<EntryColumn>({
  getColumns: () => columns.value,
  setColumns: (nextColumns) => { columns.value = nextColumns; },
  getKey: (column) => column.key,
  getTitle: (column) => column.title,
  normalize: normalizeEntryColumns,
  canReorder: (column) => column.configurable !== false && canReorderColumn(column),
  onReorder: persistColumnPreferences
});
const {
  columnFilters,
  activeFilterColumn,
  filterDialogOpen,
  activeFilterOperator,
  activeFilterValue,
  filterPopoverLeft,
  filterPopoverTop,
  openColumnFilter,
  applyColumnFilter,
  clearColumnFilter,
  rowMatchesFilters,
  isFilterActive
} = useColumnFilters<EntryColumn>(entryColumnValue);

const defaultColumns = computed<EntryColumn[]>(() => buildDefaultEntryColumns(props));

const visibleColumns = computed(() => columns.value.filter((column) => isColumnAvailable(column) && column.visible));
const configurableColumns = computed(() => columns.value.filter((column) => column.configurable !== false && isColumnAvailable(column)));
const entryCoreColumns = computed<TableCoreColumn[]>(() => visibleColumns.value.map((column) => ({
  key: column.key,
  title: column.title,
  width: column.width,
  minWidth: column.configurable === false ? Math.min(column.width, 48) : 64,
  align: numericColumns.has(column.key) ? "right" : "left",
  fixed: column.fixed,
  filterable: column.configurable !== false,
  resizable: column.configurable !== false,
  filterActive: isFilterActive(column.key),
  bulkFillable: Boolean(column.bulkFillable) && props.isDraft && (!props.sourceLockedLines || column.key === "qty"),
  dragging: columnReorder.draggingKey.value === column.key,
  dragOver: columnReorder.dragOverKey.value === column.key,
  dragTestId: `entry-column-drag-${column.key}`,
  filterTestId: `entry-column-filter-${column.key}`,
  bulkFillTestId: `entry-column-bulk-${column.key}`,
  resizeTestId: `entry-column-resize-${column.key}`,
  headerClass: columnClass(column),
  cellClass: columnClass(column)
})));
const firstVisibleColumnKey = computed(() => visibleColumns.value.find((column) => !isFrozenEntryColumn(column.key))?.key ?? "productCode");
const totalQty = computed(() => formatQty(props.lines.reduce((sum, line) => sum + Number(line.qty || 0), 0)));
const previewPriceAmounts = computed(() => Boolean(props.dirty));
const totalNetAmount = computed(() => props.lines.reduce((sum, line) => sum + entryLineAmountValue(line, previewPriceAmounts.value), 0).toFixed(2));
const totalTaxAmount = computed(() => props.lines.reduce((sum, line) => sum + entryLineTaxAmountValue(line, previewPriceAmounts.value), 0).toFixed(2));
const totalPriceTaxAmount = computed(() => props.lines.reduce((sum, line) => sum + entryLinePriceTaxTotalValue(line, previewPriceAmounts.value), 0).toFixed(2));
const totalAmountColumnKey = computed<EntryColumnKey>(() => props.showTaxColumns ? "priceTaxTotal" : "amount");
const partyCodeForLine = computed(() => props.partyCode ?? "");
const draggingColumnTitle = columnReorder.draggingTitle;
const activeDatePickerValue = computed(() => {
  if (datePickerTarget.value?.type === "line") {
    return normalizeDateInput(props.lines[datePickerTarget.value.lineIndex]?.planDeliveryDate || "");
  }
  return normalizeDateInput(bulkDateValue.value);
});
const datePickerDays = computed(() => {
  const first = new Date(datePickerYear.value, datePickerMonth.value, 1);
  const startOffset = (first.getDay() + 6) % 7;
  const start = new Date(datePickerYear.value, datePickerMonth.value, 1 - startOffset);
  return Array.from({ length: 42 }, (_, index) => {
    const current = new Date(start);
    current.setDate(start.getDate() + index);
    const value = formatDateValue(current);
    return {
      key: value,
      value,
      label: String(current.getDate()),
      inMonth: current.getMonth() === datePickerMonth.value
    };
  });
});

watch(() => [
  props.testPrefix,
  props.showSourceLineColumn,
  props.showExecutionColumns,
  props.showTargetWarehouseColumn,
  props.partyCodeLabel,
  props.showPartyCodeColumn,
  props.showCustomerMaterialCodeColumn,
  props.showSupplierMaterialCodeColumn,
  props.showCustomerOrderNoColumn,
  props.showPlanDeliveryDateColumn,
  props.showTaxColumns,
  props.showStockColumns,
  props.stockColumnMode,
  props.executionQtyLabel,
  props.remainingQtyLabel,
  props.qtyLabel,
  props.stockAvailableLabel,
  props.showExecutedQtyColumn,
  props.requiredVisibleColumnKeys?.join("|"),
  props.showPriceAmountColumns
], resetColumns, { immediate: true });

onBeforeUnmount(() => {
  document.removeEventListener("click", closeFloatingPanels);
});

function resetColumns() {
  const defaults = defaultColumns.value;
  const saved = loadColumnPreferences();
  const defaultByKey = new Map(defaults.map((column) => [column.key, column]));
  if (!saved.length) {
    columns.value = normalizeEntryColumns(defaults.map((column) => ({ ...column })));
    return;
  }
  const restored: EntryColumn[] = [];
  const restoredKeys = new Set<EntryColumnKey>();
  saved.forEach((savedColumn) => {
    const current = defaultByKey.get(savedColumn.key);
    if (!current || restoredKeys.has(current.key)) {
      return;
    }
    restoredKeys.add(current.key);
    restored.push({
      ...current,
      width: Number.isFinite(savedColumn.width) ? savedColumn.width : current.width,
      visible: isFrozenEntryColumn(current.key) || current.visibilityLocked
        ? true
        : typeof savedColumn.visible === "boolean"
          ? savedColumn.visible
          : current.visible,
      fixed: isFrozenEntryColumn(current.key) ? "left" : ""
    });
  });
  columns.value = normalizeEntryColumns([
    ...restored,
    ...defaults.filter((column) => !restoredKeys.has(column.key)).map((column) => ({ ...column }))
  ]);
}

function isColumnAvailable(column: EntryColumn) {
  return isEntryColumnAvailable(column, props);
}

function closeColumnSettings() {
  persistColumnPreferences();
  columnDialogOpen.value = false;
}

function resetColumnsToDefault() {
  localStorage.removeItem(columnPreferenceKey());
  columns.value = normalizeEntryColumns(defaultColumns.value.map((column) => ({ ...column })));
}

function moveColumn(key: EntryColumnKey, direction: -1 | 1) {
  if (isFrozenEntryColumn(key)) {
    return;
  }
  const index = columns.value.findIndex((column) => column.key === key);
  const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= columns.value.length || isFrozenEntryColumn(columns.value[targetIndex].key)) {
    return;
  }
  const next = [...columns.value];
  const [column] = next.splice(index, 1);
  next.splice(targetIndex, 0, column);
  columns.value = normalizeEntryColumns(next);
}

function loadColumnPreferences(): EntryColumn[] {
  return loadEntryColumnPreferences(columnPreferenceKey());
}

function persistColumnPreferences() {
  saveEntryColumnPreferences(columnPreferenceKey(), columns.value);
}

function columnPreferenceKey() {
  return `jdy:entry-columns:${props.testPrefix}`;
}

function entryColumnValue(row: unknown, index: number, key: string) {
  const line = row as EntryLine;
  switch (key) {
    case "rowNo":
      return String(lineLineNo(line, index));
    case "productCode":
      return line.productCode;
    case "productName":
      return productInfo(line).name;
    case "spec":
      return productInfo(line).spec;
    case "unit":
      return productInfo(line).unit;
    case "netWeight":
      return formatOptionalWeight(productInfo(line).netWeight);
    case "grossWeight":
      return formatOptionalWeight(productInfo(line).grossWeight);
    case "warehouse":
      return line.warehouseCode;
    case "targetWarehouse":
      return line.targetWarehouseCode ?? "";
    case "sourceOrderNo":
      return line.sourceOrderNo ?? "";
    case "sourceLineNo":
      return lineSourceLineNo(line);
    case "customerMaterialCode":
      return line.customerMaterialCode ?? "";
    case "supplierMaterialCode":
      return line.supplierMaterialCode ?? "";
    case "customerOrderNo":
      return line.customerOrderNo ?? "";
    case "qty":
      return formatQty(line.qty);
    case "executedQty":
      return lineExecutedQty(line);
    case "remainingQty":
      return lineRemainingQty(line);
    case "stockOnHand":
      return formatQty(line.stockOnHand);
    case "stockReserved":
      return formatQty(line.stockReserved);
    case "stockAvailable":
      return formatQty(line.stockAvailable);
    case "stockInTransit":
      return formatQty(line.stockInTransit);
    case "unitPrice":
      return formatQty(line.unitPrice);
    case "taxInclusiveUnitPrice":
      return lineTaxInclusiveUnitPrice(line);
    case "taxRate":
      return formatQty(line.taxRate ?? 0);
    case "amount":
      return lineAmount(line);
    case "taxAmount":
      return lineTaxAmount(line);
    case "priceTaxTotal":
      return linePriceTaxTotal(line);
    case "planDeliveryDate":
      return line.planDeliveryDate ?? "";
    case "remark":
      return line.lineRemark ?? "";
    default:
      return "";
  }
}

function entryColumnByKey(key: string) {
  return columns.value.find((column) => column.key === key);
}

function entryRowClass(line: EntryLine, lineIndex: number) {
  return {
    "is-dragging": props.draggingLineIndex === lineIndex,
    "is-source-target": isHighlightedSourceLine(line, lineIndex)
  };
}

function entryRowAttrs(line: EntryLine, lineIndex: number) {
  return {
    "data-testid": `${props.testPrefix}-entry-row`,
    "data-line-no": lineLineNo(line, lineIndex)
  };
}

function entryCellAttrs(_line: EntryLine, column: TableCoreColumn, lineIndex: number) {
  return {
    "data-testid": columnCellTestId(column.key as EntryColumnKey, lineIndex)
  };
}

function startEntryColumnMouseDrag(column: TableCoreColumn, event: MouseEvent) {
  const entryColumn = entryColumnByKey(column.key);
  if (entryColumn) {
    columnReorder.start(entryColumn, event);
  }
}

function openEntryColumnFilter(column: TableCoreColumn, event: MouseEvent) {
  const entryColumn = entryColumnByKey(column.key);
  if (entryColumn) {
    openColumnFilter(entryColumn, event);
  }
}

function openEntryBulkFill(column: TableCoreColumn, event: MouseEvent) {
  const entryColumn = entryColumnByKey(column.key);
  if (!entryColumn?.bulkFillable || !props.isDraft) {
    return;
  }
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  closeFloatingPanels();
  bulkFillColumnKey.value = entryColumn.key;
  bulkFillLeft.value = Math.min(rect.left, window.innerWidth - 470);
  bulkFillTop.value = Math.min(rect.bottom + 4, window.innerHeight - 290);
  if (entryColumn.key === "planDeliveryDate") {
    bulkDateValue.value = normalizeDateInput(props.batchPlanDeliveryDate || bulkDateValue.value) || "";
  }
  if (entryColumn.key === "warehouse") {
    bulkWarehouseValue.value = props.batchWarehouseCode || bulkWarehouseValue.value;
  }
  if (entryColumn.key === "qty") {
    bulkQtyValue.value = bulkQtyValue.value || "";
  }
  if (entryColumn.key === "unitPrice") {
    bulkPriceMessage.value = "";
    bulkPriceSourceKey.value = bulkPriceSourceKey.value || "defaultPrice";
    bulkPriceOperator.value = bulkPriceOperator.value || "+";
    bulkPriceFactor.value = bulkPriceFactor.value || "0";
  }
  setTimeout(() => document.addEventListener("click", closeFloatingPanels, { once: true }));
}

function resizeEntryColumn({ column, width }: { column: TableCoreColumn; width: number }) {
  const target = entryColumnByKey(column.key);
  if (target) {
    target.width = Math.max(64, Math.min(420, width));
  }
}

function finishEntryColumnResize({ column, width }: { column: TableCoreColumn; width: number }) {
  resizeEntryColumn({ column, width });
  if (entryColumnByKey(column.key)) {
    persistColumnPreferences();
  }
}

function handleEntryRowDragstart(_line: EntryLine, lineIndex: number, event: DragEvent) {
  emit("lineDragStart", event, lineIndex);
}

function handleEntryRowDragover(_line: EntryLine, _lineIndex: number, event: DragEvent) {
  event.preventDefault();
  emit("lineDragOver", event);
}

function handleEntryRowDrop(_line: EntryLine, lineIndex: number, event: DragEvent) {
  event.preventDefault();
  emit("lineDrop", lineIndex);
}

function handleEntryRowDragend() {
  emit("lineDragEnd");
}

function closeFloatingPanels() {
  bulkFillColumnKey.value = "";
  datePickerOpen.value = false;
  datePickerTarget.value = null;
  document.removeEventListener("click", closeFloatingPanels);
}

function stopFloatingClose(event: MouseEvent) {
  event.stopPropagation();
}

function targetLineIndexes() {
  return props.lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => Boolean(String(line.productCode || "").trim() || String(line.productName || "").trim()))
    .map(({ index }) => index);
}

function applyBulkWarehouse() {
  const value = bulkWarehouseValue.value.trim();
  if (!value) {
    return;
  }
  const indexes = targetLineIndexes();
  if (!indexes.length) {
    return;
  }
  emit("update:batchWarehouseCode", value);
  indexes.forEach((index) => {
    props.lines[index].warehouseCode = value;
  });
  emit("markDirty");
  emit("applyBatchWarehouse");
  closeFloatingPanels();
}

function applyBulkDate() {
  const normalized = normalizeDateInput(bulkDateValue.value);
  if (!normalized) {
    return;
  }
  const indexes = targetLineIndexes();
  if (!indexes.length) {
    return;
  }
  bulkDateValue.value = normalized;
  emit("update:batchPlanDeliveryDate", normalized);
  indexes.forEach((index) => {
    props.lines[index].planDeliveryDate = normalized;
  });
  emit("markDirty");
  emit("applyBatchPlanDeliveryDate", indexes);
  closeFloatingPanels();
}

function applyBulkQty() {
  const value = Number(bulkQtyValue.value);
  if (!Number.isFinite(value) || value < 0) {
    return;
  }
  const indexes = targetLineIndexes();
  if (!indexes.length) {
    return;
  }
  indexes.forEach((index) => {
    props.lines[index].qty = value;
  });
  emit("markDirty");
  closeFloatingPanels();
}

async function applyBulkPrice() {
  const indexes = targetLineIndexes().filter((index) => props.lines[index]?.productCode?.trim());
  if (!indexes.length) {
    bulkPriceMessage.value = "没有可填充的商品行";
    return;
  }
  const customerCode = (props.salesPriceCustomerCode || "").trim();
  if (!customerCode) {
    bulkPriceMessage.value = "请先选择客户";
    return;
  }
  const factor = Number(bulkPriceFactor.value);
  if (!Number.isFinite(factor)) {
    bulkPriceMessage.value = "系数格式不正确";
    return;
  }
  const productCodes = indexes.map((index) => props.lines[index].productCode);
  const result = await fetchSalesUnitPriceSources(customerCode, productCodes);
  if (!result.ok || !result.data) {
    bulkPriceMessage.value = result.message || "价格来源查询失败";
    return;
  }
  let applied = 0;
  indexes.forEach((index) => {
    const line = props.lines[index];
    const productSources = result.data?.products?.[line.productCode] as SalesUnitPriceSourcesByProduct | undefined;
    const source = productSources?.[bulkPriceSourceKey.value as keyof SalesUnitPriceSourcesByProduct];
    if (!isPriceSource(source)) {
      return;
    }
    const sourceValue = Number(source.value);
    if (!source.available || !Number.isFinite(sourceValue)) {
      return;
    }
    const nextPrice = calculateBulkPrice(sourceValue, factor, bulkPriceOperator.value);
    if (nextPrice == null) {
      return;
    }
    line.unitPrice = nextPrice;
    applied += 1;
  });
  if (!applied) {
    bulkPriceMessage.value = "选中商品没有可用价格来源";
    return;
  }
  emit("markDirty");
  bulkPriceMessage.value = `已填充 ${applied} 行`;
  closeFloatingPanels();
}

function isPriceSource(value: unknown): value is SalesUnitPriceSource {
  return Boolean(value && typeof value === "object" && "value" in value && "available" in value);
}

function calculateBulkPrice(sourceValue: number, factor: number, operator: string) {
  let value = sourceValue;
  if (operator === "+") {
    value = sourceValue + factor;
  } else if (operator === "-") {
    value = sourceValue - factor;
  } else if (operator === "*") {
    value = sourceValue * factor;
  } else if (operator === "/") {
    if (factor === 0) {
      bulkPriceMessage.value = "除数不能为 0";
      return null;
    }
    value = sourceValue / factor;
  }
  if (!Number.isFinite(value)) {
    return null;
  }
  return Number(Math.max(0, value).toFixed(6));
}

function commitLineDate(lineIndex: number) {
  const line = props.lines[lineIndex];
  if (!line?.planDeliveryDate) {
    return;
  }
  const normalized = normalizeDateInput(line.planDeliveryDate);
  if (normalized) {
    line.planDeliveryDate = normalized;
    emit("markDirty");
  }
}

function openLineDatePicker(lineIndex: number, event: MouseEvent) {
  const line = props.lines[lineIndex];
  if (!line || !props.isDraft) {
    return;
  }
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  openDatePicker({ type: "line", lineIndex }, line.planDeliveryDate, rect.left, rect.bottom + 4);
}

function openBulkDatePicker(event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  openDatePicker({ type: "bulk" }, bulkDateValue.value, rect.left, rect.bottom + 4);
}

function openDatePicker(target: { type: "line"; lineIndex: number } | { type: "bulk" }, value: string | undefined, left: number, top: number) {
  const parsed = parseDateInput(value || "") ?? new Date();
  datePickerTarget.value = target;
  datePickerYear.value = parsed.getFullYear();
  datePickerMonth.value = parsed.getMonth();
  datePickerLeft.value = Math.min(left, window.innerWidth - 290);
  datePickerTop.value = Math.min(top, window.innerHeight - 270);
  datePickerOpen.value = true;
  setTimeout(() => document.addEventListener("click", closeFloatingPanels, { once: true }));
}

function shiftDatePickerMonth(delta: number) {
  const next = new Date(datePickerYear.value, datePickerMonth.value + delta, 1);
  datePickerYear.value = next.getFullYear();
  datePickerMonth.value = next.getMonth();
}

function selectDatePickerDay(value: string) {
  const target = datePickerTarget.value;
  if (!target) {
    return;
  }
  if (target.type === "line") {
    props.lines[target.lineIndex].planDeliveryDate = value;
  } else {
    bulkDateValue.value = value;
  }
  emit("markDirty");
  datePickerOpen.value = false;
  datePickerTarget.value = null;
}

function normalizeDateInput(value: string | undefined) {
  const date = parseDateInput(value || "");
  return date ? formatDateValue(date) : "";
}

function parseDateInput(value: string) {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

function formatDateValue(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function lineAmount(line: EntryLine) {
  return entryLineAmount(line, previewPriceAmounts.value);
}

function lineTaxAmount(line: EntryLine) {
  return entryLineTaxAmount(line, previewPriceAmounts.value);
}

function linePriceTaxTotal(line: EntryLine) {
  return entryLinePriceTaxTotal(line, previewPriceAmounts.value);
}

function lineTaxInclusiveUnitPrice(line: EntryLine) {
  return entryLineTaxInclusiveUnitPrice(line, previewPriceAmounts.value);
}

function taxForLine(line: EntryLine) {
  return taxForEntryLine(line);
}

function lineExecutedQty(line: EntryLine) {
  return entryLineExecutedQty(line);
}

function lineRemainingQty(line: EntryLine) {
  return entryLineRemainingQty(line);
}

function lineSourceLineNo(line: EntryLine) {
  return entrySourceLineNo(line);
}

function lineLineNo(line: EntryLine, index: number) {
  return entryLineNo(line, index);
}

function isHighlightedSourceLine(line: EntryLine, index: number) {
  return Boolean(
    props.highlightedSourceLineNo
    && props.currentBillNo === props.highlightedSourceBillNo
    && lineLineNo(line, index) === props.highlightedSourceLineNo
  );
}

function formatQty(value: number | string | undefined) {
  return formatEntryQty(value);
}

function formatPrice(value: number | string | undefined) {
  return formatEntryPrice(value);
}

function productInfo(line: EntryLine) {
  return entryProductInfo(line, props.selectorOptions, props.knownProductOptions);
}

function handleLineCellKeydown(event: KeyboardEvent, lineIndex: number, cell: EditableLineCell, selectorId = "") {
  const selectorWasOpen = Boolean(selectorId && props.activeSelector === selectorId && props.selectorOptions.length > 0);
  if (selectorId) {
    emit("handleSelectorKeydown", event, selectorId);
  }
  if (!props.isDraft || selectorWasOpen || event.defaultPrevented) {
    return;
  }
  if (!props.sourceLockedLines && event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    emit("insertLineAfter", lineIndex);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    advanceLineCellOnEnter(lineIndex, cell);
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    void focusLineCell(Math.min(lineIndex + 1, props.lines.length - 1), cell);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    void focusLineCell(Math.max(lineIndex - 1, 0), cell);
  }
}

function advanceLineCellOnEnter(lineIndex: number, cell: EditableLineCell) {
  const order = editableCellOrder();
  const currentIndex = order.indexOf(cell);
  const nextCell = currentIndex >= 0 ? order[currentIndex + 1] : undefined;
  if (nextCell) {
    void focusLineCell(lineIndex, nextCell);
    return;
  }
  if (props.sourceLockedLines) {
    const nextLineIndex = Math.min(lineIndex + 1, props.lines.length - 1);
    if (nextLineIndex !== lineIndex) {
      void focusLineCell(nextLineIndex, order[0] ?? "qty");
    }
    return;
  }
  emit("insertLineAfter", lineIndex);
  void focusLineCell(Math.min(lineIndex + 1, props.lines.length), order[0] ?? "product");
}

function editableCellOrder(): EditableLineCell[] {
  if (props.sourceLockedLines) {
    return ["qty", "remark"];
  }
  return [
    "product",
    props.showCustomerMaterialCodeColumn ? "customerMaterialCode" : "",
    props.showSupplierMaterialCodeColumn ? "supplierMaterialCode" : "",
    props.showCustomerOrderNoColumn ? "customerOrderNo" : "",
    "warehouse",
    props.showTargetWarehouseColumn ? "target-warehouse" : "",
    "qty",
    props.showPriceAmountColumns !== false ? "price" : "",
    props.showTaxColumns && props.showPriceAmountColumns !== false ? "taxRate" : "",
    props.showPlanDeliveryDateColumn ? "planDeliveryDate" : "",
    "remark"
  ].filter(Boolean) as EditableLineCell[];
}

function handleLineDateKeydown(event: KeyboardEvent, lineIndex: number) {
  if (event.key === "Enter" || event.key === "ArrowDown" || event.key === "ArrowUp") {
    commitLineDate(lineIndex);
  }
  handleLineCellKeydown(event, lineIndex, "planDeliveryDate");
}

async function focusLineCell(lineIndex: number, cell: EditableLineCell) {
  await nextTick();
  const input = document.querySelector<HTMLInputElement>(`[data-testid="${lineCellTestId(lineIndex, cell)}"]`);
  input?.focus();
  input?.select();
}

function lineCellTestId(lineIndex: number, cell: EditableLineCell) {
  switch (cell) {
    case "target-warehouse":
      return lineTargetWarehouseTestId(lineIndex);
    case "warehouse":
      return lineWarehouseTestId(lineIndex);
    case "qty":
      return lineQtyTestId(lineIndex);
    case "price":
      return linePriceTestId(lineIndex);
    case "taxRate":
      return lineTaxRateTestId(lineIndex);
    case "planDeliveryDate":
      return linePlanDeliveryDateTestId(lineIndex);
    case "customerMaterialCode":
      return lineCustomerMaterialCodeTestId(lineIndex);
    case "supplierMaterialCode":
      return lineSupplierMaterialCodeTestId(lineIndex);
    case "customerOrderNo":
      return lineCustomerOrderNoTestId(lineIndex);
    case "remark":
      return lineRemarkTestId(lineIndex);
    case "product":
    default:
      return lineProductTestId(lineIndex);
  }
}
</script>
