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
                  :disabled="!isDraft"
                  :data-testid="lineProductTestId(lineIndex)"
                  @focus="emit('searchMasterOptions', 'product', line.productCode, selectorIdForLine(lineIndex, 'product'))"
                  @input="emit('handleMasterInput', 'product', line.productCode, selectorIdForLine(lineIndex, 'product'))"
                  @keydown="handleLineCellKeydown($event, lineIndex, 'product', selectorIdForLine(lineIndex, 'product'))"
                  @paste="emit('entryPaste', $event, lineIndex)"
                />
                <button
                  class="master-selector__open"
                  type="button"
                  :disabled="!isDraft"
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
                  type="button"
                  :disabled="!isDraft"
                  :data-testid="lineInsertTestId(lineIndex)"
                  title="在下方新增行"
                  @click.stop="emit('insertLineAfter', lineIndex)"
                >+</button>
                <button
                  type="button"
                  :disabled="!isDraft || lines.length <= 1"
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
              :disabled="!isDraft"
              :data-testid="lineCustomerMaterialCodeTestId(lineIndex)"
              @input="emit('markDirty')"
              @keydown="handleLineCellKeydown($event, lineIndex, 'customerMaterialCode')"
            />
            <input
              v-else-if="column.key === 'supplierMaterialCode'"
              v-model="line.supplierMaterialCode"
              :disabled="!isDraft"
              :data-testid="lineSupplierMaterialCodeTestId(lineIndex)"
              @input="emit('markDirty')"
              @keydown="handleLineCellKeydown($event, lineIndex, 'supplierMaterialCode')"
            />
            <input
              v-else-if="column.key === 'customerOrderNo'"
              v-model="line.customerOrderNo"
              :disabled="!isDraft"
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
                  :disabled="!isDraft"
                  :data-testid="lineWarehouseTestId(lineIndex)"
                  @focus="emit('searchMasterOptions', 'warehouse', line.warehouseCode, selectorIdForLine(lineIndex, 'warehouse'))"
                  @input="emit('handleMasterInput', 'warehouse', line.warehouseCode, selectorIdForLine(lineIndex, 'warehouse'))"
                  @keydown="handleLineCellKeydown($event, lineIndex, 'warehouse', selectorIdForLine(lineIndex, 'warehouse'))"
                  @paste="emit('entryPaste', $event, lineIndex)"
                />
                <button
                  class="master-selector__open"
                  type="button"
                  :disabled="!isDraft"
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
                  :disabled="!isDraft"
                  :data-testid="lineTargetWarehouseTestId(lineIndex)"
                  @focus="emit('searchMasterOptions', 'warehouse', line.targetWarehouseCode || '', selectorIdForLine(lineIndex, 'target-warehouse'))"
                  @input="emit('handleMasterInput', 'warehouse', line.targetWarehouseCode || '', selectorIdForLine(lineIndex, 'target-warehouse'))"
                  @keydown="handleLineCellKeydown($event, lineIndex, 'target-warehouse', selectorIdForLine(lineIndex, 'target-warehouse'))"
                  @paste="emit('entryPaste', $event, lineIndex)"
                />
                <button
                  class="master-selector__open"
                  type="button"
                  :disabled="!isDraft"
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
              <small v-if="line.lineCloseStatus === 'CLOSED'">已关闭</small>
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
              :disabled="!isDraft"
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
              :disabled="!isDraft"
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
              :class="{ 'is-disabled': !isDraft }"
            >
              <input
                :value="line.planDeliveryDate || ''"
                :disabled="!isDraft"
                :data-testid="linePlanDeliveryDateTestId(lineIndex)"
                placeholder="2026-05-01"
                @input="line.planDeliveryDate = ($event.target as HTMLInputElement).value; emit('markDirty')"
                @keydown="handleLineDateKeydown($event, lineIndex)"
                @blur="commitLineDate(lineIndex)"
              />
              <button
                type="button"
                class="entry-date-picker-button"
                :disabled="!isDraft"
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
            <template v-else-if="column.key === 'priceTaxTotal'">{{ totalAmount }}</template>
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
import { taxAmounts } from "../app/taxAmounts";
import { fetchSalesUnitPriceSources, type SalesUnitPriceSource, type SalesUnitPriceSourcesByProduct } from "../services/documentApi";
import ColumnFilterPopover from "./table/ColumnFilterPopover.vue";
import ColumnSettingsDialog from "./table/ColumnSettingsDialog.vue";
import TableCore, { type TableCoreColumn } from "./table/TableCore.vue";
import TableCoreHeaderCell from "./table/TableCoreHeaderCell.vue";
import { tableFilterOperators, useColumnFilters } from "./table/useColumnFilters";
import { canReorderColumn, useColumnReorder } from "./table/useColumnReorder";

export interface EntryLine {
  lineNo?: number;
  productId?: string;
  customerMaterialCode?: string;
  supplierMaterialCode?: string;
  customerOrderNo?: string;
  productCode: string;
  productName?: string;
  spec?: string;
  unit?: string;
  netWeight?: number | string;
  grossWeight?: number | string;
  warehouseCode: string;
  targetWarehouseCode?: string;
  sourceOrderNo?: string;
  sourceLineNo?: number;
  qty: number;
  executedQty?: number;
  remainingQty?: number;
  lineCloseStatus?: string;
  lineFrozenStatus?: string;
  unitPrice: number;
  taxRate?: number;
  taxAmount?: number | string;
  priceTaxTotal?: number | string;
  lineRemark?: string;
  planDeliveryDate?: string;
  downstreamDocs?: any[];
  stockOnHand?: number | string;
  stockReserved?: number | string;
  stockAvailable?: number | string;
  stockInTransit?: number | string;
}

export interface MasterOption {
  code: string;
  name: string;
  spec?: string;
  unit?: string;
  netWeight?: string;
  grossWeight?: string;
}

type EntryColumnKey = "rowNo" | "partyCode" | "customerMaterialCode" | "supplierMaterialCode" | "customerOrderNo" | "productCode" | "productName" | "spec" | "unit" | "netWeight" | "grossWeight" | "warehouse" | "targetWarehouse" | "sourceOrderNo" | "sourceLineNo" | "qty" | "executedQty" | "remainingQty" | "stockOnHand" | "stockReserved" | "stockAvailable" | "stockInTransit" | "unitPrice" | "taxInclusiveUnitPrice" | "taxRate" | "amount" | "taxAmount" | "priceTaxTotal" | "planDeliveryDate" | "remark";
interface EntryColumn {
  key: EntryColumnKey;
  title: string;
  width: number;
  visible: boolean;
  fixed?: "" | "left" | "right";
  locked?: boolean;
  reorderable?: boolean;
  configurable?: boolean;
  numeric?: boolean;
  bulkFillable?: boolean;
}

const props = defineProps<{
  lines: EntryLine[];
  testPrefix: string;
  isDraft: boolean;
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
  enableSalesPriceBulk?: boolean;
  salesPriceCustomerCode?: string;
  executionQtyLabel?: string;
  remainingQtyLabel?: string;
  entryTableColspan: number;
  entryTotalColspan: number;
  totalAmount: string;
  isTaxInclusive?: boolean;
  showTaxColumns?: boolean;
}>();

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
const numericColumns = new Set<EntryColumnKey>(["rowNo", "netWeight", "grossWeight", "qty", "executedQty", "remainingQty", "stockOnHand", "stockReserved", "stockAvailable", "stockInTransit", "unitPrice", "taxInclusiveUnitPrice", "taxRate", "amount", "taxAmount", "priceTaxTotal"]);
const bulkPriceSourceOptions = [
  { key: "defaultPrice", label: "默认价格" },
  { key: "quotePrice", label: "最新有效报价" },
  { key: "recentPrice", label: "最近成交价" },
  { key: "historyMaxPrice", label: "历史最高价" },
  { key: "historyMinPrice", label: "历史最低价" },
  { key: "historyAvgPrice", label: "平均价" },
  { key: "costPrice", label: "成本价" }
] as const;

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

const defaultColumns = computed<EntryColumn[]>(() => [
  { key: "rowNo", title: "序号", width: 48, visible: true, fixed: "left", locked: true, configurable: false, numeric: true },
  { key: "partyCode", title: props.partyCodeLabel || "客户编码", width: 118, visible: props.showPartyCodeColumn !== false },
  { key: "customerMaterialCode", title: "客户物料编码", width: 150, visible: Boolean(props.showCustomerMaterialCodeColumn) },
  { key: "supplierMaterialCode", title: "供应商物料编码", width: 150, visible: Boolean(props.showSupplierMaterialCodeColumn) },
  { key: "customerOrderNo", title: "客户订单号", width: 150, visible: Boolean(props.showCustomerOrderNoColumn) },
  { key: "productCode", title: "物料编码", width: 140, visible: true },
  { key: "productName", title: "物料名称", width: 170, visible: true },
  { key: "spec", title: "规格型号", width: 150, visible: true },
  { key: "unit", title: "单位", width: 76, visible: true },
  { key: "netWeight", title: "净重", width: 88, visible: true, numeric: true },
  { key: "grossWeight", title: "毛重", width: 88, visible: true, numeric: true },
  { key: "warehouse", title: "仓库", width: 130, visible: true, bulkFillable: true },
  { key: "targetWarehouse", title: "目标仓库", width: 130, visible: Boolean(props.showTargetWarehouseColumn) },
  { key: "sourceOrderNo", title: "源单号", width: 142, visible: props.showSourceLineColumn },
  { key: "sourceLineNo", title: "源单行号", width: 86, visible: props.showSourceLineColumn },
  { key: "qty", title: "数量", width: 104, visible: true, numeric: true, bulkFillable: true },
  { key: "executedQty", title: props.executionQtyLabel || "已执行", width: 104, visible: props.showExecutionColumns, numeric: true },
  { key: "remainingQty", title: props.remainingQtyLabel || "剩余", width: 104, visible: props.showExecutionColumns, numeric: true },
  { key: "stockOnHand", title: "即时库存", width: 104, visible: Boolean(props.showStockColumns), numeric: true },
  { key: "stockReserved", title: "锁定库存", width: 104, visible: Boolean(props.showStockColumns), numeric: true },
  { key: "stockAvailable", title: "可用库存", width: 104, visible: Boolean(props.showStockColumns), numeric: true },
  { key: "stockInTransit", title: "在途库存", width: 104, visible: Boolean(props.showStockColumns), numeric: true },
  { key: "unitPrice", title: "单价", width: 112, visible: true, numeric: true, bulkFillable: Boolean(props.enableSalesPriceBulk) },
  { key: "taxInclusiveUnitPrice", title: "含税单价", width: 112, visible: Boolean(props.showTaxColumns), numeric: true },
  { key: "taxRate", title: "税率%", width: 88, visible: Boolean(props.showTaxColumns), numeric: true },
  { key: "amount", title: "金额", width: 116, visible: true, numeric: true },
  { key: "taxAmount", title: "税额", width: 104, visible: Boolean(props.showTaxColumns), numeric: true },
  { key: "priceTaxTotal", title: "含税金额", width: 124, visible: Boolean(props.showTaxColumns), numeric: true },
  { key: "planDeliveryDate", title: "预计交期", width: 142, visible: Boolean(props.showPlanDeliveryDateColumn), bulkFillable: true },
  { key: "remark", title: "行备注", width: 210, visible: true }
]);

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
  bulkFillable: Boolean(column.bulkFillable) && props.isDraft,
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
const totalNetAmount = computed(() => props.lines.reduce((sum, line) => sum + taxForLine(line).amount, 0).toFixed(2));
const totalTaxAmount = computed(() => props.lines.reduce((sum, line) => sum + taxForLine(line).taxAmount, 0).toFixed(2));
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
  props.executionQtyLabel,
  props.remainingQtyLabel
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
  saved.forEach((savedColumn) => {
    const current = defaultByKey.get(savedColumn.key);
    if (!current) {
      return;
    }
    restored.push({
      ...current,
      width: Number.isFinite(savedColumn.width) ? savedColumn.width : current.width,
      visible: isFrozenEntryColumn(current.key) ? true : savedColumn.visible,
      fixed: isFrozenEntryColumn(current.key) ? "left" : ""
    });
  });
  const restoredKeys = new Set(restored.map((column) => column.key));
  columns.value = normalizeEntryColumns([
    ...restored,
    ...defaults.filter((column) => !restoredKeys.has(column.key)).map((column) => ({ ...column }))
  ]);
}

function isColumnAvailable(column: EntryColumn) {
  if (column.key === "partyCode") {
    return Boolean(props.showPartyCodeColumn !== false && props.partyCodeLabel);
  }
  if (column.key === "targetWarehouse") {
    return Boolean(props.showTargetWarehouseColumn);
  }
  if (column.key === "rowNo") {
    return true;
  }
  if (column.key === "customerMaterialCode") {
    return Boolean(props.showCustomerMaterialCodeColumn);
  }
  if (column.key === "supplierMaterialCode") {
    return Boolean(props.showSupplierMaterialCodeColumn);
  }
  if (column.key === "customerOrderNo") {
    return Boolean(props.showCustomerOrderNoColumn);
  }
  if (column.key === "planDeliveryDate") {
    return Boolean(props.showPlanDeliveryDateColumn);
  }
  if (column.key === "taxInclusiveUnitPrice" || column.key === "taxRate" || column.key === "taxAmount" || column.key === "priceTaxTotal") {
    return Boolean(props.showTaxColumns);
  }
  if (column.key === "sourceLineNo") {
    return props.showSourceLineColumn;
  }
  if (column.key === "sourceOrderNo") {
    return props.showSourceLineColumn;
  }
  if (column.key === "executedQty" || column.key === "remainingQty") {
    return props.showExecutionColumns;
  }
  if (["stockOnHand", "stockReserved", "stockAvailable", "stockInTransit"].includes(column.key)) {
    return Boolean(props.showStockColumns);
  }
  return true;
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
  try {
    const parsed = JSON.parse(localStorage.getItem(columnPreferenceKey()) || "[]") as EntryColumn[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistColumnPreferences() {
  localStorage.setItem(columnPreferenceKey(), JSON.stringify(columns.value.map((column) => ({
    key: column.key,
    width: isFrozenEntryColumn(column.key) ? column.width : Math.max(64, Number(column.width) || 64),
    visible: isFrozenEntryColumn(column.key) ? true : column.visible,
    fixed: isFrozenEntryColumn(column.key) ? "left" : ""
  }))));
}

function columnPreferenceKey() {
  return `jdy:entry-columns:${props.testPrefix}`;
}

function columnClass(column: EntryColumn) {
  return {
    "entry-number-cell": numericColumns.has(column.key),
    "readonly-qty": ["sourceLineNo", "executedQty", "remainingQty", "stockOnHand", "stockReserved", "stockAvailable", "stockInTransit"].includes(column.key),
    "amount-cell": column.key === "amount" || column.key === "taxAmount" || column.key === "priceTaxTotal",
    "tax-cell": column.key === "taxRate" || column.key === "taxAmount" || column.key === "priceTaxTotal",
    "remark-cell": column.key === "remark",
    "entry-row-no-cell": column.key === "rowNo",
    "entry-frozen-cell": isFrozenEntryColumn(column.key)
  };
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

function selectorIdForLine(lineIndex: number, field: "product" | "warehouse" | "target-warehouse") {
  return `${props.testPrefix}-line-${lineIndex}-${field}`;
}

function lineAmount(line: EntryLine) {
  return taxForLine(line).amount.toFixed(2);
}

function lineTaxAmount(line: EntryLine) {
  return taxForLine(line).taxAmount.toFixed(2);
}

function linePriceTaxTotal(line: EntryLine) {
  return taxForLine(line).priceTaxTotal.toFixed(2);
}

function lineTaxInclusiveUnitPrice(line: EntryLine) {
  const qty = Number(line.qty || 0);
  const priceTaxTotal = taxForLine(line).priceTaxTotal;
  if (!qty || !Number.isFinite(qty)) {
    const unitPrice = Number(line.unitPrice || 0);
    const taxRate = Number(line.taxRate ?? 0);
    const grossUnitPrice = props.isTaxInclusive ? unitPrice : unitPrice * (1 + taxRate / 100);
    return formatPrice(grossUnitPrice);
  }
  return formatPrice(priceTaxTotal / qty);
}

function taxForLine(line: EntryLine) {
  return taxAmounts(line.qty, line.unitPrice, line.taxRate, Boolean(props.isTaxInclusive));
}

function lineExecutedQty(line: EntryLine) {
  return formatQty(line.executedQty ?? 0);
}

function lineRemainingQty(line: EntryLine) {
  return formatQty(line.remainingQty ?? Math.max(0, Number(line.qty || 0) - Number(line.executedQty || 0)));
}

function lineSourceLineNo(line: EntryLine) {
  return line.sourceLineNo ? `#${line.sourceLineNo}` : "-";
}

function lineLineNo(line: EntryLine, index: number) {
  return line.lineNo ?? index + 1;
}

function isHighlightedSourceLine(line: EntryLine, index: number) {
  return Boolean(
    props.highlightedSourceLineNo
    && props.currentBillNo === props.highlightedSourceBillNo
    && lineLineNo(line, index) === props.highlightedSourceLineNo
  );
}

function formatQty(value: number | string | undefined) {
  const qty = Number(value ?? 0);
  if (!Number.isFinite(qty)) {
    return "0";
  }
  return Number.isInteger(qty) ? String(qty) : qty.toFixed(2);
}

function formatPrice(value: number | string | undefined) {
  const price = Number(value ?? 0);
  if (!Number.isFinite(price)) {
    return "0.00";
  }
  return price.toFixed(2);
}

function formatOptionalWeight(value: number | string | undefined) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return "";
  }
  const weight = Number(value);
  if (!Number.isFinite(weight)) {
    return "";
  }
  return weight.toFixed(2);
}

function productInfo(line: EntryLine) {
  if (line.productName || line.spec || line.unit || line.netWeight || line.grossWeight) {
    return {
      name: line.productName ?? "",
      spec: line.spec ?? "",
      unit: line.unit ?? "",
      netWeight: line.netWeight,
      grossWeight: line.grossWeight
    };
  }
  const product = props.selectorOptions.find((option) => option.code === line.productCode)
    ?? props.knownProductOptions.find((option) => option.code === line.productCode);
  return product
    ? { name: product.name, spec: product.spec ?? "", unit: product.unit ?? "", netWeight: product.netWeight ?? "", grossWeight: product.grossWeight ?? "" }
    : { name: "", spec: "", unit: "", netWeight: "", grossWeight: "" };
}

function lineProductTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-product` : `${props.testPrefix}-line-product-${index + 1}`;
}

function lineWarehouseTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-warehouse` : `${props.testPrefix}-line-warehouse-${index + 1}`;
}

function lineTargetWarehouseTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-target-warehouse` : `${props.testPrefix}-line-target-warehouse-${index + 1}`;
}

function lineQtyTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-qty` : `${props.testPrefix}-line-qty-${index + 1}`;
}

function lineSourceLineNoTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-source-line-no` : `${props.testPrefix}-line-source-line-no-${index + 1}`;
}

function lineSourceOrderNoTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-source-order-no` : `${props.testPrefix}-line-source-order-no-${index + 1}`;
}

function lineSourceTraceTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-source-trace` : `${props.testPrefix}-line-source-trace-${index + 1}`;
}

function lineDownstreamTraceTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-downstream-trace` : `${props.testPrefix}-line-downstream-trace-${index + 1}`;
}

function lineExecutedQtyTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-executed-qty` : `${props.testPrefix}-line-executed-qty-${index + 1}`;
}

function lineRemainingQtyTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-remaining-qty` : `${props.testPrefix}-line-remaining-qty-${index + 1}`;
}

function linePriceTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-price` : `${props.testPrefix}-line-price-${index + 1}`;
}

function lineTaxInclusiveUnitPriceTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-tax-inclusive-price` : `${props.testPrefix}-line-tax-inclusive-price-${index + 1}`;
}

function lineTaxRateTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-tax-rate` : `${props.testPrefix}-line-tax-rate-${index + 1}`;
}

function lineAmountTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-amount` : `${props.testPrefix}-line-amount-${index + 1}`;
}

function lineTaxAmountTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-tax-amount` : `${props.testPrefix}-line-tax-amount-${index + 1}`;
}

function linePriceTaxTotalTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-price-tax-total` : `${props.testPrefix}-line-price-tax-total-${index + 1}`;
}

function lineRemarkTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-remark` : `${props.testPrefix}-line-remark-${index + 1}`;
}

function lineCustomerMaterialCodeTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-customer-material-code` : `${props.testPrefix}-line-customer-material-code-${index + 1}`;
}

function lineSupplierMaterialCodeTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-supplier-material-code` : `${props.testPrefix}-line-supplier-material-code-${index + 1}`;
}

function lineCustomerOrderNoTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-customer-order-no` : `${props.testPrefix}-line-customer-order-no-${index + 1}`;
}

function linePlanDeliveryDateTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-plan-delivery-date` : `${props.testPrefix}-line-plan-delivery-date-${index + 1}`;
}

function lineDeleteTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-delete` : `${props.testPrefix}-line-delete-${index + 1}`;
}

function lineInsertTestId(index: number) {
  return index === 0 ? `${props.testPrefix}-line-insert` : `${props.testPrefix}-line-insert-${index + 1}`;
}

function columnCellTestId(key: EntryColumnKey, index: number) {
  const suffix = index === 0 ? "" : `-${index + 1}`;
  if (key === "rowNo") {
    return `${props.testPrefix}-line-row-no${suffix}`;
  }
  if (key === "partyCode") {
    return `${props.testPrefix}-line-party-code${suffix}`;
  }
  if (key === "customerMaterialCode") {
    return lineCustomerMaterialCodeTestId(index);
  }
  if (key === "supplierMaterialCode") {
    return lineSupplierMaterialCodeTestId(index);
  }
  if (key === "customerOrderNo") {
    return lineCustomerOrderNoTestId(index);
  }
  if (key === "productName") {
    return `${props.testPrefix}-line-product-name${suffix}`;
  }
  if (key === "spec") {
    return `${props.testPrefix}-line-spec${suffix}`;
  }
  if (key === "unit" || key === "netWeight" || key === "grossWeight") {
    return `${props.testPrefix}-line-${key}${suffix}`;
  }
  if (key === "sourceLineNo") {
    return lineSourceLineNoTestId(index);
  }
  if (key === "sourceOrderNo") {
    return lineSourceOrderNoTestId(index);
  }
  if (key === "executedQty") {
    return lineExecutedQtyTestId(index);
  }
  if (key === "remainingQty") {
    return lineRemainingQtyTestId(index);
  }
  if (key === "stockOnHand" || key === "stockReserved" || key === "stockAvailable" || key === "stockInTransit") {
    return `${props.testPrefix}-line-${key}${suffix}`;
  }
  if (key === "taxInclusiveUnitPrice") {
    return lineTaxInclusiveUnitPriceTestId(index);
  }
  return undefined;
}

function isFrozenEntryColumn(key: EntryColumnKey) {
  return key === "rowNo";
}

function normalizeEntryColumns(nextColumns: EntryColumn[]) {
  const frozen = nextColumns
    .filter((column) => isFrozenEntryColumn(column.key))
    .map((column) => ({ ...column, fixed: "left" as const, visible: true, configurable: false }));
  const regular = nextColumns
    .filter((column) => !isFrozenEntryColumn(column.key))
    .map((column) => ({ ...column, fixed: "" as const }));
  return [...frozen, ...regular];
}

type EditableLineCell = "product" | "warehouse" | "target-warehouse" | "qty" | "price" | "taxRate" | "planDeliveryDate" | "customerMaterialCode" | "supplierMaterialCode" | "customerOrderNo" | "remark";

function handleLineCellKeydown(event: KeyboardEvent, lineIndex: number, cell: EditableLineCell, selectorId = "") {
  const selectorWasOpen = Boolean(selectorId && props.activeSelector === selectorId && props.selectorOptions.length > 0);
  if (selectorId) {
    emit("handleSelectorKeydown", event, selectorId);
  }
  if (!props.isDraft || selectorWasOpen || event.defaultPrevented) {
    return;
  }
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
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
  emit("insertLineAfter", lineIndex);
  void focusLineCell(Math.min(lineIndex + 1, props.lines.length), order[0] ?? "product");
}

function editableCellOrder(): EditableLineCell[] {
  return [
    "product",
    props.showCustomerMaterialCodeColumn ? "customerMaterialCode" : "",
    props.showSupplierMaterialCodeColumn ? "supplierMaterialCode" : "",
    props.showCustomerOrderNoColumn ? "customerOrderNo" : "",
    "warehouse",
    props.showTargetWarehouseColumn ? "target-warehouse" : "",
    "qty",
    "price",
    props.showTaxColumns ? "taxRate" : "",
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
