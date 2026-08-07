<template>
  <section class="role-permission-page settings-page opening-stock-page" data-testid="opening-stock-page">
    <DocumentCommandHeader title="库存期初数" subtitle="按当前账套录入期初库存。保存后同步库存余额，并记录一条期初库存流水。" show-subtitle>
      <template #actions>
        <ActionBar :actions="openingStockActions" @action="handleAction" />
      </template>
    </DocumentCommandHeader>
    <div class="settings-table opening-stock-table">
      <TableCore
        kind="entry"
        test-id="opening-stock-table-core"
        frame-class="entry-table opening-stock-entry-table"
        table-class="entry-native-table"
        :columns="openingStockColumns"
        :rows="rows"
        :min-width="1280"
        :row-key="openingStockRowKey"
        :cell-title="openingStockCellTitle"
        @column-resize="resizeOpeningStockColumn"
      >
        <template #cell="{ row, column, rowIndex }">
          <input
            v-if="column.key === 'productCode'"
            v-model.trim="row.productCode"
            :data-testid="`opening-product-code-${rowIndex + 1}`"
          />
          <input
            v-else-if="column.key === 'warehouseCode'"
            v-model.trim="row.warehouseCode"
            :data-testid="`opening-warehouse-code-${rowIndex + 1}`"
          />
          <input
            v-else-if="column.key === 'qty'"
            v-model="row.qty"
            type="number"
            min="0"
            step="0.0001"
            :data-testid="`opening-qty-${rowIndex + 1}`"
            @input="updateAmount(row)"
          />
          <input
            v-else-if="column.key === 'unitCost'"
            v-model="row.unitCost"
            type="number"
            min="0"
            step="0.000001"
            :data-testid="`opening-unit-cost-${rowIndex + 1}`"
            @input="updateAmount(row)"
          />
          <input
            v-else-if="column.key === 'remark'"
            v-model.trim="row.remark"
            :data-testid="`opening-remark-${rowIndex + 1}`"
          />
          <button
            v-else-if="column.key === 'operation'"
            type="button"
            :data-testid="`opening-remove-${rowIndex + 1}`"
            @click="removeRow(rowIndex)"
          >删除</button>
          <span v-else class="entry-cell-value" :class="{ 'entry-cell-value--number': openingStockNumberColumns.has(column.key) }">
            {{ openingStockCellValue(row, column.key) }}
          </span>
        </template>
        <template #overlay>
          <div v-if="!rows.length" class="list-state-panel" data-testid="opening-stock-empty">暂无期初库存。点击“新增行”录入物料和仓库。</div>
        </template>
      </TableCore>
    </div>
    <p v-if="message" class="form-message settings-message" data-testid="opening-stock-message">{{ message }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import ActionBar from "../../../components/ActionBar.vue";
import { defineAction, type ActionBarItem } from "../../../components/actions/actionRegistry";
import DocumentCommandHeader from "../../../components/DocumentCommandHeader.vue";
import TableCore, { type TableCoreColumn } from "../../../components/table/TableCore.vue";
import { fetchOpeningStockRows, saveOpeningStockRows, type OpeningStockRow } from "../../../services/openingStockApi";

const rows = ref<OpeningStockRow[]>([]);
const message = ref("");
const unsavedRowKeys = new WeakMap<object, string>();
let unsavedRowSequence = 0;
const openingStockNumberColumns = new Set(["qty", "unitCost", "amount"]);
const openingStockColumns = ref<TableCoreColumn[]>([
  { key: "productCode", title: "物料编码", width: 150, minWidth: 96, filterable: false },
  { key: "productName", title: "物料名称", width: 150, minWidth: 96, filterable: false },
  { key: "spec", title: "规格型号", width: 130, minWidth: 96, filterable: false },
  { key: "unit", title: "单位", width: 72, minWidth: 64, filterable: false },
  { key: "warehouseCode", title: "仓库编码", width: 120, minWidth: 96, filterable: false },
  { key: "warehouseName", title: "仓库名称", width: 130, minWidth: 96, filterable: false },
  { key: "qty", title: "期初数量", width: 112, minWidth: 90, align: "right", filterable: false, headerClass: "entry-number-cell", cellClass: "entry-number-cell" },
  { key: "unitCost", title: "单位成本", width: 112, minWidth: 90, align: "right", filterable: false, headerClass: "entry-number-cell", cellClass: "entry-number-cell" },
  { key: "amount", title: "期初金额", width: 112, minWidth: 90, align: "right", filterable: false, headerClass: "entry-number-cell", cellClass: "entry-number-cell" },
  { key: "remark", title: "备注", width: 180, minWidth: 120, filterable: false },
  { key: "operation", title: "操作", width: 80, minWidth: 72, align: "center", fixed: "right", filterable: false, resizable: false }
]);
const openingStockActions = computed<ActionBarItem[]>(() => [
  defineAction("addOpeningStockRow", {
    label: "新增行",
    order: 15,
    enabled: true,
    testId: "opening-stock-add-row"
  }),
  defineAction("refresh", { enabled: true, testId: "opening-stock-refresh" }),
  defineAction("save", { enabled: true, testId: "opening-stock-save" })
]);

onMounted(() => {
  void loadRows();
});

async function loadRows() {
  const result = await fetchOpeningStockRows();
  rows.value = result.rows;
  message.value = result.message;
}

function handleAction(actionKey: string) {
  if (actionKey === "addOpeningStockRow") {
    addRow();
    return;
  }
  if (actionKey === "refresh") {
    void loadRows();
    return;
  }
  if (actionKey === "save") {
    void saveRows();
  }
}

function resizeOpeningStockColumn(payload: { column: TableCoreColumn; width: number }) {
  payload.column.width = payload.width;
}

function openingStockRowKey(row: OpeningStockRow, index: number) {
  if (row.id) {
    return row.id;
  }
  const existingKey = unsavedRowKeys.get(row);
  if (existingKey) {
    return existingKey;
  }
  const key = `new-opening-stock-${++unsavedRowSequence}-${index}`;
  unsavedRowKeys.set(row, key);
  return key;
}

function openingStockCellTitle(row: OpeningStockRow, column: TableCoreColumn) {
  return openingStockCellValue(row, column.key);
}

function openingStockCellValue(row: OpeningStockRow, key: string) {
  const value = row[key as keyof OpeningStockRow];
  return value == null ? "" : String(value);
}

function addRow() {
  rows.value.push({
    productCode: "",
    warehouseCode: "",
    qty: 0,
    unitCost: "",
    amount: "",
    remark: ""
  });
}

function removeRow(index: number) {
  rows.value.splice(index, 1);
}

function updateAmount(row: OpeningStockRow) {
  const qty = Number(row.qty || 0);
  const unitCost = row.unitCost === "" || row.unitCost == null ? NaN : Number(row.unitCost);
  row.amount = Number.isFinite(unitCost) ? (qty * unitCost).toFixed(2) : "";
}

async function saveRows() {
  const result = await saveOpeningStockRows(rows.value);
  if (result.ok) {
    rows.value = result.rows;
  }
  message.value = result.message;
}
</script>
